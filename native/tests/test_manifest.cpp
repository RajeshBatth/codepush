// Manifest parsing/validation (negative cases) and select vectors shared with the TS reference.
#include "testutil.h"

using namespace otacore;
using nlohmann::json;

static std::string H(char c) { return "sha256:" + std::string(64, c); }

static json entry(const std::string& id, double a, double b) {
  return {{"id", id}, {"patchUrl", "u"}, {"hash", H('a')}, {"size", 10}, {"updateType", "patch"}, {"range", {a, b}}};
}
static json goodManifest() {
  return {{"schema", 1}, {"platform", "android"}, {"appVersion", "11.9.0"}, {"patchAlgoVer", "v1"},
          {"version", 3}, {"ttlSec", 120},
          {"mainBundle", {{"baseHash", H('1')}, {"entries", json::array({entry("host-pr1", 0, 0.5)})}}},
          {"units", json::array({{{"unitName", "cabs"}, {"baseHash", H('2')},
                                  {"entries", json::array({entry("cabs-pr2", 0, 0.2), entry("cabs-pr1", 0.2, 0.5)})}}})}};
}
static bool hasErr(const ParseResult& r, const char* sub) {
  for (auto& e : r.errors) if (e.find(sub) != std::string::npos) return true;
  return false;
}
static ParseResult parse(const json& j) { return parseManifest(j.dump()); }

static void validation() {
  { ParseResult r = parse(goodManifest()); CHECK(r.ok); CHECK(r.errors.empty()); CHECK_EQ(r.manifest.units.size(), size_t(1)); }
  CHECK(!parseManifest("not json").ok);
  CHECK(!parseManifest("").ok);
  CHECK(!parseManifest("[]").ok);
  { json m = goodManifest(); m["schema"] = 2; CHECK(hasErr(parse(m), "schema must be 1")); }
  { json m = goodManifest(); m["platform"] = "windows"; CHECK(hasErr(parse(m), "platform")); }
  { json m = goodManifest(); m["version"] = 0; CHECK(hasErr(parse(m), "version must be")); }
  { json m = goodManifest(); m["version"] = 1.5; CHECK(hasErr(parse(m), "version must be")); }
  { json m = goodManifest(); m["ttlSec"] = 0; CHECK(hasErr(parse(m), "ttlSec")); }
  { json m = goodManifest(); m["ttlSec"] = 86401; CHECK(hasErr(parse(m), "ttlSec")); }
  { json m = goodManifest(); m.erase("mainBundle"); CHECK(hasErr(parse(m), "mainBundle missing")); }
  { json m = goodManifest(); m["mainBundle"]["baseHash"] = "sha256:XYZ"; CHECK(hasErr(parse(m), "mainBundle.baseHash invalid")); }
  { json m = goodManifest(); m["units"][0]["baseHash"] = "nope"; CHECK(hasErr(parse(m), "baseHash invalid")); }
  { json m = goodManifest(); m["units"][0]["entries"][0]["hash"] = "x"; CHECK(hasErr(parse(m), "hash must be sha256")); }
  { json m = goodManifest(); m["units"][0]["entries"][0]["hash"] = "sha256:" + std::string(63, 'a'); CHECK(!parse(m).ok); }
  { json m = goodManifest(); m["units"][0]["entries"][0]["hash"] = "sha256:" + std::string(64, 'A'); CHECK(!parse(m).ok); }
  { json m = goodManifest(); m["units"][0]["entries"][0]["size"] = 0; CHECK(hasErr(parse(m), "size must be")); }
  { json m = goodManifest(); m["units"][0]["entries"][0]["size"] = "10"; CHECK(hasErr(parse(m), "size must be")); }
  { json m = goodManifest(); m["units"][0]["entries"][0]["updateType"] = "delta"; CHECK(hasErr(parse(m), "updateType")); }
  { json m = goodManifest(); m["units"][0]["entries"][0]["patchUrl"] = ""; CHECK(hasErr(parse(m), "patchUrl missing")); }
  { json m = goodManifest(); m["units"][0]["entries"][0].erase("id"); CHECK(hasErr(parse(m), "id missing")); }
  // ranges
  { json m = goodManifest(); m["units"][0]["entries"][0]["range"] = {-0.1, 0.2}; CHECK(hasErr(parse(m), "0 <= start <= end <= 1")); }
  { json m = goodManifest(); m["units"][0]["entries"][0]["range"] = {0.0, 1.2}; CHECK(hasErr(parse(m), "0 <= start <= end <= 1")); }
  { json m = goodManifest(); m["units"][0]["entries"][0]["range"] = {0.5, 0.2}; CHECK(hasErr(parse(m), "0 <= start <= end <= 1")); }
  { json m = goodManifest(); m["units"][0]["entries"][0]["range"] = {0.5}; CHECK(hasErr(parse(m), "range must be")); }
  { json m = goodManifest(); m["units"][0]["entries"][0]["range"] = {"a", "b"}; CHECK(hasErr(parse(m), "range must be")); }
  { json m = goodManifest(); m["units"][0]["entries"][1]["range"] = {0.1, 0.5}; CHECK(hasErr(parse(m), "overlap")); }
  // touching ranges are fine; empty ranges never overlap; absent range = [0,1) overlaps anything non-empty
  { json m = goodManifest(); m["units"][0]["entries"][1]["range"] = {0.2, 0.2}; CHECK(parse(m).ok); }
  { json m = goodManifest(); m["units"][0]["entries"][0].erase("range"); CHECK(hasErr(parse(m), "overlap")); }
  { json m = goodManifest(); m["units"][0]["entries"] = json::array({entry("only", 0, 1)}); CHECK(parse(m).ok); }
  // duplicate ids (within unit, and across host/unit), duplicate unit
  { json m = goodManifest(); m["units"][0]["entries"][1]["id"] = "cabs-pr2"; CHECK(hasErr(parse(m), "duplicate")); }
  { json m = goodManifest(); m["units"][0]["entries"][1]["id"] = "host-pr1"; CHECK(hasErr(parse(m), "duplicate")); }
  { json m = goodManifest(); m["units"].push_back(m["units"][0]); CHECK(hasErr(parse(m), "duplicate")); }
  // requiresHost
  { json m = goodManifest(); m["units"][0]["entries"][0]["requiresHost"] = "host-pr1"; CHECK(parse(m).ok); }
  { json m = goodManifest(); m["units"][0]["entries"][0]["requiresHost"] = nullptr; CHECK(parse(m).ok); }
  { json m = goodManifest(); m["units"][0]["entries"][0]["requiresHost"] = "nope"; CHECK(hasErr(parse(m), "requiresHost")); }
  { json m = goodManifest(); m["mainBundle"]["entries"][0]["requiresHost"] = "host-pr1"; CHECK(hasErr(parse(m), "requiresHost")); }
  // wrong shapes must produce errors, not crashes
  { json m = goodManifest(); m["units"] = "x"; CHECK(hasErr(parse(m), "units must be an array")); }
  { json m = goodManifest(); m["units"][0]["entries"] = 5; CHECK(hasErr(parse(m), "entries must be an array")); }
  { json m = goodManifest(); m["units"][0]["entries"][0] = 5; CHECK(!parse(m).ok); }
  { json m = goodManifest(); m["units"][0] = nullptr; CHECK(!parse(m).ok); }
  // multiple errors are all reported
  { json m = goodManifest(); m["schema"] = 9; m["ttlSec"] = 0; CHECK(parse(m).errors.size() >= 2); }
  // failed parse yields an empty manifest
  { json m = goodManifest(); m["schema"] = 2; CHECK(parse(m).manifest.units.empty()); }
}

