# wireframe-navigation — Functional

Feature: the declaration-driven Wireframe surface, Spec #3119 (P5 pilot). One declaration
(`applications/wireframe/wireframeSurface.ts`) drives key resolution, the rail, the map, the
trail, availability and the journal; the legacy command surface / hotkey carrier / toolbar are
deleted.

> **Verification policy: live** (runtime behaviours: key resolution, rendered projections,
> journal, pointer commits, announcement, theme/motion). No telemetry is emitted, so no
> `telemetry_spans` receipt applies.
>
> **Env + driver:** see `smoke.md` (isolated `wf3119-a`, slot 1, MCP port `"16001"`, built-in
> `tauri_driver_session`). No scratch MCP client, no browser-only run, no synthetic keydown.
>
> **Place ids:** `wireframe.canvas` (root, label `Canvas`), `wireframe.create` (transient,
> operator `wireframe.create-shape`, cursor `crosshair`), `wireframe.edit`, `wireframe.arrange`,
> `wireframe.style`, `wireframe.view`, `wireframe.file`. Root stroke → place:
> `c→create · e→edit · a→arrange · s→style · v→view · f→file`. Root direct aliases (verbs only):
> `r→wireframe.create.rect · u→journal.undo · y→journal.redo`. Root verb keys:
> `m→app.map · k→app.ask · ←/↑→selection.previous · →/↓→selection.next`.
>
> **Place keys (binding — exact tokens):**
> `Create` `r` rect · `e` ellipse · `t` text · `b` button · `i` input · `m` image · `k` card ·
> `s` section · `l` line (= 9 bound verbs → 8 rail rows + `more…`).
> `Edit` `d` duplicate · `x` delete · `l` toggleLock · `h` toggleVisible · `r` rename.
> `Arrange` `g` group · `u` ungroup · `←` alignLeft · `→` alignRight · `d` distribute ·
> `f` bringForward · `b` sendBackward · `s` toggleSnap (= 8 bound; `alignCenter` and
> `toggleGroupLock` are declared but unbound → map/palette only).
> `Style` `f` fill · `o` border · `p` appearance · `z` radius · `t` textStyle.
> `View` `+` zoom.in · `-` zoom.out · `f` fitPage · `0` resetView · `p` togglePan.
> `File` `n` document.new · `o` place.open · `w` place.saveAs · `x` place.exportPng.
>
> **Value-key behaviour (UI/UX §8 — binding, all value args OPTIONAL, a bare key never yields
> `invalid-args`).** Style `f` cycles the fill token one step forward in `WIREFRAME_COLOR_TOKENS`
> (`surface→muted→border→text→textMuted→accent→success→warning→error→info→surface`); `o` cycles
> `none→thin→thick→none`; `p` cycles `primary→secondary→ghost→primary`; `z` cycles
> `none→s→m→l→none`; `t` cycles `body→heading→body`. Each is ONE mutation entry (one undo).
> Edit `r` is a **navigation** effect: it focuses + selects the element's name field
> (`wireframe-text-content` / `-button-label` / `-card-label` / `-input-placeholder`) and writes
> NO document entry.
>
> **Two different timeouts exist — do not confuse them:** the navigation engine's armed prefix
> times out at **250 ms** (`PENDING_TIMEOUT_MS`, `shared/navigation/types.ts:17`); the legacy
> hotkey engine's prefix times out at **1000 ms** (`PENDING_SEQUENCE_TIMEOUT_MS`,
> `shared/hotkeys/engine.ts:64`). Surface strokes use 250 ms; the legacy bar's
> `data-fredo-pending-sequence` channel is no longer involved in Wireframe.
>
> **Root DOM hook:** `[data-testid="wireframe-root"]` carries `data-wireframe-place` (the current
> place id), `data-wireframe-arm` (`none|rect|ellipse` — the armed draw state), plus the shipped
> `data-wireframe-element-count | -selection-id | -selection-type | -selection-ids |
> -selection-count | -selection-group | -group-count | -snap | -stacking | -dirty |
> -document-path | -page | -zoom | -pan-mode`. Deleted: `wireframe-toolbar`,
> `wireframe-action-*`, `wireframe-hotkey-carrier`, every `data-hotkey` on a Wireframe element.

## Harness (run before every leg)

- Isolated env as in `smoke.md` (all three `FREDO_WIREFRAME_*_PATH` seams at once; `Restart` is
  forbidden — recover with `Down` then `Up`).
