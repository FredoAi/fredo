# Wireframe — Exploratory

Feature domain: `wireframe` (the paged wireframe editor: document model, Konva canvas,
property panel, view/file commands, 32 element hotkey bindings — 20 bare + the two-step `g`
namespace, re-baselined by Spec #3071 — one Companion skill).
Unscripted edge/failure probes for Spec #3070 Slice 1. Run beyond the scripted functional
cases. A confirmed finding **PROMOTES** to `functional.md` as a new `F-` row (keep the
origin note).

Conventions: ID prefix `E-`. Evidence is LIVE + MEASURED — a quoted `tauri_webview_*` result
plus an uploaded capture (document state, not telemetry; no `telemetry_spans` receipt is
expected). Record expected vs actual; leave `- [ ]` and mark `FAIL` with a repro when the
behaviour is wrong.

- [ ] **E-1 Module-scoped document across window close/reopen.** Open Wireframe, add 3
      elements, close the window, reopen from the launcher. Is the document (and its dirty
      state) still there, or was it lost with component unmount? A lost document violates the
      module-scope decision (D4/C3) — record the observed state and the mechanism
      (`windowStore` keeps closed windows removed).
- [ ] **E-2 Two hosts, one document.** With `new-window` presentation, invoke a Companion
      action while the editor is open in the `app-wireframe` webview, then switch to
      `same-window` and repeat. Does exactly ONE document receive each intent, or do both
      hosts drift into divergent copies?
- [ ] **E-3 Stale intent after window close.** Invoke `wireframe.add.card`, close the wireframe
      window before the editor drains the intent, then reopen. Does the card appear once, never,
      or twice (replay vs take)?
- [ ] **E-4 Drag/resize interaction with zoom and pan.** At 400 % zoom + panned view, drag and
      resize an element. Does the committed geometry match the on-screen delta divided by scale,
      or does it drift (a classic screen-space vs page-space bug)?
- [ ] **E-5 Selection during rapid undo/redo.** Hammer `u`/`y` 20× on a history containing
      add/move/delete. Does `-selection-id` ever point at a removed element (stale selection,
      panel showing dead properties)?
- [ ] **E-6 Lock + undo ordering.** Lock an element, move it (inert), then undo twice. Does the
      lock state and position stay coherent, or does undo resurrect a pre-lock position while
      the element is still locked?
- [ ] **E-7 Text-entry suppression vs panel remount.** Select element A (text), focus the content
      field, type `1pkn`, then select element B (button) mid-typing. Do the typed characters stay
      in the field, and do the declared navigation strokes resolve correctly when focus leaves?
- [ ] **E-8 Key churn across windows.** Open Wireframe + Mission Monitor, toggle focus 20× while
      pressing keys. Does the navigation bar's row set ever stick, does a duplicate-stroke
      diagnostic ever appear, and does any key land in the wrong app?
- [ ] **E-9 File seam abuse.** Point `FREDO_WIREFRAME_SAVE_PATH` / `_OPEN_PATH` /
      `_EXPORT_PATH` at (a) a directory, (b) a non-writable location, (c) an existing unrelated
      text file; then Save and Open. Repeat once with ONLY the shared
      `FREDO_WIREFRAME_FILE_PATH` set (the fallback path). Is the failure surfaced in
      `wireframe-file-error` with the document intact, or does it corrupt / silently no-op?
      Also try `CANCEL=1` combined with a path seam — cancel must win with no banner.
- [ ] **E-10 Large document.** Add ~60 elements (including 12 sections and 12 icons), then
      drag/resize/zoom. Does the canvas stay responsive (no per-move React render storm), does
      export still produce the full page, and does save/open round-trip everything?
- [ ] **E-11 Page-size change with content.** Set `phone` with 12 elements placed for `desktop`.
      Are off-page elements still selectable/reachable, and does the export crop them exactly as
      the page does (no invisible-but-exported ink)?
- [ ] **E-12 Companion ambiguity.** Ask the Companion something ambiguous ("make me a
      wireframe") and something unsupported ("add a chart to the wireframe"). Does it refuse
      honestly (no page change, explicit reply), or does it invent elements/actions?

- [x] **E-13 (promoted from round 1) Cold mount on a zero-measured container.** Open the
      Wireframe app from the launcher (or via `open_app`/`open_app_window`) in an isolated env
      at the spec tip. **Expected:** the editor renders (toolbar + artboard + panel). **Actual:**
      the app crashes and the webview goes blank —
      `Uncaught InvalidStateError: Failed to execute 'drawImage' on 'CanvasRenderingContext2D':
      The image argument is a canvas element with a width or height of 0.` in `react-konva`
      `StageWrap`, mounted from `WireframeCanvasImpl.tsx:828`; `#root` unmounts (DOM is
      `body > div#root`, 0 children). Reproduces in BOTH hosts (same-window `WindowFrame` and
      the standalone `app-wireframe` window). Root cause candidate: `useState({width:0,height:0})`
      at `WireframeCanvasImpl.tsx:579` feeds `<Stage width={0} height={0}>` on the first commit;
      Konva throws before the `ResizeObserver` measurement round-trips. **This is the round-1
      blocker for every live row.**
- [ ] **E-14 (new) Missing workspace dependency in the served tree.** Before `pnpm install`,
      opening the app produced a Vite overlay
      `Failed to resolve import "react-konva" from …/WireframeCanvasImpl.tsx`. Recorded as an
      environment-prep finding (the dependency is declared in `apps/ui/package.json` +
      `pnpm-lock.yaml`, but the served root's `node_modules` had not been installed since the
      add). Re-test after every dependency change: is the served root install current?

## Round 2 — resolved and new probes (2026-10-21)

- **E-13 RESOLVED (round 2).** The zero-size-stage crash is fixed: `<Stage>` renders only when
  the measured size is non-zero, a shrink-to-zero unmounts it, and the canvas error boundary
  contains any throw. Verified live in all three hosts (launcher, `open_app`, standalone) plus a
  collapse/restore cycle — no `InvalidStateError`, canvas 1630×861 / 900×201 with real pixels.
- **[ ] E-15 (new) Numeric stepper buttons are a no-op.** Select any element, click the
  `NumberInput` increment or decrease chevron on Width: the displayed value and
  `-selection-geometry` never change (two clicks each, 300 ms apart). The slider and the number
  field both work (R-3.6 still satisfied). Repro: shape selected → Width steppers → geometry
  stays `560,628,161,120`.
- **[ ] E-16 (new) Pan mode cannot pan an empty canvas.** With `-pan-mode=true`, a drag starting
  on empty artboard/backdrop leaves the view unchanged; a drag starting on an element translates
  it. Same finding as F-27 — promoted there.
- **[ ] E-17 (new) Export capture ignores page content.** The exported PNG is the correct 2×
  size but a flat blank page at every zoom/pan and for any element count (identical SHA256).
  Same as F-33 — promoted there. Likely the page group/transform used by
  `stage.toDataURL({x: view.x, y: view.y, …})` does not include the rendered content.
- **[ ] E-18 (new) Raw `llm-skill-call` replies are dropped unless a skills generation is in
  flight.** `pushAppOpenReply` reaches the entity, but `applyAppOpenReply` returns early on
  `generationUsesSkillsRef === false`, so a direct emit shows no bubble and the caller cannot
  tell (`pushAppOpenReply` still returns `true`). Worth a product decision; the round-2 tester
  emitted during a launcher send to obtain the F-43/F-46 receipts.
- **[ ] E-19 (new) Companion ignores an explicit wireframe request.** The binding Gherkin
  sentence yields a prose reply; the model never selects the `wireframe` skill (F-47). Recorded
  as a model-behaviour/AC6 failure, not a wiring failure (the executor works via F-44a–c).

## Round 3 — re-probes after the pan / export / stepper / skill-offer fixes (2026-10-21)

- **E-13 RESOLVED, holding.** No zero-size stage, no blank window, canvas paints in both hosts.
- **E-15 PARTLY RESOLVED.** The stepper now commits the stepped value: element width 300→301,
  element height 48→49, page width 1280→1281, page height 800→801 with a realistic pointer
  sequence (`pointerdown` → 120 ms → `pointerup` → 80 ms → `click`). A zero-delay synthetic burst
  still shows the old symptom — that is a TECHNIQUE artifact (Zag's `onValueChange` lands after
  the synchronous click), not the defect.
  **Residual (new, FAIL on the undo clause):** one stepper interaction pushes TWO history
  entries. The click focuses the number input; the next blur fires Zag's `onValueCommit` with the
  already-committed value, and `dispatch('element.update')` has no no-op guard. Observed: width
  302 → click → 303 → blur → `u` (no change) → `u` (302). Same on page width (1281 → undo →
  undo → 1280). Fix direction: skip a patch that equals the current element (or skip
  `onValueCommit` when the machine value is unchanged).
- **E-16 RESOLVED (pan).** `wireframe-pan-surface` (a viewport-covering transparent hit rect,
  `listening={panMode}`, first child of `wireframe-view`) makes every drag origin pan by exactly
  the pointer delta: backdrop (50,40), page interior (−60,−25), over an element (35,−30) at
  100 %; page interior (80,50) and over an element (−45,25) at 400 %; an EMPTY document pans
  (count 0). `h` off restores the empty-canvas deselect, and count / selection / geometry /
  `dirty` / undo-depth / the saved JSON stay identical across all of it.
  **However — see the new E-20.**
- **E-17 PARTLY RESOLVED (export content).** The export is no longer blank: 20 elements ⇒
  3.295 % non-background pixels, 0 % transparent; SHA256 distinct for 20/1/0 elements; a selected
  export is byte-identical to a deselected one; `phone` ⇒ 780×1688. **Not viewport-invariant:**
  at 400 % the PNG is 44.096 % transparent (the crop region lies outside the rendered stage
  canvas) — F-33 stays FAIL on the invariance clause. See E-21.
- **E-18 unchanged.** A raw `llm-skill-call` reply still needs an in-flight skills generation.
- **E-19 RESOLVED (offer).** The exact Gherkin sentence now opens the app from closed and drafts
  `section{preset:'navbar'}` + `text{textStyle:'heading', text:'Reporter'}` +
  `card{label:'Reporter reports'}` (count 3) via the REAL model path, and the reply names only
  the performed steps. The live transport now offers the 4-skill registry
  (`companion_skill_registry()`), so the offer was the whole defect.
- **[ ] E-20 (new, regression) An element drag pans the view.** `handlePanDragEnd`
  (`WireframeCanvasImpl.tsx:745-752`) is bound to the pan group and does not check
  `event.target === event.currentTarget`; Konva bubbles the element's `dragend` to it, so the
  view is set to the element's absolute stage position. Measured: text at page (510,396) dragged
  +30,+20 → element (540,416) ✓ but view (175,30.5) → (715,446.5) ⇒ the page jumps. This also
  explains every "mysterious pan" a tester sees while measuring: read the view before/after each
  drag in any future round.
- **[ ] E-21 (new) `Stage.toDataURL({x,y,width,height})` crops the viewport, not the page.**
  At 400 % the requested crop origin is far outside the stage-sized layer canvas, so 44 % of the
  bitmap is never painted (transparent). Fix direction: capture the page GROUP
  (`pageGroup.toDataURL({pixelRatio: PAGE_EXPORT_PIXEL_RATIO})`) or temporarily reset the view
  before the capture — not the stage crop.
- **Technique findings (round 3):** `tauri_webview_interact` is a synthetic `.click()`
  (`detail === 0`, no `pointerdown`) — it cannot drive Zag steppers and does not trigger the
  pointer-activation blur; `tauri_webview_keyboard press` delivers `isTrusted === false` key
  events (fine for the engine, but Zag's typed-commit path needs the host to be OS-focused —
  on an unfocused host the typed value stays in the input and never reaches the store);
  `tauri_manage_window focus` and `window.setFocus()` are both unavailable (bridge plugin 0.12 /
  capability), so once the main window loses OS focus the only reliable way back to a
  hotkey-capable host is to open the app in its OWN window (a new window gets focus).
  `import('/@fs/C:/Code/fredo/apps/ui/src/applications/wireframe/…')` resolves the live modules
  (Vite dev graph) and exposes the Konva stage, the document store and the undo flags — the most
  precise live oracle available.

## Round 4 — closures and new technique findings (2026-10-21)

- **E-15 RESOLVED (undo clause).** The store's `commitDocument` is a no-op for a value-equal
  document, so the blur re-commit cannot push a second history entry. Live: element width
  160→161, element height 44→45, page width 1280→1281, page height 800→801, corner radius m→l —
  each reverted by exactly ONE `u` with `canRedo` set. The owner decision (the store, not the
  field) is the one that shipped; do not add a field-level guard.
- **E-20 RESOLVED.** The pan handlers ignore bubbled drags (`target !== currentTarget`). Live:
  element drag +30,+20 at 100 % and +7.5,+5 page px at 400 %, the view transform byte-identical
  at both zooms, the document diff = that element's `x/y` only, one undo each.
- **E-21 RESOLVED.** Export captures the `.wireframe-page` node under a transient
  `captureView {scale:1,x:0,y:0}`, so no view value reaches the config. All three legs of one
  document (100 %, 400 % panned, 10 %) are **byte-identical** (`SHA256 7AC12AA6…`), 0
  transparent, and the phone leg exports 780×1688.
- **E-18 unchanged (still true).** A raw `llm-skill-call` reply needs an in-flight skills
  generation; the pushed bubble's retention is shorter than one driver round-trip, so F-43/F-46
  text cannot be read reliably by polling. Prefer reading the reply text inside the same
  `execute_js` that triggers it, or capture a screencast.
- **E-22 (new, technique) A synthetic `KeyboardEvent` does not reach the hotkey engine.** Nine
  dispatched `keydown`s for `1…9` produced `-element-count` 0; the driver's real key events
  produced 1…9 correctly. Never conclude "the hotkey is broken" from a synthetic dispatch.
- **E-23 (new, environment) A fresh boot can look dead for 3-5 minutes.** `about:blank` from
  `manage_window`, `execute_js` "Request timeout after 2000ms", and a `dom_snapshot` of
  `body > div#root` with no children = still transforming the dev graph. `Down`/`Up` ×5, a
  `Clean`, driver stop/start ×5, `taskkill msedgewebview2` and `Hygiene -Kill` all failed to
  shorten it; waiting did. Budget the wait before declaring an environment wedge.
- **E-24 (new, environment) `cargo test` cannot run while the env is up** — `fredo.exe` is
  locked (`Access is denied (os error 5)` removing `target/debug/fredo.exe`). `Down` the env
  first, or accept an incremental rebuild.

## Spec #3081 — new probes (Discard label colour)

- [x] **E-25 (new) `resolveOnSolids` is min-over-all-four, not per-colour.** Override ONLY
      **Round 1 (2026-10-26) — exercised.** `monochrome` (`--status-error:"#ffffff"`) → resolved
      `--status-on-solids` `#0c1117` (dark), label `rgb(12,17,23)`, ratio 18.95 — the min-over-four
      rule flipped to dark, never white-on-light. Per-preset sweep: `solarized` 4.10 / `paper` 4.49
      are the only sub-4.5 ratios (recorded as a PO scope question, not a defect); no preset is
      white-on-light. Full table in `.opencode/tmp/3081/tests-runs.md`.
      `--status-error` to a very light red (keep success/warning/info dark) via the per-token
      override, then open the Discard dialog. Does `--status-on-solids` flip to the dark
      foreground (correct) or stay white because the other three hues outvote the light error
      (white-on-light — a real defect vs AC3)? Record the resolved `--status-on-solids`, the
      computed label colour, and the measured contrast. If it stays white, that is the
      `resolveOnSolids` semantics (`ThemeProvider.tsx:218-230` — max of the MIN across statuses)
      and must be surfaced as a product decision, not papered over.
- [ ] **E-26 (new) Accent change while the dialog is open.** With the dialog open, change the
      accent (Appearance) and re-measure. Does the label re-resolve with the theme, or is it
      cached? (It should be independent of accent — the fill is `status.error` — but a stale
      computed colour would indicate a repaint gap.)
- [ ] **E-27 (new) Dialog from the Companion path.** Trigger `document.new` via a Companion
      `llm-skill-call` on a dirty document. Does the dialog (and therefore the Discard button)
      render with the token colour on that path too, or does the Companion path skip the dialog
      (documented overwrite — F-44c)? Record the observed path.

## Spec #3071 — new probes (Layout Intelligence)

> Unscripted edge/failure probes for the arrangement slice. Evidence is LIVE + MEASURED — a
> quoted `tauri_webview_*` result plus an uploaded capture (document state, no `telemetry_spans`
> receipt expected). A confirmed finding PROMOTES to `functional.md` as a new `F-` row.

- [ ] **E-28 Group membership drift under undo/redo.** Group 3 elements, ungroup, then hammer
      `u`/`y` 10×. Does `groups[].memberIds` ever reference an element that no longer exists, or
      does a group reappear pointing at stale ids? Record `-group-count` + the saved JSON each
      cycle.
- [ ] **E-29 Reorder + group interaction.** Send an element of a group backward past a
      non-member, then drag the group. Do the members keep their relative stacking, and does
      `data-wireframe-stacking` stay coherent with the group membership?
- [ ] **E-30 Snap vs align-guide conflict.** With snap ON, drag an element so both the grid snap
      and a smart guide want to pull it. Which wins, and does the committed geometry land on the
      grid multiple? Record the guide count and the final x/y.
- [ ] **E-31 Armed prefix under text entry / focus churn.** Arm the 250 ms navigation prefix,
      then focus a panel field before the second key. Does the armed prefix leak or fire a stale
      action after the timeout? Then repeat across a window focus change.
- [ ] **E-32 Companion under-sized honesty.** Invoke `wireframe.arrange.distribute` via the
      Companion with only 2 elements selected. Does it reply "nothing changed" (honest) or claim
      success? Cross-check `runWireframeAction`'s return.
- [ ] **E-33 Large grouped document performance.** Build ~40 elements across ~10 groups, then
      drag/resize groups and run align/distribute. Does the canvas stay responsive (no per-move
      React render storm), does one undo revert a group drag, and does Save/Open round-trip all
      groups + stacking?

## Spec #3087 — new probes (on-control chip removal)

> Unscripted probes for the chip-removal slice. Evidence is LIVE + MEASURED — a quoted
> `tauri_webview_*` result plus an uploaded capture (document state, no `telemetry_spans`
> receipt expected). A confirmed finding PROMOTES to `functional.md` as a new `F-` row.

- [ ] **E-34 Stale hook residue after rapid focus churn.** Toggle focus between the Wireframe
      host and another window 20× (fast), then inspect the bar DOM. Does any legacy element-key
      hook reappear (a stale render, a `visibility` remnant)? Record the navigation bar's row
      count in both states and confirm `legacyAbsence.test.ts` is green.
- [ ] **E-35 Bar row identity across the declaration.** With Wireframe + Mission Monitor + Dev
      Mode open, check the navigation bar's `data-nav-verb-id` rows before/after toggling focus.
      Do the Wireframe titles still read the declaration's verb title, never a stale string?
- [ ] **E-36 Insert-menu composite boundary.** Open both insert menus (Section presets, Shape
      kinds) and confirm the chevrons carry no legacy key hook and no chip, and that the main
      insert control beside each chevron renders label + icon with no chip. Also confirm the
      `wireframe.document.new` row has no `data-nav-keycap` hint and no `(hotkey)` suffix in its
      accessible name.

## Spec #3119 (P5) — probes for the declaration-driven surface

> The toolbar / command surface / hotkey carrier are gone; Wireframe is driven by six declared
> places. These probes target the surfaces most likely to rot during the migration. Evidence is
> LIVE (quoted tool result + capture). A confirmed finding PROMOTES to
> `wireframe-navigation/functional.md` as `F-N<n>`.

- [ ] **E-37 The value-key gap.** Press Style `f`/`o`/`p`/`z`/`t` and Edit `r` with an element
      selected. Record precisely what each does (cycle sequence / default value / focuses a panel
      control / popover), whether it commits ONE entry, and whether the panel stays in sync. The
      UI/UX decision for this behaviour is still open (plan Q-4) — this probe is what closes it.
- [ ] **E-38 Stale armed prefix across a place change.** Arm a rect (`c r`) and, within 250 ms,
      click a rail place row, then press another stroke. Does the stale prefix fire, leak into
      the new place, or clear silently?
- [ ] **E-39 Same stroke, four places.** `s` at root / in Create / in Arrange / in Style; `f` at
      root / Arrange / Style; `u` at root / Arrange. Record the dispatched verb id each time —
      any cross-place leakage means tier 2/4 were consulted while a place binding existed.
- [ ] **E-40 Double announcement.** Enter and exit the same place repeatedly and trigger one
      transient auto-exit. Count the updates in the single live region: identical consecutive
      text must be ONE update; distinct text exactly one each.
- [ ] **E-41 Focus survival across the auto-exit.** Focus a rail row button, `c`, `r`, drag.
      After the auto-exit, is `document.activeElement` the same rail row (never `body`)? Repeat
      with the map open so the dialog trap closes first.
- [ ] **E-42 Toolbar/command-surface residue.** Search the running webview for any surviving
      trace of the deleted path: the legacy toolbar/action testids, any legacy element-key
      attribute under `wireframe-root`, the legacy carrier, and any legacy prefix pending state
      on `body`. Any residue is a FAIL of AC7 (not an exploratory note); the literal absence is
      gate-owned by `legacyAbsence.test.ts`.
- [ ] **E-43 Journal growth.** Perform ~120 small mutations: responsiveness, the 10-entry trail
      cap, and whether undo still walks back. The journal is intentionally unbounded this slice —
      record the memory shape as an observation (named risk), not a defect.
- [ ] **E-44 Companion path after the deletion.** Emit the nested `llm-skill-call` from
      `regression.md` R-27 with the app closed and open. Does it fail closed with a clean
      `Invalid` (no window, no mutation, no timeout), or does it hang / mutate / crash? Report the
      exact result to the Orchestrator for the P6 hand-off.

## Teardown (run after this suite)
- [ ] Close every Wireframe window, delete the probe fixtures under
      `.opencode/tmp/3070/e2e/` that are not part of the functional plan, restore the appearance
      preset to the served default, and `Down` the isolated env. Confirm no settings key, DB row
      or capability file was left modified by a probe.
- [ ] For #3119 also delete the probe captures under `.opencode/tmp/3119/e2e/` that are not part
      of the plan and `Down` `wf3119-a`.
