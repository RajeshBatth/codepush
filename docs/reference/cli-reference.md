# CLI reference

**Purpose:** Every command-line entry point in the repo: synopsis, flags, defaults, exit codes, copy-pasteable examples.
**Audience:** Engineers running the pipeline by hand or writing the CI jobs that will call it.
**Source of truth:** `packages/ota-cli/src/cli.ts`, `packages/ota-build/src/cli.ts`, `packages/unit-splitter/src/cli.js`, `packages/unit-splitter/scripts/metro-matrix.sh`, `packages/unit-splitter/src/determinism.js`, `tools/ota-propose.mjs`, `tools/repro_check.py`, `scripts/*`, root `package.json`, `native/tools/*`, `native/measure-rn078/*`. Flags below were read from the argument parsers (`node:util parseArgs` / `argparse` / shell `case`), not from READMEs.

All examples run from the repo root. There is no build step: Node >= 24 runs the `.ts` sources directly (type stripping). Set up PATH first (see [troubleshooting](../guides/troubleshooting.md)):

```sh
. scripts/env.sh        # newest nvm node v24 + /opt/homebrew/bin + CC/CXX=/usr/bin/clang(++)
```

Contents: [1 ota-cli](#1-ota-cli-the-deploy-job-emulator) - [2 ota-build](#2-ota-build) - [3 unit-splitter](#3-unit-splitter-cli) - [4 tools/](#4-tools) - [5 scripts/ and npm](#5-scripts-and-root-npm-scripts) - [6 native tools](#6-native-tools) - [7 package npm scripts](#7-package-npm-scripts)

## 1. ota-cli (the deploy-job emulator)

Entry: `node packages/ota-cli/src/cli.ts <command> [flags]` (package bin name `ota`). It emulates the single Jenkins deploy job against local adapters (filesystem store and CDN, in-process Ed25519, JSON team file). In production the flags come from the approved Jira ticket and PR; the Jenkins job is *planned*. Semantics of each command: [04 release workflow](../architecture/04-release-workflow.md), formats: [file formats](file-formats.md), ports: [ports and adapters](ports-and-adapters.md).

**Common flags (required by every command except `keygen`):** the CLI builds its context before dispatch, so even read-only commands (`show`, `verify`, `reconcile`) need all of them.

| Flag | Meaning |
|------|---------|
| `--store DIR` | local artifact store root (`ota-state/...`, `ota-base/...`, `ota-patches/...`) |
| `--cdn DIR` | local CDN origin directory |
| `--units FILE` | governance `units.json` (owner team, Jira keys, limits); see [config reference](config-reference.md) |
| `--teams FILE` | `{ "team": ["user", ...] }`; optional (missing = empty directory, nobody is a member) |
| `--key FILE`, `--pub FILE` | Ed25519 PEM private and public key (from `keygen`) |
| `--cdn-base-url URL` | prefix written into manifest `patchUrl`s; default `https://cdn.example.com/ota` |

| Command | Flags | Notes |
|---------|-------|-------|
| `keygen` | `--out DIR` | writes `private.pem` (mode 0600) and `public.pem`; the public key is what apps embed. Needs no common flags. |
| `init` | `--base base.json --requester U` | creates state `v1` for the app version in `base.json` (the base-release job's role). Fails if already initialized. |
| `deploy` | `--version V --unit U --pr N` + per platform `--patch-android F --built-android H` and/or `--patch-ios F --built-ios H`; `--update-type patch\|full` (both) or `--update-type-android X --update-type-ios Y` (default `patch`); `--requester U --approver U --ticket KEY`; optional `--sha SHA --job-url URL --break-glass` | pass only the platforms the change affects. Patch id becomes `<unit>-pr<N>`; entry starts at 0%. At least one platform required. |
| `rollout` | `--version V --unit U --pr N --percent P [--platform android\|ios] --requester U --approver U --ticket KEY` | `--percent 0` is routed to `halt`. Omit `--platform` = all platforms where the patch exists. |
| `halt` | `--version V --unit U --pr N [--platform ...] --requester U [--ticket KEY]` | no approver needed (DESIGN 7.2 step 7). |
| `restore` | `--version V --from N [--unit U] --requester U --approver U --ticket KEY [--break-glass]` | publishes the content of state `vN` as a **new** version (monotonic `version`). |
| `show` | `--version V [--state N]` | prints the audit line and every entry's range per platform; default = latest state. |
| `verify` | `--version V` | checks state history, signatures, audit chain and CDN; prints `PROBLEM ...` lines and exits 1 on any problem. |
| `reconcile` | `--version V` | redeploys the latest state to the CDN if it is behind. |

Unknown or missing command prints usage and exits 2 (0 if no command). Any thrown error prints `error: <message>` and exits 1.

```sh
OTA=/path/to/scratch            # e.g. .work/ota-demo
node packages/ota-cli/src/cli.ts keygen --out $OTA/keys
C="--store $OTA/store --cdn $OTA/cdn --units $OTA/units.json --teams $OTA/teams.json --key $OTA/keys/private.pem --pub $OTA/keys/public.pem"
node packages/ota-cli/src/cli.ts init    $C --base $OTA/base.json --requester alice
node packages/ota-cli/src/cli.ts deploy  $C --version 11.9.0 --unit cabs --pr 42 \
     --patch-android a.hdiff --built-android sha256:... --patch-ios i.hdiff --built-ios sha256:... \
     --requester alice --approver bob --ticket CAB-1
node packages/ota-cli/src/cli.ts rollout $C --version 11.9.0 --unit cabs --pr 42 --percent 10 --requester alice --approver bob --ticket CAB-1
node packages/ota-cli/src/cli.ts halt    $C --version 11.9.0 --unit cabs --pr 42 --requester carol
node packages/ota-cli/src/cli.ts show    $C --version 11.9.0
node packages/ota-cli/src/cli.ts verify  $C --version 11.9.0
```
A complete, tested sequence (with parallel processes racing on one version) is in `packages/ota-cli/test/job.test.ts` ("CLI end to end"). `ota-build deploy-args` prints the exact `deploy` patch flags.

## 2. ota-build

Entry: `node packages/ota-build/src/cli.ts <command> [flags]` (bin `ota-build`). Exit codes: 0 ok, 1 failure (message on stderr), 2 usage. Pipeline context: [02 build and patch pipeline](../architecture/02-build-and-patch-pipeline.md).

**Global flags:** `--tools-dir DIR` (hermesc cache; env `OTA_TOOLS_DIR`; default `<repo>/.tools`), `--work-dir DIR` (scratch; env `OTA_WORK_DIR`; default `<repo>/.work`). Precedence everywhere: flag > env > default. All env vars: [config reference](config-reference.md).

| Command | Flags | What it does |
|---------|-------|--------------|
| `fetch-tools` | `[--force] [--platform osx\|linux64\|win64]` | `npm pack react-native@0.78.3`, extract hermesc, verify the pinned sha256 before running, check HBC version 96, cache in `<tools dir>/hermesc-rn0.78.3/`. Then lists `hdiffz_tool`/`ota_apply` paths or `MISSING`. Needs network. A non-host `--platform` is hash-checked only. |
| `bundle` | `--project DIR --platform android\|ios --out DIR [--source-sha X] [--app-version V] [--base-build DIR] [--delta auto\|on\|off] [--hermesc PATH] [--allow-unpinned-hermesc]` | splitter + hermesc -> `build.json`, `host.hbc`, `units/*.hbc`, `ids.json`, `units.json`, `js/`. `--base-build` = patch mode rules AND hermesc delta mode (`-base-bytecode=<base>.hbc`, patches ~30x smaller for string edits). `--delta auto` (default) = delta whenever a base build is given; `on` = fail loudly instead of falling back; `off` = plain. The base dir must hold the `.hbc` bytes (see `archive-base`) and must itself be a non-delta (embedded base) build. `--out` must be empty/new or a previous build. |
| `verify-repro` | `--project DIR --platform P [--work DIR] [--base-build DIR] [--delta M] [--hermesc PATH] [--allow-unpinned-hermesc] [--source-sha X] [--app-version V]` | two bundles into different dirs; exit 1 with the differing files if not byte-identical. Work dir defaults to `<work>/verify-repro-<pid>`; kept on failure. |
| `patch` | `--base DIR --new DIR --out DIR [--overwrite] [--force-full] [--report-plain] [--hdiffz PATH] [--ota-apply PATH] [--hermesc PATH]` | per changed file: diff, mandatory round trip, `full` fallback; writes `patch-report.json` + `*.hdiff`. `--report-plain` also compiles each changed file without `-base-bytecode` and records `plainEquivalentSize` / `deltaOverPlain` per item. |
| `archive-base` | `--build DIR --out DIR` or `--verify DIR [--base-json FILE]` | copies what a later delta build needs from the BASE release build (host.hbc, units/*.hbc, build.json, ids.json, units.json) + `archive-manifest.json` of hashes; `--verify` checks a directory (and with `--base-json` its hashes against `base.json`). The base release job must keep this next to `base.json` (planned ota-cli port extension). |
| `base-info` | `--android DIR --ios DIR [--release-tag T] [--toolchain-image I] [--app-version V] [--out FILE]` | merges the two platforms' base builds into `base.json` for `ota-cli init`. Defaults: tag `v<appVersion>`, image `local-unpinned`. Prints to stdout without `--out`. |
| `deploy-args` | `--report FILE --report FILE --unit U --version V --pr N [--json] [--out FILE]` | exactly two reports (android + ios); enforces the one-unit rule; prints `--version ... --unit ... --pr ... --patch-<p> ... --built-<p> ... --update-type-<p> ...` for affected platforms. Fails `NOTHING_TO_DEPLOY` if unchanged on both. |
| `doctor` | `--project DIR [--platform android\|ios] [--json] [--deep] [--delta auto\|on\|off]` | readiness check; PASS/WARN/FAIL/MANUAL per check, exit 1 on any FAIL. `--deep` also runs `verify-repro` (skipped if there is a FAIL). Checks: Node, package.json, RN version, Metro versions/consistency, `units.config.json` and roots, host entry, `metro.config.js` wiring (child probe), native build dir blockList and dangling symlinks, real `node_modules`, Hermes enabled, hermesc pin vs the project's RN copy, hermesc `-base-bytecode` support (FAIL if delta is wanted and missing), `hdiffz_tool`/`ota_apply`, tools/work dirs; MANUAL for native-module review and CI image pinning. |

```sh
node packages/ota-build/src/cli.ts fetch-tools
node packages/ota-build/src/cli.ts doctor --project examples/spike-app --platform android
node packages/ota-build/src/cli.ts bundle --project examples/demo-app --platform android --app-version 11.9.0 --source-sha $(git rev-parse HEAD) --out .work/base-android
node packages/ota-build/src/cli.ts bundle --project examples/demo-app --platform android --app-version 11.9.0 --base-build .work/base-android --out .work/new-android
node packages/ota-build/src/cli.ts patch --base .work/base-android --new .work/new-android --out .work/patch-android
node packages/ota-build/src/cli.ts verify-repro --project examples/demo-app --platform ios
# after doing the same for ios:
node packages/ota-build/src/cli.ts base-info --android .work/base-android --ios .work/base-ios --out .work/base.json
node packages/ota-build/src/cli.ts deploy-args --report .work/patch-android/patch-report.json --report .work/patch-ios/patch-report.json --unit cabs --version 11.9.0 --pr 42
```
`git rev-parse HEAD` requires a git checkout (this working tree may not be one); pass any 40-char sha instead. Prerequisites: `scripts/fetch-tools.sh` and `scripts/native-build.sh --tools`.

## 3. unit-splitter CLI

Entry: `node packages/unit-splitter/src/cli.js <command> --project DIR [flags]`. Exit 2 on usage error, 1 on `VerificationError` (rule violations printed). Details of rules: [rules catalog](rules-catalog.md).

| Command | Flags (default) | Output |
|---------|-----------------|--------|
| `build` | `--out DIR` (`<project>/dist`), `--approach serializer\|postprocess` (`serializer`), `--base DIR` (none; patch mode), `--bits N` (`48`), `--platform ios\|android` (**`ios`**), `--entry PATH` (config `entry`, else `src/host/index.js`) | dist dir (`host.js`, `units/*.js`, `ids.json`, `units.json`), file hashes, per-rule check summary, warnings |
| `cycle-baseline` | `--platform`, `--entry`, `--bits`, `--file FILE` | JSON for `checks.cycleBaseline`; to stdout, or written to `--file` |
| `api-snapshot` | `--platform`, `--entry`, `--bits`, `--write` | public-package API snapshots to stdout; `--write` stores each at `checks.publicApiSnapshot[pkg]` |

```sh
node packages/unit-splitter/src/cli.js build --project examples/demo-app --out .work/demo-dist --platform android
node packages/unit-splitter/src/cli.js cycle-baseline --project examples/spike-app --platform android --file .work/cycles.json
node packages/unit-splitter/src/cli.js api-snapshot --project examples/two-package-app --write
```
Other splitter entry points:
- `node packages/unit-splitter/src/determinism.js [project]` (default project `examples/demo-app`): builds a copy at two different paths/TZ/LANG for both approaches; exit 1 if not byte-identical or a path leaks.
- `sh packages/unit-splitter/scripts/metro-matrix.sh <metro-version> [tmpdir]`: copies splitter + demo-app to a temp tree, installs exactly that Metro, runs `npm test` there (e.g. `0.87.1`). Use an absolute node on PATH; `sh` has no nvm.
- Library: `withOtaUnits` from `packages/unit-splitter/src/with-ota-units.js` (see [config reference](config-reference.md) and [adopting guide](../guides/adopting-in-your-monorepo.md)).

## 4. tools/

| Command | Flags | Notes |
|---------|-------|-------|
| `node tools/ota-propose.mjs <unit> <version> --monorepo PATH --deployments PATH [--ticket KEY] [--title TEXT]` | `unit` matches `^[a-z][a-z0-9-]*$`, `version` like `11.9.0` | Resolves branch `ota/<unit>/<version>` (remote-tracking ref first, then local) to a 40-hex sha, writes `<version>/<unit>.json` (`{branch, sha}`) into the deployments checkout, and **prints** the `git`/`gh pr create` commands. It runs no git write and no network call. Branch must already be fetched. |
| `python3 tools/repro_check.py --repo PATH --build-cmd CMD --out-dir REL [--rev HEAD] [--install-cmd CMD] [--runs 2] [--env-b K=V ...] [--sleep-between 2] [--reference FILE] [--keep]` | exit 0 = identical (and matches `--reference`), 1 otherwise | Clones the repo locally N times into fresh temp dirs, runs install/build, hashes (sha256 and md5) every file under `--out-dir`, compares. `--env-b` perturbations apply to runs after the first. Reference format `{"relative/path": "<sha256|md5 hex>"}`. |

```sh
node tools/ota-propose.mjs cabs 11.9.0 --monorepo ~/work/monorepo --deployments ~/work/ota-deployments --ticket CAB-1244 --title "fix empty-state crash"
python3 tools/repro_check.py --repo ~/work/monorepo --rev release/11.9 --build-cmd "node packages/ota-build/src/cli.ts bundle --project . --platform android --out build/android" --out-dir build/android --runs 2 --env-b TZ=Asia/Kolkata --env-b LANG=C
```

## 5. scripts/ and root npm scripts

All scripts are bash, runnable from any cwd, and source `scripts/lib/common.sh` (which sources `scripts/env.sh` quietly). Root `package.json` is a task runner only (not a workspace).

| npm script | Runs | |
|------------|------|---|
| `npm test` | `bash scripts/test-all.sh` | all suites |
| `npm run test:fast` | `test-all.sh --fast` | |
| `npm run test:native` | `test-all.sh --native` | |
| `npm run doctor` | `bash scripts/doctor.sh` | |
| `npm run clean` | `bash scripts/clean.sh` | |
| `npm run fetch-tools` | `bash scripts/fetch-tools.sh` | |
| `npm run native:build` | `bash scripts/native-build.sh` | |
| `npm run schemas:fixtures` | `node scripts/gen-schema-fixtures.mjs` | |
| `npm run schemas:test` | `cd packages/ota-core && node --test test/schemas.test.ts` | |

| Script | Flags | Behavior |
|--------|-------|----------|
| `. scripts/env.sh` (source it) | `OTA_ENV_QUIET=1` silences output | Exports `OTA_ROOT`; puts newest `~/.nvm/versions/node/v24*/bin` and `/opt/homebrew/bin` on PATH; sets `CC=/usr/bin/clang`, `CXX=/usr/bin/clang++`; sets `ANDROID_HOME` if `~/Library/Android/sdk` exists. Never changes shell options. |
| `scripts/doctor.sh` | none | Machine readiness, no network: node >= 22.12 (WARN below 24), npm, cmake, `/usr/bin/clang++`, broken `/usr/local/bin/clang*` symlinks (WARN), java, Android SDK/emulator/adb/NDK, Xcode, installed deps of the three packages, hermesc/hdiffz_tool/ota_apply present, free disk (FAIL < 3 GB). Exit 1 on any FAIL. This is the *machine* check; `ota-build doctor` is the *project* check. |
| `scripts/fetch-tools.sh [args]` | passes args to `ota-build fetch-tools` (e.g. `--force`) | needs network the first time |
| `scripts/native-build.sh` | `[--asan] [--tools] [--dir DIR] [-j N] [--clean] [-- extra cmake --build args]` | default: all targets into `native/build`; `--asan`: `-DOTACORE_SANITIZE=ON` into `native/build-asan`; `--tools`: only `ota_apply` + `hdiffz_tool` into `native/build-ota-tools`. Always passes `/usr/bin/clang(++)`. |
| `scripts/test-all.sh` | `[--fast] [--native] [--no-android]` | runs ota-core tests + typecheck, ota-cli, unit-splitter, ota-build (SKIP with reason when tools or deps are missing), optional native ctest; per-suite timeout `OTA_SUITE_TIMEOUT` seconds (default 1800); logs in `.work/test-all/`; prints a summary table; exit 1 on any FAIL. `--no-android` is accepted for CI parity and changes nothing. |
| `scripts/clean.sh` | `[--dry-run\|-n]` | removes `<repo>/.work` and `native/build*`; never `node_modules`, `.tools`, sources or schemas. Note it removes `native/build-ota-tools` (rebuild with `native-build.sh --tools`). |
| `node scripts/gen-schema-fixtures.mjs [--keep]` | | regenerates `schemas/fixtures/*.json` by running the real pipeline on `examples/demo-app` with a fixed clock (`scripts/lib/fixed-date.mjs`); work dir `.work/schema-fixtures`. Needs hermesc and the native tools. See [file formats](file-formats.md). |

## 6. Native tools

Built by `scripts/native-build.sh` (see [native README](../../native/README.md) for raw CMake commands and options `OTACORE_ZSTD`, `OTACORE_LZMA`, `OTACORE_ZSTD_SMALL`, `OTACORE_SANITIZE`, `OTACORE_BUILD_TOOLS`).

| Tool | Usage | Notes |
|------|-------|-------|
| `ota_apply` | `ota_apply <old\|-> <patch> <out> <expected-sha256:HEX>` | applies with the shipped `otacore::applyPatch`; `-` = empty old (for `full`). One JSON line on stdout. Exit = status: 0 ok, 1 IoError, 2 PatchCorrupt, 3 HashMismatch, 4 UnsupportedAlgo, 64 usage. On failure `out` is untouched. |
| `hdiffz_tool` | `hdiffz_tool [-c none\|zstd\|lzma] [-l level] [-m score] old new out.patch` | diff side, test/build only, never shipped. `ota-build` uses `-c zstd -l 19 -m 4`. |
| `measure_patch` | `measure_patch <old> <new> [label]` | patch size/time/peak RSS measurements (`native/tools/measure.cpp`). |
| `gen_synthetic` | `gen_synthetic <outdir>` | synthetic old/new pairs. |
| `native/tools/measure_size.sh [workdir]` | | patch-side binary size per plugin combination (macOS). |
| `node native/tools/make_hbc_corpus.mjs <outdir> <tweak\|feature\|big> <srcDir>...` | | builds v1/v2 Metro-style bundles from npm sources for the bytecode-diff experiment. |
| `native/measure-rn078/{fetch_tools,run_diff,demo_hbc,determinism}.sh` | usage lines at the top of each script; reproduce commands in `native/measure-rn078/RESULTS.md` | research measurements, not part of the pipeline. |

The C++ test suites run with `ctest --test-dir native/build --output-on-failure` after `scripts/native-build.sh`.

## 7. Package npm scripts

| Package | Script | Command |
|---------|--------|---------|
| `packages/ota-core` | `test` | `node --test "test/*.test.ts"` |
| | `typecheck` | `tsc --noEmit -p tsconfig.json` (also typechecks ota-cli) |
| | `vectors` | `node scripts/gen-vectors.ts` (regenerates `vectors/*.json`; commit the result) |
| `packages/ota-cli` | `test` | `node --test "test/*.test.ts"` |
| `packages/ota-build` | `test` | `node --test --test-concurrency=1 --test-timeout=900000 "test/*.test.ts"` (needs hermesc + native tools) |
| `packages/unit-splitter` | `test` | `node --test --test-concurrency=1 test/*.test.js` |
| | `build` | `node src/cli.js build --project ../../examples/demo-app --out ../../examples/demo-app/dist` |
| | `determinism` | `node src/determinism.js` |

Install dependencies per package (`cd packages/<name> && npm install`); there is no workspace install.
