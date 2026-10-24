# Third-party code

All fetched once from GitHub / npm (untrusted downloads): only specific sources are compiled by our own
CMake (`native/CMakeLists.txt`). No upstream build system or script was run. `.git` directories and
unused parts (tests, other plugins, directory-diff, bsdiff, vcdiff, docs) were removed to keep the tree small.

| Component | Version / tag | Commit SHA | License | Used for |
|---|---|---|---|---|
| HDiffPatch (sisong/HDiffPatch) | v5.1.3 | `3b9dca715ca492873bf2c49e22e5d5b7d2a78620` | MIT | patch side `libHDiffPatch/HPatch/*.c` (ships); diff side `libHDiffPatch/HDiff/*` (test/measure tool only); plugin headers `decompress_plugin_demo.h`, `compress_plugin_demo.h`, `compress_parallel.*`, `libParallel/` |
| zstd (facebook/zstd, upstream, not the sisong fork) | v1.5.7 | `f8745da6ff1ad1e7bab384bd1f9d742439278e99` | BSD-3-Clause (dual BSD / GPLv2; we use BSD, see `zstd/LICENSE`) | decoder (ships); encoder (tool only) |
| LZMA SDK (sisong/lzma, a mirror of 7-Zip LZMA SDK 26.02) | HEAD of default branch at fetch time (no tag matches the SDK version) | `44809544b95bbf2dccec75d954657ff76fc349ff` | Public domain (Igor Pavlov) | LzmaDec (ships, optional); LzmaEnc/LzFind (tool only) |
| nlohmann/json single header | v3.12.0 | tag commit `65ee68451d8eb2b5f3a30b410476ab83deb3289b`; `json.hpp` sha256 `aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63` | MIT | manifest parsing (`include/nlohmann/json.hpp`) |

HDiffPatch normally pairs with sisong's zstd/lzma forks; upstream zstd 1.5.7 works unmodified with
`decompress_plugin_demo.h` / `compress_plugin_demo.h` (verified by the round-trip tests).

## Compression plugins compiled into the PATCH side (what ships in the app)

Selected by CMake options `OTACORE_ZSTD` (ON) and `OTACORE_LZMA` (ON). The diff format is HDiffPatch's
"single compressed diff" (`create_single_compressed_diff` / `patch_single_stream`), the compress type is
stored in the patch header, so a patch whose compressor isn't compiled in is rejected with
`UnsupportedAlgo` (never misapplied).

Measured by `tools/measure_size.sh` (macOS arm64, clang `-Os -ffunction-sections -fdata-sections`, `-dead_strip`,
`strip -x`; sum of `__TEXT`+`__DATA` section bytes of a probe executable with vs without a reachable `applyPatch`):

| Patch-side configuration | Size added to the binary |
|---|---:|
| HDiffPatch core + our glue, uncompressed diffs only | ~12 KB |
| + zstd decoder (`OTACORE_ZSTD_SMALL=ON`: X1 Huffman only, short-sequence path) | ~57 KB total |
| + zstd decoder, default zstd build (both Huffman decoders; `OTACORE_ZSTD_SMALL=OFF`) | ~85 KB total |
| + lzma decoder only | ~23 KB total |
| + zstd (small) + lzma | ~67 KB total |

Not included in those numbers: the manifest parser (nlohmann/json), which costs ~91 KB by itself.
