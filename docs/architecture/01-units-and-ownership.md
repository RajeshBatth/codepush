# Units and ownership

**Purpose:** define what a unit is, how ownership is decided, which import directions are legal, and how the two-package pattern and initializers fit.
**Audience:** engineers declaring or reviewing units; AI assistants answering "who owns this module / may A import B".
**Source of truth:** `packages/unit-splitter/src/{config,analyze,ids,build}.js`, `examples/{demo-app,two-package-app}`, tests `unit-splitter/test/{rules,checks,two-package,initializer}.test.js`; rationale in [DESIGN.md 4 and 4.1](../../DESIGN.md).

Terms are defined in [glossary.md](../glossary.md). Every rule id mentioned here is in [rules-catalog.md](../reference/rules-catalog.md).

## 1. What a unit is

A **unit** is an independently patchable slice of the app: one per declared LoB (for example `cabs`, `travelplex`) plus the special unit **`host`**, whose artifact is the `mainBundle`. In the build output each unit is one file `units/<name>.js` containing only `__d(...)` module definitions; the host file `host.js` carries the Metro runtime, polyfills, the entry and all non-unit modules (`unitsJson.host.file`, `build.js`).

One Metro run produces one dependency graph; the splitter partitions it. Partitioning one graph (not separate builds) guarantees consistent module ids and no duplicates ([ADR index](decisions/README.md); [02-build-and-patch-pipeline](02-build-and-patch-pipeline.md)).

## 2. Ownership: by path/package, not by reachability

Implemented in `ownerOf(absPath, units)` (`config.js`):

1. A module belongs to unit U iff its real path is under one of U's declared **roots**.
2. Everything else is **host**, including all third-party packages, shared libraries and Common code. So the host also contains libraries used by a single LoB.
3. A root is a project-relative directory or an npm package name. A package root owns the package's own files but **not** its nested `node_modules` (those stay host).
4. Roots are `realpath`ed because Metro reports symlink-resolved paths; otherwise a symlinked unit would silently fall into the host. Verified for a real copy in `node_modules`, a symlink into the project and a symlink outside the project (`checks.test.js` "ownership by package name").
5. Roots of different units must be disjoint; build fails with `unit roots not disjoint`.
6. Module keys (what ids hash) are project-relative paths; outside the project they are `node_modules/<path after last node_modules>`; package roots outside the project use `node_modules/<pkg>/...` (`pathKey` in `ids.js`). Ids are 48-bit hashes of the key (12 hex chars; collisions fail the build). Therefore a patched unit resolves host modules exactly like the embedded base.

Patch mode only (`--base`): a package reached from a unit that the base host does not contain, and that is pure JS (no `ios/`, `android/`, podspec, `codegenConfig`), is **claimed by the unit** and bundled into it; a native-looking one fails (`native-package`).

Consequences accepted by design: shared code is patchable only through the host lane or the train; upgrading a library requires the same ([DESIGN.md 4](../../DESIGN.md)).

## 3. Direction rules

```
            +---------------------+
            |        host         |   (everything not under a unit root)
            +---------------------+
              |  ^           ^   ^
 import() of  |  | static    |   | static (unit -> host)
 the ENTRY    |  | forbidden |   |
 only, via    v  |           |   |
 lazyUnit   +-------+     +-------+
            | unit A|     | unit B|      unit -> other unit: forbidden
            +-------+     +-------+
```

| Edge | Allowed? | Rule id when violated |
|---|---|---|
| unit -> own modules | yes | |
| unit -> host module | yes (same module instance as the host's) | patch mode: `package-version-mismatch`, `missing-in-base-host`; always: `host-export-missing` |
| host -> unit entry via plain async `import()` | yes (only the declared `entry`) | `host-imports-non-entry` |
| host -> unit via static import, `require()`, `export ... from`, barrel re-export | no | `host-to-unit-static` |
| unit -> other unit (static or `import()`) | no | `unit-to-unit` |
| host `lazyUnit('x', () => import(<entry of y>))` | name must match | `lazyUnit-name-mismatch` |
| unit entry imported from more than one host site | warns | `multiple-import-sites` |

Cycles: inside one unit or first-party host code, `cycle` (ratchet via baseline); a cycle closed only by the intended `lazyUnit` boundary is counted (`lazyUnitBoundaryCycles`) but never reported. Boundary-crossing cycles are otherwise impossible by construction.

## 4. Declaring a unit

Minimum: an entry file and a root. See [splitting-a-lob-into-a-unit](../guides/splitting-a-lob-into-a-unit.md) and [config-reference](../reference/config-reference.md). Declaring a LoB is the opt-in; passing the base-build checks (Tier 2) is the entry requirement. A LoB that cannot pass simply stays undeclared (host, not patchable). The governance side (owner team, Jira keys, size limits) lives in the `ota-deployments` repo ([config-reference 2](../reference/config-reference.md)); a cross-check between the two lists is **planned**.

The **entry** is the one module the host may `import()`. With `checks.requireRegisterComponent: true` it must call `AppRegistry.registerComponent('<unitName>', ...)` because native entry points mount that component name ([05-client-runtime](05-client-runtime.md)).

## 5. The two-package pattern

When a LoB has code that must run outside its unit or that the rest of the app consumes statically (socket init, config fetch, shared state), ship two npm packages: a **public** host-owned package and a **private** package that is the unit. Full guide: [two-package-pattern](../guides/two-package-pattern.md). Summary:

| | Public package (e.g. `@travelplex/core`) | Private package = unit (`@travelplex/ui`) |
|---|---|---|
| Owner | host (not under any unit root) | the unit (`roots: ["@travelplex/ui"]`) |
| Changes via | app release / host lane | unit patch |
| Guarded by | `publicPackages`, `publicApiSnapshot`, `public-*` rules | all unit rules |

The unit may only use public API that already shipped in the binary: `host-export-missing` and `public-deep-import` enforce it, and a patch is built against the base host of each live app version.

## 6. Initializers (import-time side effects)

Evaluating a unit file only registers modules (`__d`); nothing runs. The unit's **entry module is required once per VM** by the loader (through `__otaRequire`, see [05-client-runtime](05-client-runtime.md)), and that is when import-time code in the unit runs (`initializer.test.js`):

- booting the host runs no unit initializer;
- initializers run during the entry `require`, in import order, once per VM (the loader pins a unit per VM; a second `openUnit` does not re-run them);
- an initializer that throws makes the load fail with a require error, not a crash.

Code that must run **before** any unit opens (a socket the native first page needs) must live in the host or public package and be started from the host entry, not in a unit. If it must exist before any VM, native code owns it ([DESIGN.md 4.1](../../DESIGN.md)). Eager units (evaluated at VM boot) are **planned**/not part of v1.

## 7. Where this is enforced and tested

| Concern | Code | Tests |
|---|---|---|
| Ownership, roots, entries | `config.js` | `rules.test.js`, `checks.test.js` (package-name ownership) |
| Direction/encapsulation | `analyze.js` | `rules.test.js`, `checks.test.js` C2 |
| Host API / public API | `public-api.js`, `exports.js` | `two-package.test.js` |
| Patch-mode dependency rules | `analyze.js` (base) | `rules.test.js` (iii) |
| "Only one unit differs" | `diff.js` `diffAgainstBase`; `verify.ts` `only-one-unit` | `rules.test.js`, `ota-core/test/governance.test.ts` |
