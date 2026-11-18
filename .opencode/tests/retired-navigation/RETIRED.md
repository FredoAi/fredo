# Retired navigation test suites — the reason record

**No durable suite is deleted silently in this slice.** Every path deleted by the navigation-engine
retirement programme (issue **#3151**, slice 1 of 3) is listed below with the suite it belonged to,
the issue it was retired in, and a factual statement of why its subject no longer exists.

Read this record with the deleted paths it names: a path that is gone but unlisted is a defect, and
a listed path that still exists on disk is likewise a defect. The subject of every row below is the
**NavigationEngine** (declaration model, host dispatch funnel, shared journal, the surfaces it drove,
and the research/protocol programme that produced it) — that engine is deleted in #3151, so the
suites that exercised it have nothing left to exercise.

> **Appended by later sub-tasks.** This file is the single retirement ledger for the slice. Rows 1-17
> below are the four **durable** suite directories retired by ST-7. The remaining rows are the
> **in-tree** deletions landed by the ONE deletion commit (ST-6): the deleted product modules (the
> six surface declarations, the four app navigation providers, the launcher confirmation, the
> companion verb-manifest bridge, the DEV navigation preview and the whole `shared/navigation`
> engine tree) and every `apps/ui/src/**` vitest file whose subject was one of those. The committed
> absence-guard invocation recipe is appended by ST-8.

## Retired paths

| path | suite | retired in | reason |
|---|---|---|---|
| `.opencode/tests/navigation/coverage-map.md` | navigation | #3151 | subject: the coverage ledger of the navigation engine's P8 decommission (deleted legacy suites → their engine successors); the engine and every successor it names are deleted in #3151 |
| `.opencode/tests/navigation/functional.md` | navigation | #3151 | subject: the headless NavigationEngine core, its four UI surfaces and its P5 contract changes (`CommandRail`/`NavigationMap`/`ActivityTrail`, dispatch funnel, journal, validation rules V-01…V-12); the engine is deleted in #3151 |
| `.opencode/tests/navigation/regression.md` | navigation | #3151 | subject: the engine's P3–P8 must-not-change baseline (engine module set, surface contracts, one dispatch funnel, one announcement region); the engine is deleted in #3151 |
| `.opencode/tests/navigation/smoke.md` | navigation | #3151 | subject: the engine's module-presence/dispatchability smoke (eleven headless modules, golden manifest, one host mount); the engine is deleted in #3151 |
| `.opencode/tests/navigation/exploratory.md` | navigation | #3151 | subject: unscripted probes of the engine's prefix grammar, armed state, place scoping and store-mutation boundary; the engine is deleted in #3151 |
| `.opencode/tests/navigation-fleet/functional.md` | navigation-fleet | #3151 | subject: the engine's fleet migration of five application surfaces (terminal, window traversal, mission monitor, SQL Studio, dev mode) onto declared `Surface` trees; the engine and those declarations are deleted in #3151 |
| `.opencode/tests/navigation-fleet/regression.md` | navigation-fleet | #3151 | subject: the fleet migration's must-not-change baseline (no key re-tuning, terminal passthrough, window traversal, per-surface outcomes through the engine); the engine is deleted in #3151 |
| `.opencode/tests/navigation-fleet/smoke.md` | navigation-fleet | #3151 | subject: the fleet migration's app-boot smoke (engine surfaces mounting on the five migrated apps); the engine is deleted in #3151 |
| `.opencode/tests/navigation-fleet/exploratory.md` | navigation-fleet | #3151 | subject: unscripted probes of the migrated fleet's keystroke/focus/availability behaviour under the engine; the engine is deleted in #3151 |
| `.opencode/tests/navigation-research/functional.md` | navigation-research | #3151 | subject: the navigation-engine research spike's deliverable checks (fluency report, static prototype, session protocol, Gate-H evidence) for the engine programme being retired in #3151 |
| `.opencode/tests/navigation-research/regression.md` | navigation-research | #3151 | subject: the research spike's zero-production-impact baseline for the engine prototype/protocol artefacts; the programme is retired in #3151 |
| `.opencode/tests/navigation-research/smoke.md` | navigation-research | #3151 | subject: artifact-presence smoke for the engine research spike's report, prototype and protocol; the programme is retired in #3151 |
| `.opencode/tests/navigation-research/exploratory.md` | navigation-research | #3151 | subject: unscripted probes of the engine research spike's evidence quality (prototype leaks, quote integrity, threshold drift); the programme is retired in #3151 |
| `.opencode/tests/wireframe-navigation/functional.md` | wireframe-navigation | #3151 | subject: the declaration-driven Wireframe surface (its declared places/verbs/keys, the engine-driven bar/map/trail and the journal); the declaration and engine are deleted in #3151 |
| `.opencode/tests/wireframe-navigation/regression.md` | wireframe-navigation | #3151 | subject: the Wireframe declaration surface's must-not-change baseline (single undo journal, one dispatch funnel, no legacy runtime dependence); the declaration and engine are deleted in #3151 |
| `.opencode/tests/wireframe-navigation/smoke.md` | wireframe-navigation | #3151 | subject: the Wireframe declaration surface's boot smoke (engine bar/map/trail mounting on the Wireframe shell); the declaration and engine are deleted in #3151 |
| `.opencode/tests/wireframe-navigation/exploratory.md` | wireframe-navigation | #3151 | subject: unscripted probes of the Wireframe declaration surface's armed strokes, place scoping and undo tiers; the declaration and engine are deleted in #3151 |

### ST-6 — the in-tree deletion landing (ONE commit)

> Every row below is a path this commit **deleted**. The module rows are the removal itself; the
> test rows are the in-tree suites whose subject is one of those modules. A suite whose subject
> **survives** was re-pointed rather than retired (recorded in the ST-6 verification comment).

#### The engine and its two root barrels

| path | suite | retired in | reason |
|---|---|---|---|
| `apps/ui/src/shared/navigation/index.ts` | shared/navigation (engine barrel) | #3151 | subject: the NavigationEngine's public barrel; the engine is deleted in #3151 |
| `apps/ui/src/shared/navigation/types.ts` | shared/navigation (leaf) | #3151 | subject: the engine's verb/place/journal/context noun set; nothing consumes it after the deletion |
| `apps/ui/src/shared/navigation/keys.ts` | shared/navigation (key grammar) | #3151 | subject: the declared-stroke grammar (`g+*`, prefixes, sequences); the keyboard model is deleted in #3151 |
| `apps/ui/src/shared/navigation/keyResolver.ts` | shared/navigation | #3151 | subject: stroke-to-known-key resolution for the engine's resolver |
| `apps/ui/src/shared/navigation/resolver.ts` | shared/navigation | #3151 | subject: the engine's place/stroke resolution |
| `apps/ui/src/shared/navigation/registry.ts` | shared/navigation | #3151 | subject: the engine's verb registry |
| `apps/ui/src/shared/navigation/dispatch.ts` | shared/navigation | #3151 | subject: the ONE dispatch funnel (risk policy, confirmation gate, journal write) |
| `apps/ui/src/shared/navigation/journal.ts` | shared/navigation | #3151 | subject: the shared undo journal; Wireframe now owns an app-local history (ST-3) |
| `apps/ui/src/shared/navigation/context.ts` | shared/navigation | #3151 | subject: the `ContextEnvelope` derivation; grounding is application-level (ST-2) |
| `apps/ui/src/shared/navigation/discover.ts` | shared/navigation | #3151 | subject: the command-discovery projection |
| `apps/ui/src/shared/navigation/manifest.ts` | shared/navigation (manifest) | #3151 | subject: the engine's companion manifest projection |
| `apps/ui/src/shared/navigation/validation.ts` | shared/navigation | #3151 | subject: the surface validation rules (V-01…V-12) |
| `apps/ui/src/shared/navigation/focusContext.ts` | shared/navigation (focus) | #3151 | subject: the five-value focus classifier; `window-system/chordSuppression.ts` owns the surviving subset (ST-1) |
| `apps/ui/src/shared/navigation/ui/index.ts` | shared/navigation (UI barrel) | #3151 | subject: the engine UI barrel (rail/map/trail/keycap/host) |
| `apps/ui/src/shared/navigation/ui/CommandRail.tsx` | shared/navigation (rail) | #3151 | subject: the command bar surface |
| `apps/ui/src/shared/navigation/ui/NavigationMap.tsx` | shared/navigation (map) | #3151 | subject: the `?` navigation map surface |
| `apps/ui/src/shared/navigation/ui/ActivityTrail.tsx` | shared/navigation (trail) | #3151 | subject: the journal activity trail surface |
| `apps/ui/src/shared/navigation/ui/Keycap.tsx` | shared/navigation (keycap) | #3151 | subject: the keycap/hint badge surface |
| `apps/ui/src/shared/navigation/ui/announce.tsx` | shared/navigation (announcer) | #3151 | subject: the engine's live announcement region |
| `apps/ui/src/shared/navigation/ui/constants.ts` | shared/navigation | #3151 | subject: the engine UI testids/labels |
| `apps/ui/src/shared/navigation/ui/format.ts` | shared/navigation | #3151 | subject: engine UI formatting helpers |
| `apps/ui/src/shared/navigation/ui/models.ts` | shared/navigation | #3151 | subject: the rail/map/trail projection builders |
| `apps/ui/src/shared/navigation/ui/types.ts` | shared/navigation | #3151 | subject: engine UI model types |
| `apps/ui/src/shared/navigation/ui/host.ts` | shared/navigation (host) | #3151 | subject: the `NavigationHost` dispatch/journal/undo engine |
| `apps/ui/src/shared/navigation/ui/hostRegistry.ts` | shared/navigation (registry) | #3151 | subject: the host registry (`describeContext`/`registerNavigationHost`) |
| `apps/ui/src/shared/navigation/ui/NavigationProvider.tsx` | shared/navigation (shell) | #3151 | subject: the webview-wide engine shell provider + global key listener |
| `apps/ui/src/shared/navigation/ui/globalKeys.ts` | shared/navigation (chords) | #3151 | subject: the engine key dispatcher; the three surviving chords are re-homed in `window-system/platformChords.ts` (ST-4) |
| `apps/ui/src/shared/navigation/ui/terminalPassthrough.ts` | shared/navigation (passthrough) | #3151 | subject: the engine's terminal-passthrough focus tracking + announcement; chord suppression covers the surviving behaviour (ST-4) |
| `apps/ui/src/shared/navigation/ui/confirmation.ts` | shared/navigation (confirm store) | #3151 | subject: the launcher confirmation store — only the five deleted navigation providers ever requested a confirmation |
| `apps/ui/src/shared/navigation/ui/usePlaceTransitionFocus.ts` | shared/navigation | #3151 | subject: the engine's place-transition focus mover |
| `apps/ui/src/shared/navigation/ui/useReducedMotion.ts` | shared/navigation | #3151 | subject: the engine's reduced-motion hook; re-homed to `shared/hooks/useReducedMotion.ts` (ST-1) |

#### The engine's own suites (they moved with the module)

| path | suite | retired in | reason |
|---|---|---|---|
| `apps/ui/src/shared/navigation/__tests__/context.test.ts` | shared/navigation | #3151 | subject: the engine's `ContextEnvelope` derivation |
| `apps/ui/src/shared/navigation/__tests__/determinism.test.ts` | shared/navigation | #3151 | subject: engine determinism pins |
| `apps/ui/src/shared/navigation/__tests__/discover.test.ts` | shared/navigation | #3151 | subject: the command-discovery projection |
| `apps/ui/src/shared/navigation/__tests__/dispatch.test.ts` | shared/navigation | #3151 | subject: the dispatch funnel |
| `apps/ui/src/shared/navigation/__tests__/fixtures.ts` | shared/navigation | #3151 | subject: the engine suite fixtures |
| `apps/ui/src/shared/navigation/__tests__/fixtures/wireframe.navigation.golden.json` | shared/navigation | #3151 | subject: the engine golden manifest projection |
| `apps/ui/src/shared/navigation/__tests__/focusContext.test.ts` | shared/navigation | #3151 | subject: the engine focus classifier |
| `apps/ui/src/shared/navigation/__tests__/journal.test.ts` | shared/navigation | #3151 | subject: the shared journal |
| `apps/ui/src/shared/navigation/__tests__/keyResolver.test.ts` | shared/navigation | #3151 | subject: the stroke resolver |
| `apps/ui/src/shared/navigation/__tests__/keys.test.ts` | shared/navigation | #3151 | subject: the key grammar |
| `apps/ui/src/shared/navigation/__tests__/legacyAbsence.test.ts` | shared/navigation | #3151 | subject: the engine-era purge-token absence guard (its scanned root is the engine itself) |
| `apps/ui/src/shared/navigation/__tests__/manifest.test.ts` | shared/navigation | #3151 | subject: the engine manifest projection |
| `apps/ui/src/shared/navigation/__tests__/property.test.ts` | shared/navigation | #3151 | subject: engine property-based pins |
| `apps/ui/src/shared/navigation/__tests__/purity.test.ts` | shared/navigation | #3151 | subject: the engine module-purity scan |
| `apps/ui/src/shared/navigation/__tests__/resolver.test.ts` | shared/navigation | #3151 | subject: the place/stroke resolver |
| `apps/ui/src/shared/navigation/__tests__/riskPolicy.test.ts` | shared/navigation | #3151 | subject: the risk/confirmation policy |
| `apps/ui/src/shared/navigation/__tests__/rootExport.test.ts` | shared/navigation | #3151 | subject: the engine's `index.ts` barrel export |
| `apps/ui/src/shared/navigation/__tests__/traces.test.ts` | shared/navigation | #3151 | subject: the engine's budget traces |
| `apps/ui/src/shared/navigation/__tests__/validation.test.ts` | shared/navigation | #3151 | subject: the surface validation rules |
| `apps/ui/src/shared/navigation/__tests__/windowNfr.test.ts` | shared/navigation | #3151 | subject: the engine window NFR pins |
| `apps/ui/src/shared/navigation/ui/__tests__/a11y.test.tsx` | shared/navigation (UI) | #3151 | subject: rail/map/trail accessibility |
| `apps/ui/src/shared/navigation/ui/__tests__/activityTrail.test.tsx` | shared/navigation (UI) | #3151 | subject: the activity-trail surface |
| `apps/ui/src/shared/navigation/ui/__tests__/announce.test.tsx` | shared/navigation (UI) | #3151 | subject: the announcement region |
| `apps/ui/src/shared/navigation/ui/__tests__/commandRail.test.tsx` | shared/navigation (UI) | #3151 | subject: the command-rail surface |
| `apps/ui/src/shared/navigation/ui/__tests__/commandRailFocus.test.tsx` | shared/navigation (UI) | #3151 | subject: the command-rail focus model |
| `apps/ui/src/shared/navigation/ui/__tests__/fixtures.ts` | shared/navigation (UI) | #3151 | subject: the engine UI suite fixtures |
| `apps/ui/src/shared/navigation/ui/__tests__/globalKeys.test.ts` | shared/navigation (UI) | #3151 | subject: the engine key dispatcher |
| `apps/ui/src/shared/navigation/ui/__tests__/host.test.ts` | shared/navigation (UI) | #3151 | subject: the `NavigationHost` engine |
| `apps/ui/src/shared/navigation/ui/__tests__/hostRegistry.test.ts` | shared/navigation (UI) | #3151 | subject: the host registry + confirmation store |
| `apps/ui/src/shared/navigation/ui/__tests__/keycap.test.tsx` | shared/navigation (UI) | #3151 | subject: the keycap surface |
| `apps/ui/src/shared/navigation/ui/__tests__/keycapTokenHygiene.test.ts` | shared/navigation (UI) | #3151 | subject: the engine UI tree's token hygiene |
| `apps/ui/src/shared/navigation/ui/__tests__/models.test.ts` | shared/navigation (UI) | #3151 | subject: the rail/map/trail projections |
| `apps/ui/src/shared/navigation/ui/__tests__/navTheme.test.ts` | shared/navigation (UI) | #3151 | subject: the engine UI tree's raw-colour scan |
| `apps/ui/src/shared/navigation/ui/__tests__/navigationMap.test.tsx` | shared/navigation (UI) | #3151 | subject: the navigation-map surface |
| `apps/ui/src/shared/navigation/ui/__tests__/navigationProvider.test.tsx` | shared/navigation (UI) | #3151 | subject: the engine shell provider |
| `apps/ui/src/shared/navigation/ui/__tests__/projectionMutation.test.ts` | shared/navigation (UI) | #3151 | subject: projection-mutation pins |
| `apps/ui/src/shared/navigation/ui/__tests__/reducedMotion.test.tsx` | shared/navigation (UI) | #3151 | subject: the engine rail/keycap reduced-motion behaviour (re-pointed at `shared/hooks/useReducedMotion.ts`, ST-1) |
| `apps/ui/src/shared/navigation/ui/__tests__/rootExport.ui.test.ts` | shared/navigation (UI) | #3151 | subject: the engine UI barrel export |
| `apps/ui/src/shared/navigation/ui/__tests__/singleLiveRegion.test.tsx` | shared/navigation (UI) | #3151 | subject: the one-announcement-region invariant |
| `apps/ui/src/shared/navigation/ui/__tests__/terminalPassthrough.test.ts` | shared/navigation (UI) | #3151 | subject: the engine terminal-passthrough module |

#### The declared surfaces (the engine's consumers)

| path | suite | retired in | reason |
|---|---|---|---|
| `apps/ui/src/applications/terminal/terminalSurface.ts` | terminal-surface | #3151 | subject: the declared Terminal surface (2 places, 12 verbs); the keyboard model is deleted in #3151 |
| `apps/ui/src/applications/terminal/__tests__/terminalSurface.test.tsx` | terminal-surface | #3151 | subject: the declared Terminal surface + its provider |
| `apps/ui/src/applications/mission-monitor/missionMonitorSurface.ts` | mission-monitor-surface | #3151 | subject: the declared Mission Monitor surface |
| `apps/ui/src/applications/mission-monitor/__tests__/missionMonitorSurface.test.tsx` | mission-monitor-surface | #3151 | subject: the declared Mission Monitor surface + its provider |
| `apps/ui/src/applications/database-client/databaseClientSurface.ts` | sql-studio-surface | #3151 | subject: the declared SQL Studio surface (20 verbs); the selection projection is re-homed inline in the feature (grounding only) |
| `apps/ui/src/applications/database-client/__tests__/databaseClientSurface.test.tsx` | sql-studio-surface | #3151 | subject: the declared SQL Studio surface + its provider |
| `apps/ui/src/applications/dev-mode/devModeSurface.ts` | dev-mode-surface | #3151 | subject: the declared Dev Mode surface (4 bound element keys) |
| `apps/ui/src/applications/dev-mode/__tests__/devModeSurface.test.tsx` | dev-mode-surface | #3151 | subject: the declared Dev Mode surface + its provider |
| `apps/ui/src/shared/window-system/windowSystemSurface.ts` | window-system-surface | #3151 | subject: the declared window-system surface; the three surviving chords live in `platformChords.ts` (ST-4) |
| `apps/ui/src/shared/window-system/__tests__/windowSystemSurface.test.tsx` | window-system-surface | #3151 | subject: the declared window-system surface |
| `apps/ui/src/app/dev/navigationDemoSurface.ts` | navigation-demo | #3151 | subject: the DEV navigation prototype's demo surface |
| `apps/ui/src/app/dev/NavigationPreview.tsx` | navigation-preview | #3151 | subject: the DEV-only navigation prototype component |
| `apps/ui/src/app/dev/__tests__/navigationPreviewSeed.test.tsx` | navigation-preview | #3151 | subject: the DEV preview's seed state |
| `apps/ui/src/app/routes/__tests__/navigationPreviewExclusion.test.ts` | navigation-preview | #3151 | subject: the `?view=navigation-preview` DEV route exclusion (the route branch is deleted with the component) |

#### The four app navigation providers + the launcher confirmation

| path | suite | retired in | reason |
|---|---|---|---|
| `apps/ui/src/applications/terminal/components/TerminalNavigationProvider.tsx` | terminal-provider | #3151 | subject: the Terminal app's engine host + key adapter + footer + passthrough seam |
| `apps/ui/src/applications/mission-monitor/components/MissionMonitorNavigationProvider.tsx` | mission-monitor-provider | #3151 | subject: the Mission Monitor app's engine host + key adapter + footer |
| `apps/ui/src/applications/database-client/components/DatabaseClientNavigationProvider.tsx` | sql-studio-provider | #3151 | subject: the SQL Studio app's engine host + key adapter + footer + selection publish seam |
| `apps/ui/src/applications/dev-mode/components/DevModeNavigationProvider.tsx` | dev-mode-provider | #3151 | subject: the Dev Mode app's engine host + key adapter + footer |
| `apps/ui/src/applications/home/components/launcher/LauncherConfirmation.tsx` | launcher-confirmation | #3151 | subject: the launcher confirmation dialog — only the five deleted navigation providers ever requested a confirmation |
| `apps/ui/src/applications/home/components/launcher/launcherConstants.ts` | launcher-confirmation | #3151 | subject: the confirmation dialog's testids/labels/copy (the only consumer was the deleted dialog) |
| `apps/ui/src/applications/home/components/launcher/__tests__/LauncherConfirmation.test.tsx` | launcher-confirmation | #3151 | subject: the deleted confirmation dialog |
| `apps/ui/src/applications/home/components/launcher/__tests__/LauncherShell.retirement.test.tsx` | launcher-shell | #3151 | subject: the launcher shell over the engine (`NavigationProvider`, `NAVIGATION_GLOBAL_CHORDS`, the confirmation host) |
| `apps/ui/src/applications/home/components/__tests__/Home.devModeReachability.test.tsx` | home-devmode-reachability | #3151 | subject: the Konami→Dev Mode reachability pin that dispatched the declared Dev Mode surface over the engine (the Konami path itself is untouched) |
| `apps/ui/src/applications/terminal/components/__tests__/TerminalPassthrough.test.tsx` | terminal-passthrough | #3151 | subject: the engine terminal-passthrough focus tracking + body hook (both deleted) |

#### The companion verb-manifest bridge

| path | suite | retired in | reason |
|---|---|---|---|
| `apps/ui/src/shared/companion/manifest.ts` | companion-manifest | #3151 | subject: the companion manifest projection over registered navigation surfaces |
| `apps/ui/src/shared/companion/publisher.ts` | companion-publisher | #3151 | subject: the manifest publisher (`register_app_command_surfaces`) over the host registry |
| `apps/ui/src/shared/companion/useAppCommandIntent.ts` | companion-intent | #3151 | subject: the app-command intent relay into a navigation host |
| `apps/ui/src/shared/companion/reply.ts` | companion-reply | #3151 | subject: the app-command reply copy over the published manifest |
| `apps/ui/src/shared/companion/fixtures/wireframe.companion.golden.json` | companion-manifest | #3151 | subject: the companion golden manifest projected from the deleted Wireframe surface |
| `apps/ui/src/shared/companion/__tests__/publisher.test.ts` | companion-publisher | #3151 | subject: the deleted manifest publisher |
| `apps/ui/src/shared/companion/__tests__/useAppCommandIntent.test.tsx` | companion-intent | #3151 | subject: the deleted intent relay |
| `apps/ui/src/shared/companion/__tests__/reply.test.ts` | companion-reply | #3151 | subject: the deleted reply copy |
| `apps/ui/src/applications/home/hooks/useAppCommandSkill.ts` | companion-skill | #3151 | subject: Home's generic app-skill dispatcher over the published manifest + host intents |
| `apps/ui/src/applications/home/hooks/__tests__/useAppCommandSkill.test.tsx` | companion-skill | #3151 | subject: the deleted app-skill dispatcher |

#### Cross-surface matrix suites (their five subjects are all deleted above)

| path | suite | retired in | reason |
|---|---|---|---|
| `apps/ui/src/applications/__tests__/navigationParityMatrix.test.ts` | navigation-parity | #3151 | subject: verb/shape parity across the five deleted surfaces |
| `apps/ui/src/applications/__tests__/navigationBindingsCompleteness.test.ts` | navigation-bindings | #3151 | subject: the declared bindings of the five deleted surfaces + the engine's global chords |

#### Round-2 completion — the Wireframe app + window-system host and their suites

> These rows complete the ST-6 landing: the same deletion commit removed the paths below, but the
> first pass of this ledger omitted them. The deleted-path set is the authority — every path the
> deletion diff reports has a row here and in the sections above.

| path | suite | retired in | reason |
|---|---|---|---|
| `apps/ui/src/applications/wireframe/wireframeSurface.ts` | wireframe-surface | #3151 | subject: the Wireframe declaration (places / verbs); the keyboard model is deleted in #3151 |
| `apps/ui/src/applications/wireframe/components/WireframeNavigationProvider.tsx` | wireframe-provider | #3151 | subject: the Wireframe app's engine host + key adapter + footer |
| `apps/ui/src/shared/window-system/WindowSystemNavigationProvider.tsx` | window-system-provider | #3151 | subject: the window-system engine host + dock (the three surviving chords live in `platformChords.ts`) |
| `apps/ui/src/applications/wireframe/__tests__/wireframeKeyTable.test.ts` | wireframe-surface | #3151 | subject: the declared key table |
| `apps/ui/src/applications/wireframe/__tests__/wireframeLegacySurface.test.ts` | wireframe-surface | #3151 | subject: asserted `wireframeSurface.ts` exists and the deleted `navigation-rail` region |
| `apps/ui/src/applications/wireframe/__tests__/wireframeNavigationFocus.test.tsx` | wireframe-surface | #3151 | subject: the declaration's place-transition focus model |
| `apps/ui/src/applications/wireframe/__tests__/wireframePlaceLifecycle.test.ts` | wireframe-surface | #3151 | subject: the declaration's place lifecycle |
| `apps/ui/src/applications/wireframe/__tests__/wireframePointerConvergence.test.ts` | wireframe-surface | #3151 | subject: pointer/stroke convergence through the engine |
| `apps/ui/src/applications/wireframe/__tests__/wireframeRailParity.test.tsx` | wireframe-surface | #3151 | subject: the command rail's verb parity |
| `apps/ui/src/applications/wireframe/__tests__/wireframeSurface.test.ts` | wireframe-surface | #3151 | subject: the deleted declared surface + its provider |
| `apps/ui/src/applications/wireframe/__tests__/wireframeUndoScope.test.ts` | wireframe-surface | #3151 | subject: the shared-journal undo scope (Wireframe now owns an app-local bounded history) |
| `apps/ui/src/shared/companion/__tests__/manifest.test.ts` | companion-manifest | #3151 | subject: the companion manifest projection over registered navigation surfaces |
| `apps/ui/src/shared/companion/__tests__/manifest.parity.test.ts` | companion-manifest | #3151 | subject: the manifest parity matrix over the deleted surfaces |

### ST-8 — the committed absence guard (AC1's evidence)

**What the guard proves.** AC1's scoped absence predicate: **zero references to the retired
navigation engine anywhere under `apps/ui/src`, outside the named enforcement guard and the
evidence allowlist.** The guard scans exactly one root — `apps/ui/src` — for three token classes
(module paths, engine symbols, deleted-file import specifiers) and exits non-zero on any hit that
is not covered by the allowlist. **The evidence allowlist is empty by construction:** the guard
lives in `.opencode/scripts/` and this record in `.opencode/tests/retired-navigation/`, both
outside the scanned root, so neither needs an entry — and an allowlist entry may never name
product source under `apps/ui/src`.

The guard is paired with a non-vacuity control: `-SelfTest` seeds a real banned import into the
scanned root, proves it is caught at that exact path, removes the probe in a `try/finally`, and
asserts the tree scans clean again. It also proves the root confinement the predicate claims: the
same banned import written at `apps/ui/__nav_absence_probe_outside__.ts` (a sibling of the scanned
root) is **not** scanned, and the probe is likewise removed in a `try/finally`.

```powershell
# Plain run — exit 0 = clean, 1 = at least one hit, 2 = cannot run (bad root / zero files scanned)
powershell -File .opencode/scripts/check-navigation-retired.ps1

# Exit-code-assertable form (prints `EXITCODE=<n>` and exits with the guard's own code)
powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/scripts/check-navigation-retired.ps1"

# Non-vacuity control — exits 0 only when all four controls pass
powershell -File .opencode/scripts/check-navigation-retired.ps1 -SelfTest
powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/scripts/check-navigation-retired.ps1 -SelfTest"
```

### #3153 — prose dispositions (slice 3 of 3)

> This section records the **prose** disposition of surviving durable suites that taught the deleted
> model (#3153, slice 3 of 3 — docs/ADR/rules/test-prose sync). It is **not** a retirement list:
> the four engine suites stay retired exactly once, in #3151 (rows 1-17 above), and are **not**
> re-stamped here. The `path:line-range` values are the pre-sweep locations in the file named by
> `path`; each row quotes the deleted claim so the correction stays auditable from this ledger
> alone. Disposition is `CORRECTED` (the sentence is REPLACED with the shipped surface) or
> `REMOVED` (the site is gone and the reason says why) — a non-allowlisted suite never carries the
> deleted sentence behind a marker, because the absence guard's predicate is zero tokens. The
> successor row in `.opencode/tests/navigation-retirement/functional.md` is named per row so the
> capability stays covered somewhere; the shipped surface itself is the 23 pointer-reachable
> controls on `wireframe-control-strip` (`applications/wireframe/components/WireframeEditor.tsx:186-202`)
> plus the application-local bounded history `WIREFRAME_HISTORY_LIMIT = 100`
> (`applications/wireframe/store/wireframeHistory.ts:27`) and the three platform chords
> (`apps/ui/src/shared/window-system/platformChords.ts`). Appended by ST-6; ST-7 appends its own
> rows under this same heading.

| path:line-range | suite | disposition | replacement | reason |
|---|---|---|---|---|
| `.opencode/tests/wireframe/functional.md:18-31` | wireframe/functional | CORRECTED | `Hooks (C7)` no longer claims the engine's `data-nav-keycap` / `data-nav-verb-id` / `data-nav-availability` hooks "bound in `shared/navigation/ui/constants.ts`"; it names the strip's eight published testids from `components/wireframeControlIds.ts`. Successor: Q-19 | the engine's DOM hooks and the `legacyAbsence` gate that owned their absence were deleted in #3151 |
| `.opencode/tests/wireframe/functional.md:46-52` | wireframe/functional | CORRECTED | the "Focus gate before every key press" preamble no longer reads "the navigation `text-entry` focus context must not suppress the declared stroke" or `sequence.ts:146`; it is an ordinary widget-focus guard. Successor: Q-19 | the focus-context classifier and the engine's key path were deleted in #3151 |
| `.opencode/tests/wireframe/functional.md:262-269` | wireframe/functional | CORRECTED | F-26's zoom recipe was the two-step `g i` / `g o` with "the navigation bar's 250 ms pending hint" and "a lone `g`"; it is now the `Zoom in` / `Zoom out` `wireframe-view-item` controls with `ZOOM_STEP = 0.1`. Successor: Q-19 | no per-application stroke namespace or pending prefix survives the engine |
| `.opencode/tests/wireframe/functional.md:380-393` | wireframe/functional | CORRECTED | F-37 asserted "20 bare keys" plus the 12 `g`-namespace sequences through `[data-testid="wireframe-action-<suffix>"]`; it now asserts the 21 strip rows against their declared effects, by accessible name inside the opened popup, with a bare key recorded as inert. Successor: Q-19 | the key table and the action testids were deleted in #3119 P5 / #3151 |
| `.opencode/tests/wireframe/functional.md:394-399` | wireframe/functional | CORRECTED | F-38 asserted that `navigation-bar` "contains a row (`data-nav-verb-id`) … with a `data-nav-keycap` hint"; it now asserts the strip's enabled/disabled set tracks the selection on the same tick. Successor: Q-19 | the bar and its keycap hint were part of the deleted engine |
| `.opencode/tests/wireframe/functional.md:400-405` | wireframe/functional | CORRECTED | F-39 asserted "no navigation verb fires (the declaration's `text-entry` focus-context rule)"; it now asserts a panel keystroke fires nothing because nothing is bound, and names the chord-suppression classifier. Successor: Q-18 | the declaration and its focus-context rule were deleted in #3151 |
| `.opencode/tests/wireframe/functional.md:406-410` | wireframe/functional | CORRECTED | F-40 asserted "the Wireframe rows leave the bar" and `legacyAbsence.test.ts`; it now asserts an unfocused Wireframe is inert for every pointer command. Successor: Q-1 | the bar and its absence gate were deleted |
| `.opencode/tests/wireframe/functional.md:411-415` | wireframe/functional | CORRECTED | F-41 asserted `validation.test.ts` V-07 and one `NAV-E007` for a duplicate-stroke fixture; it now asserts each testid is published once per concern, pinned by `wireframePointerControls.test.tsx`. Successor: Q-19 | the validation rules and their diagnostic code were deleted with the engine |
| `.opencode/tests/wireframe/functional.md:416-421` | wireframe/functional | CORRECTED | F-42 cited the shipped `native-consumer` rule at `sequence.ts:146`; it now records standard widget behaviour only. Successor: Q-19 | `sequence.ts` was a `shared/navigation/` module, deleted in #3151 |
| `.opencode/tests/wireframe/functional.md:738-741` | wireframe/functional | CORRECTED | the round-4 technique note taught "a bare `KeyboardEvent` … does NOT reach the hotkey engine" and "`focus-context=text-entry`, hotkeys disabled"; it now says drive everything by pointer. Successor: Q-19 | the hotkey engine the technique described was deleted |
| `.opencode/tests/wireframe/functional.md:753-770` | wireframe/functional | CORRECTED | F-57's source-read leg read `WireframeToolbar.tsx:393`; it now reads `components/WireframeNewDocumentDialog.tsx`, the surviving owner of the dialog. Successor: Q-33 | `WireframeToolbar.tsx` was deleted in #3119 P5 |
| `.opencode/tests/wireframe/functional.md:798-809` | wireframe/functional | CORRECTED | F-60 required a green `WireframeToolbar.hotkeys.test.tsx` and a `WireframeToolbar` assertion; it now requires the surviving dialog token pin and names a shipped unit file. Successor: Q-33 | both the component and its hotkey suite were deleted |
| `.opencode/tests/wireframe/functional.md:815-817` | wireframe/functional | CORRECTED | the round-1 dialog path read "`wireframe-action-add-text` … `wireframe-action-document-new`"; it is the insert menu and the File menu's `New`. Successor: Q-16 | the action testids were deleted in #3119 P5 |
| `.opencode/tests/wireframe/functional.md:831-857` | wireframe/functional | CORRECTED | the #3071 header taught "the declaration-driven place surface (`navigation-bar` + `data-nav-*`)" and the declared keys `a g` / `a s` / `a ←`; it now names the 23 strip controls and the Arrange menu rows. Successor: Q-19 | the declaration, bar and key map were deleted in #3151 |
| `.opencode/tests/wireframe/functional.md:872-882` | wireframe/functional | CORRECTED | F-63's invoker was "declared stroke `a` then `g` / map row"; it is the `Group` row in `wireframe-arrange`. Successor: Q-19 | no declared stroke exists |
| `.opencode/tests/wireframe/functional.md:896-901` | wireframe/functional | CORRECTED | F-66's delete invoker was `delete (`k`)`; it is the `Delete` row in `wireframe-arrange`. Successor: Q-18 | no application key is bound |
| `.opencode/tests/wireframe/functional.md:902-911` | wireframe/functional | CORRECTED | F-67 asserted a "toolbar `aria-pressed`"; it is now the `Lock group` row's own state plus `wireframe-tag-group`. Successor: Q-19 | the toolbar was deleted in #3119 P5 |
| `.opencode/tests/wireframe/functional.md:912-917` | wireframe/functional | CORRECTED | F-68 locked a member "individually locked (`l`)"; it is the `Lock position and size` switch in the property panel. Successor: Q-18 | no application key is bound |
| `.opencode/tests/wireframe/functional.md:918-924` | wireframe/functional | CORRECTED | F-69's invoker was "declared stroke `a` then `s` / map row" and "the map/rail row's state"; it is the `Snap to grid` `role="menuitemcheckbox"` row with `aria-checked` + `data-wireframe-snap`. Successor: Q-19 | the map, rail and stroke grammar were deleted in #3151 |
| `.opencode/tests/wireframe/functional.md:933-942` | wireframe/functional | CORRECTED | F-71's invokers were the verb ids `alignLeft` / `alignCenter` / `alignRight`; they are the `Align left` / `Align centre` / `Align right` rows. Successor: Q-19 | same capability, pointer entry only |
| `.opencode/tests/wireframe/functional.md:943-950` | wireframe/functional | CORRECTED | F-72's invoker was `wireframe.arrange.distribute`; it is the `Distribute` row. Successor: Q-19 | same capability, pointer entry only |
| `.opencode/tests/wireframe/functional.md:959-968` | wireframe/functional | CORRECTED | F-74's invokers were `bringForward` / `sendBackward`; they are the `Bring forward` / `Send backward` rows. Successor: Q-19 | same capability, pointer entry only |
| `.opencode/tests/wireframe/functional.md:969-975` | wireframe/functional | CORRECTED | F-75's edge read "a visibly-disabled toolbar control"; it is a visibly-disabled strip row. Successor: Q-19 | the toolbar was deleted in #3119 P5 |
| `.opencode/tests/wireframe/functional.md:976-982` | wireframe/functional | CORRECTED | F-76 asserted "the `navigation-bar` lists a row (`data-nav-verb-id`) with its `data-nav-keycap` hint; the declared stroke produces the SAME visible change as the map row", plus `zoom.in` (`v` `+`) and V-07; it is now pointer/Companion parity over the strip's 23 controls. Successor: Q-19 | the bar, map and stroke grammar were deleted in #3151 |
| `.opencode/tests/wireframe/functional.md:1056-1064` | wireframe/functional | CORRECTED | the #3087 header taught "shortcuts show" only on "the always-on bottom hotkey bar" and "a real keystroke performing the action"; it now states that no control carries a key hint and no key is bound. Successor: Q-19 | the toolbar, the bar and the key model were all deleted |
| `.opencode/tests/wireframe/functional.md:1066-1096` | wireframe/functional | CORRECTED | F-84…F-90 asserted `NavKeycap` / `data-nav-keycap` / `navigation-bar` / `src/shared/navigation` / `keycap.test.tsx` / `legacyAbsence.test.ts` as the **current** observable; they now assert no key hint on any control (focused and unfocused), a pointer row performing its command, pointer operability + accessible name, the unit suite + build, a stable strip height, and no key-hint consumer. Successor: Q-19 | the chip, keycap, bar and navigation barrel were all deleted |
| `.opencode/tests/wireframe/functional.md:1098-1139` | wireframe/functional | CORRECTED | the #3119 note taught "`applications/wireframe/wireframeSurface.ts` (six places … 55 verbs) mounted with `CommandRail` + `NavigationMap` + `ActivityTrail`", a 250 ms `PENDING_TIMEOUT_MS` and `wireframe-navigation/functional.md` F-N1…F-N24; it now names the pointer strip and `.opencode/tests/navigation-retirement/` as the successor suite. Successor: Q-19 | the declared surface, the three UI surfaces and their suite were deleted in #3151 |
| `.opencode/tests/wireframe/functional.md:1141-1251` | wireframe/functional | CORRECTED | the whole #3119 P5 key map and row amendments taught a `c` / `e` / `v` / `f` / `a` stroke grammar, carried in-place markers on eight rows, and cited the `wireframe-navigation` suite; it is now a shipped-invoker map over the 23 controls with no in-place marker. Successor: Q-19 | a surviving suite may not keep the deleted sentence behind a marker (the guard's predicate is zero tokens); history is this row |
| `.opencode/tests/wireframe/functional.md:1236-1236` | wireframe/functional | REMOVED | the deleted sentence cited `.opencode/tests/hotkeys/` as work for the other applications' bar. Replacement: — | that suite has never existed, so citing it as work is exactly what AC5 forbids |
| `.opencode/tests/wireframe/regression.md:13-20` | wireframe/regression | CORRECTED | R-1 taught "the DECLARATION rule (`validation.test.ts` V-07) … exactly one `NAV-E007`" and `legacyAbsence.test.ts`; it is now the control-identity rule pinned by `wireframePointerControls.test.tsx`. Successor: Q-19 | the declaration, its validation rules and their diagnostics were deleted in #3151 |
| `.opencode/tests/wireframe/regression.md:21-24` | wireframe/regression | CORRECTED | R-2 taught "every retained surface's declared keys still resolve (Mission Monitor `s`/`n`/`p`, Dev Mode `x`/`v`/`i`/`b`)" and `.opencode/tests/navigation/` P8 F-49; it is now unfocused-window inertness. Successor: Q-1 | no application declares keys any more |
| `.opencode/tests/wireframe/regression.md:25-29` | wireframe/regression | CORRECTED | R-3 was the "bar contract": `navigation-bar` / `navigation-bar-list` / `navigation-bar-row` keeping `data-nav-keycap` / `data-nav-verb-id` semantics; it is now the pointer-strip contract (23 controls, no key chip, chord suppression, `Tab` hand-off). Successor: Q-19 | the bar was deleted with the engine |
| `.opencode/tests/wireframe/regression.md:78-79` | wireframe/regression | CORRECTED | the overlapping-suites list pointed at `.opencode/tests/navigation/` "the declaration model, the bar, the duplicate guard (V-07)"; it points at `.opencode/tests/navigation-retirement/`. Successor: Q-19 | that suite directory was retired in #3151 |
| `.opencode/tests/wireframe/regression.md:231-245` | wireframe/regression | CORRECTED | R-13's source anchors were `WireframeToolbar.tsx:393` and `:390-397`; they are now `components/WireframeNewDocumentDialog.tsx`. Successor: Q-33 | `WireframeToolbar.tsx` was deleted in #3119 P5 |
| `.opencode/tests/wireframe/regression.md:253-259` | wireframe/regression | CORRECTED | R-14 taught "the legacy bar moved 22 → 32 rows", "contributes its declaration's rows to `navigation-bar`", `legacyAbsence.test.ts` and `validation.test.ts` V-07; it is now the 23 pointer-control re-baseline with the toolbar absent. Successor: Q-19 | the bar, declaration and validation rules were deleted in #3151 |
| `.opencode/tests/wireframe/regression.md:298-305` | wireframe/regression | CORRECTED | R-19 taught `NavKeycap` (`data-nav-keycap`), `data-nav-verb-id`, `navigation/ui/__tests__/keycap.test.tsx` and `legacyAbsence.test.ts`; it is now no-key-hint + accessible-name + `Tab` order. Successor: Q-19 | the keycap, its suite and the absence gate were deleted |
| `.opencode/tests/wireframe/regression.md:307-313` | wireframe/regression | CORRECTED | the #3119 header said "the surface is declaration-driven"; it is the 23-control pointer strip. Successor: Q-19 | the declaration was deleted in #3151 |
| `.opencode/tests/wireframe/regression.md:315-323` | wireframe/regression | CORRECTED | R-20 taught "the legacy bar contained no Wireframe row", "the current observable is the navigation bar over the declaration" and `legacyAbsence.test.ts`; it is now 23 strip controls with the toolbar absent and a non-vacuity control. Successor: Q-19 | the bar was deleted with the engine |
| `.opencode/tests/wireframe/regression.md:325-330` | wireframe/regression | CORRECTED | R-21 taught "the 33 toolbar capabilities are still reachable as declared verbs (rail/map/keys)" and "Undo/Redo via `u`/`y`"; it is now the 23 pointer controls, Undo/Redo being the two dedicated history buttons. Successor: Q-19 | the rail, map and root aliases were deleted in #3151 |
| `.opencode/tests/wireframe/regression.md:332-338` | wireframe/regression | CORRECTED | R-22 named `place.saveAs` / `place.open` / `place.exportPng` and `wireframe-navigation/regression.md` R-N4/R-N5; it now names the surviving `runWireframeAction` entry points. Successor: Q-33 | the place-scoped file verbs and their suite were deleted |
| `.opencode/tests/wireframe/regression.md:340-346` | wireframe/regression | CORRECTED | R-23 taught "ONE undo step through the journal", "the trail's per-entry Undo" and `wireframe-navigation` F-N17/F-N18/F-N19; it is now the app-local bounded history and one `wireframe-undo` click. Successor: Q-29 | the shared journal and the trail were deleted in #3151 (Wireframe now owns its own history) |
| `.opencode/tests/wireframe/regression.md:348-353` | wireframe/regression | CORRECTED | R-24 reached the dialog with `f n` and deferred the owning component to ST-7 as a NAMED BLOCKER; it is the File menu's `New` row with the owner named. Successor: Q-33 | no key is bound; the dialog's owner exists |
| `.opencode/tests/wireframe/regression.md:355-360` | wireframe/regression | CORRECTED | R-25 said "the canvas does NOT subscribe to the journal" and cited `wireframe-navigation` F-N24; it now says the history container, with the surviving pins. Successor: Q-29 | the journal was deleted in #3151 |
| `.opencode/tests/wireframe/regression.md:377-392` | wireframe/regression | CORRECTED | the round-1 results table described `wireframeRailParity.test.tsx`'s 33-row manifest and declared "the navigation bar is the current surface"; the PASS record is kept and each row now states the strip-based expectation. Successor: Q-19 | the re-baselined surface was itself deleted in #3151 |
| `.opencode/tests/wireframe/smoke.md:21-25` | wireframe/smoke | CORRECTED | S-3 required "`wireframe-canvas`, `wireframe-toolbar`, `wireframe-page-controls`"; it requires the shipped hooks incl. `wireframe-details-column`, `wireframe-control-strip` and `wireframe-insert`. Successor: Q-19 | the toolbar was deleted in #3119 P5 |
| `.opencode/tests/wireframe/smoke.md:32-35` | wireframe/smoke | CORRECTED | S-6 said "press `1` from the `default` focus gate (`data-fredo-focus-context=default`)"; it is the insert menu's `Text` item. Successor: Q-16 | no application key is bound |
| `.opencode/tests/wireframe/smoke.md:36-40` | wireframe/smoke | CORRECTED | S-7 said "press `w` … then `document.new` and `o`"; it is the File menu's `Save As` / `New` / `Open` rows. Successor: Q-33 | no application key is bound |
| `.opencode/tests/wireframe/smoke.md:41-43` | wireframe/smoke | CORRECTED | S-7b said "press `w`"; it clicks the File menu's `Save As` row. Successor: Q-34 | no application key is bound |
| `.opencode/tests/wireframe/smoke.md:53-56` | wireframe/smoke | CORRECTED | S-9 was the legacy-bar quick path: "the current observable is the navigation bar (`navigation-bar`) over the Wireframe declaration … `legacyAbsence.test.ts`"; it is now the 23-control pointer strip quick path. Successor: Q-19 | the bar and its absence gate were deleted |
| `.opencode/tests/wireframe/smoke.md:104-106` | wireframe/smoke | CORRECTED | the round-1 S-9 line said "(P5/P8 replaced this with the" navigation bar; the historical record is kept and re-pointed at the pointer strip. Successor: Q-19 | the bar was deleted with the engine |
| `.opencode/tests/wireframe/smoke.md:131-133` | wireframe/smoke | CORRECTED | the round-4 S-9 line said "P5/P8 replaced this with the navigation bar and `data-nav-keycap` / `data-nav-verb-id`"; the historical record is kept and re-pointed at the pointer strip. Successor: Q-19 | those hooks no longer exist |
| `.opencode/tests/wireframe/smoke.md:140-149` | wireframe/smoke | CORRECTED | S-11 said "press **New**"; it clicks the File menu's `New` row. Successor: Q-33 | no application key is bound |
| `.opencode/tests/wireframe/smoke.md:159-163` | wireframe/smoke | CORRECTED | S-12 said "from the `default` focus gate add two elements (`1`, `2`) … press `g` then `g`"; it is the insert menu plus the `Group` row. Successor: Q-16 | no application key is bound |
| `.opencode/tests/wireframe/smoke.md:164-167` | wireframe/smoke | CORRECTED | S-13 said "toggle snap (`g` `s`) … press `g` `a` (align left) … ONE `u` reverts"; it is the `Snap to grid` and `Align left` rows with one `wireframe-undo` click. Successor: Q-19 | no application key is bound |
| `.opencode/tests/wireframe/smoke.md:171-174` | wireframe/smoke | CORRECTED | S-15 taught "P5 deleted the `g` namespace; Wireframe strokes are now the declaration's place keys … the 250 ms navigation prefix rendered in `navigation-bar`"; it now states no key is bound and the strip is pointer-only. Successor: Q-19 | the namespace, the declaration and the prefix were deleted in #3151 |
| `.opencode/tests/wireframe/smoke.md:184-187` | wireframe/smoke | CORRECTED | S-16 was the toolbar/keycap quick path: "the current surface is the navigation bar with `data-nav-keycap` hints. Press `c` then `t`"; it is a no-key-hint check driven from the insert menu. Successor: Q-16 | the toolbar, keycap and bar were deleted |
| `.opencode/tests/wireframe/smoke.md:189-217` | wireframe/smoke | CORRECTED | the P5 re-baseline block taught "Wireframe is driven by a declaration of six places", `wireframe-navigation/smoke.md` (S-N1…S-N8), `navigation-bar`, `data-wireframe-place` and the `c`/`f`/`a`/`g` re-baselined recipes; it is now the 23-control strip with `.opencode/tests/navigation-retirement/` as the successor suite. Successor: Q-19 | the declaration, its smoke suite and the place model were deleted in #3151 |
| `.opencode/tests/wireframe/smoke.md:219-237` | wireframe/smoke | CORRECTED | S-17/S-18/S-19 asserted "`navigation-bar` (six place rows + ≤ 8 verb rows), `navigation-trail`, `navigation-map` trigger", breadcrumb/announcement text and "Press `c` … `c` `r`"; they are now the pointer-shell, arrange and create quick paths. Successor: Q-16 | the bar, trail, map and announcement channels were deleted in #3151 |
| `.opencode/tests/wireframe/exploratory.md:30-35` | wireframe/exploratory | CORRECTED | E-5/E-6 said "Hammer `u`/`y` 20×"; they hammer the two history controls. Successor: Q-29 | root aliases were deleted in #3151 |
| `.opencode/tests/wireframe/exploratory.md:36-41` | wireframe/exploratory | CORRECTED | E-7 asked "do the declared navigation strokes resolve correctly when focus leaves?" and E-8 asked whether "the navigation bar's row set ever stick, does a duplicate-stroke diagnostic ever appear"; they now ask whether the field keeps the characters and whether the chord suppression classifies it. Successor: Q-18 | the declared strokes, the bar and the duplicate-stroke diagnostic were deleted |
| `.opencode/tests/wireframe/exploratory.md:230-232` | wireframe/exploratory | CORRECTED | E-31 said "Arm the 250 ms navigation prefix … Does the armed prefix leak or fire a stale action after the timeout?"; it is now text entry under focus churn. Successor: Q-18 | the prefix and its armed state were deleted in #3151 |
| `.opencode/tests/wireframe/exploratory.md:247-250` | wireframe/exploratory | CORRECTED | E-34 said "inspect the bar DOM … `legacyAbsence.test.ts` … the navigation bar's row count"; it inspects the strip's DOM and its 23-control count. Successor: Q-19 | the bar and its absence gate were deleted |
| `.opencode/tests/wireframe/exploratory.md:251-253` | wireframe/exploratory | CORRECTED | E-35 checked "the navigation bar's `data-nav-verb-id` rows" and "the declaration's verb title"; it checks the strip's row identity and accessible names. Successor: Q-19 | those hooks no longer exist |
| `.opencode/tests/wireframe/exploratory.md:254-258` | wireframe/exploratory | CORRECTED | E-36 asserted "the `wireframe.document.new` row has no `data-nav-keycap` hint"; it asserts no control carries a `(hotkey)` suffix. Successor: Q-19 | the keycap hint no longer exists |
| `.opencode/tests/wireframe/exploratory.md:260-265` | wireframe/exploratory | CORRECTED | the #3119 probes header said "Wireframe is driven by six declared places" and promoted findings to `wireframe-navigation/functional.md` as `F-N<n>`; it now names the pointer surface and `functional.md`. Successor: Q-19 | the declaration and its suite were deleted in #3151 |
| `.opencode/tests/wireframe/exploratory.md:267-270` | wireframe/exploratory | CORRECTED | E-37 said "Press Style `f`/`o`/`p`/`z`/`t` and Edit `r`"; it is the property-panel value cycles. Successor: Q-18 | no application key is bound |
| `.opencode/tests/wireframe/exploratory.md:271-276` | wireframe/exploratory | CORRECTED | E-38/E-39 armed a rect with `c r`, pressed `s`/`f`/`u` "at root / in Create / in Arrange / in Style" and looked for "cross-place leakage … tier 2/4"; they are now a cross-menu activation leak and a cross-cluster identity probe. Successor: Q-19 | the place tree and its tiers were deleted in #3151 |
| `.opencode/tests/wireframe/exploratory.md:277-282` | wireframe/exploratory | CORRECTED | E-40/E-41 counted "updates in the single live region" for a transient auto-exit and asked whether focus survives "the auto-exit … the same rail row"; they are now an accessible-name dialogue and focus survival across a popup. Successor: Q-19 | the live region, the auto-exit and the rail were deleted |
| `.opencode/tests/wireframe/exploratory.md:283-287` | wireframe/exploratory | CORRECTED | E-42 probed residue "gate-owned by `legacyAbsence.test.ts`"; it is now the toolbar/keyboard-surface residue probe. Successor: Q-19 | the gate that owned the absence was deleted |
| `.opencode/tests/wireframe/exploratory.md:288-290` | wireframe/exploratory | CORRECTED | E-43 said "the 10-entry trail" cap and "The journal is intentionally unbounded this slice"; it now names the bounded `WIREFRAME_HISTORY_LIMIT = 100`. Successor: Q-31 | the trail and the journal were deleted; the app-local history is bounded |

#### ST-7 — the remaining suites (launcher, terminal, companion, workspace-layout, doom)

| `.opencode/tests/launcher/functional.md:2087-2124` | launcher/functional | CORRECTED | the #3120 launcher preamble taught a context-grounded launcher, a `describeContext` header, a 55-verb palette, a risk-policy confirmation and `/ Ask`; it now states the shipped launcher is app launch/search + the open-apps row + the command bar, and names the three static companion skills and `readCompanionGrounding`. Successor: Q-19 | the context header, palette, confirmation and routed-intent bridge were deleted with the engine in #3151 |
| `.opencode/tests/launcher/functional.md:2125-2160` | launcher/functional | CORRECTED | F-126 asserted `launcher-context` with `launcher-context-path` / `-selection` / `-verb` chips fed by `describeContext('wireframe')` and a `data-nav-verb-id` row; it now asserts those nodes count 0 over an open Wireframe window. Successor: Q-19 | no application registers a navigation host, so there is no context to render |
| `.opencode/tests/launcher/functional.md:2161-2173` | launcher/functional | CORRECTED | F-127 asserted `launcher-palette-announcer` NOT mounted, no `launcher-palette-list`, and that `>` renders the shipped `LauncherActionList` with `launcher-action-entry` rows; it now asserts the launcher DOM is identical whatever app is focused and `>` is literal query text. Successor: Q-19 | the action palette and its announcer were deleted |
| `.opencode/tests/launcher/functional.md:2174-2203` | launcher/functional | CORRECTED | F-128 asserted the header refreshed through a NavigationHost epoch / value fingerprint and cited `host.test.ts` `N-04b`; it now asserts there is no live header to refresh. Successor: Q-19 | the host registry and its refresh mechanism were deleted with the engine |
| `.opencode/tests/launcher/functional.md:2204-2221` | launcher/functional | CORRECTED | F-129 ran `launcherNavigationPalette.test.ts` and asserted a 55-row `derivePalette` Place→Verb projection with `firstKeyInPlace`; it now asserts no palette projection module exists. Successor: Q-19 | the palette projection was deleted |
| `.opencode/tests/launcher/functional.md:2222-2235` | launcher/functional | CORRECTED | F-130 asserted `launcher-palette-list` with `launcher-palette-group`, `launcher-palette-row-risk` / `-key`, `data-nav-risk` and `data-nav-availability`; it now asserts `>` renders ordinary results with no `launcher-palette-*` node. Successor: Q-19 | the palette surface was deleted |
| `.opencode/tests/launcher/functional.md:2236-2250` | launcher/functional | CORRECTED | F-131 asserted a plain query became a grounded companion turn with the context header rendered; it now asserts the plain query stays ordinary search text and the launcher sends no grounding envelope (the composer grounds). Successor: Q-19 | the launcher no longer converses; the composer does |
| `.opencode/tests/launcher/functional.md:2251-2264` | launcher/functional | CORRECTED | F-132 asserted voice/typed parity at the routed-intent seam, `app_command_intent`, `app-command-intent-result` and a journal entry per leg; it now asserts no routed-intent seam exists. Successor: Q-19 | the per-application command relay was deleted in #3151 |
| `.opencode/tests/launcher/functional.md:2265-2279` | launcher/functional | CORRECTED | F-133 asserted Enter ran the row through the ONE dispatch funnel with `effect 'navigation'` / `effect 'mutation'` journal entries; it now asserts Enter takes the shipped `resolveEnterAction` app-open / no-match path. Successor: Q-19 | the dispatch funnel and journal were deleted |
| `.opencode/tests/launcher/functional.md:2280-2294` | launcher/functional | CORRECTED | F-134 asserted `launcher-palette-secondary` opened via `buildLauncherRowActions` and `host.runIntent`, with a `map` item opening the `navigation-map` dialog; it now asserts no row-actions panel exists. Successor: Q-19 | the secondary panel and the navigation map were deleted |
| `.opencode/tests/launcher/functional.md:2295-2307` | launcher/functional | CORRECTED | F-135 asserted the Esc stack popped one palette level; it now asserts one Esc closes the launcher because no level stack exists. Successor: Q-19 | the level stack belonged to the deleted palette |
| `.opencode/tests/launcher/functional.md:2308-2321` | launcher/functional | CORRECTED | F-136 ran `shared/navigation/__tests__/manifest.test.ts` and asserted a 49-verb published manifest with `journal.undo`, `aliases` and `risk`; it now asserts the companion offer is the three static skills from the zero-argument `companion_skill_registry()`. Successor: Q-19 | the navigation manifest projection was deleted in #3151 |
| `.opencode/tests/launcher/functional.md:2322-2335` | launcher/functional | CORRECTED | F-137 asserted `risk`/`aliases` crossing the Rust wire into `app_command_surfaces`; it now asserts no command-surface wire type exists. Successor: Q-19 | the command-surface wire was deleted |
| `.opencode/tests/launcher/functional.md:2336-2348` | launcher/functional | CORRECTED | F-138 asserted a companion-channel intent mutating state with `actor:'companion'` / `channel:'agent'` journal entries; it now asserts a companion skill acts through its own handler with no relay or journal entry. Successor: Q-19 | the intent relay and journal were deleted |
| `.opencode/tests/launcher/functional.md:2349-2361` | launcher/functional | CORRECTED | F-139 asserted `outcome:"Invalid"` / `unknown-verb` / `unavailable` / `invalid-args` result events and the deleted `useAppCommandIntent.test.tsx`; it now asserts an unavailable arrange row is a no-op. Successor: Q-19 | the result-event relay was deleted |
| `.opencode/tests/launcher/functional.md:2362-2375` | launcher/functional | CORRECTED | F-140 asserted safe/mutating launcher intents applying with exactly one journal entry and cited `riskPolicy.test.ts`; it now asserts every strip action applies with no confirmation. Successor: Q-19 | the risk policy and journal were deleted |
| `.opencode/tests/launcher/functional.md:2376-2391` | launcher/functional | CORRECTED | F-141 asserted the `launcher-confirmation` dialog with `launcher-confirmation-verb` / `-target` / `-consequence` / `-undo`, `launcherConfirmTitle` and `journal.undo`; it now asserts a destructive action has no confirmation host. Successor: Q-41 | the confirmation host was deleted in #3151 |
| `.opencode/tests/launcher/functional.md:2392-2418` | launcher/functional | CORRECTED | F-142 asserted the `external` risk class live on `place.exportPng` with `launcherConfirmExternal` and `LauncherConfirmation.test.tsx`; it now asserts Export PNG writes at the seam with no dialog. Successor: Q-24 | the external risk class and confirmation host were deleted |
| `.opencode/tests/launcher/functional.md:2419-2432` | launcher/functional | CORRECTED | F-143 asserted `canceled-confirmation` statuses, `requestLauncherConfirmation` and the deleted `hostRegistry.test.ts` / `riskPolicy.test.ts` pins; it now asserts dismissing the shipped New-discard dialog changes nothing. Successor: Q-33 | the confirmation store was deleted |
| `.opencode/tests/launcher/functional.md:2433-2447` | launcher/functional | CORRECTED | F-144 ran `launcherUndoQuery.test.ts` and asserted the undo-by-description phrase table plus `resolveLauncherRoute`; it now asserts the app-local bounded history is the only undo path. Successor: Q-29 | the undo phrase matcher was deleted |
| `.opencode/tests/launcher/functional.md:2448-2459` | launcher/functional | CORRECTED | F-145 asserted the launcher closing to reveal the trail and a `journal.undo` companion phrase; it now asserts one `wireframe-undo` click reverts only the newest edit. Successor: Q-29 | the trail and journal were deleted; the history control replaces them |
| `.opencode/tests/launcher/functional.md:2460-2470` | launcher/functional | CORRECTED | F-146 asserted a block of three companion entries undone via the phrase; it now asserts three `wireframe-undo` clicks revert three entries newest-first. Successor: Q-31 | the phrase route was deleted |
| `.opencode/tests/launcher/functional.md:2471-2483` | launcher/functional | CORRECTED | F-147 asserted `navigation-trail-entry` / `data-nav-actor` / `You`-`Companion` attribution and refreshed P3/P4 pins; it now asserts no attribution channel exists (the history entry carries `verbId` + a human label). Successor: Q-29 | the journal attribution model was deleted |
| `.opencode/tests/launcher/functional.md:2484-2499` | launcher/functional | CORRECTED | F-148 asserted ambiguous-undo clarify copy (`UNDO_NO_MATCH_COPY`, `data-launcher-response`) and zero journal entries; it now asserts the undo phrases are ordinary search text with no response line. Successor: Q-13 | the undo matcher and response line were deleted |
| `.opencode/tests/launcher/functional.md:2500-2512` | launcher/functional | CORRECTED | F-149 asserted `navigation-rail-ask` opening a pre-focused grounded launcher with `launcher-context` and `app.ask`; it now asserts Ctrl+Space is the only launcher entry and no rail Ask control exists. Successor: Q-19 | the rail and its Ask verb were deleted with the engine |
| `.opencode/tests/launcher/functional.md:2513-2522` | launcher/functional | CORRECTED | F-150 recorded the rail Ask button as the pre-open element and named a confirmation close; it now records a generic pre-open element with no confirmation. Successor: Q-19 | the rail and confirmation were deleted |
| `.opencode/tests/launcher/functional.md:2523-2536` | launcher/functional | CORRECTED | F-151 asserted the results region shows "the grouped palette, one row's actions, or ONE response sentence" and named the S6 line; it now asserts only tiles and the open-apps row, with the reply in the seat bubble. Successor: Q-19 | the palette, secondary and response line were deleted |
| `.opencode/tests/launcher/functional.md:2537-2559` | launcher/functional | CORRECTED | F-152 re-adjudicated the historical evaluation template's participant columns, RQ titles and Gate H handoff as live expectations; it now asserts only that the historical file exists by exact path (it is allowlisted) and is not re-adjudicated. Successor: Q-19 | the pilot programme it documented is superseded; its record is history, not a live contract |
| `.opencode/tests/launcher/functional.md:2560-2571` | launcher/functional | CORRECTED | F-153 asserted the historical template's no-data banner and cited `docs/NAVIGATION_ENGINE.md:544` as a live comparator; it now asserts no fabricated verdict and that the superseded docs are kept and banner-marked. Successor: Q-19 | the contract it cited is superseded |
| `.opencode/tests/launcher/functional.md:2572-2586` | launcher/functional | CORRECTED | F-154 asserted the historical cohort quotas and GO-gate procedure as live contract; it now asserts they are unchanged historical record (this slice does not rewrite the evaluation). Successor: Q-19 | the programme is superseded; its record is kept |
| `.opencode/tests/launcher/functional.md:2587-2602` | launcher/functional | CORRECTED | F-155 asserted exactly one `launcher-palette-announcer` with `launcherPaletteAnnouncement(row)` and a 55-row arrow walk; it now asserts the shipped live regions (`launcher-queued-announcer` etc.) and no palette announcer. Successor: Q-19 | the palette announcer was deleted |
| `.opencode/tests/launcher/functional.md:2603-2615` | launcher/functional | CORRECTED | F-156 asserted `NAV_REDUCED_MOTION_QUERY` suppressed palette/secondary/confirmation entrances; it now asserts the shipped launcher animates nothing the slice added. Successor: Q-19 | those entrances were deleted |
| `.opencode/tests/launcher/functional.md:2616-2630` | launcher/functional | CORRECTED | F-157 scanned `shared/navigation/ui/hostRegistry.ts` / `confirmation.ts` / `launcherBridge.ts`; it now scans the shipped launcher files only (the retired paths are gone). Successor: Q-19 | those modules were deleted |
| `.opencode/tests/launcher/functional.md:2631-2644` | launcher/functional | CORRECTED | F-158 named the context region `Current context`, list `Places and actions`, secondary `Row actions` and the announcer `Launcher announcements`; it now names the shipped command bar and tile labels. Successor: Q-19 | those surfaces were deleted |
| `.opencode/tests/launcher/functional.md:2645-2658` | launcher/functional | CORRECTED | F-159 asserted `describeContext()` as a synchronous registry read (`getNavigationHost` → `host.describeContext()`) and a 55-row filter; it now asserts a pure `useMemo` filter over the registry with no dispatch path. Successor: Q-19 | the host registry and its context read were deleted |
| `.opencode/tests/launcher/functional.md:2659-2670` | launcher/functional | CORRECTED | F-160 ran `shared/navigation/__tests__/context.test.ts` and asserted `buildContextEnvelope` within `CAPABILITY_LIMITS.maxContextBytes` / `maxVerbs`; it now asserts the shipped `COMPANION_CAPABILITY_LIMITS.maxContextBytes` = 16384 grounding cap. Successor: Q-39 | the context envelope module was deleted; the grounding cap survives |
| `.opencode/tests/launcher/functional.md:2671-2686` | launcher/functional | CORRECTED | F-161 named refreshed P3/P4 pins, `NAV_ASK_DISABLED_REASON`, `commandRail.test.tsx` and a published navigation surface; it now asserts build/suite green, an unchanged listener count and the ONE platform-chord listener. Successor: Q-42 | those pins and surfaces were deleted |
| `.opencode/tests/launcher/functional.md:2687-2700` | launcher/functional | CORRECTED | F-162 referenced "the companion generation in F-131" for its span lever; it now references a companion generation generically (F-131 is the no-envelope row). Successor: Q-36 | the grounding-envelope send path it named was deleted |
| `.opencode/tests/launcher/regression.md:869-877` | launcher/regression | CORRECTED | the #3120 regression block header taught the context header, grouped navigation palette, confirmation, undo route and `/ Ask` as in force; it now states the human-directed rescope rejected that experience and the engine is deleted, and re-points the block at the shipped launcher. Successor: Q-19 | the whole experience was rejected and the engine deleted in #3151 |
| `.opencode/tests/launcher/regression.md:878-889` | launcher/regression | CORRECTED | R-75 asserted the shipped `LauncherActionList` (`launcher-action-entry` / `-tier` / `-binding` / `-unbound` / `-empty`) and `runHotkeyAction(actionId,'palette')` for `>`; it now asserts `>` stays literal text with no palette, no action list and no announcer. Successor: Q-19 | the action list and hotkey palette were deleted |
| `.opencode/tests/launcher/regression.md:890-900` | launcher/regression | CORRECTED | R-76 asserted "the context header adds height BELOW the bar only" as a shipped invariant; it now asserts the launcher reads no application context so no header exists. Successor: Q-19 | the context header was deleted |
| `.opencode/tests/launcher/regression.md:901-910` | launcher/regression | CORRECTED | R-77 asserted "NOT re-animated or re-copied by P6" and named a `>` Enter leg; it now asserts the shipped cues are unchanged with no palette leg. Successor: Q-19 | the P6 palette is deleted |
| `.opencode/tests/launcher/regression.md:911-920` | launcher/regression | CORRECTED | R-78 asserted a keyboard `wireframe.element.delete` yielding no `launcher-confirmation` and one journal entry, gating only `launcher|voice|agent` channels; it now asserts a pointer `Delete` row applies with no confirmation because no requester exists. Successor: Q-18 | the host risk policy and journal were deleted |
| `.opencode/tests/launcher/regression.md:921-932` | launcher/regression | CORRECTED | R-79 ran `shared/navigation/__tests__/journal.test.ts` + `dispatch.test.ts` + `ui/__tests__/host.test.ts` and asserted refreshed `actor:'system'` pins; it now asserts those files do not exist and names the surviving `wireframeHistory.test.ts` + `wireframeUndoAuthority.test.ts` pins. Successor: Q-29 | the journal/dispatch/host modules were deleted in #3151 |
| `.opencode/tests/launcher/regression.md:933-942` | launcher/regression | CORRECTED | R-80 asserted the no-surface launcher DOM has no `launcher-context`, `launcher-palette-announcer`, `launcher-palette-list`, `launcher-response` or confirmation node, differing from the Wireframe case only by the P6 nodes; it now asserts BOTH cases carry none of them. Successor: Q-19 | the P6 nodes were deleted |
| `.opencode/tests/launcher/regression.md:943-959` | launcher/regression | CORRECTED | R-81 asserted the Rust `app_command_surfaces` manifest publishes every app's navigation surface (49 verbs + `journal.undo`) and a `listActions` reserved id; it now asserts the companion offer is exactly the three static skills from the zero-argument registry. Successor: Q-19 | the manifest projection was deleted in #3151 |
| `.opencode/tests/launcher/regression.md:960-980` | launcher/regression | CORRECTED | R-82 asserted the `/ Ask` affordance state and rail/map parity; it now asserts no `/ Ask` affordance and no rail survive, with Ctrl+Space the only entry. Successor: Q-19 | the rail, map and Ask verb were deleted |
| `.opencode/tests/launcher/regression.md:970-980` | launcher/regression | CORRECTED | R-83 asserted the context header derived via `useMemo` over `activeAppId` + host epoch; it now asserts no derived header memo exists to loop. Successor: Q-19 | the header was deleted |
| `.opencode/tests/launcher/regression.md:990-1000` | launcher/regression | CORRECTED | R-85 asserted the Wireframe adapter stays element-scoped and the launcher `Ctrl+K` never runs a hotkey action; it now asserts the ONE capture-phase listener is `installPlatformChords` with the three chords and chord suppression. Successor: Q-42 | the element-scoped adapter was deleted with the engine |
| `.opencode/tests/launcher/regression.md:1001-1009` | launcher/regression | CORRECTED | R-86 asserted `requestLauncherConfirmation` resolves `false` with no launcher mounted; it now asserts a destructive intent has no confirmation host at all. Successor: Q-41 | the confirmation store was deleted in #3151 |
| `.opencode/tests/terminal/functional.md:1657-1666` | terminal/functional | CORRECTED | F-84 ran `src/shared/navigation/ui/__tests__/terminalPassthrough.test.ts` and asserted the relocated `terminalPassthrough.test.ts`; it now pins `chordSuppression.test.ts` (`TERMINAL_ROOT_SELECTOR` + the `'terminal'` classification) and `terminalPrimaryControl.test.tsx:149`. Successor: Q-13 | the terminal passthrough module was deleted with the engine; the chord classifier is the shipped mechanism |
| `.opencode/tests/terminal/functional.md:1667-1677` | terminal/functional | CORRECTED | F-85 asserted a ONE-time `PASSTHROUGH_ANNOUNCEMENT_PREFIX` announcement in `[data-testid="navigation-announcer"]`; it now asserts passthrough is derived from focus via the chord classifier and that no announcement channel exists. Successor: Q-13 | the announcer and the announcement prefix were deleted in #3151 |
| `.opencode/tests/terminal/functional.md:1684-1693` | terminal/functional | CORRECTED | F-87 asserted no `addEventListener('keydown'` in `src/shared/navigation/ui/terminalPassthrough.ts` and that "the navigation command bar is untouched"; it now asserts no per-terminal keydown listener exists and that the ONE capture-phase listener is `platformChords.ts`. Successor: Q-13 | the nav command bar and the terminal listener module were deleted |
| `.opencode/tests/terminal/regression.md:506-519` | terminal/regression | CORRECTED | R-29/R-30 asserted `installTerminalPassthrough`, `PASSTHROUGH_ANNOUNCEMENT_PREFIX`, `announceNavigation` and a `navigation-announcer` region; they now assert `TERMINAL_ROOT_SELECTOR` + `classifyChordSuppression` and that passthrough is focus-derived with no announcement channel. Successor: Q-13 | the passthrough module and its announcement were deleted with the engine |
| `.opencode/tests/terminal/regression.md:520-526` | terminal/regression | CORRECTED | R-31 asserted the ONE keydown path in `src/shared/navigation/ui/terminalPassthrough.ts` and "the navigation command bar is untouched"; it now asserts no per-terminal keydown listener and that the ONE listener belongs to `platformChords.ts`. Successor: Q-13 | those modules were deleted |
| `.opencode/tests/companion/functional.md:3121-3168` | companion/functional | CORRECTED | F-167/F-168/F-169 asserted the grounded turn equalled `describeContext('wireframe')` and executed "through the SAME dispatch" relay with `actor:'companion'` journal entries; they now assert the grounding is `readCompanionGrounding(appId)` (the payload fields) and the change lands through the composer's one submit path. Successor: Q-37 | `describeContext` and the ONE dispatch funnel were deleted with the engine in #3151 |
| `.opencode/tests/workspace-layout/regression.md:28-30` | workspace-layout/regression | CORRECTED | R-7 named the deleted engine by bare filename — `normalizeKeyStroke` (`keys.ts:314-352`), `resolvePrimaryModifier` `keys.ts:158-160` and "the engine's single capture listener + dispatch (`engine.ts:678-712`)" — and referenced `.opencode/tests/hotkeys/`; it now names `matchesZoneChord` (`shared/window-system/zoneLayout.ts:351`) + `resolvePrimaryModifier` (`./platformModifier`) and the ONE `installPlatformChords` listener. The behavioural outcome is KEPT: the modifier-only chord lives outside any keymap and window ops remain reachable. Successor: Q-42 | those engine files were deleted in #3151; the chord semantics survive in the re-homed seam |
| `.opencode/tests/applications-rename/regression.md:65-65` | applications-rename/regression | REMOVED | the links block cited `.opencode/tests/hotkeys/` as "hotkey tier label + resolution". Replacement: — | the suite never existed, so citing it as work is exactly what AC5 forbids |
| `.opencode/tests/workspace-layout/regression.md:29-29` | workspace-layout/regression | REMOVED | the R-7 EXPECTED line ended "Reference `.opencode/tests/hotkeys/`". Replacement: — | the suite never existed, so citing it as work is exactly what AC5 forbids |
| `.opencode/tests/workspace-layout/regression.md:49-49` | workspace-layout/regression | REMOVED | the links block cited `.opencode/tests/hotkeys/` for "window traversal / keyboard parity". Replacement: — | the suite never existed, so citing it as work is exactly what AC5 forbids |
| `.opencode/tests/doom-mode/regression.md:213-213` | doom-mode/regression | REMOVED | the links block cited `.opencode/tests/hotkeys/` as "the shared resting cluster the `view=doom` gate suppresses". Replacement: — | the suite never existed, so citing it as work is exactly what AC5 forbids |
| `.opencode/tests/doom-autoplay-fluency/regression.md:59-59` | doom-autoplay-fluency/regression | REMOVED | the links block cited `.opencode/tests/hotkeys/` as "the `view=doom` hotkeys-cluster suppression the window keeps". Replacement: — | the suite never existed, so citing it as work is exactly what AC5 forbids |

#### ST-8..ST-10 — the round-2 residual sweep (audit restart, root cause scope)

> Round 2 sweeps the PRESENT-asserting prose the merged guard's token set cannot see (G-445). Every row
> below quotes the **pre-sweep** sentence; `path:line-range` is that pre-sweep location. Disposition is
> `CORRECTED` (replaced with the shipped surface / the shipped absence) or `REMOVED` (the site is gone
> with its subject) — `SUPERSEDED` is not used outside `docs/adr/**` and `docs/NAVIGATION_ENGINE.md`.
> This sub-heading appends only; `:1-391` is byte-unchanged.

| path:line-range | suite | disposition | replacement | reason |
|---|---|---|---|---|
| `.opencode/tests/launcher/smoke.md:342-348` | launcher/smoke | CORRECTED | the block header promised "the launcher in the active app's navigation context … the grouped palette, the confirmation and undo-by-description"; it now states the shipped reality — app launch/search + the open-apps row + the global command bar, nothing else — and that the quick paths assert the retired chrome's **absence**. Successor: navigation-retirement (Q-13/Q-19) | the navigation engine is deleted in #3151 and the rescope rejected the grounded launcher |
| `.opencode/tests/launcher/smoke.md:349-353` | launcher/smoke | CORRECTED | S-40 asserted `[data-testid="launcher-context"]` **renders** with the path (`Canvas`), a selection summary and ≤3 verb chips; it now asserts `launcher-context` count **0** while the shipped `launcher-command-bar`/`launcher-command-input` render. Successor: F-126 | the context header was the navigation host's only consumer and has no host |
| `.opencode/tests/launcher/smoke.md:354-357` | launcher/smoke | CORRECTED | S-41 asserted `launcher-palette-list` with one `launcher-palette-group` per place, full-path headings, a risk word and a key-hint chip; it now asserts `[data-testid^="launcher-palette-"]` count **0** and `>` kept as literal query text. Successor: F-163/F-167 | the `>` palette and its projection were deleted with the engine |
| `.opencode/tests/launcher/smoke.md:358-361` | launcher/smoke | CORRECTED | S-42 drove `>` `delete` and asserted the dialog named `Run Delete?` appeared with Cancel focused; it now asserts `launcher-confirmation` count **0** and an immediate apply from the pointer `Delete` row. Successor: F-141/R-86 | there is no confirmation requester, so no confirmation host exists |
| `.opencode/tests/launcher/smoke.md:362-365` | launcher/smoke | CORRECTED | S-43 typed `undo the companion's last change` and asserted a trail entry `Undo <verb>` attributed to `You`; it now asserts the app-local history control (`wireframe-undo`) and that no trail surface or attribution channel exists. Successor: F-144/F-145 | the journal/trail and the undo phrase matcher were deleted; `WIREFRAME_HISTORY_LIMIT = 100` is the shipped history |
| `.opencode/tests/launcher/smoke.md:366-369` | launcher/smoke | CORRECTED | S-44 clicked `[data-testid="navigation-rail-ask"]` and asserted the context header for Wireframe; it now asserts there is no `navigation-rail-ask` control to click (count **0**) and the launcher opens only by `Ctrl+Space`. Successor: F-149 | the rail `/ Ask` bridge was deleted with the engine |
| `.opencode/tests/launcher/exploratory.md:590-594` | launcher/exploratory | CORRECTED | the block header called these "navigation-grounded launcher edge probes"; it now names the shipped launcher and states which probes were REMOVED for want of a host (G-053). Successor: navigation-retirement (Q-13) | the grounded launcher is gone; a probe whose lever does not exist is never left standing |
| `.opencode/tests/launcher/exploratory.md:596-599` | launcher/exploratory | REMOVED | E-83's "stale-envelope race" compared the context header against the palette group order. Replacement: — | both the header and the palette were retired; there is no envelope to go stale |
| `.opencode/tests/launcher/exploratory.md:600-603` | launcher/exploratory | REMOVED | E-84's "two pending confirmations" drove back-to-back destructive intents and a relay. Replacement: — | no confirmation host and no requester exist (R-86, F-141) |
| `.opencode/tests/launcher/exploratory.md:604-607` | launcher/exploratory | REMOVED | E-85's "Esc ordering across S4/S5/S6" walked the deleted level stack. Replacement: — | the levels do not exist; the surviving Esc behaviour is F-135 |
| `.opencode/tests/launcher/exploratory.md:608-611` | launcher/exploratory | CORRECTED | E-86's "undo during an in-flight intent" drove the deleted relay; it now drives a shipped companion skill and the `wireframe-undo` control, keeping the same determinism question. Successor: F-145 | the undo subject survives; only its driver moved to the shipped skill path |
| `.opencode/tests/launcher/exploratory.md:612-614` | launcher/exploratory | CORRECTED | E-87 asked whether the context source switches or renders a stale header on a window switch; it now asserts the launcher DOM is identical in every focus case because the launcher reads no application context. Successor: F-127 | the header is gone; the surviving property is focus-independence |
| `.opencode/tests/launcher/exploratory.md:615-619` | launcher/exploratory | REMOVED | E-88's "envelope-cap interaction with the palette" relied on `maxSelectionIds`/`maxPathDepth`/`maxVerbs` and the 55-row list. Replacement: — | the palette, its caps and the projection are deleted; the surviving cap is `COMPANION_CAPABILITY_LIMITS.maxContextBytes` = 16384 (F-160) |
| `.opencode/tests/launcher/exploratory.md:620-623` | launcher/exploratory | REMOVED | E-89's "relay to a closed window" sent an `app_command_intent` and asserted the `_take` drain. Replacement: — | the relay, its result event and its 16-deep queue were deleted in #3152 |
| `.opencode/tests/launcher/exploratory.md:624-627` | launcher/exploratory | CORRECTED | E-90's "reduced-motion override mid-animation" named a palette entrance; it now names a shipped launcher transition, keeping the same no-stuck-frame question. Successor: F-156 | reduced motion still ships; only the animated surface changed |
| `.opencode/tests/launcher/exploratory.md:628-631` | launcher/exploratory | REMOVED | E-91's "recents churn" overflowed `maxJournalEntries` (10) and `PALETTE_MAX_RECENTS` (5). Replacement: — | the recents list and both caps are deleted; `WIREFRAME_HISTORY_LIMIT = 100` is covered by F-145/F-146 |
| `.opencode/tests/launcher/functional.md:2543-2545` | launcher/functional | CORRECTED | the preamble cited `.opencode/tests/wireframe-navigation/functional.md` F-N25..F-N45 as the live home of the bottom command bar. Replacement: `.opencode/tests/navigation-retirement/functional.md` (Q-13 / Q-19 / Q-29) | `wireframe-navigation/` is retired and absent (verified by directory listing, G-024) |
| `.opencode/tests/launcher/functional.md:2558-2560` | launcher/functional | CORRECTED | the supersession note cited `wireframe-navigation` F-N40..F-N43/F-N45 and `navigation-research` F-8..F-10 as replacements for the retired rows. Replacement: the same rows pointed at `.opencode/tests/navigation-retirement/functional.md` (Q-13 / Q-19 / Q-29 / Q-41) | both cited suites are retired and absent |
| `.opencode/tests/launcher/functional.md:2596-2612` | launcher/functional | CORRECTED | F-165 (authored in round 1) asserted "the confirmation host still mounts: `[data-testid="launcher-confirmation"]` (`role="alertdialog"`) renders … Cancel focused" and **drove** `tauri_ipc_execute_command({command:"app_command_intent", …})`; it now asserts `launcher-confirmation` count **0**, no `role="alertdialog"`, and an immediate apply from the pointer `Delete` row — while keeping Ctrl+Space toggles-once, the dictation path and the no-`fredo.palette.openActions` clause verbatim. Successor: F-141/R-86 | the confirmation host, `requestLauncherConfirmation` and the command relay are all absent from product source (zero matches); the row contradicted F-141/R-86 in the same file (G-444) |