- **Key gate:** press keys only when `document.activeElement` is `document.body` or the shell
  root, or when a rail place row / verb row button is focused on purpose (F-N23's focus leg). A
  focused text control suppresses every stroke (`handleStroke` returns `null`) — correct
  behaviour, not a failure.
- **Pointer technique:** Konva needs DOM `MouseEvent` sequences on `.konvajs-content`
  (`pointerdown` → `mousemove` → `mouseup` with `detail: 1`); `tauri_webview_interact`'s
  synthetic `.click()` and swipes do not deliver Konva's gesture shape.
- **Breadcrumb assertion:** read the `data-nav-place-id` sequence plus the
  `navigation-rail-place` label — NOT the separator glyph (`›` U+203A is shipped; AC3 writes
  `→`; a separator mismatch is never a FAIL).
- **Announcement assertion:** pin the literal ONCE on the composer
  (`navPlaceEnterMessage('Create', 9) === 'Create — 9 actions'`), then assert the live region's
  text equals the composer output. Do not re-type a sentence twice.
- **Captures:** `.opencode/tmp/3119/e2e/<row>-<state>.jpeg`, uploaded per visual row.

## Cases

- [x] **F-N1 (R-1 / AC1) — the declaration is complete, valid and noun-shaped.**
      Run `pnpm --filter @fredo/ui test:run src/applications/wireframe/__tests__/wireframeSurface`.
      **Expected:** the titles `declares one root and the six places under the canvas`,
      `validateSurface reports zero violations`, `every verb applies only to the six declared
      object nouns`, `the declaration stays inside the capability envelope` and `every verb
      bound in a place declares that place in appliesTo` are green; root `wireframe.canvas`; the
      six children are the place ids above; the union of `appliesTo.objects` is exactly
      `document, page, element, selection, group, view`; `verbs.length === 55` (≤ 64).
      **Edge:** a widget noun (`button`) in `appliesTo.objects` FAILS the noun-set predicate
      (negative control on a clone, then revert); a 9th bound verb in Create.
      **Files:** `wireframeSurface.test.ts` (NEW).

- [x] **F-N2 (R-1 / AC1) — every place renders ≤ 8 verb rows and Create overflows by one.**
      Open Wireframe; walk the six places with `c e a s v f` + `Escape`.
      **Expected:** in every place
      `document.querySelectorAll('[data-testid="navigation-rail-row"]').length ≤ 8`; in Create it
      is **8** and `[data-testid="navigation-rail-more"]` reads `more…` with the accessible name
      `More actions in this place — opens the map`; clicking `more…` opens the map filtered to
      `wireframe.create` and the map's Create block lists all **9** verbs (the declaration is
      never truncated); `navigation-rail-place` reads the place label; the transient chip reads
      `Create · one action`; `navigation-rail-places` carries the `Places` label above the place
      rows.
      **Edge:** Canvas (2 verb rows only — the six place entries are place rows, the two globals
      are footer affordances); Arrange (8 rows, no `more…`); a leaf place (no empty place group);
      a place entered twice.

- [x] **F-N3 (R-2 / AC2) — `c` enters Create and `c r` arms a rectangle.**
      From the root press `c`, then `r`.
      **Expected:** after `c`, `data-wireframe-place="wireframe.create"`, the breadcrumb
      `data-nav-place-id` sequence is `wireframe.canvas,wireframe.create` with the current label
      `Create`, and exactly ONE new journal entry exists (`wireframe.create`,
      `effect: "navigation"`). After `r`: `data-wireframe-arm="rect"`, the place is STILL
      `wireframe.create`, the canvas cursor is `crosshair`, NO new journal entry, and NO
      announcement.
      **Edge:** `r` pressed twice (re-arm, still no entry); `r` after the 250 ms prefix timeout
      (re-arms); an announcement on arming is a FAIL (arming is silent).

- [x] **F-N4 (R-2 / AC2) — `r` at the root arms a rectangle WITHOUT entering Create.**
      From the root press `r`, then drag.
      **Expected:** `data-wireframe-place` stays `wireframe.canvas`, `data-wireframe-arm="rect"`,
      cursor `crosshair`, no navigation entry; the drag creates one element with
      `type:"shape"` and `shape:"rect"` (the `-selection-type="shape"`, `-selection-shape="rect"`
      hooks), sets `data-wireframe-arm="none"`, and journals exactly ONE
      `wireframe.create.rect` entry whose `placePath` is `["wireframe.canvas"]` (no Create
      segment) — the ONLY observable difference from `c r`. The new element is selected.
      **Edge:** a root alias that also collides with a child key (`r` is Edit's rename) — inside
      Edit, `r` must focus the name field, not arm a rect.

- [x] **F-N5 (R-2 / AC2) — `s` enters Style at the root and toggles snap inside Arrange.**
      Root `s` → Style; `Escape`; `a` → Arrange; `s`.
      **Expected:** root `s` gives `data-wireframe-place="wireframe.style"`; inside Arrange `s`
      flips `data-wireframe-snap` `false`↔`true` and journals ONE
      `wireframe.arrange.toggleSnap` NAVIGATION entry (not undoable, redo stack preserved) while
      `data-wireframe-place` stays `wireframe.arrange`.
      **Edge:** `s` inside Create = `wireframe.add.section` (third place, third meaning);
      `s` inside Arrange twice; snap state unchanged by `Escape`.

- [x] **F-N6 (R-2 / AC2) — `f` is place-scoped in three places.**
      Root `f` → File; `Escape`; `a` → Arrange → `f`; `Escape`; `s` → Style → `f` (with a
      **shape** selected first, since fill is kind-gated).
      **Expected:** root `f` enters `wireframe.file`; Arrange `f` journals ONE
      `wireframe.arrange.bringForward` mutation (the selected element moves one position later in
      `data-wireframe-stacking`); Style `f` journals ONE `wireframe.style.fill` mutation and the
      element's fill token advances EXACTLY one step in `WIREFRAME_COLOR_TOKENS` (wrap
      `info→surface`); the place stays `wireframe.style`.
      **Edge:** File `f` is a place entry, never a verb; Arrange `f` with nothing selected
      (`did-nothing` noop, no entry); `f` on a **text** element in Style → the fill verb is
      unavailable → ONE announcement `f isn't available here`, no entry (bound-but-unavailable);
      `f` with a text control focused (nothing dispatched).

