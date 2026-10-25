// VM lifecycle: prewarm, create, and replace the React Native VM (and the settle wait for a host patch).
// Part of the runtime orchestrator: shared state and the method list are in runtime_impl.h; the reading guide
// (vocabulary, C++ syntax notes, launch order) is at the top of runtime_impl.h.
#include "runtime_impl.h"


namespace otaruntime {

// True when the manifest picked a host patch for this device and it is still on its way (queued, downloading,
// building or verifying). False if there is no manifest yet, no host patch, it is blacklisted, or already done.
bool Runtime::Impl::hostWaiting() {
  if (!snap || !cacheOk) return false;
  auto sel = otacore::selectHost(*snap, hostCtx());
  if (sel.source != otacore::Source::Patch || bad.count(sel.entry->id)) return false;
  auto it = patches.find(sel.entry->id);
  return it != patches.end() && waitable(it->second.s);
}

// Native tells us: "the first (native) page of the app is on screen and usable".
//
// Why this exists: creating the React Native VM costs hundreds of milliseconds and a lot of CPU. If we did it
// during app start-up it would slow the very first screen, which is native and must never wait on anything. If we
// waited for the user to tap an RN entry point (e.g. "Chat"), the first tap would pay the full VM startup.
// So we create the VM in the background right AFTER the first page is interactive ("prewarm"): out of the way of
// start-up, but usually ready before the first tap. This method just records that moment and tries to prewarm.
void Runtime::Impl::onFirstPageInteractive() {
  firstPage = true;
  tryPrewarm();
}

// Create the VM in the background if (and only if) now is a good moment. Safe to call repeatedly; it is called
// again whenever something changes (first page up, host patch became ready, wait timer fired).
//
// The one real decision: should we create the VM from the EMBEDDED host or wait briefly for a PATCHED host?
//   * A VM runs exactly one host bundle for its whole life; changing the host means destroying the VM and
//     creating a new one (see considerRecreate). So if a host patch is just about to be ready and we prewarm
//     right now, we boot the old host, then throw that VM away moments later: wasted work and a visible stall.
//   * But we also must not delay prewarm indefinitely: the patch may be big, the network slow, or the CDN down.
// Compromise: if a host patch is selected and still in flight (hostWaiting), wait at most hostSettleMs
// (~800 ms). If it becomes ready sooner, settle() calls us again and we boot straight from the patched host.
// If the timer fires first, we prewarm with what is on disk (usually embedded); the patch will be picked up
// at the next safe moment (VM replaced when no screen is open). We never wait on a manifest that has not arrived
// (no manifest => hostWaiting() is false => prewarm immediately), and we only ever wait ONCE per process
// (settleExpired), so this adds at most hostSettleMs to prewarm and never delays the first page or any tap.
//
// If the user taps an entry point while we are waiting, submit() creates the VM at once and cancels the wait.
void Runtime::Impl::tryPrewarm() {
  if (!started || !cfg.prewarm || !firstPage || vm != VmState::None) return;
  if (hostWaiting() && !settleExpired) {
    if (!settleTimer) {
      settleTimer = after(cfg.hostSettleMs, [this] {
        settleTimer = 0;
        settleExpired = true;
        emit("prewarm-settle-expired");
        if (vm == VmState::None) startCreate();
      });
    }
    return;
  }
  cancelTimer(settleTimer);
  startCreate();
}

// Chooses the host from disk only (never the network) and asks the platform to create the VM.
// Patched host used only if: selected for this device, not blacklisted, already built, passes pre-evaluate
// checks, and its "attempt" was persisted (so a crash while booting it is counted). Otherwise: embedded host.
void Runtime::Impl::startCreate() {
  cancelTimer(settleTimer);
  vm = VmState::Creating;
  poisoned = false;
  HostSource hs;
  if (snap && cacheOk) {
    auto sel = otacore::selectHost(*snap, hostCtx());
    if (sel.source == otacore::Source::Patch && usable(*sel.entry)) {
      const std::string id = sel.entry->id;
      auto it = patches.find(id);
      if (it != patches.end() && it->second.s == Stage::Ready) {
        Check c = preEvaluate(id);
        if (!c.ok) {
          if (c.persistent) markBad(id, c.why);
        } else if (bumpAttempt(id)) {  // host boot guard: persisted BEFORE createVm
          hs.hostId = id;
          hs.path = cache->builtPath(id);
          hs.buffer = c.buf;
        }
      }
    }
  }
  pendingHost = hs.hostId;
  emit("vm-create", kHost, hs.hostId);
  d.vm->createVm(hs);
}

// The platform reports the result of createVm. On success, answer all requests that queued up meanwhile. If a
// PATCHED host failed to boot, blacklist it and immediately retry once with the embedded host (never leave the
// app without a working VM because of a bad patch).
void Runtime::Impl::onVmCreated(bool ok) {
  if (vm != VmState::Creating) return;
  if (ok) {
    vm = VmState::Running;
    runningHost = pendingHost;
    emit("vm-created", kHost, runningHost);
    auto ops = std::move(pendingOps);
    pendingOps.clear();
    for (auto& op : ops) runOp(std::move(op));
    considerRecreate(true);
    return;
  }
  emit("vm-create-failed", kHost, pendingHost);
  if (pendingHost != kEmbedded) {  // patched host failed to boot: blacklist it, retry once with embedded
    markBad(pendingHost, "vm-create-failed");
    startCreate();
    return;
  }
  vm = VmState::None;
  auto ops = std::move(pendingOps);
  pendingOps.clear();
  for (auto& op : ops) fail(op, "vm-create-failed");
}

// The VM is gone, so every per-VM decision is void: forget the pins and fail requests still waiting on them.
void Runtime::Impl::dropPins(const char* err) {
  auto old = std::move(pins);
  pins.clear();
  for (auto& kv : old) {
    cancelTimer(kv.second.timer);
    for (auto& op : kv.second.waiters) fail(op, err);
  }
}

// The VM was destroyed (by us, the OS, or the app's lifecycle manager). If WE destroyed it to switch hosts
// (state Destroying), create the replacement now; otherwise go back to "no VM" until someone needs one.
void Runtime::Impl::onVmDestroyed() {
  const bool recreating = vm == VmState::Destroying;
  dropPins("vm-destroyed");
  runningHost = kEmbedded;
  emit("vm-destroyed");
  if (recreating) { startCreate(); return; }
  if (vm == VmState::Creating || vm == VmState::Running) {
    vm = VmState::None;
    auto ops = std::move(pendingOps);
    pendingOps.clear();
    for (auto& op : ops) fail(op, "vm-destroyed");
  }
}

// Is a better host ready than the one running? (a different, usable, fully built host patch)
bool Runtime::Impl::hostUpgradeAvailable() {
  if (!snap || !cacheOk) return false;
  auto sel = otacore::selectHost(*snap, hostCtx());
  if (sel.source != otacore::Source::Patch || sel.entry->id == runningHost) return false;
  if (bad.count(sel.entry->id) || !usable(*sel.entry)) return false;
  auto it = patches.find(sel.entry->id);
  return it != patches.end() && it->second.s == Stage::Ready;
}

// 5.4: recreate only with zero mounted views and no load in flight; remember the wish for the next
// zero-views moment when `recreateAtZeroViews`. `readyMoment`: the new host just became ready.
void Runtime::Impl::considerRecreate(bool readyMoment) {
  if (vm != VmState::Running) return;
  if (!poisoned && !hostUpgradeAvailable()) { pendingRecreate = false; return; }
  const bool loads = loadsInFlight() > 0;
  const bool views = d.vm->mountedSurfaceCount() > 0;
  if (!loads && !views) { beginRecreate(); return; }
  pendingRecreate = poisoned || cfg.recreateAtZeroViews || (loads && (pendingRecreate || readyMoment));
}

// Destroy the VM so onVmDestroyed can create a new one from the new host. While Destroying, new requests queue.
void Runtime::Impl::beginRecreate() {
  pendingRecreate = false;
  vm = VmState::Destroying;  // recreate lock: openUnit calls queue until the new VM is up
  emit("vm-recreate", kHost, "", poisoned ? "poisoned" : "new-host");
  d.vm->destroyVm();
}

}  // namespace otaruntime
