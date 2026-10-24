# Hermes bytecode diff + reproducibility with the RN 0.78.3 hermesc (bytecode v96)

Host-machine measurements (macOS arm64). Versions/hashes/evidence: `VERSIONS.md`. Nothing from npm tarballs was executed except the `hermesc` / `hermes` binaries.

## Reproduce
```sh
export PATH=/opt/homebrew/bin:$PATH; cd native/measure-rn078
./fetch_tools.sh /tmp/rn078tools                      # npm pack react-native@0.78.3 + corpus libs
H=/tmp/rn078tools/rn/x/package/sdks/hermesc/osx-bin/hermesc
./run_diff.sh $H /tmp/rn078tools/src /tmp/rn078work                 # corpus diff, flags: -O -emit-binary (default debug info)
HFLAGS=-g0 ./run_diff.sh $H /tmp/rn078tools/src /tmp/rn078work_g0   # same with -g0 (== what -output-source-map gives)
./demo_hbc.sh $H demo-dist /tmp/rn078demo                           # demo-app bundles (demo-dist/ = snapshot of examples/demo-app/dist)
./determinism.sh $H demo-dist/units/bus.js /tmp/rn078det            # reproducibility probes
```
`run_diff.sh` needs `native/build/hdiffz_tool`, `zstd`, node. Each bundle is compiled as `cd <dir> && hermesc -O -emit-binary -out ../vN.hbc bundle.js` (fixed relative name). Corpus: `native/tools/make_hbc_corpus.mjs` (1418 modules, lodash/rxjs cjs/date-fns/moment).

## 1. Corpus diff (zstd-19 HDiffPatch; % = diff / zstd-19 of full new .hbc)

Note: my corpus rebuild is not byte-identical to the one behind the old table (rxjs dir choice; JS text is 2.33 MB here vs 2.16 MB), so the right comparison is v96 vs v98 on the SAME corpus (columns 2-3), not vs the old table.

| Edit | JS diff (zstd) | RN 0.78.3 hermesc v96, `-O` | same, `-O -g0` | hermes-compiler v98, `-O` | OLD README (v98, old corpus) |
|---|---:|---:|---:|---:|---:|
| 5 literal tweaks | 78 B | 14.1 KB (4.3%) | 13.8 KB (6.1%) | 15.3 KB (4.6%) | 1.3 KB (0.5%) |
| 5 modules: new function + strings | 502 B | 51.9 KB (15.7%) | 48.9 KB (21.6%) | 47.1 KB (14.2%) | 42 KB (15%) |
| 5% of modules edited (70) | 2.4 KB | 91.2 KB (27.0%) | 67.6 KB (29.3%) | 67.9 KB (20.2%) | 61 KB (22%) |

Other formats (v96 `-O`): lzma-9 diff = 12.8 KB / 46.4 KB / 78.6 KB (about 9-14% below zstd); uncompressed diff = 64 KB / 218 KB / 278 KB (4-5x larger than zstd -> compressed diff still mandatory).
Full-file sizes (v96, `-O`): JS 2.33 MB -> hbc 1.16 MB -> zstd-19 331 KB (v98: hbc 1.10 MB, zstd 331 KB). With `-g0`: hbc 693 KB, zstd 226 KB.

Findings:
* v96 behaves like v98: diffs are the same order of magnitude; feature-style edits ~14-22% of the zstd'd bytecode, 5% churn ~20-29%. The v96 "5%" case with default debug info is worse (91 KB vs 68 KB v98); with `-g0` it matches v98. So debug info (file/line tables) hurts diffing; `-g0` is better on size and on diff for large churn.
* The "5 literal tweaks" case is 14 KB here vs 1.3 KB in the old table, and v98 on this corpus also gives 15 KB, so that is a corpus difference (which modules/literals were hit), not a compiler difference. The old 1.3 KB figure is a best case; do not rely on it. The sweep over real app edits is still open.
* Percent-of-full is higher with `-g0` only because the denominator shrank; absolute diff is equal or smaller.

## 2. Demo-app bundles (snapshot of examples/demo-app/dist, Metro output)

Flags = RN's own: `hermesc -emit-binary -max-diagnostic-width=80 -O [-output-source-map]` (verified in `react-native-xcode.sh` lines 170-179: `-O` for release, `-Og` for dev, `-output-source-map` if EMIT_SOURCEMAP; Android Gradle plugin `BundleHermesCTask`: `-emit-binary -max-diagnostic-width=80 -out X in` plus `hermesFlags` default `["-O","-output-source-map"]`).

| File | JS bytes | hbc `-O` | zstd-19(js) | zstd-19(hbc `-O`) | hbc `-O -g0` | zstd-19(hbc -g0) |
|---|---:|---:|---:|---:|---:|---:|
| host.js | 41,087 | 23,460 | 9,678 | 11,929 | 16,028 | 9,196 |
| units/bus.js | 1,253 | 1,438 | 580 | 940 | 1,048 | 756 |
| units/cabs.js | 1,264 | 1,488 | 576 | 960 | 1,080 | 768 |
| units/travelplex.js | 950 | 1,244 | 440 | 835 | 920 | 670 |

