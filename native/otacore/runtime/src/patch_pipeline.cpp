// Patch pipeline: decide what to fetch, download, build/verify on a worker, wake waiters, cache cleanup, and the pre-evaluate safety checks.
// Part of the runtime orchestrator: shared state and the method list are in runtime_impl.h; the reading guide
// (vocabulary, C++ syntax notes, launch order) is at the top of runtime_impl.h.
#include "runtime_impl.h"

#include <algorithm>
#include <cstdlib>
#include <set>
#include "otaruntime/hermes.h"

namespace otaruntime {

// Which host the VM will run (or runs): the selected host patch if usable, else the currently running host.
// Used so unit selection ("requiresHost") matches the host that the unit will actually load into.
std::string Runtime::Impl::targetHostId() {
  if (snap && cacheOk) {
    auto sel = otacore::selectHost(*snap, hostCtx());
    if (sel.source == otacore::Source::Patch && !bad.count(sel.entry->id)) return sel.entry->id;
  }
  return runningHost;
}

// Make sure there is an patch record for this manifest entry. A patch already built on disk goes straight to
// verification (VerifyPending); otherwise it is Queued for download. `rank` is its download priority (lower =
// sooner); -1 means a user is waiting for it right now and sticks.
void Runtime::Impl::considerEntry(const otacore::Entry& e, bool isHost, const std::string& target, int rank, bool resetFailed) {
  if (!usable(e)) return;
  auto it = patches.find(e.id);
  if (it != patches.end() && it->second.hash != e.hash) {  // same id, different content: start over
    if (busy(it->second.s)) return;
    cancelTimer(it->second.retryTimer);
    if (cacheOk) d.fs->remove(cache->builtPath(e.id));
    patches.erase(it);
    it = patches.end();
  }
  if (it == patches.end()) {
    PatchState a;
    a.id = e.id; a.url = e.patchUrl; a.hash = e.hash; a.updateType = e.updateType; a.size = e.size;
    a.target = target; a.isHost = isHost; a.rank = rank; a.seq = ++patchSeq;
    if (cache->has(e.id)) {
      a.s = Stage::VerifyPending;
      std::string v;
      if (d.store->get(kBuilt(e.id), v)) a.builtSize = std::atoll(v.c_str());
    } else a.s = Stage::Queued;
    patches[e.id] = a;
    return;
  }
  PatchState& a = it->second;
  if (a.rank >= 0) a.rank = rank;  // rank -1 (promoted: a user is waiting) sticks
  if (resetFailed && a.s == Stage::Failed) {
    cancelTimer(a.retryTimer);
    a.retries = 0;
    a.s = cache->has(e.id) ? Stage::VerifyPending : Stage::Queued;
  }
}

// (Re)computes which patches this device wants, in prefetch order: host, priority units, the rest.
void Runtime::Impl::replan(bool resetFailed) {
  if (!snap || !cacheOk) return;
  auto hs = otacore::selectHost(*snap, hostCtx());
  if (hs.source == otacore::Source::Patch) considerEntry(*hs.entry, true, kHost, 0, resetFailed);
  std::string tgt = targetHostId();
  std::vector<const UnitConfig*> order;
  std::set<std::string> seen;
  for (auto& n : priority) {
    const UnitConfig* u = findUnit(n);
    if (u && seen.insert(n).second) order.push_back(u);
  }
  for (auto& u : cfg.units) if (seen.insert(u.name).second) order.push_back(&u);
  int rank = 1;
  for (const UnitConfig* u : order) {
    auto sel = otacore::selectUnit(*snap, u->name, unitCtx(*u, tgt));
    // fetch=lazy: no download before the first request; a patch already on disk is only verified.
    if (sel.source == otacore::Source::Patch && fetchOf(u->name) == Fetch::Lazy && !patches.count(sel.entry->id) &&
        !cache->has(sel.entry->id)) { rank++; continue; }
    if (sel.source == otacore::Source::Patch) considerEntry(*sel.entry, false, u->name, rank, resetFailed);
    rank++;
  }
  // Ranks are recomputed from scratch when the priority list changes.
  pump();
}

void Runtime::Impl::setPriority(const std::vector<std::string>& units) {
  priority = units;
  int rank = 1;
  std::set<std::string> seen;
  std::vector<std::string> names = units;
  for (auto& u : cfg.units) names.push_back(u.name);
  for (auto& n : names) {
    if (!seen.insert(n).second) continue;
    for (auto& kv : patches) if (!kv.second.isHost && kv.second.target == n && kv.second.rank >= 0) kv.second.rank = rank;
    rank++;
  }
  pump();
}

// Of all patches in state s1 or s2, the one to work on next: lowest rank, then oldest.
PatchState* Runtime::Impl::pickBest(Stage s1, Stage s2) {
  PatchState* best = nullptr;
  for (auto& kv : patches) {
    PatchState& a = kv.second;
    if (a.s != s1 && a.s != s2) continue;
    if (!best || a.rank < best->rank || (a.rank == best->rank && a.seq < best->seq)) best = &a;
  }
  return best;
}

// The work scheduler: start as many builds and downloads as the concurrency limits allow. Called after
// anything that could unblock work (plan changed, download finished, build finished, network changed).
// Builds are started before downloads; on a metered network, downloads over the cellular size cap are held back.
void Runtime::Impl::pump() {
  if (!cacheOk) return;
  while (activeBuild < cfg.maxConcurrentBuilds) {
    PatchState* a = pickBest(Stage::Downloaded, Stage::VerifyPending);
    if (!a) break;
    startWork(*a);
  }
  while (activeDl < cfg.maxConcurrentDownloads) {
    PatchState* a = pickBest(Stage::Queued, Stage::Queued);
    if (!a) break;
    if (d.http->isMetered() && a->size > cfg.patchSizeCapCellular) {
      a->s = Stage::Absent;
      a->blocked = true;
      emit("download-blocked-metered", "", a->id);
      settle(a->id);
      continue;
    }
    startDownload(*a);
  }
}

// Ask the platform to download the patch file into the cache. The result arrives as onDownloadDone/Failed.
void Runtime::Impl::startDownload(PatchState& a) {
  a.s = Stage::Downloading;
  a.blocked = false;
  a.token = ++tokenCtr;
  tokenToPatch[a.token] = a.id;
  activeDl++;
  std::string dest = cache->patchPath(a.id);
  d.fs->remove(dest);
  emit("download-start", a.target, a.id);
  DownloadRequest r;
  r.token = a.token; r.url = a.url; r.destPath = dest; r.maxBytes = a.size;
  d.http->download(r);
}

// The platform finished a download. Size must match the manifest exactly; otherwise treat as a transient failure.
void Runtime::Impl::onDownloadDone(uint64_t token, int64_t bytes) {
  auto t = tokenToPatch.find(token);
  if (t == tokenToPatch.end()) return;
  std::string id = t->second;
  tokenToPatch.erase(t);
  activeDl--;
  auto it = patches.find(id);
  if (it == patches.end() || it->second.s != Stage::Downloading) { pump(); return; }
  PatchState& a = it->second;
  if (bytes != a.size || d.fs->fileSize(cache->patchPath(id)) != a.size) {
    d.fs->remove(cache->patchPath(id));
    emit("download-failed", a.target, id, "size-mismatch");
    failTransient(id, Stage::Queued);
  } else {
    emit("download-done", a.target, id);
    a.s = Stage::Downloaded;
  }
  pump();
}

void Runtime::Impl::onDownloadFailed(uint64_t token, const std::string& reason) {
  auto t = tokenToPatch.find(token);
  if (t == tokenToPatch.end()) return;
  std::string id = t->second;
  tokenToPatch.erase(t);
  activeDl--;
  auto it = patches.find(id);
  if (it != patches.end() && it->second.s == Stage::Downloading) {
    d.fs->remove(cache->patchPath(id));
    emit("download-failed", it->second.target, id, reason);
    failTransient(id, Stage::Queued);
  }
  pump();
}

// Transient failure: retry with jittered backoff up to maxRetries, then stay Failed until the next
// manifest swap resets it. Never persisted as bad.
void Runtime::Impl::failTransient(const std::string& id, Stage retryTo) {
  auto it = patches.find(id);
  if (it == patches.end()) return;
  PatchState& a = it->second;
  a.retries++;
  a.s = Stage::Failed;
  cancelTimer(a.retryTimer);
  if (a.retries <= cfg.maxRetries) {
    a.retryTimer = after(backoff(a.retries), [this, id, retryTo] {
      auto i = patches.find(id);
      if (i == patches.end() || i->second.s != Stage::Failed) return;
      i->second.retryTimer = 0;
      i->second.s = retryTo;
      pump();
    });
  }
  settle(id);
}

// Slow step, done OFF the ota queue on a worker thread:
//   build  : apply the downloaded diff to the embedded file -> writes the "built" file, sha256-checked by applyPatch
//   verify : a built file from an earlier run is on disk; re-check its size and sha256 before trusting it
// The worker only touches local copies (never `this`); the outcome comes back to finishWork on the ota queue.
void Runtime::Impl::startWork(PatchState& a) {
  const bool build = a.s == Stage::Downloaded;
  a.s = build ? Stage::Building : Stage::Verifying;
  activeBuild++;
  emit(build ? "build-start" : "verify-start", a.target, a.id);
  auto res = std::make_shared<WorkResult>();
  const std::string id = a.id, hash = a.hash, target = a.target;
  const std::string builtPath = cache->builtPath(id), patchPath = cache->patchPath(id), root = cache->root();
  const bool full = a.updateType == "full";
  const int64_t expectSize = a.builtSize;
  FileSystem* fsys = d.fs;
  EmbeddedAssets* assets = d.assets;
  PatchBuilder* builder = d.builder;
  auto work = [=] {
    auto underRoot = [&] {
      std::string c = fsys->canonical(builtPath), r = fsys->canonical(root);
      return !c.empty() && !r.empty() && c.size() > r.size() && c.compare(0, r.size(), r) == 0 && c[r.size()] == '/';
    };
    if (build) {
      otacore::MemorySource empty(nullptr, 0);  // `full`: same applyPatch, empty old source
      std::unique_ptr<otacore::RandomAccessSource> src;
      otacore::RandomAccessSource* old = &empty;
      if (!full) {
        src = assets->openSource(target);
        if (!src) { res->st = otacore::Status::IoError; return; }
        old = src.get();
      }
      res->st = builder->build(*old, patchPath, builtPath, hash);
      if (res->st != otacore::Status::Ok) return;
      res->size = fsys->fileSize(builtPath);
      res->pathOk = underRoot();
      res->hashOk = true;  // applyPatch verified sha256 while writing
    } else {
      res->size = fsys->fileSize(builtPath);
      res->pathOk = underRoot();
      if (res->size < 0) { res->st = otacore::Status::IoError; return; }
      if (expectSize >= 0 && res->size != expectSize) return;  // hashOk stays false
      std::string h;
      if (!fsys->sha256File(builtPath, h)) { res->st = otacore::Status::IoError; return; }
      res->hashOk = (h == hash);
    }
  };
  auto al = alive;
  d.worker->run(work, [this, al, id, build, res] {
    if (!*al) return;
    finishWork(id, build, *res);
  });
}

// Back on the ota queue with the worker's outcome. IO trouble => retry later (transient). Corrupt/unsafe
// result => the patch is blacklisted for good. Success => Ready, and anyone waiting for it is woken (settle).
void Runtime::Impl::finishWork(const std::string& id, bool build, const WorkResult& r) {
  activeBuild--;
  auto it = patches.find(id);
  if (build && cacheOk) d.fs->remove(cache->patchPath(id));  // patch file is not needed after the build
  if (it == patches.end()) { pump(); return; }
  PatchState& a = it->second;
  using S = otacore::Status;
  if (r.st == S::IoError) {
    emit("build-failed", a.target, id, "io-error");
    failTransient(id, build ? Stage::Queued : Stage::VerifyPending);
  } else if (r.st != S::Ok || !r.pathOk || !r.hashOk || r.size < 0) {
    std::string why = r.st != S::Ok ? otacore::statusName(r.st) : !r.pathOk ? "path-escape" : "hash-or-size-mismatch";
    emit("build-failed", a.target, id, why);
    markBad(id, why);
  } else {
    a.builtSize = r.size;
    d.store->put(kBuilt(id), std::to_string(r.size));
    a.s = Stage::Ready;
    a.retries = 0;
    emit(build ? "build-ok" : "verify-ok", a.target, id);
    settle(id);
  }
  pump();
}

// An patch reached Ready/Bad/Failed/blocked: wake loads, prewarm and host recreate; schedule GC.
void Runtime::Impl::settle(const std::string& id) {
  auto it = patches.find(id);
  if (it == patches.end()) return;
  const Stage st = it->second.s;
  const bool isHost = it->second.isHost;
  std::vector<std::string> units;
  for (auto& kv : pins) if (kv.second.st == UnitPin::Loading && kv.second.waitingArt == id) units.push_back(kv.first);
  for (auto& u : units) {
    UnitPin& pin = pins[u];
    if (st == Stage::Ready) {
      cancelTimer(pin.timer);
      pin.waitingArt.clear();
      loadPatchIntoPin(u, id);
    } else if (!waitable(st)) {
      cancelTimer(pin.timer);
      pin.waitingArt.clear();
      evaluateEmbedded(u, "patch-unavailable");
    }
  }
  if (isHost) {
    tryPrewarm();
    considerRecreate(true);
  }
  scheduleGc();
}

// Cache garbage collection: delete files for patches that the current manifest no longer lists. Deferred to a
// later queue turn, and skipped while any file is being written.
void Runtime::Impl::scheduleGc() {
  if (!gcPending || gcScheduled) return;
  gcScheduled = true;
  auto al = alive;
  d.scheduler->post([this, al] {
    if (!*al) return;
    gcScheduled = false;
    runGc();
  });
}

void Runtime::Impl::runGc() {
  if (!gcPending || !cacheOk || !snap) return;
  for (auto& kv : patches) if (busy(kv.second.s)) return;  // retried when the busy patch settles
  std::vector<std::string> keep = otacore::allEntryIds(*snap);
  std::set<std::string> ref(keep.begin(), keep.end());
  size_t removed = cache->gc(keep);
  for (auto it = patches.begin(); it != patches.end();) {
    if (!ref.count(it->first)) { cancelTimer(it->second.retryTimer); it = patches.erase(it); }
    else ++it;
  }
  for (auto& k : d.store->keys("attempts/")) if (!ref.count(k.substr(9))) d.store->erase(k);
  for (auto& k : d.store->keys("built/")) if (!ref.count(k.substr(6))) d.store->erase(k);
  gcPending = false;
  emit("gc", "", "", std::to_string(removed));
}

// Network type changed (e.g. cellular -> Wi-Fi): retry downloads that were held back by the cellular size cap.
void Runtime::Impl::onNetworkChanged() {
  bool any = false;
  for (auto& kv : patches) {
    if (kv.second.s == Stage::Absent && kv.second.blocked) { kv.second.s = Stage::Queued; any = true; }
  }
  if (any) pump();
}

// The once-per-process content checks (hash, size, canonical path) already ran when the patch became
// Ready; here: lexical path, map, expected size, 4-byte alignment, Hermes magic and version.
Check Runtime::Impl::preEvaluate(const std::string& id) {
  Check c;
  auto it = patches.find(id);
  if (it == patches.end() || it->second.s != Stage::Ready) { c.why = "not-ready"; return c; }
  std::string path = cache->builtPath(id);
  const std::string root = cache->root() + "/";
  if (path.compare(0, root.size(), root) != 0 || path.find("..") != std::string::npos) {
    c.why = "path-escape"; c.persistent = true; return c;
  }
  c.buf = d.fs->map(path);
  if (!c.buf) { c.why = "map-failed"; return c; }  // transient: no persistent blame
  c.persistent = true;
  if (it->second.builtSize >= 0 && int64_t(c.buf->size()) != it->second.builtSize) { c.why = "size-mismatch"; return c; }
  if (const char* e = checkHermesBytecode(c.buf->data(), c.buf->size(), cfg.bytecodeVersion)) { c.why = e; return c; }
  c.ok = true;
  return c;
}

}  // namespace otaruntime
