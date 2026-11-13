# 40 - Plugin Loading, Sandboxing, and Build

**Runtime-loading independently-built UI applications into a Tauri v2 + React host**

**Date:** 2026-11-12
**Scope:** The frontend half only. How to build a Fredo "application" as an independently-compiled package and load it into the running React host safely, with the least reinvention, while it still reaches the Rust backend through contracts. Covers runtime module loading, micro-frontend approaches, styling/design-system coupling, Vite packaging mechanics, integrity/signing, and failure containment. Does **not** specify the Rust-side contract registry, IPC ACL design, or catalog/install UX beyond what loading requires.
**Method:** Spec and vendor documentation first (MDN/WHATWG, Tauri v2 docs and docs.rs, Vite docs, Chakra UI docs, npm docs, webpack docs, Module Federation docs, single-spa docs, minisign, Sigstore). Every URL in *Sources* was fetched during this research; nothing is claimed from a URL's existence alone. One blog is used and is labelled secondary. Repo facts were read directly from `apps/ui/package.json`, `apps/tauri/src-tauri/tauri.conf.json`, `apps/tauri/src-tauri/Cargo.toml`, and `apps/ui/src/applications/`.

---

## Executive Summary

1. **Adopt ESM + one host-owned import map; do not adopt Module Federation.** The import map is what guarantees a single React/Chakra instance, it needs no runtime, and Module Federation's own docs show a mode that "resolves shared dependencies through a native browser import map instead of the federation runtime" ([S5], [S10]) - i.e. the runtime is optional when the host owns the dependency set.
2. **Externalise `react`, `react-dom`, `react/jsx-runtime`, `@emotion/react`, `@chakra-ui/react` in every plugin build** via `build.lib` + `external`, and declare them as `peerDependencies` so the loader can refuse incompatible plugins before executing anything ([S26], [S28], [S29]).
3. **Serve plugin bytes from one custom scheme registered in Rust** (`register_uri_scheme_protocol` / `register_asynchronous_uri_scheme_protocol`), never from a CDN - Tauri explicitly warns against remote scripts ([S1], [S4]).
4. **Declare that scheme in the build-time CSP, spelled per platform**: `plugin:` on macOS/iOS/Linux but `http://plugin.localhost` on Windows/Android, because that is how Tauri maps custom-scheme origins ([S1], [S4]). This is a host-release commitment, so choose the scheme once.
5. **Do not use `assetProtocol` as the plugin loader.** It is disabled in this repo, its scope is path-glob shaped (not plugin-identity shaped), it needs `asset:`/`http://asset.localhost` in CSP, and its `deny`/dot-directory rules are easy to misconfigure ([S2], [S3], [S7]).
6. **Treat install-time verification as Ed25519 (minisign semantics) + hash pinning, both offline.** A signed trusted comment should carry `{pluginId, version, hostContract, sha256}` so downgrades are cryptographically detectable ([S31]).
7. **Pin every plugin chunk in the import map's `integrity` map (SHA-384).** SRI covers `script`/`link`, and import maps extend integrity metadata to dynamically imported modules ([S5], [S30]).
8. **Make CSS custom properties the styling contract, and Chakra components an optimisation.** Chakra emits every token as a CSS variable and semantic tokens always resolve to `var(--...)`, so the contract survives a different React, a shadow root, and an iframe ([S24], [S25]).
9. **Accept that a plugin can be unmounted but never unloaded.** `import()` caches permanently and module namespace objects are never collectable; "hot enable" means re-mounting the same instance, and "upgrade" leaks the old instance until a window reload ([S6]).
10. **Use the single-spa lifecycle shape (bootstrap/mount/unmount + per-app timeouts) rather than a framework.** It is three named exports and a `timeouts` object, maps directly onto React roots, and gives you a documented hang-detection model ([S11]).
11. **Contain failures in three layers: an error boundary (render), plugin-tagged global handlers (async/timers), and a mount timeout.** Error boundaries do not catch event-handler or timer errors, and their dev/prod bubbling differs ([S21], [S34]).
12. **Introduce exactly two trust tiers now: first-party ESM (no JS isolation) and untrusted iframe (`sandbox="allow-scripts"`, opaque origin, RPC bridge).** Shadow DOM is a styling tool, not isolation; `mode:"closed"` is explicitly not a security mechanism ([S12], [S13], [S15], [S20]).
13. **Gate each plugin against the lethal trifecta** (private data x untrusted content x egress) and remove one leg structurally - via CSP `connect-src`, a bridge with no network verb, or a reduced data surface ([S23], secondary).
14. **Plan for capability denial as the default, not the exception.** Non-bundled origins get no IPC unless `remote.urls` is granted, and capabilities on the same window merge - so "load it into the main window" quietly grants the whole backend ([S35]).

---

## 0. Verified starting conditions in this repo

Several "obvious" options are already foreclosed by the current configuration, so they are stated before any recommendation.

| Fact | Value | Where read |
|---|---|---|
| React version | **18.3.1** (`react`, `react-dom`), not 19 | `apps/ui/package.json` |
| Chakra UI | `@chakra-ui/react` `^3.2.2`, plus `@emotion/react`, `@emotion/styled` | `apps/ui/package.json` |
| Bundler | Vite `^6.0.0`, `@vitejs/plugin-react` `^5.1.2` | `apps/ui/package.json` |
| Tauri | `tauri = "2"` (docs.rs resolves 2.12.5 today) | `apps/tauri/src-tauri/Cargo.toml` |
| Production CSP | `default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ipc: http://ipc.localhost; worker-src blob:` | `tauri.conf.json` |
| `app.security.assetProtocol` | absent, so default `{ "enable": false, "scope": [] }` | `tauri.conf.json`; [S7] |
| `withGlobalTauri` | `false`, so no `window.__TAURI__` global | `tauri.conf.json` |
| IPC pattern | brownfield (default `{ use: "brownfield" }`), no isolation app | `tauri.conf.json`; [S7] |
| In-tree applications | 14 dirs incl. `mission-monitor`, `database-client`, `terminal`, `doom`, `theming`, `settings-app` | `apps/ui/src/applications/` |

**Consequences that shape everything below:**

1. `script-src 'self' blob:` contains **no `https:` and no custom scheme**. A runtime-loaded module served from a new scheme needs that scheme declared in the **build-time** CSP, because the CSP is compiled into the app. The host must therefore ship with the scheme already allowed.
2. `assetProtocol` is disabled, so `convertFileSrc()` cannot produce a loadable URL until it is enabled, scoped, *and* allowed by CSP ([S2], [S3], [S4]).
3. Code loaded from any origin other than the bundled app is **denied IPC by default**; Tauri capabilities are granted per window/webview, with remote access opt-in ([S35]). "Plugin can call Rust" is not free.
4. React is **18**, so the custom-elements path carries the pre-19 limitations (props-as-attributes, no automatic event binding) ([S12], [S14], [S18]).

---

## 1. Runtime module loading in a webview

### 1.1 ES modules + import maps are the native substrate

`import()` is Baseline "widely available" (since Jan 2020). It returns a promise that fulfils to a **sealed, null-prototype module namespace object**; it never throws synchronously. Rejection causes are enumerated: fetch failure/CORS/HTTP error, parse or link error, evaluation error ([S6]).

Two lifecycle facts dominate the design:

- *"This aggressive caching ensures that a piece of JavaScript code is never executed more than once. Future imports ... don't even result in HTTP requests or disk access."*
- *"there is no way to manually clear the cache of module namespace objects"*; the query-string workaround *"can lead to memory leaks in a long-running application"*, because the engine *"cannot safely garbage-collect any module namespace objects"* ([S6]).

=> **A plugin can be unmounted; it cannot be unloaded.** "Disable, then enable again" must re-use the same evaluated module (accepting possibly-stale state) or reload the whole window. This is the hard constraint that makes "hot disable/enable without restarting" partially achievable at best.

Import maps (`<script type="importmap">`) supply `imports`, `scopes`, and an **`integrity` map keyed by module URL**:

- They must be *"declared and processed before any `<script>` elements that import modules using specifiers declared in the map."*
- They apply *"only to module specifiers in the `import` statement or `import()` operator for modules loaded into documents"*, **not** to `<script src>`, and **not** to workers/worklets ([S5]).
- Merging is global and first-wins: *"Module specifiers in each registered map that were already resolved beforehand are dropped"*, and an already-mapped specifier's *"previous mapping prevails"* ([S5]).
- Baseline since March 2023, with the caveat that *"some parts of this feature may have varying levels of support"* and that some browser versions *"allow only a single import map declaration"* ([S5]).

