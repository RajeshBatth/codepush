# ota-build

## Purpose
The build side of the OTA pipeline (DESIGN.md 7.8 steps 1-3): `bundle` (Metro splitter -> `hermesc` with a reproducible recipe) -> `patch` (HDiffPatch plus a MANDATORY round trip through the C++ the app ships) -> hand-off flags for `ota-cli deploy`. Also `doctor`, a readiness check for adopting the tooling in a real project. Node >= 24, TypeScript run by type stripping (no build step), no runtime npm dependencies.

## Public API (modules / commands)
| module | what |
|---|---|
| `src/bundle.ts` | `bundle(opts)`, `verifyRepro(opts)`, `loadBuild`, `verifyBuildDir`, `compileHbc`; `BuildJson` |
| `src/patch.ts` | `createPatches(opts)`, `roundTrip`; `PatchReport`; algorithm constants (`patchAlgoVer v1`) |
| `src/handoff.ts` | `baseInfo(opts)` (BaseInfo for `ota-cli init`), `deployArgs(opts)` (flags for `ota-cli deploy`) |
| `src/pins.ts` | the ONE hermesc pin table (`HERMESC_PIN_TABLE`: osx / linux64 / win64 for RN 0.78.3, Hermes commit), `pinKeyForHost`, `parsePinKey`; pure logic |
| `src/tools.ts` | `fetchTools({force, platform})`, `resolveHermesc`, `resolveHdiffz`, `resolveOtaApply`, `toolStatus` (each result carries its `origin`: flag / env / default) |
| `src/doctor.ts` | `runDoctor(opts) -> {checks, ok}`, `formatReport` (child probe: `src/doctor-probe.mjs`) |
| `src/hbc.ts`, `src/util.ts`, `src/types.ts` | HBC header validation; process runner (no shell, fixed env, SIGKILL timeout), hashing, location resolution (`toolsDir()`, `workDir()`, `pickPath`); shared types re-exported from ota-core |
| `src/cli.ts` | the `ota-build` command |

## Inputs/outputs and file formats
Input: a project dir with `units.config.json` (see unit-splitter README) and its sources. Tools: `hermesc` (RN tarball, sha256-pinned per OS, in the tools dir), `hdiffz_tool`, `ota_apply` (`native/build-ota-tools`).

### Locations and environment variables
Every tool/work location resolves **explicit flag > environment variable > default** (the default is repo-relative, so nothing existing changes). `doctor` prints where each one came from (`flag --x`, `env OTA_X`, `default`).

| what | flag | env | default |
|---|---|---|---|
| hermesc cache dir (`hermesc-rn0.78.3/`) | `--tools-dir` | `OTA_TOOLS_DIR` | `<repo>/.tools` |
| scratch/work dir (fetch, verify-repro, doctor --deep) | `--work-dir` | `OTA_WORK_DIR` | `<repo>/.work` |
| hermesc binary | `--hermesc` | `OTA_HERMESC` | `<tools dir>/hermesc-rn0.78.3/hermesc` |
| hdiffz_tool | `--hdiffz` | `OTA_HDIFFZ` (legacy alias `OTA_HDIFFZ_TOOL`) | `<repo>/native/build-ota-tools/hdiffz_tool` |
| ota_apply | `--ota-apply` | `OTA_APPLY` | `<repo>/native/build-ota-tools/ota_apply` |

