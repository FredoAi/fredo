# Installable Applications — Research Synthesis & Delivery Plan

**Date:** 2026-11-12
**Synthesises:** [`42`](42-fredo-application-plugin-seams.md) (repo seams), [`43`](43-plugin-architecture-precedents.md) (ecosystem precedents), [`44`](44-plugin-loading-sandboxing-and-build.md) (frontend loading/bundling/security), [`45`](45-plugin-backend-contracts-and-capabilities.md) (backend capability contracts).
**Verified independently for this synthesis:** `allApplications.ts`, `applicationRegistry.ts`, `Home.tsx:13,26,32`, `FredoApplicationClass.ts`, `apps/ui/package.json`, `apps/tauri/src-tauri/build.rs`, `tauri.conf.json:26-29`, `capabilities/default.json`, `application_data/commands.rs:879-919`, `__tests__/retainedApplicationSet.test.ts`.

---

## 1. The one-sentence problem

Fredo's applications are **not modules that plug into a host** — they are **source files that the host's bundler happens to include**, and they reach the host's internals by direct import rather than by any contract. Everything about "installable apps" follows from fixing those two facts, in that order.

---

## 2. What is already in our favour (don't rebuild it)

| Already contract-shaped | Evidence |
|---|---|
| A small app base class with 4 abstract + 4 optional members and 2 lifecycle hooks | `FredoApplicationClass.ts:51-192` |
| A registration seam with a subscription (`subscribeApplications`) a loader could hook | `applicationRegistry.ts:32-53` |
| A declared keyboard surface validated by `validateSurface()` and funnelled through one `dispatch()` | `shared/navigation/validation.ts`, `dispatch.ts` |
| A declaration-based data API the backend validates and physically namespaces (`feature_<appId>_<table>`) | `application_data/commands.rs:879-919`, `declaration.rs` |
| A per-app identity that already routes native windows (`app-*`) and settings sections | `app_window.rs`, `SettingsSurface.tsx:121-126` |
| `adapterBridge` as a single, app-agnostic IPC seam | `shared/utils/adapterBridge.ts` |

**Implication:** we are not designing a plugin system from zero. We are *naming* an interface that already exists implicitly, and then removing the build-time assumption.

---

## 3. The five hard blockers (in dependency order)

| # | Blocker | Why it blocks | Fix belongs to |
|---|---|---|---|
| B1 | **No declared interface** — apps import `@/shared/*` directly (hooks, module singletons, 7 `shared/*` modules import back into `applications/*`) | Freezing today's internal imports as "public API" makes every future refactor an ecosystem break (43 §Exec 14) | Phase A |
| B2 | **Discovery is a build-time glob** — `import.meta.glob('./*/index.ts', { eager: true })`, registry snapshotted at `Home.tsx:26` | An app installed after app start is invisible; a separately-bundled app gets its *own* copy of `_registry` | Phase A (registry) + C (loader) |
| B3 | **Singleton identity** — React context, `StreamContext` row store, `windowStore`, `hostRegistry`, `appPresentationStore`, Emotion cache, Chakra system | Two bundles ⇒ two stores ⇒ correctness bugs, not styling bugs | Phase C (import map + externals) |
| B4 | **Backend is ambient-authority** — `build.rs` calls bare `tauri_build::build()`, so *every* window may invoke *every* command; `application_data_*` accepts a caller-supplied `applicationId` | Any installed code can read/delete another app's tables; this is the confused deputy verbatim (45 §Exec 5) | Phase B |
| B5 | **CSP is compiled in** — `script-src 'self' blob: 'wasm-unsafe-eval'`, no remote origin, `assetProtocol` disabled, `withGlobalTauri:false` | Determines *how* plugin bytes may be loaded; a wrong guess costs a host release. Note `blob:` is already allowed — see §6 | Phase C spike |

---

## 4. What the literature says to copy, and what to refuse

