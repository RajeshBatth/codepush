# CodePush: Goals, Approach, Design (draft v0.3)

Status: draft. **[DECIDE]** = needs a call. **[SPIKE]** = measure first.

v0.3 changes: "chunk" is renamed **unit**; deployment workflow rewritten around the `ota-deployments` repo with PR verification and PR-comment commands (`ota-deploy`, `ota-rollout`); releases are sharded per unit; patch size has a soft (warn) and a hard (block) limit. Simplicity is the priority; tech cleanup of LoBs comes *after* safe release/rollback exists.

## 1. Context

Hybrid app: native shell (Home/Common, Flights, Hotels) plus React Native LoBs (Bus, Rails, Cabs, Holidays, Chatbot/Travelplex, +5-8). Hermes. Some LoBs live in their own repos (internal npm, linked into the monorepo at build), some in the monorepo. LoB code quality is uneven (cycles, singletons, globals, duplicated libs); **the system is not designed to accommodate that**. The Common team (project owner) owns the base bundle and the pipeline. Infra: GitHub Enterprise (no Actions), Jenkins, Jira.

**App shape: bare React Native 0.78 (Fabric/bridgeless, Hermes, Metro 0.81), hybrid: the first screen is native and RN surfaces are reached through native entry points.** No RN VM is needed to render the first page, which shapes the loader (5.8).

Monthly train (freeze -> dev test -> release-branch merge -> QA sign-off, Android then iOS) costs ~40% of bandwidth. The `release` branch is strictly gated; **patches never land on it**.

## 2. Goals

| # | Goal | Measure |
|---|------|---------|
| G1 | Ship fixes/features to prod after the cut without a new train | Time from fix merged to prod: weeks -> hours/days |
| G2 | Take pressure off sign-off: late changes have a safe path, so the train can freeze earlier and test less under duress | Train overhead 40% -> target [DECIDE] |
| G3 | Rollouts are safe and reversible: staged, observable, rollback in minutes | Rollback MTTR, crash-free delta |
| G4 | LoB teams release independently, no cross-team coordination for a patch | No approval for patches beyond the LoB's own team |
| G5 | Make the system conducive to later cleanup: isolation rules make bad design *visible and blocking*, not accommodated | Number of LoBs patchable over time |

### Non-goals
- Patching native code, or anything that changes the app's primary purpose (store policy).
- Supporting LoBs that break unit rules (they stay in the host until fixed).
- Cross-LoB atomic releases (those wait for the train).
- Automating cleanup itself.

## 3. Principles
1. **Simple over general.** Static files, client-side decisions, few moving parts.
2. **Patch = diff against the embedded bundle** of the exact app version. No chains, no client state negotiation.
3. **One unit per patch.** Small blast radius, easy attribution, authorization falls out of it.
4. **Embedded bundle is always the fallback.**
5. **Integrity is enforced in CI; process is convention** (best practices, section 7.6).

### Design tenets (how to judge future changes)
1. **Built on existing systems and known patterns:** git (pins, review), Jira (approval), PR-comment commands, Jenkins, the CI artifact store, the CDN pipeline. A new capability should reuse one of these before introducing a new system.
2. **No new server and no new analytics:** there is no OTA server (the CDN serves one static manifest) and no telemetry pipeline. Health is judged by each LoB's own product analytics and Sentry, using the `unit`/`patchId` attribution the SDK exposes. The only automatic safety net is on device (verify, confirm, crash-loop guard, embedded fallback).
3. **Simplicity serves audit and authorization first, cost second.** Every state change is traceable to a requester, an approver who is not the requester, a Jira ticket, a PR and a source SHA (`audit.json` chain), and authorization is "owner team of the unit" everywhere. The exceptions are explicit and recorded: halt needs no approval (it only reduces exposure) and break-glass bypasses tickets (and is logged). When a simplification would weaken the audit trail or the authorization model, it loses.
4. **No toolchain change.** The client framework works within Metro, Hermes and the current React Native; no migration to another bundler. Any step that requires the whole organization to change its build or dev workflow is out of scope.

## 4. Bundle layout

Terminology: a **unit** is an independently patchable piece of the app: one per declared LoB (cabs, travelplex, ...) plus the special unit **`host`** (the `mainBundle`).

```
base (embedded in binary)
  host         : everything that is not a unit (react, RN, navigation, design system, shared stores, third-party libs, bridge)
  unit: bus | rails | cabs | holidays | travelplex | ...
```

