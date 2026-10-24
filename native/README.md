# otacore: native C++ core (prototype)

Platform-neutral C++17 core of the OTA SDK from `DESIGN.md` 5.1-5.6 and 6. It will be wrapped by Kotlin/JNI
(Android) and ObjC++/Swift (iOS). No platform APIs, no exceptions across the public API (status codes and
result structs), tested on macOS with CTest.

## Build and test

Use Apple clang directly. On this machine `/usr/local/bin/clang{,++}` is a symlink to a broken `ccache`
(missing `libfmt`), so CMake's compiler check fails unless you pass the compilers explicitly.

```sh
export PATH=/opt/homebrew/bin:$PATH
cd native

# normal (Release) build + tests
cmake -S . -B build -DCMAKE_C_COMPILER=/usr/bin/clang -DCMAKE_CXX_COMPILER=/usr/bin/clang++
cmake --build build -j8
ctest --test-dir build --output-on-failure

# AddressSanitizer + UBSan build + tests
cmake -S . -B build-asan -DOTACORE_SANITIZE=ON -DCMAKE_BUILD_TYPE=Debug \
      -DCMAKE_C_COMPILER=/usr/bin/clang -DCMAKE_CXX_COMPILER=/usr/bin/clang++
cmake --build build-asan -j8
ctest --test-dir build-asan --output-on-failure

# patch-side binary size per plugin combination
tools/measure_size.sh /tmp/otacore-size
```

CMake options: `OTACORE_ZSTD` (ON), `OTACORE_LZMA` (ON), `OTACORE_ZSTD_SMALL` (ON), `OTACORE_SANITIZE` (OFF),
`OTACORE_BUILD_TOOLS` (ON; tools and tests need it). The sanitizer build instruments `otacore`, HDiffPatch's
patch side, the zstd/lzma decoders and the tests. The diff-side libraries are never shipped; UBSan is turned off
for upstream `LzmaEnc.c`, which has a misaligned store and a `clz(0)`.

## Layout

```
otacore/include/otacore/otacore.h    C++ API         otacore/include/otacore/otacore_c.h   C API (JNI/ObjC friendly)
otacore/src/                         sha256, bucket, manifest, select, patch, cache, c_api
tests/                               CTest executables (tiny CHECK macros, no framework)
tools/hdiffz_tool.cpp                diff-side CLI (target hdiffz_tool), test/measurement only
tools/measure.cpp                    target measure_patch
tools/gen_synthetic.cpp              synthetic old/new pairs
tools/make_hbc_corpus.mjs            builds v1/v2 Metro-style JS bundles from npm sources for the hermesc experiment
tools/measure_size.sh                binary-size probe
third_party/                         see third_party/VERSIONS.md
```

## API overview (C++, namespace `otacore`)

| Area | API |
|---|---|
| sha256 | `Sha256` (streaming), `sha256Hash(ptr,len)` -> `"sha256:<hex>"`, `sha256File(path,out)`, `isHash(s)` |
| bucket | `double bucket(deviceId, unit)` = sha256(deviceId, 0x0A, unit)[0..4] big-endian / 2^32 |
| manifest | `ParseResult parseManifest(json)`: parse + validate (schema, hash format, ranges in [0,1] and disjoint, duplicate ids, `requiresHost` refs, ttl/version). On `!ok`, `errors` is filled and the caller keeps the old manifest. |
| select | `selectUnit(manifest, unit, ctx)`, `selectHost(manifest, ctx)` -> `Selection{source, entry*, reason}` (DESIGN 5.2 step 2, same reason strings as `select.ts`) |
| patch | `applyPatch(oldFile, patchFile, outFile, expectedHash)`, `applyPatch(RandomAccessSource&, ...)` for asset-backed old data, `applyPatchMemory(...)`. Statuses `Ok, IoError, PatchCorrupt, HashMismatch, UnsupportedAlgo`. Streams old+patch -> `outFile.tmp`, hashes while writing, checks the hash, fsyncs, atomically renames; the temp file is removed on any failure and `outFile` is never partial (and an existing `outFile` is untouched on failure). |
| sources | `RandomAccessSource{size(), read(offset,buf,len)}`, `FileSource`, `MemorySource`; wrappers implement it over `AAsset` / bundle files |
| cache | `Cache(baseDir, versionName, buildNumber)` creates `codepush/<ver>-<build>/`, deletes sibling roots of other app versions, `builtPath/patchPath/has`, `gc(keepIds)`, `allEntryIds(manifest)`; ids that could escape the root (`/`, `..`) are rejected |
| C API | `otacore_sha256[_file]`, `otacore_bucket`, `otacore_validate_manifest`, `otacore_select` (returns result JSON), `otacore_apply_patch`, `otacore_apply_patch_source` (callback-backed old data), `otacore_free` |

