// Tiny executables used by tools/measure_size.sh to estimate the binary-size cost of the patch side.
// size_probe_base calls only sha256; size_probe also calls applyPatch.
// The difference after -dead_strip + strip is the footprint of HDiffPatch + enabled plugins + patch.cpp.
#include <cstdio>
#include "otacore/otacore.h"
int main(int argc, char** argv) {
  if (argc < 2) return 1;
#if defined(WITH_MANIFEST)
  std::string h(argv[1]);
  auto r = otacore::parseManifest(h);
  otacore::SelectContext c;
  c.bucket = otacore::bucket(argv[0], argv[1]);
  auto sel = r.ok ? otacore::selectUnit(r.manifest, "u", c) : otacore::Selection{};
  std::printf("%d %d\n", int(r.ok), int(sel.source));
  return 0;
#elif defined(WITH_PATCH)
  if (argc < 5) return 1;
  return int(otacore::applyPatch(argv[1], argv[2], argv[3], argv[4]));
#else
  std::string h;
  otacore::sha256File(argv[1], h);
  std::printf("%s\n", h.c_str());
  return 0;
#endif
}
