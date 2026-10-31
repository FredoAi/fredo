# navigation — Coverage Map (P8 decommission, issue #3122)

> AC7 / R-7.1. This map is the binding successor record for the **deleted**
> `.opencode/tests/hotkeys/` durable suite and for the **26** vitest suites under the deleted
> `apps/ui/src/shared/hotkeys/__tests__/`. Every successor below exists on the P8 tree or is a
> named deliverable of an owning sub-task (`ST-1`…`ST-4`); no successor is invented. A deleted
> assertion with no successor would be a coverage loss and a FAIL.
>
> **Verification policy: static** for this map (paths + test titles + suite exits).
>
> **Guard self-reference (binding).** This map and the P8 rows in the four sibling suite files
> necessarily name the purge tokens and the deleted suite names. `legacyAbsence.test.ts` MUST
> allowlist `.opencode/tests/navigation/{smoke,functional,regression,exploratory,coverage-map}.md`
> (or scan only code extensions under `.opencode/tests/`); a literal scan of these `.md` files would
> fail on the guard's own documentation.

## A. Deleted durable suite files (`.opencode/tests/hotkeys/`)

| Deleted file | Successor | Evidence that the successor carries the behaviour |
|---|---|---|
| `.opencode/tests/hotkeys/smoke.md` | `.opencode/tests/navigation/smoke.md` — P8 section `S-14`…`S-20` | boot + one mount + slot/announcer coherence + terminal passthrough smoke rows |
| `.opencode/tests/hotkeys/functional.md` | `.opencode/tests/navigation/functional.md` — P8 section `F-35`…`F-48` | per-REQ P8 rows (deletion, single mount, manifest parity, retained set, Dev Mode) |
| `.opencode/tests/hotkeys/regression.md` | `.opencode/tests/navigation/regression.md` — P8 section `R-17`…`R-28` | "must not change" baseline + the P8 deletions recorded as superseded-by-design |
| `.opencode/tests/hotkeys/exploratory.md` | `.opencode/tests/navigation/exploratory.md` — P8 section `E-17`…`E-22` | unscripted probes for the post-deletion surface (stale hooks, double mounts, retired ids) |

## B. Deleted vitest suites (`apps/ui/src/shared/hotkeys/__tests__/`, 26 files)

> The legacy directory held 22 modules + these 26 suites. `applicationFocus`, `commandSurface*`,
> `commandSurfaceFixture*` and `commandSurfaceStore` covered the deleted command-surface tooling;
> their product successor is the ONE navigation dispatch funnel. The DEV-only
> `commandSurfaceFixture` suite has **no product successor** (D-10) — it is recorded as retired
> tooling, carried by `shared/navigation/ui/__tests__/host.test.ts`.

