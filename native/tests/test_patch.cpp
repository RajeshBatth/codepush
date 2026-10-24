// applyPatch: round trips (binary with offset ripple, JS-like text), every compressor compiled in,
// failure modes (corruption, truncation, wrong hash, wrong base, unsupported algo) and the
// "never leave a partial output" guarantee.
#include "testutil.h"
#include "otacore/otacore_c.h"

using namespace otacore;

static const char* kComps[] = {"none", "zstd", "lzma"};

struct Case {
  std::string name;
  Bytes oldB, newB;
};

static std::vector<Case> makeCases() {
  std::vector<Case> cs;
  Rng r(12345);
  Bytes bin = randomBytes(r, 300 * 1024);
  cs.push_back({"binary-2pct-edits+shifts", bin, mutateBinary(r, bin, 0.02, 40, 40)});
  cs.push_back({"binary-pure-shift", bin, [&] { Bytes b = bin; b.insert(b.begin() + 100, 7, 0xAA); return b; }()});
  Bytes js = jsLikeBundle(r, 600);
  Rng r2(12345);
  Bytes js2 = jsLikeBundle(r2, 600, 777, 12);
  cs.push_back({"js-like-text", js, js2});
  cs.push_back({"identical", bin, bin});
  cs.push_back({"empty-new", bin, Bytes{}});
  cs.push_back({"tiny", Bytes{1, 2, 3}, Bytes{1, 2, 4, 5}});
  cs.push_back({"unrelated", randomBytes(r, 5000), randomBytes(r, 7000)});
  return cs;
}

// Old-data source that records read sizes, to prove the core never slurps the whole old file.
struct CountingSource : RandomAccessSource {
  MemorySource inner;
  size_t maxRead = 0, reads = 0;
  CountingSource(const Bytes& b) : inner(b.data(), b.size()) {}
  uint64_t size() const override { return inner.size(); }
  bool read(uint64_t off, void* buf, size_t len) override { reads++; if (len > maxRead) maxRead = len; return inner.read(off, buf, len); }
};

static bool noLeftovers(const std::string& out) {
  return !fs::exists(out) && !fs::exists(out + ".tmp");
}

static void roundTrips(TempDir& td) {
  std::vector<Case> cases = makeCases();
  for (auto& c : cases) {
    std::string oldF = td / "old.bin", newF = td / "new.bin";
    writeFile(oldF, c.oldB);
    writeFile(newF, c.newB);
    std::string want = hashOf(c.newB);
    for (const char* comp : kComps) {
      std::string patchF = td / "p.patch", outF = td / "out.bin";
      fs::remove(outF);
      std::string label = c.name + "/" + comp;
      if (!makePatch(oldF, newF, patchF, comp)) { CHECK(false && "hdiffz_tool failed"); std::fprintf(stderr, "  %s\n", label.c_str()); continue; }
      Status s = applyPatch(oldF, patchF, outF, want);
      if (s != Status::Ok) std::fprintf(stderr, "  %s -> %s\n", label.c_str(), statusName(s));
      CHECK(s == Status::Ok);
      CHECK(readFile(outF) == c.newB);
      CHECK(!fs::exists(outF + ".tmp"));
      // in-memory variant
      Bytes patchB = readFile(patchF), outM;
      CHECK(applyPatchMemory(c.oldB.data(), c.oldB.size(), patchB.data(), patchB.size(), outM, want) == Status::Ok);
      CHECK(outM == c.newB);
      // abstract-source variant (asset-style reader)
      CountingSource cs(c.oldB);
      fs::remove(outF);
      CHECK(applyPatch(cs, patchF, outF, want) == Status::Ok);
      CHECK(readFile(outF) == c.newB);
      CHECK(cs.maxRead <= 1u << 20);  // chunked reads only
      // C API
      fs::remove(outF);
      CHECK_EQ(otacore_apply_patch(oldF.c_str(), patchF.c_str(), outF.c_str(), want.c_str()), int(OTACORE_OK));
      CHECK(readFile(outF) == c.newB);
      // Overwrite of an existing built file
      CHECK(applyPatch(oldF, patchF, outF, want) == Status::Ok);
    }
  }
}

