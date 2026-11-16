# Fredo Application Plugin Seams

**Date:** 2026-11-12
**Method:** Static analysis of the repository at commit `9c38626110ef406ad3dd80c5e77f84617e88c16f` (`9c38626`, "tests(fredo-health-led): update smoke.md"). Every claim below is traceable to a `file:line` in that tree. Inferences are explicitly labelled **{inference}**. No product code was modified.

**Scope requested:** inventory every seam an in-tree application (`apps/ui/src/applications/*`) depends on, in order to assess making them runtime-installable packages plugged into the Rust backend "via contracts".

---

## Executive Summary

1. **Registration is a module-load side effect, not a declared contract.** `allApplications.ts:5` eagerly globs `./*/index.ts` (`import.meta.glob(..., { eager: true })`), and each app's `index.ts` calls `registerApplication(instance)` at import time (e.g. `mission-monitor/index.ts:24`, `database-client/index.ts:31`, `terminal/index.ts:6`). There is no manifest, no loader, no lifecycle owner — the host *is* the bundler.
2. **The app base class is already a small, clean contract** (`FredoApplicationClass.ts:51-192`): 4 abstract members (`id`, `name`, `icon`, `render`), 4 optional override members (`gridConfig`, `showable`, `isMultiWindow`, `hasSettings`/`renderSettings`), 3 host-registered callbacks, and 2 lifecycle hooks. This is the single most contract-shaped seam in the system.
3. **The hardest seam is the shared runtime, not the class.** Apps reach into `@/shared/*` at *module scope and React-hook level*, not through a host API object: `useWindowActions` (provider context, `useWindowActions.ts:17-23`), `useStream` (StreamContext, `StreamContext.tsx:93-99`), `useTheme` (ThemeProvider context, `ThemeProvider.tsx:75-79`), `useEventRows` (module-scoped row store + `adapterBridge`), plus 7 `shared/*` modules that import *back* into `applications/*` (see §3b), creating a bidirectional package graph.
4. **Data access is the most mature "plugin API"** — and it is already a contract: six backend commands `application_data_{read,watch,unwatch,write,delete,declare}` (`commands.rs:878-925`) with a typed frontend client (`client.ts:173-227`), a declaration schema validated backend-side (`declaration.rs:282-465`), and per-app physically namespaced tables `feature_<appId>_<table>` (`application_store.rs:236-262`). A third-party app *can* declare its own tables **if** it declares them at boot.
5. **Navigation/companion is a second contract-shaped seam**, and it is almost entirely *data*: a `Surface` object (`missionMonitorSurface.ts:301-314`, `wireframeSurface.ts:1777`, `terminalSurface.ts:401`, `databaseClientSurface.ts:550`, `devModeSurface.ts:304`, `windowSystemSurface.ts:150`) validated by `validateSurface()` (`validation.ts:485`) and funneled through one `dispatch()` (`dispatch.ts:451-491`). But the app must also mount a React provider that registers the host (`hostRegistry.ts:58`) and the app retains live callbacks in module scope.
6. **Keyboard state is a HARD BLOCKER for true out-of-tree modules only if the module is loaded as separate JS** — global keys live in `shared/navigation/ui/globalKeys.ts` (one `document` listener, `:162-167`) and window traversal in `shared/window-system/traversal.ts`; an app that shipped its own copy of `@/shared` would create a *second* dispatcher and second module-scoped stores. {inference} A single shared runtime (import-map / externalised host module) is required.
7. **`adapterBridge` is the one IPC seam and it is app-agnostic**, but it is a *singleton module* registered once at boot (`apps/ui/src/main.tsx:27-39`, `apps/tauri/src/main.tsx:22-36`). Command names are **flat, not per-app namespaced** (`lib.rs:909-1121`, ~116 entries: `db_*`, `terminal_*`, `wireframe_*`, `application_data_*`, `llm_*`, …), so a third-party app cannot add commands without editing `lib.rs`.
8. **Settings/theming/window-system are host-owned with app-facing hooks**, not app-owned: `SettingsSurface.tsx:121-126` auto-discovers `hasSettings`; theming is `ThemeProvider` writing CSS vars on `document.documentElement` (`ThemeProvider.tsx:322-351`); per-app window presentation is a host store + control-setting cache (`appPresentationStore.ts:42-46`, `controlSettingAccessor.ts:27-34`).
9. **Styling/build coupling is significant.** All apps import Chakra (`@chakra-ui/react`), `react-icons`, and some CSS modules (`MonitorNode.module.css` 204 lines) or third-party CSS (`reactflow/dist/style.css`, `MissionMonitorPanel.tsx:13`). Aliases are `@` → `src` (`vite.config.ts:11-14`, `tsconfig.json:18-20`); a Vite build of an app in isolation must reproduce the alias, the Chakra system, and theme CSS vars — otherwise it renders unstyled or throws `use* must be used within a Provider`.
10. **Complexity is real, not a demo.** `wireframe` 9,805 LOC / 32 test files, `mission-monitor` 9,025 / 27, `database-client` 6,584 / 21, `terminal` 4,333 / 8. These are genuine applications with heavy external deps (`reactflow`, `konva`/`react-konva`, `ghostty-web`, `three`, `framer-motion`).
11. **The hardest blockers for a frontend package are:** (a) React 18 provider-context hooks that an out-of-tree bundle cannot satisfy without the host exposing the provider instances; (b) module-scoped singleton stores (row store, window store, navigation host registry, application-data store) that assume a single copy; (c) `import.meta.glob` discovery that requires the source to be present at host build time.
12. **The most tractable path (evidence-derived, not a design):** treat the app class contract + `Surface` declaration + `ApplicationDataDeclaration` + a new host-provided "runtime API" object (wrapping `adapterBridge`, `useEventRows`, `useApplicationWatch`, `useWindowActions`, theme tokens) as the externalised contract, loaded via a host-owned module loader — because those are already the only seams that cross the app/host boundary *as data or typed calls*.

---

## Coupling Inventory

### 1. Registration & discovery