| # | Deleted suite | Successor (path / durable row) | Owner |
|---|---|---|---|
| 1 | `announcer.test.tsx` | `apps/ui/src/shared/navigation/ui/__tests__/announce.test.tsx` + `singleLiveRegion.test.tsx` | ST-2 |
| 2 | `applicationFocus.test.ts` | `apps/ui/src/shared/navigation/__tests__/focusContext.test.ts` (relocated classification) + `apps/ui/src/shared/navigation/ui/__tests__/hostRegistry.test.ts` (per-app host ownership) | ST-1 |
| 3 | `commandDispatch.test.ts` | `apps/ui/src/shared/navigation/__tests__/dispatch.test.ts` (the ONE funnel) | ST-2 |
| 4 | `commandPromptValidation.test.ts` | `apps/ui/src/shared/navigation/__tests__/dispatch.test.ts` (`validateDeclaredArguments`) + `apps/ui/src/shared/companion/__tests__/manifest.parity.test.ts` (declared args on the wire) | ST-1 / ST-3 |
| 5 | `commandScopeDuplicates.test.ts` | `apps/ui/src/shared/navigation/__tests__/validation.test.ts` (V-07/V-08) + `apps/ui/src/applications/__tests__/navigationParityMatrix.test.ts` (per-app scope) | ST-2 |
| 6 | `commandSingleExecution.test.ts` | `apps/ui/src/shared/navigation/ui/__tests__/host.test.ts` (one dispatch per intent) + `apps/ui/src/shared/navigation/__tests__/dispatch.test.ts` | ST-2 |
| 7 | `commandSurface.test.ts` | `apps/ui/src/shared/navigation/__tests__/validation.test.ts` (declaration validity) + `dispatch.test.ts` (execution) | ST-2 |
| 8 | `commandSurfaceBar.test.tsx` | `apps/ui/src/shared/navigation/ui/__tests__/commandRail.test.tsx` (the bottom command bar rows) | ST-2 |
| 9 | `commandSurfaceFixture.test.tsx` | **retired tooling — coverage carried by `apps/ui/src/shared/navigation/ui/__tests__/host.test.ts`** (D-10; DEV-only fixture for the deleted engine) | — |
| 10 | `commandSurfaceStore.test.ts` | `apps/ui/src/shared/navigation/__tests__/dispatch.test.ts` + `apps/ui/src/shared/navigation/ui/__tests__/host.test.ts` | ST-2 |
| 11 | `describe.test.ts` | `apps/ui/src/shared/navigation/ui/__tests__/models.test.ts` (`formatKeyHint`) + `apps/ui/src/shared/navigation/__tests__/keys.test.ts` (`displaySequence` / `accessibleSequence`) | ST-1 |
| 12 | `engine.test.ts` | `apps/ui/src/shared/navigation/__tests__/keyResolver.test.ts` (grammar/resolution) + `apps/ui/src/shared/navigation/ui/__tests__/globalKeys.test.ts` (the three kept chords) + `focusContext.test.ts` (suppression) | ST-1 |
| 13 | `featureHotkeyKeys.test.ts` | `apps/ui/src/applications/__tests__/navigationBindingsCompleteness.test.ts` (every declared key resolves) + `navigationParityMatrix.test.ts` | ST-2 |
| 14 | `focusContext.test.ts` | `apps/ui/src/shared/navigation/__tests__/focusContext.test.ts` (relocated, same classification) | ST-1 |
| 15 | `HotkeyBar.test.tsx` | `apps/ui/src/shared/navigation/ui/__tests__/commandRail.test.tsx` | ST-2 |
| 16 | `hotkeyBarModel.test.ts` | `apps/ui/src/shared/navigation/ui/__tests__/models.test.ts` | ST-2 |
| 17 | `hotkeyElements.test.ts` | `apps/ui/src/shared/navigation/__tests__/legacyAbsence.test.ts` (no discovery observer / no `data-hotkey`) + `navigationBindingsCompleteness.test.ts` (declared bindings only) | ST-5 |
| 18 | `hotkeyGrammar.test.ts` | `apps/ui/src/shared/navigation/__tests__/keyResolver.test.ts` + `validation.test.ts` (stroke grammar and V-07) | ST-1 |
| 19 | `HotkeysProvider.test.tsx` | `apps/ui/src/shared/navigation/ui/__tests__/navigationProvider.test.tsx` (the ONE mount) + `singleLiveRegion.test.tsx` | ST-1 |
| 20 | `keys.test.ts` | `apps/ui/src/shared/navigation/__tests__/keys.test.ts` (relocated) + `ui/__tests__/models.test.ts` (display) | ST-1 |
| 21 | `registry.test.ts` | `apps/ui/src/shared/navigation/__tests__/dispatch.test.ts` (verb existence/availability) + `apps/ui/src/shared/navigation/ui/__tests__/hostRegistry.test.ts` | ST-2 |
| 22 | `sequence.test.ts` | `apps/ui/src/shared/navigation/__tests__/resolver.test.ts` + `keyResolver.test.ts` | ST-1 |
| 23 | `servedEntryMount.test.ts` | `apps/ui/src/shared/navigation/ui/__tests__/navigationProvider.test.tsx` + the P8 static entry rows in `navigation/functional.md` F-36 (both entries mount it once) | ST-1 |
| 24 | `terminalMode.test.ts` | `apps/ui/src/shared/navigation/ui/__tests__/terminalPassthrough.test.ts` (relocated; `data-fredo-passthrough` KEPT) | ST-1 |
| 25 | `themeHygiene.test.ts` | `apps/ui/src/shared/navigation/ui/__tests__/navTheme.test.ts` (token/alpha-append scan over `ui/**`) + `pnpm --filter @fredo/ui contrast:gate` | ST-2 |
| 26 | `traversal.test.ts` | `apps/ui/src/shared/window-system/__tests__/WindowTraversal.test.tsx` (relocated DOM/tab traversal) | ST-1 |

## C. Retired tooling (no product successor)

| Deleted artifact | Disposition |
|---|---|
| `apps/ui/src/shared/hotkeys/commandSurfaceFixture.tsx` + `commandSurfaceFixtureBridge.ts` | DEV-only fixture for the deleted engine; no product surface. Behavioural successor: `host.test.ts` (ONE dispatch funnel). |
| `apps/ui/src/shared/hotkeys/HotkeyBar.tsx` / `hotkeyBarModel.ts` | UI successor: `CommandRail` (`navigation/ui/CommandRail.tsx`) + `models.test.ts`. |
| `apps/ui/src/shared/hotkeys/HotkeysProvider.tsx` | Mount successor: `NavigationProvider` (`navigation/ui/NavigationProvider.tsx`). |
| `apps/ui/src/shared/hotkeys/announcer.tsx` | Announcement successor: `nav/announce.tsx` single channel + `navigation-announcer`. |
| The 4 `data-hotkey-*` test hooks | Test-hook successors: `data-nav-keycap`, `data-nav-verb-id`, `data-nav-availability`; reserved `data-nav-label` / `data-nav-key` / `data-nav-action` / `data-nav-mode-id` only where a retained test needs them. `data-fredo-passthrough` KEPT. |
