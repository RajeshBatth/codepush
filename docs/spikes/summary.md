# Spike summary

**Purpose:** One page of what each spike/prototype proved and did not, with numbers and caveats, linking the detailed reports.
**Audience:** Anyone deciding what is safe to rely on; AI assistants (do not claim more than this page).
**Source of truth:** DESIGN 5.6-5.9 ([DESIGN.md](../../DESIGN.md)), [examples/spike-app/SPIKE.md](../../examples/spike-app/SPIKE.md), [JS_FINDINGS.md](../../examples/spike-app/JS_FINDINGS.md), [android/SPIKE_ANDROID.md](../../examples/spike-app/android/SPIKE_ANDROID.md), [ios/SPIKE_IOS.md](../../examples/spike-app/ios/SPIKE_IOS.md), [native/measure-rn078/RESULTS.md](../../native/measure-rn078/RESULTS.md), [native/README.md](../../native/README.md), [native/otacore/runtime/README.md](../../native/otacore/runtime/README.md), [docs/research/rn-0.78-loader.md](../research/rn-0.78-loader.md). Numbers are copied from those files, not re-measured.

Stack throughout: react-native 0.78.3, Metro 0.81.5, Hermes HBC version 96 (`hermesc` sha256 `a82e519e...02ab`, from the RN tarball), Node 24.

## 1. Overview

| Spike | Where | Result | Run on |
|---|---|---|---|
| Metro split prototype (demo-app) | `examples/demo-app`, `packages/unit-splitter` | one graph -> host + unit bundles, 48-bit path-hash ids, rules with negative fixtures, byte-identical across paths/TZ/LANG/cwd | host machine (Node `vm` harness) |
| Splitter on a real RN 0.78.3 app | `examples/spike-app` (JS side), [JS_FINDINGS.md](../../examples/spike-app/JS_FINDINGS.md) | works unchanged on a ~490-module graph; `verify-repro` passes android+ios | host machine |
| Native core | `native/otacore` | 4 CTest suites, ASan/UBSan clean, bit-for-bit vectors with TypeScript | macOS only |
| Runtime orchestrator | `native/otacore/runtime` | 37 scenario tests (20 units, 11 host, 6 manifest) | macOS, virtual clock |
| Bytecode diff / hermesc | `native/measure-rn078` | sizes and reproducibility recipe | macOS |
| Android device spike | `examples/spike-app/android` | S1-S10 PASS (`pass=10 fail=0`) | arm64 emulator API 33, debug |
| iOS device spike | `examples/spike-app/ios` | compiles; **no test run** | none (no simulator runtime) |
| Two-package example | `examples/two-package-app` | pattern proven in the build harness | host machine (see [two-package guide](../guides/two-package-pattern.md)) |

## 2. Android S1-S10 (what each proved)

Execution order: S1 S3 S6 S4 S5 S7 S8 S9 S2 S10.

| ID | Proved |
|---|---|
| S1 | Embedded host boots; surface `HOST:embedded` |
| S2 | Patched host via `ReactHost.reload()` with a dynamic loader: `HOST:patched` (answers "does reload re-ask the loader": yes) |
| S3 | Aligned mmap'd unit evaluated after the host in the same runtime, entry run, surface `CABS:v1` |
| S4 | Wrong version, plain JS text, truncated, misaligned views rejected by pre-checks; the text unit never ran (`pwned=false`). With the version check bypassed Hermes throws `Wrong bytecode version. Expected 96 but got 98`, nothing executes |
| S5 | Throwing entry returns `RequireError`, no crash, another unit loads afterwards (only via `__otaRequire`) |
| S6 | Evaluating v2 into a VM holding v1 returns Ok but stays v1 (define is first-wins): the per-VM pin is inherent |
| S7 | After reload: new context, new holder, new `jsi::Runtime` address; old holder `get()==0`; fresh invoker loads |
| S8 | Timing (below) |
| S9 | `import()` -> `__loadBundleAsync('cabs')` -> `NativeOtaUnits.load` -> evaluate -> surface renders (legacy module through bridgeless interop) |
| S10 | Host swap with no surfaces: new VM from the patched host, loaded-unit state gone, unit loads again |

Timing (warm, 3,328 B cabs unit, emulator): map 0.02 ms, check+sha256 0.08 ms, evaluate 0.02-0.04 ms, entry require 0.06-0.10 ms; about 0.75 ms with thread hops. Cold page cache: map 8.6 ms, evaluate 1.5 ms, require 3.3 ms. Host file 860,712 B.

Caveats (Android): debug build; emulator (swiftshader), not a physical device, not a release build; S2/S7/S10 use `ReactHost.reload()` on a long-lived host, not a cold process start; units are 1.5-3.3 KB so large-unit behaviour is unmeasured.

