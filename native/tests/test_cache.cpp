#include "testutil.h"
#include "otacore/otacore_c.h"

using namespace otacore;

static std::string H(char c) { return "sha256:" + std::string(64, c); }

static void cacheTests() {
  TempDir td("cache");
  // Pre-existing roots: other versions + junk
  fs::create_directories(td.path / "codepush" / "11.8.0-100");
  writeFile(td / "codepush/11.8.0-100/cabs-pr1.bundle", Bytes{1});
  fs::create_directories(td.path / "codepush" / "11.9.0-100");  // same version, other build number
  fs::create_directories(td.path / "codepush" / "11.9.0-101");
  writeFile(td / "codepush/11.9.0-101/keep-pr1.bundle", Bytes{1});

  Cache c(td.path.string(), "11.9.0", "101");
  CHECK(c.ok());
  CHECK(!fs::exists(td.path / "codepush" / "11.8.0-100"));
  CHECK(!fs::exists(td.path / "codepush" / "11.9.0-100"));
  CHECK(fs::exists(td.path / "codepush" / "11.9.0-101"));
  CHECK(c.has("keep-pr1"));  // our own root is preserved across restarts
  CHECK(!c.has("nothing"));

  // gc: keep ids referenced by the manifest, remove the rest (old builds, patches, temp files, dirs)
  writeFile(c.builtPath("cabs-pr1"), Bytes{1});
  writeFile(c.builtPath("cabs-pr2"), Bytes{2});
  writeFile(c.builtPath("bus-pr9"), Bytes{3});
  writeFile(c.patchPath("cabs-pr2"), Bytes{4});
  writeFile(c.builtPath("cabs-pr2") + ".tmp", Bytes{5});
  fs::create_directories(td.path / "codepush" / "11.9.0-101" / "stray");
  size_t removed = c.gc({"cabs-pr1", "keep-pr1", "../evil"});
  CHECK_EQ(removed, size_t(5));  // cabs-pr2.bundle, bus-pr9.bundle, cabs-pr2.patch, .tmp, stray/
  CHECK(c.has("cabs-pr1"));
  CHECK(c.has("keep-pr1"));
  CHECK(!c.has("cabs-pr2"));
  CHECK(!c.has("bus-pr9"));
  CHECK(!fs::exists(c.patchPath("cabs-pr2")));
  CHECK_EQ(c.gc({"cabs-pr1", "keep-pr1"}), size_t(0));  // idempotent

  // ids from a manifest can't escape the root
  CHECK(c.builtPath("../x").empty());
  CHECK(c.builtPath("a/b").empty());
  CHECK(c.builtPath("..").empty());
  // bad version tokens are rejected
  CHECK(!Cache(td.path.string(), "../x", "1").ok());

  // gc with ids from a parsed manifest
  nlohmann::json m = {{"schema", 1}, {"platform", "ios"}, {"appVersion", "11.9.0"}, {"patchAlgoVer", "v1"}, {"version", 1}, {"ttlSec", 60},
      {"mainBundle", {{"baseHash", H('1')}, {"entries", nlohmann::json::array()}}},
      {"units", nlohmann::json::array({{{"unitName", "cabs"}, {"baseHash", H('2')},
        {"entries", nlohmann::json::array({{{"id", "cabs-pr1"}, {"patchUrl", "u"}, {"hash", H('3')}, {"size", 1}, {"updateType", "patch"}}})}}})}};
  ParseResult pr = parseManifest(m.dump());
  CHECK(pr.ok);
  auto ids = allEntryIds(pr.manifest);
  CHECK_EQ(ids.size(), size_t(1));
  c.gc(ids);
  CHECK(c.has("cabs-pr1"));
  CHECK(!c.has("keep-pr1"));
}

static void cApiTests() {
  // validate
  char* errs = nullptr;
  CHECK_EQ(otacore_validate_manifest("{}", 2, &errs), 0);
  CHECK(errs != nullptr);
  otacore_free(errs);
  // select against the shared vector manifest
  nlohmann::json v = nlohmann::json::parse(readText(VECTORS_DIR "/select.json"));
  std::string mj = v["manifest"].dump();
  CHECK_EQ(otacore_validate_manifest(mj.data(), mj.size(), nullptr), 1);
  std::string base = v["manifest"]["units"][0]["baseHash"].get<std::string>();
  char* out = otacore_select(mj.data(), mj.size(), "cabs", 0.1, base.c_str(), "v1", "embedded");
  CHECK(out != nullptr);
  nlohmann::json r = nlohmann::json::parse(out);
  otacore_free(out);
  CHECK_EQ(r["source"].get<std::string>(), std::string("patch"));
  CHECK_EQ(r["entry"]["id"].get<std::string>(), std::string("cabs-pr12"));
  out = otacore_select(mj.data(), mj.size(), "cabs", 0.1, base.c_str(), "v2,v3", "embedded");
  r = nlohmann::json::parse(out); otacore_free(out);
  CHECK_EQ(r["reason"].get<std::string>(), std::string("algo-unsupported"));
  out = otacore_select("garbage", 7, "cabs", 0.1, base.c_str(), "v1", "embedded");
  r = nlohmann::json::parse(out); otacore_free(out);
  CHECK_EQ(r["reason"].get<std::string>(), std::string("invalid-manifest"));
  // host selection (unit_name == NULL)
  std::string hb = v["manifest"]["mainBundle"]["baseHash"].get<std::string>();
  out = otacore_select(mj.data(), mj.size(), nullptr, 0.1, hb.c_str(), "v1", "embedded");
  r = nlohmann::json::parse(out); otacore_free(out);
  CHECK_EQ(r["entry"]["id"].get<std::string>(), std::string("host-pr88"));
  // sha + bucket
  char* h = otacore_sha256("abc", 3);
  CHECK_EQ(std::string(h), std::string("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
  otacore_free(h);
  CHECK(otacore_bucket("device-0001", "cabs") == bucket("device-0001", "cabs"));
}

int main() {
  cacheTests();
  cApiTests();
  TEST_MAIN_END();
}