=> The host can expose `react`, `react-dom`, `react/jsx-runtime`, `@emotion/react`, `@chakra-ui/react` as bare specifiers in one import map, and every plugin bundle can literally `import "react"`. This is the minimum-invention route to a single React instance. But the map is **global, append-only, and effectively irreversible** once a specifier has resolved.

### 1.2 Tauri's asset protocol vs. a registered custom scheme

Two distinct Rust/Tauri loading surfaces with different scope semantics:

- **Asset protocol** via `convertFileSrc(filePath, protocol = 'asset')`: requires `app.security.assetProtocol.enable = true` **and** the resolved path to match `scope`. Scope is an `FsScope`: either an array of globs, or an object `{ allow, deny, requireLiteralLeadingDot }`, with `deny` winning over `allow`. *"The protocol origins must also be allowed by the relevant `app.security.csp` directive"*; the documentation's own example uses `img-src 'self' asset: http://asset.localhost` ([S2], [S3], [S7]).
- **Custom URI scheme** registered in Rust: `Builder::register_uri_scheme_protocol(name, handler)` (synchronous, returns `http::Response<T>`) or `register_asynchronous_uri_scheme_protocol(name, handler)` (responder-based, request handled off-thread) ([S1]).

The **platform origin split** is the least-appreciated constraint. For a registered scheme `my-scheme`:

- **macOS, iOS, Linux:** origin is `my-scheme://localhost/<path>`
- **Windows, Android:** origin is `http://my-scheme.localhost/<path>` by default; HTTPS only via `WebviewBuilder::use_https_scheme` ([S1])

So a CSP source expression and any CORS allow-list are **per-platform**, and a single `script-src my-scheme:` works everywhere except Windows, where the page origin is `http://my-scheme.localhost`. The same doc warns that servers enforcing CORS *"will need to add the exact same Origin header (or `*`) in `Access-Control-Allow-Origin` if you wish to send requests with native `fetch` and XmlHttpRequest APIs"* ([S1]).

### 1.3 Origin choice for plugin assets

| Entry origin | CSP burden | IPC access | Host React/theme reuse | Notes |
|---|---|---|---|---|
| Bundled `tauri://localhost` (`'self'`) | none (already allowed) | full (bundled code) | trivial | Today's model; cannot update without shipping the app |
| Custom scheme (`plugin://localhost`) | add scheme to `script-src`, per-platform spelling | **denied by default** ([S35]) | good, same document and same realm | Recommended: Rust decides which bytes are served |
| `asset:` protocol | `asset:` + `http://asset.localhost` in `script-src`; glob scope | **denied by default** | good | Scope is path-shaped, not plugin-identity-shaped; dot-dir rules are easy to misconfigure ([S3]) |
| `https://` catalog/CDN | `script-src https://plugins.example` (broad) | denied unless `remote.urls` granted | poor, module identity is a URL; offline fails | Tauri explicitly cautions against remote scripts ([S4]) |

Tauri's CSP guidance is unambiguous: *"Avoid loading remote content such as scripts served over a CDN as they introduce an attack vector. In general any untrusted file can introduce new and subtle attack vectors."* ([S4])

### 1.4 IPC is authorised per origin, not per bundle

*"By default the API is only accessible to bundled code shipped with the Tauri App. To allow remote sources access to certain Tauri Commands it is possible to define this in the capability configuration file"*, using `remote: { urls: [...] }` ([S35]). And the platform trap: *"On Linux and Android, Tauri is unable to distinguish between requests from an embedded `<iframe>` and the window itself."* ([S35])

Two implications:

- If plugins are served from `plugin://localhost`, they need an explicit capability with `remote.urls` covering the platform-correct origin.
- Because capabilities are per window label and *"Windows and WebViews which are part of more than one capability effectively merge the security boundaries"* ([S35]), every plugin loaded into the main window inherits the main window's IPC surface unless a separate webview is used.

Also stated plainly in the capability security-boundary section, the things capabilities do **not** protect against include *"0-days or unpatched 1-days in the system WebView"* and *"Supply chain attacks or otherwise compromised developer systems"* ([S35]).

### 1.5 Webview version reality

Tauri desktop rides the system webview: WebView2/Chromium on Windows (self-updating), WKWebView on macOS (tied to OS updates), WebKitGTK on Linux (tied to distro) ([S38]). The Baseline features used here (import maps March 2023, `import()` 2020, shadow DOM 2020, `postMessage` 2015) are all older than the oldest plausible webview, but *"import maps allow only a single declaration"* on some builds ([S5]) means the host must emit exactly one map rather than dynamically injecting a second.

---

## 2. Micro-frontend approaches, honestly compared

### 2.1 Module Federation (webpack 5, or `@module-federation/vite`)

**Model.** *"Multiple separate builds should form a single application. These separate builds act like containers and can expose and consume code among themselves."* Remote loading is explicitly asynchronous: *"It's not possible to use a remote module without a chunk loading operation"*, normally an `import()` ([S8]). Exposed access is split into two steps: *"loading the module (asynchronous)"* and *"evaluating the module (synchronous)"* ([S8]).

**Shared deps and version negotiation.** A share scope is *"a plain object ... that maps a module key to the versions of it that are available on the page"*; two plugins work it: `ProvideSharedPlugin` registers the build's copy, `ConsumeSharedPlugin` *"looks a module up in the scope instead of bundling it, falling back to the local copy when nothing satisfying is there"* ([S8]). Version choice: *"a consumer gets the highest version in the scope that satisfies its range"*; ties break on `output.uniqueName`; *"An already-loaded version is never replaced."* ([S8])

`singleton: true` exists precisely because *"Some libraries use a global internal state (e.g. react, react-dom). Thus, it is critical to have only one instance of the library running at a time."* ([S9]) With multiple versions in scope, *"the highest semantic version is used"* ([S9]).

**Failure modes, documented, not hypothetical:**

- `Uncaught Error: Shared module is not available for eager consumption` - the host eagerly executes a module that consumes a shared dep; the fixes are an async boundary (`import('./bootstrap')`) or `eager: true`, which *"will always be downloaded"* ([S8]).
- `Container initialization failed as it has already been initialized with a different share scope` - *"A container's `init()` was called twice with two different scope objects"* ([S8]).
- `Uncaught TypeError: fn is not a function` - missing container, or the host's own container file not present ([S8]).
- `Uncaught Error: Module "./Button" does not exist in container.` - expose key mismatch (`'Button'` vs `'./Button'`) ([S8]).

**Vite flavour.** `@module-federation/vite` *"brings Module Federation to Vite 5, 6, 7, and 8"*, supports `type: 'module'` remotes, `shared: { react: { singleton: true } }`, and a manifest-based remote entry (`mf-manifest.json`). Options exist for `bundleAllCSS`, `disableRemote`, `disableShared`, and an `experiments.hostProvidesAllShared` mode that *"resolves shared dependencies through a native browser import map instead of the federation runtime"* and *"does not support version negotiation, `import: false`, runtime plugins, SSR, `loadRemote`, or interop with Webpack and Rspack containers"* ([S10]).

Notably, `experiments.hostProvidesAllShared` is an admission that for a host that fully owns its dependency set, the federation runtime is optional: the import map alone suffices. That is directly relevant here (see 3.2).

**Honest assessment for Fredo.** Federation solves a problem Fredo does not have (independent deployment teams negotiating `lodash` majors on a shared public web page). Its costs are real: a runtime, a manifest, share-scope state machines, `uniqueName` collisions, `init()`-once semantics, and `eager` bundle bloat. Its main gift, automatic shared-dependency resolution with React singleton guarantees, is obtainable more simply with an import map plus externalisation.

### 2.2 single-spa / import-map micro-frontends

single-spa defines a lifecycle contract: a registered application *"must correctly implement all of the following lifecycle functions"*: `bootstrap`, `mount`, `unmount` required, `unload` optional, each returning a promise or being `async`. Lifecycle props include `name`, `singleSpa`, `mountParcel`, and `customProps` ([S11]). `unmount` is explicit about the cleanup burden: *"it should clean up all DOM elements, DOM event listeners, leaked memory, globals, observable subscriptions, etc. that were created at any point when the registered application was mounted."* ([S11]) Failure handling is a first-class per-app concern via `timeouts` with `millis`, `dieOnTimeout`, `warningMillis` ([S11]).