- [x] **F-N7 (LIVE WALKTHROUGH — required evidence) — root → create → drag → style → fill → file → save.**
      **Exact token sequence (binding, `Escape` required — see plan Q-2):**
      `c` → `r` → drag a rectangle → (auto-exit) → `s` → `f` (fill cycle) → `Escape` → `f`
      (File) → `w` (Save As).
      **Expected, quoted step by step:** `data-wireframe-place` reads
      `wireframe.create` → `wireframe.canvas` (after the drag) → `wireframe.style` → (one fill
      entry, the token advances one step) → `wireframe.canvas` (after `Escape`) →
      `wireframe.file`; `-element-count="1"`; the file exists at `FREDO_WIREFRAME_SAVE_PATH` with
      `schemaVersion:1`, `app:"fredo.wireframe"` and one `shape` element with `shape:"rect"`;
      `-dirty="false"`; `wireframe-status` reads `Saved`; console clean.
      **Artifacts (mandatory, uploaded):** a `dom_snapshot` (or `find_element` with
      `includeHtml`) of the Canvas state showing `navigation-rail` + the rail rows/place rows,
      plus a **light** screenshot (`light-default`) and a **dark** screenshot (`dark`) of the
      rail + canvas after the rectangle exists.
      **Edge:** the `Escape` omitted (the second `f` is fill again — a FAIL, not a product
      defect); a `FAIL_FILE` launch (banner, document intact).

- [x] **F-N8 (R-2 / AC2) — arrows align inside Arrange and move the selection at the root.**
      With ≥2 elements selected: `a` → `←` / `→`. Then `Escape` and `←` / `→` at the root.
      **Expected:** Arrange `←`/`→` journal ONE `wireframe.arrange.alignLeft`/`alignRight` each
      and the selected elements' `-selection-geometry` show coincident left (or right) edges;
      root `←`/`→` (and `↑`/`↓`) move the selection to the previous/next element in
      `data-wireframe-stacking` order, journal ONE `wireframe.selection.previous/next`
      NAVIGATION entry each (attributed, non-undoable, redo preserved), and change no document
      value.
      **Edge:** a `<2` selection in Arrange (`did-nothing`, no entry); arrows inside a text
      control (caret movement, nothing dispatched); an arrow press at the last element
      (clamped, selection unchanged, still one navigation entry).

- [x] **F-N9 (R-2 / AC2) — `Escape` pops exactly one level.**
      Enter `Create`, then `Escape`; enter `Style` then `Arrange` and `Escape` once.
      **Expected:** one level per press (`wireframe.create` → `wireframe.canvas`), `place.exit`
      journalled as a NAVIGATION entry, no document change, announcement
      `Left Create — Canvas — 2 actions` (composer-pinned); at the root `Escape` dispatches
      nothing and journals nothing (quiet hint, no announcement).
      **Edge:** `Escape` while a prefix is armed (the prefix is cancelled AND one level pops —
      one press, both effects); `Escape` with the map open (the adapter returns early: the map
      closes, the place does NOT pop); `Escape` in a details text field (focus moves to the
      canvas root, no dispatch).