Patch format: HDiffPatch "single compressed diff" (`create_single_compressed_diff`, applied with
`patch_single_stream`). The diff is read strictly sequentially (can be applied while downloading), memory is bounded
by the producer's `stepMemSize` (default 256 KiB) plus a 256 KiB I/O cache, and the old data is only randomly read.
Header values come from an untrusted file, so old size is checked against the real old size and `stepMemSize` is capped (64 MiB).

## Compiled-in compression options (patch side)

zstd and lzma decoders plus uncompressed diffs; see `third_party/VERSIONS.md` for the size table
(~12 KB core only, ~57 KB with zstd, ~67 KB with zstd+lzma; stripped, `-Os`, arm64). The manifest parser
(nlohmann/json) adds ~91 KB on its own and is the biggest single item. Static library sizes of the default
Release build: `libhpatch_core.a` 40 KB, `libzstd_dec.a` 82 KB, `liblzma_dec.a` 23 KB (unstripped, pre-link).
Threading is disabled in the patch path (`_IS_USED_MULTITHREAD=0`).

## Test results

Normal and ASan+UBSan builds: 4/4 CTest suites pass, 0 sanitizer reports.

* `hashing`: NIST SHA-256 vectors (incl. 1,000,000 x 'a'), padding boundaries, file helper, all 24 `bucket.json` vectors bit-for-bit.
* `manifest`: ~45 validation cases (positive and negative, wrong JSON types) and all 32 `select.json` cases (reason strings match), plus host selection.
* `patch`: 7 old/new pairs (random binary with 2% edits + insertions/deletions, pure shift, JS-like text, identical, empty new, tiny, unrelated) x 3 compressors x {file, memory, asset-style source, C API}; wrong hash, wrong/short old file, 7 truncations per compressor, 120 random byte flips per compressor (none: 66 PatchCorrupt/54 HashMismatch; zstd: 90/27; lzma: 113/1 and 3 flips in lzma padding that still produced the correct output), garbage patch, missing files, unsupported compress type; each failure asserts no `outFile` and no `.tmp` is left.
* `cache`: version-sibling deletion, `gc`, path-traversal rejection, C API.

## Measurements

`measure_patch <old> <new>` runs `hdiffz_tool` for each compressor, then applies in a fresh child process (3 runs, median) and reports
patch size against the raw and zstd-19/gzip-9 compressed full new file. RSS delta = peak RSS minus RSS before the apply
(page-granular, so read it as "about 1 MB, not tens of MB"). Apple Silicon, Release (-O3), single thread.

| Pair | full new (raw / zstd-19) | diff none | diff zstd-19 | diff lzma-9 | apply ms | RSS delta |
|---|---|---:|---:|---:|---:|---:|
| synthetic 3 MB random binary, 2% scattered edits + 200 ins + 200 del | 3.15 MB / 3.15 MB (incompressible) | 192,474 (6.1%) | 148,498 (4.7%) | 142,386 (4.5%) | 15-20 | 0.5-1.2 MB |
| synthetic JS-like text 4.7 MB, 200/8000 modules edited | 4.67 MB / 434 KB | 3,110 | 2,582 | 2,303 | ~20 | 0.3-0.5 MB |
| **Hermes bytecode** (hermesc -O), 971 KB, 5 modules, same-length-ish literal tweaks | 971 KB / 274 KB | 27,513 | 1,279 | 1,395 | ~4.3 | 0.4-0.5 MB |
| JS source, same tweaks (comparison) | 2.16 MB / 211 KB | 69 | 73 | 73 | ~9 | 0.3 MB |
| **Hermes bytecode**, 5 modules get a new function + new strings | 973 KB / 274 KB | 181,294 | 42,055 (15% of zstd full) | 35,824 | 5-6 | 0.5-1.0 MB |
| JS source, same edits (comparison) | 2.16 MB / 211 KB | 1,888 | 519 | 491 | ~10 | 0.3-0.5 MB |
| **Hermes bytecode**, 70 of 1418 modules (5%) edited | 994 KB / 279 KB | 230,792 | 61,524 (22%) | 53,644 | 5-8 | 0.5-1.1 MB |
| JS source, same edits (comparison) | 2.19 MB / 213 KB | 26,687 | 2,414 | 2,206 | ~10 | 0.3-0.5 MB |
| Hermes bytecode -O0 (1.42 MB), new function + strings | 1.43 MB / 309 KB | 150,239 | 30,606 | 28,042 | 7-8 | 0.7-0.9 MB |

### The hermesc experiment (key open question)

* `hermesc` was obtained from the npm package `hermes-compiler@250829098.0.19` (`npm pack`, extracted, never installed or scripted; macOS universal
  binary at `package/hermesc/osx-bin/hermesc`, HBC bytecode version 98). `react-native` was not needed.