| Evidence | What it shows | Implication for third-party apps |
|---|---|---|
| `allApplications.ts:1-5` | `import.meta.glob('./*/index.ts', { eager: true })` — the comment says "To add a new feature, just create a folder under applications/ with an index.ts that calls registerApplication()." | App must exist inside the host source tree at host build time. Not runtime-installable. |
| `applicationRegistry.ts:22` | `const _registry: FredoApplicationClass[] = []` | Single module-scoped array. A separately bundled app importing its own copy registers into *its own* array, invisible to the host. |
| `applicationRegistry.ts:34-38` | `registerApplication` = plain `_registry.push(feature)` then notifies listeners | No dedupe at registration; no manifest; no validation of `id` uniqueness. |
| `applicationRegistry.ts:40-42` | `getApplications()` returns the **live** array reference | Callers can mutate the registry; ordering is import order. |
| `applicationRegistry.ts:48-53` | `subscribeApplications(listener)` — subscription fires AFTER the push | The only "registration event" a loader could hook today. Used only by the companion publisher (`publisher.ts:115`). |
| `applicationRegistry.ts:81-89` | `dedupeByApplicationId` — first-wins by `id`, never by `name` | Double registration is tolerated; a runtime loader could register twice safely. |
| `Home.tsx:13` | `import '../../allApplications'` — side-effect import inside Home | Registration happens when the Home module graph evaluates. |
| `Home.tsx:26` | `const ALL_FEATURES = getApplications()` — captured **at module scope**, i.e. at Home module evaluation | A feature registered *after* Home's module evaluation would not be in `ALL_FEATURES`. {inference} A runtime install must re-read or extend this. |
| `Home.tsx:32` | `SHOWABLE_FEATURES = dedupeByApplicationId(ALL_FEATURES.filter(f => f.showable))` | Launcher grid + keyboard nav indices are index-aligned to this snapshot. |
| `Home.tsx:54-65` | On mount, loops `ALL_FEATURES` registering open callbacks and calls `declareAllRegisteredApplicationData()` | Boot-time lifecycle assumptions; data declarations materialized once. |
| `Home.tsx:152-189` | `openFeatureWindow` builds window params from `feature.gridConfig`, calls `feature.render()`, registers close/open/rerender callbacks, defers `onMount` with `setTimeout(...,0)` | Host owns the open lifecycle; app only supplies `render` + hooks. |
| `StandaloneAppWindow.tsx:34-38` | Side-effect `import '../allApplications'` — the `?view=app` window re-triggers registration | Registry is per-webview module instance; every window re-imports all apps. |
| `StandaloneAppWindow.tsx:59-66` | `resolveStandaloneFeature` resolves by `id` from `getApplications()`, requires `showable` | `id` is the routing key for native windows. |
| `StandaloneAppWindow.tsx:86-102` | Calls `onMount`/`onUnmount` for lifecycle parity with Home | Lifecycle hook contract is real and used in two places. |
| `retainedApplicationSet.test.ts:22-31,40-58` | Pins the exact 8 retained registered ids and their `showable` flags | Adding a runtime app would break this test unless it is updated. {inference} An install registry must be separate from this pinned set. |
| `apps/ui/src/index.ts:88` | `export { FredoApplicationClass }` — the only registered-app type exported from the package eponymous module | Public API surface is minimal; third-party apps would need much more exported. |

**Ordering / lifecycle assumptions:**
- Apps self-register at import; the host snapshots the list at Home module evaluation (`Home.tsx:26`), so registration must complete before Home renders.
- `registerOpenCallback` is registered eagerly for every feature (`Home.tsx:54-59`) and re-registered on each open (`Home.tsx:174-176`).
- `onMount` is deferred one macrotask (`Home.tsx:183-188`) explicitly so "AppProvider's useEffect has time to register the adapterBridge" (comment `:182`).
- `hasSettings` discovery is *render-time*, not boot-time (`SettingsSurface.tsx:118-126`), so settings can appear later than the launcher snapshot.

---

### 2. The app base contract (`FredoApplicationClass`)

Every member, with the call sites that consume it:

| Member | Definition | Kind | Called by |
|---|---|---|---|
| `id: string` | `FredoApplicationClass.ts:58` | abstract | `Home.tsx:164`, `appIdentity.ts:94`, `StandaloneAppWindow.tsx:64`, `StandaloneAppWindow.tsx:133` (`data-fredo-app-id`), `useAppOpenRequests`, `appPresentationStore.ts:113`, `SettingsSurface.tsx:206` |
| `name: string` | `FredoApplicationClass.ts:63` | abstract | `Home.tsx:155` (window title), `LauncherShell.tsx:844`, `SettingsSurface.tsx:206`, `appIdentity.ts` (display-name matcher) |
| `icon: IconType` | `FredoApplicationClass.ts:68` | abstract (`react-icons` type) | `Home.tsx:156` (`React.createElement(feature.icon,{size:16})`), `SettingsSurface.tsx:204-206` |
| `render(props?)` | `FredoApplicationClass.ts:74` | abstract | `Home.tsx:157`, `Home.tsx:179`, `StandaloneAppWindow.tsx:141` |
| `gridConfig` | `FredoApplicationClass.ts:82-85` (`{closable,maximizable}`, default true/true) | default override | `Home.tsx:158-160` |
| `showable` | `FredoApplicationClass.ts:92` (default `true`) | default override | `Home.tsx:32`, `appIdentity.ts:94`, `StandaloneAppWindow.tsx:65`, `AppPresentationSettings.tsx:225`, `composerTarget.ts:137`, `CompanionComposer.tsx:91` |
| `isMultiWindow` | `FredoApplicationClass.ts:99` (default `false`) | default override | `AppPresentationSettings.tsx:364` (disables presentation choice); `appPresentationStore.ts:113` |
| `hasSettings` | `FredoApplicationClass.ts:107` (default `false`) | default override | `SettingsSurface.tsx:123` |
| `renderSettings?()` | `FredoApplicationClass.ts:118` | optional method | `SettingsSurface.tsx:123`, `:249` |
| `registerRerenderCallback(cb)` | `FredoApplicationClass.ts:145-147` | host-injected | `Home.tsx:178-180` |
| `registerCloseCallback(cb)` | `FredoApplicationClass.ts:152-154` | host-injected | `Home.tsx:166-170` |
| `registerOpenCallback(cb)` | `FredoApplicationClass.ts:161-169` (one-shot wrapper) | host-injected | `Home.tsx:56`, `Home.tsx:174` |
| `openSelf()` | `FredoApplicationClass.ts:175-177` (protected) | app-callable | Referenced in `TerminalFeature.tsx:23` comment; `setup/SetupFeature.tsx:15` uses `this.onCloseRequested` |
| `onMount?()` | `FredoApplicationClass.ts:185` | optional lifecycle | `Home.tsx:184`, `StandaloneAppWindow.tsx:88` |
| `onUnmount?()` | `FredoApplicationClass.ts:191` | optional lifecycle | `Home.tsx:167`, `StandaloneAppWindow.tsx:95` |

Supporting types: `types.ts:11-14` (`GridItemConfig`), `types.ts:20-23` (`GridItem`, seemingly unused by the class). `EventSubscription.ts` is exported through `shared/classes/index.ts` but is a *wire type* module, not app lifecycle.

**Concrete feature classes** (evidence that the contract is small in practice): `MissionMonitorFeature.tsx:8-32`, `TerminalFeature.tsx:8-34` (also `hasSettings` + `renderSettings`), `DatabaseClientFeature.tsx:708-724`, `WireframeFeature.tsx:16-34`, `ThemingFeature.tsx:12-25` (non-showable, `render` returns a Fragment, only `renderSettings` matters), `SettingsFeature.tsx:20-29`, `SetupFeature.tsx:8-15` (uses `this.onCloseRequested` inside `render`), `DevModeFeature.tsx:7-18` (non-showable).

**Reading:** the base class is a viable plugin ABI *as a TypeScript interface*, with two problems: `icon: IconType` binds to the `react-icons` package type, and `render()` returns a live React element from the app's module graph (see §8).

---

### 3. Shared-platform dependencies of representative apps

Method: extracted every non-local import specifier from each app folder (excluding `__tests__`).

#### 3a. Import inventory (representative apps)

**`mission-monitor`** (external: `@chakra-ui/react`, `react`, `reactflow`, `react-icons`; `vitest` in tests):

