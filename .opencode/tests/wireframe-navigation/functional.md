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

- [x] **F-N23 (R-9 / AC9) — one region, one announcement, focus kept.**
      **PASS (round 2, 2026-10-30, spec/3119 @ `6311823`) — focus leg fixed by `c587972`.**
      Round-1 history (superseded): the FOCUS leg failed — focusing a
      `navigation-rail-place-row` and pressing `c` left `document.activeElement === BODY`
      (the current place's `placeRows` unmount). Round 2 re-ran the exact repro live: focus
      `[data-testid="navigation-rail-place-row"][data-nav-place-id="wireframe.create"]`
      (`activeElement` = that `BUTTON`, `aria-label="Create — 9 actions (C) — one action"`) →
      press `c` → `data-wireframe-place="wireframe.create"`, `document.activeElement` is
      `H2[data-testid="navigation-rail-place"]` (`tabindex="-1"`, text `Create`) INSIDE
      `[data-testid="navigation-rail"]` — **never `BODY`**; `Escape` pops to `wireframe.canvas`
      and restores focus to the SAME Create row (`data-nav-place-id="wireframe.create"`);
      pointer-click the Edit row → `wireframe.edit`, focus retained in the rail (heading), never
      `BODY`. A subsequent `Escape` still dispatched (the element-scoped key adapter stayed
      alive). A place transition driven from the CANVAS (`v` at root) did NOT steal focus
      (`activeElement` stayed `DIV[data-testid="wireframe-canvas"]`).
      **Expected (R-9 adjudication, recorded inline):** the navigation stream is exactly ONE
      update per transition on `[data-testid="hotkeys-announcer"]` (`role="status"`,
      `aria-live="polite"`) and `[data-testid="navigation-announcer"]` is ABSENT; a global
      `[aria-live].length === 1` is NOT asserted because the shipped `WireframeStatusBar` is also
      a `role="status"` region (observed 7 `[aria-live]` nodes — round-1 R-9 adjudication). The
      composer pins hold (`navPlaceEnterMessage('Create', 9) === 'Create — 9 actions'`,
      `navPlaceExitMessage('Create','Canvas', 2) === 'Left Create — Canvas — 2 actions'`) and
      entering/exiting produces exactly ONE update each with that text; focus a
      `navigation-rail-place-row` button, press `c`, and focus is re-homed to the always-rendered
      `navigation-rail-place` heading (the same row when it reappears on the return trip), never
      `body`; text-entry focus announces nothing; the region is never written by a failed file verb.
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

---

## Round 2 results — 2026-10-30 (spec/3119 @ `6311823`, retry: AC9 focus leg)

Scope: re-test ONLY the previously-failing AC9 focus leg (F-N23) plus a regression sweep of the
fixed surface. Env: isolated `wf3119-a` (slot 1, MCP `16001`), `Up` on `6311823` after a
`Down`→`Up` (no `Restart`). CI parity — `pnpm --filter @fredo/ui typecheck` exit 0;
`build` green **before** the suite (2864 modules, 11.66s); full suite **296 files / 3888 tests**;
`contrast:gate` **4 files / 50 tests**. `cargo check` not run — `git diff --stat origin/main HEAD
-- apps/tauri` is empty (no Rust source changed; disclosed). Console clean across the drive.

| Row | Result | Evidence (quoted receipt) |
|---|---|---|
| **F-N23 (focus leg)** | **PASS (was FAIL)** | Focus `navigation-rail-place-row[data-nav-place-id=wireframe.create]` → `activeElement` = `BUTTON` `aria-label="Create — 9 actions (C) — one action"` → press `c` → `place="wireframe.create"`, `activeElement` = `H2[data-testid=navigation-rail-place]` `tabindex="-1"` text `Create`, `activeInsideRail=true`, `activeIsBody=false`; `announcer="Create — 9 actions"`, `navigation-announcer` absent. `Escape` → `place="wireframe.canvas"`, focus restored to the Create row `BUTTON` (`data-nav-place-id=wireframe.create`), `announcer="Left Create — Canvas — 2 actions"` — the Escape itself dispatched (key adapter alive). |
| **F-N23 (pointer leg)** | **PASS** | Click the Edit place row → `place="wireframe.edit"`, `activeElement` = `H2[navigation-rail-place]` text `Edit`, inside rail, `activeIsBody=false`; one announcement `Edit — 5 actions`. |
| **F-N23 (no-steal, canvas)** | **PASS** | Focus `[data-testid=wireframe-canvas]`, press `v` → `place="wireframe.view"`, `activeElement` stays `DIV[data-testid=wireframe-canvas]` (rail did not steal focus), `announcer="View — 5 actions"`, 5 View rows, `navigation-announcer` absent. |
| **F-N23 (announcements)** | **PASS** | `Create — 9 actions`, `Edit — 5 actions`, `Style — 5 actions`, `View — 5 actions`, `Left Create — Canvas — 2 actions` — each exactly one update; `navigation-announcer` absent; 7 `[aria-live]` nodes (R-9 adjudication — the shipped `WireframeStatusBar` is also a status region). |
| **NFR build/parity** | **PASS** | typecheck 0 diagnostics; build 2864 modules / 11.66s; full suite 296/3888; contrast 4/50; no `.skip`/`.todo`/`.only` in `applications/wireframe` or `shared/navigation`. |
| **AC3 surface sweep** | **PASS** | Live rail/trail/canvas present; `wireframe-toolbar 0`, `wireframe-hotkey-carrier 0`, `[data-hotkey]` under `wireframe-root 0`, `hotkeys-keybar 0`; 33-row parity pinned by the green `wireframeRailParity.test.tsx` (10/10). |

Unit pins (green in the full run): `commandRailFocus.test.tsx` **3/3**,
`wireframeNavigationFocus.test.tsx` **4/4**, `commandRail.test.tsx` (no focus move on mount),
`wireframePlaceLifecycle.test.ts` (focus + one announcement), `wireframeRailParity.test.tsx`
**10/10**, `wireframeLegacySurface.test.ts` **7/7**.

---

## #3120 rescope extension — the bottom command bar (human-directed rescope)

> **HUMAN-DIRECTED RESCOPE.** The left rail the human rejected is replaced by ONE full-width horizontal
> command bar docked at the BOTTOM of the Wireframe editor: breadcrumb left, the SIX child place rows
> (Create / Edit / Arrange / Style / View / File) and then the current place's contextual verbs centre
> (declaration order, ≤ 8), a vertical `Separator` between the two groups when both are present,
> `? Map`/`Ask` right, no horizontal scroll. Rows map 1:1 to `.opencode/tmp/3120/triage.md` `## QA Expert` keyed **R-1**,
> **R-4** (declaration), **R-5**, **R-6**, **R-7** and **R-8** (live half).
> **Verification policy: live**, except **F-N35** and **F-N38** which are `static` (prove-a-negative
> source scans — G-408). Evidence record: the POSTED `## Tests Runs` comment, never a
> `.opencode/tmp/3120/` draft (G-415).
>
> **This durable suite is the source of truth.** `functional.md` (with `smoke.md`, `regression.md`
> and `e2e.md`) — not the `.opencode/tmp/3120/` drafts, the triage plan or an issue comment —
> defines what the tester executes and scores. **The pipeline does not run Gate H**: the
> pilot-exit review needs human-produced participant data, no participant data exists in this spec,
> and its absence is never a test failure.
>
> **Binding names (consume verbatim).** Bar root `[data-testid="navigation-bar"]` (symbol
> `NAV_RAIL_TESTID`, value `navigation-bar`; `aria-label` `Command bar`; `data-nav-surface="bar"`);
> `navigation-bar-breadcrumb`; the child-place list `navigation-rail-places` (**retained** testid
> string, `NAV_RAIL_PLACES_TESTID`; `role="list"`/`<ul>`) whose six `navigation-rail-place-row`
> buttons (`NAV_RAIL_PLACE_ROW_TESTID`) each sit inside a `role="listitem"` `li`, are real
> `button`s carrying `data-nav-place-id`, the row tooltip as `title`/`aria-label`, and a keycap, and
> are rendered BEFORE the verb cluster (with a vertical `Separator` between the two groups when both
> are present); `navigation-bar-place` (the LAST breadcrumb segment, the focus anchor,
> `tabindex="-1"`); `navigation-bar-list`; `navigation-bar-row` (each carries `data-nav-verb-id`);
> `navigation-bar-more` (`more…`); `navigation-bar-map` (`? Map`); `navigation-bar-ask` (`Ask`);
> shell hooks `wireframe-command-bar`, `wireframe-details-column`, `wireframe-status-bar`, and
> `data-wireframe-region="canvas|details"`. Constants: `NAV_BAR_MIN_HEIGHT_PX = 44`,
> `NAV_BAR_ROW_MIN_WIDTH_PX = 96`, `NAV_BAR_ROW_GAP_PX = 2`, `NAV_RAIL_MAX_ROWS = 8`. The COMPONENT
> and MODEL symbols keep their historic names (`CommandRail`, `buildCommandRailModel`,
> `CommandRailModel`); `model.placeRows` IS rendered as the bar's child-place list. **Naming note
> (verified on the tip):** the `navigation-bar-places` / `navigation-bar-place-row` spellings do NOT
> exist on this tip — the shipped constants are the retained `navigation-rail-places` /
> `navigation-rail-place-row` values. Do NOT assert those two strings absent: they now identify the
> BAR's place list/rows. The legacy LEFT rail itself is gone (`[data-testid="navigation-rail"]` = 0).
>
> **Supersession.** The #3119 rail rows F-N2/F-N12/F-N23 pinned place ROWS and the rail TESTIDS
> `navigation-rail*`; those testid strings and the place-row rendering are SUPERSEDED by
> F-N25..F-N31/F-N39/F-N44. The BEHAVIOUR pins (declaration order, ≤ 8, one announcement, focus
> re-home, no store mutation outside `dispatch`, one key adapter) remain in force and are restated
> below against the bar. F-N1/F-N3..F-N10/F-N13..F-N22/F-N24 are NOT superseded — run them unchanged.

- [ ] **F-N25 (R-1.1) — horizontal placement: breadcrumb left, verbs centre, `? Map` and `Ask` right.**
  **Steps:** open Wireframe (launcher `wire` + Enter); read the rects in ONE `execute_js` task — the
  root `navigation-bar`, `navigation-bar-breadcrumb`, every `navigation-bar-row`,
  `navigation-bar-map`, `navigation-bar-ask`, and the containing `wireframe-command-bar`.
  **Expected:** the bar root is INSIDE `wireframe-command-bar`; `data-nav-surface="bar"`; root
  accessible name `Command bar`; computed `min-height` ≥ `NAV_BAR_MIN_HEIGHT_PX` (**44**);
  `breadcrumb.right ≤ firstRow.left`; every row's horizontal centre lies between `breadcrumb.right`
  and `map.left`; `map.right ≤ ask.left`; **Ask is the rightmost control and flushes the bar's
  CONTENT box:** `ask.right ≥ contentRight − 1`, where
  `contentRight = root.right − paddingRight − borderRightWidth` read from
  `getComputedStyle(root)` (the bar carries 12 px symmetric horizontal padding — `px="3"` — plus its
  1 px top border, so the content box ends ~13 px inside the border box; a `root.right − 1` bound
  would instead demand Ask sit on the padding and is NOT the shipped contract), and no row, `? Map`
  or breadcrumb segment has a `right` greater than `ask.right`; the breadcrumb renders the
  place path (`Canvas` at root, `Canvas › <place>` inside a place); the bar spans the editor width
  (`bar.left` ≈ editor.left, `bar.right` ≈ editor.right).
  - **Edge:** root place (one segment); a long place label; 1280×800 and 900×600; `? Map`/`Ask` keep
    their accessible names; the bar's own height does not clip a row.
  - **Receipt:** the rect table + E-SHOT.

- [ ] **F-N26 (R-1.2) — declaration order and the eight-row cap, never padded, sorted or sliced by the component.**
  **Steps:** walk the six places with `c e a s v f` (+ `Escape`); read `data-nav-verb-id` per
  `navigation-bar-row` and the `navigation-bar-more` node.
  **Expected:** every place `rows.length ≤ 8`; **Create** = **8** rows in declaration order
  `Rectangle, Ellipse, Text, Button, Input, Image, Card, Section` + `navigation-bar-more` (`more…`);
  **Arrange** = 8 rows (no `more…`); **Edit/Style/View** = their declared 5; **File** = its declared 4;
  **Canvas** = its true 2 (the bar is NEVER padded to a minimum — the 4–8 band applies to the six child
  places, root renders its real count); order equals the declaration's `deriveRail` order; no row is
  rendered twice.
  - **Edge:** re-enter Create (same order); a leaf place; the 9th Create verb (`Line`) is NOT a row but
    IS in the filtered map (F-N29); a 520-px-wide window.
  - **Receipt:** E-DOM (verb ids per place) + E-SHOT of Create.

- [ ] **F-N27 (R-1.3) — the bar never scrolls horizontally and the title is the one ellipsizing child.**
  **Steps:** at 1280×800 and 900×600, read `overflowX` for every element in the bar subtree and
  `scrollWidth`/`clientWidth` for the bar root, the breadcrumb and the verb list; read
  `text-overflow`/`white-space`/`overflow` of each row title and breadcrumb segment.
  **Expected:** the bar root's `overflowX` is `hidden` (never `auto`/`scroll`); NO element in the bar
  subtree computes `overflow-x: auto|scroll`; `scrollWidth ≤ clientWidth` on the bar root, the
  breadcrumb and the verb list at BOTH widths (no horizontal scrollbar); exactly ONE ellipsizing child
  per row (the title) and the breadcrumb segments ellipsize, never wrap; every verb row is at least
  `NAV_BAR_ROW_MIN_WIDTH_PX` (**96**) wide; when 8 rows cannot fit one line at 900 px the verb cluster
  GROWS VERTICALLY (the bar's measured height increases; the status bar stays directly below it) —
  vertical growth is the agreed escape valve (UIUX-D6), horizontal scroll is never one; **the scored
  observables are NO horizontal scroll, every row ≥ 96 px, and the status bar still below the bar**
  (see Discussion QA-1 for the R-1 `minWidth: 0` wording).
  - **Edge:** a 60-char verb title; 8 rows at 900 px (vertical-growth leg); a long breadcrumb; a resize
    while the map is open.
  - **Receipt:** the computed-style + scroll table at both widths + E-SHOT.

- [ ] **F-N28 (R-1.4) — the bar renders the child-place list before the verb cluster; the legacy left rail is gone.**
  **Steps:** at the root, read `[data-testid="navigation-bar"]`; count the
  `[data-testid="navigation-rail-places"]` list's `[data-testid="navigation-rail-place-row"]`
  children and read their `data-nav-place-id` order, labels, role and `aria-label`/`title`; confirm
  every place row precedes the first `[data-testid="navigation-bar-row"]` in document order; scan the
  whole Wireframe subtree for the OLD left-rail root `[data-testid="navigation-rail"]`; then open
  `? Map` and confirm the six place blocks exist.
  **Expected:** the child-place list renders at the ROOT with the SIX child places in declaration
  order — `wireframe.create`, `wireframe.edit`, `wireframe.arrange`, `wireframe.style`,
  `wireframe.view`, `wireframe.file` (labels Create / Edit / Arrange / Style / View / File) — each
  row a real `button` inside a `role="listitem"` `li`, inside a `role="list"`/`<ul>` list, carrying
  `data-nav-place-id` and a non-empty accessible name; the place group renders BEFORE the verb
  cluster (the first place row precedes the first verb row; a vertical `Separator` separates the two
  groups); `[data-testid="navigation-rail"]` count **0** (the old LEFT rail is absent); the map has
  the SIX place blocks with their verbs (non-vacuity — discovery remains, the absence of the old rail
  is not vacuous).
  - **Edge:** every one of the six places; the map open; the transient Create chip is NOT a place
    list; a second Wireframe window.
  - **Receipt:** E-DOM (the list + rows + order + the legacy-root absence + the map blocks) + E-SHOT.

- [ ] **F-N29 (R-1.5) — `more…` opens the navigation map filtered to the current place.**
  **Steps:** `c` (Create), click `[data-testid="navigation-bar-more"]`; read the `navigation-map`
  dialog, its search input (`NAV_MAP_SEARCH_TESTID`) and the Create block; close it and read focus.
  **Expected:** the map opens; its search value is seeded from the current place path; the Create block
  lists the declaration's ACTUAL create set — **11** verbs: `wireframe.create.rect`,
  `wireframe.create.ellipse`, `wireframe.add.text`, `wireframe.add.button`, `wireframe.add.input`,
  `wireframe.add.image`, `wireframe.add.icon`, `wireframe.add.card`, `wireframe.add.section`,
  `wireframe.add.shape`, `wireframe.add.line` (Rectangle … Line) — i.e. every declared verb whose
  `places` includes `wireframe.create`, counted from the declaration at read time; the block's row
  count EQUALS that count (8 bar rows + the 3 overflow verbs `Icon`, `Shape`, `Line`) and the block is
  never truncated — derive the expected set/count from `wireframeSurface.ts`, never from a stale
  literal; closing the map restores focus to the `more…` button.
  - **Edge:** keyboard activation (Enter/Space) of `more…`; Arrange (no `more…` — open the map from
    `? Map` with no filter and see all six places); Canvas (2 rows, no `more…`); `Escape` closes the
    map only (the place does NOT pop — F-N9).
  - **Receipt:** E-DOM (search value + block rows) + E-SHOT.

- [ ] **F-N30 (R-1.6) — a place transition re-homes focus to the same control or the current-place breadcrumb; focus elsewhere is never stolen.**
  **Steps:** (a) focus a `navigation-bar-row` at the root and press a stroke that changes place;
  (b) focus the same verb row in a place, leave the place, re-enter it; (c) focus
  `[data-testid="wireframe-canvas"]` and press `v`; (d) focus an element in another app window and
  trigger a Wireframe place change.
  **Expected:** (a) the control unmounted → `document.activeElement` is the LAST breadcrumb segment
  `[data-testid="navigation-bar-place"]` (`tabindex="-1"`, text = the new place label), NEVER `body`
  and never an out-of-app node; (b) on re-entry the SAME control (verb row) is focused when it renders
  again; (c) the canvas keeps focus (the bar never steals); (d) focus outside the app is untouched.
  `data-wireframe-place` is the new place in (a)-(c).
  - **Edge:** a place entered by pointer (breadcrumb/map) vs keyboard; the transient place auto-exit;
    reduced motion; the map dialog's own focus restore.
  - **Receipt:** E-DOM (`activeElement` tag/testid/text per step).

- [ ] **F-N31 (R-1.7) — the canvas and details fill the workspace and the status bar sits below the bar.**
  **Steps:** at 1280×800 read `getBoundingClientRect()` of the workspace row, the bar row, the canvas
  region, the details column and `[data-testid="wireframe-status-bar"]`; enumerate the workspace row's
  ELEMENT children.
  **Expected:** `wireframe-command-bar` sits BELOW the workspace row (`bar.top ≥ workspace.bottom − 1`)
  and ABOVE the status bar (`status.top ≥ bar.bottom − 1`); the workspace row's element children are
  EXACTLY two — `[data-wireframe-region="canvas"]` and `[data-wireframe-region="details"]`; NO element
  with a ~266-px-wide left command column exists; the canvas fills the remaining width
  (`canvas.width ≥ details.width × 2`); `[data-testid="wireframe-details-column"]` contains the
  property panel AND the compact `navigation-trail` (the trail is not in the bar); the bar spans the
  full editor width.
  - **Edge:** 900×600; details panel open vs. empty; both themes; the map dialog open.
  - **Receipt:** the rect table + E-SHOT of the full editor.

- [ ] **F-N32 (R-5.1) — typing then Backspace empties the details text field and focus stays on the input.**
  **Steps:** L1/L3 one **card** selected (the recipes in the #3119 harness above); focus
  `[data-testid="wireframe-card-label"]`; type `a`; read the store value + `document.activeElement` +
  the journal length; press `Backspace`; read again; read the console.
  **Expected:** after `a` the label is `a` and ONE journal entry (`Set label`) exists; after
  `Backspace` the store label is `''` (the input renders empty) and EXACTLY ONE more journal entry
  (`Set label`, patch `label: ''`) is appended — never an `invalid-args` rejection, never a revert to
  `a`; `document.activeElement` is STILL `wireframe-card-label` after both commits; console clean.
  - **Edge:** a whitespace-only value (`' '`) — free text may be blank under `allowEmpty` (record;
    never an `invalid-args` FAIL); a card with a pre-existing label cleared to `''`; the same leg on
    `wireframe-button-label` and `wireframe-input-placeholder`; reduced motion.
  - **Receipt:** E-DOM (value + `activeElement` + journal ids) + E-SHOT.

- [ ] **F-N33 (R-5.2) — focus survives two consecutive store commits in the details text field.**
  **Steps:** same focus; type `a`, then `ab`; read `document.activeElement` + the caret/selection after
  EACH keystroke commit.
  **Expected:** the input keeps focus after BOTH commits (`document.activeElement` is the same DOM
  node — never a remounted clone); the caret stays at the typed position; exactly TWO journal entries
  (one per typed character; no coalescing); console clean; no `Maximum update depth exceeded`.
  - **Edge:** type → pause → continue; a store update from another source (undo) while focused
    (record focus/caret); rapid typing; a panel re-render from an unrelated selection change.
  - **Receipt:** E-DOM (node identity + selection) + the journal entries.

- [ ] **F-N34 (R-5.3) — a printable key inside a text control never dispatches a verb (passthrough preserved).**
  **Steps:** focus `wireframe-card-label`; press the bound root strokes `c`, `e`, `a`, `s`, `v`, `f`
  one at a time; then press `Backspace`; then move focus to `wireframe-canvas` and press `f`.
  **Expected:** inside the text control every printable stroke is INSERTED into the input (or edits
  it) with `data-wireframe-place` UNCHANGED, ZERO new journal entries and zero announcements;
  `Backspace` deletes and dispatches nothing; at the canvas root `f` enters `wireframe.file` (the
  non-vacuity control — the adapter is alive, not disabled).
  - **Edge:** `Escape` in the field (shipped focus move to the canvas root, no dispatch); a
    contenteditable element; `Ctrl+Space` while typing (must not fire); a modifier chord in the field.
  - **Receipt:** E-DOM (place + value + journal length per stroke).

- [ ] **F-N35 (R-6.1 static) — one declaration-derived bar; no second key table or per-place literal verb list.**
  **Steps:** on the tested tip, strip comments + string-literal text (keep interpolations as CODE) and
  scan `apps/ui/src/shared/navigation/ui/**` + `apps/ui/src/applications/wireframe/**` (excluding
  `__tests__`) for a second per-place verb table / key map (a `PLACE_VERBS`-/`VERBS_BY_PLACE`-shaped
  literal, a hardcoded verb-id array outside `wireframeSurface.ts`, or a `key → verbId` table outside
  the declaration); read `CommandRail.tsx` and confirm it renders ONLY a `CommandRailModel`.
  **Expected:** ZERO second key table; every rendered `data-nav-verb-id` is declared in
  `wireframeSurface.ts` (compare the live row ids against the declaration); `buildCommandRailModel` is
  the ONLY derivation feeding the bar AND the map; a seeded second-table token in a scratch copy is
  found (negative control).
  - **Edge:** a per-place list inside `__tests__` (excluded); a verb-id string in a comment (stripped);
    a derived constant naming the SAME declaration (allowed).
  - **Receipt:** E-STATIC (scan scope + hit count + negative control) + the live row-id comparison.

- [ ] **F-N36 (R-6.2) — one dispatch funnel: bar, map and trail mutations all commit through `dispatch`.**
  **Steps:** run `pnpm --filter @fredo/ui test:run src/applications/wireframe/__tests__/wireframeLegacySurface`
  → `no ui handler mutates the store outside dispatch`; live: click a bar verb row (`lock`), a map
  verb row, and the trail's per-entry Undo; read the journal.
  **Expected:** the cited title is green (verbatim in the reporter); each live leg appends exactly ONE
  journal entry carrying the DECLARED `verbId` and a real effect (a mutation for `lock`; the map leg
  performs the same verb; the trail undo appends one `Undo <label>` entry) — no direct store write is
  reachable from a UI handler; the document changes accordingly.
  - **Edge:** an `aria-disabled` row (dispatch nothing, no entry); a `did-nothing` no-op (no entry); a
    failed dispatch (no entry); the same verb from the bar and the map yields the same entry shape.
  - **Receipt:** the quoted vitest summary + E-DOM (journal per leg).

- [ ] **F-N37 (R-6.3) — one element-scoped key adapter; no new `document` or `window` keydown listener.**
  **Steps:** before opening Wireframe, wrap `document.addEventListener`/`window.addEventListener` on the
  page and count `keydown` registrations; open Wireframe, drive 10 strokes, close it; compare. Read the
  Wireframe provider's handler registration (element-scoped) and count the keydown handlers on the
  shell element.
  **Expected:** the number of `document`/`window` `keydown` listeners is UNCHANGED across open/close
  (delta **0**); the shell has exactly ONE element-scoped keydown handler (the bar adds none); strokes
  resolve synchronously in the same task (the existing NFR pin); the map dialog's Escape path still
  works.
  - **Edge:** two Wireframe windows (one adapter per window); the bar's `more…` map open (Escape closes
    the map only); text-control focus (suppression); the composer open (no new listener).
  - **Receipt:** the listener counts before/after + the source read of the registration site.

- [ ] **F-N38 (R-6.4) — no cross-application import is introduced.**
  **Steps:** static scan `apps/ui/src/applications/wireframe/**`, `apps/ui/src/shared/navigation/**` and
  `apps/ui/src/shared/components/companion/**` for `from '…applications/<other>'` /
  `features/<other>` imports (strip comments + string text, keep interpolations as code).
  **Expected:** ZERO cross-application imports; shared modules only (`shared/**`); no new
  `features/<x>` path; a seeded import in a scratch copy is found (negative control).
  - **Edge:** a type-only import (still a FAIL); a re-export barrel; a path alias resolving to another
    application.
  - **Receipt:** E-STATIC (scope + hits + negative control).

- [ ] **F-N39 (R-6.5) — the bar adds no second live region; navigation still announces once on the shipped announcer.**
  **Steps:** transition through three places; read the bar subtree's `[aria-live]` count, the
  `[data-testid="hotkeys-announcer"]` text (role/`aria-live`), and confirm
  `[data-testid="navigation-announcer"]` is absent; read the shipped status bar's own live region.
  **Expected:** the bar subtree contains **0** `aria-live` nodes; each transition writes exactly ONE
  update to `hotkeys-announcer` (`role="status"`, `aria-live="polite"`) equal to the composer output
  (`navPlaceEnterMessage('Create', n)`); `navigation-announcer` absent; the shipped
  `WireframeStatusBar` live region still exists and is UNCHANGED (non-vacuity). **Do NOT assert a
  global `[aria-live].length === 1`** — the status bar is a live region too (G-424).
  - **Edge:** a failed/quiet transition (no announcement); two transitions in a row (two distinct
    messages); reduced motion; a theme switch (no announcement).
  - **Receipt:** E-DOM (the announcer text + the scoped counts per step).

- [ ] **F-N40 (R-4.1) — the three text-edit verbs are declared, published, kind-gated and default to the primary selection.**
  **Steps:** run `pnpm --filter @fredo/ui test:run src/applications/wireframe/__tests__/wireframeSurface`;
  live: select one **card**, one **text**, one **input**, then nothing; invoke
  `wireframe.element.setLabel` with NO `id` and `{value:'Reports'}` through the sanctioned scripted
  routed intent (`app_command_intent`); repeat for `setText` (text) and `setPlaceholder` (input).
  **Expected:** the unit run reports **58** declared verbs (55 → 58) and
  `wireframe.element.setLabel`/`.setText`/`.setPlaceholder` each declared in `wireframe.edit`,
  `risk:'mutating'`, `publish:true`, with a `value` arg carrying `allowEmpty:true`; availability is
  `selection.count === 1` AND the primary kind matches (card/button → `setLabel`; text → `setText`;
  input → `setPlaceholder`); with no `id` the PRIMARY selected element is patched (quote the id from
  `data-wireframe-selection-id`); each leg appends ONE journal entry
  (`Set label`/`Set text`/`Set placeholder`) and the live value changes; an empty selection is
  `unavailable` and applies nothing.
  - **Edge:** an explicit `id` overrides the primary; count 2 ⇒ unavailable; the wrong kind ⇒
    unavailable; a locked element (available, may no-op); `setField`'s generic contract unchanged.
  - **Receipt:** the vitest summary + E-DOM (declaration + availability + patched id) per leg.

- [ ] **F-N41 (R-7.1) — a companion edit is attributed to `Companion` in the trail.**
  **Steps:** one selected card; relay `wireframe.element.setLabel {value:'Reports'}` via
  `app_command_intent` (channel `agent`, `actor:'companion'`); read the newest
  `[data-testid="navigation-trail-entry"]`.
  **Expected:** `data-nav-actor="companion"`; `navigation-trail-actor` text `Companion`
  (`NAV_ACTOR_LABELS`); the entry carries the declared verb label + the dispatch-time place path; the
  card label is `Reports`; exactly ONE entry appended; a following HUMAN edit appends its own `You`
  entry (the companion entry is untouched).
  - **Edge:** a companion NAVIGATION entry (actor `Companion`, effect `navigation`); no coalescing; a
    companion no-op (no entry); the trail scrolled to the newest entry.
  - **Receipt:** E-DOM (both entries' actor/label) + E-SHOT of the trail.

- [ ] **F-N42 (R-7.2) — `journal.undo` with a `verbId` filter reverts exactly that entry and no other.**
  **Steps:** on one card: (1) companion `setLabel {value:'Reports'}`; (2) a HUMAN `toggleLock`
  (different verb); then dispatch `journal.undo {verbId:'wireframe.element.setLabel', count:'1'}`
  through the ONE funnel; read the label, the lock flag and the journal. **Multi-match leg:** on a
  fresh card add TWO matching `setLabel` entries — the older `setLabel {value:'Alpha'}` then the newer
  `setLabel {value:'Beta'}`, BOTH as companion edits (`app_command_intent`, `actor:'companion'`) — then
  `journal.undo {verbId:'wireframe.element.setLabel', count:'1'}` and read the label; then repeat the
  same `verbId`-only undo once more and read the label; then walk back with the actor-scoped undo
  `journal.undo {verbId:'wireframe.element.setLabel', actor:'companion', count:'1'}` and read the
  label.
  **Expected:** the manifest-declared undo command ACCEPTS the `verbId` arg (no `invalid-args`); on
  the single-match leg the label reverts to its pre-edit value (`''`), the lock flag is UNCHANGED,
  exactly ONE new `Undo Set label` entry is appended and the original entries remain (append-only);
  an unknown filter (`wireframe.nope`) is a `no-matches` noop (`Nothing to undo.`, nothing applied);
  a `count:'2'` with only one matching entry applies one and reports 1. **On the multi-match leg the
  undo is NEWEST-first over the append-only journal (shipped `seq DESC`), and R-7's literal "newest
  matching entry" holds:** the first `verbId`-only `count:'1'` reverts the NEWER companion edit
  (`Beta` → label `Alpha`) and leaves the OLDER `setLabel` entry intact. **That reversal is itself
  journaled under the SAME `verbId`** (`wireframe.element.setLabel`, `effect:'mutation'`, non-null
  `inverse`), so a SECOND identical `verbId`-only undo re-targets the REVERSAL — a REDO: the label
  returns to `Beta` and one more `Undo Set label` entry is appended; expect the redo (not a defect,
  and not a contradiction of R-7). To reach the OLDER original edit instead, scope the filter past
  the human-attributed reversal with `actor:'companion'` — the actor-scoped undo skips the reversal
  and reverts the older companion edit (label back to its pre-edit `''`); exactly one new
  `Undo Set label` entry per undo, the other journal entries untouched.
  - **Edge:** no matching entry; a matching NAVIGATION entry (inverse `null` → skipped); a `verbId` on
    a legacy command-surface app; the undo while the app is closed (queued `_take`); three matching
    entries with `count:'2'` reverts the two NEWEST and leaves the oldest.
  - **Receipt:** E-DOM (label + lock + the new entry) + the result event.

- [ ] **F-N43 (R-7.3) — the reversal entry is attributed to the requester.**
  **Steps:** same run as F-N42; read the reversal entry's actor; then relay the same undo through
  `app_command_intent` (a companion-channel request) and read the new reversal's actor.
  **Expected:** a user/host-requested undo appends an entry with `data-nav-actor="human"` /
  `navigation-trail-actor` `You`; a companion-channel undo REQUEST journals the reversal as `human`
  (the companion → human rule); the ORIGINAL companion entry still reads `Companion`; the
  `NOTHING_TO_UNDO` path adds no entry; a system-originated undo keeps `System`.
  - **Edge:** undo of a companion entry vs a human entry; repeated undo; the trail's per-entry Undo
    button (`host.undoEntry`) also reads `You`.
  - **Receipt:** E-DOM (each reversal's actor) + the named rule source.

- [ ] **F-N44 (R-8 live half — wireframe) — no left rail and no palette node in the running webview; the child-place rows live in the bottom bar.**
  **Steps:** open Wireframe; scan the whole document for the old left-rail root
  `[data-testid="navigation-rail"]` and for `[data-testid^="launcher-palette-"]`; read the workspace
  row's children + the leftmost column's computed width; read the bar's
  `[data-testid="navigation-rail-places"]` list and its six `navigation-rail-place-row` buttons; walk
  all six places and repeat.
  **Expected:** the legacy LEFT rail root `[data-testid="navigation-rail"]` counts **0** and no
  ~266-px left command column exists; the SIX child-place rows render INSIDE the bottom bar
  (`navigation-rail-places` / `navigation-rail-place-row`, the retained testid symbols) ABOVE the
  verb rows (non-vacuity — the rows were relocated, not deleted); the workspace has exactly the
  canvas + details children; the bar root is `[data-testid="navigation-bar"]` at the BOTTOM (F-N31);
  zero palette nodes in the document; the canvas/details/bar are all present.
  - **Edge:** each of the six places; the map open; a text control focused; light + dark; a second
    Wireframe window.
  - **Receipt:** E-DOM per place + E-SHOT.

- [ ] **F-N45 (R-1.8 / R-3 Ask re-point) — `Ask` and `app.ask` open the ONE composer with a target, never the launcher.**
  **Steps:** click `[data-testid="navigation-bar-ask"]`; then press `k` at the root; then invoke the
  `app.ask` verb through the sanctioned routed intent; read the launcher state + the composer.
  **Expected:** each leg publishes exactly ONE `requestCompanionComposerOpen` request
  (`source:'command-bar-ask'`, `appId:'wireframe'`, `focus:true`) and opens exactly ONE
  `fredo-companion-composer` with its input focused and the chip reading `for Wireframe`; the LAUNCHER
  does NOT open and no `launcher-*` palette/context node appears; `launcherBridge.ts` is not involved
  (retired).
  - **Edge:** `Ask` while the launcher is already open (no double open); `app.ask` from a no-surface
    app (no request, shipped no-op — record); `Ask` with no focused app frame (the default/no-target
    chip); activation by pointer and by `k`.
  - **Receipt:** E-DOM (composer + launcher absence) + the composer-request count.
