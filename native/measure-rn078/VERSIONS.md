# Tool versions used (native/measure-rn078)

| Item | Value |
|---|---|
| react-native | **0.78.3** (latest 0.78.x on npm, 2026-10-21; `npm view react-native versions`) |
| hermesc path in tarball | `package/sdks/hermesc/osx-bin/hermesc` (Mach-O universal x86_64 + arm64; also `linux64-bin/hermesc`, `win64-bin/hermesc.exe`) |
| hermesc sha256 | `a82e519e1fa3737f6b95554cdb9edaaf37458fb03abcdc2144f039fa0b3302ab` |
| hermes (runtime CLI) path | `package/sdks/hermesc/osx-bin/hermes`, sha256 `4c695220be111a1c1bf91f1fef08e5a05135fcda0623c89cc59707e792b2960c` |
| `hermesc -version` | "Hermes release version: for RN 0.78.3", **HBC bytecode version: 96**, LLVH 8.0.0svn |
| `package/sdks/.hermesversion` | `hermes-2025-01-13-RNv0.78.0-a942ef374897d85da38e9c8904574f8376555388` |
| HBC header of an emitted file | bytes 0-7 magic `c6 1f bc 03 c1 03 19 1f` (u64 LE 0x1F1903C103BC1FC6), bytes 8-11 version u32 LE = `0x60` = 96 |
| previous prototype compiler | `hermes-compiler@250829098.0.19`, hermesc sha256 `fb0887abe00d833c7fbd6617e6b698a8e52065278cbf5d34822839e5f2dc0830`, bytecode 98 (header `62 00 00 00`) |
| corpus sources | lodash 4.17.21, rxjs 7.8.1 (`dist/cjs`), date-fns 2.30.0, moment 2.30.1 (npm tarballs, extracted only) |
| @react-native/gradle-plugin | 0.78.3 (read only, to confirm Android flags) |

## Bytecode version the RN 0.78 runtime expects: 96

Evidence (all three agree):
1. `sdks/.hermesversion` pins Hermes commit `a942ef374897d85da38e9c8904574f8376555388` (tag `hermes-2025-01-13-RNv0.78.0`); the RN 0.78 `hermes-engine` (iOS pod / Android `com.facebook.react:hermes-android`) is built from that commit.
2. `include/hermes/BCGen/HBC/BytecodeVersion.h` at that exact commit (fetched from raw.githubusercontent.com): `const static uint32_t BYTECODE_VERSION = 96;`
3. The `hermes` runtime CLI shipped in the same tarball ("for RN 0.78.3") reports version 96 and rejects a version-98 file with `Wrong bytecode version. Expected 96 but got 98`.
Caveat: the CLI is the host-built VM, not the device binary; they share source/commit so the version is the same, but we did not extract and inspect libhermes.so from the app's AAR/pod.
So the previous measurements (v98, hermes-compiler) would NOT load on an RN 0.78 device.
Hermes in RN 0.78 builds is pinned per RN release; a RN patch bump may change the hermes commit, so CI must re-derive/assert the version from `.hermesversion` + `hermesc -version`.