| Imported module | Capability provided | Category |
|---|---|---|
| `shared/classes` (FredoApplicationClass) | app base contract | (b) platform contract |
| `shared/classes/EventSubscription` | `ChatRow`/`ToolUseRow` wire types | (b) data contract (types) |
| `shared/contexts/StreamContext` (`useStream`) | stream health `isConnected` | (c) React-context hook |
| `shared/hooks/useApplicationData` (`useApplicationRead`, `useApplicationWatch`) | declared-table read/watch | (b) platform service + (c) hook |
| `shared/application-data/{client,registry,declaration}` | data IPC + key derivation + declaration type | (b) data contract |
| `shared/hooks/usePersistedSetting` | KV persistence | (b) platform service + (c) hook |
| `shared/navigation` (`validateSurface`) + `shared/navigation/ui` (`getNavigationHost`) | surface validation + host lookup | (b) platform service |
| `shared/companion/composerBridge` | open the companion composer | (b) platform service (module pub/sub) |
| `shared/utils/colorTint` (`tint`) | theme-safe tinting | (a) UI primitive |
| `shared/utils/adapterBridge` | generic IPC invoke | (b) platform transport |
| `shared/window-system/useWindowActions` | resize/maximize own window | (c) React-context hook |
| `shared/navigation/focusContext` (`isTextControl`) | key-adapter guard | (b) platform utility |
| `reactflow` | graph canvas | external npm |
| `MonitorNode.module.css` | node styling | CSS module (build-coupled) |

**`database-client`** (external: `@chakra-ui/react`, `react`, `react-icons/lu`):

| Imported module | Capability | Category |
|---|---|---|
| `shared/classes` | app base contract | (b) |
| `shared/companion/composerBridge` | companion composer open | (b) |
| `shared/hooks/usePersistedSetting` | prefs/history persistence | (b)+(c) |
| `shared/navigation/focusContext` | key guard | (b) |
| `shared/utils/adapterBridge` | `db_*` IPC | (b) |
| `shared/utils/colorTint` | tint | (a) |
| `applications/settings` (`settingsService`) | KV store | (b) platform service |
| `applications/settings/SettingsSaveContext` (`useSettingsSave`) | unified save footer | (c) host React context |
| `shared/application-data/*` (via `databaseClientSurface` types) | — | (b) |

**`terminal`** (external: `@chakra-ui/react`, `react`, `ghostty-web`, `react-icons`):

| Imported module | Capability | Category |
|---|---|---|
| `shared/classes` | base contract | (b) |
| `shared/companion/composerBridge` | composer | (b) |
| `shared/navigation/ui/terminalPassthrough` | PTY keyboard passthrough | (b) |
| `shared/utils/adapterBridge` | `terminal_*`, `*_pty_*` IPC | (b) |
| `shared/utils/colorTint` | tint | (a) |
| `applications/settings` + `SettingsSaveContext` | KV + unified save | (b)+(c) |
| `presentation.ts` → `shared/window-system/appPresentationStore` | per-app window mode | (b) |
| `ghostty-web` (`init`, `Terminal`, `FitAddon`) | terminal emulator | external npm |

**`wireframe`** (external: `@chakra-ui/react`, `konva`, `react`, `react-dom`, `react-icons`, `react-konva`):

| Imported module | Capability | Category |
|---|---|---|
| `shared/classes` | base contract | (b) |
| `shared/companion/composerBridge`, `useAppCommandIntent` | companion intent drain | (b)+(c) |
| `shared/navigation` (full barrel), `focusContext` | surface + key guard | (b) |
| `shared/utils/adapterBridge` | `wireframe_*` file IPC | (b) |
| `shared/utils/colorTint` | tint | (a) |
| `react-konva`/`konva` | canvas editor | external npm |
| lazy `import('./WireframeCanvasImpl')` (`WireframeCanvas.tsx:21`) | canvas code split | build-coupled (Vite lazy chunk) |

**`settings-app`** (external: `@chakra-ui/react`, `react`, `react-icons/lu`):

| Imported module | Capability | Category |
|---|---|---|
| `shared/components/companion/CompanionSettingsPanel` | companion settings pane | (a) host UI component |
| `shared/navigation/keys`, `shared/navigation/ui` | key model + rail primitives | (b) |
| `shared/utils/{adapterBridge,colorTint,selectStyles}` | IPC/tint/select styles | (b)/(a) |
| `shared/window-system/{appWindows,useWindowActions,windowStore}` | per-app window control | (b)+(c) |
| `applications/{settings,home,ingest,setup,theming}` — **cross-app imports** | static sections | HARD cross-app coupling |
| `applications/shared/classes` | base contract | (b) |

**`theming`** (external: `@chakra-ui/react`, `react`, `react-icons/lu`):

| Imported module | Capability | Category |
|---|---|---|
| `app/providers/ThemeProvider` (`useTheme`) | live theme tokens + presets | (c) **upward app→app-provider import** |
| `app/types/theme` (`ThemeOverrides`) | theme type | (b) |
| `shared/utils/selectStyles` | select chrome | (a) |
| `shared/classes/FredoApplicationClass` | base contract | (b) |

#### 3b. Cross-app import graph (evidence for "apps are not isolated")

| From app | To app | file:line |
|---|---|---|
| database-client | settings | `DatabaseClientSettings.tsx:8`, `lib/storage.ts:13`, `lib/useDbClientLayout.ts:18` |
| mission-monitor | settings | `DetailPanel.tsx:10` (`serializeValue`) |
| terminal | settings | `NewSessionDialog.tsx:3`, `settings.ts:1`, `TerminalSettings.tsx:3-4` |
| home | dev-mode | `Home.tsx:12` |
| home | postgres | `Home.tsx:22` (`PgRecoveryBanner`) |
| home | settings | `backgroundStore.ts:32`, `TelemetrySettings.tsx:15` |
| ingest | settings | `ingestAutostartStore.ts:16` |
| settings-app | home, ingest, postgres, settings, setup, theming | `SettingsSurface.tsx:5-9`, `PostgresSettings.tsx:61` |

And the reverse direction — **`shared/*` importing `applications/*`** (a bidirectional package cycle):

| shared module | imports from applications | file:line |
|---|---|---|
| `shared/companion/publisher.ts` | `applications/applicationRegistry` | `:28` |
| `shared/components/companion/CompanionComposer.tsx` | `applications/applicationRegistry` | `:22` |
| `shared/components/companion/CompanionEntity.tsx` | `applications/applicationRegistry` | `:44` |
| `shared/hooks/usePersistedSetting.ts` | `applications/settings` | `:10` |
| `shared/utils/patStorage.ts` | `applications/settings` | `:11` |
| `shared/window-system/appPresentationStore.ts` | `applications/applicationRegistry` | `:37` |
| `shared/window-system/zoneLayoutStore.ts` | `applications/settings` | `:33` |
| `app/providers/ThemeProvider.tsx` | `applications/home/.../lifeConstants` | `:26` |

**Reading:** the package graph is not layered. `shared` depends on `applications` for settings and the registry; `applications` depend on `shared` for everything; some apps depend on each other. A plugin boundary must first cut these cycles (or expose the shared side as a host module the app imports).

---

### 4. Keyboard / navigation contract

**What the host provides / owns:**

