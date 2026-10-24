// hdiffz_tool: create a HDiffPatch "single compressed diff" between two files.
//   hdiffz_tool [-c none|zstd|lzma] [-l level] [-m minMatchScore] old new out.patch
// Test/measurement tool only; the SDK never links the diff side.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "libHDiffPatch/HDiff/diff.h"
#include "compress_plugin_demo.h"

static bool readAll(const char* p, std::vector<unsigned char>& v) {
  FILE* f = fopen(p, "rb");
  if (!f) return false;
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  v.resize(size_t(n));
  bool ok = n == 0 || fread(v.data(), 1, size_t(n), f) == size_t(n);
  fclose(f);
  return ok;
}

int main(int argc, char** argv) {
  std::string comp = "none";
  int level = -1, score = 4;
  int i = 1;
  for (; i < argc && argv[i][0] == '-' && argv[i][1]; i += 2) {
    if (i + 1 >= argc) break;
    if (!strcmp(argv[i], "-c")) comp = argv[i + 1];
    else if (!strcmp(argv[i], "-l")) level = atoi(argv[i + 1]);
    else if (!strcmp(argv[i], "-m")) score = atoi(argv[i + 1]);
    else { fprintf(stderr, "unknown option %s\n", argv[i]); return 2; }
  }
  if (argc - i != 3) {
    fprintf(stderr, "usage: hdiffz_tool [-c none|zstd|lzma] [-l level] [-m score] old new out.patch\n");
    return 2;
  }
  std::vector<unsigned char> oldD, newD;
  if (!readAll(argv[i], oldD) || !readAll(argv[i + 1], newD)) { fprintf(stderr, "cannot read inputs\n"); return 1; }

  const hdiff_TCompress* plugin = 0;
  static TCompressPlugin_zstd zp = zstdCompressPlugin;
  static TCompressPlugin_lzma lp = lzmaCompressPlugin;
  if (comp == "zstd") { zp.compress_level = level < 0 ? 19 : level; plugin = &zp.base; }
  else if (comp == "lzma") { lp.compress_level = level < 0 ? 9 : level; plugin = &lp.base; }
  else if (comp != "none") { fprintf(stderr, "unknown compressor %s\n", comp.c_str()); return 2; }

  std::vector<unsigned char> diff;
  const unsigned char* ob = oldD.data();
  const unsigned char* nb = newD.data();
  try {
    create_single_compressed_diff(nb, nb + newD.size(), ob, ob + oldD.size(), diff, plugin,
                                  kDefaultPatchStepMemSize, score);
  } catch (const std::exception& e) {
    fprintf(stderr, "diff failed: %s\n", e.what());
    return 1;
  }
  FILE* f = fopen(argv[i + 2], "wb");
  if (!f || fwrite(diff.data(), 1, diff.size(), f) != diff.size()) { fprintf(stderr, "cannot write output\n"); return 1; }
  fclose(f);
  return 0;
}
