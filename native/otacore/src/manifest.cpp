// Manifest parsing + integrity validation. Mirrors validateManifest() in
// packages/ota-core/src/manifest.ts (rules and, where practical, error wording).
// Unlike the TS version, which receives an already-typed object, this also has to reject
// wrong JSON types, so type checks are folded into the same pass.
#include <algorithm>
#include <cmath>
#include <set>

#include "nlohmann/json.hpp"
#include "otacore/otacore.h"

namespace otacore {
namespace {
using nlohmann::json;

bool asInt(const json* j, int64_t& out) {
  if (!j) return false;
  if (j->is_number_integer()) { out = j->get<int64_t>(); return true; }
  if (j->is_number_float()) {  // JS treats 10.0 as an integer; so do we
    double d = j->get<double>();
    if (std::isfinite(d) && d == std::floor(d) && std::fabs(d) < 9e15) { out = int64_t(d); return true; }
  }
  return false;
}
const json* field(const json& o, const char* k) {
  if (!o.is_object()) return nullptr;
  auto it = o.find(k);
  return it == o.end() ? nullptr : &*it;
}
bool nonEmptyString(const json* j, std::string& out) {
  if (!j || !j->is_string()) return false;
  out = j->get<std::string>();
  return !out.empty();
}

struct Ctx {
  std::vector<std::string>& errors;
  std::set<std::string> seenIds;
};

struct RangeRec { std::string id; double s, e; };

void parseEntries(const std::string& path, const json* arr, const std::set<std::string>& hostIds,
                  Ctx& c, std::vector<Entry>& out) {
  if (!arr || !arr->is_array()) { c.errors.push_back(path + ".entries must be an array"); return; }
  std::vector<RangeRec> nonEmpty;
  size_t i = 0;
  for (const json& je : *arr) {
    std::string p = path + ".entries[" + std::to_string(i++) + "]";
    Entry e;
    if (!je.is_object()) { c.errors.push_back(p + " must be an object"); continue; }
    if (!nonEmptyString(field(je, "id"), e.id)) c.errors.push_back(p + ".id missing");
    else if (c.seenIds.count(e.id)) c.errors.push_back(p + ".id duplicate: " + e.id);
    else c.seenIds.insert(e.id);
    if (!nonEmptyString(field(je, "patchUrl"), e.patchUrl)) c.errors.push_back(p + ".patchUrl missing");
    const json* h = field(je, "hash");
    if (!h || !h->is_string() || !isHash(h->get<std::string>())) c.errors.push_back(p + ".hash must be sha256:<64 hex>");
    else e.hash = h->get<std::string>();
    if (!asInt(field(je, "size"), e.size) || e.size <= 0) c.errors.push_back(p + ".size must be a positive integer");
    const json* ut = field(je, "updateType");
    if (!ut || !ut->is_string() || (ut->get<std::string>() != "patch" && ut->get<std::string>() != "full"))
      c.errors.push_back(p + ".updateType must be patch|full");
    else e.updateType = ut->get<std::string>();
    if (const json* r = field(je, "range")) {
      if (!r->is_array() || r->size() != 2 || !(*r)[0].is_number() || !(*r)[1].is_number() ||
          !std::isfinite((*r)[0].get<double>()) || !std::isfinite((*r)[1].get<double>())) {
        c.errors.push_back(p + ".range must be [start,end]");
      } else {
        e.hasRange = true;
        e.rangeStart = (*r)[0].get<double>();
        e.rangeEnd = (*r)[1].get<double>();
        if (e.rangeStart < 0 || e.rangeEnd > 1 || e.rangeStart > e.rangeEnd)
          c.errors.push_back(p + ".range must satisfy 0 <= start <= end <= 1");
      }
    }
    if (const json* rh = field(je, "requiresHost")) {
      if (!rh->is_null()) {
        if (!rh->is_string()) c.errors.push_back(p + ".requiresHost must be a string or null");
        else {
          e.hasRequiresHost = true;
          e.requiresHost = rh->get<std::string>();
          if (!hostIds.count(e.requiresHost))
            c.errors.push_back(p + ".requiresHost \"" + e.requiresHost + "\" does not match a mainBundle entry id");
        }
      }
    }
    double s = e.hasRange ? e.rangeStart : 0.0, t = e.hasRange ? e.rangeEnd : 1.0;
    if (!(t <= s)) nonEmpty.push_back({e.id, s, t});  // empty ranges ([x,x], halted) never overlap
    out.push_back(std::move(e));
  }
  std::stable_sort(nonEmpty.begin(), nonEmpty.end(), [](const RangeRec& a, const RangeRec& b) { return a.s < b.s; });
  for (size_t k = 1; k < nonEmpty.size(); k++) {
    if (nonEmpty[k].s < nonEmpty[k - 1].e)
      c.errors.push_back(path + ": ranges of " + nonEmpty[k - 1].id + " and " + nonEmpty[k].id +
                         " overlap (sum of shares must be <= 1)");
  }
}

bool isHashField(const json* j, std::string& out) {
  if (!j || !j->is_string() || !isHash(j->get<std::string>())) return false;
  out = j->get<std::string>();
  return true;
}

void parseInto(const json& j, Manifest& m, std::vector<std::string>& errors) {
  Ctx c{errors, {}};
  if (!j.is_object()) { errors.push_back("manifest must be a JSON object"); return; }
  int64_t v = 0;
  if (!asInt(field(j, "schema"), v) || v != 1) errors.push_back("schema must be 1");
  else m.schema = 1;
  const json* pl = field(j, "platform");
  if (!pl || !pl->is_string() || (pl->get<std::string>() != "android" && pl->get<std::string>() != "ios"))
    errors.push_back("platform must be android|ios");
  else m.platform = pl->get<std::string>();
  if (!nonEmptyString(field(j, "appVersion"), m.appVersion)) errors.push_back("appVersion missing");
  if (!nonEmptyString(field(j, "patchAlgoVer"), m.patchAlgoVer)) errors.push_back("patchAlgoVer missing");
  if (!asInt(field(j, "version"), m.version) || m.version < 1) errors.push_back("version must be an integer >= 1");
  if (!asInt(field(j, "ttlSec"), m.ttlSec) || m.ttlSec < 1 || m.ttlSec > 86400) errors.push_back("ttlSec must be 1..86400");
  const json* mb = field(j, "mainBundle");
  if (!mb || !mb->is_object()) { errors.push_back("mainBundle missing"); return; }
  if (!isHashField(field(*mb, "baseHash"), m.mainBundle.baseHash)) errors.push_back("mainBundle.baseHash invalid");
  parseEntries("mainBundle", field(*mb, "entries"), {}, c, m.mainBundle.entries);
  std::set<std::string> hostIds;
  for (auto& e : m.mainBundle.entries) hostIds.insert(e.id);
  const json* units = field(j, "units");
  if (!units || !units->is_array()) { errors.push_back("units must be an array"); return; }
  std::set<std::string> names;
  size_t i = 0;
  for (const json& ju : *units) {
    UnitManifest u;
    std::string nm = ju.is_object() && field(ju, "unitName") && field(ju, "unitName")->is_string()
                         ? field(ju, "unitName")->get<std::string>() : "";
    std::string p = "units[" + std::to_string(i++) + "](" + nm + ")";
    if (!ju.is_object()) { errors.push_back(p + " must be an object"); continue; }
    if (!nonEmptyString(field(ju, "unitName"), u.unitName)) errors.push_back(p + ".unitName missing");
    else if (names.count(u.unitName)) errors.push_back(p + " duplicate unit");
    else names.insert(u.unitName);
    if (!isHashField(field(ju, "baseHash"), u.baseHash)) errors.push_back(p + ".baseHash invalid");
    parseEntries(p, field(ju, "entries"), hostIds, c, u.entries);
    m.units.push_back(std::move(u));
  }
}
}  // namespace

ParseResult parseManifest(std::string_view text) {
  ParseResult r;
  try {
    json j = json::parse(text.begin(), text.end(), nullptr, /*allow_exceptions=*/false);
    if (j.is_discarded()) { r.errors.push_back("manifest is not valid JSON"); return r; }
    parseInto(j, r.manifest, r.errors);
  } catch (const std::exception& e) {  // defensive: nothing should throw past here
    r.errors.push_back(std::string("internal error: ") + e.what());
  } catch (...) {
    r.errors.push_back("internal error");
  }
  r.ok = r.errors.empty();
  if (!r.ok) r.manifest = Manifest{};
  return r;
}

std::vector<std::string> allEntryIds(const Manifest& m) {
  std::vector<std::string> ids;
  for (auto& e : m.mainBundle.entries) ids.push_back(e.id);
  for (auto& u : m.units) for (auto& e : u.entries) ids.push_back(e.id);
  return ids;
}

}  // namespace otacore