| Element | Evidence |
|---|---|
| `Surface` type: `{ tree: PlaceTree, verbs: VerbDescriptor[], companion: {appName,description}\|null }` | `navigation/types.ts:291-295` |
| `PlaceTree`: `{appId, root, places[], directAliases}` | `navigation/types.ts:185-190` |
| `PlaceNode`: `{id,label,parent,transient,sticky,cursor,operator,keys,entryHooks,exitHooks}` | `navigation/types.ts:171-182` |
| `VerbDescriptor`: id/title/description/appliesTo/args/available/risk/aliases/run/undo?/consequence?/externalParty?/publish | `navigation/types.ts:266-288` |
| `ContextSnapshot`: `{appId, placePath, selection, dirty}` | `navigation/types.ts:225-230` |
| 12 validation rules V-01…V-12 + `validateSurface()` | `validation.ts:48-94`, `validation.ts:485` |
| One dispatch funnel `dispatch(deps, intent)` / `createDispatcher` | `dispatch.ts:451-491`, deps `:50-67` |
| Host factory `createNavigationHost({surface,getContext,journal?,now?,applyPatch?,confirm?,overlayOpen?})` | `ui/host.ts:71-89`, `:212` |
| `NavigationHost` interface (getSnapshot, subscribe, describeContext, refreshContext, runIntent, handleStroke, runVerb, undoLast, undoEntry, openMap, closeMap, reset) | `ui/host.ts:121-166` |
| Module-scoped host registry `registerNavigationHost` / `getNavigationHost` / `listRegisteredSurfaces` | `ui/hostRegistry.ts:58-92` |
| One global chord listener (`document.addEventListener('keydown', listener, true)`) — installed once by `NavigationProvider` | `ui/globalKeys.ts:162-167`; mounted in `main.tsx` (`NavigationProvider`) |
| Shared UI: `CommandRail`, `NavigationMap`, `ActivityTrail`, `NavigationAnnouncer` | `ui/index.ts:23-38` |

**What the app provides:**

| Element | Evidence |
|---|---|
| A pure `Surface` declaration file | `missionMonitorSurface.ts:301-314`; `databaseClientSurface.ts:550`; `terminalSurface.ts:401`; `devModeSurface.ts:304`; `wireframeSurface.ts:1777`; `windowSystemSurface.ts:150` |
| A module-scoped handler set the verbs delegate to | `missionMonitorSurface.ts:70-93` (`setMissionMonitorActionHandlers`), `databaseClientSurface.ts:105-132` |
| A React provider that creates the host in `useMemo`, registers it in a mount effect, and mounts ONE element-scoped `onKeyDown` adapter | `MissionMonitorNavigationProvider.tsx:128-141` (host), `:145-155` (register), `:186-208` (key adapter) |
| Selection publication through `host.refreshContext()` (value-keyed, no poll) | `MissionMonitorNavigationProvider.tsx:178-184` |
| App-side intent drain hook mount | `useAppCommandIntent.ts:220`; mounted at `WireframeEditor.tsx:86` |

**Host-side prerequisites an app must satisfy to be *reachable*:**
- `validateSurface(surface)` must return `{valid:true, diagnostics:[]}` — every shipped surface is pinned by a test (`missionMonitorSurface.test.tsx:187`, `databaseClientSurface.test.tsx:253`, `terminalSurface.test.tsx:112`, `devModeSurface.test.tsx:168`, `wireframeSurface.test.ts:180`).
- The surface must be registered *live* for the launcher to ground on it: `getNavigationHost(appId)` reads the module registry (`hostRegistry.ts:71-77`), populated only while the app's provider is mounted (`MissionMonitorNavigationProvider.tsx:145`). **A closed app has no host** — list-only answers work from the published manifest (`useAppCommandSkill.ts:235-240`), but `describeContext` returns `null` (`hostRegistry.ts:89-92`).
- The published manifest is derived from *registered* surfaces (`publisher.ts:64-66`, `manifest.ts:118-133`) and pushed to Rust with `register_app_command_surfaces` (`publisher.ts:40,86`; Rust registry `surface_registry.rs:114,132`).

**Coupling-consequence:** the navigation contract is "data + one React provider + a handful of module-scoped callbacks". The *data* part is fully externalisable as JSON except `VerbDescriptor.run` and `available` are **functions** (`types.ts:275,278`). Therefore a manifest cannot carry a *serialised* surface; the app must supply code.

---

### 5. Data contract (application-data layer)

**Frontend declaration schema** (`shared/application-data/declaration.ts`):

| Type | Evidence | Notes |
|---|---|---|
| `ActivitySource = 'chat'\|'toolUse'\|'agentSession'` | `:11` | canonical RTDB sources |
| `DeclaredColumnType = 'TEXT'\|'INTEGER'\|'REAL'\|'BOOLEAN'\|'JSON'` | `:14` | |
| `WhereExpr` (all/any/not/eq/isNull/in) | `:17-23` | |
| `RowProjection {kind:'row', from, where?, select}` | `:26-31` | |
| `SessionRollupProjection {kind:'sessionRollup', excludeDispatchNames, terminalStates}` | `:41-48` | closed projection kind |
| `ApplicationDataTableDeclaration {name, primaryKey[], columns[{name,type,nullable?,owner:'backend'\|'application'}], source?, retention?}` | `:50-64` | |
| `ApplicationDataDeclaration {applicationId, declarationRevision, tables[]}` | `:66-70` | |

**Concrete declaration**: `mission-monitor/lib/dataDeclaration.ts:40-67` — one table `sessions`, PK `['sessionId']`, 11 columns, `source: {kind:'sessionRollup', excludeDispatchNames:['build','plan'], terminalStates:['Response','Timeout']}`, `retention:{maxRows:500}`; `customName` is `owner:'application'`.

**Backend schema ownership** (`apps/tauri/src-tauri/src/infrastructure/application_data/`):

| Rust element | Evidence |
|---|---|
| `RESERVED_COLUMNS = ["_row_version","_updated_at"]`, `is_reserved_column` | `declaration.rs:24-28` |
| Enums `ActivitySource`, `DeclaredColumnType`, `ColumnOwner`, `WhereExpr`, `RowProjectionKind`, `SessionRollupKind`, `DataSource` | `declaration.rs:34,56,113,137,167,174,193,217` |
| `Retention`, `ApplicationDataTableDeclaration`, `ApplicationDataDeclaration` | `declaration.rs:225,235,262` |
| `validate()` + `parse()` + `parse_slice()` — hard named errors | `declaration.rs:282-358` |
| Table/column validation (empty names, PK presence, reserved columns, dup columns, identifier charset) | `declaration.rs:397-465` |
| `is_identifier` = `[A-Za-z_][A-Za-z0-9_]*`; `is_application_id` = non-empty `[A-Za-z0-9_-]`, hyphens sanitized to `_` | `declaration.rs:515-531` |
| Physical table `feature_<sanitized appId>_<table>` + namespace validation | `application_store.rs:231-262`; `registry.rs:1-18` |
| Metadata tables `feature_data_tables` / `feature_data_tombstones` (frozen NO-MIGRATE literals) | `store.rs:31-63` |
| Additive-only migration (add column OK; remove/retype/PK change refused) | `registry.rs:9-16` |

**IPC commands** (`commands.rs`, all take ONE `args` struct — wire note `:7-10`):

| Command | Args struct | Result struct | Evidence |
|---|---|---|---|
| `application_data_read` | `ApplicationDataReadArgs {ref, where[], orderBy?, limit?}` | `{version, rows[], retention}` | `:104-132`, `:878-885` |
| `application_data_watch` | `{ref, scope, fields?, initial, flushMs?}` | `{watchId, version, rows?}` | `:134-157`, `:886-893` |
| `application_data_unwatch` | `{watchIds[]}` | `{watchIds[]}` | `:159-171`, `:894-901` |
| `application_data_write` | `{ref, key[], set{}}` | `{updated}` | `:173-193`, `:902-909` |
| `application_data_delete` | `{ref, key[]}` | `{deleted}` | `:195-209`, `:910-917` |
| `application_data_declare` | `{declarations: JsonValue[]}` | `{materialized[]}` | `:211-223`, `:918-925` |