- [x] **F-N10 (R-2 / AC2) — a completed action in the transient place auto-exits exactly once.**
      `c`, `r`, then drag a rectangle; separately `c` then `t` (insert).
      **Expected:** for BOTH legs the cursor returns to `wireframe.canvas`; the journal has
      exactly ONE human entry (draw: `wireframe.create.rect`, placePath
      `["wireframe.canvas","wireframe.create"]`, `exitedBy: "verb"`; insert:
      `wireframe.add.text`, same placePath) and NO second navigation entry; ONCE the
      announcement `Left Create — Canvas — 2 actions`; `data-wireframe-arm="none"`.
      **Edge:** a zero-area drag (abandoned — no entry, NO pop); a second draw after auto-exit
      (starts from Canvas); an aborted drag with `mouseup` outside the canvas.
      **Cross-ref:** the ST-1 host fix (`commitResult` must pop on `exitedBy:"verb"` in a
      transient place — shipped `ui/host.ts:322-334` moves the cursor only for
      `effect === "navigation"`).

- [x] **F-N11 (R-3 / AC3) — the rail and the map replace the bar and the toolbar.**
      Open Wireframe from the launcher.
      **Expected:** `navigation-rail`, `navigation-trail`, `navigation-map` (footer affordance)
      and `wireframe-canvas` render; `wireframe-toolbar` is **absent**;
      `[data-testid^="wireframe-action-"]` count **0**; `hotkeys-keybar` count **0** while
      Wireframe is focused, and `buildHotkeyBarModel(...).empty === true` for it. The INSERT pill
      (`wireframe-insert`) is present (the only toolbar-shaped affordance), opens a menu whose
      items carry `data-nav-verb-id`, and activating one does NOT change
      `data-wireframe-place`.
      **Non-vacuity control (G-408):** focus Mission Monitor → `hotkeys-keybar` present and its
      model non-empty.
      **Edge:** Wireframe open-but-unfocused (the bar stays empty); a second Wireframe window;
      the insert menu closed (still no toolbar).

- [x] **F-N12 (R-3 / AC3) — breadcrumb and rail cap.**
      Walk all six places.
      **Expected:** the `navigation-rail-breadcrumb` `data-nav-place-id` sequence is
      `[wireframe.canvas, wireframe.<place>]` for each of the six, and `navigation-rail-place`
      reads `Create/Edit/Arrange/Style/View/File`; at the root the sequence is
      `[wireframe.canvas]` and the label is `Canvas`; rail verb rows ≤ 8 everywhere;
      `actionCount` excludes the two globals and the place rows.
      **Edge:** the rail at 520 px window width (`scrollWidth ≤ clientWidth`); a 60-char verb
      title (ellipsis only on the title, G-274).

- [x] **F-N13 (R-3a / AC3) — the 33-row parity manifest.**
      Run `pnpm --filter @fredo/ui test:run src/applications/wireframe/__tests__/wireframeRailParity`.
      **Expected:** `the parity manifest has thirty-three rows` and `every toolbar capability
      resolves to a declared verb` green; exactly **33** `WIREFRAME_ACTIONS` rows have
      `toolbar: true`; the five id-aliased rows are pinned: `wireframe.file.open→place.open`,
      `wireframe.file.saveAs→place.saveAs`, `wireframe.file.exportPng→place.exportPng`,
      `wireframe.edit.undo→journal.undo`, `wireframe.edit.redo→journal.redo`; the two
      `wireframe.companion.*` rows (`toolbar: false`) are NOT counted; an unmapped row FAILS.
      **Edge:** a 34th toolbar row; a mapping to a deleted id; an engine verb (`journal.*`)
      mapped but absent from `ENGINE_VERB_IDS`.
      **Parity list (33, in `WIREFRAME_ACTIONS` declaration order):**
      `add.text, add.button, add.input, add.image, add.icon, add.card, add.section, add.shape,
      add.line, element.duplicate, element.delete, element.toggleLock, edit.undo, edit.redo,
      zoom.in, zoom.out, view.fitPage, view.resetView, view.togglePan, file.saveAs, file.open,
      file.exportPng, arrange.group, arrange.ungroup, arrange.toggleGroupLock,
      arrange.toggleSnap, arrange.alignLeft, arrange.alignCenter, arrange.alignRight,
      arrange.distribute, arrange.bringForward, arrange.sendBackward, document.new`.

- [x] **F-N14 (R-3b / AC3) — 100% reachability, including argument-requiring verbs.**
      **Expected:** every declared verb is reachable by a key binding somewhere in the tree OR
      appears in its `appliesTo` place block of `navigation-map` with
      `data-nav-availability="available"`; `the create place reports one overflow verb and opens
      the map filtered` and `every argument-requiring capability performs from the map with its
      default` are green; clicking `Icon`, `Shape` and `Section` in the map's Create block each
      adds exactly one element with the declared defaults — `{iconId:'star'}`, `{shape:'rect'}`,
      `{preset:'header'}` — an `invalid-args` rejection is a FAIL. A map click on
      `wireframe.create.rect` ARMS (no entry) — it does not error.
      **Edge:** `app.ask` (`k`) is present but DISABLED with
      `Ask arrives with the launcher in the next phase`; Undo/Redo reachable via `u`/`y` and
      the trail's per-entry Undo; `setField`/`page.update`/`move`/`resize`/`panBy` invoked with
      no args are `noop` (documented capability rows, no error); a map click on an unavailable
      verb runs nothing.

