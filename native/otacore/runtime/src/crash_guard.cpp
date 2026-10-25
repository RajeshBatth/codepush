// Crash-loop guard: persisted "attempt" counters and the patch blacklist.
// Part of the runtime orchestrator: shared state and the method list are in runtime_impl.h; the reading guide
// (vocabulary, C++ syntax notes, launch order) is at the top of runtime_impl.h.
#include "runtime_impl.h"

#include <cstdlib>

namespace otaruntime {

// How we protect users from a patch that crashes the app:
//   1. BEFORE running a patch we persist "attempts[id] += 1" (bumpAttempt).
//   2. When JS renders its first frame, markReady() erases the counter: the patch is proven healthy.
//   3. If the process dies first, the counter survives. On the next start, a counter >= crashLimitK means the
//      patch crashed us K times without ever confirming: it is blacklisted for good (`bad/<id>`) and embedded
//      code runs instead.
void Runtime::Impl::markBadId(const std::string& id, const std::string& why) {
  bad.insert(id);
  d.store->put(kBad(id), why);  // best effort: in-memory flag already protects this process
  d.store->erase(kBuilt(id));
  if (cacheOk) {
    std::string p = cache->builtPath(id);
    if (!p.empty()) d.fs->remove(p);
  }
  emit("patch-bad", "", id, why);
}

void Runtime::Impl::markBad(const std::string& id, const std::string& why) {
  markBadId(id, why);
  auto it = patches.find(id);
  if (it != patches.end()) {
    it->second.s = Stage::Bad;
    cancelTimer(it->second.retryTimer);
    settle(id);
  }
}

int Runtime::Impl::attemptsOf(const std::string& id) {
  std::string v;
  if (!d.store->get(kAttempts(id), v)) return 0;
  return std::atoi(v.c_str());
}

// Usable = we may consider running this patch: not blacklisted, and the cache works. Also applies the crash limit to ids first seen after start().
bool Runtime::Impl::usable(const otacore::Entry& e) {
  if (!cacheOk || cache->builtPath(e.id).empty()) return false;
  if (bad.count(e.id)) return false;
  if (!attempted.count(e.id) && attemptsOf(e.id) >= cfg.crashLimitK) {
    markBadId(e.id, "crash-loop");
    emit("blacklisted", "", e.id, "crash-loop");
    return false;
  }
  return true;
}

// Persist attempts[id]+1 BEFORE using a patch. Once per process per id.
bool Runtime::Impl::bumpAttempt(const std::string& id) {
  if (attempted.count(id)) return true;
  if (!d.store->put(kAttempts(id), std::to_string(attemptsOf(id) + 1))) return false;
  attempted.insert(id);
  return true;
}

}  // namespace otaruntime