Frontend client mirrors all six with the `{ args: {...} }` wrapper (`client.ts:159-170,173-227`), `DataTableRef` union (`client.ts:41-43`), `WatchScope` (`client.ts:84-87`). Registry bootstrap issues ONE declare for all registered declarations (`registry.ts:79-96`, wired from `Home.tsx:60-64`).

Consumer hooks: `useApplicationRead` (`useApplicationData.ts:127-168`), `useApplicationWatch` (`:175-245`). Store semantics: per-table partitions (`store.ts:45-52`), insert/update spread-merge (`:128-142`), version-guarded stale drops (`:122-126`), epoch bumps only on real mutation (`:150-179`).

**`useEventRows` (RTDB row subscription)** — `shared/hooks/useEventRows.ts`:

```
useEventRows(
  eventType: 'Chat' | 'ToolUse' | 'AgentSession',
  args?: Record<string, string|number|boolean|null|{op,value}>,
  options?: { replay?: boolean; flushMs?: number },
) → { rows: Map<string,Row>, epoch: number, error: string|null, ready: boolean }
```
- Typed overloads: `useEventRows.ts:196-215`.
- Query text built from args + canonical field list: `buildQueryText` `:137-156`; field lists from `EventSubscription.ts:158-212`.
- Args are compared via a stable serialized key (`:184-192`), so inline object literals are safe.
- Replay marker: `ready` resolves only on the backend `replayCompleteQueryId` (`:102`, `:261-274`; envelope `EventSubscription.ts:250-265`; drain registry `StreamContext.tsx:317-388`).
- `args` are **equality/comparison filters**, not app-scoped partitions — any app can query any canonical row (`buildQueryText` produces `chat(sessionId = "x") { … }`).

**Consequence:** the data layer already *is* a third-party-capable contract: declare a table (validated backend-side), read/watch/write/delete over typed IPC, subscribe to canonical rows. The only supply-chain concern is `applicationId` charset + the physical namespace, both enforced (`application_store.rs:248-262`).

---

### 6. Backend invocation surface

**Frontend transport:**

| Layer | Evidence |
|---|---|
| `adapterBridge` singleton with `setInvoke/setListen/setLlmChat*/...` registered once at boot | `adapterBridge.ts:64-138`, `:140-264` |
| App calls Rust only via `adapterBridge.invoke(command, args)` | e.g. `database-client/lib/api.ts:37`, `terminal/components/TerminalWindow.tsx:259`, `wireframe` file actions, `doom/DoomWindow.tsx:133` |
| `HostAdapter` interface (onMessage, invoke?, llmChat*, llmChatWithSkills?, ...) | `HostAdapter.ts:8-117` |
| `TauriAdapter` — dynamic `@tauri-apps/api` imports only | `TauriAdapter.ts:24,49` (and throughout) |
| `DevAdapter` — `invoke` is a no-op returning `undefined` | `DevAdapter.ts:47-50` |
| Dynamic-import rule enforced by an engineering test | `launcherSpaceHold.test.ts:377` asserts launcher source has no `@tauri-apps` |
| Direct `@tauri-apps/api` imports **only** in adapters | verified: zero static imports inside `applications/**` (grep) |

**Rust command registration:**

| Fact | Evidence |
|---|---|
| One flat `generate_handler![...]` list (~116 command paths) | `lib.rs:909-1121` |
| Commands grouped by module: `infrastructure::rtdb::commands`, `infrastructure::application_data::commands`, `applications::settings::commands`, `applications::terminal::commands`, `applications::db_client::commands`, `applications::wireframe::commands`, `infrastructure::app_window`, `infrastructure::app_command`, `companion::surface_registry`, `application_store::*`, etc. | `lib.rs:910-1121` |
| `AppRuntime` is an **empty marker struct**; registration is entirely `lib.rs` | `runtime/mod.rs:11-17` |
| `DesktopCapable` / `CliCapable` traits exist but are `#[allow(dead_code)]` and unimplemented | `runtime/capability.rs:1-13` |
| New commands require editing `applications/mod.rs` + `lib.rs` | `applications/mod.rs:1-10`; `lib.rs` list |

**Command naming:** **flat, not per-app namespaced** — `db_connection_list`, `db_query_execute`, `terminal_*`, `*_pty_*`, `wireframe_save_as`, `doom_*`, `llm_*`, `application_data_*`, `application_store_*`, `pg_*`, `telemetry_*`. `db_*` is namespaced by prefix convention only (no enforcement beyond Rust module ownership).

**Backend↔frontend event channel:** exactly one — `"fredo-stream-event"` (`TauriAdapter.ts:26`, `AppProvider.tsx:94-136`), discriminated by envelope key: `streamHealth` → heartbeat, `applicationBatch` → app-data notifications, `rowBatch` → RTDB rows, else single `RowDelivery` (`AppProvider.tsx:99-133`). Third-party apps receive this transitively through the host's AppProvider.

**Implication:** a third-party app cannot add a Rust command without a host code change. It *can* use every existing command, and it can ship *backend behaviour* today only through the data layer (declarations + writes) or the generic intent relay (`app_command_intent`, `app_command_intent_take`, `app_command_intent_result` — `lib.rs:1049-1051`, Rust `app_command.rs:159-196`).

---

### 7. Settings + theming + window system coupling

| Concern | Host-owned element | App-facing element | Evidence |
|---|---|---|---|
| Settings shell | `SettingsSurface.tsx` static sections (Companion, Appearance, Fredo Setup, Telemetry, Apps, Ingest, Database, Layout) | auto-discovered `hasSettings`/`renderSettings()` sections under "Applications" | `SettingsSurface.tsx:117-259`, discovery `:121-126`, render `:246-252` |
| Unified save | `SettingsSaveProvider` + one `SaveFooter` reading `useSettingsSaveContext` | panel calls `useSettingsSave(fn)` | `SettingsSaveContext.tsx:29-57`; `SettingsSurface.tsx:83-115` |
| Settings persistence | `settingsService` (`get_setting`/`save_setting`, localStorage shadow) | `usePersistedSetting(key, default)` | `applications/settings/index.tsx:31-91`; `usePersistedSetting.ts:15-50` |
| Per-app window mode | `appPresentationStore` + `get_control_setting`/`save_control_setting` | `AppPresentationSettings` UI; `appWindows.createAppOpener` | `appPresentationStore.ts:41-46`, `:157-208`; `controlSettingAccessor.ts:27-34`; `appWindows.ts:69-81` |
| Native windows | Rust `open_app_window` / `close_app_window`; label `app-<id>` (bespoke `terminal`/`doom`); URL `index.html?view=app&id=<id>` | `openAppInOwnWindow` | `app_window.rs:54,78,164-217`; `appWindows.ts:36-49` |
| In-window kernel | `windowStore` module store, `WindowManager`, `WindowSystemProvider` | `useWindowActions()` | `windowStore.ts:19-185`; `windowTypes.ts:52-59`; `useWindowActions.ts:17-23` |
| Theme tokens | Chakra system built from `SEMANTIC_TOKENS` (58 tokens) mapped to CSS vars | components read `bg="bg.surface"` or `var(--card-bg)`; `tint()` helper | `theme/system.ts:1-15,77-130,323`; `contract/tokens.ts:70+`; `contract/surfaces.ts:90-121` |
| Theme values | `ThemeProvider` writes CSS vars to `document.documentElement` | `useTheme()` for presets/overrides | `ThemeProvider.tsx:322-351`; `ThemingSettings.tsx:78,213` |
| Zone layout | `zoneLayoutStore` (module-scoped) | Layout settings pane | `settings-app/components/LayoutSettings.tsx`; `Home.tsx:119-127` |