**Isolation caveats are implicit in the design:** mount/unmount is cooperative cleanup, not enforcement. A plugin that leaks a global, a `setInterval`, a prototype mutation, or a listener on `window` survives `unmount`. There is no address-space boundary. `load` *"is best practice to do as little as possible / nothing at all during `load`"* ([S11]).

**What is worth stealing.** The lifecycle shape (bootstrap -> mount -> unmount -> optional unload with timeouts) is a good, cheap contract for Fredo, and it maps onto React cleanly: `mount` renders a root inside the host's tree; `unmount` unmounts it. The `timeouts` idea is a direct answer to "plugin failed to load / hung."

**What is not worth taking.** The root-config/activity-function routing layer and the parcel model duplicate Fredo's existing window/application kernel and navigation host. Import-map micro-frontends also inherit the single-declaration and irreversibility limits of 1.1.

### 2.3 Web Components + Shadow DOM

Shadow DOM gives genuine **style** isolation in one direction: *"The page CSS does not affect nodes inside the shadow DOM"* and *"styles defined in the shadow DOM tree are not applied in the rest of the page"* ([S12]). Encapsulation is not a security boundary; MDN says of `mode: "closed"`: *"you should not consider this a strong security mechanism, because there are ways it can be evaded"* ([S12], [S13]).

**React 18/19 realities:** custom elements do not automatically receive props as JS properties (React 18 sets attributes) nor bind custom events, so a wrapper is required; this is the well-known limitation that React 19 partially relaxes. In this repo React 18.3 is pinned, so a wrapper (`ref` plus manual `addEventListener` / property assignment) is mandatory. Events cross the boundary only if `composed` is true: *"All UA-dispatched UI events are composed ... Most other types of events are not composed"*, and *"Propagation only occurs if the `bubbles` property is also `true`"* ([S14]). React portals render into the light DOM (or a detached root), so a portal-based dialog/menu from inside a shadow root escapes the shadow tree and loses its styling - a concrete, immediate failure for any plugin using Chakra's `Portal`-based components.

**Theme sharing.** CSS custom properties are the only channel that crosses the shadow boundary by inheritance without extra plumbing (custom properties inherit through the flattened tree). Chakra v3 emits its tokens as CSS variables, so a shadow-rooted plugin *can* see host tokens if the theme variables are set on `:root` and inherited down. Chakra's own documented `cssVarsRoot` default is `":where(:root, :host)"` ([S24]), i.e. Chakra already anticipates hosts.

**Honest assessment.** Web Components buy *style* isolation and a stable custom-element contract; they do not buy security, they complicate React interop on React 18, and they break portals. For a trusted-first-party plugin model, shadow DOM is a styling tool, not an isolation level.

### 2.4 iframe + `postMessage` / Comlink RPC

**Model.** `<iframe>` is *"a nested browsing context"* with *"its own document"* ([S15]). Cross-origin scripts *"cannot access most properties in other `window` objects"*, and *"Cross-origin communication can be achieved using `Window.postMessage()`"* ([S15], [S16]). This is the **only** mechanism in the web platform that gives a real document-level isolation boundary short of a separate webview.

`sandbox` is the hardening dial. Without `allow-same-origin`, *"the resource is treated as being from a special origin that always fails the same-origin policy"*, blocking storage and many APIs ([S15]). Two warnings matter:

- *"When the embedded document has the same origin as the embedding page, it is **strongly discouraged** to use both `allow-scripts` and `allow-same-origin`, as that lets the embedded document remove the `sandbox` attribute - making it no more secure than not using the `sandbox` attribute at all."* ([S15])
- Without `allow-same-origin` the plugin also cannot read host `localStorage`, cookies, or IndexedDB ([S15]) - which is exactly the isolation you want for untrusted code.

**RPC datatype boundary.** `postMessage` *"data is serialized using the structured clone algorithm"* ([S16]). Structured clone **cannot** copy functions or DOM nodes (`DataCloneError`), does not preserve prototypes, and does not walk the prototype chain ([S17]). So an iframe plugin's "host API" can only be message-shaped: JSON-ish values, `ArrayBuffer`/`TypedArray`, `Map`/`Set`, `Blob`/`File`, and transferables. Everything host-side must be an async RPC stub.

**Comlink** exists to hide exactly that: *"Comlink turns this messaged-based API into something more developer-friendly by providing an RPC implementation"*; `wrap` *"returns a proxy. The proxy will have all properties and functions of the exposed value, but access and invocations are inherently asynchronous"*, so *"a function that returns a number will now return a promise"*. Functions are neither cloneable nor transferable, so callbacks require `Comlink.proxy(value)`; events require a transfer handler because *"`Event` is neither structured cloneable nor transferable"*; and `Comlink.windowEndpoint(window, context, targetOrigin)` exists specifically for iframe/window targets ([S18]). This is a credible, tiny (~2.5 kB) RPC layer if an iframe path is ever taken.

**Security discipline is non-optional.** *"Failure to check the `origin` and possibly `source` properties enables cross-site scripting attacks"*, and *"Always specify an exact target origin, not `*`"* ([S16]).

**Costs of iframe hosting in Fredo:** each iframe is *"a complete document environment"* with *"increased memory and other computing resources"* ([S15]); the plugin cannot use the host's React or Chakra (different realm, different document); it cannot share the host DOM, the navigation host, the window manager, or the design-system context; theming is limited to passing CSS custom-property values over the bridge or via `:host` inheritance; and dialogs/menus/drag-and-drop over a window system that spans the host DOM become RPC-heavy.

### 2.5 What isolation actually buys: the threat-model reading

Isolation protects against **code you cannot audit doing things you did not intend**. The concrete deltas:

| Attack / capability | Same-realm ES module | Web Component (shadow) | iframe (cross-origin, sandboxed) |
|---|---|---|---|
| Read host DOM and user-visible data | yes | yes (`shadowRoot` is cosmetic) | no |
| Read host `localStorage` / IndexedDB / cookies | yes | yes | no (opaque origin blocks storage) |
| Call `window.__TAURI_INTERNALS__` / `invoke` | yes | yes | no window, no IPC |
| Mutate `Object.prototype` (prototype pollution) | yes | yes | **contained to the iframe realm** |
| Exfiltrate anything via `fetch` | yes (subject to CSP `connect-src`) | yes | only if sandbox allows and CSP permits |
| Block on crash (`RangeError: too much recursion`, OOM) | no | no | **yes, contained** |
| Style bleed into host | yes | styled isolation | yes (fully) |

Prototype pollution is a *realm*-scoped hazard: an attacker who can add a property to `Object.prototype` changes *"all derived objects ..., including objects that the attacker doesn't have direct access to"* ([S19]); it can rewrite `fetch()` defaults or `HTMLIframeElement.srcdoc`. The mitigations are freeze/seal, null-prototype objects, schema validation, and realm lockdown (SES) ([S19]) - none of which a perfunctory plugin author will do reliably. An iframe gives realm isolation for free.

Same-origin policy is the load-bearing primitive: *"Two URLs have the same origin if the protocol, port ... and host are the same"*, and *"Scripts cannot access most properties in other `window` objects if the script was loaded from a different origin"* ([S20]). It is a **cross-origin** control. Two modules fetched into the same document are, by construction, same-origin and therefore **un-isolated**.

**Lethal-trifecta reasoning (secondary source).** Simon Willison's formulation: the dangerous combination is *"Access to your private data"*, *"Exposure to untrusted content"*, and *"The ability to externally communicate"*; *"If your agent combines these three features, an attacker can easily trick it into accessing your private data and sending it to that attacker"* ([S23], secondary/blog). Transposed to plugins: an installed plugin that (a) can read Fredo state through IPC (workspace paths, DB rows, repo content - private data), (b) ingests untrusted content (repository files, agent output, web pages, telemetry), and (c) can make network requests, is a data-exfiltration channel by construction. Mitigation is to **break the triangle**, not to rely on code review: an install-time trust tier that removes IPC breadth, removes egress (CSP `connect-src`), or removes both. The recommendation in section 9 leans on this.

---

## 3. Styling and design-system coupling

### 3.1 Can a plugin render Chakra components with the host's theme?

Chakra v3's theming is: `defineConfig(...)` -> `createSystem(defaultConfig, config)` -> `<ChakraProvider value={system}>` ([S24]). The system object carries `token`, `token.var`, `css`, `cva`, `sva`, `isValidProperty`, `splitCssProps`, `breakpoints` ([S24]). Crucially:

