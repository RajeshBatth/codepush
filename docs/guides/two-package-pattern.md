# The two-package pattern

**Purpose:** show how a LoB with always-on code (init, config, shared state) splits into a stable public host-owned package and a patchable private unit package, using `examples/two-package-app` as the worked example.
**Audience:** LoB engineers (Travelplex-like) and reviewers of public API changes.
**Source of truth:** `examples/two-package-app/` (`units.config.json`, `api/travelplex-core.api.json`, `src/host/index.js`, `node_modules/@travelplex/{core,ui}`), `packages/unit-splitter/test/two-package.test.js`, [DESIGN.md 4.1](../../DESIGN.md).

Principle: **the package boundary is the patch boundary.** What is in the binary (public, host-owned) changes only with an app release or the host lane. What is OTA-patchable (private, the unit) can change any time. Background: [01-units-and-ownership](../architecture/01-units-and-ownership.md), rules in [rules-catalog](../reference/rules-catalog.md).

## 1. When to use it

Use it when LoB code must run outside the unit or be consumed statically by the rest of the app: websocket init, fetch-config, singleton session state, a shared module other LoBs import. If everything can live inside the unit and be opened only via an entry point, use a plain unit ([splitting-a-lob-into-a-unit](splitting-a-lob-into-a-unit.md)).

## 2. The worked example

```
examples/two-package-app/
  units.config.json            checks.publicPackages + publicApiSnapshot; unit roots = the PRIVATE package
  api/travelplex-core.api.json committed public API snapshot
  src/host/index.js            host entry: calls init() once, exposes the "app"
  node_modules/@travelplex/core   PUBLIC  (host-owned)  index.js init.js config.js session.js shell.js internal/secret.js
  node_modules/@travelplex/ui     PRIVATE (the unit)    entry.js screens/Home.js screens/Inbox.js
```

`units.config.json` (verbatim):
```json
{
  "checks": {
    "publicPackages": ["@travelplex/core"],
    "publicApiSnapshot": { "@travelplex/core": "api/travelplex-core.api.json" }
  },
  "units": [
    { "name": "travelplex", "roots": ["@travelplex/ui"], "entry": "@travelplex/ui" }
  ]
}
```

| Piece | File | Role |
|---|---|---|
| Public entry | `@travelplex/core/index.js` | Re-exports the API: `init`, `getConfig`, `getSession`, `getUnreadCount`, `markRead`, `onEvent`, `TravelplexEntry`. Comment: removing or renaming a name fails `public-api-breaking`. |
| Initializer | `core/init.js` | `init()` is idempotent and never throws; failure is recorded on the session. Starts the (stand-in) socket and fetches config. |
| Thin shell | `core/shell.js` | `lazyUnit('travelplex', () => import('@travelplex/ui'))` is the only reach into the unit. `TravelplexEntry(props, onState)` reports loading/error/ready states. No business logic. |
| Unit entry | `@travelplex/ui/entry.js` | Imports `getSession` from `@travelplex/core` (same module instance as the host), registers the component name, exports `render`. |
| Host entry | `src/host/index.js` | `init()` once at boot; calls `TravelplexEntry`. |

`package.json` of the public package lists the unit package as an optional peer dependency (`peerDependencies: {"@travelplex/ui": "^1.0.0"}` in the example; DESIGN says optional) and the app installs both.

## 3. Dependency directions (all already enforced)

- host / other LoBs -> public package: static import, allowed.
- unit -> public package: a unit -> host edge, allowed, same instance, so session/connection state is shared.
- public package -> unit: only through the shell's `lazyUnit` + `import()` of the entry. A static import is `host-to-unit-static`. The cycle this creates (shell imports unit, unit imports core) is by design and produces no warning (test "lazyUnit-boundary cycle ... NO cycle-async warning").

## 4. What the unit may rely on

A unit patch is built against the base host of each live app version, so it can only use public API that already shipped in that binary:

- `host-export-missing`: every named/default/namespace-member import the unit takes from a host module must exist in that module's runtime exports (base and patch mode).
- `public-deep-import`: units import the public package only through its entry or paths listed in its `exports`; `@travelplex/core/internal/secret` is rejected (test "deep-imports ... internal/secret").
- The same unit change may verify for the latest version and fail for an older one; patches are built per live version.

## 5. Keeping the public package stable

1. **Additive-only API.** The snapshot records the sorted runtime export names and default flag of the entry. Removing or renaming fails (`public-api-breaking`, build and patch mode). Adding warns (`public-api-changed`; error with `publicApiStrict: true`).
2. **Create/update the snapshot:**
   ```
   node packages/unit-splitter/src/cli.js api-snapshot --project examples/two-package-app           # print
   node packages/unit-splitter/src/cli.js api-snapshot --project examples/two-package-app --write   # write to the configured path
   ```
   It refuses to write if the entry is not statically analyzable (`public-api-opaque`).
3. **Thin by construction:** transport, state and the loader shell in core; UI, flows and copy in the unit. Tunable behavior comes from fetched config; the unit must tolerate missing or extra config fields.
4. **No UI logic in the shell** beyond loading/error/retry.

| Change | Lane |
|---|---|
| UI, flows, copy, validations in the unit | unit patch (OTA) |
| ws-init / fetch-config bug, transport or state change | host lane (rare, Phase 2: **planned**) or the train |
| New public API plus UI using it | train (coupled release); later UI-only changes are OTA again |
| Config-driven behavior | remote config |

## 6. Runtime contract of `init()`

Proven in the build harness (`two-package.test.js`): `init()` runs exactly once per VM at host boot, before any unit opens, and not again when the unit opens; a failed init does not throw and the shell shows an error state; a UI-only unit patch changes only the unit artifact and the host stays byte-identical. A host swap or lifecycle destroy recreates the VM and runs `init()` again, so the core must reconnect cleanly. If the connection must exist before any VM or survive VM recreation, native code owns it ([DESIGN.md 4.1](../../DESIGN.md)).

## 7. Analyzer limits to know

The export analyzer reads ESM and Babel/tsc CJS. Opaque entries (`module.exports = fn()`, computed names) give `host-export-unknown` warnings, or `public-api-opaque` errors when a snapshot exists. Namespace imports are checked only for `ns.member`; `export {x} from './y'` does not verify `x` exists in `./y`. See [rules-catalog A3](../reference/rules-catalog.md) and `packages/unit-splitter/README.md`.

## 8. Adoption checklist

1. Create the public package (host-owned): API in its entry, `init()`, config fetch, thin shell with the single `lazyUnit` site.
2. Create the private package; `roots` and `entry` = the package name in `units.config.json`.
3. Add `publicPackages` and `publicApiSnapshot`; run `api-snapshot --write`; commit the snapshot.
4. Call `init()` once from the host entry.
5. Build; fix `public-*` and `host-export-*` findings; add the snapshot check to review for the public package (CODEOWNERS on `api/*.json` is a suggestion, not implemented).