- Units are Hermes bytecode with **deterministic module IDs** (hash of module path), so a patched unit resolves host modules identically to the embedded base.
- **Host = everything that is not a unit.** A unit is exactly the source owned by a declared LoB (source roots/packages listed in the monorepo's build config; npm-published LoB packages linked into the monorepo count by package name). Every other module, including all third-party packages, shared libraries and Common code, belongs to the host. Ownership is by path/package, not by reachability. Shared code is therefore patchable only through the host lane (Common-owned). Consequence: the host also contains libraries used by a single LoB, so the host is larger, and upgrading a library requires the train or a host patch.
- **Declared units:** the build config (roots, entry) lives in the monorepo; governance data (owner GitHub team, Jira project keys, size limits) lives in `units.json` in the `ota-deployments` repo; a check keeps the two lists in sync. Undeclared LoBs live in the host and are not patchable. Declaring a LoB is the opt-in, and passing Tier 2 below is the entry requirement.
- **Direction rule:** allowed edges are unit -> own modules, unit -> host, and host -> unit *only* through `lazyUnit`. Never unit -> other unit, never a static host -> unit import. This makes boundary-crossing cycles impossible by construction.

### Unit rules

Three tiers, differing in *when* they run and whether they can be waived.

**Tier 1: Patch safety (every verify and deploy build; hard fail; no waiver).** Cheap to satisfy because the base already passed; they exist to stop a patch from crashing at runtime.

| # | Rule | Why |
|---|------|-----|
| 1 | Toolchain matches base: build runs in the **pinned toolchain image** recorded in the base release (RN version, **`hermesc` sha256 and HBC bytecode version**, Metro config hash) and compiles with the reproducible recipe in 5.7 (`-O -emit-binary -g0`, fixed relative file name) | HBC only runs on the matching runtime; reproducible bytes |
| 2 | Patch is built against the **base module-ID map**; exactly one unit's artifact differs from base, and the host and all other units are **byte-identical** to the base hashes | one-unit rule; stable resolution |
| 3 | Every import leaving the unit resolves to a module present in the base host (no unit -> other unit) | otherwise "module not found" at runtime |
| 4 | **Dependencies resolve to the host.** Every module a unit imports from outside its own roots must exist in the base host *at the same `package@version`*. A patch may introduce a package not present in the host only if it is pure JS (no `ios/`/`android/`, podspec, codegen config, or unregistered `NativeModules` use); it is then bundled into the unit. A package present in the host at a different version fails the build (upgrading shared libs goes through the train or the host lane) | prevents duplicate singletons and silent version drift |
| 5 | No new native-backed package or `NativeModules`/TurboModule reference that the binary does not register | the binary cannot gain native code OTA |
| 6 | `baseHash` of the unit matches the hash recorded in the base release | right base |

**Tier 2: Unit eligibility (base build, for declared units; hard fail).** This is the real cleanup work, and it is where bad design gets blocked rather than accommodated.

| # | Rule | Why |
|---|------|-----|
| 7 | Direction rule holds (no static host -> unit import, no unit -> unit import) | lazy loading works |
| 8 | Unit roots are disjoint, and no owned module is also imported statically by host code outside a `lazyUnit` boundary | clean ownership |
| 9 | Unit declared in both the build config and `units.json` (owner team, Jira keys, entry module exists) | governance |

A LoB that cannot pass Tier 2 simply stays undeclared (in host). A declared LoB that regresses fails the *base* build, so it is fixed before the train, not discovered during a patch.

**Size limits (verify phase).** Each patch artifact (patch or `full`, whichever is served) is measured per platform:
- **Soft limit:** the check passes but posts a **warning** on the PR (visible to reviewers).
- **Hard limit:** the check **fails**; the PR can't merge. The remedy is to shrink the change, split it, or ride the train. Changing a limit is a PR to `units.json` by Common.
- Limits are set globally with optional per-unit overrides, each as absolute bytes and as a ratio of the unit's base size (either exceeding triggers). The host has its own, stricter limits. Values are [DECIDE] after Phase 0 measurements.

**Tier 3: Hygiene (warn at launch; ratchet per LoB later).** Do not affect runtime correctness.

| # | Rule | Why |
|---|------|-----|
| 10 | Unit base size budget (startup) | startup |
| 11 | Same new pure-JS package (not in host) imported by more than one unit in a patch | **implemented as an ERROR** (`new-package-in-multiple-units`, not a warning): one module id cannot live in two unit files, so add the package to the host instead |
| 12 | Assignments to `global`/`globalThis` inside units (lint) | hidden cross-LoB coupling; cannot be proven safe statically |
| 13 | New pure-JS dependencies introduced by a patch (listed for review) | review visibility |

**Static breakage checks added after the spike (implemented in `packages/unit-splitter`; configured by `checks` in `units.config.json`):**

| Rule id | Tier | Default | What it catches |
|---------|------|---------|-----------------|
| `cycle` | 2 (base build) / 1 (patch) | error | A **cyclic dependency** (static edges) inside a unit, including packages bundled into it, or in first-party host code. Shortest cycle is reported (`a -> b -> a`) with a stable signature over the whole cycle group. **Ratchet policy:** on a base build any cycle is an error unless it is listed in `checks.cycleBaseline` (generate it with `cli.js cycle-baseline`), so a messy LoB can adopt incrementally; on a patch build only cycles **new compared to the base build's recorded `cycles`** fail. Adding a module to an accepted cycle counts as a new cycle. Third-party host code (RN internals: 3-4 cycles in the spike app) is counted for information, never enforced. |
| `cycle-async` | warn | warn | Cycles that need an `import()` edge. |
| `host-to-unit-static`, `host-imports-non-entry`, `unit-to-unit`, `lazyUnit-name-mismatch` (tightened) | 1/2 | error | **Encapsulation:** a module inside a unit may be imported from outside the unit **only by the host, only through a plain async `import()`, only to the unit's declared entry**. Also covers host `require()` of a unit module, `export ... from` re-exports of a unit module, and a unit module re-exported through a host barrel file. `lazyUnit` name check works for relative and bare package specifiers. |
| `multiple-import-sites` | 3 | warn (`checks.singleImportSite`: off/warn/error) | A unit entry imported from more than one place in the host (all sites listed). |
| `dynamic-require` | 1/2 | error | Non-literal `require(x)`, non-literal `import(x)`, `require.context(...)`: they defeat every static rule. Metro 0.81.5 already rejects non-literal `require()` in first-party code and non-literal `import()` everywhere (translated into our rule format; cannot be downgraded); in `node_modules` a non-literal `require()` silently becomes a runtime-throwing placeholder, which we detect in the output for packages bundled into a unit (error) and only count for host packages; `require.context` is not rejected by Metro without `unstable_allowRequireContext`, so we detect it with an AST pass. |
| `register-component` | 2 | off (`checks.requireRegisterComponent`; on for the spike app) | A unit entry must call `AppRegistry.registerComponent('<unitName>', ...)` with a literal name equal to the unit name (native entry points mount that name). |
| `host-export-missing` / `host-export-unknown` | 1/2 | error (`checks.hostExports`: error/warn/off) / warn | **A unit may only import names that exist in the host module's runtime exports** (named, default, `ns.member`, `export {a} from`, `require('x').a`, destructured `require`). Runs in base and patch mode (host sources equal base in patch mode, so current host exports equal base exports). The analyzer understands ESM (all `export` forms, `export *` followed through the graph, cycle-safe) and Babel/tsc-compiled CJS (`exports.x`, chained `void 0`, `defineProperty` getters, `module.exports = {...}`, the Babel `Object.keys(_x).forEach` and tsc `__exportStar` wildcard re-exports). Opaque targets (`module.exports = fn()`, computed names, unparsable) are **never a failure**: they produce the warning `host-export-unknown`. |
| `public-deep-import` / `public-package-not-host` / `public-package-missing` | 1/2 | error (`checks.publicPackages` lists the public packages; default none) | A unit may import a public package only through its entry or files exposed by `exports`/`main`/`react-native`/`browser`/`module`; the public package must be host-owned (not under a unit root) and installed and reachable from the host entry. |
| `public-api-breaking` / `public-api-changed` / `public-api-opaque` / `public-api-snapshot-missing` | 2 | error / warn (error with `checks.publicApiStrict`) / error / error | **Keeps the public package stable:** `checks.publicApiSnapshot: {"@travelplex/core": "api/travelplex-core.api.json"}` holds the sorted runtime export names (and the default-export flag) of the package entry. Removing or renaming a name, or dropping the default, fails; adding a name is a reviewable snapshot change; an entry the analyzer cannot read fails with instructions. `cli.js api-snapshot --project <dir> [--write]` produces it. Every build records `publicApi` in `units.json`. |
| `asset-not-in-base` / `asset-path-changed` | 1 (patch mode) | error (`checks.assets`) | **Implemented.** A patch may only reference assets whose bytes are already in the binary: every asset a unit uses must exist in the base build with the same path and sha256 (and the same `@2x`/`@3x` variant set). A new or changed asset fails (`asset-not-in-base`, says which); an asset whose registered location/name changed while the bytes are the same fails (`asset-path-changed`, with both Android drawable names), because the Android resource name derives from the path and a move would point at a resource that does not exist. Removing an asset is allowed. `units.json` records `assets[]` with `name`, `type`, `httpServerLocation`, `scales`, `androidResource`, `iosPath`, `variants[]`. (RN strips characters outside `[a-z0-9_]` when deriving the drawable: `bus-icon` -> `busicon`.) |
| `native-module-new` / `native-method-new` / `native-module-dynamic` / `native-refs-base-missing` | 1 (patch mode) | error / warn / warn / warn (`checks.nativeModules`) | **Implemented (v1: Tier 1 rule 5).** The inventory is derived from the BASE JS graph (everything the base references must exist in the binary): an AST scan of `NativeModules.X`, destructuring, `TurboModuleRegistry.get/getEnforcing('X')`, `requireNativeComponent`/`codegenNativeComponent`, `UIManager.getViewManagerConfig('X')` records `nativeRefs` in `units.json` (68 references on the spike app's RN graph, 0 parse failures, ~66 ms). A unit patch referencing a native module or view name the base never referenced fails (`native-module-new`); a new method on a known module and non-literal names only warn. **Limits:** it can only reject modules the base JS never referenced (a module present in the binary but unused by the base JS cannot be adopted OTA until the train references it); indirect uses (codegen spec wrappers, a module obtained in one file and used in another, `NativeModules[name]`) are invisible, hence the warnings; matching is by identifier name; first-party host files are not checked in a patch. A native-side inventory with `contractHash` remains planned. |

**Limits of the export checks (honest):** namespace imports are checked only for `ns.member` (not `ns[x]`, destructuring, or passing `ns` around); no shadowing analysis; `require` forms never check `default`; `export {x} from './y'` does not verify that `x` exists in `./y`; runtime mutation of exports is invisible; a host-owned package under `node_modules` counts as third-party host, so cycles inside the public package are counted but not enforced. On the real spike app the checks add no findings (0 errors, 0 warnings; the analyzer reads `react-native/index.js` with its 104 names and `react/jsx-runtime`) and build time is unchanged (~4.1 s per platform). A two-package example (`examples/two-package-app`, 21 tests) proves the pattern end to end in the build harness: `init()` runs exactly once per VM at host boot and not again when the unit opens; the unit shares the host's session singleton; a UI-only unit patch changes only the unit artifact with the host byte-identical; each negative case (missing name, deep import, removed/renamed export, core importing the unit statically, CJS-compiled and opaque cores) is caught. A cycle closed only by the intended `lazyUnit` boundary is counted (`lazyUnitBoundaryCycles`) but does not warn.

**Unit ownership by package name works** (a unit's declared roots may be directories or package names; roots are realpath'd because Metro reports symlink-resolved paths, so a linked unit would otherwise end up silently in the host). Verified for a real copy in `node_modules`, a symlink into the project, and a symlink outside the project (outside directories are added to Metro's `watchFolders`; module keys become `node_modules/<pkg>/...` so ids stay machine-independent). Before this change a package-name root did not work at all. On the real spike app the new checks find no cycles, no dynamic requires and no multiple import sites; build time is unchanged (~5-6 s per platform) and the build output is byte-identical to before.

**Known gaps (no rule can catch these):** a LoB patch changing the shape of data it writes into a host store that other LoBs read; behavior regressions. These rely on LoB testing and staged rollout.

### 4.1 The two-package pattern: a stable public package plus a patchable private unit

**Principle:** the package boundary is the patch boundary. What is in the binary (public, host-owned) can change only with an app release or the host lane; what is OTA-patchable (private, unit) can change at any time. A LoB that has code that must run outside its unit, or that the rest of the app consumes statically, ships **two npm packages**:

| | **Public package** (host-owned) | **Private package** (the unit) |
|---|---|---|
| Example | `@travelplex/core` | `@travelplex/ui` |
| Contents | fetch-config API, ws-init, **thin UI shell** (loader/error states, the only place that `import()`s the unit), shared modules consumed by the rest of the app, the singleton state (connection, session, config) | everything else: screens, flows, copy, business UI |
| Declared as | not under any unit root (so the host owns it) | `units.config.json` unit with `roots: ["@travelplex/ui"]`, `entry: "@travelplex/ui"` |
| Ships in | the binary (embedded host bundle) | the binary as the embedded unit, and OTA patches on top |
| Changes via | app release, or the host lane (rare) | unit patch (`ota-deploy`), per-LoB approval |
| Stability | **very stable**: additive-only API, snapshot-checked | free |

**Dependency directions (all already enforced by the existing rules):** host/other LoBs -> public package (static import, allowed); unit -> public package (unit -> host edge, allowed, **same module instance**, so session/connection state is shared); public package -> unit **only** through the shell's `lazyUnit('travelplex', () => import('@travelplex/ui'))` (host -> unit async import of the declared entry; the shell file is the single import site). The public package must never statically import unit code (`host-to-unit-static`). In `package.json` the public package lists the unit package as an optional `peerDependency` and the app installs both. A cycle that is closed only by the intended `lazyUnit` boundary is by design and is not reported.

**Entry paths coexist:** a native entry point calls `openUnit("travelplex")` (primary, 5.8); RN screens of other LoBs embed `<TravelplexEntry/>` from the public package (the shell). Both load the same pinned unit; if the unit is already loaded in this VM the shell's `import()` resolves immediately.

**Code that must run outside the unit** (ws-init, fetch-config) lives in the public package:
- `init()` is **idempotent, never throws, never blocks the JS thread** (starts async work only); the host entry calls it once per VM at host boot. Because the VM is prewarmed after the native first page is interactive, the socket and config start before the user taps.
- A host swap or a lifecycle destroy recreates the VM and runs `init()` again: the core must reconnect cleanly, and the server side must tolerate it.
- If the connection must exist **before any VM** (e.g. an unread badge on the native first page) or must **survive VM recreation**, the connection is owned by native code (Kotlin/Swift) and the core only talks to it through a native module. This is the robust choice for long-lived sockets and does not change the unit boundary.

**What the unit may rely on:** a unit patch is built against the base host of each live app version, so it can only use public-package API that already shipped in that version's binary. Enforced by `host-export-missing` (every named import a unit takes from a host module must exist in that module's runtime exports) and `public-deep-import` (units import the public package only through its entry / `exports`, never its internals). The same unit change may therefore verify for the latest version and fail for an older one; patches are built and verified **per live version**.

**Keeping the public package stable (the key rule):**
1. **Additive-only API.** The public entry's runtime export names are recorded in an API snapshot (`checks.publicApiSnapshot`); removing or renaming a name fails the build (`public-api-breaking`); adding one shows as a reviewable snapshot change (`public-api-changed`).
2. **Thin by construction.** The core holds transport, state and the loader shell; volatile logic (UI, flows, copy) stays in the unit. Tunable behavior comes from the fetched config, not from code, so it can change without a host release. The unit must tolerate missing or extra config fields (a patched UI may meet an older core's config).
3. **No UI logic in the shell** beyond loading/error/retry; the shell never decides business behavior.
4. **Which lane changes what:**

| Change | Lane |
|--------|------|
| UI, flows, copy, validations in the unit | unit patch (OTA) |
| ws-init or fetch-config bug, transport/state change | host lane (rare) or the train |
| New public API plus UI that uses it | train (a coupled release); later UI-only changes are OTA again |
| Behavior that is config-driven | change the remote config |

**If the Travelplex team later needs to hotfix initializer logic without a host release,** the option is an *eager unit* (evaluated at VM boot, consumed through a runtime registry rather than a static import). It gives up static consumption, so it is deliberately not part of the first version.

## 5. Client: manifest, lazy units, and VM lifecycle

### 5.1 Model
- At app start the SDK fetches **one** manifest: `GET <cdn>/<platform>/<app-version>/manifest.json` (conditional GET, cached on disk). It lists the host bundle (`mainBundle`) and a dictionary of units with their patches (section 6).
- Units load through a React.lazy-like boundary, `lazyUnit('cabs')`. When the boundary activates, the native side looks the unit up in the manifest, picks the patch for this device (bucket), and fetches it if it isn't already on disk. The tree suspends meanwhile; the screen can fetch page data in parallel, and the host provides loader and error screens.
- A "unit fetch" is a **patch** fetch: the patch is applied to the **embedded unit** to produce the unit bundle, which is then handed to the JS runtime. Patch algorithm is **HDiffPatch "single compressed diff" with zstd** (lzma optional), identified by `patchAlgoVer` (`v1`). Uncompressed diffs are not viable for Hermes bytecode (see 5.7).
- Storage: app-private, non-purgeable dir (Android `filesDir`, not `cacheDir`; iOS Application Support, not Caches; excluded from backup), rooted at `codepush/<versionName>-<buildNumber>/`. **On every start, delete any sibling root belonging to another app version.** Inside the root, keep the **built unit** (patch applied, hash verified) so applying happens once, not every session; delete the patch file after a successful build, and delete anything no longer referenced by the manifest after each sync.

### 5.2 Resolution at the boundary (per unit, per VM)
1. **Manifest:** use the in-memory manifest, else the on-disk one from the last session. **Never wait for the manifest.** On a fresh install with no cache, use embedded; patches are picked up from the next session.
2. **Select:** find the patch whose `range` contains this device's bucket for this unit; no match -> embedded. Ignore any patch whose `baseHash` differs from the embedded unit's hash, whose manifest `patchAlgoVer` the binary doesn't support, or whose `requiresHost` is set and does not equal the **host id the running VM booted with** (embedded instead; see 5.5).
3. **Fetch/build:** built unit on disk -> use it. Download in flight -> wait up to a **per-unit budget** (default ~1s) then fall back to embedded and let the download finish for next time. Nothing on disk and nothing in flight -> start the download, wait within the same budget, else embedded.
4. **Prefetch** reduces waiting: as soon as the manifest arrives, the SDK downloads and builds the selected patches for all units (they're small) in the background, off the main thread.
5. **Pin:** the choice (embedded or patch id) is fixed for this unit **for the lifetime of this VM instance**; a unit's JS evaluates once and its module state lives in the VM. Pinning is per unit, not per session (see 5.5).

### 5.3 VM lifecycle: what takes effect when
| Event | Effect |
|-------|--------|
| Unit first loaded in this VM | resolved per 5.2 and pinned |
| Patch finishes downloading after the unit was loaded | stored; used the next time the unit is first loaded in a fresh VM |
| Manifest changes mid-session (new patch, ramp) | affects only units not yet loaded in this VM; each lookup reads the current manifest snapshot (swapped atomically), so unit A may be pinned from the old snapshot and unit B from the new one (safe, see 5.5) |
| Patch entry removed from manifest or its range no longer includes this device (this is what a "halt" does) | not-yet-loaded units use embedded; loaded units keep running until the VM is recreated; the SDK deletes the built unit on the next manifest sync |
| New VM created (cold start, OS kill, host swap) | everything re-resolves from the latest manifest |

Consequence to accept: a halt does not fix users who already loaded the bad patch in their current session; it takes effect when their VM is next created. Mitigations: the crash-loop guard (section 8) and the VM lifecycle manager. We deliberately do not recreate VMs on halts.

### 5.4 `mainBundle` and applying a new host
`mainBundle` is the host (entry) bundle. It is loaded **before** JS runs, so it cannot be fetched lazily:
- Download and build happen in the background; the native side decides which host to boot with from disk only, **never from the network**. A host already built in an earlier session is simply used when the VM is created at launch, so the logic below only matters when the manifest (and the host patch it points to) arrives **after** the VM was already created.
- `updateType`: `patch` (diff against embedded) or `full` (whole replacement bundle). The build picks `full` when the patch would be larger than ~60% of the bundle. The same field is valid on unit entries.
- **Apply behavior (single, no strategy field):** when a newer host is ready (downloaded, built, hash-verified) and a VM built from an older host already exists:
  - if **no JS views are mounted**, destroy that VM and create a new one from the new host;
  - if views are mounted, leave the VM alone; the new host is used when the lifecycle manager destroys it and the next VM is created.
  - Forcing a reload under a visible RN surface is out of scope.
- **Recreate mechanics:**
  - The check happens when the new host becomes **ready** (after download and build), not when the manifest arrives, so we never tear down a VM and then wait for bytes.
  - Hold a lock while recreating: a surface that tries to mount mid-recreate is queued until the new VM is ready (also deep links and RN entry points).
  - The recreated VM re-resolves all units from the latest manifest (section 5.3).
  - Typical case: the manifest is fetched at launch while the user is still on a native screen with a preloaded VM and no JS views, so recreation usually happens in the same session. This costs one extra VM boot.
- **Open question [DECIDE]:** if views are mounted on the old-host VM when the new host becomes ready, should we also recreate the VM the next time the mounted-view count drops to zero, or leave it to the lifecycle manager? Recommendation: recreate at the next zero-views moment, since a stale host otherwise lives until the lifecycle manager happens to destroy the VM.
- **Boot guard (native, pre-VM):** persist a "boot attempt" counter before starting the VM with a patched host; clear it when the first RN surface renders healthily. K unconfirmed boots -> blacklist that host patch and boot embedded.
- Host patches obey the export-surface rule (section 7.4), so embedded or patched units remain compatible with a patched host. Enabling host patches for production is Phase 2, but the manifest and SDK support the field from v1.

### 5.5 Update types and manifest consistency

**Two kinds of release:**
1. **Host (`mainBundle`) update, possibly with units.** Needs a new VM to take effect (5.4).
2. **Unit-only update.** Works regardless of when the manifest arrives, including after the VM is created.

**Is it a problem that unit A loads from a stale manifest and unit B, later, from a fresher one? No, by construction.**
- Bundlers (webpack, Metro) assume one manifest per session because their chunks form a graph with cross-references and content-hashed IDs; mixing versions of chunks that import each other breaks. Our units have **no edges between them** (Tier 1 rule 3, direction rule), and every patch is built against the same base host. Each unit is independently versioned, which is also what Module Federation does: a host plus remotes, each remote's entry resolved at runtime, no global manifest.
- Mixed versions across units already occur in production through cohorts (cabs on a patch, bus on embedded). Per-session snapshots would not remove that; they would only add machinery.
- So the contract is **per-unit consistency, not per-session consistency**: a unit is pinned for the VM's lifetime once loaded; the manifest snapshot is replaced atomically in memory; every lookup reads the current snapshot.

**Why unit-only updates are safe with any host of the same app-version:** unit patches are built against the *base* host, and host patches must keep the export surface (section 7.4), so a unit entry with `requiresHost: null` is valid on the embedded host and on any patched host. CI should smoke-test each unit patch against both the embedded host and (once the host lane exists) the current host patch.

**Coupled releases (host change + unit that needs it):** the only real consistency hazard. **Expected to be rare** (common modules change rarely today), so `requiresHost` is a documented escape hatch, not a normal workflow. An entry may set `requiresHost` to a host entry id.
- The client uses the entry only if the VM booted with that host id; otherwise it uses the embedded unit (or the previous eligible patch) until a VM with the new host exists.
- Avoid coupling when possible (prefer a backward-compatible host and an independent unit). It adds no cost to the common path (`null` by default); implement it in the SDK selection step but do not build tooling or UI around it in v1. Because the workflow allows one unit per PR, a coupled release needs two PRs plus a manual `requiresHost` edit to the manifest state by Common (a super-admin deploy-job command); v1 may simply say "ride the train".

**Remaining hazards (not detectable by tooling):** data-shape contracts through host stores or events between LoBs, and host behavior changes that an old unit did not expect. Both already exist across cohorts and are owned by LoB testing and staged rollout.

### 5.6 Client framework: producing units and loading them (to validate in Phase 0)

Confidence labels: **[verified]** read in source/docs, **[likely]** standard practice but confirm on your RN/Metro version, **[spike]** must be proven.

**A. Producing unit bundles from Metro**
- One Metro run resolves **one dependency graph**; we then partition it by the ownership rule (4): host = everything outside unit roots; unit = modules under that unit's roots. The host bundle carries the Metro runtime, polyfills and entry; a unit bundle contains only `__d(...)` module definitions. Partitioning one graph (not separate builds) guarantees consistent module IDs and no accidental duplicates. [likely]
- **Deterministic IDs:** `serializer.createModuleIdFactory` returning a **48-bit** hash of the project-relative path (12 hex chars, still an exact JS number), with a collision check that fails the build. 32-bit IDs would collide on a real app (roughly 0.3-3% for 5-15k modules). **Filtering:** `serializer.processModuleFilter`, or a `customSerializer` that receives the whole graph and writes several outputs. The common-bundle + business-bundle pattern with these two hooks is well established; the sources I found are older, so confirm the hook signatures on your Metro version. [likely / spike]
- Each output file is compiled separately with `hermesc` to a `.hbc`; per-bundle source maps (Sentry debug IDs must be deterministic too, or reproducibility fails). [spike]
- **Direction rule on the graph:** Metro distinguishes `import()` (async) dependencies from static ones, so "host -> unit only through `lazyUnit`" and "no unit -> unit" can be checked on the graph instead of by grep. [likely]
- **No toolchain change (constraint).** Re.Pack/webpack is ruled out: replacing Metro would need org-wide alignment months ahead. Everything stays on Metro + Hermes + the current RN. Fallbacks if the serializer hooks prove awkward, in order of preference:
  1. **Multiple Metro runs with filters:** one run for the host and one per unit (`processModuleFilter` against a shared path->ID map). Simple, slower, and determinism must hold across runs. [likely]
  2. **Post-process split:** build the normal single Metro bundle with path-hash IDs and an emitted ID->path map, then split the serialized JS by module (a bundle is a sequence of `__d(factory, id, deps)` statements) before `hermesc`. Needs no Metro serializer hooks, only the stable IDs. [likely; spike]
  3. A small Metro serializer wrapper/fork maintained by Common. Last resort.

**Verified by prototype (target stack: RN 0.78 / Metro 0.81.5 with `@react-native/babel-preset` 0.78.3 and `@react-native/metro-config` 0.78.3; also passes on Metro 0.87.1 via a matrix script; `examples/demo-app` + `packages/unit-splitter`, 23 tests passing, byte-identical across absolute paths/TZ/LANG/cwd/time):**
- A single Metro run with `serializer.customSerializer` receives the whole graph and can emit multiple files (host + one per unit). It must return one primary result: the host code is returned and the unit files travel through a side channel. **Approach (a) works and is the default.**
- **Post-processing the stock bundle** at `__d` statements (approach (c)) also works and produces byte-identical output to (a), so it is a validated fallback if the serializer approach breaks on a Metro upgrade. Approach (b), multiple runs with filters, was not implemented (it cannot produce `paths` without a custom serializer anyway).
- **Metro does not emit `paths` in a normal build** (`includeAsyncPaths` is tied to a lazy graph, and a lazy graph drops async dependencies). The splitter writes `paths` itself so `import()` compiles to `asyncRequire(id, _dependencyMap.paths)` with `paths[entryId] === "<unit>"`. The mechanism differs by version: **on 0.81 (your target) there is no `unstable_getAsyncDependencyPath`**, and `includeAsyncPaths` demands a `sourceUrl` and emits `.bundle?...` URLs, so the adapter builds `{...deps, paths}` itself using the public `metro-transform-plugins`; on 0.87 it uses `metro/private/*` helpers. **All Metro-internal access lives in one adapter (`src/metro-compat.js`) that accepts only 0.81.x and 0.87.x and fails loudly otherwise.** On a Metro upgrade, run the matrix (`scripts/metro-matrix.sh <version>`) and keep fallback (c) available.
- `metro-runtime`'s `asyncRequire.js` is functionally identical in 0.81.5 and 0.87.1: a custom `__loadBundleAsync` works, and `unstable_importMaybeSync` and `prefetch` exist.
- **RN 0.78's `@react-native/metro-config`:** sets `asyncRequireModulePath` to the same module as Metro's default (so `import()` compiles identically), sets `inlineRequires: true`, does not touch `createModuleIdFactory` or `customSerializer`, and RN defines its own `__loadBundleAsync` only under `__DEV__`, so release builds are free to define ours. Its `getModulesRunBeforeMainModule` requires RN's `InitializeCore`, which the demo overrides because react-native is not installed there.
- `define()` silently ignores a second definition of an already-defined module ID (first wins, whether or not the first was initialized): a unit cannot be swapped inside a live runtime, confirming the per-VM pin.
- Setup gotchas: Metro does not convert ES modules to CommonJS (the Babel preset must, and `import()` must be left for Metro); `metro-runtime` must be resolvable from the app and its `require.js` directory included in `watchFolders`; `processModuleFilter` alone is not enough, a custom serializer is needed. Modules outside the project root are keyed by the path after `node_modules/` and the Metro cache is disabled in the split build, which is what made output deterministic.
- All direction/dependency rules ran on the Metro graph with negative fixtures: unit -> unit, static host -> unit, import of a non-entry unit module, `lazyUnit` name mismatch, version drift against the base host, module missing from the base host, new native-looking package (all fail); a new pure-JS package is allowed and bundled into the unit. `diffAgainstBase` reports `{changedUnits, hostChanged}` and is the basis of the "only one unit differs" check.
- **Not verified (needs real RN + Hermes):** `hermesc` and real `.hbc` corruption behaviour (the prototype's "fails before registering" check is a parse plus only-`__d` validator); native loaders and JSI evaluate of a second bundle; the real React Native Babel preset, source maps and debug IDs, dev mode/HMR; scale (the demo has 17 modules); the `NativeModules` scan (Tier 1 rule 5) and the `baseHash` check (rule 6) are not implemented, and the pure-JS-package check is a heuristic.

**B. The JS API**
```ts
const CabsApp = lazyUnit('cabs', () => import('@acme/cabs/entry'));   // returns a React.lazy-style component
```
- `lazyUnit` is a thin wrapper over `React.lazy`/Suspense that adds the loader and error UI and **asserts at build time** that the imported entry belongs to unit `cabs` (declared in the build config). A magic comment such as `/* ota-unit-tlx */` is technically possible (a Babel plugin can read leading comments before Metro's dependency collection), but it duplicates information that the unit roots already define and can silently drift, so use the explicit name and let the build verify it.
- **Hook point [verified]:** Metro compiles `import()` into `asyncRequire(moduleID, paths)`. That function looks up `paths[moduleID]`, and if a global `__loadBundleAsync` exists it calls it with that path and, after it resolves, runs `require.importAll(moduleID)`. Custom `__loadBundleAsync` implementations are supported (Metro >= 0.76.3; the older `transformer.asyncRequireModulePath` is deprecated, and `experimentalImportBundleSupport` was removed in that release).
- So: define `global.__loadBundleAsync = (unitName) => NativeOtaUnits.load(unitName)` and make the serializer emit `paths[<unit entry module id>] = "<unitName>"` (we control the serializer, so we can produce this map). Standard `import()` then goes through our loader without patching Metro. [likely; confirm that a custom serializer can emit `paths` in production builds]

**C. Native loader flow**
```
JS  lazyUnit('cabs')  -> suspends
    import() -> asyncRequire(id, paths) -> global.__loadBundleAsync('cabs')
JS->native  NativeOtaUnits.load('cabs')          (TurboModule, returns a Promise)
native      resolve per 5.2: manifest snapshot + device bucket -> embedded | patch id
            embedded      -> path/fd of the unit in app assets
            patch built   -> path of the built file in codepush/<ver>/
            patch missing -> wait up to the fetch budget; download -> HDiffPatch(embedded unit, patch) -> verify sha256 -> atomic rename
            evaluate the .hbc into the running Hermes runtime on the JS thread
native->JS  resolve Promise
JS          require.importAll(id) -> unit's modules were registered by __d -> run entry -> component renders
```
- **Evaluate step: decided from the RN 0.78.3 source (see `docs/research/rn-0.78-loader.md`; still needs an on-device spike):**
  - **Booting a patched host uses RN's own, public hooks.** Android: `DefaultReactHost.getDefaultReactHost(..., jsBundleFilePath = patchedPath or null)` (null falls back to the embedded asset); the host is cached statically with a fixed loader, so a host switch needs a cold start (see unknown 6). iOS: override `bundleURL`/`bundleURLBlock`, which `RCTHost` re-reads on start and reload.
  - **Evaluating a unit uses our own JSI call (option 2), on both platforms.** RN offers no usable public API for a second bundle in bridgeless mode: on Android `ReactInstance` is a package-private class (`final class ReactInstance`), `BridgelessCatalystInstance.loadScriptFromFile` and `registerSegment` throw `UnsupportedOperationException`; on iOS the only route is `registerSegmentWithId:path:`. `CallInvoker::invokeAsync(CallFunc&&)` with `CallFunc = std::function<void(jsi::Runtime&)>` exists in 0.78.3 (verified), so the native module hands a `CallInvoker` and a runtime handle to C++, which runs `invokeAsync([&](jsi::Runtime& rt){ rt.evaluateJavaScript(buf, "unit://cabs"); })` inside try/catch. Re.Pack's `NativeScriptLoader.cpp` (Android) and `ScriptManager.mm` (iOS) do the same, though only with text JS, so Hermes bytecode through this path is not yet proven.
  - **Android sequence:** (1) before the first `getDefaultReactHost`, verify the patched host `.hbc` hash and bytecode version; (2) `getDefaultReactHost(jsBundleFilePath = patched or null)`; (3) for a unit, take `reactContext.jsCallInvokerHolder` (`@FrameworkAPI`) and `javaScriptContextHolder.get()` into JNI; (4) in C++, mmap the file as a **4-byte-aligned** buffer that is never freed, then `invokeAsync(... evaluateJavaScript(buf, "unit://cabs"))`; (5) fallback `reactContext.registerSegment(id, path, cb)` (no error signal; sourceURL becomes `seg-<id>.js`).
  - **iOS sequence:** (1) `bundleURL` returns the verified `file://` patched host, else embedded `main.jsbundle`; (2) get the runtime and call invoker from `[RCTBridge currentBridge]` (`[bridge runtime]`, `[bridge jsCallInvoker]`) or `InitParams.jsInvoker`; (3) mmap an aligned buffer, `invokeAsync(... evaluateJavaScript)` in try/catch; (4) fallback `[bridge registerSegmentWithId:path:]`.
  - **Facts that shape the loader's own checks:** Hermes `evaluateJavaScript` auto-detects bytecode by its magic number and validates the version before running anything ("Compiling JS failed: Wrong bytecode version. Expected 96 but got N"); a buffer WITHOUT the Hermes magic is compiled as JavaScript *source*, so the loader must check the magic itself; a misaligned buffer is rejected ("Buffer misaligned"); the bytecode hash is checked only in debug Hermes builds, so the SDK verifies hashes itself (already in the design).
  - **Unknowns for the device spike: Android answered on an emulator (5.9); iOS pending.** See 5.9 for the results; still open: iOS selectors, a cold process boot with a patched host, release builds, physical devices.
- **Invariant that makes fallback safe:** a unit bundle contains only `__d(...)` definitions, so a bad bundle (wrong bytecode version, corrupt) fails at load/validation before any module registers, and the loader can then evaluate the embedded unit instead. Metro's `define` ignores a second definition of an already-defined module ID (confirm on your Metro version), which is also why a unit cannot be swapped for another version inside the same VM: the per-VM pin in 5.2 is inherent, not just policy.
- **Embedded units:** shipped as uncompressed assets (Android `noCompress` for `.hbc`; iOS bundle resources) so they can be read or mapped and used as the "old" input of HDiffPatch.
- **Host boot (`mainBundle`):** the standard approach used by existing CodePush libraries: before creating the VM, the app's host/delegate returns the path of the patched host bundle instead of the embedded one (Android: the host's JS bundle file/loader; iOS: the bundle URL provider/delegate). Hermes loads it if it is bytecode. The boot guard from 5.4 wraps this. [likely]
- **Errors:** native rejects the Promise with a typed error; `lazyUnit`'s error boundary renders the host error UI and offers retry. Native falls back to embedded internally before rejecting.

**D. What Phase 0 must prove, in order**
1. On your RN and Metro versions: one graph -> host + unit `.hbc` files with path-hash IDs; a bare test app boots the host and loads a unit via `import()`.
2. `__loadBundleAsync` + `paths` end to end with Suspense (JS only, units shipped as embedded assets).
3. Evaluate option 1 vs 2 on Android and iOS, in the app's real architecture mode.
4. HDiffPatch as a C++ library: apply on device from the embedded asset, memory and time.
5. Boot from a patched host file, including the crash-loop guard path.

### 5.7 Measured in the native prototype (`native/`; host machine, not a device)

Build/test status: C++17 core `otacore` (sha256, bucket, manifest parse + validation, `selectUnit`/`selectHost`, streaming `applyPatch`, cache/GC) with a C API for JNI/ObjC. CTest: 4 suites pass, also under ASan+UBSan. All 24 bucket vectors match bit for bit and all 32 select cases match the TypeScript reference (reason strings included). `applyPatch` is atomic and hash-verified: on wrong hash, truncated or corrupt patch (120 random byte flips per compressor), garbage patch or unsupported compressor, no output file and no temp file is left, and an existing output is untouched. (A handful of flips inside lzma padding still produce the correct output; accepted because the hash matches.)

**Patch side size (stripped, `-Os`, arm64):** core ~12 KB; + zstd (small decoder) ~57 KB; + zstd + lzma ~67 KB; full zstd decoder ~85 KB. The nlohmann/json manifest parser alone adds ~91 KB, the largest single item: a purpose-built manifest parser is worth doing before shipping. Peak RSS during apply was ~1 MB or less (the patch is read sequentially); apply took 4-20 ms for the test inputs.

**Which `hermesc`? The one shipped with your React Native version.** RN 0.78.3's `sdks/hermesc/osx-bin/hermesc` (sha256 `a82e519e...02ab`, Hermes commit `a942ef37`, from `sdks/.hermesversion`) emits **HBC bytecode version 96**. The first measurement used a newer compiler (version 98), whose output would NOT load on an RN 0.78 device. Evidence the runtime expects 96: `.hermesversion` pin, `BytecodeVersion.h` at that commit, and the `hermes` CLI in the same tarball; the on-device libhermes itself was not inspected. **Verified with that CLI:** a v98 file or a patched version byte is rejected *before anything runs* ("Wrong bytecode version. Expected 96 but got 98", exit 5), and a truncated file is rejected with a clear error; so a bytecode-version mismatch makes the SDK's load fail cleanly and fall back to the embedded unit.

**Does Hermes bytecode diff well?** Re-measured with the RN 0.78.3 compiler on the open-source corpus (lodash, rxjs, date-fns, moment; zstd-19 diffs; percentages are of the zstd-compressed full bytecode, 331 KB):

| Edit | JS-source diff | v96 `-O` | v96 `-O -g0` | v98 `-O` (same corpus) |
|------|---------------:|---------:|-------------:|-----------------------:|
| 5 literal tweaks | 78 B | 14.1 KB (4.3%) | 13.8 KB | 15.3 KB |
| 5 modules get a new function + strings | 502 B | 51.9 KB (15.7%) | 48.9 KB | 47.1 KB |
| 5% of modules edited | 2.4 KB | 91.2 KB (27%) | 67.6 KB | 67.9 KB |

- Bytecode diffs are ~30-180x larger than source diffs, but still a fraction of shipping the unit. **The cause is verified (see 5.10): Hermes re-sorts the whole string set at the end of compilation, so one string edit renumbers 40-90% of string IDs.** `hermesc -base-bytecode=<embedded base>` removes most of the cost.
- The earlier "1.3 KB for 5 literal tweaks" figure was an artifact of the first corpus; **treat ~14 KB as the realistic small-edit cost** on this corpus.
- Compressed diffs stay mandatory: lzma is ~10% smaller than zstd, uncompressed diffs are 4-5x bigger. `patchAlgoVer` `v1` = HDiffPatch + zstd, lzma optional.
- **Size limits:** ratios must be defined against the **zstd-compressed embedded unit** (what shipping the unit in full would cost), not the raw bundle size: 5% churn is 20-29% of that. Calibrate the real defaults on your own units.
- Demo-app units (compiled with RN's flags `-emit-binary -max-diagnostic-width=80 -O [-output-source-map]`): the tiny units (~1 KB) are slightly larger as bytecode than as JS text; `host.js` 41 KB JS -> 23 KB hbc (16 KB with `-g0`). A unit consisting only of `__d(...)` statements compiles without diagnostics, as does a bundle without Metro's runtime (run alone it fails with `__d` undefined, as expected).
- **Reproducibility recipe (`hermesc`):** `hermesc` embeds the input name/path as a string in the bytecode (a different name shifts offsets; an absolute path leaks `/Users/...`); no timestamps were found. Runs at different times, and the same relative name from different working directories, were identical. **`-g0` removes the name entirely**, so even different names/absolute paths then give identical output (`-output-source-map` yields the same bytes as `-g0`, but the `.map` records the path as passed). Recipe: pin the `hermesc` binary by RN version and sha256; `cd $WORK && hermesc -O -emit-binary -g0 -out unit.hbc bundle.js` with a fixed relative name; verify by building twice in different directories and requiring equal hashes. Cost: stack traces need the source map (Sentry symbolication via the Metro/Hermes map, as in a normal RN release).
- **Executing bytecode:** the `hermes` CLI loads only one HBC file, so *unit evaluated after host in the same runtime* is **still unverified** (needs a JSI harness or device). Host plus a `__d` unit compiled together does run.
- **Bytecode version in the base metadata:** the base release records `hbc.bytecodeVersion` and the `hermesc` sha256 (`base.json`), verify's Tier 1 rule 1 requires the patch build to use exactly that compiler, and the SDK treats a load failure as "use embedded".
- **Platform/SDK layer, not in the core:** manifest `platform`/`appVersion` checks, `version` monotonicity, `ttlSec`, and Ed25519 verification (CryptoKit on iOS, `java.security` on Android; detached signature over the served bytes).

### 5.8 Hybrid lifecycle: native first page, entry points, and the loader's state machine

**Design goals, in priority order:** (1) never delay or risk the native first page; (2) never run code that was not verified; (3) every failure degrades to the embedded bundle, never to a broken screen; (4) minimal added latency on the path from tapping an entry point to a rendered RN screen; (5) one platform-neutral implementation of the decision logic (C++), with thin platform glue.

**Native-driven loading is the primary path; `lazyUnit` is the fallback.** Because the shell is native, the SDK (not JS) knows which unit an entry point opens. Loading before the surface exists avoids Suspense on the JS side, keeps the JS thread free, and lets the SDK apply timeouts and fall back before any RN code runs:
```
native entry point tap
  -> OtaRuntime.openUnit("cabs", initialProps)                          (SDK, runs on the single "ota queue")
       1. ensure a VM exists (create from the best host available on disk; never from the network)
       2. resolve the unit's source: patch (built + verified) | embedded      (5.2 rules, pinned for this VM)
       3. if a patch is selected but still downloading/building: wait up to unitBudgetMs, else embedded
       4. pre-evaluate checks, then evaluate the unit's bytecode into the VM (registers modules only: `__d` statements)
       5. run the unit's entry module (registers the RN component named after the unit)
       6. create/mount the surface (moduleName = unit name)
       7. JS calls OtaRuntime.markReady(unit) after first render -> patch becomes "confirmed"
```
`lazyUnit` (5.6 B) remains for navigation that happens *inside* RN (one unit opening another through the host), and it calls the same native `load(unit)` underneath.

**Single serial "ota queue".** All OTA decisions (selection, download/build scheduling, VM create/recreate, crash counters) run on one serial queue; the JS thread and the main thread only receive commands and send events. This removes data races by construction. Only immutable snapshots (the manifest) cross threads.

**Startup sequence (target: <5 ms of OTA work on the main thread).**
1. App start: SDK init on the ota queue: read the cached manifest, verify its detached signature, validate, reject if `version` is below the highest ever seen (anti-replay; a legitimate restore is published as N+1), compute host and unit selections. Persisted state: `deviceId`, `highestManifestVersion`, per-patch attempt counters and blacklist, last good manifest.
2. Conditional manifest refresh in the background (honours `ttlSec`; jittered; exponential backoff on failure).
3. When a manifest arrives: validate, swap the snapshot atomically, recompute selections, then download and build (apply patch) off-thread: host first, then units in priority order (units reachable from visible entry points, most recently used first). Patches are small (tens of KB) so this normally completes within seconds.
4. **VM prewarm:** after the native first page is interactive, create the VM so the first entry-point tap is fast. If a host patch is selected but not yet built, wait at most `hostSettleMs` (default ~800 ms) before prewarming with what is on disk; this avoids creating a VM and immediately recreating it. If the host patch arrives later, the rule in 5.4 applies (recreate only when no JS views are mounted).
5. Entry point opens while any of this is in flight: the sequence above; the user never waits longer than `unitBudgetMs` (default ~1 s) for OTA, then gets the embedded unit.

**Pre-evaluate checks (all must pass; any failure -> mark the patch bad, use embedded):**
file lives under the cache root (no path escape) and has the expected size; `sha256` of the built file equals the manifest `hash` (a ~1 MB file hashes in a few ms; verified once per process per unit); buffer is **4-byte aligned**; the Hermes **magic number** is present (otherwise Hermes would compile the bytes as JavaScript *source*, which would execute unverified text); bytecode version equals the runtime's; evaluation happens inside try/catch. Because a unit contains only `__d(...)` registrations, a failure before registration leaves the VM clean and the embedded unit can be evaluated instead.

**Crash-loop guard (persisted, native, survives process death).** Before using a patch, increment `attempts[patchId]`; clear it on `markReady`. If the app dies repeatedly (K = 2-3) before confirmation, blacklist that patch (persisted) and stop selecting it; the same for the host via a counter written before VM creation. A blacklisted patch is retried only if the manifest later offers a different patch id.

**Performance rules.** No patch application, hashing of large files or network on the main thread. Patch application happens at download time, never at the entry point (except the bounded wait). Built units are kept so no session re-applies a patch. Bytecode is mmap'd (page-cache friendly). Download policy: any network for patches up to a size cap (default 512 KB, [DECIDE]), larger only on Wi-Fi; resumable or restart (patches are small). Cache GC removes everything the manifest no longer references and every other app version's root.

**Unit policy (implemented in the orchestrator; per unit, with a default for all units).** Version stability, load latency and freshness are a *policy per unit*, not design constants (`Config::defaultPolicy`, `Config::unitPolicy[unit]`; each field overrides individually; field order: unit, then default, then built-in):
- `pin` (lock scope): **`vm` (default)**: a unit's selection is decided at its first load in a VM and is fixed for that VM's life; a **new VM re-resolves from the latest manifest** (adopts a newer patch, drops a halted or blacklisted one). Within a VM a unit cannot change version anyway (Metro ignores a second definition of a loaded module id). **`process`** (opt-in, for a unit that holds live state across VM recreation): the decision survives new VMs, with safety exceptions (decision 14).
- `loadBudgetMs`: how long a load waits for a selected patch that is not built yet. Default `unitBudgetMs` (~1 s). **`0` = latency-first**: never wait, load embedded at once if the patch is not already built (the download carries on; the patch is used by the next resolution). A larger value = freshness-first.
- `fetch`: **`eager` (default)**: as soon as a manifest selects a patch for this device, download and apply it in the background, so the boundary or entry point only loads a built file (priority order from `setEntryPointPriority`). **`lazy`**: no prefetch for this unit (a patch already on disk is only verified, no download); the first request promotes it and downloads inside `loadBudgetMs`; cheaper on data for units most users never open, but freshness shifts to the next resolution unless the budget covers the download. The cellular size cap (`patchSizeCapCellular`) applies in both modes.
- Presets: `UnitPolicy::latencyFirst()` {vm, 0, eager}, `UnitPolicy::freshnessFirst(ms)` {vm, ms, eager}, `UnitPolicy::stable()` {process}.
The apply step is identical in all modes; only its trigger and the lock scope move. Policy lives in SDK config (optionally hinted per entry in the manifest later).

**Privacy and server blindness.** `deviceId` is a random install-scoped UUID in app-private storage (not a hardware id) and never leaves the device: bucketing is local, and the CDN sees only anonymous conditional GETs.

**Keys.** Embed more than one Ed25519 public key (current + next) so a signing key can be rotated without shipping a binary; the signature file carries a key id. [DECIDE]

**Platform glue vs. portable core.** The orchestrator described in this section is implemented once in C++ (`native/otacore/runtime`) against injected interfaces (clock, scheduler, HTTP, file system, persistent store, signature verifier, and a `VmController` that creates/destroys the VM, evaluates a file into it and mounts a surface). It is tested with deterministic simulations (virtual time, fake network) for the scenarios above. Kotlin/ObjC++ implement only the interfaces.

**Decisions made while implementing and testing the orchestrator (`native/otacore/runtime`, 37 scenario tests, also clean under ASan/UBSan):**
1. **Manifest `size` is the patch size** (download size), not the built size. The built size is recorded locally when a unit is built and checked on later runs.
2. **The crash counter counts processes, not VM creations:** it is bumped once per process per id, so recreating the VM inside one process does not double count. With K=2 a patch survives two unconfirmed processes and is blacklisted at the third start.
3. **`markReady(anyUnit)` also confirms the booted host patch** (the first healthy RN surface is the host's confirmation signal).
4. **The unit budget starts when resolution begins, after the VM exists;** VM boot time is not charged to it.
5. **If `require` of the unit's entry fails after the unit was evaluated, the VM is polluted** (Metro's `define` ignores re-registration, so "try embedded" is only valid for failures *before* registration). The runtime blacklists the patch, reports the error to that call, and recreates the VM at the next zero-views moment.
6. **A host recreate is deferred while any unit load is in flight,** not only while views are mounted.
7. **Prefetch resolves `requiresHost` against the host we are heading to** (so coupled units download early); selection at tap time uses the host actually running.
8. **A tap while no VM exists creates the VM immediately** and cancels the `hostSettleMs` wait.
9. **Transient IO/download failures are never persisted as bad:** they retry with jittered backoff up to `maxRetries`, reset on the next manifest swap. Only hash, corrupt-patch and pre-evaluate failures are persisted.
10. **If the attempt counter cannot be persisted, the runtime uses the embedded bundle** (fail closed).
11. **The manifest's `platform` and `appVersion` must match the binary;** `highestManifestVersion` is persisted *before* a manifest is adopted (fail closed).
12. **The host bucket key is configurable** (`hostBucketKey`, default `"mainBundle"`): the host's bucket is `bucket(deviceId, hostBucketKey)`.
13. **`createVm`/`destroyVm` are asynchronous;** `openUnit`/`loadUnit` callbacks fire exactly once and never re-entrantly.

14. **Version lock scope is a per-unit policy: per VM by default, per process opt-in (implemented; `UnitPolicy::pin`; 68 scenarios, also under ASan/UBSan, and with the suite's default pin forced to `vm` and to `process`).** *Per VM (default):* a unit's selection (patch id or embedded, plus the reason) is decided when it first finishes loading in a VM and is reused by every request in that VM (simultaneous requests share one decision); a new VM re-resolves from the latest manifest, so the same process can change a unit's version across VMs. *Per process (`pin=process`, e.g. `UnitPolicy::stable()`):* the outcome is frozen for the process and reused by VMs recreated inside it; prefetch still follows the latest manifest and a newer patch is adopted by the next process. **Safety exceptions of the process pin, checked only when a NEW VM resolves the unit:** the freeze drops if the patch was blacklisted (incl. the crash-loop limit), its entry vanished from the manifest or its hash changed (halt/rollback), selection no longer picks it for this device (range, `requiresHost`, base), the file is missing or fails the pre-evaluate checks, or evaluate/attempt-write fails in the new VM. A frozen *embedded* outcome is kept like any other; a failed resolution is never frozen. Observer events `selection-frozen`, `selection-reused`, `selection-dropped` carry `scope=vm|process` in the detail (`selection-reused/dropped` occur only for process scope); `Runtime::frozenOf(unit)` for telemetry tags. (An earlier iteration made the process pin the default for the chat unit's experiment freeze; experimentation is out of scope, so the default went back to per VM.)
15. **A failed pin may re-decide only in a CLEAN VM** (found in review of the freeze work and fixed, with a regression scenario that fails without the fix): when a patch's entry module throws after its modules registered, the VM is poisoned and Metro will not let embedded code override those registrations; until the VM is replaced a second request fails fast and evaluates nothing.
   - **Open:** under `pin=process`, a newer patch that supersedes the frozen one makes cache GC delete the old file, so the freeze drops at the next VM; if a unit needs a recreated VM to keep the *old* version, GC must retain the frozen file and the drop rule changes. Under `pin=process`, an embedded freeze caused by a prewarmed embedded host stays embedded after the host swap even if the patch became eligible. The freeze map is per unit and per process, so several coexisting VMs would need a per-VM key. Whether the vm-scope `selection-frozen` event (emitted at each load) is too noisy for telemetry is undecided.

**Not yet covered:** real-thread behaviour of the `Worker` (serialised in the tests), real `Http`/`Store`/`VmController`/`EmbeddedAssets`, Ed25519 verification, mmap-based file mapping, pausing the refresh timer in the background, and the entry-point table feeding `setEntryPointPriority`.

**Open [DECIDE]s:** `hostSettleMs`, `unitBudgetMs`, the cellular size cap, K for the crash guard, how entry points are declared (a static native table unit -> surface name, so the SDK can prefetch for visible entry points), and key rotation policy.

### 5.9 Device spike results (Android: RN 0.78.3 bridgeless/Fabric, Hermes HBC 96, debug build, arm64 emulator API 33)

`examples/spike-app` is a hybrid app (native Kotlin first screen, RN surfaces opened on demand, `ReactHost` created lazily). I re-ran the agent's APK on a freshly booted emulator with a fresh install: **S1-S10 all PASS** (`OTA_SPIKE SUMMARY pass=10 fail=0`). Caveats: debug build, emulator (swiftshader), not a physical device, not a release build; S2/S7/S10 use `ReactHost.reload()` on a long-lived host rather than a cold process start; the units are tiny (1.5-3.3 KB), so large-unit behaviour is unmeasured.

**Questions answered on Android:**
| Question | Result |
|---|---|
| Does an aligned, mmap'd `.hbc` evaluate via `jsi::Runtime::evaluateJavaScript` on the JS thread? | **Yes** (S3, S8). Unit evaluated after the host in the same runtime, entry run, surface rendered. |
| Does a wrong bytecode version fail safely? | **Yes.** With our pre-check bypassed, Hermes throws `Compiling JS failed: Wrong bytecode version. Expected 96 but got 98` and nothing executes (S4). Text JS, truncated and misaligned inputs are rejected by the pre-checks; the text unit's side effect never ran. |
| Can a throwing entry module be handled without crashing? | **Yes, but only via `__otaRequire`** (see below) (S5). |
| Is the per-VM pin real (a second definition of a loaded unit is ignored)? | **Yes** (S6): v2 evaluated into a VM holding v1 returns Ok but `units.cabs` stays `v1`. |
| Stale runtime handles after a reload? | The `JavaScriptContextHolder` of the old context returns 0 after reload (detectable); the new context has a new holder and a different `jsi::Runtime` address (S7). The pointer from the holder differs from the `&rt` seen inside `invokeAsync`: use the holder only for lifetime/identity checks, always use the `rt` passed to the callback. |
| Can a host swap happen in-process? | **Yes** (S2, S10) with `ReactHost.reload()` provided the host was built with a *dynamic* `JSBundleLoader` that is re-asked on reload. **`DefaultReactHost.getDefaultReactHost` caches the host statically, so it cannot swap bundles:** the glue builds `ReactHostImpl` directly with `DefaultReactHostDelegate` and its own loader. A swap with no surfaces mounted boots from the patched host and clears loaded-unit state, then units load again. |
| `import()` path through `__loadBundleAsync`? | **Yes** (S9) via a plain legacy `ReactContextBaseJavaModule` `NativeOtaUnits.load(name)`, working under bridgeless interop. |
| `CallInvoker` access without the `@FrameworkAPI` opt-in? | The holder is passed as `Object` to JNI, so no opt-in was needed. |

**New requirements found by the spike (now part of the design):**
1. **Entry modules must be run through a host-provided `__otaRequire(id)`, not Metro's `__r`.** `__r` catches an exception in a module factory and calls `ErrorUtils.reportFatalError`, which crashes a release app and never throws to the loader. `__otaRequire` hides `ErrorUtils` for the call so the exception propagates and the loader gets a `RequireError`. It must be defined by the host bundle (an SDK-provided pre-module); `shared/ota_unit_jsi.h` now prefers it and falls back to `__r`. Verified on Android (debug); also exercised in a Node `vm`.
2. **Entry ids are 48-bit numbers** and must be passed as a `double`.
3. **The first RN surface did not render until `ReactHost.onHostResume(activity)` was called:** the glue must call it for each activity that hosts a surface.
4. **Build environment:** Homebrew's broken `ccache` (missing libfmt) is auto-used by RN's CMake; build with ccache off `PATH` and delete `app/.cxx` if it was cached.

**Timing (warm, 3.3 KB cabs unit, emulator):** map 0.02 ms, check + sha256 0.08 ms, evaluate 0.02-0.04 ms, entry require 0.06-0.10 ms; with thread hops ~0.75 ms total. Cold page cache: map 8.6 ms, evaluate 1.5 ms, require 3.3 ms. The host file is 860,712 B. These are emulator numbers for a tiny unit: the point is that the loader path adds well under 1 ms when warm; real devices and bigger units need measurement.

**iOS (compiled, NOT run):** the same spike exists under `examples/spike-app/ios/` (UIKit native first screen, lazy `RCTReactNativeFactory`, ObjC++ glue, S1-S10 runner). `pod install` and the app target build for the iPhone Simulator SDK (arm64, Debug; the build logs show `BUILD SUCCEEDED`), but no simulator runtime is installed on this machine, so **no iOS test has run**. API facts learned from the 0.78.3 sources while building (they refine docs/research/rn-0.78-loader.md): the factory's delegate `bundleURL` is re-read on start and on every `RCTHost` reload; `[RCTBridge currentBridge]` is an `RCTBridgeProxy` (an `NSProxy`) and `currentBridge` is declared in `RCTBridge+Private.h`; `runtime` / `jsCallInvoker` are not declared on `RCTBridge` (a category declares them), so the selectors are undeclared and may change; `reload` is in `RCTHost+Internal.h`; creating a host without a surface works with `[rootViewFactory createReactHost:nil]` after `RCTEnableTurboModuleInterop(YES)` and `RCTEnableTurboModuleInteropBridgeProxy(YES)`; `RCTHost` has no explicit destroy (drop the host and the factory; the factory holds its delegate weakly, so keep the delegate strongly). The iOS glue also runs the entry through `__otaRequire` in a second JS-thread task. Build-environment fixes needed on Xcode 26: the fmt pod shipped with RN 0.78.3 fails to compile (consteval), so the Podfile `post_install` patches `FMT_USE_CONSTEVAL` to 0; `pod install` needs `--repo-update` the first time; the storyboard launch screen is replaced by `UILaunchScreen`; the workspace-level `xcodebuild -destination 'generic/platform=iOS Simulator'` fails without an installed runtime, so the agent built with `-project`/`-target` (commands in `ios/SPIKE_IOS.md`). **Unverified on iOS:** every test result, whether `NativeOtaUnits` is visible to JS under interop, whether `RCTHost reload` picks up a changed bundle URL, whether Hermes accepts the mmap'd bytecode, and the S9 `accessibilityActivate` tap path.

**Real RN 0.78.3 host: bundler results (`examples/spike-app/JS_FINDINGS.md`, android/ios, Hermes `-O -g0`):** host 490/486 modules, JS 2.22 MB, hbc 860,712/854,756 B, zstd 348,781/346,568 B; each unit 2-4 modules, 1.5-3.3 KB hbc. The splitter worked unchanged on the real graph for `import()`, `paths`, inline requires, InitializeCore and polyfills (all stay in the host). 48-bit id collisions: 0 on the real ~500-module graph (a synthetic run over all 14,570 `node_modules` files gave 3 collisions at 24 bits, 0 at 32+). `verify-repro` passes on both platforms (byte-identical, including a copy in another directory with different TZ/LANG). Metro + hermesc takes ~5-7 s per platform. The splitter needed fixes for: a cached `loadConfig` (second build in one process skipped `withOtaUnits`), the `require.js` polyfill resolving from the splitter's own `metro-runtime` (its directory must be watched), symlinked `node_modules` (Metro needs real copies), and a `blockList` for `ios/Pods` and Android build dirs.

**Patch sizes on the real RN host (zstd-19 HDiffPatch):** one-line unit change 80 B; new function in a unit 825 B; numeric-literal edit in host app code or in an RN file 85 B; **a string-literal edit in host app code 22-35 KB (6-10% of the zstd host)**, and an RN message-string edit 652 B-2.7 KB. The jump for host string edits is Hermes string-table renumbering (verified, see 5.10) and largely disappears with `-base-bytecode`. Consequence: host patches are cheap for logic/number changes and expensive for string changes; size limits for the host should assume tens of KB.

**Assets are an unresolved gap:** an image is an ordinary module (`registerAsset(...)`) owned by the unit, but its bytes are in no bundle. A patch can only reference assets that already exist in the binary (Android resolves a drawable name derived from the path; iOS a bundle path). **New Tier 1 rule (to implement): every asset module in a patched unit must exist in the base build with the same path and hash; otherwise the patch fails verify** (units.json already lists `assets` with path and sha256). Shipping new assets OTA is out of scope for v1.

### 5.10 Why bytecode diffs jump, and the fix (`native/measure-rn078/STRING_TABLE.md`, 99-cell matrix, Hermes at commit a942ef37)

**Mechanism (read from the Hermes source at the pinned commit and confirmed with bytecode dumps):**
- Hermes does **not** number strings by first use. At the end of compilation it re-sorts the whole string set (identifier-reference frequency windows, then kind, then alphabetical), and under `-O` a suffix-overlap packer lays out the string storage globally. A string's ID is its final position in that order.
- So adding, removing or changing **one** string moves a large share of the others: 0.7-91% of string IDs shift (typically 40-90%), and 27-76% of function bodies change although their instruction text is identical (they reference the shifted IDs). Function IDs follow source order, so inserting a function renumbers every later one.
- The cost is **bimodal and unpredictable from the edit**: a typo fix is either ~85 B or several KB. The floor is ~85 B (header source hash, file length, footer SHA-1 always change).

**Cost with the plain recipe (median, zstd-19 HDiffPatch):** numeric edit 85 B at every size; one string reworded/added/removed: ~0.6 KB for a 30 KB unit (4% of the compressed unit), ~6.5 KB for a 300 KB unit (6%), ~42 KB for the 860 KB RN host (12%); a new function: 2.5-3.5 KB / ~11 KB / 47-49 KB. The full-file fallback was never cheaper than the patch in any of the 99 cells (worst cell 24.7% of full). **Units are not a problem; the host is.** I re-measured 12 random same-length string edits on the real spike-app host independently: plain 17-48 KB (median ~33 KB).

**The fix, build-time only: `hermesc -base-bytecode=<base.hbc>` (Hermes "delta optimizing mode", in the pinned hermesc).** Existing strings keep their IDs and new ones are appended. Output is ordinary HBC v96, so **nothing changes on the device** (same loader, same apply code). Median string edit: ~0.2 KB (30 KB unit), ~0.5 KB (300 KB), ~0.9 KB (host); independently re-measured on the real host: 0.7-1.7 KB over the same 12 edits (~35x smaller). A new function appended as a new module at the end: 0.45 / 0.9 / 2.1 KB.
- **Verified here:** deterministic (two builds identical); the delta patch round-trips byte-identically through `ota_apply`; a program with edited, inserted and removed strings and an inserted function printed identical output under the Hermes 0.78.3 runtime for plain and delta builds; a wrong-version base fails cleanly; function disassembly matched the plain build in all 33 checks.
- **Verified on the Android emulator (spike tests S11-S15, re-run independently: `pass=15 fail=0`; debug build, API 33 arm64, not a phone):** a delta-built patched unit loaded FIRST in a fresh VM runs as v2 (`CABS:v2`; file hash differs from the embedded one); a delta-built patched host (new function and strings) boots and its new function returns the expected value, then a unit loads on top of it; **the on-device apply works**: otacore `applyPatch` (HDiffPatch + zstd decoder, built with the NDK for arm64 and x86_64) turns the embedded unit/host plus the `.hdiff` into a file whose sha256 equals the expected built hash and the delta-built file, which then loads and runs (cabs: 139 B patch -> 3,340 B, 39.6 ms cold, peak RSS +336 kB on the emulator; host 860 KB: ~162 ms, +340 kB; emulator numbers are not phone numbers); corrupt, truncated and wrong-hash patches are rejected with `PatchCorrupt`/`HashMismatch`, leave no output file and leave a pre-existing output untouched. **S16-S18 (re-run independently, `pass=18 fail=0`) answer 'does a unit patch force a host patch?': no.** A unit edit that adds a new function, new strings, changes an existing string and adds a new module (`cabs` v3, delta-built) ran in a fresh VM on the **embedded, untouched host**: the host file hash was identical to the embedded one before and after loading (and identical between the base and v3 builds), the new function returned its expected value, and the same held when the unit was produced by the on-device apply (patch 886 B delta-built vs 1,557 B plain-built; 3,328 -> 4,012 B; ~13-24 ms apply, +48-88 kB). **A realistic unit size (S18, `biglib`, 262,568 B of bytecode from lodash + dayjs + semver + ajv and their dependencies, through the real splitter/ota-build):** hash check ~5-6 ms, evaluate ~0.1 ms, entry require 27-71 ms (this is module initialization, not our loader), a one-string-edit patch of 426 B (delta-built) vs 2,919 B (plain-built) applied in ~13 ms with +0.8 MB peak RSS, and the built unit loaded and ran. Emulator numbers; the large `require` time is dominated by what the libraries do at import, which is why units should keep import-time work small (docs/guides/writing-a-unit.md). Gotchas found building S18: a transitive package not listed in a unit's `roots` stays host-owned (the unit then fails with 'Requiring unknown module': list the full dependency closure or add the package to the host); the splitter only sees units that a host `import()` reaches. Still unverified: a physical device, a release build, iOS. On the spike's host edit (a new function plus strings) the patch was 48.7 KB plain versus 5.5 KB delta (~9x); the 0.7-1.7 KB figure is for pure string edits. For a 3 KB unit plain (80 B) beats delta (139 B), which is why the production policy ships tiny units as `full`.
- **Costs and rules:** (1) the delta base is always the **embedded** bundle (never a previous patch), which matches how patches are defined; (2) the patch build needs the base `.hbc` **bytes**, so the base release job must archive them next to `base.json` (today only hashes are stored: planned port extension; `ota-build archive-base`); (3) delta output is slightly larger than plain (it keeps base strings: +12 B on the host); (4) unchanged files must stay byte-identical to the base or the one-unit rule breaks (being checked in the pipeline integration).

**Other mitigations measured:** append new code at the end (2-3x in delta mode, 5-25% in plain); `-O0` cuts string-edit cost but makes the base 68% bigger (no); `-g1`/`-fstrip-function-names` don't help; moving UI copy into one `JSON.parse` string makes a reword cost ~261 B in plain mode (delta mode makes placement nearly irrelevant); server-driven copy costs nothing; zstd `-l 19 -m 4` is fine (lzma is 4-16% smaller on plain cells: not worth a second decoder); with delta mode 30 mixed edits stay at 7-14% of full, with plain mode 10 edits already reach 16-30%.
**A bytecode-aware diff (ID remapping with an on-device inverse transform) is not worth building:** beyond delta mode it only helps for mid-unit function insertions (0.7-1.6 KB), which appending avoids.
**Calibrate size limits as ratios of the zstd-compressed full file** (suggested soft 15% / hard 40%, to be tuned on real units) and monitor: patch/full ratio, string IDs moved, functions with a new index, delta/plain ratio. **Caveats:** library-code corpus, one machine, hermesc 0.78.3 only, 3 positions per cell, synthetic regex edits.

## 6. Manifest and CDN

```
<cdn>/<platform>/<app-version>/
    manifest.json                  # ONE file served to clients (canonical JSON)
    manifest.json.sig              # detached signature over the exact bytes of manifest.json
    <patchId>.<hash12>.<platform>.patch   # immutable artifacts as written by the deploy job (packages/ota-cli/src/job.ts); hash12 = first 12 hex of sha256 of the patch file.
                                   # (ota-build names its own build output `<unit>.<platform>.<base12>-<new12>.(delta|full).hdiff`; the deploy job renames on upload)
```

The served `manifest.json` (per platform and app version) **is the deployable state**: it is stored as a versioned, immutable artifact in the CI artifact store, and every command (`ota-deploy`, `ota-rollout`) produces the next version of it and deploys it (section 7.1). There is no separate state file in git.

```json
{
  "schema": 1,
  "patchAlgoVer": "v1",
  "version": 42,                     // monotonic; replay/downgrade protection
  "ttlSec": 120,
  "mainBundle": {
    "baseHash": "sha256:...",
    "entries": [
      { "id": "host-pr88", "patchUrl": "...", "hash": "sha256:<built result>", "size": 118000,
        "updateType": "patch", "range": [0.0, 0.05] }
    ]
  },
  "units": [
    { "unitName": "cabs", "baseHash": "sha256:...",
      "entries": [
        { "id": "cabs-pr1234", "patchUrl": "...", "hash": "sha256:<built result>", "size": 41200,
          "updateType": "patch", "range": [0.00, 0.20],
          "requiresHost": null },            // optional; e.g. "host-pr88" for a coupled release (5.5)
        { "id": "cabs-pr1201", "patchUrl": "...", "hash": "sha256:<built result>", "size": 39800,
          "updateType": "patch", "range": [0.20, 0.50] }
      ] }
  ]
}
```

- **Signature is detached and covers the exact bytes served:** the CDN serves `manifest.json` (canonical JSON: sorted keys, no whitespace) and `manifest.json.sig` (base64 Ed25519 over those bytes). Devices verify the received bytes, then parse; they never need to canonicalize JSON, which keeps the native verifiers trivial. The manifest carries `platform` and `appVersion` inside the signed bytes so a signature cannot be replayed across platforms or app versions.
- **Patch id = `<unit>-pr<N>`**, where N is the `ota-deployments` PR number that pinned it: unique, human-readable, the same for both platforms, and it links straight to the PR thread (approvals, verify output, ramp history). Identity of the *bytes* is separate: each entry carries `hash` (sha256 of the built result, verified on device) and the artifact file name includes a content hash. The id is a label for commands, analytics and the ladder; the hash is what guarantees integrity. (A hash of the diff as the id would also work technically, but it differs per platform and per app version, is unreadable on dashboards, and doesn't link to the PR. MD5 is fine as a quick reference checksum but not for integrity; use sha256.)
- **Entry without `range` = 100% of devices** (the flat `{unitName, patchUrl, id}` form is the degenerate case).
- **Why ranges are needed:** a single static manifest is identical for all clients, so percentage rollout must be decided on the device from its stable bucket; otherwise the manifest would have to be generated per request.
- `patchAlgoVer` lives in the manifest as a sanity check: the algorithm itself is in the binary, so a new algorithm implies a new binary and a new app-version path.
- **Rollout invariant:** ranges of one unit's entries are disjoint (sum <= 1). Unassigned range = embedded.
- **Bucketing:** `bucket = hash(deviceId + unitName) -> [0,1)`, computed once, stable. Raising a rollout extends a contiguous range.
- **Ladder allocation (N entries; convention is 2 active, see 7.6):** `[0,x) newest | [x,y) previous | [y,1) embedded`. Ramping the newest takes buckets from the previous one (users move forward only); at 100% the previous is retired.
- **Rollback = redeploy an earlier state:** `ota-rollout 0` on the bad patch, or a restore of manifest artifact version K (published as a new version N+1 with K's content, since `version` must stay monotonic); users return to what they had.
- **New patch starts at 0%** (what `ota-deploy` does).
- **Halt (kill) = `ota-rollout 0`**, which removes the entry (or sets its range to `[0,0]`). There is no separate `halted` flag. Effective after `ttlSec` (keep 1-5 min) and the next sync, with the VM caveat in 5.3.
- **One fetch, one consistent snapshot** (not per-unit manifests): the client makes a single conditional GET at start; unit patches are separate, content-addressed downloads.

## 7. Release process

### 7.0 Principles of the workflow
- The `release` branch stays strictly gated and is **not used for patches**. The embedded base is whatever shipped from it (identified by its tag and recorded hashes).
- A patch is a **commit on a per-unit, per-version OTA branch** in the monorepo, **pinned** by a PR in the separate `ota-deployments` repo. The pin PR proves the candidate is valid (verify); an **approval by the unit's owner** (not the requester) authorizes the deploy; the deploy and each ramp are commands requested by PR comment.
- One PR = one unit = one app version.
- Supported targets: the **latest 3 release lines** (e.g. 11.9.x, 11.8.x, 11.7.x). A fix for two lines is two branches and two PRs (a backport helper script can come later).

### 7.1 Repos, branches and files

**Monorepo (code):** branch `ota/<unit>/<version>`, e.g. `ota/travelplex/11.9.0`, cut from the release tag of that version (so it starts byte-identical to the embedded base).
- Protected by branch-name pattern: PR review required (CODEOWNERS by the unit's source roots, i.e. the unit's team), unit tests and lint required. **Code review happens here.**
- Developers merge their fix PRs into this branch as usual.

**`ota-deployments` repo (pins only):**
```
units.json                         # per unit: owner GitHub team (= approvers), Jira project keys, size-limit overrides
CODEOWNERS                         # /*/travelplex.json  @org/ota-travelplex ; /*/host.json  @org/ota-super-admin ; ...  (generated from units.json)
<version>/                         # e.g. 11.9.0/
    <unit>.json                    # HUMAN, via PR:  { "branch": "ota/cabs/11.9.0", "sha": "<commit>" }
```
**CI artifact store (state; written only by Jenkins jobs):**
```
ota-base/<version>/base.json       # written by the base release job: pinned toolchain image digest, release tag, the hash of every embedded unit/host bundle per platform
                                   # (sha256; md5 may be stored alongside for reference), extracted from the shipped APK/IPA, plus the `hermesc` sha256 and HBC bytecode version; plus a "retired" flag when the line leaves the live window
ota-patches/<hash>                 # immutable patch binaries
ota-state/<version>/v<N>/          # THE STATE: immutable, versioned bundle
    android/manifest.json          #   exact bytes as served to clients
    android/manifest.json.sig      #   detached Ed25519 signature over those bytes
    ios/manifest.json
    ios/manifest.json.sig
    audit.json                     #   who/what produced this version: command, requester, approver, Jira ticket, PR, previous version, source SHA, job URL
```
- **Pin vs state:** the **pin** says *which commit we intend to ship*: human-authored, reviewed, in git. The **state** says *what is actually published and at what percentage*: machine-written, in the artifact store, and it is literally the manifest that gets deployed. A PR comment like `ota-rollout 10` changes no file in git, so the percentage lives in the next `ota-state` version.
- **Every command runs the same deploy job** (the only holder of KMS signing and CDN write credentials), under a **lock per app version**:
  1. fetch the latest `ota-state/<version>/vN`;
  2. apply the change (add a patch at 0%, change a range, remove an entry, or restore an earlier version);
  3. validate integrity (schema, disjoint ranges, `baseHash` against `base.json`, `version` = N+1, provenance of any new patch);
  4. sign, upload as `v(N+1)` (never overwrite), then deploy both platforms' manifests to the CDN and purge the cache.
  A periodic reconcile job redeploys the latest state if the CDN is behind it (e.g. the CDN step failed after the upload).
- The pin is platform-neutral; both platforms are built from the same SHA. Rollout ranges are per platform inside the manifests.
- Patch binaries are **not** in git; they live in the artifact store (and on the CDN), keyed by hash.
- A version is **live** if its `base.json` exists and its release line is among the latest 3; the base release job sets `retired` when a line leaves the window (no new pins accepted; halt still works).
- **Retention:** `ota-state`, `ota-base` and referenced `ota-patches` for live versions must be exempt from the artifact store's cleanup policy; keep at least the last K state versions per app version for restore. The served manifests on the CDN are also a recoverable copy of the latest state.

### 7.2 Flow

1. **Fix** merged into `ota/<unit>/<version>` in the monorepo (normal reviewed PR).
2. **Propose:** the developer runs the helper script (`ota propose <unit> <version>`), which opens a PR in `ota-deployments` changing exactly `<version>/<unit>.json` to the branch HEAD SHA. The PR title must start with the Jira ticket key, e.g. `TLX-1244: fix empty-state crash`.
3. **Verify** (Jenkins, required status; section 7.3). Builds, checks, posts a report on the PR (changed unit, patch hashes and sizes per platform, warnings). **The verify build output is discarded**; only the report (with hashes) is kept.
4. **Review and merge:** the pin PR needs one approving review from the unit's owner team (CODEOWNERS; GitHub does not let the author approve their own PR) plus a green verify. Merging a pin changes nothing for users by itself; the deploy approval in step 5 is a separate, second gate.
5. **`ota-deploy`** (PR comment on the merged PR, by anyone): Jenkins creates a **Jira deploy ticket** linked to the PR and recording the pinned SHA. The unit's owner approves it in Jira (existing approval flow); the **approver must be a member of the unit's owner team and must not be the requester**. On approval, the deploy job **builds again** (the existing CI does a fresh build in the submit step), requires the resulting hashes to equal those recorded in the verify report (a mismatch aborts loudly; it also acts as a continuous reproducibility check), stores the patches, and produces the next `ota-state` version with the new patch at **0%** and deploys it (7.1).
6. **`ota-rollout <percent> [android|ios]`** (PR comment, by anyone): creates a Jira ticket with the same approval rule (owner approves, never the requester). **Every ramp needs approval**; on approval the deploy job produces the next `ota-state` version with the new range and deploys it.
7. **`ota-rollout 0` (halt) needs no approval** and may be requested by anyone with repo access: it can only reduce exposure, and an incident should not wait in an approval queue. A ticket is created automatically afterward for the record.
8. Everything for the patch (verify report, deploy, each ramp and halt, with requester and approver) is linked from one PR thread; the `audit.json` chain across `ota-state` versions is the machine-readable audit trail.

**Command authorization:**
- **Anyone can request; owners approve.** The approver must be in the unit's owner team (`units.json`, GitHub team synced from SSO; `host` requires the super-admin team) and must not be the requester. Jira workflow enforces "approver is not reporter"; the Jenkins job re-checks both rules via the Jira and GitHub APIs before acting.
- `ota-deploy` tickets are bound to the pinned SHA; the job refuses to run if the pin on main has changed since the request, or if the PR's pin is not the one currently on main (a stale PR can't deploy something that was since replaced).
- Ramp-up is accepted only for the **latest deployed patch** of that unit and version. Halt is accepted for any of that unit's patches.
- Commands extend the existing `deploy` comment mechanism and the existing Jira approval flow; no new approval system.

### 7.3 Verify checks (required status on the PR; integrity and authorization)

| Check | Why |
|-------|-----|
| PR has **exactly one commit** and changes **exactly one file**, a `<version>/<unit>.json` for a live app version | one unit per PR; keeps history clean |
| *(deferred; off unless `enforceJira`)* PR title starts with a Jira key whose **project is mapped to that unit** in `units.json` (e.g. TLX -> travelplex, BR -> bus and rails). The check calls the Jira API: ticket exists and is in an acceptable status [DECIDE which], not just a regex | authorization and traceability |
| `branch` matches `ota/<unit>/<version>`, `sha` exists on that branch and descends from the version's release tag, and the branch is protected | patch comes from reviewed code, not an arbitrary branch |
| Build at `sha` in the **pinned toolchain image** for that version: Tier 1 rules all pass; **only this unit's artifact differs from base** (host and every other unit byte-identical to the hashes in `base.json`) | one-unit rule; no accidental host or cross-unit changes |
| Patches generated for both platforms; **size soft limit -> warning on the PR; hard limit -> check fails** (section 4) | bounded downloads |
| Verify output records the patch hashes; `ota-deploy` rebuilds and must match them (verify artifacts themselves are discarded) | what was verified is what is deployed |

**How this answers "what if the branch has a host change, multiple unit changes, or a too-large patch":** any artifact other than the claimed unit differing from base fails the check, so such a branch can't be deployed as is; the developer splits the change into separate branches (one per unit). The `host` unit is itself a unit with its own pin file and stricter ownership. Oversized patches warn, then block.

**Deliberately not enforced (best practices, see 7.6):** ramp step sizes, minimum soak time, starting percentage beyond the 0% default of `ota-deploy`, number of active patches. These can become checks later if experience shows the need.

### 7.4 Host unit (Common-owned), designed now, shipped Phase 2
Same flow with `<version>/host.json`; command approval restricted to the super-admin team; stricter size limits; slower ramp convention (1/5/25/50/100 with longer holds). Extra rules:
- **Export-surface rule:** a host patch may change module bodies but must keep every module ID and export that units import. Verify diffs the export surface against base and fails on removal or rename. This is what lets host patches and unit patches compose without coordination.
- **Startup path differs:** the host loads before JS runs, so the native side picks the host from disk at VM creation (5.4), with the boot guard falling back to the embedded host.
- Until then, host bugs wait for the train; reduce exposure by putting risky host behavior behind remote flags.

### 7.5 Native dot releases (11.9.0 -> 11.9.1)
**Decision: treat a dot release as its own app version** (own `<version>/` directory, own `manifest.json` path, own embedded bundle, own rollouts). It is the simplest option and stays correct, because the client checks `baseHash` and a patch only ever applies to the exact unit bytes it was built against.
- The 11.9.1 binary is built from the release branch, which already includes whatever was merged to it; its embedded units are therefore newer, and OTA patches for 11.9.0 do not apply to it (different `baseHash`). Nothing needs to be done for those units.
- **Reuse, not rebuild (optional tooling):** if a unit's base hash is identical in 11.9.0 and 11.9.1 (unit untouched), the deploy job can reference the same patch artifact (same hash) in the 11.9.1 manifest, with its own independent range.
- Builds are keyed by `(unit, baseHash)`, so dot releases do not multiply CI work.
- A "release line" for the live-version limit (3) is `major.minor`; all dot releases of a line are live together.
- Users updating from the store (11.9.0 -> 11.9.1) get the new embedded bundle and the old cache root is deleted automatically (section 5.1).

### 7.6 Best practices (conventions, not enforced)
Published in the `ota-deployments` README; the helper scripts print them as hints.
1. **Start small.** `ota-deploy` puts a patch at 0%; then internal allowlist, then 1-5%, then step up (e.g. 5 -> 25 -> 50 -> 100).
2. **Soak between steps** long enough for your traffic to produce a signal in your own analytics. Low-traffic LoBs soak longer or use bigger steps with a human check.
3. **Watch your own dashboards** at every step, tagged by `unit` and `patchId` (see 9). Halt first, investigate after.
4. **Keep patches small and focused.** Read the soft-limit warning seriously.
5. **At most two active patches** per unit (current + previous); retire old patches once the new one reaches 100%.
6. **No peak-hour ramps** for large LoBs; avoid ramping when nobody can watch.
7. **Say why** in the PR thread for every ramp and halt (it is your audit trail).
8. **Halt is cheap; use it.** Rolling back to embedded is always safe.
9. **Smoke test before ramping past internal:** each LoB agrees its own checklist on a patched build.

If the same mistake happens twice, add a check for it (7.3) instead of another guideline.

### 7.7 Platform mapping (GitHub Enterprise without Actions + Jenkins + Jira)
| Need | Implementation |
|------|----------------|
| Verify checks | Jenkins PR job on `ota-deployments`, posting a commit status (required in branch protection) and a PR comment with the report |
| Commands (`ota-deploy`, `ota-rollout`) | GitHub webhook on PR comments -> Jenkins (the existing `deploy` comment mechanism, extended); Jenkins creates the Jira ticket; approval in Jira triggers the job; the job re-checks approver is in the unit's team and is not the requester |
| Ownership | GitHub teams synced from SSO; `units.json` maps unit -> owner team (approvers) and Jira project keys; CODEOWNERS on pin files gives the pin-PR review |
| Patch branches | Branch protection by name pattern `ota/**` (PR reviews, required status checks) |
| Jira | Jenkins calls the Jira API in verify (ticket exists, status, project key) |
| State store | CI artifact store: versioned, immutable `ota-state/<version>/vN`; only the deploy job's Jenkins credentials can write it |
| Deploy job | Jenkins job triggered by approved Jira tickets (deploy, ramp, halt, restore). Takes a lock per app version, applies the change to the latest state, validates, signs with KMS, uploads the next version, deploys to the CDN, purges the cache. The only holder of KMS signing and CDN write credentials. A scheduled reconcile run redeploys the latest state if the CDN lags |
| Provenance | The deploy job records source SHA, Jenkins job URL and patch hash in `audit.json` and signs the state with a Jenkins-held KMS key; the next deploy verifies the signature of the state it reads |
| Break-glass | If Jira, GitHub or Jenkins is down, a super-admin can run the deploy job manually (or the underlying script) with a "restore vK" or "remove entry" command, bypassing the ticket; the action is recorded in `audit.json` |

**Halt path:** `ota-rollout 0` is the incident fast path: one comment, no approval. LoB alerting can call the same Jenkins job with a token.

**Costs:** every action goes through GitHub comments, Jenkins, Jira and the artifact store (latency; a halt is a few minutes from comment to CDN plus the manifest TTL); every patch is built twice (verify, then again at deploy, as in today's CI), which needs Jenkins capacity and caching; builds must be reproducible byte for byte; rollout history lives in artifact versions and Jira instead of git (no `git revert`; restore is an explicit command); the artifact store becomes a critical dependency (retention exemption, backups); a compromised pin merge can't ship anything without an owner's Jira approval and a matching rebuild.

### 7.8 Build and patch creation pipeline (what CI produces and how the manifest inputs are made)

**Step 1: bundle** (per platform; deterministic): Metro (splitter) -> `host.js` + `units/<unit>.js` + `ids.json` + `units.json`; then `hermesc` per file with the reproducible recipe (5.7: `-O -emit-binary -g0`, fixed relative name, pinned compiler) -> `host.hbc`, `units/<unit>.hbc`. Output `build.json`:
```json
{ "schema": 1, "platform": "android", "appVersion": "11.9.0", "sourceSha": "<commit>",
  "toolchain": { "rn": "0.78.3", "metro": "0.81.5", "hermescSha256": "sha256:...", "hbcVersion": 96, "hermescFlags": "-O -emit-binary -g0" },
  "host":  { "file": "host.hbc", "hash": "sha256:...", "size": 123, "zstdSize": 45 },
  "units": { "cabs": { "file": "units/cabs.hbc", "hash": "sha256:...", "size": 123, "zstdSize": 45, "entryModuleId": 281474976710655 } },
  "ids": { "file": "ids.json", "hash": "sha256:..." } }
```
The **base release** produces this once; its hashes become `base.json` (verified against the files extracted from the shipped APK/IPA). The embedded `host.hbc` and `units/*.hbc` are what ships in the binary.

**Step 2: patch** (`new` build vs `base` build): for each unit (and host) whose hash differs:
- artifact = HDiffPatch "single compressed diff", zstd (`patchAlgoVer` `v1`), fixed parameters recorded in the tool; old = the base `.hbc`, new = the new `.hbc`;
- **round-trip verification is mandatory**: apply the patch with the *same C++ code the app ships* (`otacore::applyPatch`) to the base file and require `sha256(result) == new.hash`; a patch that does not round-trip is never emitted;
- **`full` fallback:** if `patchSize > 0.6 x zstdSize(new)`, emit `updateType: "full"`, which is the same diff format computed against an *empty* old file (so the device uses the same apply code, no second decoder);
- patch bytes need not be reproducible; the **built hash** must be (the deploy job compares built hashes recorded at verify with those rebuilt at deploy);
- output `patch-report.json`: per platform `{ base: <hash of base build.json>, new: <hash>, hostChanged, changedUnits: [..], items: [{ unit, patchFile, patchSize, updateType, builtHash, baseHash, ratioOfZstdFull }] }`. This is the input of the verify checks (`changedUnits`, `hostChanged`, sizes) and of `ota deploy` (patch file + built hash per platform).

**Step 3: deploy** (approved ticket, or locally in tests): `ota deploy` takes the patch files and built hashes from `patch-report.json` and produces the next state version (7.1).

**Per-platform builds and deploys:** Metro builds each platform separately (platform-specific files like `Foo.android.js` and `Platform.OS` make the bundles differ), so `build.json`, patches and reports exist per platform. A change that touches only an `.android.js` file leaves the iOS bytes identical, so that unit has a patch on Android only: `deploy` takes a patch for each *affected* platform (with its own `updateType`), the other platform's manifest simply gets no entry, and rollout/halt default to the platforms where the patch exists (state versions stay shared by both manifests). The one-unit rule is checked per platform.

**Rules unchanged:** exactly one unit may differ from base for a unit PR; the host may differ only for the host unit; sizes are checked against the soft/hard limits using `ratioOfZstdFull`.

**Pin PR helper (script only, not wired):** `node tools/ota-propose.mjs <unit> <version> --monorepo <path> --deployments <path> [--ticket KEY] [--title TEXT]` writes `<version>/<unit>.json` into a checkout of the deployments repo with the current `ota/<unit>/<version>` branch head, and only **prints** the `git` / `gh pr create` commands; nothing is committed or opened for you.

## 8. Client safety

- Verify manifest signature, patch hash, and post-apply unit hash; any mismatch -> discard, use embedded.
- **Health confirmation:** a patched unit counts as confirmed after it mounts and runs N seconds without a crash.
- **Crash-loop guard:** K crashes in a patched unit before confirmation -> blacklist that patch locally, fall back to embedded, report.
- Keep at most 1 patch per unit on disk; delete on app update (new binary has new embedded base).
- The SDK emits lifecycle events (download, apply, load, confirm, rollback) and exposes the active `unit`/`patchId` for LoBs to tag their own analytics (see 9). CodePush does not collect telemetry itself.

## 9. Monitoring and halting: owned by LoBs, outside this system

- **Detection is not part of CodePush.** Each LoB already has product analytics and alerting and owns judging whether its patch is healthy. We do not build metrics ingestion, cohort comparison, or auto-halt.
- **What CodePush provides so LoBs can do it:**
  1. **Attribution:** the SDK exposes `getActivePatch(unit) -> {patchId, hash, source: embedded|patch}` and a global listener, so LoBs attach `unit`, `patchId`, `appVersion` to their own analytics and crash-reporting events (e.g. as a custom dimension/tag).
  2. **Lifecycle callbacks:** `onApplied`, `onConfirmed`, `onRolledBack(reason)`, `onFailed(reason)` for LoBs/host to forward into their own pipelines.
  3. **Control via PR comments (see 7.2):** `ota-rollout <percent>` and `ota-rollout 0` (halt) per patch. LoB alerting (webhook, runbook, or script) can trigger the same Jenkins job. Anyone can request; the unit's owner team approves (never the requester), except halts. The PR thread, Jira tickets and the `ota-state` audit chain are the audit trail.
- **Local safety stays in the SDK** (needs no analytics): hash/signature verification, confirm-after-mount, crash-loop guard falling back to embedded.
- **Process expectation (not enforced by tooling):** LoB admin watches their dashboards during each ramp step before moving to the next; ramp-up is always a manual action.

## 10. Security
- Manifests and patches signed in CI (key in KMS), public key embedded in binary; HTTPS; hash verification at every step.
- Monotonic manifest `version` to prevent downgrade/replay.
- Admin actions are PR comments approved in Jira: authenticated via SSO, approver restricted to the unit's owner team and never the requester, protected by branch protection and required checks. Provenance (artifact built by Jenkins from a pinned SHA on a protected `ota/` branch and verified in a merged PR) prevents shipping an unreviewed binary. The deploy job and its KMS signing identity are the only writers to the CDN and the state store.
- Store policy: JS and assets only.

## 11. Trade-offs

| | |
|---|---|
| **+** Simple: static files, client-side bucketing, no live service | |
| **+** No coordination or central dependency for patches; one PR = one unit = one owner team | |
| **+** Patch vs embedded: stateless, deterministic | |
| **+** Builds on existing mechanisms (PR comments, Jenkins, CODEOWNERS, Jira) | |
| **+** Rules push LoBs toward good design | |
| **-** Build complexity (deterministic IDs, unit rules, reproducible builds, per-version fan-out) | |
| **-** Two-pass fetch; first-use latency unless prefetched | |
| **-** Non-compliant LoBs get nothing until cleaned up | |
| **-** Host fixes and cross-LoB changes still ride the train | |
| **-** Manifest TTL bounds kill latency | |
| **-** Backports are one PR per version | |
| **-** Patch size grows over the month as the branch diverges from base | |

## 12. Roadmap

| Phase | Scope | Exit |
|-------|-------|------|
| 0 | **Spikes:** (a) split the real bundle with Metro into host + LoB units with deterministic module IDs (expected to be easy), with Travelplex first, and report Tier 1/2 violations per LoB; (b) **reproducible builds**: run `tools/repro_check.py` on a release tag (fresh checkouts at different paths, perturbed env/timestamps) and compare against the stored hashes of the shipped bundles; same source and pinned image must give byte-identical HBC, otherwise "only one unit differs" can't work; (c) HDiffPatch sizes on real branch divergence for host and units, with compression options, vs. compressed full bundle as a baseline, to set soft/hard limits; (d) on-device apply time and peak memory on a low-end Android and an older iPhone; (e) the client framework spike in 5.6 D (Metro split, `__loadBundleAsync`, native evaluate, patched host boot) | Per-LoB compliance report; reproducibility result; patch size and apply-time numbers; chosen compression and limits |
| 1 | Build tooling (unit split, rules, patch builder), native loader + `lazyUnit`, `ota-deployments` repo with verify job, `ota-deploy` / `ota-rollout` commands, `ota propose` script, deploy job (state artifacts, signing, CDN), SDK safety (confirm, crash loop), one **pilot unit (Travelplex)** | Pilot unit ships a patch to prod with a halt drill |
| 2 | All compliant LoBs onboarded, attribution hooks documented for LoBs, host-fix lane, Jira integration polish, backport helper | Every compliant LoB can self-serve patches via PRs |
| 3 | Reduce train: earlier freeze, smaller P4; track compliance | Train overhead measurably down |
| 4 | Cleanup program driven by compliance report; optional later: build from main with host-export check | More LoBs patchable |

## 13. Open questions

**Resolved**
- Pilot: Travelplex (chatbot). Phase 0 lists its static imports to migrate and any native modules it needs in the host; any entry into it must go through `lazyUnit('travelplex')`.
- Rule strictness: Tier 1 and Tier 2 hard fail, Tier 3 warn; no singleton list (host = everything outside units; dependencies must resolve to host at the same version).
- Concurrent patches: manifest/client support N via ladder; convention of at most 2 active, not enforced.
- Live versions: latest 3 release lines; dot releases are their own app version.
- Host lane: designed now (export-surface rule), shipped Phase 2.
- Monitoring and auto-halt: LoB-owned; we provide attribution, callbacks, and `ota-rollout`.
- Single build: today one bundle contains all LoBs; npm modules link into the monorepo.
- Auth and audit: SSO groups -> GitHub teams (`units.json`), Jira approvals (owner approves, never the requester), PR threads and the `ota-state` audit chain.
- Repo: separate `ota-deployments`; sharded per unit; pin files human-edited and reviewed by the unit's owner team. State is the deployable manifest, stored as a versioned artifact in the CI artifact store.
- Every ramp needs approval (halt does not).
- Naming: "unit". Patch algorithm: HDiffPatch (`v1`), compression tuned in Phase 0. Size limits: soft warn, hard block.
- Pin PR creation: developers, with a helper script. Verify build output is discarded; deploy rebuilds and compares hashes.
- Commands: anyone can request, unit owner approves, approver is not the requester; halt needs no approval.

**Open**
1. Reproducible builds (Phase 0b): can the pinned toolchain image produce byte-identical Metro and Hermes output? This gates the one-unit verify check. **Plan:** (i) run `tools/repro_check.py` twice-over on the release tag; (ii) fix sources of non-determinism (absolute paths, timestamps, debug IDs, parallel ordering, env); (iii) make the base release job store the hash of each embedded bundle in `base.json`, extracted from the shipped APK/IPA, and run the same reproducibility check as a gate before a base release is accepted; (iv) a "no-op pin" of the release tag itself must verify with zero differences.
2. Soft and hard size limit values: calibrate on real app units (prototype numbers in 5.7: a 5%-of-modules edit is ~6% of the uncompressed unit), and whether to use bytes, ratio, or both (proposed: both).
3. Jira: which ticket statuses are acceptable at verify, and does the project-key-to-unit map need to support multiple keys per unit (yes in `units.json`)?
4. Halt latency target: working target is comment to CDN within ~5 minutes plus manifest TTL (1-5 min). Measure in Phase 1.
5. Confirm with the platform team: Jenkins can post commit statuses to GitHub Enterprise, receive PR-comment webhooks, call the Jira API, open PRs through a bot account, and use SSO-backed teams; branch-name-pattern protection is available.
6. How many RN VMs does the app run (preloaded VM, one per surface)? The recreate logic and view counting depend on it; assumed one VM. What does the lifecycle manager do today (when does it destroy the VM)?
7. Per-unit fetch budget default (1s?) and loader UI (skeleton or spinner). The one open [DECIDE] in 5.4 (recreate at the next zero-views moment).
8. `ota-rollout` with a platform argument: is per-platform rollout needed, or both platforms always together?
9. CI artifact store capabilities: immutability or create-if-absent semantics, retention exemption for `ota-*`, access control (only the deploy job writes), and whether a lock per app version in Jenkins is enough to serialize writes.
10. App's RN version, architecture mode (new architecture / bridgeless?), Metro version, and whether it is bare RN or Expo: these decide the loader API (5.6 C) and serializer hooks (5.6 A).
