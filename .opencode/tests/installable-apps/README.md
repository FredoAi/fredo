# installable-apps — fixtures & generators

Three **independent, deterministic, Node-built-ins-only** generators produce every package this
suite's live rows consume. They are deliberately separate files so they never contend on a
lock, a temp dir or a helper module: each one can be run, re-run and reviewed on its own.

> **Nothing here ships.** These scripts and the packages they emit are test scaffolding. No
> product code under `apps/ui` or `apps/tauri` imports, reads or depends on anything in this
> directory.

| Generator | Owner | Emits |
|---|---|---|
| `fixtures/build-package-fixtures.mjs` | **ST-2** | the seven install-validation packages — valid, no-manifest, bad-manifest, zip-slip, hash-tamper, `engines.fredo`-incompatible, reserved-`__fredo/` — plus its committed expected-output manifest naming each id and the refusal code it drives |
| `fixtures/build-behaviour-fixtures.mjs` | **ST-7** | the five behaviour apps (+ one optional variant) + `behaviour-fixtures.expected.json` |
| `fixtures/build-capability-fixtures.mjs` | **QA Expert (#3146)** | **eleven capability packages** (ten capability packages + the `qa3146-mirror-control` negative control). **Every openable one is SELF-DRIVING** — see §6 |

Both write to a gitignored output directory under `.opencode/tmp/3147/fixtures/` and print the
output directory plus every produced file name and its sha256.

---

## 1. Running the generators

From the repo root:

```powershell
# ST-7 — the behaviour fixtures (this document's own deliverable)
node .opencode/tests/installable-apps/fixtures/build-behaviour-fixtures.mjs
node .opencode/tests/installable-apps/fixtures/build-behaviour-fixtures.mjs --verify
node .opencode/tests/installable-apps/fixtures/build-behaviour-fixtures.mjs --out .opencode/tmp/3147/fixtures/behaviour-b
node .opencode/tests/installable-apps/fixtures/build-behaviour-fixtures.mjs --write-expected
node .opencode/tests/installable-apps/fixtures/build-behaviour-fixtures.mjs --help
```

```powershell
# ST-2 — the install-validation packages
node .opencode/tests/installable-apps/fixtures/build-package-fixtures.mjs
```

> ST-2's generator lands with ST-2. If it is not in the tree yet, that command exits with
> `MODULE_NOT_FOUND` — the file is genuinely absent, not broken. ST-7 does not create or edit it
> (the two generators are deliberately independent so neither can break the other).

`--verify` re-builds every archive in memory and compares its sha256 against the committed
expected-output manifest, exiting non-zero on any drift. `--write-expected` regenerates that
manifest — run it only when a fixture change is intentional, and commit the result in the same
change so the tester's ids/hashes and the bytes can never disagree.

Both generators use **only** `node:fs`, `node:path`, `node:crypto` (and `node:url` for the
script's own location). No network, no npm package, no toolchain, no shell-out. They must run on
a bare checkout with nothing installed.

### Determinism

Running either generator twice produces **byte-identical** archives. The mechanism:

- zip entries are emitted in a **fixed order** (`fredo-app.json`, then each file `entry` names);
- every entry carries the **fixed DOS timestamp 1980-01-01 00:00:00** (`dosTime 0x0000`,
  `dosDate 0x0021`) — the earliest representable DOS date, i.e. a zip with no wall-clock time;
- entries are **stored** (method 0, no deflate stream), so the payload bytes are a pure function
  of the input;
- nothing in a fixture body is generated from the clock or from randomness **at build time**. The
  per-run values a fixture needs (a mount stamp, a probe uuid) are produced inside the child
  document at mount time, never here.

Compare the printed `sha256` column across two runs, or diff `Get-FileHash` on the produced
`.zip` files. A build that is not reproducible is a fixture defect, not a cosmetic detail: the
suite pins ids and hashes from the committed expected-output manifests.

### Self-checks the generator runs on EVERY build (not opt-in)

Before a single file is written the generator validates every manifest against the plan's schema
(`manifestVersion === 1`, the `id` regex and 96-char cap, `displayName` 1–64, SemVer 2.0.0 with no
`v` prefix, a non-empty `engines.fredo` range, relative POSIX `entry` paths ending `.html`/`.js`
with no `..`). After building, it re-opens each archive and asserts:

- the EOCD count, central-directory size and offset are consistent;
- every central-directory entry's name/size/CRC agrees with what was written;
- the `fredo-app.json` inside the archive round-trips to the object it meant to write;
- `index.html` exists, is non-empty and is an HTML document;
- `main.js` exists and exports `mount` (the crash-on-import variant asserts the opposite: it must
  **not** export `mount`, because it throws while evaluating).

Any failure aborts the build with a non-zero exit code. A generator whose gate has never run is
not evidence, so these checks run on the default path rather than behind a flag.

---

## 2. The package format (fixed by the plan — consume it, do not invent it)

A package is a **zip** with `fredo-app.json` at the archive **root** plus the files its `entry`
points at.

```json
{
  "manifestVersion": 1,
  "id": "qa3147-lazy-trace",
  "displayName": "QA3147 Lazy Trace",
  "version": "1.0.0",
  "engines": { "fredo": ">=0.0.0" },
  "entry": { "document": "index.html", "module": "main.js" },
  "description": "…"
}
```

| Field | Rule |
|---|---|
| `manifestVersion` | number, exactly `1` |
| `id` | `^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$`, ≤ 96 chars |
| `displayName` | string, 1–64 chars |
| `version` | SemVer 2.0.0, no `v` prefix |
| `engines.fredo` | a semver **RANGE** string (e.g. `>=0.0.0`) |
| `entry.document` | relative POSIX path ending `.html`, no `..` |
| `entry.module` | relative POSIX path ending `.js`, no `..` |
| `description` | optional, string ≤ 280 chars |
| `__fredo/` | a path segment named `__fredo/` is **reserved** |

### The child document contract

The document is served by the **host's** scheme handler, which the fixture does not own. The host:

1. serves `entry.document` and injects its own bootstrap and its theme `<style>`;
2. sets `window.__FREDO_INSTALLED__ = { appId, version, theme }`;
3. has already written the theme tokens as CSS custom properties on `document.documentElement`;
4. creates the root element `[data-testid="installed-app-root"]` (also a named region
   `aria-label={displayName}`) — this is `ctx.root`;
5. fetches `entry.module` and calls its exported `mount(ctx)`.

```ts
mount(ctx: InstalledAppContext): void | Promise<void>

InstalledAppContext = {
  appId: string;
  version: string;
  theme: FredoThemeTokens;   // { tokens: readonly {name, value}[]; colorScheme: 'light' | 'dark' }
  root: HTMLElement;         // [data-testid="installed-app-root"]
}
```

There is deliberately **no `unmount`** — closing the window destroys the document, and that
destruction *is* the stop. Fixture modules are plain ESM (`export function mount(ctx) { … }`) with
no bundler, no framework and **no bundled Tauri API**.

### DOM hooks the fixture must NOT duplicate

The host bootstrap owns these, and the fixture renders only *inside* `ctx.root`:

`[data-testid="installed-app-loading"]` · `[data-testid="installed-app-failure"]` ·
`[data-testid="installed-app-failure-reason"]` · `[data-testid="installed-app-retry"]`.

A fixture that renders its own copy of any of them would make the host's failure/loading rows
unreadable, so the generated documents deliberately contain no such markup.

---

## 3. The behaviour fixtures (`build-behaviour-fixtures.mjs`, ST-7)

Five required apps plus one optional variant. Every id, displayName, byte size and sha256 is
committed in **`fixtures/behaviour-fixtures.expected.json`** — read them from there, never from
memory.

### `qa3147-probe` — AC-2 / R-2.2 / F-2.2 (the refusal proof)

On `mount` it attempts **two real shipped commands** and records the caught outcome on the DOM:

1. `save_control_setting` with `{ key: 'qa3147-probe-child-<uuid>', value: 'probe-sentinel' }`
   (a pre-existing command with an observable side effect);
2. `installed_apps_list` (a shipped installed-app command).

**The invoke path is a claim confirmed at implementation, not an assumption.** The child bundles
no Tauri API and `withGlobalTauri` is `false`, so the module resolves a mechanism through an
explicit ladder, first hit wins, and **records which one it used**:

| # | Mechanism | Meaning |
|---|---|---|
| 1 | `window.__TAURI_INTERNALS__.invoke` | the handle the shipped frontend itself uses |
| 2 | `window.__TAURI__.core.invoke` | only present when `withGlobalTauri` is true |
| 3 | raw wire `POST http://ipc.localhost/<cmd>` | last resort: reproduce the init script's request |
| — | none reachable | recorded as **`no-invoke-mechanism`** |

**Expectation, recorded here as an expectation and NOT as an assumption:** `withGlobalTauri:
false` only suppresses the bundled `window.__TAURI__` JS-API object. Tauri's init script is still
injected into every webview it creates — including the `WebviewUrl::External` window this feature
opens — and that script defines `__TAURI_INTERNALS__`. So mechanism **1** is the expected hit and
the refusal should then be an ACL/authority denial from the command gate (which is precisely the
AC-2 proof). Mechanism 3 exists because a wrong expectation must not silently degrade into an
untested claim: if 1 and 2 are both absent, the probe still issues a real request and records the
endpoint's actual answer.

DOM it renders (all inside `ctx.root`):

| Hook | Content |
|---|---|
| `[data-probe-mechanism]` | which mechanism resolved (`handle` / `global-handle` / `wire`) |
| `[data-probe-result]` | `mechanism=<id> \| <cmd>=rejected (<Name>); <cmd>=rejected (<Name>)` |
| `[data-probe-error]` | the caught error's **name and message text, verbatim** (one line per call) |
| `[data-probe-outcome]` | `all-rejected` \| `all-resolved` \| `mixed` \| `no-invoke-mechanism` |
| `[data-probe-state]` | `pending` → `settled` |
| `[data-probe-child-key]` | the exact key passed to `save_control_setting` |
| `[data-probe-host-key]` | a suggested control key for the host-side non-vacuity leg |
| `[data-probe-log]` | an append-only trace of the whole attempt |

`[data-probe-error]` is the AC-2 **discrimination evidence**: it lets the tester tell an
ACL/authority *"not allowed"* refusal (the desired proof) from a transport/CSP failure (a probe
defect). The fixture also exposes the child key so the host can prove **no side effect exists**
(`get_control_setting` → `null`) while a same-round host control key reads back.

**If no invoke mechanism is reachable at all**, the fixture records `no-invoke-mechanism` on
`[data-probe-result]` and stops. That is a *stronger structural isolation fact*, but it is a
**different** fact from a refusal: report it to the Orchestrator, never substitute it for a
refusal observation.

Mount resolves synchronously and the probe runs on a floating continuation, so a hanging
transport can never be mistaken for a mount-timeout failure (R-4.2's signal stays clean). Poll
`[data-probe-state]`.

### `qa3147-lazy-trace` — R-5.1 / R-5.3 / R-5.4 / F-5.1 / F-5.3 / F-5.4

`mount` stamps the mount on `ctx.root`:

- `[data-mounted-at]` — an ISO 8601 timestamp (**the discriminator**);
- `[data-mount-ms]` — the same instant as epoch milliseconds;
- `[data-mount-id]` — a random per-document id.

`data-mounted-at` can only exist **after a first open** — there is no child document before that
to carry it — which is exactly why it proves laziness. A re-open is a *fresh document*, so all
three values change. It also renders `[data-installed-context]` (what it received in `ctx` and via
`window.__FREDO_INSTALLED__`) and `[data-theme-readout]` (the four theme custom properties read
with `getComputedStyle`).

### `qa3147-crash-on-load` — R-4.1 / F-4.1

Throws **synchronously from `mount`** and catches nothing — containment is the host's obligation,
so the fixture must not soften the failure. It marks `ctx.root` with `data-fixture="crash-on-load"`
immediately before throwing, so the failure is attributable. The host must render *its own*
`[data-testid="installed-app-failure"]` naming this app's `displayName`.

### `qa3147-crash-on-import` — OPTIONAL variant of the above

Throws during **module evaluation**, so the host's `import()` rejects and no `mount` export ever
exists. Use it when a round wants both throw shapes; the suite names `crash-on-load` as the
required one.

### `qa3147-hang-on-load` — R-4.2 / F-4.2 / R-5.2

`mount` returns a promise that **never settles** and schedules no work at all — zero CPU, zero
timers. The host's own watchdog (`INSTALLED_APP_MOUNT_TIMEOUT_MS = 10_000`) is therefore the only
thing that can end this load, which gives a stable ~10 s window in which R-5.2 can observe the
loading state and R-4.2 can measure the timeout. `ctx.root` is marked `data-fixture="hang-on-load"`.

### `qa3147-fail-once` — R-4.3 / F-4.3 (the retry leg)

**Throws on the first document load and mounts on the reload.** The lever is a counter in
`sessionStorage`:

```js
var previous = window.sessionStorage.getItem("qa3147-fail-once-loads"); // null on a fresh context
var loads = (Number(previous) || 0) + 1;
window.sessionStorage.setItem("qa3147-fail-once-loads", String(loads));
if (loads === 1) throw new Error("qa3147-fail-once: intentional failure on document load #1 …");
```

DOM: `[data-fail-once-load]` (`1` on the failing load, `2` on the recovery load),
`[data-fail-once-storage]` (`sessionStorage` or `unavailable`), `[data-mounted-at]` and
`[data-mount-id]` **on the recovery load only**, and `[data-fail-once-panel]`.

The two attributes exist so a **dead lever is diagnosable rather than silent**: if
`[data-fail-once-storage]` reads `unavailable`, the retry leg is an ARTIFACT defect to report —
never something to paper over with "the retry was attempted".

#### Verdict on the `sessionStorage` lever: **it holds**

Verified two ways, both reproducible:

1. **From the spec.** `sessionStorage` is scoped to the **top-level browsing context**, and
   `location.reload()` **reuses** that context — it does not create a new one. The reload
   re-runs the document's scripts (so in-memory module state is gone) but the browsing context,
   and therefore its `sessionStorage`, survives. A window **close** destroys the context and with
   it the storage. That is precisely the semantics this fixture needs: *first load in a window
   fails, every later load in the same window mounts*.
2. **By execution.** The emitted modules were executed against a minimal DOM shim that models
   exactly those semantics (one storage object shared across two "loads" of one window; a fresh
   storage object for a new window). Results: load 1 throws and records `data-fail-once-load=1`
   with no `data-mounted-at`; load 2 of the **same** context mounts and records
   `data-fail-once-load=2` with a stamp; a **new** context fails again on its load 1; and with
   storage stubbed to throw, the fixture reports `data-fail-once-storage=unavailable` and the
   first load still fails. The lever is the storage, not a coincidence.

Reproduce that run (scratch harness, not committed — it lives under `.opencode/tmp/`):

```powershell
node .opencode/tests/installable-apps/fixtures/build-behaviour-fixtures.mjs
node .opencode/tmp/3147/fixtures/exec-fixtures.mjs .opencode/tmp/3147/fixtures/behaviour
```

**One caveat the tester must honour:** the lever is per **browsing context**, so it is correct
only if the retry **reloads the same webview** rather than destroying and re-creating the window.
A retry that closes and re-opens the native window starts a new context, so load 1 fails again.
That is a property of the *host's* retry implementation, not of the fixture: if a retry clicks
"Try again" and the app fails a second time with `[data-fail-once-load]` back at `1`, report the
retry implementation, not the fixture.

---

## 4. The package fixtures (`build-package-fixtures.mjs`, ST-2)

Owned by **ST-2**. It emits the install-validation packages and its own committed
expected-output manifest, **`fixtures/package-fixtures.expected.json`**. Like the behaviour
generator it is Node-built-ins only (`node:crypto`, `node:fs`, `node:path`, `node:url`) plus
the kit's **published-schema** validator (`packages/fredo-authoring/lib/validate.mjs`, a pure
module), needs no network and no npm package, and is byte-deterministic across runs (fixed
entry order, stored entries, the same fixed 1980-01-01 DOS timestamp).

```powershell
node .opencode/tests/installable-apps/fixtures/build-package-fixtures.mjs
node .opencode/tests/installable-apps/fixtures/build-package-fixtures.mjs --verify
node .opencode/tests/installable-apps/fixtures/build-package-fixtures.mjs --out .opencode/tmp/3147/fixtures/packages-b
node .opencode/tests/installable-apps/fixtures/build-package-fixtures.mjs --write-expected
node .opencode/tests/installable-apps/fixtures/build-package-fixtures.mjs --help
```

### The eight packages

Read `id`, `expects`, `expectsStage` and the sha256 from
**`fixtures/package-fixtures.expected.json`**, never from this table. `expectsStage` matters:

| Fixture | `expects` | `expectsStage` | The defect it carries |
|---|---|---|---|
| `qa3147-valid` | _(none — installs)_ | `none (installs cleanly)` | none; the happy path (AC-1 / R-1.1) |
| `qa3147-no-manifest` | `no_manifest` | install | a valid zip with **no** `fredo-app.json` at its root |
| `qa3147-bad-manifest` | `manifest_unknown_field` | install | an **unknown top-level key** `sandbox` (shape recorded as `badManifestShape`) |
| `qa3147-zip-slip` | `unsafe_path` | install | an entry `../../qa3147-escaped.txt` (shape recorded as `unsafeShape`) |
| `qa3147-hash-tamper` | `integrity_mismatch` | **load** | none at install — the tester mutates one installed byte first |
| `qa3147-incompatible-engines` | `host_incompatible` | install | `engines.fredo: ">=999.0.0"` — well-formed but excludes every real build |
| `qa3147-reserved-path` | `reserved_path` | install | an entry `__fredo/bootstrap.js` claiming the host-reserved segment |
| `qa3145-missing-field` | `manifest_invalid_field` | install | the required top-level field **`displayName` is absent** (field recorded as `missingField`) |

**The bad-manifest shape is a choice, and the manifest records it — and it was WRONG until
#3145.** An unparseable document, an unknown top-level key and a non-`1` `manifestVersion`
drive **three different codes** (`manifest_malformed`, `manifest_unknown_field`,
`unsupported_manifest_version`). This generator ships the **unknown-top-level-key** shape, and
`badManifestShape` in the committed manifest says so.

**Drift correction D1 (Spec #3145 ST-2).** This fixture used to drive
`manifest_unknown_field` with the key **`capabilities`**. Spec #3146 made `capabilities` the
manifest's **8th legal top-level key**, so the same bytes now classify as
**`manifest_invalid_field`** ("capabilities must be an object" — the fixture set it to an
array). The fixture is now built with a genuinely-undefined key (`sandbox`), and the
hand-written schema copy that let the drift happen is **gone**: the allowed-key set, the
length caps, the patterns and the reserved-id list are read from
**`packages/fredo-authoring/schema/fredo-app.schema.json`**, which is generated from the Rust
parser. That is why the generator's self-check can catch this class again rather than
repeating it.

**The schema leg of `--verify`.** `--verify` now checks three things: the committed sha256s,
the recorded codes, **and** that every fixture whose expected code is decided by the manifest
classifies with the published schema as that exact code (every other fixture's manifest must be
schema-legal). A corpus that drifts from the parser therefore reddens even when its bytes did
not change.

**`hash-tamper` INSTALLS.** Its expected code is reached at LOAD time (the verify-at-serve step),
so a tester must (a) install it, (b) mutate the recorded byte, then (c) attempt to open it. An
install-time refusal from this package would itself be the defect. The mutation target and offset
are committed under `tamper` in the expected manifest:

```json
"tamper": { "file": "main.js", "offset": 3 }
```

Offset 3 lands inside `main.js`'s leading comment block, so flipping it changes only the hash, never
module semantics. Restoring the byte must make the app load again (the "block clears on the next
activation attempt" leg of T-4.4).

### Why the incompatible range is a fixed constant, not "the running version plus one"

The running version's SOURCE is the crate version (`env!("CARGO_PKG_VERSION")` in
`applications/installed_apps/mod.rs`). A generator that read the crate version to compute
"current + 1" would change its own bytes on a version bump and silently invalidate the committed
sha256s. `>=999.0.0` is well-formed, excludes every plausible build, and is stable.

### Self-checks the generator runs on EVERY build (not opt-in)

Before writing anything it asserts the catalog itself is coherent (22 frozen codes; every required
code driven by some fixture). After building it re-opens each archive and asserts:

- the entry order and names in the archive are exactly what was meant to write;
- `fredo-app.json`, when present, round-trips to the object written;
- the **bad-manifest** package carries **exactly** its declared unknown key — checked against the
  **published schema's** key set, never a hand-written list (a stale list is exactly how
  `capabilities` stayed "unknown" after #3146) — and the **missing-field** package really omits
  `displayName`;
- **every other** fixture's manifest is schema-legal per the published schema (with the engines
  range validated separately, because `>=999.0.0` is legal yet excludes the host);
- each declared extra entry drives the package's expected code, and **every ordinary entry name is
  safe** — so a fixture cannot be "unsafe by accident";
- `index.html` is a real HTML document and `main.js` exports `mount`;
- the tamper offset lies inside its target file.

Any failure aborts with a non-zero exit code. A generator whose gate has never run is not evidence,
so these run on the default path.

### The theme-parity fixtures (`theme-parity/build-theme-fixtures.mjs`, ST-1)

One generator entry emits the **four** theme fixtures, so the three "may not rely on" negatives
are the positive **plus exactly one host-internal import** and the scan and the load agree by
construction:

```powershell
node .opencode/tests/installable-apps/fixtures/theme-parity/build-theme-fixtures.mjs
node .opencode/tests/installable-apps/fixtures/theme-parity/build-theme-fixtures.mjs --check
```

| Package | What it is |
|---|---|
| `theme-parity/` | the positive: paints **only** published theme token names, mirrors every reading as plain visible text in `[data-testid="authoring-theme-readout"]` |
| `theme-parity-neg-shared-store/` | the positive + `import '@/shared/installed-apps/store'` |
| `theme-parity-neg-base-class/` | the positive + `import { FredoApplicationClass } from 'apps/ui/src/applications/FredoApplicationClass'` |
| `theme-parity-neg-register/` | the positive + `import { registerApplication } from '@/applications/registerApplication'` |

**The vendoring route is the point, not a workaround.** Each package carries
`vendor/fredo-theme/` — a COPY of `packages/fredo-theme/dist/` — and imports it
**relatively**. A published artifact is runtime-reachable only by being part of the installed
package: the `fredoapp` handler's serve whitelist is the install record, so a file outside the
package has no route, and a bare `@fredo/theme` specifier never resolves in the child document
(no bundler, no import map, `script-src 'self'`).

`--check` compares all twenty generated files against the committed copies (LF-normalised), so
the vendored copy cannot silently drift from `dist/`. The generator refuses to build unless the
readout hook, the mirrored token names, the alias chip painted from `cssVar('accent.subtle')`,
the relative-only imports and the one-line difference of each negative all hold.

### What the ST-2 install fixtures are NOT here to prove

Runtime behaviour — probe refusal, crash/hang containment, retry, laziness — belongs to the ST-7
behaviour fixtures (§3). These packages exist only to drive the **install / integrity** decision
matrix. The generated documents are minimal inert pages and the modules are minimal ESM `mount`
exports; nothing here duplicates a host-owned `installed-app-*` testid.

---

## 5. What is committed vs generated

| Path | Committed? | Notes |
|---|---|---|
| `fixtures/build-behaviour-fixtures.mjs` | **yes** | the generator |
| `fixtures/behaviour-fixtures.expected.json` | **yes** | the expected-output manifest (ids, displayNames, hashes, what each app asserts, the DOM hooks it renders) |
| `fixtures/build-package-fixtures.mjs` + its manifest | **yes** (ST-2) | the sibling generator |
| `fixtures/theme-parity/**` | **yes** (ST-1) | the theme-parity package and its three negatives, **generated** — including the vendored `vendor/fredo-theme/` copy — by `fixtures/theme-parity/build-theme-fixtures.mjs` |
| `fixtures/build-capability-fixtures.mjs` | **yes** (QA Expert, #3146) | the capability generator — self-driving fixtures, no hash manifest (§6) |
| `.opencode/tmp/3147/fixtures/**`, `.opencode/tmp/3146/fixtures/capabilities/**` | no (gitignored) | the generated `.zip` archives and per-run summaries |

The generated archives are deliberately **not** committed: they are reproducible byte-for-byte,
so a committed copy would only be a second source of truth that can drift from the generator.

---

## 6. The capability fixtures (#3146) — self-driving, with a rendered-text mirror

### Why they drive themselves

The installed window is **deliberately unreachable by every `tauri_webview_*` tool**. `execute_js`
*lands* (`window.eval` runs) but its **result channel** is ACL-denied inside the child — the injected
wrapper calls `window.__TAURI__.core.invoke('plugin:mcp-bridge|script_result', …)`, and the child has
neither `__TAURI__` (`withGlobalTauri:false`) nor a grant for that command. So `execute_js`,
`dom_snapshot`, `find_element`, `screenshot` and `console` all return
**`Request timeout after 2000ms`** against an `installed-*` windowId. That is not a bug to work
around — it is the isolation property under test working.

A fixture that waits to be driven therefore cannot be driven at all. So each openable package from
`build-capability-fixtures.mjs` runs its own **probe plan** on `mount` and mirrors every result as
**rendered text**. The tester reads that text with a capability-independent instrument: a **native
accessibility (UIA) text read** of the installed window's own a11y tree, corroborated by a **native
window capture**. No `execute_js` call is involved.

### The mirror grammar (stable — rows cite these strings)

| Node | Text |
|---|---|
| `[data-qa3146-header]` | `QA3146-FIXTURE app=<id> version=<v> capabilities=<set> tables=<csv> probes=<ids>` — **identical on every run**, so a reader asserts what it is looking at |
| `[data-qa3146-document]` | `QA3146-DOCUMENT app=<id> version=<v> ready=true mount=<id> loaded=<iso> origin=<origin>` |
| `[data-qa3146-theme]` | `QA3146-THEME theme.body-bg=… theme.card-bg=… theme.text-primary=… theme.accent-primary=… colorScheme=<light\|dark> mount=<id>` — re-published every second |
| `[data-qa3146-assertions]` | one `<p data-assertion="<id>">` per probe: `PASS <id> codes=<c1>,<c2> …` or `FAIL <id> codes=… <reason>` |
| `[data-qa3146-consent]` | `QA3146-CONSENT app=<id> mount=<id> state=<consent\|granted> query=<code>` (consent fixtures only; `state=none` otherwise) |
| `[data-refusal-code]` / `[data-refusal-json]` | the last refusal, as text |
| `[data-call-log]` | every call in drive order, JSON |
| `[data-qa3146-summary]` | `QA3146-SUMMARY calls=<n> rejected=<n> probes=<n> done=<true\|halted\|running>` |

`codes=` is **positional**: one entry per step in drive order, `ok` for a resolve and the refusal code
otherwise. Watch-generated lines (`consent` / `data` transitions) carry the `mount=` they were
observed at, so "no reload" is checkable.

### The plans

The probe plan is **data**, built by `probePlanFor(fixture)` and embedded in that fixture's `main.js`.
Rows bound:

| Fixture | Assertion ids it emits |
|---|---|
| `qa3146-app-a` | `F-7.5`, `F-7.6`, `F-7.7`, `F-7.8`, `F-7.9`, `F-7.10`, `F-7.13`, `F-7.14`, `F-7.24`, `F-7.31` (+ `HDR`, and `RELOAD` on failure) |
| `qa3146-app-b` | `F-7.11`, `F-7.13` (load-time read) **and** `F-7.13` (live watch — announces a landed write) |
| `mission` | `F-7.11` |
| `orbit` · `orbit-lab` | `F-7.12` (both sides) |
| `qa3146-consent-a` | `F-7.17` at load; `F-7.18`, `F-7.27` (transition lines) and `F-7.20` (once the query grant is observed) from the consent watcher |
| `qa3146-consent-b` | `F-7.19` |
| `qa3146-no-capabilities` | `F-7.26` |
| `qa3146-mirror-control` | `MIRROR-CONTROL` — **must be `FAIL`** |

### The negative control (do not remove it)

`qa3146-mirror-control` declares its own table and then asserts the **opposite** of the true outcome:
that reading that table is refused. A working mirror therefore **always** prints
`FAIL MIRROR-CONTROL codes=ok step 1 expected refusal action_not_declared, resolved`.

- line **missing** → the mirror never ran (no child evidence exists);
- line reads **PASS** → either the declared read really was refused (a product defect) or the mirror
  fabricates results;
- line reads **FAIL with that reason** → the transport is live.

Without it, "every probe said PASS" and "the mirror renders nothing" are the same observation.

### Determinism and self-checks

The generator writes **eleven** archives with stored entries and a fixed 1980-01-01 DOS timestamp, and
commits **no** hash manifest. Two runs must print an identical `sha256` column — that comparison is
the determinism receipt. Before writing anything it self-checks every archive (re-parse, CRC, manifest
+ `capabilities` round-trip, `mount` export, the exact capability defect for each refusal fixture,
**every advertised probe id embedded in `main.js`**, the mirror hooks present, and the control probe's
knowingly-false expectation). Any failure exits non-zero.

### Two limits the verdict must record

1. A **native/UIA read is not a live-evidence token** for the pipeline's `testing → audit` matcher
   (`telemetry_spans` / `user-attachments` / `tauri_webview_*` / `getBoundingClientRect`). The verdict
   must also carry **one genuine `tauri_webview_*` receipt from a reachable window** (`main` /
   `app-*`) in the same round, plus the `user-attachments` upload of the native capture — otherwise
   the leg is **refused for an instrument reason**, never upgraded to a PASS on a native read alone.
2. A **host-side child read/inject path** (a bridge that can read or drive an `installed-*` document)
   is a **Toolsmith** item. It is routed and **non-gating this round** — no row blocks on it, and no
   row may be answered by an improvised one-off script.