- `system.token("colors.danger")` and `system.token.var("colors.danger")` **both return `var(--chakra-colors-danger)`** for semantic tokens, *"because semantic tokens change based on the theme"* ([S24]).
- Token CSS variables are emitted at a **configurable root**: default `":where(:root, :host)"`, overridable via `cssVarsRoot`, with an overridable prefix via `cssVarsPrefix` ([S24], [S25]).
- `strictTokens: true` throws a TS error for a non-token colour ([S24]).

**Two viable coupling models:**

**(a) Same-instance Chakra.** The plugin imports `@chakra-ui/react` and renders inside the host's existing `ChakraProvider`. This works *only* if the plugin resolves to the exact same module instance as the host; otherwise `createContext` values differ and the plugin's components fall back to `defaultSystem`. That is precisely what an import map with `"@chakra-ui/react": "<host chunk>"` guarantees, and precisely what a bundled copy breaks. Emotion is also a shared-singleton problem: two `@emotion/react` copies produce two cache instances and duplicated style sheets.

**(b) CSS-custom-property contract.** The plugin renders plain DOM / its own styling, and consumes host tokens only through `var(--...)`. Chakra already emits every token as a CSS variable ([S24], [S25]); Fredo's `ThemeProvider` additionally sets `--body-bg`, `--card-bg`, `--text-primary`, `--accent-primary`, `--status-*` per `docs/ENGINEERING_RULES.md`. This model survives a different React, a different Chakra, an iframe boundary, and a shadow root, because custom properties inherit.

**Recommendation:** (b) as the *contract*, (a) as an *optimisation* for first-party plugins. The contract must not be "you may import Chakra"; it must be "these CSS variables and these component primitives are stable." That directly matches the repo's existing rule that *"All colors come from the theming application"* and that components read *"a token (`bg="bg.surface"`) or its var (`bg="var(--card-bg)"`), never a raw value"*.

### 3.2 Avoiding duplicate React/Chakra instances

The mechanism is `peerDependencies`: *"you want to express the compatibility of your package with a host tool or library, while not necessarily doing a `require` of this host. This is usually referred to as a plugin"* ([S26]). Peer deps are **not bundled**; npm v7+ *"peerDependencies are installed by default"*, and the guidance is to *"make sure your plugin requirement is as broad as possible"* ([S26]). `peerDependenciesMeta` marks them optional ([S26]).

At build time the equivalent mechanism is `build.rolldownOptions.external` (Vite 8) / `build.rollupOptions.external` (Vite 6): *"make sure to also externalize any dependencies that you do not want to bundle into your library, e.g. `vue` or `react`"* ([S28], [S29]).

Whichever micro-frontend path is chosen, **the singleton requirement is the same**: one `react`, one `react-dom`, one `react/jsx-runtime`, one `@emotion/react`, one Chakra system. Only 2.1's `singleton: true` and 1.1's import map actually enforce it. An iframe deliberately violates it (separate realm, separate React if the plugin bundles one), which is fine, because an iframe plugin does not participate in the host's React tree.

---

## 4. Build/packaging mechanics with Vite

### 4.1 Library mode

`build.lib` needs an `entry` (HTML is not allowed as a library entry), `name` only when `formats` includes `umd`/`iife`, default formats `['es','umd']` for single entry and `['es','cjs']` for multiple, and `fileName`/`cssFileName` ([S28], [S29]). For runtime `import()` the format must be **`es`**. IIFE/UMD is only useful for the webpack `script`-remote style, which Fredo should not adopt.

Library mode has two sharp edges that matter here:

- *"If you specify `build.lib`, `build.assetsInlineLimit` will be ignored and assets will always be inlined"* ([S28]), so `?url` assets become data URIs, which interacts with CSP (`script-src` must never allow `data:`).
- *"If you specify `build.lib`, `build.cssCodeSplit` will be `false` as default"* ([S28]), so there is one CSS file per plugin, emitted next to the JS.

CSS handling: in library mode CSS is *"bundled as a single CSS file besides the built JS files"*, named from `fileName` or `cssFileName`, and exported as `"./style.css"` in `package.json` ([S28]). The host must therefore load the plugin's CSS *before* or with its JS (see section 9).

`import.meta` preservation: Vite requires native `import.meta` for relative bases, and production targets assume native dynamic import plus `import.meta` ([S28], [S27]). The plugin must be built with `base: './'` or an absolute runtime-known prefix so its internal chunk URLs resolve relative to the plugin's own directory.

### 4.2 Manifest output as the load contract

`build.manifest` *"generates a manifest file that contains a mapping of non-hashed asset filenames to their hashed versions, which can then be used by a server framework to render the correct asset links"*, default path `.vite/manifest.json` ([S28]). Combined with content hashing, this is exactly the input the host loader needs: a stable mapping from logical entry to hashed filename plus its CSS. The plugin package should ship federation-manifest-like metadata of its own (entry, CSS, integrity hashes, `peerDependencies` ranges, contract version).

`build.license: true` emits `.vite/license.md` (or JSON) *"that includes all bundled dependencies' licenses"* ([S28]) - cheap and useful for a plugin catalog.

### 4.3 Why externalise the host's React rather than bundle it

Five independent reasons, all from the docs above:

1. **Singleton requirement** - React's hooks state lives in the module instance; two copies means two dispatchers, "Invalid hook call", and broken context ([S9]).
2. **Context identity** - Chakra's provider is a `createContext` value; two `@chakra-ui/react` copies means the plugin gets `defaultSystem`, not the host theme ([S24]).
3. **Bundle size** - React + ReactDOM + Emotion + Chakra is multiple hundreds of kB per plugin, repeated per install.
4. **Fix propagation** - a React security fix should land once, in the host, not per plugin.
5. **Compatibility surface** - with externals, `peerDependencies` becomes an enforceable contract (`react: "18.x"`), and the loader can refuse to load a plugin whose range does not match ([S26]).

### 4.4 Determinism and content hashing

Vite emits hashed filenames by default and the manifest maps them ([S28]). For reproducible builds the practical levers are: pin the toolchain (Vite 6, plugin versions), `build.minify` consistency (default `'esbuild'` on Vite 6, `'oxc'` on Vite 8 - [S27] vs [S28]), and a stable `fileName` in lib mode. Determinism matters here mainly because **integrity hashes are the trust anchor** (section 5): if a rebuild produces a different hash for identical source, every install looks "tampered."

### 4.5 What the loader must know at build time

Because CSP is baked into the shipped app, the plugin build must agree with the host build on:

- the scheme (`plugin:`), its CSP spelling per platform (`plugin:` on macOS/Linux; `http://plugin.localhost` on Windows), and
- the fact that plugin chunks are dynamically imported from that scheme.

That is a **host release dependency**, not a plugin one: adding a new scheme later requires a host release. This is the strongest argument for choosing the scheme once, now, and reserving a stable path space (`plugin://localhost/<pluginId>/<version>/...`).

---

## 5. Integrity, signing, and supply chain

### 5.1 Subresource Integrity (SRI)

SRI works by *"allowing you to provide a cryptographic hash that a fetched resource must match"*, with `sha256`/`sha384`/`sha512` prefixes, a whitespace-separated list, and strongest-hash-wins semantics ([S30]). It applies to `<script>`, and to `<link>` with `rel` of `stylesheet`, `preload`, or `modulepreload` ([S30]).

Two constraints hit runtime-loaded plugins directly:

- Cross-origin SRI **requires CORS**: *"Cross-origin requests that use subresource integrity must use the Cross-Origin Resource Sharing (CORS) protocol"* and the markup *"must include the `crossorigin` attribute"* ([S30]). Dynamically-`import()`ed modules do not carry an `integrity` attribute, but the **import map's `integrity`** map does, keyed by module URL ([S5]).
- *"browsers will not allow `no-cors` requests to use subresource integrity"* ([S30]), so a same-origin (`plugin://`) fetch is the easiest path.

=> Two complementary checks: (1) verify the plugin archive's Ed25519 signature **before install** (5.2); (2) pin per-module SHA-384 in the import map's `integrity` map for **every** chunk the plugin can load, so a swapped file on disk fails at import.

### 5.2 Package signing: minisign / Ed25519 / Sigstore

**minisign** is *"a dead simple tool to sign files and verify signatures ... portable, lightweight, and uses the highly secure Ed25519 public-key signature system"*. Commands: `minisign -G` (keypair), `minisign -Sm file`, `minisign -Vm file -P <base64 pubkey>`. Signature format is `untrusted comment` + `base64(algo || key_id || sig)` + `trusted_comment` + `base64(global_signature)`, with prehashing `ed25519(Blake2b-512(file data))` and *"New implementations must use the hashed signature format"*. Trusted comments are explicitly recommended for *"application-specific metadata such as the intended file name, timestamps, resource identifiers, or version numbers to prevent downgrade attacks"* ([S31]).

