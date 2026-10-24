// Mirror of packages/ota-core/src/select.ts (DESIGN 5.2 step 2). Pure functions.
#include <algorithm>

#include "otacore/otacore.h"

namespace otacore {
namespace {
bool contains(const Entry& e, double b) {
  double s = e.hasRange ? e.rangeStart : 0.0, t = e.hasRange ? e.rangeEnd : 1.0;
  return s <= b && b < t;
}

Selection embedded(const char* reason) { return Selection{Source::Embedded, nullptr, reason}; }

Selection pick(const std::vector<Entry>& entries, const SelectContext& ctx, const std::string& runningHost) {
  // The bucket falls in at most one range (validated). If its owner is ineligible the answer is
  // embedded: v1 deliberately does not search for an older patch.
  for (const Entry& e : entries) {
    if (!contains(e, ctx.bucket)) continue;
    if (e.hasRequiresHost && e.requiresHost != runningHost) return embedded("requires-host-mismatch");
    return Selection{Source::Patch, &e, "ok"};
  }
  return embedded("no-range-match");
}

bool algoSupported(const Manifest& m, const SelectContext& ctx) {
  return std::find(ctx.supportedAlgos.begin(), ctx.supportedAlgos.end(), m.patchAlgoVer) != ctx.supportedAlgos.end();
}
}  // namespace

Selection selectUnit(const Manifest& m, std::string_view unitName, const SelectContext& ctx) {
  if (!algoSupported(m, ctx)) return embedded("algo-unsupported");
  for (const UnitManifest& u : m.units) {
    if (u.unitName != unitName) continue;
    if (u.baseHash != ctx.embeddedHash) return embedded("base-mismatch");
    return pick(u.entries, ctx, ctx.runningHostId);
  }
  return embedded("unit-not-in-manifest");
}

Selection selectHost(const Manifest& m, const SelectContext& ctx) {
  if (!algoSupported(m, ctx)) return embedded("algo-unsupported");
  if (m.mainBundle.baseHash != ctx.embeddedHash) return embedded("base-mismatch");
  return pick(m.mainBundle.entries, ctx, "embedded");  // requiresHost is meaningless for the host
}

}  // namespace otacore
