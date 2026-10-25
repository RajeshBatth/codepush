// Public API of the OTA runtime: thin forwarding to Runtime::Impl (runtime_impl.h + runtime_*.cpp).
#include "runtime_impl.h"

namespace otaruntime {

const char* vmStateName(VmState s) {
  switch (s) {
    case VmState::None: return "none";
    case VmState::Creating: return "creating";
    case VmState::Running: return "running";
    case VmState::Destroying: return "destroying";
  }
  return "?";
}

// ---------------------------------------------------------------------- public API forwarding
Runtime::Runtime(Config cfg, Deps deps) : p_(new Impl(std::move(cfg), deps)) {}
Runtime::~Runtime() = default;

void Runtime::start() { p_->start(); }
void Runtime::onFirstPageInteractive() { p_->onFirstPageInteractive(); }
void Runtime::setEntryPointPriority(const std::vector<std::string>& u) { p_->setPriority(u); }
void Runtime::openUnit(const std::string& unit, const std::string& props, OpenCallback cb) {
  Op op;
  op.open = true; op.unit = unit; op.props = props; op.cb = std::move(cb);
  p_->submit(std::move(op));
}
void Runtime::loadUnit(const std::string& unit, OpenCallback cb) {
  Op op;
  op.unit = unit; op.cb = std::move(cb);
  p_->submit(std::move(op));
}
void Runtime::markReady(const std::string& unit) { p_->markReady(unit); }
void Runtime::onVmCreated(bool ok) { p_->onVmCreated(ok); }
void Runtime::onVmDestroyed() { p_->onVmDestroyed(); }
void Runtime::onSurfaceMounted() {}
void Runtime::onSurfaceUnmounted() { p_->onSurfaceUnmounted(); }
void Runtime::onNetworkChanged() { p_->onNetworkChanged(); }
void Runtime::onManifestFetched(uint64_t t, const ManifestResponse& r) { p_->onManifestFetched(t, r); }
void Runtime::onManifestFailed(uint64_t t, const std::string& why) { p_->onManifestFailed(t, why); }
void Runtime::onDownloadDone(uint64_t t, int64_t bytes) { p_->onDownloadDone(t, bytes); }
void Runtime::onDownloadFailed(uint64_t t, const std::string& why) { p_->onDownloadFailed(t, why); }

VmState Runtime::vmState() const { return p_->vm; }
std::string Runtime::runningHostId() const { return p_->runningHost; }
int64_t Runtime::manifestVersion() const { return p_->snap ? p_->snap->version : 0; }
std::string Runtime::deviceId() const { return p_->deviceId; }
std::string Runtime::artifactState(const std::string& id) const {
  auto it = p_->patches.find(id);
  return it == p_->patches.end() ? "unknown" : stageName(it->second.s);
}
bool Runtime::isBlacklisted(const std::string& id) const { return p_->bad.count(id) > 0; }
std::string Runtime::frozenOf(const std::string& unit) const {
  auto it = p_->frozen.find(unit);
  if (it == p_->frozen.end()) return "";
  return it->second.patch ? "patch:" + it->second.id : "embedded";
}
std::string Runtime::pinOf(const std::string& unit) const {
  auto it = p_->pins.find(unit);
  if (it == p_->pins.end()) return "";
  switch (it->second.st) {
    case UnitPin::Loading: return "loading";
    case UnitPin::Failed: return "failed";
    case UnitPin::Loaded: return it->second.patch ? "patch:" + it->second.patchId : "embedded";
  }
  return "";
}

}  // namespace otaruntime