| Copy | Don't copy |
|---|---|
| Declarative manifest validated & displayed **without executing code** (VS Code `contributes`, Grafana `plugin.json`) | VS Code's **separate extension-host process** — its payoff is isolating Node code that touches the filesystem; our plugins are React over typed rows. Cost is permanent and asymmetric (43 R10) |
| `host` semver range + `versions.json` ladder, required, never `*` (VS Code `engines`, Grafana `grafanaDependency`, Obsidian `minAppVersion`) | Backstage's **compile-time discovery** — impossible in a shipped binary |
| Host **facade** object; internals stay private (VS Code `vscode` module, JupyterLab `JupyterFrontEnd` + tokens) | JupyterLab's **source extensions** — deprecated upstream precisely because they need a rebuild |
| Per-plugin **error boundary + disable/lock** shipped with v1 of the loader (Backstage `ExtensionBoundary`, JupyterLab 4.1) | Obsidian's **full-privilege same-realm** posture for third parties |
| **Default-deny network** with a declared allowlist, enforced below JS (Figma `networkAccess`; we can enforce in Rust) | **Module Federation** — its one gift (shared-dep resolution) is replaced by import map + externals; the runtime is optional when the host owns the deps |
| **Signed archive, default-deny unsigned** in release; loud dev-mode escape (Grafana statuses) | **Never auto-upgrading** without a compatibility ladder |
| **Additive-only within a MAJOR**, immutable field identity, `reserved` on removal (protobuf discipline) | "Be liberal in what you accept" — RFC 9413 recommends virtuous intolerance when the host can be updated |

---

## 5. Recommended target architecture

```
┌────────────────────────── Host (single Vite build + Rust) ──────────────────────────┐
│  Launcher / Home ── AppRegistry (validated, id-unique, host-range gated)            │
│       │                                                                             │
│       └── AppMount (error boundary + Suspense + disable switch + mount timeout)      │
│              │                                                                      │
│              ▼                                                                      │
│        FredoAppManifest  (data only: identity, entry, contributes, requires)         │
│              │  validated before any code runs                                       │
│              ▼                                                                      │
│        import(entry)  ──►  app instance (mount/unmount, never unload)               │
│              │                                                                      │
│              ▼                                                                      │
│        FredoHost facade  ◄── the ONLY thing an app may touch                        │
│          rows.use(...)  data.declare/read/watch/write  window.open/close             │
│          commands.invoke(scoped)  navigation.dispatch  theme.tokens  settings  toast │
└──────────────┬──────────────────────────────────────────────────────────────────────┘
               │ Tauri IPC (capability-scoped per window)
┌──────────────▼──────────────────────────────────────────────────────────────────────┐
│ Rust: AppManifest::commands()  +  per-plugin capability files  +  host-minted grants  │
│       application_data_* take a Handle, never a caller-supplied applicationId         │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**Three decisions this encodes**

1. **The manifest is data; the app is code.** Identity, contribution points, required capabilities and host range are reviewable JSON. `render()`, `run`, `available` are functions and can only come from the entry module — so the manifest *points at* code rather than embedding it. (Derived in 42 §Minimum viable contract sketch.)
2. **One realm for first-party, one optional second tier for untrusted.** ESM + import map + externals for anything that must appear in the launcher and participate in keyboard/navigation. `iframe sandbox="allow-scripts"` (no `allow-same-origin`) + RPC only for opaque panels, and only if a third-party marketplace is in scope. Shadow DOM is styling, never security.
3. **Mount/unmount, never unload.** `import()` caching is permanent; "upgrade" means reload the window. Design the UX around that instead of fighting it.

---

## 6. The load-path spike (do this before writing a manifest schema)

CSP currently permits `script-src 'self' blob:`. That gives **three** candidate load paths, and the choice gates everything else:

| Path | CSP change | Origin / trust | Relative imports inside plugin | Verdict |
|---|---|---|---|---|
| **Blob module** — Rust reads the verified file, frontend does `import(URL.createObjectURL(new Blob([src],{type:'text/javascript'})))` | **none** | same-origin as host ⇒ trusted code | break — must ship a **single-file** ESM bundle | Cheapest real path; ideal for v1 |
| **Custom scheme** — `register_uri_scheme_protocol` in Rust, `plugin://localhost/<id>/…` | **required**, and platform-split (`plugin:` vs `http://plugin.localhost`) | same-origin-ish, own scheme | work | Correct long-term; costs a host release to get the spelling right |
| **Separate webview per plugin** — own window label ⇒ own capability file | none | **own origin/capability set** | work | Only path that gives per-plugin capability scoping without capability merging; escalate to this when third parties are real |

**Spike deliverable:** one throwaway in-tree app built with `vite build --lib` (externals: `react`, `react-dom`, `react/jsx-runtime`, `@emotion/react`, `@chakra-ui/react`), loaded via blob path, rendering a Chakra `Box` with a theme token, invoking one existing command, and reading one `useEventRows` query. Success criteria: one React, one Chakra system, theme vars intact, command works, and a deliberate throw inside the app does not white-screen the host.

---

## 7. Contract layers and their versioning unit