**Host vs app split (as evidenced):**
- **Host:** settings shell chrome, save footer, clipboard of token names, CSS-variable application, all window chrome (frame, drag, z-order, zones), native window creation, per-app presentation persistence, global key dispatch.
- **App:** a settings *pane* (must use the save-context), a `Surface` declaration + nav provider, `render()` content, per-app KV keys (namespaced by convention like `Fredo_dbclient_*`), per-app command invocations.

**Hard coupling points for a third-party app:** `useTheme` is exported from `app/providers/ThemeProvider` (not from `shared`), and `theming` itself imports it *upward* (`ThemingSettings.tsx:4`); `SettingsSurface` imports six sibling apps directly (`SettingsSurface.tsx:5-9`); `useWindowActions` throws outside a `WindowSystemProvider` (`useWindowActions.ts:19-22`) and the standalone app window adds its own provider (`StandaloneAppWindow.tsx:141`).

---

### 8. Styling / build coupling

| Aspect | Evidence | What breaks in an isolated build |
|---|---|---|
| Alias `@` → `apps/ui/src` | `vite.config.ts:11-14`; `tsconfig.json:18-20` | `@/shared/...` imports fail unless the app's build replicates the alias or is rewritten to package imports. |
| Monorepo package `@fredo/ui` (exports `.` → `src/index.ts`) | `apps/ui/package.json:6-8`; `apps/tauri/vite.config.ts:22-23` | The host consumes TS **source**, not a built artifact; an external app cannot import internals unless the host publishes them. |
| `@fredo/ui` root export is only ~78 lines | `apps/ui/src/index.ts:1-78` | Does **not** export `useEventRows`, `useApplicationWatch`, `registerApplication`, `getNavigationHost`, or theme tokens. It *does* export `adapterBridge` (`:21`), `settingsService` (`:9`), `FredoApplicationClass` (`:88`). Third-party apps need far more surface. |
| TypeScript config: `"jsx":"react-jsx"`, `"isolatedModules":true`, `"strict":true` | `tsconfig.json` | App must compile under the same settings; CSS-module typings are supplied implicitly by Vite. |
| CSS modules | `MonitorNode.module.css` (204 lines) imported by 3 components (`ChatNode.tsx:11`, `SubagentNode.tsx:72`, `ToolCallAccordionItem.tsx:36`) | Requires a bundler that supports `.module.css` with local scoping. |
| Third-party CSS import | `MissionMonitorPanel.tsx:13` `import 'reactflow/dist/style.css'` | Requires the app bundle to resolve and inject the dependency's CSS. |
| Global CSS + CSS vars | `style.css` (scrollbars, `#root` height, `--text-muted`); `ThemeProvider.tsx:322-351` | An isolated app renders unstyled unless the host's global CSS and theme vars are present. |
| Chakra system | `shared/components/ui/provider.tsx` wraps `ChakraProvider value={system}`; `system.ts:323` | Chakra compound components require the host `system`; a second `ChakraProvider` with default config would render differently. |
| `reactflow/dist/style.css`, `konva`, `ghostty-web` theme | external | Each app brings heavy runtime deps; two copies (host + app bundle) would break React context (e.g. `ReactFlowProvider` at `MissionMonitorPanel.tsx:1177`). |
| Lazy chunk | `WireframeCanvas.tsx:21` `lazy(() => import('./WireframeCanvasImpl'))` | Vite-specific dynamic import; a different loader must support code splitting or inline it. |
| React version | `react ^18.3.1` (`apps/ui/package.json:28`); Chakra `^3.2.2` (`:17`) | An external app bundling another React copy breaks hooks (`useSyncExternalStore`, context). Must be an external peer. |
| No app-level `package.json` | verified: no `applications/*/package.json` | Apps are plain source folders, not packages today. |
| Test config | `vitest.config.ts` jsdom + setup file | Per-app tests assume the host harness. |
| CSP | `tauri.conf.json` `csp: "script-src 'self' blob: 'wasm-unsafe-eval'"`, `withGlobalTauri:false` | A runtime-loaded app bundle loaded from a remote/other origin would violate `default-src 'self'` unless bundled into `dist` or served from a trusted origin. {inference} |
| Capabilities | `capabilities/default.json` grants `core:*` to windows `main`, `terminal`, `doom`, `app-*` | A new window label outside `app-*` would need a capability entry. |

**Reading:** an app's TS can be compiled independently *as a Vite library*, but only if: aliases are rewritten, React/Chakra are externalised as peers pointing at the host instance, CSS modules and third-party CSS are emitted, and the host exports the runtime hooks. The current build produces a single `dist` where all of this is implicit.

---

### 9. Code-size / realism check

Computed with PowerShell over `apps/ui/src/applications/<app>/**/*.{ts,tsx}` excluding `__tests__` (LOC = line count; tests = count of `*.test.ts(x)` files).

| App | Files | LOC | Test files | Class | External npm deps (beyond React/Chakra/react-icons) |
|---|---:|---:|---:|---|---|
| wireframe | 33 | 9,805 | 32 | complex | `konva`, `react-konva`, `react-dom` |
| home | 29 | 9,767 | 29 | complex | (host shell) |
| mission-monitor | 27 | 9,025 | 27 | complex | `reactflow` |
| database-client | 24 | 6,584 | 21 | complex | — |
| terminal | 18 | 4,333 | 8 | complex | `ghostty-web` |
| dev-mode | 8 | 2,473 | 2 | medium | `framer-motion`, `three` |
| settings-app | 7 | 2,234 | 8 | medium | — |
| doom | 3 | 1,039 | 2 | medium | — (renders canvas) |
| postgres | 3 | 588 | 0 | small | — |
| theming | 4 | 576 | 0 | small | — |
| setup | 3 | 400 | 2 | small | — |
| ingest | 2 | 372 | 1 | small | — |
| settings | 2 | 152 | 1 | small | — (infrastructure, not an app) |
| app-window | 2 | 148 | 1 | small | — (route root, not an app) |

Shared runtime LOC (for scale): `shared/navigation` 7,072 (31 files), `shared/window-system` 3,672 (20), `shared/hooks` 1,866 (14), `shared/contexts` 1,195 (3), `shared/application-data` 695 (4), `shared/classes` 599 (4), `shared/companion` 780 (6).

**Not registered / not "feature apps":** `home`, `doom`, `postgres` (module only), `ingest` (module only), `settings` (infrastructure module — not a `FredoApplicationClass`, `settings/index.tsx:1-8`), `app-window` (route root — explicitly does **not** call `registerApplication`, `app-window/index.ts:1-6`). The retained registered set is exactly 8 (`retainedApplicationSet.test.ts:22-31`): `wireframe`, `terminal`, `mission-monitor`, `database-client`, `theming` (hidden), `setup`, `settings`, `dev-mode` (hidden).

