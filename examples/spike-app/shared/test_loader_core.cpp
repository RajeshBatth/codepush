// Host test for the platform-neutral loader primitives. Build/run: see ../README (SPIKE.md) or tools in this dir.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include "ota_unit_loader.h"
#include "otacore/otacore.h"

using namespace otaspike;
static int failures = 0;
#define CHECK(c) do { if (!(c)) { std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #c); failures++; } } while (0)

static std::string writeTmp(const std::string& name, const std::vector<uint8_t>& bytes) {
  std::string p = std::string(std::getenv("TMPDIR") ? std::getenv("TMPDIR") : "/tmp") + "/" + name;
  std::ofstream f(p, std::ios::binary | std::ios::trunc);
  f.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
  return p;
}
static std::vector<uint8_t> fakeHbc(uint32_t version, size_t total) {
  std::vector<uint8_t> b(total, 0xAB);
  uint64_t m = kHermesMagic;
  std::memcpy(b.data(), &m, 8);
  std::memcpy(b.data() + 8, &version, 4);
  return b;
}

int main() {
  MappedFile f;
  auto good = fakeHbc(96, 4096);
  CHECK(mapFile(writeTmp("otaspike_good.hbc", good), f) == LoadStatus::Ok);
  CHECK(f.size == 4096);
  CHECK(reinterpret_cast<uintptr_t>(f.data) % 4 == 0);
  CHECK(hasHermesMagic(f) && bytecodeVersion(f) == 96);
  CHECK(preEvaluateChecks(f, 96, "") == LoadStatus::Ok);
  CHECK(preEvaluateChecks(f, 98, "") == LoadStatus::BytecodeVersionMismatch);
  CHECK(preEvaluateChecks(f, 96, otacore::sha256Hash(good.data(), good.size())) == LoadStatus::Ok);
  CHECK(preEvaluateChecks(f, 96, "sha256:" + std::string(64, '0')) == LoadStatus::HashMismatch);

  // text JavaScript must never pass: Hermes would compile it as SOURCE and run it
  std::string js = "globalThis.__pwned = true;";
  MappedFile t;
  CHECK(mapFile(writeTmp("otaspike_text.js", std::vector<uint8_t>(js.begin(), js.end())), t) == LoadStatus::Ok);
  CHECK(preEvaluateChecks(t, 96, "") == LoadStatus::TooSmall || preEvaluateChecks(t, 96, "") == LoadStatus::NotHermesBytecode);
  std::string longjs(200, ' ');
  longjs += js;
  MappedFile t2;
  CHECK(mapFile(writeTmp("otaspike_text2.js", std::vector<uint8_t>(longjs.begin(), longjs.end())), t2) == LoadStatus::Ok);
  CHECK(preEvaluateChecks(t2, 96, "") == LoadStatus::NotHermesBytecode);

  // magic present but wrong version, truncated, empty, missing
  MappedFile v98;
  CHECK(mapFile(writeTmp("otaspike_v98.hbc", fakeHbc(98, 512)), v98) == LoadStatus::Ok);
  CHECK(preEvaluateChecks(v98, 96, "") == LoadStatus::BytecodeVersionMismatch);
  MappedFile tr;
  CHECK(mapFile(writeTmp("otaspike_trunc.hbc", fakeHbc(96, 6)), tr) == LoadStatus::Ok);
  CHECK(preEvaluateChecks(tr, 96, "") == LoadStatus::TooSmall);
  CHECK(mapFile(writeTmp("otaspike_empty.hbc", {}), f) == LoadStatus::TooSmall);
  CHECK(mapFile("/nonexistent/file.hbc", f) == LoadStatus::IoError);

  // misalignment is detected on a deliberately offset view
  MappedFile off{good.size() ? mapFile(writeTmp("otaspike_good2.hbc", good), f), f.data + 1 : nullptr, 4000};
  CHECK(preEvaluateChecks(off, 96, "") == LoadStatus::Misaligned);

  std::printf(failures ? "FAILED (%d)\n" : "all loader-core checks passed\n", failures);
  return failures ? 1 : 0;
}