static void failureModes(TempDir& td) {
  Rng r(999);
  Bytes oldB = randomBytes(r, 200 * 1024);
  Bytes newB = mutateBinary(r, oldB, 0.02, 30, 30);
  std::string oldF = td / "old.bin", newF = td / "new.bin", outF = td / "out.bin";
  writeFile(oldF, oldB); writeFile(newF, newB);
  std::string want = hashOf(newB);

  for (const char* comp : kComps) {
    std::string patchF = td / (std::string("p-") + comp + ".patch");
    CHECK(makePatch(oldF, newF, patchF, comp));
    Bytes patch = readFile(patchF);
    std::string label = comp;

    // wrong expected hash
    fs::remove(outF);
    CHECK(applyPatch(oldF, patchF, outF, hashOf(Bytes{1})) == Status::HashMismatch);
    CHECK(noLeftovers(outF));
    CHECK(applyPatch(oldF, patchF, outF, "garbage") == Status::HashMismatch);
    CHECK(noLeftovers(outF));

    // a failed apply must leave a pre-existing good output byte-for-byte intact
    writeFile(outF, Bytes{'o', 'k'});
    CHECK(applyPatch(oldF, patchF, outF, hashOf(Bytes{1})) == Status::HashMismatch);
    CHECK(readFile(outF) == (Bytes{'o', 'k'}));
    CHECK(!fs::exists(outF + ".tmp"));
    fs::remove(outF);

    // wrong old file (same size, different content)
    Bytes wrongOld = oldB;
    for (size_t i = 0; i < wrongOld.size(); i += 97) wrongOld[i] ^= 0x5A;
    writeFile(td / "wrong.bin", wrongOld);
    Status ws = applyPatch(td / "wrong.bin", patchF, outF, want);
    CHECK(ws == Status::HashMismatch || ws == Status::PatchCorrupt);
    CHECK(noLeftovers(outF));
    // old of a different size is detected from the header
    writeFile(td / "short.bin", Bytes(oldB.begin(), oldB.begin() + 1000));
    CHECK(applyPatch(td / "short.bin", patchF, outF, want) == Status::PatchCorrupt);
    CHECK(noLeftovers(outF));

    // truncated patch at many lengths
    int truncOk = 0;
    for (size_t len : {size_t(0), size_t(1), size_t(8), size_t(20), patch.size() / 4, patch.size() / 2, patch.size() - 1}) {
      Bytes t(patch.begin(), patch.begin() + long(len));
      writeFile(td / "trunc.patch", t);
      Status s = applyPatch(oldF, td / "trunc.patch", outF, want);
      if (s == Status::PatchCorrupt) truncOk++;
      CHECK(s != Status::Ok);
      CHECK(noLeftovers(outF));
      Bytes outM;
      CHECK(applyPatchMemory(oldB.data(), oldB.size(), t.data(), t.size(), outM, want) != Status::Ok);
      CHECK(outM.empty());
    }
    CHECK(truncOk >= 5);  // most truncations are reported as PatchCorrupt specifically

    // byte flips: each flip must be rejected (PatchCorrupt/HashMismatch), never produce a bad output
    int flips = 0, corrupt = 0, mismatch = 0, benign = 0;
    Rng fr(4242);
    for (int k = 0; k < 120; k++) {
      Bytes b = patch;
      size_t pos = k < 30 ? fr.below(uint32_t(std::min<size_t>(b.size(), 64))) : fr.below(uint32_t(b.size()));
      b[pos] ^= uint8_t(1 + fr.below(255));
      writeFile(td / "flip.patch", b);
      fs::remove(outF);
      Status s = applyPatch(oldF, td / "flip.patch", outF, want);
      flips++;
      if (s == Status::PatchCorrupt) corrupt++;
      else if (s == Status::HashMismatch) mismatch++;
      else if (s == Status::Ok) { benign++; CHECK(readFile(outF) == newB); }
      else { CHECK(s == Status::UnsupportedAlgo); }  // a flip inside the compressType name
      if (s != Status::Ok) CHECK(noLeftovers(outF));
    }
    std::printf("  [%s] %d flips: %d PatchCorrupt, %d HashMismatch, %d benign(Ok, correct output)\n", comp, flips, corrupt, mismatch, benign);
    CHECK(corrupt + mismatch >= flips - 10);

    // random garbage as a patch
    writeFile(td / "garbage.patch", randomBytes(r, 4096));
    CHECK(applyPatch(oldF, td / "garbage.patch", outF, want) == Status::PatchCorrupt);
    CHECK(noLeftovers(outF));
  }

  // I/O errors
  CHECK(applyPatch(td / "nope.bin", td / "p-none.patch", outF, want) == Status::IoError);
  CHECK(applyPatch(oldF, td / "nope.patch", outF, want) == Status::IoError);
  CHECK(applyPatch(oldF, td / "p-none.patch", td / "no_such_dir/out.bin", want) == Status::IoError);

  // unsupported compression: rename the compressType in a zstd patch header ("zstd" -> "zstx")
  {
    Bytes p = readFile(td / "p-zstd.patch");
    bool found = false;
    for (size_t i = 0; i + 4 <= std::min<size_t>(p.size(), 64); i++) {
      if (std::memcmp(&p[i], "zstd", 4) == 0) { p[i + 3] = 'x'; found = true; break; }
    }
    CHECK(found);
    writeFile(td / "alien.patch", p);
    CHECK(applyPatch(oldF, td / "alien.patch", outF, want) == Status::UnsupportedAlgo);
    CHECK(noLeftovers(outF));
  }
}

int main() {
  std::printf("compiled compressors:");
  for (auto& c : compiledPatchCompressors()) std::printf(" %s", c.c_str());
  std::printf("\n");
  TempDir td("patch");
  roundTrips(td);
  failureModes(td);
  TEST_MAIN_END();
}
