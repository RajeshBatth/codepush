// Small shared helpers of the runtime: events, timers, retry backoff, per-unit policy lookup, selection freeze.
// Part of the runtime orchestrator: shared state and the method list are in runtime_impl.h; the reading guide
// (vocabulary, C++ syntax notes, launch order) is at the top of runtime_impl.h.
#include "runtime_impl.h"


namespace otaruntime {

uint64_t Runtime::Impl::rnd() {
  rngState ^= rngState >> 12; rngState ^= rngState << 25; rngState ^= rngState >> 27;
  return rngState * 2685821657736338717ull;
}

double Runtime::Impl::r01() { return double(rnd() >> 11) * (1.0 / 9007199254740992.0); }

// Report something that happened to the app's Observer (logging/telemetry). Purely informational.
void Runtime::Impl::emit(const char* kind, const std::string& unit, const std::string& id, const std::string& detail) {
  if (d.observer) d.observer->onEvent(Event{kind, unit, id, detail});
}

// Run `fn` after `ms` milliseconds, unless this object was destroyed meanwhile. Returns a timer id for cancelTimer.
TimerId Runtime::Impl::after(Millis ms, std::function<void()> fn) {
  auto a = alive;
  return d.clock->schedule(ms, [a, fn = std::move(fn)] { if (*a) fn(); });
}

void Runtime::Impl::cancelTimer(TimerId& t) {
  if (t) d.clock->cancel(t);
  t = 0;
}

// Answer a caller. Always deferred via the scheduler (posted), never called inline, so callers can rely on
// "the callback never runs inside the method I just called".
void Runtime::Impl::complete(OpenCallback& cb, OpenResult r) {
  if (!cb) return;
  auto a = alive;
  d.scheduler->post([a, cb = std::move(cb), r = std::move(r)] { if (*a) cb(r); });
}

void Runtime::Impl::fail(Op& op, const std::string& err) {
  OpenResult r;
  r.error = err;
  complete(op.cb, std::move(r));
}

// Retry delay after the n-th failure: base * 2^(n-1), capped, then randomized to [50%,100%] so that many devices
// that failed together do not all retry at the same instant.
Millis Runtime::Impl::backoff(int n) {
  Millis dl = cfg.backoffBaseMs;
  for (int i = 1; i < n && dl < cfg.backoffMaxMs; i++) dl *= 2;
  dl = std::min(dl, cfg.backoffMaxMs);
  return Millis(double(dl) * (0.5 + 0.5 * r01()));  // equal jitter: [d/2, d]
}

const UnitConfig* Runtime::Impl::findUnit(const std::string& n) const {
  for (auto& u : cfg.units) if (u.name == n) return &u;
  return nullptr;
}

// This device's stable position (0..1) for a unit; a rollout of "30%" reaches devices whose bucket is below 0.3.
double Runtime::Impl::bucketOf(const std::string& key) {
  auto it = buckets.find(key);
  if (it != buckets.end()) return it->second;
  return buckets[key] = otacore::bucket(deviceId, key);
}

otacore::SelectContext Runtime::Impl::unitCtx(const UnitConfig& u, const std::string& running) {
  otacore::SelectContext c;
  c.bucket = bucketOf(u.name);
  c.embeddedHash = u.embeddedHash;
  c.supportedAlgos = cfg.supportedAlgos;
  c.runningHostId = running;
  return c;
}

otacore::SelectContext Runtime::Impl::hostCtx() {
  otacore::SelectContext c;
  c.bucket = bucketOf(cfg.hostBucketKey);
  c.embeddedHash = cfg.hostEmbeddedHash;
  c.supportedAlgos = cfg.supportedAlgos;
  c.runningHostId = kEmbedded;
  return c;
}

// How many units are currently deciding/waiting. A VM must not be replaced while any load is in flight.
int Runtime::Impl::loadsInFlight() const {
  int n = 0;
  for (auto& kv : pins) if (kv.second.st == UnitPin::Loading) n++;
  return n;
}

// Effective policy of a unit: per-unit field, else defaultPolicy field, else the built-in default.
Pin Runtime::Impl::pinOfUnit(const std::string& unit) const {
  auto it = cfg.unitPolicy.find(unit);
  if (it != cfg.unitPolicy.end() && it->second.pin) return *it->second.pin;
  return cfg.defaultPolicy.pin.value_or(Pin::Vm);
}

Millis Runtime::Impl::budgetOf(const std::string& unit) const {
  auto it = cfg.unitPolicy.find(unit);
  if (it != cfg.unitPolicy.end() && it->second.loadBudgetMs) return std::max<Millis>(0, *it->second.loadBudgetMs);
  return std::max<Millis>(0, cfg.defaultPolicy.loadBudgetMs.value_or(cfg.unitBudgetMs));
}

Fetch Runtime::Impl::fetchOf(const std::string& unit) const {
  auto it = cfg.unitPolicy.find(unit);
  if (it != cfg.unitPolicy.end() && it->second.fetch) return *it->second.fetch;
  return cfg.defaultPolicy.fetch.value_or(Fetch::Eager);
}

// true for units with pin=Process ("freeze" is the older name for the process-wide lock).
bool Runtime::Impl::freezes(const std::string& unit) const { return pinOfUnit(unit) == Pin::Process; }

const char* Runtime::Impl::scopeName(const std::string& unit) const { return freezes(unit) ? "process" : "vm"; }

// Called when a unit finished loading: report the decision, and for pin=Process units also remember it
// in `frozen` so the next VM in this process reuses it.
void Runtime::Impl::freezeNow(const std::string& unit, const UnitPin& pin) {
  const std::string detail = std::string(pin.patch ? "patch" : "embedded") + ":" + pin.reason + " scope=" + scopeName(unit);
  if (!freezes(unit)) {  // pin=vm: the selection is fixed for this VM only (nothing is memoized)
    emit("selection-frozen", unit, pin.patchId, detail);
    return;
  }
  Frozen f;
  f.patch = pin.patch;
  f.id = pin.patchId;
  if (pin.patch && snap) {
    for (auto& u : snap->units) {
      if (u.unitName != unit) continue;
      for (auto& e : u.entries) if (e.id == f.id) f.hash = e.hash;
    }
  }
  auto old = frozen.find(unit);
  const bool same = old != frozen.end() && old->second.patch == f.patch && old->second.id == f.id;
  frozen[unit] = f;
  if (same) return;  // a reused freeze is not announced again
  emit("selection-frozen", unit, f.id, detail);
}

void Runtime::Impl::dropFreeze(const std::string& unit, const std::string& reason) {
  auto it = frozen.find(unit);
  if (it == frozen.end()) return;
  emit("selection-dropped", unit, it->second.id, reason + " scope=process");
  frozen.erase(it);
}

// Drops the freeze when it points at patch `id` (a failure while loading that very patch).
void Runtime::Impl::dropFreezeIfPatch(const std::string& unit, const std::string& id, const std::string& reason) {
  auto it = frozen.find(unit);
  if (it != frozen.end() && it->second.patch && it->second.id == id) dropFreeze(unit, reason);
}

}  // namespace otaruntime