This maps cleanly onto a desktop marketplace: the app ships one (or a few) Ed25519 public keys; the plugin archive plus a `.minisig` are downloaded; verification is a few hundred lines of Rust (`ed25519-dalek` + Blake2b) or a bundled `minisign` binary; **works fully offline**; and a *trusted comment* can carry `{pluginId, version, minHostVersion, sha256}` inside the signature so a downgrade is cryptographically detectable.

**Sigstore/cosign** is the heavyweight alternative: keyless verification *"using OpenID Connect"*, with `cosign verify-blob <file> --bundle artifact.sigstore.json --certificate-identity=... --certificate-oidc-issuer=...`, or a key-based `--key cosign.pub` ([S32]). The bundle format *"supports offline verification"* ([S32]), but the trust root is Fulcio + Rekor, which means either shipping root material and bundle verification code, or accepting an online dependency. For a desktop app that must work on a plane, minisign/Ed25519 with a pinned key is the realistic choice; Sigstore is the right choice **if** plugins are published through a public CI and you want *keyless* CI identity rather than a long-lived key.

### 5.3 npm provenance and SLSA as trust context

npm provenance publishes *"provenance attestation"* and *"publish attestation"*, signed by Sigstore and recorded in a transparency log; generation requires *"a supported cloud CI/CD provider using a cloud-hosted runner"* (GitHub Actions, GitLab CI/CD), and verification is `npm audit signatures` ([S33]). The docs are explicit about the limit: *"When a package in the npm registry has established provenance, it does not guarantee the package has no malicious code. Instead, npm provenance provides a verifiable link to the package's source code and build instructions"* ([S33]).

=> Provenance is **evidence about the build**, not safety of the code. A Fredo marketplace likely will not have it (plugins are not npm-published artifacts). It is worth *accepting and surfacing* provenance/provenance-like attestations when present, but the enforceable desktop guarantee is the local Ed25519 signature plus hash pin, not provenance.

### 5.4 What a desktop app can realistically verify offline

| Check | Offline? | Mechanism |
|---|---|---|
| Archive signature | yes | Ed25519 + pinned pubkey ([S31]) |
| Every loaded chunk unmodified | yes | import-map `integrity` (SHA-384) ([S5]); SRI semantics ([S30]) |
| Publisher identity | yes | signature over `{pluginId, version}` in trusted comment ([S31]) |
| Not a downgrade | yes | monotonic version inside a signed trusted comment ([S31]) |
| Not yanked / revoked | no | needs last-known-good list; ship it in the host app and refresh opportunistically |
| Published by a specific CI workflow | partially | requires bundle + roots; or accept online ([S32], [S33]) |
| No malicious code | **no** | no mechanism; see 2.5 and [S33] |

---

## 6. Failure containment, contract negotiation, and lifecycle

### 6.1 Error boundaries are necessary but not sufficient

React's error boundary is `static getDerivedStateFromError` plus `componentDidCatch`; it catches *"when some child component (including distant children) throws an error during rendering"* ([S21], [S34]). The caveats are documented and decisive:

- It catches **rendering** errors. It does not catch errors in event handlers, async code, or timers ([S21]).
- In **development**, caught errors *"will bubble up to `window`"*; in production they do not ([S34]).
- Hooks cannot be used in a class boundary, and there is *"no direct equivalent ... for function components yet"*, so you write one class component and reuse it ([S21]).

=> Each plugin mount point needs (a) an error boundary, (b) `window.addEventListener('error')` and `'unhandledrejection'` filters scoped by a plugin tag, and (c) a load timeout. An error boundary alone will not catch a plugin that schedules a bad `setInterval` callback 300 ms after mount.

### 6.2 "Plugin failed to load" UX

Enumerate distinct, separately-actionable states rather than one "failed":