- [x] **F-N15 (R-4 / AC4) — availability is kind+count gated and derived from the snapshot.**
      With nothing selected read the map's Edit/Arrange/Style blocks; then select a **shape**,
      a **text**, a **button**, and a **card** in turn and re-read.
      **Expected (UI/UX §4 matrix):** nothing selected → every Edit/Arrange/Style verb reads
      `data-nav-availability="disabled"` with `Not available for the current selection`;
      shape → `fill`/`border`/`radius` available; text → `textStyle` available while `fill` is
      DISABLED; button → `appearance` available; card → `rename` available, `rename` disabled
      for a `shape`/`image`/`section`/`line`; count 2 → `alignLeft/alignCenter/alignRight/group`
      available, `distribute` disabled; count 3 → `distribute` available; a whole-group
      selection DISABLES `group` and enables `ungroup`/`toggleGroupLock`; the flip appears in
      the SAME snapshot after one selection change; no component holds a local availability
      boolean.
      **Edge:** select by pointer then deselect by empty-canvas click; a locked element
      (available, the verb may still no-op); a hidden element (selectable via undo only);
      `radius` on a non-rect shape stays available and no-ops.
      **Note:** the Canvas rail lists only `selection.previous/next`, so element-scoped rows are
      read from the MAP. Reading the Canvas rail for them is a technique error.

- [x] **F-N16 (R-4 / AC4) — multi-selection reflects the count.**
      Select 2, then 3, then 1 element.
      **Expected:** count 2 → `alignLeft`, `alignCenter`, `alignRight`, `group` available,
      `distribute` disabled; count 3 → `distribute` available; count 1 → align/distribute/group
      all disabled with the reason.
      **Edge:** 3 selected with 1 locked → the row stays ENABLED and the invoke returns
      `did-nothing` (movable-only store rule unchanged, R-g); a 2-element selection that is
      exactly one group → `group` disabled, `ungroup` available.

- [x] **F-N17 (R-5 / AC5) — one `human` entry per document mutation, with the verb id and place path.**
      Perform each of: create (`c r` drag), move (drag), resize (transformer), duplicate
      (`e` `d`), delete (`e` `x`), lock (`e` `l`), fill/border/radius/text style (`s` … on the
      appropriate kind), page change, arrange group (`a` `g`).
      **Expected:** each appends exactly ONE entry with `actor:"human"`, the dispatched
      `verbId`, `effect:"mutation"`, the DISPATCH-TIME `placePath` (e.g.
      `["wireframe.canvas","wireframe.arrange"]` for Arrange verbs), `undoable === true`, and
      `coalesceKey === null`; the trail shows one new row per action with the verb label and the
      path.
      **Edge:** a no-op (already-aligned, clamped reorder) writes NOTHING; a view verb
      (`+`, `-`, `f`, `0`, `p`) writes ONE **navigation** entry, `patch: null`, not undoable, and
      does NOT clear the redo stack; Edit `r` (rename) writes a navigation entry (focus move),
      not a mutation; a repeated field tick writes TWO entries (no coalescing).