**Verdict:** the four "headline" apps are genuinely complex production applications, not demos. Any plugin story must handle React context, heavy external deps, CSS, and thousands of LOC per app — this is not a "toy widget" marketplace.

---

## Seam Classification Table

Legend: **Hard** = blocks an out-of-tree app without host changes; **Workable** = possible with a bounded host export/rewrite; **Already-contract-shaped** = the interface already exists as a typed boundary.

| Seam | Current mechanism | Blocking for out-of-tree app? | Evidence | Notes |
|---|---|---|---|---|
| Registration / discovery | `import.meta.glob(eager)` + `registerApplication()` module side effect | **Hard** | `allApplications.ts:5`, `applicationRegistry.ts:34-42`, `Home.tsx:26` | Requires manifest + loader; `ALL_FEATURES` snapshot at module eval. |
| App base class | `FredoApplicationClass` abstract class | **Already-contract-shaped** | `FredoApplicationClass.ts:51-192` | Only 4 abstract members; `icon: IconType` couples to react-icons. |
| App lifecycle hooks | `onMount`/`onUnmount` called by host | **Already-contract-shaped** | `Home.tsx:166-188`, `StandaloneAppWindow.tsx:86-102` | Deferred `onMount` relies on adapter being registered. |
| Shared React hooks (`useWindowActions`,`useStream`,`useTheme`,`useSettingsSave`) | React context providers mounted by host | **Hard** | `useWindowActions.ts:17-23`, `StreamContext.tsx:93-99`, `ThemeProvider.tsx:75-79`, `SettingsSaveContext.tsx:44-57` | App must run inside host provider tree OR receive an API object. |
| Module-scoped singleton stores | row store, window store, app-data store, nav host registry | **Hard** | `StreamContext.tsx:153`, `windowStore.ts:19`, `store.ts:45`, `hostRegistry.ts:30` | Two copies = divergent state; app must import host instance. |
| IPC transport | `adapterBridge.invoke` singleton | **Already-contract-shaped** (read) / **Hard** (write) | `adapterBridge.ts:76-138`; `lib.rs:909-1121` | Apps can call existing commands; cannot add commands. |
| Event channel | single `"fredo-stream-event"` + envelope discriminators | **Workable** | `TauriAdapter.ts:26`, `AppProvider.tsx:94-136` | App must consume via host AppProvider, not its own listener. |
| RTDB row subscription (`useEventRows`) | typed hook over module store + `subscribe_events` | **Already-contract-shaped** (data) / **Workable** (hook) | `useEventRows.ts:196-306` | Args are canonical filters; hook must come from host. |
| Application-data declaration/IPC | typed schema + 6 commands | **Already-contract-shaped** | `declaration.ts:66-70`, `client.ts:173-227`, `commands.rs:878-925` | Best existing plugin API; needs app-supplied declaration. |
| Data declaration bootstrap | `declareAllRegisteredApplicationData()` once from Home | **Workable** | `registry.ts:79-96`, `Home.tsx:60-64` | A runtime-installed app must trigger a (re)declare. |
| Navigation surface | `Surface` data + `validateSurface` | **Already-contract-shaped** (data) / **Hard** (`run`/`available` are functions) | `types.ts:266-295`, `validation.ts:485` | Surface cannot be serialised; app must ship code. |
| Navigation host | `createNavigationHost` + `registerNavigationHost` | **Already-contract-shaped** | `ui/host.ts:71-166,212`, `hostRegistry.ts:58-92` | App mounts provider; host reads registry synchronously. |
| Global keyboard dispatch | one `document` keydown listener | **Hard** (if duplicated) | `globalKeys.ts:162-167`, `NavigationProvider` in `main.tsx` | Must be host singleton; app contributes only element-scoped adapter. |
| Companion publishing | `register_app_command_surfaces` from registered surfaces | **Already-contract-shaped** | `publisher.ts:40,75-93`; `surface_registry.rs:114,132` | Automatic if the surface registers. |
| Companion intent relay | `app_command_intent*` + `useAppCommandIntent` | **Already-contract-shaped** | `app_command.rs:159-196`; `useAppCommandIntent.ts:220`; `lib.rs:1049-1051` | Generic, appId-scoped. |
| Settings shell | `hasSettings`/`renderSettings()` auto-discovery | **Workable** | `SettingsSurface.tsx:121-126,246-252` | Works if class is registered before shell render. |
| Settings persistence | `settingsService` get/save + localStorage | **Already-contract-shaped** | `settings/index.tsx:31-91` | Key namespacing is convention only. |
| Theming | Chakra system + CSS vars on documentElement | **Workable** | `system.ts:323`, `ThemeProvider.tsx:322-351` | App must use tokens; isolated bundle must inherit host CSS. |
| Window system | module window store + provider | **Already-contract-shaped** (actions) / **Hard** (store copy) | `windowTypes.ts:52-59`, `windowStore.ts`, `StandaloneAppWindow.tsx:141` | App calls actions; host owns entries. |
| Native windows | Rust `open_app_window` (`app-<id>`) + `?view=app&id=` | **Workable** | `app_window.rs:54,78,164-217` | Generic path works for any registered id; capabilities cover `app-*`. |
| CSS / styling | CSS modules + global CSS + Chakra + third-party CSS | **Hard** (isolated build) / **Workable** (bundled into host) | `MonitorNode.module.css`, `style.css`, `MissionMonitorPanel.tsx:13`, `system.ts:323` | Bundle into host dist or replicate tokens. |
| Cross-app imports | direct `applications/<sibling>` imports | **Hard** | `SettingsSurface.tsx:5-9`, `DatabaseClientSettings.tsx:8`, `DetailPanel.tsx:10` | Must be cut for a clean boundary. |
| Alias / package resolution | `@` → `src`, `@fredo/ui` → `src/index.ts` | **Hard** (isolated build) | `vite.config.ts:11-14`, `apps/ui/package.json:6-8` | External build must resolve or rewrite. |
| Build-time lazy chunks | `import('./WireframeCanvasImpl')` | **Workable** | `WireframeCanvas.tsx:21` | Loader must support dynamic import. |
| CSP / capabilities | `default-src 'self'`, window allowlist | **Hard** (remote loading) | `tauri.conf.json` security block; `capabilities/default.json` | Runtime-loaded bundle must originate from self or a trusted scheme. |

---

## Minimum viable contract sketch

Derived **only** from the evidence above. This is an enumeration of what a hypothetical `FredoAppManifest` would have to declare, and *why each field exists* (each field maps to a seam that something in the tree currently reads). It is deliberately not a backend design.