## 3. iOS
Built for the iPhone Simulator SDK (Xcode 26.6, iphonesimulator26.5, CocoaPods 1.16.2; `BUILD SUCCEEDED` for all Pods and the app target, per SPIKE_IOS.md). All of S1-S10 are implemented and compiled, none ran. Unverified: every test result, `NativeOtaUnits` visibility under interop, `RCTHost reload` picking up a changed URL, Hermes accepting the mmap'd bytecode, the S9 tap path. API facts: [android-ios-integration](../guides/android-ios-integration.md).

## 4. Bundler results on the real RN host (`JS_FINDINGS.md`, `-O -g0`)

| | android | ios |
|---|---|---|
| modules host / cabs / bus / travelplex | 490 / 4 / 4 / 2 | 486 / 4 / 4 / 2 |
| JS host (unminified) | 2,221,900 B | 2,208,494 B |
| hbc host | 860,712 B | 854,756 B |
| zstd-19 host | 348,781 B | 346,568 B |
| hbc cabs / bus / travelplex | 3,328 / 2,172 / 1,524 | 3,328 / 2,168 / 1,524 |

Build: Metro + hermesc 5.2-6.9 s per platform (cache disabled); demo-app 1.2-1.5 s. 48-bit id collisions: 0 on the ~500-module graph; synthetic run over all 14,570 `node_modules` files: 3 collisions at 24 bits, 0 at 32/40/48. `ota-build verify-repro`: byte-identical (13 files per platform), also for a copy in another directory with different TZ/LANG. Symlinked `node_modules` does not work with Metro (copy it).

## 5. Patch sizes (HDiffPatch zstd-19, % of zstd-19 of the new full file)

| Change | Android | iOS |
|---|---:|---:|
| one-line unit change (`fare: 120` -> `125`) | 80 B (3.4%) | 80 B |
| new function in a unit | 825 B (33.4%) | 825 B |
| host app code: string literal, new length | 32,646 B (9.4%) | 29,570 B (8.5%) |
| host app code: string literal, same length | 22,475 B (6.4%) | 35,254 B (10.2%) |
| host app code: numeric literal | 85 B | 85 B |
| RN `node_modules` numeric literal | 85 B | 85-86 B |
| RN message string | 2,657 B (0.8%) | 652 B (0.2%) |

Reading: logic/number edits are tiny; a host string edit costs tens of KB (suspected Hermes string-table renumbering, **not verified**). Plan host patches at about 30 KB worst case. Unit sizes are too small for ratios to mean anything.

Corpus (lodash, rxjs, date-fns, moment, 1418 modules; `native/measure-rn078/RESULTS.md`): 5 literal tweaks 14.1 KB (4.3%) at `-O`; 5 modules with a new function 51.9 KB (15.7%); 5% of modules 91.2 KB (27%) (67.6 KB with `-g0`). Source diffs are 78 B / 502 B / 2.4 KB. lzma-9 is 9-14% smaller than zstd; uncompressed diffs are 4-5x larger, so compressed diffs are mandatory. The older "1.3 KB for 5 literal tweaks" figure was a corpus artifact; do not use it.

Native apply: 4-20 ms for test inputs, peak RSS delta about 1 MB or less. Stripped `-Os` arm64 size: core about 12 KB, +zstd about 57 KB, +zstd+lzma about 67 KB; the nlohmann/json manifest parser adds about 91 KB (a purpose-built parser is a recorded to-do).

## 6. Reproducibility recipe (hermesc)
`hermesc` embeds the input name (absolute paths leak `/Users/...`; any name change shifts offsets); no timestamps. `-g0` removes the name. Recipe: pin the binary by sha256, `cd $WORK && hermesc -O -emit-binary -g0 -out unit.hbc bundle.js` with a fixed relative name, build twice in different directories and compare. Cost: stack traces need the source map. See [02](../architecture/02-build-and-patch-pipeline.md).

## 7. Native core and orchestrator
* `otacore`: all 24 bucket vectors and 32 select cases match the TypeScript reference, reason strings included. `applyPatch` leaves no output or temp file on wrong hash, truncation (7 cuts per compressor), 120 random byte flips per compressor, garbage, or unsupported compressor. A few flips inside lzma padding still produce the correct output (accepted: the hash matches).
* Runtime: scenarios cover crash-loop guard, host swap rules, cached manifests, rejected manifests, rollout changes affecting only unloaded units, IO retry/backoff, cellular cap, tampered built file, determinism (same events, same log). See [05](../architecture/05-client-runtime.md).

## 8. What no spike has shown
Release builds; physical devices; any iOS execution; cold-process boot with a patched host; units larger than a few KB on device; host-patch size on a realistic large unit; source maps and Sentry debug ids; minified builds; dev mode/HMR; graphs of 5-15k modules; `Worker` real-thread behaviour; Ed25519 on device; the asset rule (planned, DESIGN 5.9); the `NativeModules` scan and `baseHash` rule in the splitter (DESIGN 5.6 "Not verified"; check [rules catalog](../reference/rules-catalog.md) for current state).