| Layer | Contract | Versioning unit | Compatibility rule |
|---|---|---|---|
| UI ↔ host data | `host.rows.use(rowType, args)` | `fredo.rows.<type>@MAJOR.MINOR` | additive-only inside MAJOR; new row type rather than mutated shape |
| UI ↔ host commands | `host.commands.<area>.<verb>(payload)` | `fredo.cmd.<area>@MAJOR.MINOR` | additive verbs/optional fields; removal = MINOR deprecation ≥1 release before MAJOR |
| App's own persisted data | `applicationData.tables[]` declaration | `(contractMajor, declarationRevision)` | additive columns only; removal/retype = new table + backfill; never `ALTER` destructively |
| Native plugin logic (if ever) | WASI component + WIT package | `fredo:plugin@MAJOR.MINOR.PATCH` | WIT `@since`/`@deprecated` |
| Package ↔ host | manifest `host: semver range` + `versions.json` ladder | app version | host refuses to load outside range rather than degrading |

**Do not publish more than this.** `FredoApplicationClass` field names, the row classifier's internal shapes, and `StreamContext` internals stay private.

---

## 8. Phased delivery plan

### Phase A — Named contract, zero loading change (highest value / lowest risk)
- `FredoAppManifest` type + JSON Schema; validator run at registration.
- `FredoHost` facade (rows, data, commands, window, navigation, theme, settings, toast) with **no** new capability — implemented over today's internals.
- Registry becomes the validated registry: id uniqueness, host-range gate, per-app error boundary, per-app disable list.
- Migrate **two** in-tree apps as proof (one heavy: `mission-monitor` ~9.0k LOC; one small: `setup` ~400 LOC). Leave the other six on raw imports.
- **Exit criteria:** the two migrated apps import zero `@/shared/*` symbols; `retainedApplicationSet.test.ts` updated with an explicit "built-in vs installable" split; `pnpm --filter @fredo/ui build` clean.

### Phase B — Backend authority (independent of A, can run in parallel)
- `tauri_build::AppManifest::commands(...)`; stop the blanket allow.
- Per-plugin capability file(s); plugin windows **never** share `app-*`.
- `application_data_*`: replace caller-supplied `application_id: String` with a host-minted grant handle bound to (app id, window label); reject unregistered ids.
- Declare `FREDO_CONTRACT_VERSION`; log-and-refuse unknown MAJOR.
- **Exit criteria:** an app can only reach its declared commands and its own tables; a test proves app B cannot read app A's table via a forged id.

### Phase C — Packaging + runtime load
- `vite build --lib`, ESM, `base:'./'`, `build.manifest`, externals + `peerDependencies`.
- Loader: manifest fetch → verify → `import(entry)` → mount into the Chakra tree with a timeout and error boundary.
- Install/uninstall/disable UI; `versions.json` ladder; unsigned → `Unsigned` status (dev-mode load allowed with a visible badge).
- Run the §6 spike first; pick the load path from its result.
- **Exit criteria:** an app produced outside the repo installs, renders with theme tokens, reads rows, writes its own table, and can be disabled without restarting the host.

### Phase D — Trust tiers (only if a third-party marketplace is in scope)
- `iframe` sandbox tier for opaque panels, or separate webview per plugin for real capability scoping.
- Ed25519/minisign archive signature + import-map `integrity` (SHA-384) hashes.
- Fail-closed install pipeline (single open handle: hash and load the same bytes — avoids TOCTOU).

### Explicitly out of scope
- Separate extension-host process.
- Building TypeScript on the user's machine at install time (§9).
- Web Components/Shadow DOM as a loading model.
- Module Federation.

---

## 9. Why "bun builds the TS at install time" should not be the shipping model

Attractive because it needs no signing or registry. It has three disqualifiers:

1. **Arbitrary code execution at install** — a build step executes app-authored config, plugins, and `postinstall` hooks. That is worse than running the app's runtime code, because it happens before any capability gate exists.
2. **Toolchain on the user's machine** — a shipped desktop binary cannot assume `bun`/`node`, and the error surface (version skew, missing deps, native modules) becomes support load.
3. **Non-deterministic artifacts** — no reproducible hash ⇒ no signature ⇒ no integrity statement.

