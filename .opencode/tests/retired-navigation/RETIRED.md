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
asserts the tree scans clean again.

```powershell
# Plain run — exit 0 = clean, 1 = at least one hit, 2 = cannot run (bad root / zero files scanned)
powershell -File .opencode/scripts/check-navigation-retired.ps1

# Exit-code-assertable form (prints `EXITCODE=<n>` and exits with the guard's own code)
powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/scripts/check-navigation-retired.ps1"

# Non-vacuity control — exits 0 only when all three controls pass
powershell -File .opencode/scripts/check-navigation-retired.ps1 -SelfTest
powershell -File .opencode/scripts/run-exitcode.ps1 -Command "powershell -File .opencode/scripts/check-navigation-retired.ps1 -SelfTest"
```