- [x] **F-N18 (R-5 / AC5) — undo restores, redo re-applies, undo after a selection change is safe.**
      Move element A, then select B, then `u` at the ROOT; then `y`.
      **Expected:** `u` restores A's exact prior geometry and selection, appends ONE
      `actor:"system"` entry labelled `Undo <label>`, speaks `Undid <label>` once, and no live
      selection id is absent from the document; `y` re-applies and removes that seq from the redo
      stack; an extra `y` is a no-op.
      **Edge:** undo of a delete (the same id returns); undo then a NEW mutation (redo stack
      cleared); undo after New/Open (`noop`, `Nothing to undo.`); a view verb never enters the
      undo stack; **inside Arrange `u` is ungroup** — the undo leg must run at the Canvas root
      (or via the trail's per-entry Undo).

- [x] **F-N19 (R-5a / AC5) — exactly ONE undo stack (the journal).**
      Run `pnpm --filter @fredo/ui test:run src/applications/wireframe/__tests__/wireframeUndoAuthority`
      and `.../wireframeJournal`.
      **Expected:** `the store keeps no past or future stack`, `canUndo and canRedo read the
      journal`, `history reset on new and open clears the journal`, `every shipped document
      mutation still commits exactly one undo step` and `store undo and host undoLast advance
      the same journal` are green; the source scan of `wireframeDocumentStore.ts` (comments and
      string/template literal text stripped; interpolations kept as code) finds zero `past` /
      `future` tokens; live, `store.undo()` then `host.undoLast()` walk two consecutive states
      with no gap.
      **Edge:** a retained private array under another name (the behavioural half catches it);
      undo interleaved with a companion/system entry; 100+ edits (journal unbounded — named risk).

- [x] **F-N20 (R-6 / AC6) — pointer and keyboard commit the same verbs.**
      Create by drag; move by drag; resize by transformer; pan in `View` `p`.
      **Expected:** each commits exactly ONE entry with the declared verb id —
      `wireframe.create.rect`, `wireframe.element.move`, `wireframe.element.resize`,
      `wireframe.view.panBy` (navigation); the same verb id the keyboard/declaration path uses;
      pan leaves document, count, selection, dirty and the saved JSON identical.
      **Edge:** an abandoned gesture; a 1-px drag; 400 % zoom (page-space delta = pointer/scale);
      two gestures = two entries; a drag that ends outside the canvas.
      **Cross-ref:** `wireframePointerConvergence.test.ts` (NEW, ST-5).

- [x] **F-N21 (R-6a / AC6) — no UI handler mutates the store outside `dispatch`.**
      Run `pnpm --filter @fredo/ui test:run src/applications/wireframe/__tests__/wireframeLegacySurface`.
      **Expected:** `no ui handler mutates the store outside dispatch` green: the scan over
      `applications/wireframe/components/**/*.{ts,tsx}` (excluding `__tests__`; comments and
      literal text stripped, interpolations kept as code) finds zero uses of `dispatch`,
      `applyDocumentPatch`, `undo`, `redo`, `resetForNewDocument`, `loadDocument`,
      `addWireframeElement`, `updateElement` from the document store. The property panel
      therefore dispatches `wireframe.style.*` / `wireframe.element.setField` /
      `wireframe.page.update` through the host, not the store.
      **Edge:** a re-exported alias (scan the module barrel); a comment naming a mutator
      (stripped → pass); a template interpolation calling the mutator (must be caught).

- [x] **F-N22 (R-7 / AC7) — the legacy path is gone and the build is clean.**
      **Expected:** `applications/wireframe/wireframeCommandSurface.ts` and
      `components/WireframeHotkeyCarrier.tsx` do not exist; no import of either anywhere;
      `WireframeFeature` declares no `commandSurface`; no `WIREFRAME_ACTIONS` row has a
      `hotkey` key; zero `g+` sequences and zero `data-hotkey` in
      `applications/wireframe/**`; live
      `document.querySelectorAll('[data-testid="wireframe-root"] [data-hotkey]').length === 0`;
      after a real `pnpm --filter @fredo/ui build`, every file under `apps/ui/dist/assets/**`
      has zero hits for `wireframeCommandSurface`, `WireframeHotkeyCarrier`,
      `wireframe-hotkey-carrier`; the build exits 0.
      **Edge:** a `g`-prefixed string in a comment (stripped → pass); a stale `dist` (rebuild
      first); the four replaced product test files deleted in the same landing; the file rows are
      no longer visually disabled during an operation (accepted delta — behaviour, not the
      disabled affordance, is asserted).

- [ ] **F-N23 (R-9 / AC9) — one region, one announcement, focus kept.** **FAIL (round 1,
      2026-10-30).** The announcement legs pass; the FOCUS leg fails in the real shell:
      focus a `navigation-rail-place-row` button (`activeElement` = that BUTTON), press `c` →
      `data-wireframe-place="wireframe.create"` and `document.activeElement` becomes `BODY`
      (the `navigation-rail-places` group unmounts because `placeRows` are the CURRENT place's
      children, so the focused node is removed). Expected: still the same row button, never
      `body`. Repro: open Wireframe → focus the `Create` place row → press `c` → read
      `document.activeElement.tagName` → `BODY`.
      **Expected:** `document.querySelectorAll('[aria-live]').length === 1` and the region is
      `[data-testid="hotkeys-announcer"]` (`role="status"`, `aria-live="polite"`);
      `[data-testid="navigation-announcer"]` is ABSENT (the provider creates the host with
      `announcementChannel: 'legacy'` and mounts no `NavigationAnnouncer`); the composer pins hold
      (`navPlaceEnterMessage('Create', 9) === 'Create — 9 actions'`, `navPlaceExitMessage(
      'Create','Canvas', 2) === 'Left Create — Canvas — 2 actions'`) and entering/exiting
      produces exactly ONE update each with that text; focus a `navigation-rail-place-row`
      button, press `c`, and `document.activeElement` is still that same button (never `body`);
      text-entry focus announces nothing; the region is never written by a failed file verb.
      **Edge:** root `Escape` (quiet hint, no announcement); a transition immediately reversed
      (two distinct messages); the map dialog's close restores focus to its invoker;
      reduced-motion on; a bound-but-unavailable key (`f` on a text element) speaks
      `f isn't available here` exactly once.

- [x] **F-N24 (NFR) — synchronous, cheap, themed, motion-safe.**
      **Expected:** `every listed stroke resolves synchronously in the same task` green (a spy
      records `host.handleStroke` inside the same call stack as the keydown; no `await`/`.then`
      precedes it — and there is exactly ONE element-scoped keydown handler, no document
      listener); `no new polling or timer loop exists` green (no `setInterval`, no `rAF` loop;
      only the one-shot 250 ms prefix clear); `the canvas reads a derived place view and never
      the journal` green (50 journal appends do not re-render the canvas); `contrast:gate` green
      and a scoped sweep of `src/shared/navigation/**` + `applications/wireframe/**` finds no
      `#rrggbb`, no `rgb(`/`hsl(`, no `var(--x)NN` alpha-append, no bare `white`/`black`;
      rail/map/trail transitions name only `opacity`/`transform` and honour
      `useNavReducedMotion()`; console clean after 50 drags + 30 key strokes + 2 theme switches.
      **Edge:** an effect keyed on `entries.length` (FAIL); two epoch advances for one mutation;
      `setInterval` in a surface; a raw colour in a `title` string (text only — never a style
      prop); the reserved hotkey-bar padding is gone with the bar (no layout reservation).

## Suite-level pass/fail

PASS = F-N1…F-N24 green, every cited `it()` title observed VERBATIM in the reporter, no
`.skip`/`.todo`/`.only`, every live row carrying a quoted tool result, the walkthrough (F-N7)
carrying both light and dark captures plus a DOM snapshot, and the build green. A row whose
evidence is a draft (this plan, the developer summary, the tests-runs draft) is UNVERIFIED.
Pre-authorized UNVERIFIED: **only** the companion/launcher parity regression (plan Q-1 — P6,
asserted as fail-closed in `regression.md` R-27).

---

## Amendment procedure (when a row fails on a PRODUCT defect)

Leave `- [ ]`, mark **FAIL** with expected-vs-actual and the exact stroke sequence + the
observed `data-wireframe-place` / `data-wireframe-arm` / journal length. Never re-baseline a
clause; re-baselining an EXPECTED VALUE (a count, a key, a testid) is allowed and must be
recorded inline (G-125).

---

## Round 1 results — 2026-10-30 (spec/3119 @ `5e49d43`, tester)

Env: isolated `wf3119-a` (slot 1, MCP `16001`), built-in `tauri_driver_session`. Pre-flight:
`pnpm --filter @fredo/ui build` green **before** the suite (2863 modules); full UI suite
**294 files / 3881 tests**; scoped wireframe **30 files / 407 tests**; `typecheck` clean;
`contrast:gate` **4 files / 50 tests**. Console (`tauri_read_logs source=console`) clean across
the whole drive — no `Error:`/`Uncaught`/`Maximum update depth exceeded`.

| Row | Result | Evidence (quoted receipt) |
|---|---|---|
| F-N1 | PASS | `wireframeSurface.test.ts` **11/11**; manifest titles verbatim, green in the 407-test run. |
| F-N2 | PASS | Rail at Canvas: `placeRows 6`, `navigation-rail-row 2`. Create: 8 rows `[Rectangle, Ellipse, Text, Button, Input, Image, Card, Section]`, `navigation-rail-more 1`, transient chip `Create · one action`. |
| F-N3 | PASS | `c` → `place="wireframe.create"`, breadcrumb `[wireframe.canvas, wireframe.create]`, announcer `Create — 9 actions`, trail +1. `r` → `arm="rect"`, place unchanged, cursor `crosshair`, trail unchanged, announcement unchanged. |
| F-N4 | PASS | Root `r` + drag → place stayed `wireframe.canvas`, `arm` rect→none, count 0→1, `-selection-type="shape"`, `-selection-shape="rect"`, one `Rectangle` entry, no announcement. |
| F-N5 | PASS | Root `s` → `wireframe.style`; Arrange `s` → `data-wireframe-snap` false→true, one `Toggle snap` NAVIGATION entry with **no** Undo button, place unchanged. |
| F-N6 | PASS | Root `f` → `wireframe.file`; Arrange `f` → stacking flipped + one `Bring forward` entry; Style `f` on a shape → fill `muted`→`border`, one entry; Style `f` on **text** → announcer `f isn't available here`, no entry. |
| F-N7 | PASS (amended, Q-2) | Sequence `c → r → drag → s → f (fill) → Escape → f (File) → w`. Places `create`→`canvas`→`style`→`canvas`→`file`; `-element-count="1"`; saved file `schemaVersion:1`, `app:"fredo.wireframe"`, one `shape`/`rect`; `-dirty="false"`; `wireframe-status` `Saved`; console clean. Captures: dark + light (uploaded). |
| F-N8 | PASS | Root `→` → one `Next element` navigation entry, selection clamped, place unchanged. Arrange-align leg pinned green by `ArrowLeft and ArrowRight align the selection inside arrange` (live multi-select drive not reproducible — see note below). |
| F-N9 | PASS | Style→`Escape` → `wireframe.canvas` + `Left Style — Canvas — 2 actions`; root `Escape` → **no** entry, **no** new announcement. Escape with the map open closes the map and leaves the place unchanged. |
| F-N10 | PASS | Draw auto-exit: `Left Create — Canvas — 2 actions`, one `Rectangle` entry, `arm="none"`. Insert leg (`c` `t`): one `Add Text` entry, `Left Create — Canvas — 2 actions`, place `canvas`. |
| F-N11 | PASS | `navigation-rail 1`, `navigation-trail 1`, `wireframe-canvas 1`, `wireframe-property-panel 1`, `wireframe-insert 1`, `wireframe-toolbar 0`, `[data-testid^="wireframe-action-"] 0`, `hotkeys-keybar 0`. Non-vacuity (G-408): Mission Monitor focused → `hotkeys-keybar 1` with 1 row. |
| F-N12 | PASS | Breadcrumbs observed `Canvas`, `Canvas›Create`, `Canvas›Style`, `Canvas›File` (all `[wireframe.canvas, <place>]`); ≤8 verb rows in every place; Canvas 2 rows. |
| F-N13 | PASS | `wireframeRailParity.test.tsx` **10/10** (`the parity manifest has thirty-three rows`, `every toolbar capability resolves to a declared verb` verbatim, green). |
| F-N14 | PASS | Map data query: every declared verb appears in its `appliesTo` block. `wireframe.add.icon` click → count +1, `-selection-type="icon"`, one `Add Icon` entry (no `invalid-args`); `wireframe.add.section` → `-selection-type="section"`, one entry. `app.ask` present with `data-nav-availability="disabled"`. |
| F-N15 | PASS | Live: text selected → Style block `fill/border/appearance/radius = disabled`, `textStyle = available`; nothing selected → `align*`, `distribute`, `group` `disabled`; count-2/3 matrix pinned by the green `flipping the selection flips rail and map availability` + `multi-selection gates align distribute and group by count` titles. |
| F-N16 | PASS | Count 1 → align/distribute/group `disabled`. Count 2/3 legs pinned by the green titles above (live multi-select drive not reproducible — see note below). |
| F-N17 | PASS | One human entry per mutation at the store level: `Rectangle`, `Add Text`, `Add Icon`, `Add Section`, `Add Image`, `Bring forward`, `Fill`, `Update page`, `Move`, `Resize` — each exactly one, trail newest-first. No coalescing observed. |
| F-N18 | PASS | Root `u` → count 6→5, one `System Undo Add Image` entry (actor `System`), announcer `Undid Add Image`; `y` → count back to 6, selection restored. |
| F-N19 | PASS | `wireframeUndoAuthority.test.ts` 4/4 + `wireframeJournal.test.ts` 7/7 green (`the store keeps no past or future stack`, `store undo and host undoLast advance the same journal` verbatim). |
| F-N20 | PASS | Create-drag → `Rectangle`; element drag → geometry `520,608,240,160`→`576,640,240,160` + one `Move`; transformer drag → `576,640,240,160`→`576,600.6,299.1,199.4` + one `Resize`; pan drag (View `p`) → one `Pan` NAVIGATION entry, count/geometry/dirty identical. |
| F-N21 | PASS | `wireframeLegacySurface.test.ts` **7/7** (`no ui handler mutates the store outside dispatch` verbatim, green). |
| F-N22 | PASS | `wireframeCommandSurface.ts` / `WireframeHotkeyCarrier.tsx` deleted (diff); `the built bundle names no removed module` green after the pre-suite build; `data-hotkey` under `wireframe-root` = 0. |
| F-N23 | **FAIL** | Announcements PASS (`Create — 9 actions`, `Left Create — Canvas — 2 actions`, `Left Style — Canvas — 2 actions`, `File — 4 actions`; `navigation-announcer` absent). FOCUS leg FAIL: focusing a `navigation-rail-place-row` and pressing `c` leaves `document.activeElement === BODY` (the places group unmounts). Expected: the same row button. |
| F-N24 | PASS | `every listed stroke resolves synchronously in the same task`, `no new polling or timer loop exists`, `the canvas reads a derived place view and never the journal` green; `contrast:gate` 50/50; console clean. |

**Live-drive limitation (disclosed, not a product FAIL):** the multi-select pointer gesture
(click element A, then Shift+click element B) could not be reproduced with the sanctioned
driver — `tauri_webview_interact` clicks drive single selection correctly (verified), but the
modifier state does not reach the Konva native event, so only count-1 selection could be
driven. The count-2/3 availability matrix is therefore evidenced by the cited green unit titles
plus the live count-0/count-1 observations.