Keep build-from-source **only** as a loud developer mode (mirrors Grafana's dev-mode escape hatch). Ship prebuilt, signed, single-file ESM.

---

## 10. Housekeeping found during research

- **React version drift:** `AGENTS.md` and `ENGINEERING_RULES.md` describe React 19; `apps/ui/package.json` pins `react@^18.3.1` / `react-dom@^18.3.1`. This changes Web-Component interop analysis materially and should be corrected in the human-owned docs (a human follow-up, not a pipeline edit).
- **`app-window/index.ts` is not a registry feature** — it is a route root; the `retainedApplicationSet` test's comment is correct and the file only *mentions* `registerApplication()` in prose.
- `retainedApplicationSet.test.ts` pins exactly 8 ids; any install path must be a **separate** registry from that pinned built-in set.

---

### Container: DECIDED — separate webview (own window)

Settled 2026-11-12 after measurement (§10c). **Installed apps open in their own native window**, in a separate Tauri webview with its own origin, and receive per-app Tauri capability files. They never render inside the main Fredo window.

Why this over the opaque iframe:
- Per-app origin ⇒ capability scoping is enforceable per app (`dynamic-acl` confirmed in `tauri 2.10.3`); iframe would give all installed apps one shared origin.
- **No CSP change.** A separate webview is a document, not a frame, so `frame-src` is untouched. The iframe path requires a CSP spelling we have not proven.
- Costs nothing in payload (§10c: iframe vs webview is not a bundle question).
- Accepted loss: no in-window panels for installed apps. Adding an iframe tier later is additive, not a rewrite.

### Theme: DECIDED — publish the full theme as `@fredo/theme`

Extract `app/theme/contract/` + the `system.ts` recipe config into a package third-party apps consume. Evidence for the choice:
- `contract/` is pure data — `surfaces.ts`, `allowlist.ts`, `index.ts` have **zero imports**; `tokens.ts` imports only `./surfaces` (verified).
- Every Chakra colour token resolves to `var(--…)` (`system.ts:59-64`), so a plugin's own Chakra instance renders **byte-identical** colours.
- Load cost is low single-digit KB against a 138 KB gzip plugin baseline (§10c).
- Committing token names as public API is additive-friendly (new tokens break nobody), unlike the row schema.

### Loading policy: DECIDED — lazy mount on first open

App module loads on first open; unmount on close; module stays cached (it cannot be unloaded). Rationale: each isolated app carries its own React/Chakra/Emotion instance, so preloading N installed apps means N frameworks resident. Lazy mount keeps startup at today's cost regardless of how many apps are installed. Consequence to design for: first open has a cold-start delay — show a loading state, and preload on launcher hover/focus if it proves noticeable.

### Why the theme requirement did not pick the container

CSS custom properties do **not** cross a document boundary — not even a same-origin iframe. Both isolated containers must read token values from the host and apply them to the child root (IPC for webview, `postMessage` for iframe). The mechanism is identical; only the transport differs. So "apps should use Fredo themes" is satisfiable equally either way and is not a container criterion.

---

## 10b. CHOSEN DIRECTION (human decisions, 2026-11-12)

Recorded so the backlog has one source of truth. These supersede §11.

| Decision | Answer |
|---|---|
| Author set | Fredo's own **and** apps from other people/places → **two trust tiers required** |
| Install UX (v1) | Settings → upload a **zip** of the app files |
| Motivation | **Ecosystem / users extending Fredo** |
| Backend access | Existing commands + its own declared tables — **no new Rust command per app** |
| Scope | **B — install anyone, properly contained** |
| `db_query_execute` / `spawn_terminal_session` | **High-risk grant**: declared + per-app user consent |
| Artifact | **Local zip, unsigned**; trusted-by-user-judgement in v1 |

### The consequence this forces

**Containment and host-realm code reuse are mutually exclusive.** Code inside the host realm can call `window.__TAURI_INTERNALS__.invoke` directly, so any frontend-only allowlist is decorative. Containment therefore requires a **separate origin**, and a separate origin cannot import the host's React/Chakra. This overrides research recommendation R7 (import map + shared singletons) for installed apps only.

| | Built-in apps | Installed apps |
|---|---|---|
| Realm | host, in-bundle | isolated origin |
| Backend | direct `invoke` | host facade only, declared capabilities |
| React / Chakra | host instance | own copy; theming via CSS custom properties |
| Presentation | `same-window` or `new-window` (`appPresentationStore.ts:46`) | container-dependent (below) |
| Keyboard surface | declares verbs via `*Surface.ts` | **cannot participate** (opaque origin, no host dispatch) |

### Container choice — MUST be settled by a spike, not by design

Both containers satisfy "separate origin"; the facade, manifest, RPC schema and capability declaration are identical either way. Only the transport differs.

| | 1. Opaque-origin iframe (`sandbox="allow-scripts"`, no `allow-same-origin`) | 2. Separate webview per app, own custom-scheme origin |
|---|---|---|
| Backend scoping | facade-mediated only | **real Tauri capability file per window label** (`dynamic-acl` confirmed available in `tauri 2.10.3`) |
| Presentation | can host inside the main window | `new-window` only |
| CSP impact | needs `frame-src` (currently absent ⇒ falls back to `default-src 'self'`) — exact spelling unproven | **no CSP change** — separate webview, not a frame |
| Rust work | low | medium (window lifecycle, per-label capabilities) |
| Hot swap | iframe reload works | window reload only |

**Correction to the earlier §6 note:** the "no CSP change" claim applies only to the *trusted ESM* path. Any iframe container needs a `frame-src` change; the separate-webview container needs none.

### What is still required in BOTH containers

1. `tauri_build::AppManifest::commands(...)` — end the blanket allow in `build.rs`.
2. `application_data_*` — replace caller-supplied `application_id: String` with a host-minted handle bound to (app id, window). Closes the confused deputy (`commands.rs:879-919`).
3. High-risk commands (`db_query_execute`, `spawn_terminal_session`, `pg_database_reset`) route only with a declared grant + recorded user consent.
4. Manifest declares `capabilities[]` and `origin: "host" | "isolated"` so the trust tier is explicit data, not an implicit assumption.
5. Contract version constant + additive-only-within-MAJOR rule; refuse unknown MAJOR.
6. **Hash the installed files at install and re-verify at every load.** Unsigned is acceptable only if post-install tampering is still detectable — this costs one hash per file and needs no key management.

### Why unsigned is defensible here

Containment is architectural (origin boundary + facade), not cryptographic. A signature answers "was this zip swapped in transit", which matters at registry scale, not for a local file the user picked. What unsigned does **not** excuse is post-install tampering, hence item 6.

### Accepted v1 limitations (state these in the UI, not just the code)

- Installed apps get **one origin** shared among installed apps unless container 2 is chosen — so an app is contained from *the host's* backend, not necessarily from *other installed apps*.
- Installed apps cannot declare keyboard verbs or join the navigation dispatch tree.
- Installed apps cannot appear in `same-window` presentation unless container 1 is chosen.
- Two code paths (built-in vs installed) exist until Phase A's facade lands for built-ins.

---

## 10c. Measured performance (2026-11-12, this machine)

Method: `esbuild --bundle --minify --format=esm` on representative plugin entries inside `apps/ui` (so resolution matches the real tree). Gzip measured on the output. **Indicative, not a full-app benchmark** — single-screen component samples.

| Artifact | raw | gzip |
|---|---|---|
| Host main bundle `apps/ui/dist/index-*.js` (all 8 built-ins) | 2,828 KB | **798 KB** |
| Plugin, self-contained: React + ReactDOM + Chakra + minimal UI | 173 KB | **58 KB** |
| Plugin, self-contained: + framer-motion, react-icons, Table/Dialog/Menu/Tabs | 422 KB | **138 KB** |
| Plugin, host-provided React/Chakra (externals) | ~39 KB | **~few KB** |

Derived:

- **Loading 138 KB gzip from local disk is not a performance concern.** No network. This is single-digit milliseconds. (Inference from artifact size; not timed.)
- **The marginal cost of host-realm code reuse ≈ 100 KB gzip per app** (138 − ~few). That is the *only* bundle-size penalty of isolation.
- **Isolation's real cost is memory, not bytes.** Each isolated app carries its own React + Chakra + Emotion instance ⇒ its own JS heap. (Inference; not profiled.)
- **The theme is not the performance variable.** The token contract is pure data; bundling the full Fredo system adds low single-digit KB. Colors are byte-identical either way because `chakraValue()` returns `var(--…)` for every color token (`system.ts:59-64`).
- **iframe vs separate webview is not a bundle question at all.** Both are separate documents/bundling; the difference is process topology and window chrome, not payload. (Process-model specifics unverified here.)

**Consequence for the decision:** choose the container on *isolation + windowing*, not on load performance. Both isolated containers are fast enough; the host-realm path is fast *and* not contained.

---

## 11. Decision points the human must settle (SUPERSEDED by §10b)

| # | Decision | Options | Recommended |
|---|---|---|---|
| D1 | Who may author apps in v1? | first-party only / trusted partners / open marketplace | **trusted partners** — keeps one trust tier, defers iframe/wasm |
| D2 | Artifact source | build-at-install / prebuilt local file / remote registry | **prebuilt local file** (`.zip` + manifest) first, registry later |
| D3 | Load path | blob module / custom scheme / separate webview | **blob module** for v1 (no CSP change), custom scheme for v2 |
| D4 | Built-in apps on the contract? | migrate all 8 / migrate 2 as proof / new apps only | **migrate 2 as proof**, then decide from evidence |
| D5 | Untrusted UI tier | in scope now / deferred | **deferred** until D1 changes |
| D6 | Backend authority for v1 | full command surface / declared commands only | **declared only** — it is the whole point of "contracts" |