* Corpus: real CommonJS sources of lodash 4.17.21, rxjs 7.8.1 (cjs), date-fns 2.30.0, moment 2.30.1 wrapped Metro-style (`__d(function...)`),
  1418 modules, 2.16 MB of JS -> 971 KB bytecode with `-O`. v2 applies small edits to 5 modules or 5% of modules. Scripts: `tools/make_hbc_corpus.mjs`.
* Result: **bytecode diffs far worse than source diffs** (about 20-80x larger than the same edits in JS text), but still far smaller than
  shipping the unit: with zstd-compressed diffs a 5-module feature edit is ~42 KB, i.e. ~15% of the zstd-compressed full bytecode (274 KB);
  a 5% module churn is ~61 KB (22%). Tiny literal tweaks are ~1.3 KB. Uncompressed HDiffPatch output is much larger (181 KB for the feature case),
  so **compressed diffs are required**; lzma saves another ~10-15% over zstd-19 for 15-20% slower apply.
* Likely cause (hypothesis, not verified by inspecting the bytecode): adding strings or functions shifts the function/string tables and string ids referenced throughout the bytecode, so small
  edits ripple across the file even though function bodies are mostly position independent.
* Caveats: hermesc embeds the input file name in the output (21 differing bytes when only the file name changed) and a trailer hash, so the build must
  compile with a fixed path/name for reproducible bytes. Only one hermesc version was tried. The corpus is third-party library code, not an app, and `examples/demo-app/dist` contained
  no old/new pair and only ~1.3 KB units, so it was not measured. These are macOS numbers; no real devices were involved.

## Not done yet

* Reusable JNI/Kotlin and ObjC++/Swift wrappers (spike-quality glue exists in `examples/spike-app/{android,ios}` and does NOT use `otaruntime::Runtime` yet); the `RandomAccessSource` implementations over `AAssetManager` / bundle files (interface and C callback struct exist, tested with a memory-backed stand-in).
* Ed25519 verification of `manifest.json.sig`: stays in platform code (CryptoKit / `java.security`); `parseManifest` must only be called on bytes that passed verification. Also not implemented: `version` monotonicity / `ttlSec` / conditional GET handling, and the `platform`/`appVersion` match check against the running app (inputs the SDK layer owns).
* The JSI evaluate step, Metro/hermesc unit production, download/prefetch scheduling, the per-unit fetch budget and VM pinning (5.2 steps 3-5).
* Real-device memory/time measurements (Android low-end, iOS), Android NDK / iOS toolchain builds (only macOS clang was used; `fseeko`/`fsync` are POSIX, Windows is not targeted).
* Reducing the manifest parser footprint (nlohmann/json costs ~91 KB; a purpose-built parser would be a fraction), optional lzma2/multithreaded decode, patch-while-downloading, and a CI job running the sanitizer build.

## RN 0.78 hermesc re-measurement (added section)

`native/measure-rn078/` redoes the bytecode-diff experiment with the hermesc shipped in react-native@0.78.3 (HBC bytecode **v96**, not the v98 of `hermes-compiler`), plus demo-app bundle sizes, a hermesc reproducibility recipe (`-g0`/`-output-source-map` + fixed relative name) and execution/version-mismatch checks with the `hermes` CLI from the same tarball. See `measure-rn078/RESULTS.md` and `VERSIONS.md`. The "21 differing bytes" note above is superseded: the name is embedded as a string, so any name change shifts offsets; `-g0` removes it.

## Runtime orchestrator

<!-- runtime-orchestrator:begin -->
`otacore/runtime/` (library `otaruntime`, docs in `otacore/runtime/README.md`) is the platform-neutral loader state
machine of `DESIGN.md` 5.8: manifest accept/refresh, prefetch (download, build, verify), VM prewarm and host
recreate, per-unit pinning, the unit budget, pre-evaluate checks and the crash-loop guard. It is single-threaded
("ota queue"), has no platform headers, and talks to the platform only through injected interfaces
(`Clock, Scheduler, Worker, Http, FileSystem, Store, SignatureVerifier, EmbeddedAssets, PatchBuilder, VmController`).

Scenario tests (`tests/runtime/`, target `test_runtime`, one CTest per `SCENARIO(name)`, ctest names `runtime.*`) run
on a virtual clock with a fake network, fake VM, in-memory store and real temp-dir files (real `applyPatch`, `Cache`,
sha256; patches are made with `hdiffz_tool`). Files live under `native/.work/runtime-tests/`.

```sh
export PATH=/opt/homebrew/bin:$PATH
cd native
cmake -S . -B build-runtime -DCMAKE_C_COMPILER=/usr/bin/clang -DCMAKE_CXX_COMPILER=/usr/bin/clang++
cmake --build build-runtime -j8 --target test_runtime
ctest --test-dir build-runtime -R '^runtime\.' --output-on-failure      # or: build-runtime/test_runtime [scenario]
# sanitizers: same with -DOTACORE_SANITIZE=ON -DCMAKE_BUILD_TYPE=Debug in build-runtime-asan
```
<!-- runtime-orchestrator:end -->