1. **Not installed / missing** - record present, files gone -> offer reinstall.
2. **Integrity failure** - signature or chunk hash mismatch -> do not load; surface "package appears corrupted or tampered"; offer reinstall from catalog.
3. **Contract incompatible** - `peerDependencies`/contract version range unsatisfied -> refuse, explain required host version.
4. **IPC denied** - plugin loaded but its commands are not in a capability -> degrade to read-only UI shell.
5. **Boot timeout** - no `mount` resolution within N ms (single-spa's `timeouts.dieOnTimeout` model, [S11]).
6. **Render crash** - error boundary caught; keep the shell, show crash panel, offer disable.
7. **Post-mount fault** - global handler saw an uncaught error attributed to this plugin.

All seven should be *persisted* per plugin so the disabled/crashed state survives restart, and per the repo's engineering rules that state must live in module-scoped state or `SettingsStore`, **not** a React ref.

### 6.3 Versioned contract negotiation

Three independent version axes, and conflating them is a common bug:

- **Host API/contract version** - semver of the host-to-plugin prop surface and IPC command set. Plugin declares `hostContract: "^2"`; loader refuses mismatches ([S26] semantics).
- **React/Chakra range** - `peerDependencies` ([S26]); the loader can check the resolved versions it is about to hand over.
- **Plugin package version** - for upgrade/downgrade detection, embedded in the signed trusted comment ([S31]).

Negotiation must be **fail-closed and pre-execution**: read the manifest, compare ranges, and only then `import()`. Once the module is evaluated, the code has already run.

### 6.4 Hot disable / enable

Given 1.1 (*no way to manually clear the cache of module namespace objects* [S6]):

- **Disable = unmount + revoke.** Unmount the React root, remove the plugin's `<link>` CSS, drop its DOM, remove its listeners, and mark it disabled. Cheap and safe.
- **Enable = re-import the same URL.** The module is already evaluated; the entry's exported `mount` is called again. Works only if the plugin's module-level code is side-effect-free and its `mount()` is re-entrant. This must be a stated contract requirement ("module top-level must be side-effect free; all state lives inside `mount`").
- **Upgrade = new URL = new module instance.** Installing v2 while v1 is mounted yields two instances (both evaluated, both possibly holding globals). The safe sequence is disable v1, optionally reload the webview, then import v2. Memory for v1's namespace object is not reclaimable; for many plugins this is acceptable, for hot-swapping in one session it is a slow leak.

---

## 7. Option matrix

| Approach | Isolation | Style isolation | Host-API ergonomics | Build complexity | Reflexivity (reuse host React+Chakra?) | Verdict for Fredo |
|---|---|---|---|---|---|---|
| **Single bundle (status quo)** - all apps compiled into one Vite build | none (same realm) | none (global CSS) | trivial (direct imports) | lowest | full | Baseline. Cannot ship apps independently; keep for core applications (`home`, `settings-app`, `app-window`). |
| **ESM + import map (externals + custom scheme)** | none (same realm; **same-origin by definition**) | managed, not enforced (CSS custom-property contract plus scoped selectors) | good: plain props/context, real `invoke()` via preload-exposed bridge | low: `build.lib` + `external` + manifest + one import map | **full** - single React, single Chakra system, single Emotion cache | **Recommended for v1.** Least reinvention, keeps Chakra/theming working, keeps the Rust contract direct. Accept that it is a *trust* boundary, not a *security* boundary. |
| **Module Federation** (`@module-federation/vite`) | none (same realm) | same as ESM | good | high: runtime, manifest, share scope, `uniqueName`, `init()`-once, eager-chunk pitfalls | full, *with automatic negotiation* | Over-engineered for a desktop app with one host. Its one real gift (shared-dep resolution) is replaced by import map plus externals. Reserve as a fallback if plugin count/version skew grows large. |
| **Web Component + Shadow DOM** | cosmetic only (`closed` is *"not a strong security mechanism"* [S12]) | **strong** (one-way CSS isolation) | awkward: attribute-vs-property, manual event wiring on React 18, portals escape the shadow root | medium: wrapper element, dual build | partial - Chakra works only if same instance, and portals break | Useful *inside* the ESM path for a plugin that must not leak styles. Not a standalone loading model. |
| **iframe + `postMessage`/Comlink RPC** | **strong** - separate document, opaque origin, no host DOM/storage/IPC unless granted | complete | poor: async RPC over structured clone; no functions, no DOM, no shared React; theming via CSS vars only | high: RPC schema, preload injection per frame, capability per frame | none (separate realm) | **Recommended for the untrusted tier only.** Correct answer for third-party/community plugins; wrong answer for first-party apps that need the window system and Chakra. |
| **Separate Tauri webview per plugin** (not a frontend-only option) | strongest available (own label -> own capability set [S35]) | complete | RPC like iframe, but native window chrome and independent capability scope | highest (Rust-side) | none | Worth flagging as the only way to get *per-plugin capability scoping* without capability merging [S35]. Out of scope for this report's frontend recommendation; note it as the escalation path. |

**Reading of the matrix:** the choice is not "which micro-frontend framework"; it is **how many trust tiers Fredo wants**. One tier means ESM + import map. Two tiers means ESM + import map for first-party, iframe (or separate webview) for untrusted. Federation, shadow DOM, and single-spa each solve a slice of a problem that the ESM path solves more directly with fewer moving parts.

---

## 8. Principle -> Rationale -> Citation

| Principle | Rationale | Citation |
|---|---|---|
| Own the module graph with exactly one import map, emitted by the host build | Import maps must precede importing scripts, apply only to `import`/`import()`, merge first-wins, and some engines allow only one declaration | [S5] |
| Externalise `react`, `react-dom`, `react/jsx-runtime`, `@emotion/react`, `@chakra-ui/react`; never bundle them | Two React copies means two dispatchers and two Chakra contexts; singleton/react state is why `singleton: true` exists | [S9], [S24], [S26], [S28] |
| Express the React/Chakra range as `peerDependencies` and enforce it before `import()` | Peer deps encode host compatibility without bundling the host; ranges should be as broad as the API allows | [S26] |
| Serve plugin bytes from one host-chosen custom scheme, not `https://` | Tauri warns against remote scripts; scheme origin is platform-split and must be CSP-declared at build time | [S1], [S4] |
| Declare the plugin scheme in the **build-time** CSP, spelled per platform | CSP is compiled in; `my-scheme://localhost` (macOS/iOS/Linux) vs `http://my-scheme.localhost` (Windows/Android) | [S1], [S4], [S7] |
| Do not use `assetProtocol` as the plugin loader | It is disabled today, requires path-glob scope (not plugin identity), needs `asset:`/`http://asset.localhost` in CSP, and `deny`/dot-dir rules are error-prone | [S2], [S3], [S7] |
| Never grant `remote.urls` breadth you do not need; prefer a per-plugin webview if capability scoping matters | Capabilities are per window and multiple capabilities merge; remote access is opt-in | [S35] |
| Make the styling contract **CSS custom properties**, with Chakra components as an optimisation | Chakra emits tokens as CSS vars (semantic tokens always resolve to `var(--...)`); vars inherit across shadow roots and iframes; fits the repo's token-only rule | [S24], [S25] |
| Do not treat Shadow DOM `mode: "closed"` as security | MDN: not a strong security mechanism, evadable; and portals escape the shadow tree | [S12], [S13] |
| Bind the plugin's React root to `mount`/`unmount` with documented teardown and timeouts | Module namespace caching means you cannot truly unload; `unmount` must clean DOM, listeners, globals, subscriptions; `dieOnTimeout` prevents hangs | [S6], [S11] |
| Require side-effect-free module top-level and re-entrant `mount()` | Cached modules are evaluated once and never re-executed; re-import returns the same namespace object | [S6] |
| Verify archive signature (Ed25519/minisign) **before** executing any code, offline | minisign is portable Ed25519, hashed signatures, and supports trusted comments for id/version/downgrade binding | [S31] |
| Pin every plugin chunk hash in the import map `integrity` map | SRI applies to `script`/`link`; import maps extend integrity to dynamically imported modules | [S5], [S30] |
| Check `event.origin`/`source` and use an exact `targetOrigin` on every bridge message | Failure to check origin enables XSS; `*` can leak to an attacker-controlled window | [S16] |
| Keep bridge payloads structured-cloneable; expose callbacks explicitly | Structured clone cannot copy functions/DOM nodes and drops prototypes | [S17], [S18] |
| Wrap every plugin mount in an error boundary **plus** global handlers **plus** a load timeout | Error boundaries catch render errors only; async/timer errors escape them | [S21], [S34], [S11] |
| Fail closed and pre-execution on contract/version mismatch | After `import()` resolves, plugin code has already run | [S6], [S26] |
| Break the lethal trifecta per trust tier (private data x untrusted content x egress) | The combination is what enables exfiltration; remeasure per plugin | [S23] (secondary) |
| Do not rely on provenance as a safety proof | npm: provenance links source/build, "does not guarantee the package has no malicious code" | [S33] |

---

## 9. Recommended loading pipeline

A concrete sequence from "user clicks Install" to "app renders". Each step names the capability it depends on. **First-party tier** in the main path; **untrusted tier** diverges at step 11.

**Install (host, Rust + webview):**

1. **Fetch the package** - `plugin://` is not yet available (not installed), so this is a plain `https://` catalog fetch by Rust (`reqwest`), not the webview. *Not a webview capability; keeps CSP `connect-src` narrow.*
2. **Verify signature** - Ed25519 over the archive using a pinned public key in the app; enforce that the signed trusted comment carries `{pluginId, version, hostContract, sha256}` and that `version` is not below the installed one. *(minisign semantics [S31]; offline.)*
3. **Verify digest** - recompute SHA-256/SHA-384 of the archive and compare with the signed value; compare chunk hashes against the plugin manifest. *(SRI semantics [S30].)*
4. **Resolve contract** - read `manifest.json`: `hostContract`, `peerDependencies` (`react`, `@chakra-ui/react`, `@emotion/react`), entry, CSS, chunk list. Compare against the host's actual versions via semver ([S26]). On mismatch, emit state 3 of 6.2 and abort **before** any code runs.
5. **Materialise on disk** - unpack into an app-owned directory under `$APPDATA`/`$APPLOCALDATA` (a plugin store the host owns), one directory per `pluginId@version`. **Do not** widen `assetProtocol.scope`; the custom scheme handler reads from this store directly. *(Directory override guidance [S7]; asset protocol not used [S2].)*
6. **Register the capability** *(untrusted tier only)* - grant the plugin's origin (per-platform spelling) the minimal command set via a capability with `remote.urls`, or give it its own webview with a narrower capability so scopes do not merge ([S35]). First-party tier: the plugin runs in the main window and inherits the main capability; record that decision explicitly.
7. **Update the import map** *(host, in-memory, before first import)* - add `"@fredo/plugin-<id>" -> plugin://localhost/<id>/<version>/entry.js`, plus `integrity` entries for the entry and every chunk. Because the map is global and first-wins ([S5]), the host should maintain **one** map object it rebuilds and re-injects, or, simpler, encode per-plugin specifier prefixes so additions never collide. Note: adding a *new* map at runtime works only before the specifier resolves; adding a new **scheme** cannot be done at runtime at all.
8. **Preload CSS** *(host)* - insert `<link rel="stylesheet" href="plugin://localhost/<id>/<v>/style.css">` (with `crossorigin` if cross-origin [S30]), await `load`, then import. Vite's lib-mode CSS is a single file per plugin ([S28]).
9. **Import the entry** *(webview)* - `await import("plugin://localhost/<id>/<v>/entry.js")`; the import map plus `integrity` enforce resolution and hashes ([S5], [S6]). Verify the namespace exports the expected lifecycle surface (`bootstrap?`, `mount`, `unmount`) ([S11]).
10. **Check the IPC bridge** *(webview to Rust)* - a single, narrow, preload-exposed facade (e.g. `window.fredo.host.invoke(pluginId, contract, method, args)`) that the **host** validates and forwards to `@tauri-apps/api/core` `invoke`; the plugin never touches `@tauri-apps/api` directly. *(`invoke` semantics [S37]; the repo already forbids static `@tauri-apps/api` imports outside `TauriAdapter.ts`.)*
11. **Render inside the host tree** *(webview)* - the host mounts the plugin's exported React component inside the existing `ChakraProvider value={system}` and the window system, wrapped in an error boundary ([S21]), a plugin-tagged `window.onerror`/`unhandledrejection` filter, and a mount timeout ([S11]).
12. **Record state** - persist `{pluginId, version, status, lastError, disabled}` in `SettingsStore` (not a ref, per repo rules); states 5/6/7 of 6.2 become recoverable across restarts.
13. **Disable/uninstall** - unmount, remove CSS link, remove listeners/globals via the documented teardown, revoke the capability, delete the versioned directory. Remember: the evaluated module stays in memory until window reload ([S6]).

**Untrusted tier delta:** at step 11, instead of mounting in the host React tree, create a sandboxed `<iframe>` pointing at `plugin://localhost/<id>/<v>/frame.html`, with `sandbox="allow-scripts"` (**no** `allow-same-origin`) ([S15]), and speak to it over a `MessageChannel` with Comlink-style RPC ([S18]). Theme is passed as a snapshot of CSS custom-property values (read from `getComputedStyle(document.documentElement)` and posted), not shared objects. Capability is granted only to that frame's origin ([S35]), with the documented Linux/Android caveat that Tauri *"is unable to distinguish between requests from an embedded `<iframe>` and the window itself"*, which means on those platforms the iframe tier is **not** a capability boundary and should be treated as same-trust.

---

## 10. Security analysis

### 10.1 What each isolation level protects against

| Level | Protects against | Does **not** protect against |
|---|---|---|
| **Same-realm ESM module** (recommended for first-party) | Nothing structural. Benefits are process-level: signature plus hash pin catches tampered or download-corrupted packages; error boundaries plus timeouts contain crashes; capability scoping narrows what a *compromised* plugin can ask the backend to do. | Host DOM access, host storage/cookies, prototype pollution of shared builtins ([S19]), reading any in-memory host state (tokens, PATs, workspace paths), direct `invoke` abuse, style bleed. |
| **Web Component + shadow DOM** | Style leakage in both directions ([S12]); DOM structure hidden from `document.querySelectorAll` ([S12]). | All JS access; `mode:"closed"` is explicitly not a security mechanism ([S12], [S13]); events still cross if `composed` ([S14]); portals escape. |
| **iframe, cross-origin, `sandbox="allow-scripts"`** | Host DOM, host storage/cookies/IndexedDB (opaque origin) ([S15]), direct IPC (no host window), prototype pollution in the host realm, main-thread crashes. Enforced by the **same-origin policy**, the platform's only real JS isolation ([S20]). | Anything the RPC bridge allows; network egress unless CSP `connect-src` restricts it; side channels (timing, size); DOM-based attacks inside its own frame; on **Linux/Android** Tauri cannot distinguish iframe requests from the window's ([S35]). |
| **Separate Tauri webview** (escalation) | Everything an iframe gives, plus per-label capability scoping that does not merge with the main window ([S35]). | Webview 0-days (*"does not protect against ... 0-days or unpatched 1-days in the system WebView"* [S35]); supply-chain compromise of the plugin's own dependencies. |

### 10.2 What no level protects against

- **Malicious code that was legitimately signed.** A signature proves *who* and *what*, never *safe* ([S31], [S33]).
- **Dependency compromise inside the plugin.** The plugin's own bundled `node_modules` are outside any host check unless the catalog scans them.
- **Prompt-injection-driven data flow**, if the plugin reads agent output or repo content and can also make requests (2.5, [S23]).
- **Webview engine bugs** ([S35]).

### 10.3 Lethal-trifecta reasoning, applied

Per plugin, score three booleans:

- **P - private data:** can it read workspace files, DB rows, telemetry spans, PATs, or conversation content (via host API or filesystem)?
- **U - untrusted content:** does it ingest repo files, agent output, web pages, telemetry, or user-supplied text that a third party could influence?
- **E - egress:** can it make outbound requests (host bridge method, `fetch`, `<img>` beacon, or a link the user is nudged to click)?

`P && U && E` must be **impossible without an explicit user-visible warning**, and preferably impossible by construction. Give each trust tier one of:

- **no extra egress** - CSP `connect-src` for the plugin's document excludes everything except the backend; the bridge has no `http` verb; or
- **no private data** - the plugin receives only data the user explicitly handed it; or
- **no untrusted ingest** - the plugin declares it does not consume external content (hard to enforce, so prefer the first two).

This is the actionable form of the trifecta: *not* "review the plugin," but "guarantee one leg of the triangle is structurally absent."

Concretely for Fredo, the highest-risk combination is a telemetry/database-flavoured plugin: it has DB access (P), ingests agent/tool output that third parties can influence (U), and can reach the network (E). Such a plugin should be forced into the iframe tier **or** given an IPC surface with no network verb.

---

## 11. Sources

All URLs fetched during this research unless marked otherwise.

| # | URL | What it supports | Fetched? |
|---|---|---|---|
| S1 | https://docs.rs/tauri/latest/tauri/struct.Builder.html#method.register_uri_scheme_protocol | `register_uri_scheme_protocol` / `register_asynchronous_uri_scheme_protocol`; the platform origin split (`scheme://localhost` vs `http://scheme.localhost`); CORS/`Access-Control-Allow-Origin` note | fetched |
| S2 | https://v2.tauri.app/reference/javascript/api/namespacecore/ | `convertFileSrc(filePath, protocol='asset')`; asset protocol must be enabled + scoped + CSP-allowed; `invoke`, `Channel`, `isTauri`, `transformCallback` | fetched |
| S3 | https://v2.tauri.app/security/asset-protocol/ | `assetProtocol.scope` as `FsScope` (array or `{allow,deny,requireLiteralLeadingDot}`), `deny` precedence, dot-dir rules, `$VAR` patterns | fetched |
| S4 | https://v2.tauri.app/security/csp/ | CSP configured per app; local scripts hashed, external scripts nonce'd; explicit warning against remote scripts/CDNs; `'wasm-unsafe-eval'` note | fetched |
| S5 | https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/script/type/importmap | import map syntax (`imports`/`scopes`/`integrity`); must precede importing scripts; only affects `import`/`import()` in documents; global merge, first-wins; baseline March 2023; single-declaration caveat | fetched |
| S6 | https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/import | `import()` semantics, sealed null-prototype namespace, rejection causes, aggressive caching, cannot clear module map, query-string workaround leaks | fetched |
| S7 | https://v2.tauri.app/reference/config/ | Defaults: `assetProtocol {enable:false, scope:[]}`, `withGlobalTauri:false`, `pattern:{use:"brownfield"}`; capability merge semantics; `appDirectoriesOverride` security notes | fetched |
| S8 | https://webpack.js.org/concepts/module-federation/ | Container model; async-only remote loading; share scopes and version resolution; `uniqueName` collisions; documented troubleshooting failures | fetched |
| S9 | https://webpack.js.org/plugins/module-federation-plugin/ | `shared` hints: `singleton`, `requiredVersion`, `strictVersion`, `eager`, `shareKey`, `shareScope`; React/ReactDOM singleton rationale | fetched |
| S10 | https://module-federation.io/integrations/build-tool/vite.html | `@module-federation/vite` on Vite 5-8; `type:'module'` remotes; `shared.singleton`; `experiments.hostProvidesAllShared` resolving shared deps via native import map (and its limits) | fetched |
| S11 | https://single-spa.js.org/docs/building-applications/ | Lifecycle contract (`bootstrap`/`mount`/`unmount`/optional `unload`), lifecycle props, cleanup obligations, per-app `timeouts` with `dieOnTimeout` | fetched |
| S12 | https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_shadow_DOM | Shadow DOM style encapsulation both directions; `mode:"open"` exposes `shadowRoot`, `closed` returns null but is *"not a strong security mechanism"* | fetched |
| S13 | https://developer.mozilla.org/en-US/docs/Web/API/Element/attachShadow | `attachShadow` options (`mode`, `delegatesFocus`, `clonable`, `slotAssignment`); closed root still reachable if you keep the reference | fetched |
| S14 | https://developer.mozilla.org/en-US/docs/Web/API/Event/composed | Only UA-dispatched UI events are composed; propagation requires `bubbles`; `composedPath()` differences | fetched |
| S15 | https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe | Nested browsing context; same-origin scripting limits; `sandbox` token semantics; `allow-scripts`+`allow-same-origin` warning; memory cost | fetched |
| S16 | https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage | Cross-origin messaging; structured-clone serialization; targetOrigin must be exact; origin/source verification or XSS | fetched |
| S17 | https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm | What cannot be cloned (functions, DOM nodes); prototypes not walked; supported types | fetched |
| S18 | https://github.com/GoogleChromeLabs/comlink | Comlink as `postMessage` RPC; async proxies; `Comlink.proxy` for callbacks; event transfer handlers; `windowEndpoint` for iframes; `releaseProxy` | fetched |
| S19 | https://developer.mozilla.org/en-US/docs/Web/Security/Attacks/Prototype_pollution | Prototype pollution mechanics and blast radius (`fetch()` defaults, `srcdoc`); defenses: freeze/seal, null-prototype objects, schema validation, SES | fetched |
| S20 | https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy | Origin tuple definition; cross-origin script API access limits; storage partitioning; postMessage as the sanctioned channel | fetched |
| S21 | https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary | Error boundaries: `getDerivedStateFromError` + `componentDidCatch`; dev-vs-prod bubbling; no hook equivalent | fetched |
| S22 | https://react.dev/reference/react/Component | Class component lifecycle context for the boundary pattern (same page, broader reference) | fetched |
| S23 | https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/ | Lethal trifecta: private data + untrusted content + external communication; guardrails unreliable | fetched - **secondary/blog** |
| S24 | https://chakra-ui.com/docs/theming/overview | `defineConfig` -> `createSystem` -> `ChakraProvider value={system}`; `cssVarsRoot` default `:where(:root, :host)`; `cssVarsPrefix`; `strictTokens`; `system.token`/`token.var` returning `var(--...)` for semantic tokens; recipes | fetched |
| S25 | https://chakra-ui.com/docs/theming/customization/css-variables | Token CSS variables emitted at a configurable root and prefix; example `--chakra-colors-*` output | fetched |
| S26 | https://docs.npmjs.com/cli/v10/configuring-npm/package-json#peerdependencies | `peerDependencies` semantics for plugins; not auto-installed historically, auto in npm v7+; recommendations on range breadth; `peerDependenciesMeta` | fetched |
| S27 | https://v6.vite.dev/config/build-options.html | Vite 6 build options: `build.lib`, defaults `['es','umd']`/`['es','cjs']`, `cssCodeSplit` false in lib mode, `assetsInlineLimit` ignored, `manifest`, target `'modules'`, minify `'esbuild'` | fetched |
| S28 | https://vite.dev/config/build-options.html | Current Vite build options (Vite 8): `build.lib` incl. `cssFileName`, `manifest`, `assetsInlineLimit` ignored in lib mode, `cssCodeSplit`, target `'baseline-widely-available'`, minify `'oxc'` | fetched |
| S29 | https://vite.dev/guide/build.html | Library mode guidance; externalise `react`/`vue`; `rolldownOptions.external`; ES+UMD single entry / ES+CJS multi entry; single CSS file output; `package.json` `exports` for `./style.css`; `vite:preloadError` | fetched |
| S30 | https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Subresource_Integrity | SRI algorithm, `sha256/384/512`, strongest-hash-wins, applies to `script` and `link[rel=stylesheet|preload|modulepreload]`, CORS + `crossorigin` required, `no-cors` SRI blocked, `Integrity-Policy` | fetched |
| S31 | https://jedisct1.github.io/minisign/ | minisign/Ed25519; `-G`/`-Sm`/`-Vm`; hashed signature format; trusted comments for id/version/timestamps to prevent downgrade | fetched |
| S32 | https://docs.sigstore.dev/cosign/verifying/verify/ | `cosign verify`/`verify-blob --bundle`; keyless OIDC identity+issuer; key-based `--key cosign.pub`; bundle format supports offline verification | fetched |
| S33 | https://docs.npmjs.com/generating-provenance-statements | npm provenance via Sigstore; requires cloud CI/CD runner; `npm audit signatures`; explicit limit: provenance does not guarantee absence of malicious code | fetched |
| S34 | https://react.dev/reference/react/Component#componentdidcatch | `componentDidCatch` semantics/caveats (paired with S21) | fetched |
| S35 | https://v2.tauri.app/security/capabilities/ | Capabilities per window/webview; merge behavior; **remote API access is opt-in via `remote.urls`**; what capabilities do not protect against; Linux/Android iframe indistinguishability | fetched |
| S36 | https://v2.tauri.app/security/http-headers/ | Configurable response headers list (incl. COOP/COEP/CORP/Permissions-Policy); CSP is not configured here; per-framework header setup | fetched |
| S37 | https://v2.tauri.app/reference/javascript/api/namespacecore/ | `invoke(cmd, args, options)`, `Channel`, `isTauri()`, `transformCallback` (the backend `eval`s the callback), which is the IPC surface a bridge must wrap | fetched |
| S38 | https://v2.tauri.app/reference/webview-versions/ | WebView2/Chromium on Windows, WKWebView on macOS, WebKitGTK on Linux; version tied to OS/distro | fetched |
| S39 | https://v2.tauri.app/concept/inter-process-communication/isolation/ | Isolation pattern (iframe + SubtleCrypto/AES-GCM IPC interception); its limitation: *"newer mechanisms such as ES Modules will not successfully load"* inside the isolation iframe | fetched |

---

## 12. Open questions (max 8)

1. **Capability model for plugins:** is one merged capability for the main window acceptable for first-party plugins, or does every plugin get its own webview so capability scopes stay disjoint ([S35])? The latter is a Rust/architecture decision this report cannot make.
2. **Scheme spelling budget:** can the host ship with `script-src` covering both `plugin:` and `http://plugin.localhost` from day one ([S1], [S4])? If not, the Windows tier needs a separate release.
3. **Whether plugins need true unload:** 1.1 says module caching is permanent ([S6]). Is "disable plus reload window on upgrade" acceptable UX, or does the product require in-session hot-swap (which will leak module namespace objects)?
4. **Chakra contract:** does the plugin API expose Chakra components at all, or only CSS custom properties ([S24], [S25])? This decides whether `@chakra-ui/react` must be a hard `peerDependency` and therefore an import-map entry.
5. **Import-map mutability:** given first-wins/global merge ([S5]), is one host-owned map rebuilt on every install (risking losing already-resolved specifiers) acceptable, or should the host pre-declare a specifier *prefix* per plugin (`@fredo/plugin-<id>/...`) so no map mutation is ever needed?
6. **Integrity granularity:** can the plugin manifest enumerate **every** emitted chunk hash reliably (including dynamic imports), enough to populate the import-map `integrity` map ([S5], [S30])? Vite's manifest gives non-hashed-to-hashed mapping ([S28]) but not necessarily all transitive dynamic chunks.
7. **Trust tiering policy:** is a two-tier (first-party ESM / third-party iframe) model acceptable, and who assigns the tier - the catalog, the plugin author, or the user at install time ([S23])?
8. **Signing key custody:** one app-wide Ed25519 key, a per-publisher key with a pinned publisher registry, or Sigstore keyless ([S31], [S32])? This determines whether the host needs an offline key registry and revocation list.

---

## 13. Summary (as requested)

**Recommended loading model:** ESM + a single host-owned import map. Plugins are built with Vite library mode (`formats: ['es']`, `base: './'`, `build.manifest`), externalising `react`, `react-dom`, `react/jsx-runtime`, `@emotion/react`, `@chakra-ui/react`. The host serves plugin files from one custom scheme registered in Rust (`plugin://localhost/<id>/<version>/...`), declared in the build-time CSP in its per-platform spelling, and loads them with `await import(specifier)`. Lifecycle is the single-spa trio (`mount`/`unmount`, optional `bootstrap`, with timeouts), and all IPC goes through one narrow host facade that plugin code never bypasses.

**Recommended isolation level:** *no JS isolation for first-party plugins* (same realm, signed + hash-pinned, capability-scoped, error-bounded), and *iframe with `sandbox="allow-scripts"` and no `allow-same-origin`, bridged with Comlink-style RPC* for anything not first-party. Do not adopt Module Federation, and do not treat shadow DOM as security.

**Top 3 things that will bite us:**
1. **CSP is baked in and platform-split.** The scheme must be declared at build time and spelled `plugin:` on macOS/Linux but `http://plugin.localhost` on Windows ([S1], [S4]); any later scheme change is a host release.
2. **Modules cannot be unloaded.** `import()` caching is permanent and module namespace objects are never GC-able ([S6]), so "hot disable/enable" is really "unmount + re-mount the same instance," and every upgrade is a new instance that leaks the old one until window reload.
3. **The Rust contract is not free.** Plugins loaded from a non-bundled origin are denied IPC by default and need `remote.urls` opt-in ([S35]); first-party plugins inherit the main window's merged capability surface, so "just add it to the main window" quietly grants the whole backend, and the temptation to solve that with `assetProtocol` globs walks straight into scope/`deny`/dot-dir misconfiguration ([S3]).

Two honourable mentions: React 18 (not 19) makes any Web-Component detour painful and Chakra portals escape shadow roots ([S12], [S14]); and signature verification proves provenance, never safety - the lethal-trifecta check (10.3, [S23]) is the only thing that actually bounds an installed plugin.
