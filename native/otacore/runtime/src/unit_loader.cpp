// Unit loading: openUnit/loadUnit requests, the embedded-vs-patch decision (resolve), evaluating code, answering callers.
// Part of the runtime orchestrator: shared state and the method list are in runtime_impl.h; the reading guide
// (vocabulary, C++ syntax notes, launch order) is at the top of runtime_impl.h.
#include "runtime_impl.h"


namespace otaruntime {

// Entry point for native requests. If the VM is ready, handle now; if it is being created/replaced, queue until it
// is up; if there is no VM, an openUnit creates one (a tap never waits for prewarm), a loadUnit fails ("no-vm").
void Runtime::Impl::submit(Op op) {
  if (!started) { fail(op, "not-started"); return; }
  switch (vm) {
    case VmState::Running: runOp(std::move(op)); return;
    case VmState::Creating:
    case VmState::Destroying: pendingOps.push_back(std::move(op)); return;
    case VmState::None:
      if (!op.open) { fail(op, "no-vm"); return; }
      pendingOps.push_back(std::move(op));
      startCreate();
      return;
  }
}

// Handle one request on a running VM. The first request for a unit starts the decision (resolve); requests that
// arrive while it is pending just wait on the same decision, so the unit is evaluated at most once per VM.
void Runtime::Impl::runOp(Op op) {
  const std::string unit = op.unit;
  if (!findUnit(unit)) { fail(op, "unknown-unit"); return; }
  auto it = pins.find(unit);
  // A failure is never frozen: with the freeze on, a new request re-decides instead of replaying the error, but ONLY in a
  // CLEAN VM. A poisoned VM (a patch entry threw after its modules registered; Metro ignores re-registration) must not be
  // asked to evaluate anything until it is replaced, so there the failed pin stays failed (DESIGN.md 5.8 decision 5).
  if (it != pins.end() && it->second.st == UnitPin::Failed && freezes(unit) && !poisoned) { pins.erase(it); it = pins.end(); }
  const bool fresh = it == pins.end();
  UnitPin& pin = fresh ? pins[unit] : it->second;
  pin.waiters.push_back(std::move(op));
  if (fresh) resolve(unit);
  else if (pin.st != UnitPin::Loading) serve(unit);
}

// 5.2 steps 2-3 for one unit, pinned for the lifetime of this VM.
// Re-validates a frozen patch selection when a NEW VM resolves the unit (safety exceptions a, b, c).
// Returns "" when the freeze holds, otherwise the reason it was dropped.
std::string Runtime::Impl::frozenPatchProblem(const std::string& unit, const Frozen& f) {
  if (!snap || !cacheOk) return "no-manifest";
  if (bad.count(f.id)) return "blacklisted";
  const otacore::Entry* found = nullptr;
  for (auto& u : snap->units) {
    if (u.unitName != unit) continue;
    for (auto& e : u.entries) if (e.id == f.id) found = &e;
  }
  if (!found) return "removed-from-manifest";
  if (found->hash != f.hash) return "entry-changed";
  auto sel = otacore::selectUnit(*snap, unit, unitCtx(*findUnit(unit), runningHost));
  if (sel.source != otacore::Source::Patch || sel.entry->id != f.id) {
    return sel.source == otacore::Source::Patch ? "range-excluded" : sel.reason;
  }
  if (!usable(*found)) return "blacklisted";  // crash-loop limit applied now
  auto it = patches.find(f.id);
  if (it == patches.end() || it->second.s != Stage::Ready) return "file-missing";
  Check c = preEvaluate(f.id);
  if (!c.ok) {
    if (c.persistent) markBad(f.id, c.why);
    return "pre-evaluate-failed:" + c.why;
  }
  return "";
}

// THE central decision for one unit in this VM: embedded or patch? In order:
//   1. pin=Process and a remembered choice exists  -> reuse it if still safe (frozenPatchProblem), else drop it.
//   2. no verified manifest / no cache             -> embedded.
//   3. manifest selects embedded for this device   -> embedded (not in rollout, halted, wrong host, ...).
//   4. selected patch is blacklisted               -> embedded.
//   5. patch already built                         -> load it now.
//   6. patch unusable (bad/failed)                 -> embedded.
//   7. patch still downloading/building            -> latency-first unit (budget 0): embedded now, the patch is
//      used by a later resolution; otherwise wait up to `loadBudgetMs`, loading the patch the moment it is
//      ready (settle) or falling back to embedded when the timer expires. The user is waiting, so the patch
//      is promoted to the front of the download queue (rank -1).
void Runtime::Impl::resolve(const std::string& unit) {
  const UnitConfig* uc = findUnit(unit);
  if (freezes(unit)) {
    auto f = frozen.find(unit);
    if (f != frozen.end()) {
      if (!f->second.patch) {
        emit("selection-reused", unit, "", "embedded scope=process");
        evaluateEmbedded(unit, "frozen");
        return;
      }
      const Frozen fz = f->second;
      std::string why = frozenPatchProblem(unit, fz);
      if (why.empty()) {
        emit("selection-reused", unit, fz.id, "patch scope=process");
        pins[unit].reason = "frozen";
        loadPatchIntoPin(unit, fz.id);
        return;
      }
      dropFreeze(unit, why);  // then the normal selection runs against the latest manifest
    }
  }
  if (!snap || !cacheOk) { evaluateEmbedded(unit, "no-manifest"); return; }
  auto sel = otacore::selectUnit(*snap, unit, unitCtx(*uc, runningHost));
  if (sel.source != otacore::Source::Patch || !usable(*sel.entry)) {
    const std::string why = sel.source != otacore::Source::Patch ? sel.reason : "blacklisted";
    emit("select-embedded", unit, "", sel.reason);
    evaluateEmbedded(unit, why);
    return;
  }
  const otacore::Entry e = *sel.entry;
  considerEntry(e, false, unit, -1, false);
  auto it = patches.find(e.id);
  if (it == patches.end()) { evaluateEmbedded(unit, "patch-missing"); return; }
  it->second.rank = -1;  // the user is waiting: promote ahead of prefetch
  if (it->second.s == Stage::Absent) it->second.s = Stage::Queued;
  if (it->second.s == Stage::Queued) pump();
  it = patches.find(e.id);
  if (it == patches.end()) { evaluateEmbedded(unit, "patch-missing"); return; }
  switch (it->second.s) {
    case Stage::Ready: pins[unit].reason = "ok"; loadPatchIntoPin(unit, e.id); return;
    case Stage::Bad: case Stage::Failed: case Stage::Absent: evaluateEmbedded(unit, "patch-unavailable"); return;
    default: break;
  }
  const Millis budget = budgetOf(unit);
  if (budget <= 0) {  // latency-first: never wait; the (promoted) download/build continues for the next resolution
    emit("budget-exceeded", unit, "", "no-wait");
    evaluateEmbedded(unit, "budget-exceeded");
    return;
  }
  UnitPin& pin = pins[unit];
  pin.waitingArt = e.id;
  pin.reason = "ok";
  pin.timer = after(budget, [this, unit] {
    auto p = pins.find(unit);
    if (p == pins.end() || p->second.st != UnitPin::Loading || p->second.waitingArt.empty()) return;
    p->second.timer = 0;
    p->second.waitingArt.clear();
    emit("budget-exceeded", unit, "");
    evaluateEmbedded(unit, "budget-exceeded");
  });
}

// Run the built patch in the VM: pre-evaluate checks -> persist the crash-guard attempt -> evaluate the bytecode
// -> run the unit's entry module. Each failure blacklists the patch and falls back to embedded. The exception:
// if the ENTRY module throws, the patch's modules are already registered in the VM and Metro ignores a second
// definition, so embedded cannot override them; the VM is marked poisoned and replaced, and this request fails.
void Runtime::Impl::loadPatchIntoPin(const std::string& unit, const std::string& id) {
  const UnitConfig* uc = findUnit(unit);
  UnitPin& pin = pins[unit];
  Check c = preEvaluate(id);
  if (!c.ok) {
    emit("pre-evaluate-failed", unit, id, c.why);
    if (c.persistent) markBad(id, c.why);
    dropFreezeIfPatch(unit, id, "pre-evaluate-failed:" + c.why);
    evaluateEmbedded(unit, "pre-evaluate-failed");
    return;
  }
  if (!bumpAttempt(id)) {
    emit("attempt-persist-failed", unit, id);
    dropFreezeIfPatch(unit, id, "attempt-persist-failed");
    evaluateEmbedded(unit, "attempt-persist-failed");
    return;
  }
  std::string err;
  if (!d.vm->evaluateUnit(*c.buf, "ota://" + unit + "/" + id + ".hbc", err)) {
    emit("evaluate-failed", unit, id, err);
    markBad(id, "evaluate-failed");
    dropFreezeIfPatch(unit, id, "evaluate-failed");
    evaluateEmbedded(unit, "evaluate-failed");  // a failed evaluate registered nothing: the VM is clean
    return;
  }
  if (!d.vm->requireEntry(uc->entryModuleId, err)) {
    // Modules of the patch are already registered; embedded would not override them. Blame the
    // patch, fail this load, and replace the VM at the next zero-views moment.
    emit("entry-failed", unit, id, err);
    markBad(id, "entry-failed");
    dropFreezeIfPatch(unit, id, "entry-failed");
    poisoned = true;
    failPin(unit, "entry-failed: " + err);
    considerRecreate(true);
    return;
  }
  pin.st = UnitPin::Loaded;
  pin.patch = true;
  pin.patchId = id;
  emit("unit-loaded", unit, id, "patch");
  if (pin.reason == "frozen") pin.reason = "ok";
  freezeNow(unit, pin);
  serve(unit);
}

// Run the unit's embedded (shipped-in-the-binary) bytecode. `why` records the reason for the choice (events only).
void Runtime::Impl::evaluateEmbedded(const std::string& unit, const std::string& why) {
  const UnitConfig* uc = findUnit(unit);
  UnitPin& pin = pins[unit];
  pin.reason = why;
  std::string err;
  auto buf = d.assets->open(unit);
  if (!buf) { failPin(unit, "embedded-missing"); return; }
  if (!d.vm->evaluateUnit(*buf, "ota://" + unit + "/embedded.hbc", err)) { failPin(unit, "embedded-evaluate-failed: " + err); return; }
  if (!d.vm->requireEntry(uc->entryModuleId, err)) { failPin(unit, "embedded-entry-failed: " + err); return; }
  pin.st = UnitPin::Loaded;
  pin.patch = false;
  pin.patchId.clear();
  emit("unit-loaded", unit, "", "embedded");
  freezeNow(unit, pin);
  serve(unit);
}

void Runtime::Impl::failPin(const std::string& unit, const std::string& err) {
  UnitPin& pin = pins[unit];
  pin.st = UnitPin::Failed;
  pin.error = err;
  emit("unit-failed", unit, "", err);
  serve(unit);
}

// The unit's decision is final (Loaded or Failed): answer every request waiting on it. openUnit also mounts the
// screen (mountSurface); loadUnit just reports success. Callbacks are posted, not called inline (see complete).
void Runtime::Impl::serve(const std::string& unit) {
  auto ws = std::move(pins[unit].waiters);
  pins[unit].waiters.clear();
  for (auto& op : ws) {
    UnitPin& pin = pins[unit];
    OpenResult r;
    r.source = pin.patch ? "patch" : "embedded";
    r.patchId = pin.patchId;
    if (pin.st == UnitPin::Failed) {
      r.error = pin.error;
      r.source.clear();
    } else if (op.open) {
      std::string err;
      if (d.vm->mountSurface(unit, op.props, err)) r.ok = true;
      else r.error = "mount-failed: " + err;
    } else {
      r.ok = true;
    }
    complete(op.cb, std::move(r));
  }
  if (pendingRecreate) considerRecreate(false);
}

// JS rendered the unit's first frame: the code is healthy. Clear the crash-guard counter of the patch (and of
// the booted host patch, which is also proven by a healthy RN surface).
void Runtime::Impl::markReady(const std::string& unit) {
  auto it = pins.find(unit);
  if (it == pins.end() || it->second.st != UnitPin::Loaded) return;
  if (it->second.patch) {
    d.store->erase(kAttempts(it->second.patchId));
    attempted.erase(it->second.patchId);
    emit("confirmed", unit, it->second.patchId);
  }
  if (runningHost != kEmbedded) {  // the first healthy RN surface also confirms the booted host patch
    d.store->erase(kAttempts(runningHost));
    attempted.erase(runningHost);
    emit("confirmed", kHost, runningHost);
  }
}

void Runtime::Impl::onSurfaceUnmounted() {
  if (pendingRecreate && vm == VmState::Running) considerRecreate(false);
}

}  // namespace otaruntime