Tiny units are larger as bytecode than as JS (fixed header of 128 B plus tables, plus debug info), and zstd'd hbc is larger than zstd'd JS for small files. Real unit sizes will be dominated by app code; the table only shows the overhead floor (~0.5-0.7 KB zstd'd per unit).

Compile checks:
* A unit consisting solely of `__d(...)` statements compiles with no diagnostics (hermesc treats `__d` as a free global; `-Wundefined-variable` is off by default, so no warning either).
* hermesc accepts a bundle without Metro's runtime/polyfills (it is just a script). Running such an hbc alone fails at run time as expected: `ReferenceError: Property '__d' doesn't exist` (exit 1).
* Host + unit concatenated and compiled together runs fine (`typeof __r`/`__d` are functions; module defined). That is the Metro single-bundle shape, not the OTA shape.

## 3. Determinism: what hermesc leaks and the recipe

Probes (`determinism.sh`, same JS, v96 hermesc):

| Probe | Result |
|---|---|
| same dir + name, run twice 2 s apart | byte-identical (no timestamps) |
| same relative name `bundle.js`, compiled from different directories (cwd differs) | byte-identical |
| same dir, different file name (`bundle.js` vs `renamed.js`) | differs (269 bytes differ and later offsets shift; the name is stored in the string table / debug info) |
| absolute path vs relative path | differs; the absolute path string (e.g. `/Users/...`) is embedded in the .hbc |
| stdin (`-`) from any cwd | byte-identical to itself, differs from the named-file build (name `-`) |
| the old claim "21 bytes differ" | only true for same-length names; in general the name changes string table size and shifts offsets |
| `-g0` (also implied by `-output-source-map`) | file name NOT embedded; `bundle.js` vs `renamed.js` vs absolute `/x/other_name.js` all byte-identical; hbc 40% smaller |
| `-g1` (default) / `-g3` | name embedded (g3 also much larger) |
| `-output-source-map` | hbc output identical to `-g0` output (debug info dropped); the `.map` file records the path exactly as passed in `sources` (absolute path leaks into the map, relative stays relative) |
| header | bytes 12.. contain a 20-byte hash of the source (sourceHash) + file/function counts; deterministic functions of the input. No timestamp, no hostname, no tool path was found by `strings` other than the input name. |

### Recipe (reproducible bytes)
1. Pin the exact hermesc binary: take it from the app's `react-native` version, record sha256 (VERSIONS.md style) in CI; assert `hermesc -version` bytecode version equals the version the runtime expects.
2. Produce the Metro output byte-deterministically first (hermesc input must be identical; the demo host/unit files contain no timestamps, but `__BUNDLE_START_TIME__` is runtime-only so OK).
3. Invoke as: `cd "$WORK" && cp unit.js bundle.js && hermesc -O -emit-binary -max-diagnostic-width=80 -g0 -out unit.hbc bundle.js` (or with `-output-source-map`, which implies no debug info, if you want the map). Rules: relative input path, fixed file name (`bundle.js` or the unit id), `-g0` (or `-output-source-map`). With `-g0` even name/path do not matter, but keep the fixed name as defense in depth. Do not pass absolute paths; do not use `-g`/`-g3` for shipped OTA units.
4. Do not compile through different hermesc versions across build and rebuild; hash of the .hbc is only stable for the same binary.
5. Verify: build the unit twice in two different temp dirs and require equal sha256 (CI check).
Trade-off: `-g0` drops the in-bytecode line/column tables, so JS stack traces in production come from the source map (which is what RN release builds with `-output-source-map` already do). Keep the map per unit hash.

## 4. Executing HBC: yes, with the `hermes` CLI shipped in the RN tarball
`package/sdks/hermesc/osx-bin/hermes` (universal binary, v96) runs bytecode: `hermes -b file.hbc` ("treat input as executable bytecode").
* (b) Version mismatch is rejected before any code runs: a v98 file (real hermes-compiler output, and a v96 file with version byte patched to 98) -> `Error deserializing bytecode: Wrong bytecode version. Expected 96 but got 98`, exit code 5, no output from the script. Truncated file -> `Buffer smaller than a bytecode file header. Expected at least 128 bytes but got 50 bytes` (exit 5); a JS source passed with `-b` gets the same header-size error.
* (a) NOT verifiable with the CLI: `hermes` loads exactly one bytecode file ("Hermes can only load one bytecode file."), and multiple files require `-commonjs` source mode. There is no global to load a second HBC (`HermesInternal` has no eval-bytecode; `loadSegment` needs segment bytecode). What was verified instead: (i) host.hbc runs; (ii) host+unit (`__d` only) in one compile runs and defines the module; (iii) host and a `__d` unit as two JS sources concatenated into one script run in order (both.js). The real mechanism (JSI `evaluateJavaScript(buffer)` on a second HBC buffer; expected, from Hermes source knowledge, to check HBC magic and version, NOT verified here) still needs a device or a small libhermes/JSI harness, which is not in the tarball.

## Caveats
Single machine, no device; corpus is library code; `hermes` CLI is the desktop VM; only RN 0.78.3 tested (a 0.78.x bump could change the Hermes commit); sizes of `-O` vs `-Og` for dev not measured here.