static void selectVectors() {
  json v = json::parse(readText(VECTORS_DIR "/select.json"));
  ParseResult pr = parseManifest(v["manifest"].dump());
  CHECK(pr.ok);
  if (!pr.ok) for (auto& e : pr.errors) std::fprintf(stderr, "  %s\n", e.c_str());
  int n = 0;
  for (auto& c : v["cases"]) {
    SelectContext ctx;
    ctx.bucket = c["ctx"]["bucket"].get<double>();
    ctx.embeddedHash = c["ctx"]["embeddedHash"].get<std::string>();
    for (auto& a : c["ctx"]["supportedAlgos"]) ctx.supportedAlgos.push_back(a.get<std::string>());
    ctx.runningHostId = c["ctx"]["runningHostId"].get<std::string>();
    Selection s = selectUnit(pr.manifest, c["unit"].get<std::string>(), ctx);
    auto& ex = c["expect"];
    CHECK_EQ(std::string(s.source == Source::Patch ? "patch" : "embedded"), ex["source"].get<std::string>());
    CHECK_EQ(std::string(s.reason), ex["reason"].get<std::string>());
    if (ex["entryId"].is_null()) CHECK(s.entry == nullptr);
    else { CHECK(s.entry != nullptr); if (s.entry) CHECK_EQ(s.entry->id, ex["entryId"].get<std::string>()); }
    n++;
  }
  std::printf("select vectors: %d\n", n);

  // selectHost: the vectors only cover units, so test host selection here.
  SelectContext ctx;
  ctx.supportedAlgos = {"v1"};
  ctx.embeddedHash = pr.manifest.mainBundle.baseHash;
  ctx.bucket = 0.25;
  Selection h = selectHost(pr.manifest, ctx);
  CHECK(h.source == Source::Patch && h.entry && h.entry->id == "host-pr88");
  ctx.bucket = 0.75;
  h = selectHost(pr.manifest, ctx);
  CHECK(h.source == Source::Embedded && std::string(h.reason) == "no-range-match");
  ctx.bucket = 0.25; ctx.embeddedHash = "sha256:" + std::string(64, '0');
  CHECK_EQ(std::string(selectHost(pr.manifest, ctx).reason), std::string("base-mismatch"));
  ctx.embeddedHash = pr.manifest.mainBundle.baseHash; ctx.supportedAlgos = {"v2"};
  CHECK_EQ(std::string(selectHost(pr.manifest, ctx).reason), std::string("algo-unsupported"));
  ctx.supportedAlgos = {"v1"};
  CHECK_EQ(std::string(selectUnit(pr.manifest, "nope", ctx).reason), std::string("unit-not-in-manifest"));
}

int main() {
  validation();
  selectVectors();
  TEST_MAIN_END();
}
