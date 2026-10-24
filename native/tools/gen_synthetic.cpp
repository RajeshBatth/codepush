// gen_synthetic <outdir>: writes old.bin/new.bin (3 MB random binary, 2% scattered byte edits plus 200
// insertions and 200 deletions that shift offsets) and old.js/new.js (JS-like text) for measure_patch.
#include "../tests/testutil.h"

int main(int argc, char** argv) {
  if (argc != 2) { std::fprintf(stderr, "usage: gen_synthetic <outdir>\n"); return 2; }
  std::string d = argv[1];
  fs::create_directories(d);
  Rng r(2024);
  Bytes old = randomBytes(r, 3 * 1024 * 1024);
  writeFile(d + "/old.bin", old);
  writeFile(d + "/new.bin", mutateBinary(r, old, 0.02, 200, 200));
  Rng a(7), b(7);
  writeFile(d + "/old.js", jsLikeBundle(a, 8000));
  writeFile(d + "/new.js", jsLikeBundle(b, 8000, 99, 200));  // 200 of 8000 modules changed
  return 0;
}