```ts
// Hypothesis only — field-by-field justification below.
interface FredoAppManifest {
  // ── identity (read by registry, launcher, windows, routing) ──────────────
  id: string;                 // FredoApplicationClass.ts:58; kebab-case; dedupe key
                              // (applicationRegistry.ts:81-89); native-window label `app-<id>`
                              // (app_window.rs:78); application-data namespace (declaration.rs:526-531)
  name: string;               // FredoApplicationClass.ts:63; window title (Home.tsx:155), launcher
                              // label, identity matcher (appIdentity.ts)
  icon: string;               // today: IconType (FredoApplicationClass.ts:68); must become a
                              // resolvable id/asset path since an IconType is a JS component reference
  version: string;            // {inference} install/upgrade/dedupe; no current reader

  // ── surface / UX (read by launcher + settings shell) ─────────────────────
  showable: boolean;          // FredoApplicationClass.ts:92 (launcher, open-app, companion target)
  gridConfig: { closable: boolean; maximizable: boolean }; // FredoApplicationClass.ts:82-85
                              // (Home.tsx:158-160)
  isMultiWindow: boolean;     // FredoApplicationClass.ts:99; AppPresentationSettings.tsx:364
  hasSettings: boolean;       // FredoApplicationClass.ts:107; SettingsSurface.tsx:123
  // render()/renderSettings()/onMount/onUnmount: NOT declarable — they are code.
  // → manifest must point at an entry module that exports a FredoApplicationClass instance.

  entry: string;              // path/URL to the module exporting the app instance
                              // (today implicit via import.meta.glob + index.ts side effect)

  // ── data (read by application_data_declare) ─────────────────────────────
  applicationData?: ApplicationDataDeclaration; // declaration.ts:66-70; validated by
                              // declaration.rs:282-465; materialized once at boot (registry.ts:79-96).
                              // Must declare: applicationId, declarationRevision, tables[]
                              //  (name, primaryKey[], columns[{name,type,nullable?,owner}],
                              //   source? {row|sessionRollup}, retention? {maxRows?,ttlDays?})

  // ── commands / navigation (read by validation + companion publishing) ────
  surface?: Surface;          // navigation/types.ts:291-295; validateSurface (validation.ts:485);
                              // published via register_app_command_surfaces (publisher.ts:86;
                              // surface_registry.rs:114,132). NOTE: verbs[] contain functions
                              // (`run` types.ts:278, `available` types.ts:275), so the manifest must
                              // be produced IN CODE, not parsed from JSON — the JSON-serialisable
                              // subset is tree.places/keys + verbs' id/title/description/appliesTo/
                              // args/risk/aliases/publish/consequence.
  companion?: { appName: string; description: string } | null; // types.ts:294
                              // (`surface.companion`; a surface without it publishes nothing —
                              // manifest.ts:128)

  // ── transport (what IPC the app is allowed to use) ──────────────────────
  requiredCommands?: string[]; // {inference} derived from observed per-app usage:
                              //   terminal: spawn_terminal_session, list_terminal_sessions,
                              //             get_pty_buffer, write_pty_input, resize_pty,
                              //             close_terminal_session, open_terminal_window,
                              //             close_terminal_window, list_persisted_terminal_sessions,
                              //             resume_terminal_session,
                              //             delete/rename_terminal_session_record (lib.rs:946-957)
                              //   database-client: db_* (9 commands, lib.rs:1027-1035)
                              //   wireframe: wireframe_save_as/open_document/export_png (lib.rs:1043-1045)
                              //   doom: doom_* + launch/stop/step/frame (lib.rs:1083-1117)
                              //   mission-monitor: application_data_* (lib.rs:918-923)
                              // No current enforcement exists; this is the field a host would need
                              // to gate access if it wants per-app command scoping.
  events?: string[];          // {inference} today all apps share "fredo-stream-event"
                              // (TauriAdapter.ts:26); LLM channels llm-token/llm-done/llm-status/
                              // llm-skill-call are host-wide (TauriAdapter.ts:79,93,166).

  // ── settings (read by Settings shell + persistence) ─────────────────────
  settingsKeys?: string[];    // {inference} per-app KV namespace; observed convention:
                              //   terminal_work_dir/terminal_default_cli (terminal/settings.ts:15-16),
                              //   Fredo_dbclient_* (database-client/lib/storage.ts:25-34),
                              //   Fredo_mm_detail_panel_width (DetailPanel.tsx)
  // settings pane = code (renderSettings), not declarable.

  // ── build / asset metadata (read by any loader — none exists today) ─────
  dist: { entry: string; css?: string[]; assets?: string[] }; // CSS modules + reactflow css +
                              // global assumptions (MonitorNode.module.css, MissionMonitorPanel.tsx:13)
  peerDependencies: { react: string; "@chakra-ui/react": string; /* ... */ }; // react ^18.3.1
                              // (apps/ui/package.json:28), Chakra ^3.2.2 (:17) — must be shared
                              // singletons, not bundled copies
}
```

**Why the manifest cannot be a pure JSON document (inference, strongly evidenced):**
- `render()` returns a React element (`FredoApplicationClass.ts:74`).
- `VerbDescriptor.run` / `available` are functions (`navigation/types.ts:275,278`).
- `onMount`/`onUnmount` are functions (`:185,191`).
- `renderSettings()` is a function (`:118`).
- Therefore `entry` must reference **code**, and the manifest is the *declarative* subset (identity, visibility, data schema, companion copy, required commands) plus a pointer to executable module(s).

**Why command scoping is absent today and would be needed (evidence):** all commands are globally registered (`lib.rs:909-1121`) and `adapterBridge.invoke` accepts any command string (`adapterBridge.ts:108-122`). The only per-app guard that exists is *data* namespacing (`application_store.rs:248-262`) and *surface* identity (`validateSurface` + `registerNavigationHost`). There is no capability model per app.

---

## Open questions for the human

1. **Where does the install artifact live?** In-repo `dist` (satisfies `default-src 'self'`, `tauri.conf.json` security), a local app-data directory served under a trusted scheme, or a remote registry? The current CSP (`script-src 'self' blob: 'wasm-unsafe-eval'`, `withGlobalTauri:false`) constrains this heavily.
2. **Does "plug into the Rust backend via contracts" mean new per-app backend commands?** Today commands are flat and only addable by editing `lib.rs:909-1121`; the only app-extensible backend surface is `application_data_*` + `app_command_intent` + existing per-feature command families. Is an app allowed to introduce new commands at all?
3. **Is the shared runtime a single host module (import map / externals) or a duplicated bundle?** Module-scoped singletons (`StreamContext.tsx:153`, `windowStore.ts:19`, `hostRegistry.ts:30`, `store.ts:45`) and React context mean two copies break correctness. Which mechanism should the host guarantee?
4. **How are the cross-app imports handled?** `settings-app` imports six sibling apps (`SettingsSurface.tsx:5-9`) and `shared/*` imports `applications/*` for settings and the registry. Is the intent to keep the built-in apps special-cased while third-party apps use a narrower API, or to refactor built-ins onto the same contract?
5. **What is the trust model?** An installed app runs arbitrary JS in the host webview with full `adapterBridge` access (any command). Do you want a permission manifest (per-command, per-data-table) enforced host-side, and if so, where (frontend gate vs Rust wrapper)?
6. **Is "built with bun + Vite grabbing TS" a build-per-install or install-prebuilt?** Building TS at install time requires the toolchain on the user machine (the plugin app already uses `bun build`, `apps/opencode-plugin/package.json:9`); prebuilt requires a signing/distribution story.
7. **Should a third-party app be allowed to declare its own `application_data` tables, and at what lifecycle point?** Today declaration is one boot-time batch (`registry.ts:79-96`, `Home.tsx:60-64`); a runtime install needs an incremental declare path.
8. **What is the scope of "settings" for third-party apps?** Only `hasSettings` + `renderSettings()` into the existing shell (`SettingsSurface.tsx:121-126`), or also a standalone settings window and its own persisted keys?

---

*End of document.*