The splitter's Metro is no longer read from a repo path: it is the PROJECT's Metro (see unit-splitter README); `build.json` records the version that ran.
### Output layout
```
<build dir>/   (per platform)
  build.json           schema 1: platform, appVersion, sourceSha, toolchain{rn,metro,hermescSha256,hbcVersion,hermescFlags},
                       host{file,hash,size,zstdSize}, units{<u>:{...,entryModuleId}}, ids{file,hash}, unitsMap{file,hash}
  host.hbc  units/<u>.hbc  ids.json  units.json
  js/                  the splitter's output (host.js, units/*.js, ids.json, units.json), kept for inspection
<patch dir>/
  patch-report.json    {schema, platform, appVersion, base, new, hostChanged, changedUnits, idsChanged,
                        items:[{unit, patchFile, patchSize, updateType, builtHash, baseHash, ratioOfZstdFull, deltaPatchSize, newZstdSize}],
                        toolchain, algo{patchAlgoVer:v1, zstdLevel:19, minMatchScore:4, patchStepMemSize, fullThreshold:0.6}, tools{sha256 of hdiffz_tool, ota_apply}}
  <unit>.<platform>.<base12>-<new12>.(delta|full).hdiff
```
`base`/`new` in the report are the sha256 of the two `build.json` files. `zstdSize` = zstd level 19 of the file (Node's built-in zstd). `build.json` contains no timestamps or paths.


### Patch algorithm and reproducibility
**Reproducibility recipe** (what `bundle` does for host.js and every unit)
1. `hermesc` = RN 0.78.3 `sdks/hermesc/<osx-bin|linux64-bin|win64-bin>/hermesc[.exe]` for the host OS, pinned by sha256 (`src/pins.ts`); bytecode version must be 96.
2. Copy the file to `<work>/hermes-<label>/bundle.js` (fixed relative name), `cd` there, run `hermesc -O -emit-binary -g0 -out out.hbc bundle.js`. `-g0` drops the embedded file name/debug tables (see native/measure-rn078/RESULTS.md section 3).
3. Validate every `.hbc`: Hermes magic `c6 1f bc 03 c1 03 19 1f` and u32 version at offset 8 == toolchain version.
4. `verify-repro` is the gate: two builds in different absolute directories must produce byte-identical files and build.json.
Patch bytes need not be reproducible; built hashes must be.

**Patch algorithm `v1`** (constants in `src/patch.ts`)
`hdiffz_tool -c zstd -l 19 -m 4 old new out` = HDiffPatch `create_single_compressed_diff`, zstd level 19, min match score 4, step mem 256 KiB (HDiffPatch default). Changing any value needs a new `patchAlgoVer`.
For each file whose hash differs: diff -> round trip with `ota_apply` (= `otacore::applyPatch`, the app's code) into a scratch file, require exit 0 and `sha256(result) == new hash` (re-hashed independently) -> if `patchSize > 0.6 x zstdSize(new)` (or `--force-full`) redo the diff against an EMPTY old file (`updateType: full`) and round-trip it with old `-`. Any failure aborts the whole command; nothing is emitted. Pre-checks: both builds re-hashed against their build.json, same platform/appVersion/toolchain (rn, metro, hermesc sha, bytecode version, flags), same unit set, no module-id conflicts.


## Commands with examples
`node packages/ota-build/src/cli.ts <command>` (exit 0 ok, 1 failure (stderr), 2 usage). All child processes run without a shell, with a fixed minimal environment (`LANG=C TZ=UTC`) and a hard timeout (SIGKILL). Staging dirs (`<out>.stage-*`) are renamed into place only on success and removed on failure; `bundle` refuses to delete a non-empty `--out` that is not a previous build.

| command | what |
|---|---|
| `fetch-tools [--force] [--platform osx\|linux64\|win64]` | obtain/verify hermesc (default: the pin of this host), report hdiffz_tool and ota_apply paths + sha256. `--platform` fetches another OS's pin into `hermesc-rn0.78.3-<key>/` (hash-verified, never executed) |
| `doctor --project DIR [--platform android\|ios] [--json] [--deep]` | readiness check, see below |
| `bundle --project DIR --platform android\|ios --out DIR [--source-sha X] [--app-version V] [--base-build DIR]` | splitter -> hermesc -> `build.json`. `--base-build` turns on the splitter's patch-mode rules 3/4 against that earlier build |
| `verify-repro --project DIR --platform P [--work DIR]` | bundle twice into different absolute paths; require byte-identical files and build.json |
| `patch --base DIR --new DIR --out DIR [--overwrite] [--force-full]` | diffs + round trip + `patch-report.json` |
| `base-info --android DIR --ios DIR [--release-tag T] [--toolchain-image I] [--app-version V] [--out FILE]` | BaseInfo JSON for `ota-cli init` |
| `deploy-args --report F --report F --unit U --version V --pr N [--json] [--out FILE]` | the exact `ota-cli deploy` flags |

```sh
N=$(ls -d ~/.nvm/versions/node/v24*/bin); export PATH=$N:/opt/homebrew/bin:$PATH     # nvm shells: npm/node are lazy functions
node packages/ota-build/src/cli.ts bundle --project examples/demo-app --platform android --out .work/base-android
node packages/ota-build/src/cli.ts patch --base .work/base-android --new .work/new-android --out .work/patch-android
```

### Setup (once per machine)
```sh
N=$(ls -d ~/.nvm/versions/node/v24*/bin); export PATH=$N:/opt/homebrew/bin:$PATH     # nvm shells: npm/node are lazy functions
# 1. native tools (slow the first time: compiles the diff tools). ota_apply links the same `otacore` as the app.
cmake -S native -B native/build-ota-tools -DCMAKE_C_COMPILER=/usr/bin/clang -DCMAKE_CXX_COMPILER=/usr/bin/clang++
cmake --build native/build-ota-tools --target ota_apply hdiffz_tool -j8
# 2. hermesc for RN 0.78.3 -> <repo>/.tools (gitignored)
node packages/ota-build/src/cli.ts fetch-tools
```
`fetch-tools` does `npm pack react-native@0.78.3` into a fresh work dir, extracts ONLY the hermesc binary (and, for win64, its pinned DLLs) plus `sdks/.hermesversion` (the tarball is untrusted), checks the sha256 of EVERY extracted file against the pin BEFORE executing anything, then (only for the host's own pin) runs `hermesc -version` and requires HBC bytecode version 96. A hermesc whose sha256 is not the host's pin is refused unless `--allow-unpinned-hermesc` (experiments only; the real sha is recorded in build.json). Pin selection is by `process.platform` + `process.arch`; linux arm64 has no pin (clear error).

**Hermesc pins (RN 0.78.3, Hermes `hermes-2025-01-13-RNv0.78.0-a942ef374897d85da38e9c8904574f8376555388`, bytecode v96)** - single table in `src/pins.ts`:

| key | host | file | sha256 |
|---|---|---|---|
| `osx` | darwin arm64/x64 | `osx-bin/hermesc` | `a82e519e1fa3737f6b95554cdb9edaaf37458fb03abcdc2144f039fa0b3302ab` |
| `linux64` | linux x64 | `linux64-bin/hermesc` | `028225889c34216961579c54223e7686b32ad6b9fbc5820fbdf508650ffd9a42` |
| `win64` | win32 x64 | `win64-bin/hermesc.exe` (+ 9 DLLs, pinned in the table) | `4d7185efa1f594a85d36420bcd033fb0bf03e504e3ffd7d98d4d86e97b1b4a0e` |

The linux64/win64 hashes were taken by hashing the files extracted from the `npm pack` tarball on macOS; those binaries have NOT been executed anywhere yet (first `fetch-tools` on a Linux agent runs `-version` and the bytecode check). The rest of the pipeline on Windows is untested.

### `doctor`: adoption readiness check
`node src/cli.ts doctor --project <dir> [--platform android|ios] [--json] [--deep]`. One line per check: `PASS`, `WARN` (works, look at it), `FAIL` (pipeline will refuse or produce wrong output), `MANUAL` (cannot be automated); non-PASS lines print a one-line `fix:`. Exit 1 if any FAIL. `--platform` limits the Hermes-flag checks and selects the `--deep` platform (default android). `--json` prints `{project, platform, checks:[{id,title,status,detail,remedy}], ok}`.

| id | checks | FAIL / WARN / MANUAL when | remedy |
|---|---|---|---|
| `node` | Node >= 22.12 (require(esm) of the ESM splitter from a CJS metro.config.js) | FAIL < 22.12; WARN < 24 | install Node 24 |
| `project` | project dir and `package.json` exist | FAIL | point `--project` at the app root |
| `react-native` | RN resolved from the project; expects 0.78.x (pin 0.78.3) | WARN if missing (demo fixtures), other line, or other patch | add the other RN's hermesc to `HERMESC_PINS`, re-verify the splitter |
| `metro` | metro resolved FROM THE PROJECT (also via react-native / @react-native/metro-config); line must be one the splitter supports (0.81.x, 0.87.x) | FAIL unsupported line; WARN not resolvable, or a line/patch other than the one the splitter's test suite is verified against (0.81.5) | align Metro or run the matrix (`scripts/metro-matrix.sh`) / extend `metro-compat.js` first |
| `metro-runs` | the Metro that WILL run (`describeMetro`): the project's, else the splitter's fallback copy, and whether the splitter's version gate accepts it (metro = metro-config = metro-runtime) | FAIL gate would refuse; WARN fallback copy in use (project has no metro) | install the project's dependencies; pin the three to one version |
| `metro-config` | metro-config == metro | WARN | pin both |
| `units-config` | `units.config.json` exists, shape `{units:[{name,roots[],entry}]}` | FAIL | fix the file |
| `units-resolve` | the splitter's own loader: roots are directories or installed packages, entries exist and lie under roots, names unique, roots disjoint | FAIL with the loader's message | fix the named root/entry; `npm install` for package roots |
| `host-entry` | host entry (`entry` in units.config.json, default `src/host/index.js`) exists | FAIL | set `entry` |
| `metro-config-wired` | loads the metro config (`metroConfig` from units.config.json, else the auto-detected `metro.config.js`) in a child process with `OTA_UNITS_BUILD=1` and requires `serializer.customSerializer` and `createModuleIdFactory` | FAIL load error / timeout / not wired; WARN no config at all (demo mode) | wrap with `withOtaUnits` |
| `metro-config-used` | `metro.config.js` is auto-detected by the splitter (PASS), or WARN if `"metroConfig": false` makes it ignore an existing one | WARN | drop `"metroConfig": false` |
| `metro-crawl` | `resolver.blockList` covers `ios/Pods`, `ios/build`, `android/app/build`, `android/build`, `android/.gradle` where those dirs exist; reports dangling symlinks under `ios/Pods` | WARN if not blocked; MANUAL if the config did not load | add the standard blockList (see examples/spike-app/metro.config.js) |
| `node-modules` | `node_modules` is a real directory | FAIL symlink (Metro's crawler/watcher does not follow it); WARN absent | real install / workspaces |
| `hermes-engine` | android `gradle.properties` `hermesEnabled`, iOS `Podfile` `hermes_enabled` / `USE_HERMES` (unset = RN default true) | FAIL disabled; MANUAL if neither file exists | enable Hermes |
| `hermesc` | pinned hermesc present and equal to the pin of THIS host (osx / linux64 / win64), its source (flag/env/default), and its sha256 compared with `node_modules/react-native/sdks/hermesc/<os-bin>/` of the PROJECT (both reported) | FAIL no pin for this OS/arch, pinned binary missing/wrong, or the project's hermesc differs; WARN project has none to compare | `fetch-tools`; add a pin for your OS/RN in `src/pins.ts` |
| `hdiffz`, `ota-apply` | native tools found; detail says flag/env/default | FAIL | build `native/build-ota-tools` or set `OTA_HDIFFZ` / `OTA_APPLY` |
| `tools-dir` | the tools dir exists (or `OTA_HERMESC` set); path and origin reported | FAIL | `fetch-tools` |
| `work-dir` | the work dir and its origin | always PASS | set `OTA_WORK_DIR` |
| `native-modules` | Tier-1 rule 5 (NativeModules scan) | always MANUAL | review native changes in PRs |
| `toolchain-image` | CI image pinned (`base-info` records `local-unpinned` otherwise) | always MANUAL | pass `--toolchain-image img@sha256:...` |
| `deep-repro` (`--deep`) | `verify-repro` on the project: two bundles in different directories, reports time and byte-identity | FAIL not reproducible / build error; WARN skipped because earlier checks FAILed | find the nondeterminism |

Verified on `examples/demo-app` (READY, 4 WARN for the missing RN/Metro/metro.config) and `examples/spike-app` (READY, 0 WARN).

## How to run the tests
```sh
N=$(ls -d ~/.nvm/versions/node/v24*/bin); export PATH=$N:/opt/homebrew/bin:$PATH
cd packages/ota-build && npm install && npm test        # 39 tests, about 25 s, sequential (--test-concurrency=1)
node ../ota-core/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```
Needs the built native tools (`native/build-ota-tools/{hdiffz_tool,ota_apply}`) and `.tools/hermesc-rn0.78.3` from `fetch-tools` (Setup above). Without them the pipeline and the "realistic RN layout" doctor tests print a SKIPPING reason instead of failing (the project-only doctor tests still run).
- `test/pipeline.test.ts` (17): builds the demo app for both platforms, edits a COPY, patches, runs the real `ota-cli` (keygen/init/deploy/rollout 10/verify), simulates a device with `ota-core` (`bucket` + `selectUnit` on the served manifest) and applies the served patch with `ota_apply`, requiring `sha256 == manifest hash`. Also host change, two units changed, identical builds, tampered/truncated patch, garbage diff tool never emitted, `full` fallback, toolchain/platform/appVersion mismatch, modified build dir, reproducibility.
- `test/pins.test.ts` (5): pure logic of the pin table, host selection by platform/arch, `--platform` parsing, flag > env > default resolution.
- `test/doctor.test.ts` (17): copies the demo app (and a synthetic RN 0.78.3 layout with the real pinned hermesc and a wired metro.config.js) into `<repo>/.work/` and breaks it: missing / malformed units config, bad root, missing entry, overlapping roots, missing host entry, Metro 0.80 / 0.81.2, RN 0.79, different or absent project hermesc, unwired / throwing metro.config.js, Hermes disabled, dangling Pods symlink, symlinked node_modules, missing hermesc on the machine.
Work files go to `<repo>/.work/` and are removed afterwards.

## Depends on / depended on by
- Depends on: `packages/unit-splitter` (`build()`, `loadUnitsConfig`, `describeMetro`; imported by RELATIVE path `../../unit-splitter/src/*.js`; the Metro that runs is the project's, see its README), `packages/ota-core` (types, by relative path), the native tools in `native/`, `hermesc` from the react-native tarball (`npm pack`).
- Depended on by: Jenkins build/verify/deploy jobs (not started); its tests drive `packages/ota-cli`.

## WHERE TO EXTEND
- **Another OS / RN version**: edit the pin table in `src/pins.ts` (`HERMESC_PIN_TABLE`, `RN_VERSION`, `HERMES_COMMIT`, `EXPECTED_HBC_VERSION`); `doctor` shows the project's own hermesc sha256 to copy.
- **Different tool/work locations** (Jenkins images): `OTA_TOOLS_DIR`, `OTA_WORK_DIR`, `OTA_HERMESC`, `OTA_HDIFFZ`, `OTA_APPLY`, or `--tools-dir/--work-dir/--hermesc/--hdiffz/--ota-apply`.
- **New patch algorithm**: change constants in `src/patch.ts` AND bump `patchAlgoVer` (it is recorded in the manifest).
- **New doctor check**: push another `add(id, title, status, detail, remedy)` in `runDoctor` (`src/doctor.ts`); add a broken-project test.
- **Policy gates** (size limits, rule 5/6): after `patch` and before `deploy-args` in the Jenkins job; the report already carries the numbers.
- **Other CI/artifact layouts**: the commands only read/write plain directories (`build.json`, `patch-report.json`); fetch the base build dir from your artifact store before `--base-build` / `patch --base`.

### Where it plugs into Jenkins (conceptual)
- **Base release job (per platform):** `bundle` (no `--base-build`) -> the shipped binary embeds `host.hbc` and `units/*.hbc` -> after both platforms: `base-info ... --out base.json` -> `ota-cli init --base base.json`. `verify-repro` runs in the same job as a gate.
- **Verify job (PR):** check out the PR, `bundle --base-build <base build restored from the artifact store>` per platform, `patch` against the base build, then policy: `changedUnits == [unit]`, `hostChanged == false` (`deploy-args` enforces this and fails otherwise), size limits from `ratioOfZstdFull`/`patchSize`. Store `build.json` hashes and `patch-report.json`.
- **Deploy job (approved ticket):** rebuild (`bundle` + `patch`), compare built hashes with those recorded at verify, then `deploy-args --json ...` and run `ota-cli deploy` with those flags plus requester/approver/ticket, then `ota-cli rollout`.


## Known limitations / not done
- The unit-splitter's `platform` handling: android and ios builds of the demo app are byte-identical today; platform is mostly a label in build.json.
- Real-device loading of the `.hbc` files and large-app scale are not covered (demo app: 17 modules, units about 1 KB). Patch ratios on tiny units are dominated by fixed overhead.
- linux64/win64 hermesc pins are hash-only (never executed by the engineer who recorded them); nothing here has run on Linux CI yet. `tar` is `/usr/bin/tar` if present else `tar` on PATH. The tarball's own integrity is whatever `npm pack` verifies; the binary hash pin is the trust anchor.
- The native tools default to `<repo>/native/build-ota-tools` (override per tool; there is no single env var for the build dir). `ota-build` still imports the splitter and ota-core by relative path, so it must live in this repo layout (or be vendored whole).
- Metro config hash and the toolchain image digest are not recorded in build.json (only RN, Metro version, hermesc sha, bytecode version, flags); `base-info` defaults `toolchainImage` to `local-unpinned`.
- Tier 1 rules 5 (NativeModules scan) and 6 (baseHash vs base release) are not implemented here.
- `ota-cli deploy` takes ONE `--update-type`; if platforms differ `deploy-args` refuses (`MIXED_UPDATE_TYPES`) and suggests `patch --force-full` for both. It also needs a patch for BOTH platforms.
- Size-limit enforcement (soft/hard) is not implemented: the report carries the numbers only.
- `doctor`: the Metro config is loaded in a child with a fixed minimal environment (`PATH` = node's dir), so configs that need other env vars may report a load error; `metro-crawl` only evaluates `resolver.blockList` regexes (not watchman or `watchFolders`); the project's hermesc is hashed, never executed; Hermes flags are found by regex, not by evaluating the Podfile/Gradle.
