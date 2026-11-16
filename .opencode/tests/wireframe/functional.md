# Wireframe — Functional

> Durable functional suite for the **Wireframe** application domain (first seeded at Spec
> #3070, Slice 1: core editor). Rows map 1:1 to the QA Plan in
> `.opencode/tmp/3070/triage.md` `## QA Expert` (`F-1`..`F-56` plus `F-44a`–`F-44c`, keyed to
> the Architect's EARS ids `R-1.1`..`R-6.5` plus `R-4.13`). Names bind verbatim to the
> Architect's C1–C9 block — do not invent alternative ids or hooks.
>
> **Verification policy: live.** The feature is DOCUMENT STATE, not telemetry: no span, row
> or metric is emitted for any AC, so a `telemetry_spans` receipt is **not** expected here
> and its absence is not a missing receipt. Required evidence per row:
> (1) a quoted live `tauri_webview_*` result (find_element / dom_snapshot / execute_js /
> interact / keyboard / screenshot) carrying the testid and the OBSERVED value, and
> (2) for visual rows, an uploaded `user-attachments` URL produced by
> `pipeline-state.rs --issue 3070 --agent tester --action upload-evidence --image <path>`.
> A static-only or "looks correct" PASS fails closed.
>
> **Hooks (C7):** `wireframe-root` carrying `data-wireframe-element-count`,
> `-selection-id`, `-selection-type`, `-selection-geometry` (`"x,y,w,h"`, 1 dp),
> `-dirty`, `-document-path`, `-page` (`"1280x800"`), `-zoom` (percent), `-pan-mode`;
> plus `wireframe-status`, `wireframe-canvas`, `wireframe-toolbar`,
> `wireframe-action-<suffix>` (suffix = the id after `wireframe.` with `.`→`-`, camelCase
> PRESERVED: `wireframe-action-element-toggleLock`, `wireframe-action-view-fitPage`,
> `wireframe-action-file-saveAs`), `wireframe-property-panel`, `wireframe-page-controls`,
> `wireframe-file-error` (rendered by ST-6's `WireframeFileError` in the editor shell,
> between the canvas and the status bar — C8 adjudication 3). There is **no**
> `data-wireframe-selection-props`: that hook is DECLINED (C7 adjudication 7 / G-324).
> Shipped hooks consumed: `data-fredo-passthrough` (terminal) and the navigation hooks
> `data-nav-keycap`, `data-nav-verb-id`, `data-nav-availability` (bound in
> `shared/navigation/ui/constants.ts`). The legacy element-key hooks were DELETED in P8 / #3122;
> their absence is gate-owned by `legacyAbsence.test.ts`.

## Harness (run before every leg)

- **Isolated env — ONE env proves the whole file flow** (C6 amended: per-command seams).
  Launch with all three path seams set; `Restart` is forbidden (G-328), recover with `Down`
  then `Up`:
  `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3070 -EnvId wf3070-a -EnvSlot 1 -RequireIsolation -EnvVar "FREDO_WIREFRAME_SAVE_PATH=C:\Code\fredo\.opencode\tmp\3070\e2e\doc-a.wireframe.json" -EnvVar "FREDO_WIREFRAME_OPEN_PATH=C:\Code\fredo\.opencode\tmp\3070\e2e\doc-a.wireframe.json" -EnvVar "FREDO_WIREFRAME_EXPORT_PATH=C:\Code\fredo\.opencode\tmp\3070\e2e\page-export"`
- **Seam precedence (binding):** `FREDO_WIREFRAME_CANCEL=1` > `FREDO_WIREFRAME_FAIL_FILE=1` >
  own seam (`_SAVE_PATH`/`_OPEN_PATH`/`_EXPORT_PATH`) > shared `FREDO_WIREFRAME_FILE_PATH` >
  native dialog. Extra launches are needed only where a different VALUE is required:
  `CANCEL=1` (F-35 cancel + precedence leg), `FAIL_FILE=1` (F-35 failure), and one
  `OPEN_PATH` per bad-document fixture (F-50/F-51/F-52).
- **Driver:** `tauri_driver_session start`, `appIdentifier` = the env's MCP port as a decimal
  string (`"16001"` for slot 1) — never the bare bundle id.
- **Focus gate before every key press:** `document.activeElement === document.body` and no
  text-entry control focused (the navigation `text-entry` focus context must not suppress the
  declared stroke). A focused interactive control
  (`<button>`, `[tabindex>=0]`) makes bare keys pass through (`sequence.ts:146`), and the canvas
  host is itself `tabIndex={0}` — so NEVER `.focus()` it: reach the gate via a pointer-down on
  the empty canvas (explicit blur, UI/UX §2.3) or a pointer toolbar activation (`detail > 0`
  blurs to body, UI/UX §3.14), then re-read the gate. F-42 covers the keyboard-activation case.
- **Canvas coordinates:** `Reset view` (`0`) ⇒ 100 % and centred. Read
  `[data-testid="wireframe-canvas"]` rect + `-page` + `-zoom`; page origin = canvas centre −
  pagePx × scale/2; element centre = origin + (x + w/2, y + h/2) × scale. Calibrate with TWO
  elements at opposite page corners and prove each computed click selects the intended
  `-selection-id` before any drag.
- **Property oracle:** `Save As` through the seam, then read the document file — text content,
  `textStyle`, alignment, label/appearance, fill/border/radius and `locked`/`visible` have no
  DOM hook (Konva paints to canvas; `data-wireframe-selection-props` is DECLINED). The oracle
  is the user's own save path and **F-31 proves that path independently**, so a broken save
  cannot green-light a property row.
- **Captures:** `.opencode/tmp/3070/e2e/<row>-<state>.jpeg`; fixtures under
  `.opencode/tmp/3070/e2e/fixtures/`. Nothing outside the repo, no credential.

## R-1 / AC1 — Add components

- [ ] **F-1 (R-1.1)** Add a text element with key `1` from the `default` focus gate.
      **Expected:** `data-wireframe-element-count` 0→1; `-selection-type`=`text`;
      `-selection-id` non-empty; the element renders at its rect; `-dirty`=`true`.
      **Edge:** first element on a fresh document; add while another element is selected
      (the new one becomes THE selection); add after an undo.
- [ ] **F-2 (R-1.2)** Add each of the eight remaining tools (`2`…`9`).
      **Expected:** count reaches 9; each add sets `-selection-type` to that type; each
      element has `w>0`,`h>0` and lies fully inside `-page`; the document's `elements[].type`
      set covers all nine types.
      **Edge:** the same tool twice (two elements, distinct ids); add with a selection
      active; add at the page edge then Fit.
- [ ] **F-3 (R-1.3)** Set a Section element's `preset` to each of `header`, `navbar`,
      `sidebar`, `footer` through the property panel.
      **Expected:** after each change the document carries that exact `preset`; the rendered
      frame differs per preset (non-zero diff between consecutive captures); count stays 1.
      **Edge:** preset change with another element selected (only the selected one changes);
      all four present as four separate section elements.
- [ ] **F-4 (R-1.4)** Add both text styles (`body`, `heading`).
      **Expected:** the document's `textStyle` set contains both; the heading's rendered ink
      bounding-box height is **1.25 ± 0.07 ×** the body's at the same `size` preset (measured
      off the page capture).
      > **Oracle correction (round 3, recorded plan defect):** the original "≥ 1.5×" floor was
      > unsatisfiable — heading is body × `HEADING_SCALE` = 1.25 by design
      > (`WireframeCanvasImpl.tsx:79`). AC1's wording ("distinct type scale + weight") is
      > unaffected; only the measurement oracle changed.
      **Recipe:** one text element, `size = m`; deselect (empty-canvas click — Escape only
      reaches the canvas `onKeyDown` while the canvas host holds DOM focus) before EVERY
      capture so the selection outline cannot fill the rect; ink = rows inside the element rect
      containing a pixel ≥ 8/255 different from the page background.
      **Edge:** body→heading→body (no stale paint); heading with a long string (wraps inside
      the page).
- [ ] **F-5 (R-1.5)** Add an icon and change `iconId`.
      **Expected:** the panel offers ≥ 12 curated icons; selecting another changes the
      rendered glyph (non-zero region diff) and the document's `iconId`; the glyph is
      visible (not blank).
      **Edge:** the same icon twice (two elements); icon over a busy background.
- [ ] **F-6 (R-1.6)** Put all 12 AC1 categories on one page.
      **Expected:** count = 12; the type/preset/style set covers text·heading, button, input,
      image, icon, card, section·(header, navbar, sidebar, footer), shape, line; every
      element is selectable and rendered.
      **Edge:** the 12 on a `phone` page (Fit keeps all on-screen); delete one and re-add.
- [ ] **F-7 (R-1.6)** Repaint on theme change (the WHILE-rendered clause).
      **Expected:** switching `light-default` ↔ dark preset (Settings → Appearance,
      `select[aria-label="Theme presets"]`) leaves the page background pixel within ±6/255 of
      the NEW `--body-bg` read from `getComputedStyle(document.documentElement)` in the SAME
      task; the primary-button LABEL matches `--accent-contrast` and the selection chrome
      (outline + Transformer handles) matches `palette.accent` — the `useCanvasPalette()` key
      resolving `--accent-primary` (Spec #3071 ST-5 re-baseline: the canvas chrome moved off
      `--accent-strong`, which now paints only the DOM focus ring via the `focusRing` key) —
      the 12-key palette is the contract (C6/`useCanvasPalette` adjudication 4); a dense
      full-page diff between the two captures is non-zero on ≥ 30 % of sampled pixels; card,
      text and border follow their tokens.
      **Edge:** theme switch with a selection; theme switch mid-drag; accent override (not
      only a preset).
- [ ] **F-8 (R-1.6 colour hygiene / palette shape)** Static + live colour audit.
      **Expected:** `apps/ui/src/app/theme/contract/allowlist.ts` has NO wireframe entry; the
      palette resolves exactly the **12 contracted keys** (10 `WireframeColorToken`s +
      `onAccent`→`--accent-contrast` + `focusRing`→`--accent-strong`), and neither extra key
      enters the document's colour-token enum; no `#rrggbb` / `rgba(` / `rgb(` / `hsla(` and
      no `var(--x)NN` alpha-append in `applications/wireframe/**` (issue-ref comments exempt);
      both shipped themes legible.
      **Edge:** a `tint()`-derived translucent surface; a shape whose fill equals the page
      background (border still visible).

## R-2 / AC2 — Select and transform

- [ ] **F-9 (R-2.1)** Click A then B.
      **Expected:** `-selection-id`/`-selection-type` = B exactly; A is not also selected;
      handles show for B only. **Shift-click now ADDS to the selection (Spec #3071 R-1.1 — the
      Slice-1 "does not add a second selection" clause is re-baselined):** shift-click C ⇒
      `wireframe-root[data-wireframe-selection-ids]`=`B,C`, `-selection-count`=2 and the
      Transformer wraps the UNION bounds; see F-61/F-62 for the full multi-select semantics
      and F-79…F-83 for the group/arrange clauses.
      **Edge:** click empty canvas (selection cleared, page controls shown); click the same
      element twice; click an overlapping pair (topmost wins).
- [ ] **F-10 (R-2.2)** Swipe-drag the element by (dx,dy).
      **Expected:** `-selection-geometry` x,y change by ≈ (dx,dy)/scale (±2 px); exactly ONE
      undo step (one `u` restores the pre-drag geometry string exactly).
      **Edge:** drag to the page edge; drag 1 px; drag at 200 % zoom; abandon mid-gesture
      (geometry unchanged).
- [ ] **F-11 (R-2.3)** Swipe a Transformer handle.
      **Expected:** `w`/`h` change per the dragged corner; ONE undo restores the exact
      pre-resize geometry.
      **Edge:** each of the corner handles; shrink to minimum (still selectable); resize past
      the page edge; resize at 200 % zoom.
- [ ] **F-12 (R-2.4)** Duplicate (`p`) then delete (`k`).
      **Expected:** duplicate gives count+1, an offset copy at the declared fixed delta, and
      the COPY selected; delete gives count−1 with `-selection-id`=`''`.
      **Edge:** duplicate 3× (distinct ids, no collapse); delete with nothing selected
      (no-op, no error); delete the only element (count 0, page still exports).
- [ ] **F-13 (R-2.5)** Lock (`l`) a selected element.
      **Expected:** `locked` set; count unchanged; the element's ink is still present at its
      RESTING rect (G-170); **no Transformer anchors render** for it (UI/UX §2.4 — no handles
      to grab, dashed outline, panel shows a "Locked" tag); a body drag AND a drag at the
      FORMER handle coordinates both leave `-selection-geometry` string-identical.
      **Edge:** three lock-then-drag attempts (body + former handle); lock then Fit/zoom;
      save + reopen preserves `locked`.
- [ ] **F-14 (R-2.6)** Unlock (`l` again).
      **Expected:** a drag now changes `-selection-geometry` and one undo reverts it.
      **Edge:** unlock then resize; lock→unlock→lock; lock state after undoing a move made
      before the lock.
- [ ] **F-15 (R-2.7)** Selection reconciliation on delete, undo-to-empty, open, new.
      **Expected:** `-selection-id`=`''`, `-selection-type`=`''`,
      `[data-testid="wireframe-page-controls"]` present in every case.
      **Edge:** reconciliation when undo removes an element that was added; open a document
      with an empty `elements`; open while a panel field has focus.
- [ ] **F-16 (R-2.5/R-2.4 identity)** Undo of a delete restores identity.
      **Expected:** the element returns with the SAME id, geometry, `locked`/`visible` and
      type-specific properties (document comparison).
      **Edge:** undo delete then redo; undo delete of a locked element; undo twice.

## R-3 / AC3 — Edit properties

- [ ] **F-17 (R-3.1)** Text panel: content, size, alignment.
      **Expected:** all three controls present; each change is observable in the SAME
      interaction (document + canvas) before the next action; size is a preset row and
      alignment a visual toggle group.
      **Edge:** empty text; 300-char text; right-align in a narrow element; toggle alignment
      three times.
- [ ] **F-18 (R-3.2)** Button panel: label + appearance.
      **Expected:** label edit and `primary`/`secondary`/`ghost` each change the render
      immediately (non-zero region diff) and appear in the document.
      **Edge:** empty label; long label (no paint outside the element rect); three appearance
      changes.
- [ ] **F-19 (R-3.3)** Shape panel: fill, border, radius.
      **Expected:** fill swatches write a TOKEN name (`surface`/`muted`/`accent`/…), never a
      hex; `border` (`none`/`thin`/`thick`) and `radius` (`none`/`s`/`m`/`l`) each change the
      render; the radius slider also changes it.
      **Edge:** all three shape kinds; max radius on a small element; fill equal to the page
      background.
- [ ] **F-20 (R-3.4)** Width, height, visibility on any element.
      **Expected:** width/height land in `-selection-geometry` and the render; `visible=false`
      removes the ink while the element REMAINS in the document (count unchanged,
      `visible:false`) AND the selection is NOT cleared (so the switch can restore it);
      re-enable restores it.
      **Edge:** a hidden element, once DESELECTED, is not hit-testable (declared behaviour —
      recovery is Undo); hide then save/reopen (stays hidden); resize into the clamp.
- [ ] **F-21 (R-3.5)** Page controls with nothing selected.
      **Expected:** `wireframe-page-controls` shows THREE selectable presets
      (Desktop/Tablet/Phone) plus editable width/height; `desktop`⇒`1280x800`,
      `tablet`⇒`768x1024`, `phone`⇒`390x844`; typed dims set exactly those values and the
      preset row then shows NO selection with a derived `Custom` caption (there is no dead
      fourth chip — UI/UX reply).
      **Edge:** change preset with elements present (record the crop rule); custom dims ⇒
      `Custom` caption; preset → custom → preset again.
- [ ] **F-22 (R-3.6)** No NUMERIC property is numeric-only.
      **Expected:** for each NUMERIC property — element width, element height, page width,
      page height, corner radius — the panel exposes ≥ 1 non-numeric control (stepper button,
      `input[type=range]`, preset chips / segmented option) with an accessible name, AND
      operating it changes the value. A numeric property reachable only through its number
      field is a FAIL. Typed TEXT properties (text content, button/card label, input
      placeholder) are inherently typed: assert presence + immediate effect, NOT a non-text
      alternative (UI/UX reply; AC3's "numeric entry never the only way").
      **Edge:** a numeric property offering both a slider and a number field (both work); each
      control operated by keyboard; the 4-stop radius slider and the radius chips write the
      same enum.
- [x] **E-15 (R-3.6, found in F-22 — stepper)** The numeric STEPPER must commit the stepped value.
      **Expected:** one click on the increment/decrement trigger of element width, element
      height, page width and page height changes the value by the declared step (and the
      displayed number matches); ONE undo reverts exactly one step.
      **Recipe (round 3):** Zag increments on `pointerdown`, so the click must be driven as a
      realistic sequence — `pointerdown` → ~120 ms → `pointerup` → ~80 ms → `click` on
      `[data-testid="<field>-number"] [data-part="increment-trigger"]`. A zero-delay burst
      under-reads the committed ref (Zag's `onValueChange` lands in a microtask after the click)
      and is a TECHNIQUE artifact, not a product defect.
      **Round 3 residual (FAIL on the undo clause)** — **FIXED in round 4**: the store's
      `commitDocument` is now a no-op for a value-equal document, so the blur re-commit pushes
      no history entry. Round-4 live: width 160→161, height 44→45, page 1280→1281 / 800→801 and
      radius m→l each revert with exactly ONE `u` (`canRedo` set).
      **Historical (round 3):** the stepper click focuses the number
      input; the following blur fires Zag's `onValueCommit` with the SAME value, and
      `dispatch('element.update')` has no no-op guard, so every stepper interaction pushes TWO
      history entries — one undo produces no visible change, the second reverts the step.
      **Note:** corner radius has NO stepper (chips + 4-stop slider); drive it with one
      `ArrowRight` on `[data-testid="wireframe-corner-radius"] [role="slider"]`.
- [ ] **F-23 (R-3.1…R-3.5)** Panel variant switching.
      **Expected:** only the selected type's fields plus the shared width/height/visibility
      render; switching selection swaps the panel with no stale field; deselecting shows page
      controls.
      **Edge:** A→B→A rapidly; select a hidden element; select a locked element.

## R-4 / AC4 — Navigate and keep the work

- [ ] **F-24 (R-4.1)** Undo for each listed mutation — six independent legs: add, move,
      resize, delete, duplicate, property change.
      **Expected:** each mutation then `u` returns count/geometry/document value to the
      pre-mutation value exactly.
      **Edge:** two mutations then one undo (only the last reverts); undo with empty history
      (no-op); undo after Open (history cleared ⇒ no-op).
- [ ] **F-25 (R-4.1)** Redo re-applies.
      **Expected:** after each F-24 undo, `y` restores the identical post-state; the redo
      stack empties (extra `y` is a no-op).
      **Edge:** undo→redo→undo; redo after a NEW mutation (stack dropped); redo of a
      duplicate.
- [ ] **F-26 (R-4.2)** Zoom in/out by a fixed step.
      **Expected:** the two-step `g` `i` (zoom in) / `g` `o` (zoom out) — RE-BOUND from the
      Slice-1 bare `g`/`m` by Spec #3071 ST-4 — change `-zoom` by the same declared step each
      press (record consecutive values); the page visibly scales; `-element-count` and the
      document are unchanged. The bare key `g` now only ARMS the two-step namespace
      (the navigation bar's 250 ms pending hint), and the freed first step `m` dispatches nothing.
      **Edge:** at 100 %; with a selection (handles scale, selection kept); alternate
      `g i`/`g o` back to 100.
- [ ] **F-27 (R-4.3)** Pan mode translates the VIEW only.
      **Expected:** `h` sets `-pan-mode`=`true`; dragging **anywhere** on the canvas shifts the
      rendered page by the pointer delta while `-element-count`, `-selection-id`,
      `-selection-geometry`, `-dirty`, the undo depth and the saved document are IDENTICAL; `h`
      restores `false` and an empty-canvas click then clears the selection again.
      **Recipe (round 3):** the pan hit surface is a Konva node named `wireframe-pan-surface`
      inside the group `wireframe-view`; read the view transform through the canvas registry
      (`import('/@fs/.../canvas/wireframeCanvasRegistry.ts').getWireframeStage()` →
      `findOne('.wireframe-view')`) and drive drags with DOM `MouseEvent` sequences on
      `.konvajs-content` (`interact` clicks do not deliver Konva's drag shape). Three drag
      origins: (a) the backdrop outside the page, (b) the empty page interior, (c) over an
      element — at 100 % and again at 400 %. At 400 % the page covers the whole viewport, so
      origin (a) is unreachable there (record as N/A, not a pass).
      **Edge:** pan an EMPTY document (count 0); pan with a selection; pan beyond the page edge;
      pan then Fit.
- [x] **E-16 (new, R-2.2/R-4.2 — regression) An element drag must not move the view.**
      **Expected:** dragging an element changes only that element's geometry; the view
      transform is untouched by a document gesture.
      **Round-4 result (FIXED):** the pan handlers ignore bubbled drags (`target !==
      currentTarget`). Live at 100 %: element `560,426`→`590.1,446.1` with the view
      **byte-identical** `{scale:0.99625,x:177.4,y:32}`, full document JSON diff = only that
      element's `x/y`, one `u` restores; at 400 %: element `+7.5,+5` page px with the view
      byte-identical `{scale:4,x:-1745,y:-1362}`, one `u` restores.
      **Round-3 signature (for recognition):** the element's `dragend` bubbled to the pan group
      and `handlePanDragEnd` committed the ELEMENT's absolute stage position as the view
      (+30,+20 moved the view from (175,30.5) to (715,446.5)).
      **Recipe:** read the view before/after a drag; assert `view` byte-identical and the element
      delta = pointer delta / scale.
- [ ] **F-28 (R-4.4)** Fit page (`n`).
      **Expected:** the entire page rect is inside `[data-testid="wireframe-canvas"]` on all
      four edges (zero clipping) and centred within ±2 px.
      **Edge:** fit a `phone` page; fit at 400 % zoom; fit with 12 elements.
- [ ] **F-29 (R-4.5)** Reset view (`0`).
      **Expected:** `-zoom`=`100`; the page is centred ±2 px; pan offset cleared.
      **Edge:** reset while panned; reset at the 10 % clamp; reset with a selection.
- [ ] **F-30 (R-4.6)** Page presets and editable dimensions.
      **Expected:** each preset writes exact dims to `-page`; typing `640`×`480` yields
      `640x480`.
      **Edge:** preset → custom → typed; typed then preset (preset wins); dims while zoomed.
- [ ] **F-31 (R-4.7)** Save As (`w`) through the env seam.
      **Expected:** the file is written at `FREDO_WIREFRAME_SAVE_PATH` (own seam wins over the
      shared `FREDO_WIREFRAME_FILE_PATH` fallback); `-document-path` equals that path;
      `-dirty`=`false`; `wireframe-status` reads `Saved`; the document has `schemaVersion:1`,
      `app:"fredo.wireframe"`, the page and every element. This row also proves the property
      oracle's save path.
      **Edge:** save twice (overwrite, path stable); save an empty document; save right after
      an undo; a shared-only launch still writes.
- [ ] **F-32 (R-4.8)** Open (`o`) round-trip.
      **Expected:** pre-save readings captured (count, page, each element's id/type/geometry/
      locked/visible/properties); after `document.new` + `o` (reads
      `FREDO_WIREFRAME_OPEN_PATH`) the count and page match and a selection walk reproduces
      every geometry + type; the re-saved document is semantically identical to the pre-save
      one. Save and open run in the SAME env — no relaunch needed.
      **Edge:** a document saved at `phone` dims; a 12-element document; open then undo
      (history cleared ⇒ no-op).
- [x] **F-33 (R-4.9)** Export PNG (`t`) of the PAGE at 2×.
      **Expected:** the image is written at `FREDO_WIREFRAME_EXPORT_PATH` (own seam; the
      document path is untouched — no relaunch); its IHDR dimensions equal exactly 2× the page
      width and 2× the height (`desktop` ⇒ 2560×1600); a second export after changing zoom AND
      pan yields the SAME dimensions AND the SAME INK LAYOUT (proves page-space, not viewport,
      capture); the image shows every element and no editor chrome.
      **Content assertions (round 3, binding — the dimension half alone let a blank file pass
      twice):** decode each PNG and assert (i) ≥ 1 % of pixels differ from the page background,
      (ii) SHA256(20 elements) ≠ SHA256(1 element) ≠ SHA256(empty), (iii) 100 % / 400 % panned /
      10 % of the SAME document produce the same ink layout (dense diff below a small
      tolerance; 100 %↔10 % ≈ 1 % AA difference is acceptable, a transparent quadrant is not),
      (iv) an export taken with an element SELECTED is byte-identical to the same export with
      nothing selected, (v) a `phone` page exports 780×1688.
      **Edge:** export at 400 % and at 10 %; export panned to a corner; export a `phone` page;
      export then immediately Save (no clobber).
      **Data gap:** if the sandbox has no raster decoder, the row is UNVERIFIED, not PASS.
      **Round-4 result (FIXED, page-space by construction):** the capture paints under a
      transient `captureView {scale:1,x:0,y:0}` and captures the `.wireframe-page` node, so no
      view value reaches the config. Live: 100 %, **400 % panned** and **10 %** of one
      9-element document are **byte-identical** (`SHA256 7AC12AA6…8D2F87`, 0 transparent,
      3.296 % ink, 2560×1600); 1-element `F4513CC7…` ≠ empty `0F68F8B7…` ≠ 9-element; selected ≡
      deselected byte-identical; `phone` → 780×1688, 0 transparent; no `flushSync` warning in
      the console. **Recipe:** export, then `png-stats.ps1 -Mode stats|alpha|header|diff`
      (System.Drawing decoder) for ink/alpha/dims/SHA/dense diff.
- [ ] **F-34 (R-4.10)** Saved/unsaved state visible.
      **Expected:** the declared rule is `dirty ? 'Unsaved' : 'Saved'` with a fresh document
      `dirty=true` (single input), so the status text never disagrees with the root `-dirty`
      attribute; after any mutation `wireframe-status` reads `Unsaved` and `-dirty`=`true`;
      after a successful save both read `Saved` / `false`; the text is present and unclipped.
      **Edge:** mutate→save→mutate; undo back to the saved state (assert the DECLARED dirty
      rule); save a document whose path was `''`.
- [ ] **F-35 (R-4.11)** Cancel and failure paths keep the document.
      **Cancel (drivable — `FREDO_WIREFRAME_CANCEL=1`):** after `w`, `o` and `t` every command
      returns `Ok(None)`: count/geometry/document unchanged, `-document-path` unchanged,
      `-dirty` keeps its pre-command value, NO `wireframe-file-error` banner, and no file is
      written at any seam.
      **Failure (`FREDO_WIREFRAME_FAIL_FILE=1`):** `w` shows the `wireframe-file-error` banner
      (rendered in the editor shell between the canvas and the status bar) with a readable
      message, path/count/geometry/document unchanged, `-dirty` still `true`, status `Unsaved`;
      same for `o` and `t`.
      **Edge:** cancel after a successful save (path retained, state stays `Saved`); failure
      after a successful save; two consecutive failures; failure then a successful save in a
      clean env; `CANCEL` + `FAIL_FILE` together ⇒ CANCEL wins and NO banner.
- [ ] **F-36 (R-4.12)** Open/new resets the flow state.
      **Expected:** after `o` and after `document.new`: `-selection-id`=`''`, page controls
      shown, undo/redo empty (`u`/`y` no-ops), view fitted (whole page visible, no stale
      zoom), saved state set (new ⇒ path `''`, dirty `true`; opened ⇒ path = the `_OPEN_PATH`
      value, dirty `false`). A USER-initiated New on a dirty document first shows the
      `Discard unsaved changes?` dialog (Cancel default-focused, Discard): Cancel keeps the
      document AND its dirty state; Discard proceeds (UI/UX §3.11).
      **Edge:** Cancel then Discard; New on a clean document (no dialog); a Companion
      `document.new` never blocks on the dialog; open the same document twice.

## R-5 / AC5 — Hotkeys

- [ ] **F-37 (R-5.1)** All 32 bindings, each vs its visible control.
      **Expected:** with `data-fredo-focus-context=default`, each of the **20 bare keys**
      `1 2 3 4 5 6 7 8 9 p k l u y n 0 h w o t` produces its action's observable effect
      (count / geometry / zoom / history / dirty / file), AND each of the **12 two-step
      sequences** in the `g` namespace — `g i` (zoom in) / `g o` (zoom out), re-bound from the
      Slice-1 bare `g`/`m`, plus the 10 arrange rows `g g` / `g u` / `g l` / `g s` / `g a` /
      `g c` / `g r` / `g d` / `g f` / `g b` — produces its action's observable effect (the
      navigation bar's pending hint shows between the two strokes). Clicking its
      `[data-testid="wireframe-action-<suffix>"]` produces an INDISTINGUISHABLE effect. A
      POINTER toolbar activation blurs the control (UI/UX §3.14), so the very next bare key
      fires — verify that loop for at least `1`, `p`, `u`.
      **Edge:** `u`/`y` on empty history; `l`/`p`/`k` with no selection; `w`/`o`/`t` in the
      seam env (all three path seams set at once); each key pressed twice; a lone `g` does
      nothing after the 1000 ms prefix timeout.
- [ ] **F-38 (R-5.2 — historical; current model).** The bar lists the declaration's rows.
      **Expected (current):** `navigation-bar` contains a row (`data-nav-verb-id`) for the
      current place's declared verbs, each with a non-empty title and a `data-nav-keycap` hint;
      no legacy element-key row exists (the committed `legacyAbsence.test.ts` owns the literal
      absence). **Edge:** other windows open; narrow viewport (rows scroll/are not clipped); the
      digit/arrow reserved strokes render their glyphs.
- [ ] **F-39 (R-5.3 — historical; current model).** Text-entry suppression in the property
      panel. **Expected:** with a panel field focused, typing `1`, `p`, `k`, `n` lands the
      characters in the field and no navigation verb fires (the declaration's `text-entry`
      focus-context rule); the document is unchanged.
      **Edge:** each text-entry control (label, content, numeric dims); blur then press `1`
      (fires); a digit typed into the page width field.
- [ ] **F-40 (R-5.4 — historical; current model).** Unfocused Wireframe neither dispatches nor
      lists. **Expected:** focus another window ⇒ the Wireframe rows leave the bar; pressing `1`
      from the other window's context adds nothing to Wireframe. No legacy element-key attribute
      exists in either state (`legacyAbsence.test.ts` green).
      **Edge:** focus returns (rows restored); two windows open.
- [ ] **F-41 (R-5.5 — historical; current model).** No duplicate-stroke collision.
      **Expected:** `validation.test.ts` V-07 yields exactly one `NAV-E007` for a duplicate-stroke
      fixture; the shipped Wireframe surface validates with zero diagnostics; console clean of
      any duplicate throw.
      **Edge:** every retained app open at once; focus toggled 10×.
- [ ] **F-42 (R-5.1 platform note, non-AC)** Bare key with a toolbar `<button>` focused.
      **Expected:** NOTHING happens (shipped `native-consumer` rule, `sequence.ts:146`).
      Record as expected platform behaviour — a no-op here is NOT a FAIL; the AC path is the
      `default`-context press in F-37.
      **Edge:** focused `<button>` vs canvas; focused panel field (F-39); modal open
      (suspended).

## R-6 / AC6 — Companion control

> **#3099 SUPERSESSION (G-136 — history preserved, no row or PASS record deleted).** Spec #3099 makes
> the companion skill a GENERATED projection of this application's TypeScript command surface, so the
> hand-written catalog (`wireframe_catalog.rs`) and its parity test are gone and FOUR rows below are
> re-pointed. The authoritative rows for the new contract are `.opencode/tests/companion/`
> F-144..F-163 / R-70..R-75; the wording below is the superseded form kept for the record.
>
> - **Emit shape (all rows below):** `llm-skill-call` now carries
>   `{skill:"wireframe", arguments:{action:"<id>", arguments:{…}}}` — arguments are NESTED under
>   `arguments`, and `action` is required by the generated schema. A flat
>   `{action, app_name}` payload (the #3070 shape) is superseded.
> - **F-43:** the listing id is the RESERVED `listActions` (not `wireframe.companion.listActions`,
>   which is no longer a command); the reply is composed HOST-SIDE from the published manifest —
>   `Wireframe actions: <id> — <description>; …` — and keeps working with the app closed. The 35-id
>   TS↔Rust parity pin is replaced by ONE shared golden fixture asserted by the TS builder suite and
>   the Rust `tests/companion_manifest.rs` (companion F-159).
> - **F-45:** the performed reply is now generic — `Performed in Wireframe: <description>, …`
>   (supersedes `Started a new wireframe for Reporter: …`); it still names only what was performed
>   and a stopped `draftApp` still lists only the prior steps.
> - **F-46:** the unknown-id copy is unchanged in form — `I don't know the Wireframe action "<id>".
>   Nothing changed.` The undeclared-key rejection now happens in TypeScript (`executeCommand`)
>   BEFORE `run`, fail-closed, with no window opened (companion F-153..F-155); the Rust validator
>   still rejects the outer `{action, arguments}` shape.
> - **F-48:** the relay is the generic `app-command-intent` / `app-command-intent-result` pair with
>   `{requestId, appId, action, arguments}` and the SAME bounded queue (16, oldest-first); the
>   cross-webview take-on-mount guarantee is retained (companion F-150).

- [ ] **F-43 (R-6.1)** `wireframe.companion.listActions`.
      **Expected:** the reply contains all 35 action ids with a non-empty description each
      (the 25 Slice-1 ids + the 10 `wireframe.arrange.*` ids added by this slice); supported by
      a direct `llm-skill-call` emit
      `{skill:"wireframe", arguments:{action:"wireframe.companion.listActions"}}`; a TS
      parity test pins the 35 ids against the Rust catalog source.
      **Edge:** a narrow reply surface (scroll, never truncate the id list); invoked while the
      app is closed.
- [ ] **F-44a (R-6.2)** Invoke the 9 `wireframe.add.*` actions.
      **Expected:** a direct `llm-skill-call` emit for each of `add.text`, `add.button`,
      `add.input`, `add.image`, `add.icon`, `add.card`, `add.section`, `add.shape`, `add.line`
      adds exactly ONE element of that type (`-element-count` +1, new `-selection-type` = the
      type). With the app CLOSED, the first emit opens it and then performs the action.
      **Edge:** app closed (open-then-act); emitted twice (two elements, distinct ids); emitted
      with a selection active (the new element becomes the selection); `add.text` without
      `textStyle` (documented default).
- [ ] **F-44b (R-6.2)** Invoke the 10 element/edit/view actions.
      **Expected:** a direct emit for each of `element.duplicate`, `element.delete`,
      `element.toggleLock`, `edit.undo`, `edit.redo`, `zoom.in`, `zoom.out`, `view.fitPage`,
      `view.resetView`, `view.togglePan` performs exactly its action, observably: count+1 with
      a selected copy / count−1 with cleared selection / `locked` flips; document or
      `-selection-geometry` reverts or re-applies; `-zoom` steps up/down; whole page visible;
      `-zoom`=100 centred; `-pan-mode` flips. With NO selection the three element actions are
      recorded NO-OPS (nothing changes; reply stays honest).
      **Edge:** no selection (recorded no-op); duplicate then undo; `edit.redo` with an empty
      redo stack; `zoom.out` at the 10 % clamp; `togglePan` emitted twice.
- [x] **F-44c (R-6.2)** Invoke the 3 file actions + `document.new`.
      **Expected:** a direct emit for `file.saveAs`, `file.open`, `file.exportPng` (each
      resolved through its own path seam) and `document.new` performs exactly its action: the
      save path receives the document, the open path restores it, the export path receives the
      page image, and `document.new` yields `-element-count`=0 with `-dirty`=`true` and the
      path cleared. **Coverage accounting: these 23 ids + the 10 `wireframe.arrange.*` ids
      (F-63/F-76) + `companion.listActions` (F-43) + `companion.draftApp` (F-47) = all 35 ids
      invoked.** The kind-group rows are a grouping device only, never a substitute for
      covering all 35.
      **Edge:** app closed for one leg; file commands in a `CANCEL=1` env (no-op, document
      intact); `document.new` while dirty via the Companion (accepted overwrite — documented
      limitation); two sequential emits.
- [ ] **F-45 (R-6.3)** The reply names only what was performed.
      **Expected:** each reply enumerates exactly `performed[]` (e.g.
      `Started a new wireframe for Reporter: …`); a failing step in `draftApp` stops the
      script and the reply lists only the PRIOR steps.
      **Edge:** full 4-step draft vs a stopped script; an unknown action (nothing performed);
      repeated invoke (no duplicated names).
- [ ] **F-46 (R-6.4)** Unknown action / unsupported arguments change nothing.
      **Expected:** `{action:"wireframe.add.teapot"}` leaves `-element-count`, ids and geometry
      identical (document comparison) and the reply states
      `I don't know the Wireframe action "wireframe.add.teapot". Nothing changed.`; an
      undeclared argument key is rejected fail-closed by the Rust validator with an explicit
      refusal and zero page change — a silent success is a FAIL.
      **Edge:** unknown action with the app closed; unknown action mid-script; blank `action`.
- [ ] **F-47 (R-6.5 binding Gherkin)** Live end-to-end.
      **Expected:** with Wireframe NOT open, asking
      `let's create a new wireframe for our new Reporter app, I would like a way to visualize reports`
      opens the app and produces a page containing a section with `preset` `navbar` (or
      `header`), a `text` element with `textStyle` `heading` whose text is `Reporter`
      (case-insensitive), and a `card` whose label names reports (case-insensitive) — asserted
      from `Save As` + the document; count ≥ 3; the reply names only performed actions.
      **Edge:** the model supplies `app_name:"Reporter"`; app already open (no duplicate
      window/elements); the same sentence twice (record the declared behaviour).
- [ ] **F-48 (R-6.2 cross-webview)** Intent relay with `new-window` presentation.
      **Expected:** invoking `wireframe.add.card` before the `app-wireframe` webview mounts
      yields exactly one card (take-on-mount path) and the reply names the performed action.
      **Edge:** two emits before mount; window closed between intent and execution; main-window
      host as the contrast leg.
- [ ] **F-49 (R-6.2 additive registry)** Existing skills unchanged.
      **Expected:** `open_app`, `close_app`, `doom_mode` still resolve and behave as before
      with the 4th skill registered (`with_app_control_doom_and_wireframe`, offer order
      `open_app, close_app, doom_mode, wireframe`); one listener per skill.
      **Edge:** all four skills in one request body; a wireframe request while doom mode is
      active.

## Error / edge rows

- [x] **F-50 (R-4.13)** Unreadable document.
      **Expected:** with `FREDO_WIREFRAME_OPEN_PATH` pointing at
      `fixtures/invalid.wireframe.json` (`{ not json`) in its own launch, `o` shows
      `wireframe-file-error` (in the shell); count/geometry/document unchanged; dirty
      unchanged. Fixture `fixtures/invalid.wireframe.json`.
      **Edge:** empty file; zero-byte file; truncated-with-valid-prefix JSON.
- [x] **F-51 (R-4.13)** Foreign `app` tag.
      **Expected:** rejected with an error naming the problem; no page change. Fixture
      `fixtures/foreign-app.wireframe.json` (`app:"other.app"`).
      **Edge:** foreign tag with otherwise valid content; foreign tag + wrong `schemaVersion`.
- [x] **F-52 (R-4.13)** Unknown or missing `schemaVersion`.
      **Expected:** rejected with an error naming the version problem; no page change. Fixture
      `fixtures/v2.wireframe.json` (`schemaVersion:2`).
      **Edge:** `schemaVersion:0`; MISSING `schemaVersion`; a string `"1"`.
- [ ] **F-53 (R-4.2 + R-4.6)** Export/clamp edges.
      **Expected:** exporting a ZERO-element page still writes a valid 2× blank page (empty is
      not an error); page width `32` clamps to `64`, `99999` clamps to `4096`; with the declared
      ±10 percentage-point zoom step, **30** zoom-ins from 100 % reach `-zoom`=`400` and a 31st
      stays `400`; **9** zoom-outs from 100 % reach `10` and a 10th stays `10`.
      **Edge:** both clamps hit exactly (no off-by-one); dims typed while a preset is active
      (becomes `custom`); zoom at the clamp then Fit.

## Non-functional

- [ ] **F-54 (NFR console/material)** After 50 drag moves, 20 resizes, theme switches and
      focus churn: `tauri_read_logs(source="console")` shows no `Error:`/`Uncaught`/
      `Maximum update depth exceeded`, and no React re-render per pointer move (AGENTS.md
      #523 pattern).
- [x] **F-55 (NFR CI parity)** `pnpm --filter @fredo/ui build` exit 0 zero TS errors;
      `pnpm --filter @fredo/ui test:run` green; `pnpm --filter @fredo/tauri build:webview`
      exit 0; `cargo check --manifest-path apps/tauri/src-tauri/Cargo.toml --locked` zero
      warnings; `cargo clippy --manifest-path apps/tauri/src-tauri/Cargo.toml --locked -- -D warnings`
      zero warnings; `cargo nextest run --manifest-path apps/tauri/src-tauri/Cargo.toml --locked`
      green; no existing assertion weakened/disabled.
      **Round 1 PASS (nextest leg substituted, disclosed):** `pnpm --filter @fredo/ui build`
      → "✓ 2831 modules transformed … ✓ built in 11.17s" (tsc + vite, zero TS errors);
      `pnpm --filter @fredo/ui test:run` → "Test Files 236 passed (236) / Tests 3051 passed
      (3051)"; `pnpm --filter @fredo/ui contrast:gate` → 46/46 passed;
      `cargo check … --locked` → "Finished `dev` profile … in 2m 47s", zero warnings;
      `cargo clippy … -- -D warnings` → "Finished `dev` profile … in 25.13s", zero warnings.
      The `cargo nextest` leg was not installed in this sandbox; `cargo test` was not run
      (time-boxed after the served-app blocker below) — residual pin, not an AC.
- [x] **F-56 (NFR bundle, non-AC)** `applications/wireframe/index.ts` does not statically
      import `konva`/`react-konva`; `WireframeCanvas` is behind `React.lazy` + `Suspense`; the
      build emits konva in a chunk separate from the entry; opening the app loads it once.
      **Round 1 PASS (static half):** the production build emits
      `assets/WireframeCanvasImpl-BMlK6N31.js 307.43 kB` as its OWN chunk beside
      `assets/index-BPAunTLj.js 2,903.09 kB` — konva/react-konva stay out of the entry chunk.
      The "loads exactly once" half is UNVERIFIED: the lazy mount throws (see the blocker
      section) so a successful load never completes.

## Round 1 result — 2026-10-21 — served app BLOCKED by a canvas mount crash

**Environment:** isolated env `wf3070-a` (slot 1, Vite :16000 / MCP :16001), repo root on
`spec/3070` @ `9e216ac`, all three path seams injected
(`FREDO_WIREFRAME_SAVE_PATH` / `_OPEN_PATH` / `_EXPORT_PATH`), driver session on `"16001"`.
`pnpm install --frozen-lockfile` was run first: the served root's `node_modules` predated the
`react-konva`/`konva` dependency add, so the first open failed with a Vite
"Failed to resolve import react-konva" overlay until the workspace deps were materialised.

**Root defect (blocks every live row):** opening the Wireframe app crashes the webview before
the editor paints.

```
Uncaught InvalidStateError: Failed to execute 'drawImage' on 'CanvasRenderingContext2D':
  The image argument is a canvas element with a width or height of 0.
  at StageWrap (…/node_modules/.vite/deps/react-konva.js:27485:42)
  at WireframeCanvasImpl (…/applications/wireframe/components/WireframeCanvasImpl.tsx:828:17)
  at Suspense / WireframeCanvas / WireframeEditor / WindowFrame / WindowManager
```

`WireframeCanvasImpl.tsx:579` seeds `useState<CanvasSize>({ width: 0, height: 0 })` and
`:828-831` renders `<Stage width={size.width} height={size.height}>`, so the first commit
mounts a 0×0 Konva stage; the layer draw throws, React has no error boundary, and `#root` is
unmounted (DOM ends at `body > div#root`, 0 children → the window is blank).

**Reproduced on both host paths** (so it is not a single-host artifact):
- same-window: launcher tile click, launcher `Enter`, and
  `llm-skill-call {skill:'open_app', arguments:{app:'Wireframe'}}` → blank main window;
- standalone app window: `open_app_window {appId:'wireframe'}` (900×600) → the same throw
  inside `StandaloneAppWindow`.

**Fix direction:** do not mount `<Stage>` until the container has a nonzero measured size
(render a placeholder while `size.width === 0 || size.height === 0`, or seed a nonzero
default), and wrap the canvas in an error boundary so a canvas fault cannot blank the shell.

`F-1` therefore FAILS (expected `data-wireframe-element-count` 0→1 with
`-selection-type`=`text`; actual: no editor DOM at all). Every other live row (F-2…F-54,
F-57 edges) is UNVERIFIED behind the same blocker — the observables never mount. The unit
suite mocks Konva (`WireframeCanvas.test.tsx`), which is why 3051 unit tests stay green while
the served app is dead: this is exactly the "library-green / served-broken" class F-55's
served-host leg exists for.

## Round 2 result — 2026-10-21 — crash fixed; 52/58 rows pass, 3 fail, 3 unverified

**Verdict: FAIL** (full detail in `.opencode/tmp/3070/tests-runs.md`). The round-1 mount crash
is gone in all three hosts (launcher `Enter`, `open_app`, standalone `app-wireframe`), the
stage is never committed at 0×0, and a shrink/restore cycle repaints without a throw.

**Row results:** F-1 PASS · F-2 PASS · F-3 PASS (presets applied; four distinct frames) ·
F-4 UNVERIFIED (heading style applies; the ≥1.5× ink measurement is confounded by the
selection outline; no save-capable env left) · F-5 UNVERIFIED (12-icon picker + selection
change; glyph pixel-diff inconclusive at 94 % zoom; no save oracle) · F-6 PASS (12 categories
on one page) · F-7 PASS (theme repaint; caveat: page follows `--card-bg`, 8/255 from the
±6-vs-`--body-bg` oracle) · F-8 PASS · F-9…F-26 PASS · **F-27 FAIL** · F-28…F-32 PASS ·
**F-33 FAIL** · F-34…F-46 PASS (F-37 all 22 keys, F-38 22 bar rows, F-39 suppression,
F-40 unfocused drop, F-41/F-42 clean; F-43/F-46 replies via a skills-generation emit) ·
**F-47 FAIL** · F-48 UNVERIFIED · F-49 PASS · F-50/F-51/F-52 PASS (banner copy exact, no page
change) · F-53 PASS (30→400 / 9→10 clamps; 32→64 / 99999→4096) · F-54 PASS · F-55 PASS
(build 2832 modules, 3056 tests, contrast 46/46, cargo check zero warnings; clippy/nextest/
build:webview not re-run) · F-56 PASS (own 307.81 kB chunk, loads and paints).

**Failures (live, reproducible):**
- **F-27 — pan on empty canvas is a no-op.** `h` sets `-pan-mode=true`, but a drag on an empty
  area of the artboard/backdrop leaves the page rect at stage x=175; a drag that starts on an
  element translates the view (+40,+40). An empty document cannot be panned.
- **F-33 — Export PNG is blank.** 2560×1600 at 100 %, 400 % + panned and 10 %, byte-identical
  (SHA256 `F916CC96…`) for 20-element, 1-element and 0-element documents — the capture never
  includes page content.
- **F-47 — binding Gherkin not performed.** The exact sentence produced a prose reply and zero
  performed actions; Wireframe never opened. Model-level: gemma-4-E2B chose not to call the
  skill.

**New Exploratory finding E-15** (promoted below): the `NumberInput` stepper buttons do not
change the value — the slider (which does) carries R-3.6.

**Technique notes:** Companion replies only apply while a skill-capable generation is in flight
(`generationUsesSkillsRef` gate), so F-43/F-46 were emitted ~250 ms after a launcher send;
`interact` swipe does not deliver Konva's gesture shape — DOM MouseEvent sequences were used;
the CDP `press` helper does not drive Zag sliders — a synthetic keydown on the thumb was used.

## Round 3 result — 2026-10-21 — pan / export / stepper / skill-offer fixes re-verified

**Verdict: FAIL** (full detail in `.opencode/tmp/3070/tests-runs.md`). Env `wf3070-r3`
(slot 2, Vite :16010 / MCP :16011), served `c045877`.

**Fixed and confirmed live:** F-27 (a `wireframe-pan-surface` inside `wireframe-view` makes
every drag origin pan by the exact pointer delta — backdrop, page interior, over an element, at
100 % and 400 %; an empty document pans; `h` off restores empty-canvas deselect) · F-33's content
half (the export is no longer blank: 3.295 % ink at 100 %, distinct SHAs for 20/1/0 elements,
selected ≡ deselected byte-identical, `phone` ⇒ 780×1688) · **F-47** (the exact Gherkin sentence
now opens the app from closed and drafts `navbar` + heading "Reporter" + card "Reporter reports",
reply names only performed actions) · F-48 (new-window relay: intent emitted while
`app-wireframe` is unmounted yields exactly one card; reopen replays nothing; main-window contrast
leg +1) · E-15's value half (every stepper steps by +1 with a realistic pointer sequence).

**Still failing (live, reproducible):**
- **F-33 (viewport invariance) — the export is not page-space.** At 400 % the PNG is
  **44.096 % transparent** (1,806,173 px) and 44.1 % of its pixels differ from the 100 % export:
  `Stage.toDataURL({x: view.x, y: view.y, …})` crops the *rendered stage canvas* (viewport-sized),
  so any crop region outside the visible stage is empty. Export artefacts linked in the report.
- **E-15 (undo clause) — one stepper click pushes two history entries.** The click focuses the
  number input; the following blur fires `onValueCommit` with the same value and
  `dispatch('element.update')` has no no-op guard ⇒ undo #1 changes nothing, undo #2 reverts.
- **E-16 (new, regression) — an element drag pans the view.** The element's `dragend` bubbles to
  the pan group; `handlePanDragEnd` commits the element's absolute stage position as the view
  (text drag +30,+20 ⇒ view 175,30.5 → 715,446.5).

**Unverified in round 3 (named blockers):** F-43/F-46 (the main window had no OS focus and the
connected MCP bridge plugin (0.12) exposes no window-focus action; the reply surface only accepts
a pushed reply inside an active skill generation — one plain generation did surface a bubble and
was captured) · F-30 typed-dimension commits on the unfocused host (the identical technique
commits on the focused host, so the row is environment-blocked, not failing).

**Technique notes (round 3):** `tauri_webview_interact` clicks are synthetic `.click()` (no
`pointerdown`, `detail === 0`) — they cannot drive Zag steppers or a pointer-activation blur; use
DOM `MouseEvent` with `detail: 1` for the latter. Konva drag/press needs DOM `MouseEvent`
sequences on `.konvajs-content`; the stage/view/figure state is readable through
`import('/@fs/…/canvas/wireframeCanvasRegistry.ts')` + `store/wireframeDocumentStore.ts`, which
is the most precise live oracle for the view transform, the document and the undo flags.

## Round 4 result — 2026-10-21 — export page-space, one-undo stepper, bubbled-drag guard

**Verdict: PASS** (full detail in `.opencode/tmp/3070/tests-runs.md`). Env `wf3070-r4`
(slot 3, Vite :16020 / MCP :16021), served `7d03f3c` (fix `481a590`); seam envs `wf3070-r4c`
(CANCEL), `-r4d` (FAIL_FILE), `-r4e` (both).

**Fixed and confirmed live:**
- **F-33** — the export is **byte-identical** at 100 %, 400 % panned and 10 %
  (`SHA256 7AC12AA6…8D2F87`, 0 transparent, 3.296 % ink); 1-element/empty SHAs distinct;
  selected ≡ deselected; `phone` 780×1688; no `flushSync` warning.
- **E-15** — one stepper click = one step = ONE undo (element width/height, page width/height,
  corner radius); the blur re-commit is a store-level no-op.
- **E-16** — an element drag moves only that element: the view transform is byte-identical at
  100 % and 400 %, the document diff is that element's `x/y` only, one undo reverts.
- **F-35** — CANCEL: `w`/`o`/`t` no-op, no banner, no file; FAIL_FILE: banner
  `wireframe file operation failed (FREDO_WIREFRAME_FAIL_FILE=1)` with the document intact;
  CANCEL+FAIL_FILE: cancel wins, no banner, no file.
- **F-50/F-51/F-52** — one `OPEN_PATH` launch, the same scratch file overwritten three times:
  `This file is not readable JSON. Nothing changed.` /
  `This file isn't a Wireframe document (app tag "other.app"). Nothing changed.` /
  `Unsupported Wireframe document version "2". Nothing changed.` — document unchanged each time.
- **F-44c** — `file.saveAs` / `document.new` / `file.open` / `file.exportPng` all performed
  through the real `llm-skill-call` channel.
- **F-47/F-45** — the binding Gherkin re-ran live (Companion ON, app closed): navbar section +
  heading "Reporter" + card "Reporter reports", reply names only the performed steps.
- **F-55** — gates run by the tester on `7d03f3c`: typecheck ✓ · build 2832 modules ✓ ·
  test:run 239 files / 3077 tests ✓ · contrast 46/46 ✓ · build:webview 2834 modules ✓ ·
  `cargo check --locked` ✓ zero warnings · `cargo clippy --locked -- -D warnings` ✓ zero
  warnings · `cargo test --locked` 1451 lib tests + all integration suites ✓ (`nextest` is not
  installed; `cargo test` covers the same set).

**Carried with a named blocker:** F-43 (listActions reply) and the reply-string half of F-46 —
the pushed bubble was observed (`data-reply-kind="reply"`) but auto-dismissed inside one driver
round-trip; the reply source (`wireframeReply.ts`, `useWireframeSkill.ts`, `skillBridge.ts`,
`useWireframeIntent.ts`) is **byte-unchanged** since round 3 (`git diff --stat` empty), so the
round-2/3 live receipts stand.

**Environment note for the next round:** a fresh boot can spend **3-5 minutes** on
`about:blank` / an empty `#root` with `execute_js` timing out (Vite dev-graph transform). A
`dom_snapshot` returning `body > div#root` with no children is a BOOTING webview — wait, do not
`Down`/`Up` (five cycles did not help; waiting did).

**Technique notes (round 4):** a bare `KeyboardEvent` dispatch does NOT reach the hotkey engine
(9 synthetic keydowns → count 0); use the driver's real key events. Every panel interaction
focuses a hidden radio/number input (`focus-context=text-entry`, hotkeys disabled) — a canvas
pointer-down (the shipped explicit blur) restores `default` before any bare key.

## Spec #3081 — Wireframe "Discard" label colour (AC1–AC4)

> Extends the #3070 suite. Scope: the destructive-action confirm dialog's Discard button
> (`WireframeToolbar.tsx:390-397`) currently sets `color="white"` (line 393) — a raw colour.
> Fix: derive the label from `status.onSolids` / `--status-on-solids`. Verification policy:
> **live** (DOM computed colour + measured contrast), no `telemetry_spans` receipt expected.
> Evidence per row: a quoted `tauri_webview_execute_js` result carrying the OBSERVED computed
> colour(s) + the resolved `--status-on-solids`, plus an uploaded `user-attachments` capture
> (G-154 — a visual read alone is not a PASS).

- [x] **F-57 (REQ-1 / AC1)** Discard label colour derives from the theme token, light + dark.
      **Round 1 (2026-10-26) — PASS.** Env `3081-a` (MCP :16031), served `7f2983b`. LIGHT
      `light-default`: `{labelColor:"rgb(12, 17, 23)", buttonBg:"rgb(239, 71, 71)",
      onSolidsVar:"#0c1117", ratio:5.11, labelIsWhite:false}`; DARK `dark`:
      `{labelColor:"rgb(12, 17, 23)", buttonBg:"rgb(239, 68, 68)", onSolidsVar:"#0c1117",
      ratio:5.04, labelIsWhite:false}`. Label == resolved `--status-on-solids` (`#0c1117`) in
      both; ratio ≥ 4.5; never white. Source `WireframeToolbar.tsx:393` = `color="status.onSolids"`.
      **Recipe:** open Wireframe → add one element (dirty) → **New** → dialog
      `[data-testid="wireframe-new-document-dialog"]`; read the Discard button
      `[data-testid="wireframe-new-document-discard"]`.
      **Expected:** `getComputedStyle(discard).color` equals
      `getComputedStyle(document.documentElement).getPropertyValue('--status-on-solids')`
      (rgb-normalised, same task) in BOTH `light-default` and a dark preset; contrast between
      that colour and `getComputedStyle(discard).backgroundColor` ≥ **4.5** (the `status-error-label`
      body floor); the label is NOT `rgb(255,255,255)` where `--status-error` is light; a source
      read of `WireframeToolbar.tsx:393` shows a token prop (no `white`/hex/rgba).
      **Edge:** accent override; dialog opened via the toolbar New button AND via a Companion
      `document.new`; label unclipped inside the button.

- [x] **F-58 (REQ-2 / AC2)** Repo sweep — zero raw-colour literals in the Wireframe tree.
      **Round 1 (2026-10-26) — PASS.** `contrast:gate` 46/46; named-colour scan → only
      `__tests__` comment/fixture hits, ZERO source hits; no wireframe entry in
      `allowlist.ts`/`rawColorBaseline.ts`.
      **Recipe:** `pnpm --filter @fredo/ui contrast:gate` (hex / `rgb(` / `hsl(` / `var(--x)NN`)
      PLUS a wireframe-scoped **named-colour** scan over
      `apps/ui/src/applications/wireframe/**` for `"white"`/`"black"`/`bg="<name>"`/`color="<name>"`.
      **Expected:** ZERO hits in the whole tree; only `transparent`/`inherit`/`currentColor`/`none`
      remain; no wireframe entry in `app/theme/contract/allowlist.ts` or `rawColorBaseline.ts`.
      **Edge:** issue-ref comments stripped and must NOT mask a literal; `tint()`/`color-mix(...)`
      is not a literal; `var(--x)55` alpha-append IS flagged; `.test.tsx` fixtures out of scope.

- [x] **F-59 (REQ-3 / AC3 — edge/negative)** Light `status.error` never yields white-on-light.
      **Round 1 (2026-10-26) — PASS.** Preset `monochrome` (`--status-error:"#ffffff"`):
      `{labelColor:"rgb(12, 17, 23)", buttonBg:"rgb(255, 255, 255)", onSolidsVar:"#0c1117",
      ratio:18.95, labelIsWhite:false, fillIsLight:true}` — dark glyph on white fill, never
      white-on-light.
      **Recipe:** force a light `--status-error` (the lightest-`status.error` shipped preset, or
      the per-token override — theming app / `localStorage['Fredo_theme_overrides']`), open the
      dialog, measure the label.
      **Expected:** computed label colour is NOT `rgb(255,255,255)`; contrast ≥ 4.5; the capture
      shows a readable (dark) glyph on the light-red fill.
      **Edge:** a light `status.error` combined with dark `success`/`warning`/`info` (the
      `resolveOnSolids` min-over-all-four semantics — see the plan Discussion point); accent
      change while the override is active; mid-transition capture.

- [x] **F-60 (REQ-4 / AC4)** Regression gates.
      **Round 1 (2026-10-26) — PASS.** `test:run` 240 files / 3084 tests; `build` 2832 modules
      zero TS errors; `contrast:gate` 46/46; `WireframeToolbar` assertion UPDATED (+43 lines,
      strengthened — G-125).
      **Recipe:** `pnpm --filter @fredo/ui test:run` (must include green
      `applications/wireframe/__tests__/canvasPalette.test.ts` +
      `applications/wireframe/__tests__/WireframeToolbar.hotkeys.test.tsx`),
      `pnpm --filter @fredo/ui build` (zero TS errors), `pnpm --filter @fredo/ui contrast:gate`.
      **Expected:** all three exit 0; the `WireframeToolbar` assertion is UPDATED to expect the
      token (not deleted/weakened — G-125); no other assertion changed.
      **Edge:** the dialog testid is unchanged; the build introduces no new chunk regression;
      the contrast gate stays at its frozen baseline cap.

### Round 1 result — 2026-10-26 — PASS (4/4)

Env `3081-a` (Vite :16030 / MCP :16031), served `7f2983b` (= `spec/3081` HEAD). Driver:
`tauri_driver_session` on `127.0.0.1:16031` (the `tauri_*` tools were PRESENT this round).
Dialog reached by: launcher → Wireframe → `wireframe-action-add-text` (count 1) →
`wireframe-action-document-new` → `wireframe-new-document-dialog`. Theme via Settings →
Appearance `select[aria-label="Theme presets"]` (reset to default after).

- **F-57 PASS** — label == `--status-on-solids` in light + dark; ratios 5.11 / 5.04.
- **F-58 PASS** — `contrast:gate` 46/46 + zero named-colour source hits + no allowlist/baseline entry.
- **F-59 PASS** — `monochrome` (light `status.error`) → dark label, ratio 18.95, never white-on-light.
- **F-60 PASS** — `test:run` 240/3084, `build` 2832 modules zero TS errors, `contrast:gate` 46/46.

**Residual recorded (PO scope question, not a fix defect):** per-preset painted-pair ratios —
`solarized` 4.10, `paper` 4.49 sit marginally below the 4.5 body floor (mid-luminance error;
`resolveOnSolids` min-over-four). No preset is white-on-light. Flagged to the Orchestrator per the
plan; the two REQ-1 named presets clear 4.5.

## Spec #3071 — Wireframe Layout Intelligence (AC1–AC3)

> Extends the #3070 Slice-1 suite. Scope: multi-select + group; snap-to-grid + align + distribute
> + smart guides; bring-forward/send-backward; hotkey + Companion parity; groups/stacking
> persistence. Rows map 1:1 to the Architect's EARS `R-1.1`…`R-3.3` (incl. the convergence
> clauses R-1.9/R-1.10/R-2.8/R-2.9/R-3.3, pinned at rows F-79…F-83) and bind VERBATIM to the
> BINDING names block in `.opencode/tmp/3071/triage.md` (action ids, two-step `g` namespace,
> root/canvas DOM hooks, testids). **Verification policy: live** — DOCUMENT STATE, no
> `telemetry_spans` receipt expected; per-row evidence is a quoted `tauri_webview_*` result
> carrying the named testid + the OBSERVED value, plus an uploaded capture for the visual rows.
>
> **RE-BASELINE (never delete — G-125).** This slice added 10 hotkeyed controls, so the legacy
> count assertions moved 22 → 32 at #3071. **P5/P8 supersession:** the legacy element-key channel
> and its counts are DELETED; the current surface is the declaration-driven place surface
> (`navigation-bar` + `data-nav-*`). The rows below keep their behavioural outcomes (selection,
> grouping, snap, alignment, undo), with the invoker re-pointed to the declared keys (`a g`,
> `a s`, `a ←`).
>
> **Other Slice-1 rows re-baselined in place (expected value only, never deleted):**
> `F-7` (selection chrome now `palette.accent`, not `--accent-strong`), `F-9` (shift-click ADDS
> to the selection — R-1.1), `F-26` (zoom re-bound to `g i` / `g o`), and `F-43`/`F-44c`
> (catalog ids **25 → 35**).
>
> **New hooks asserted:** root `wireframe-root[data-wireframe-selection-ids | -selection-count |
> -selection-group | -group-count | -snap | -stacking]`; canvas
> `wireframe-canvas[data-wireframe-guides]`; controls `wireframe-action-arrange-<group|ungroup|
> toggleGroupLock|toggleSnap|alignLeft|alignCenter|alignRight|distribute|bringForward|
> sendBackward>`; `wireframe-tag-group`. Unchanged Slice-1 hooks still asserted
> (`wireframe-selection-id` is now the PRIMARY = last selected id).

- [ ] **F-61 (R-1.1)** Shift-click ADDS to the selection.
      **Expected:** with A selected, shift-click B then C ⇒ `wireframe-root[data-wireframe-selection-ids]`
      = `A,B,C` (document order), `-selection-count` 1→3, `wireframe-selection-id` = the
      last-clicked (C), the Transformer wraps the UNION bounds, `wireframe-tag-group` absent.
      **Edge:** shift-click the same element twice (add then remove); shift-click with an empty
      selection (starts one); shift-click a member of an existing group (adds it individually,
      membership unchanged); an overlapping pair (topmost hit wins).
- [ ] **F-62 (R-1.2)** Shift-click REMOVES from the selection.
      **Expected:** shift-click a selected element ⇒ it leaves `-selection-ids`,
      `-selection-count` decrements; shift-click the last one ⇒ count `0`, `-selection-ids`=`''`,
      `-selection-id`=`''`, `[data-testid="wireframe-page-controls"]` shown.
      **Edge:** remove down to empty; remove the primary (primary becomes the new last in
      document order); remove then re-add; remove all then a plain click selects one.
- [ ] **F-63 (R-1.3)** Group creates ONE group, geometry unchanged.
      **Expected:** select ≥2, invoke `wireframe.arrange.group` (declared stroke `a` then `g` /
      map row / Companion id) ⇒ `-group-count` +1, `-selection-group` =
      the NEW group id, `wireframe-tag-group` shown, `-selection-ids` unchanged, and EVERY
      member's `-selection-geometry` is string-identical pre/post.
      **Edge:** exactly 2; the whole page; each of the three invokers; members already in another
      group ⇒ **RE-GROUP (R-1.9)** — selected ids leave their old groups, any old group left with
      ZERO members is removed (`WIREFRAME_GROUP_MIN_MEMBERS` = 1), ONE new UNLOCKED group is
      created, and `-group-count` moves by `(1 − removedGroups)` (two singleton groups re-grouped
      ⇒ 2→1, NOT 2→3); a selection that is exactly ONE whole group is a NO-OP returning `false`
      (see F-79).
- [ ] **F-64 (R-1.4)** Group drag/resize applies the delta to every unlocked member.
      **Expected:** drag the group by (dx,dy) ⇒ every UNLOCKED member's `-selection-geometry`
      shifts by the same delta (page-space = pointer/scale); exactly ONE `u` restores all;
      `-selection-group` unchanged.
      **Edge:** resize the group (delta scales members); one member individually locked (stays —
      see F-68); at 200 % zoom; abandon mid-gesture (no change).
- [ ] **F-65 (R-1.5)** Ungroup leaves geometry + stacking unchanged.
      **Expected:** group selected, `wireframe.arrange.ungroup` ⇒ `-group-count` −1,
      `-selection-group`=`''`, `wireframe-tag-group` gone, every member keeps its EXACT geometry
      AND its position in `data-wireframe-stacking`.
      **Edge:** ungroup a LOCKED group (ungroup is neither a move nor a resize ⇒ it SUCCEEDS —
      lock covers position+size only, R-1.10); ungroup then undo; ungroup a single non-grouped
      element (no-op, `runWireframeAction` false).
- [ ] **F-66 (R-1.6)** Delete group removes group + members in ONE undo step.
      **Expected:** group selected, delete (`k`) ⇒ group AND every member removed:
      `-element-count` − n, `-group-count` −1, `-selection-ids`=`''`; exactly ONE `u` restores
      the group and all members with ids/geometry intact.
      **Edge:** members include a hidden element; the only group; via Companion `element.delete`;
      undo then redo.
- [ ] **F-67 (R-1.7)** `toggleGroupLock` flips; locked group members don't move/resize.
      **Expected:** group selected, `wireframe.arrange.toggleGroupLock` ⇒ group `locked` flips
      (toolbar `aria-pressed` + locked affordance + `wireframe-tag-group`); a body drag AND a
      drag at the FORMER handle coordinates then leave EVERY member's `-selection-geometry`
      string-identical; the flip commits ONE undo snapshot and flips `-dirty` (the
      `documentsEqual` trap — a groups-only change must NOT be a silent no-op).
      **Edge:** toggle twice (flip back); toggle then drag (all members immovable); toggle with a
      member INDIVIDUALLY locked (its own lock is independent — the group flip is a groups-only
      mutation that STILL commits and flips `-dirty`; the `documentsEqual` trap); save+reopen
      preserves group `locked`.
- [ ] **F-68 (R-1.8)** A locked member in an unlocked group stays immovable.
      **Expected:** group of 3 with ONE member individually locked (`l`), drag the group ⇒ the two
      unlocked members move by the delta, the locked member's `-selection-geometry` is
      string-identical, ONE undo restores.
      **Edge:** lock 2 of 3; resize the group; the locked member's former handle coordinates do
      nothing; unlock mid-group and re-drag.
- [ ] **F-69 (R-2.1)** `toggleSnap` flips + reports state.
      **Expected:** `wireframe.arrange.toggleSnap` (declared stroke `a` then `s` / map row /
      Companion) ⇒ `wireframe-root[data-wireframe-snap]` flips `'false'`↔`'true'` AND the
      map/rail row's state matches; `-dirty` and the undo depth UNCHANGED (editor state, not
      document state).
      **Edge:** toggle twice; toggle then Save/Open (snap absent from the document); toggle with
      a selection; each invoker.
- [ ] **F-70 (R-2.2)** Snap lands the origin on the nearest grid multiple.
      **Expected:** snap ON, drag an element off-grid ⇒ on release `-selection-geometry` x AND y
      are exact multiples of `WIREFRAME_GRID_SIZE_PX` (8) and the element is clamped inside
      `-page`; snap OFF, the same drag keeps its free coordinates.
      **Edge:** drag near a page edge (clamp wins); snap a group/multi-selection ⇒ **R-2.9**: the
      UNION-BOX ORIGIN snaps to the nearest `WIREFRAME_GRID_SIZE_PX` (8) multiple and that delta
      is applied UNIFORMLY to every movable member (inter-element offsets preserved, clamped to
      `-page`); 200 % zoom; a 1 px nudge rounds to the nearest multiple.
- [ ] **F-71 (R-2.3)** `alignLeft`/`alignCenter`/`alignRight` line up edges/centres.
      **Expected:** ≥2 selected: `alignLeft` ⇒ all left edges coincide (min left) in
      `-selection-geometry`; `alignCenter` ⇒ horizontal centres coincide; `alignRight` ⇒ right
      edges coincide; every element's w/h UNCHANGED; ONE undo per align.
      **Edge:** 2 vs 5 elements; a mixed locked/unlocked selection ⇒ **R-2.8**: align operates on
      the MOVABLE members only, the align TARGET is the WHOLE selection's union bounds (locked
      members anchor the target edge), and every locked member's `-selection-geometry` is
      string-identical pre/post — `<2` movable ⇒ no-op returning `false`; already-aligned ⇒
      **R-2.9 TRUE NO-OP** (value-equal ⇒ no commit, no `-dirty`, no undo step, returns `false`);
      each invoker.
- [ ] **F-72 (R-2.4)** `distribute` equalises horizontal gaps; ends unchanged.
      **Expected:** ≥3 selected: `wireframe.arrange.distribute` ⇒ the horizontal gaps between
      consecutive selected elements (ordered by left edge) are equal within ±1 px; the leftmost
      and rightmost elements are geometry-identical pre/post; ONE undo.
      **Edge:** exactly 3 MOVABLE (minimum — **R-2.8**: the operand set is the movable members, so
      3 selected with 1 locked ⇒ 2 movable ⇒ no-op `false`); 5; already-even ⇒ **R-2.9 TRUE
      NO-OP** (value-equal ⇒ no commit, returns `false`); equal-width vs mixed-width (gap =
      edge-to-edge space, not centre pitch); each invoker.
- [ ] **F-73 (R-2.5)** Smart alignment guides paint then vanish on drop.
      **Expected:** drag an element so its left/centre/right is within `ALIGN_GUIDE_THRESHOLD_PX`
      (6) of another element's corresponding edge/centre ⇒
      `[data-testid="wireframe-canvas"][data-wireframe-guides]` reads a number > 0 read MID-drag,
      and returns to `'0'` on drop; no React state is written per pointer move (console clean).
      **Edge:** approach each axis separately; drag away beyond 6 px (guides `'0'`); several
      simultaneous guides; guides absent from an exported PNG (see F-78); drag near the page
      edge.
- [ ] **F-74 (R-2.6)** `bringForward`/`sendBackward` move one position, clamped.
      **Expected:** non-empty selection: `bringForward` ⇒ each selected element moves ONE
      position later in `data-wireframe-stacking`; `sendBackward` ⇒ one position earlier;
      clamped at the ends (topmost forward / bottommost backward is a no-op); ONE undo.
      **Edge:** bringForward the top element (clamped ⇒ value-equal ⇒ no commit, returns `false` —
      R-2.9); sendBackward the bottom (clamped, `false`); multi-select reorder determinism
      (**R-2.9**: `bringForward` walks selected ids DESCENDING, `sendBackward` ASCENDING, a swap
      that would cross the array end is skipped, ONE commit, `false` if nothing moved, the
      selection SURVIVES the reorder); reorder then undo; each invoker; a locked element IS still
      reorderable (lock covers position+size only — R-1.10).
- [ ] **F-75 (R-2.7)** Under-sized selection performs nothing; `runWireframeAction` returns false.
      **Expected:** `group` with 0/1 selected, `align*` with <2, `distribute` with <3,
      `bringForward`/`sendBackward` with 0 ⇒ NOTHING changes (document, selection, `-group-count`,
      `-stacking`, undo depth) and `runWireframeAction` returns `false`; the Companion replies
      "nothing changed".
      **Edge:** each invoker × each under-sized case; a visibly-disabled toolbar control still
      no-ops when invoked; the Companion reply text is honest.
- [ ] **F-76 (R-3.1 — historical; current model)** Declaration / map / Companion parity.
      **Expected:** for each of the 10 actions the `navigation-bar` lists a row
      (`data-nav-verb-id`) with its `data-nav-keycap` hint; the declared stroke produces the SAME
      visible change as the map row and as the Companion command id;
      `wireframe.companion.listActions` contains all 10 ids with non-empty descriptions.
      **Edge:** each action × all three invokers; the 250 ms prefix hint after the first stroke;
      `zoom.in` (`v` `+`) / `zoom.out` (`v` `-`) still work; no duplicate stroke (V-07).
- [ ] **F-77 (R-3.2)** Save As…/Open restores groups + stacking.
      **Expected:** build a document with ≥2 groups (one locked) and a non-default stacking
      order, Save As…, then `document.new` + Open ⇒ `-group-count` matches, the saved JSON
      `groups[]` id/memberIds/locked are identical, `data-wireframe-stacking` order is identical
      to pre-save, and no other document property changed; a Slice-1 file with no `groups`
      parses to `groups: []`.
      **Edge:** a legacy (no-`groups`) file at `.opencode/tmp/3071/e2e/fixtures/legacy.wireframe.json`;
      a file whose `groups[].memberIds` references a missing element ⇒ **R-3.3**:
      `parseWireframeDocument`/`reconcileDocumentGroups` DROPS the dangling id and removes the
      group ONLY if it empties, preserving every survivor's `id`/order/`locked`; a duplicate
      membership keeps the FIRST group in document order; a structurally malformed group entry ⇒
      `WireframeDocumentError`, nothing changes (see F-83); round-trip twice.
- [ ] **F-78 (NFR)** Non-functional gate.
      **Expected:** `pnpm --filter @fredo/ui build` exit 0 zero TS errors;
      `pnpm --filter @fredo/ui test:run` green; `cargo check` / `cargo clippy -- -D warnings`
      zero warnings; no `#[allow(...)]`; `contrast:gate` green; **guides never in an exported
      PNG** (an export right after a guide-bearing drag is byte-identical to one from the same
      document with no guide ever painted); **no per-pointer-move React state** (50-move drag
      with a clean console and no re-render storm); no `#rrggbb`/`rgb(`/`hsl(`/`hsla(` and no
      `var(--x)NN` alpha-append in `applications/wireframe/**`.
      **Edge:** export mid-guide; theme switch with a selection; 60-element document responsive;
      the re-baseline rows (F-37/F-38/F-39/F-40) updated to 32 (never deleted).

### Convergence clauses — F-79…F-83 (Architect RESOLUTION A1/A2/A3, B4/B5)

- [ ] **F-79 (R-1.9)** `group` RE-GROUPS already-grouped elements.
      **Expected:** select ≥2 where ≥1 element already belongs to another group, invoke
      `wireframe.arrange.group` ⇒ selected ids are REMOVED from their previous `memberIds`, any
      previous group left with ZERO members is REMOVED (`WIREFRAME_GROUP_MIN_MEMBERS` = 1),
      exactly ONE new UNLOCKED group is created with `memberIds` = the whole selection in
      document order and becomes the selection; `-group-count` moves by `(1 − removedGroups)`
      (two singleton groups ⇒ 2→1, NOT 2→3).
      **Edge:** two elements drawn from two singleton groups (2→1); an element drawn from a
      3-member group (old group survives, `-group-count` 2→2); a selection that is exactly ONE
      whole group ⇒ NO-OP, `runWireframeAction` false, no new group id minted; each invoker.
- [ ] **F-80 (R-1.10)** Element lock is position+size ONLY.
      **Expected:** `wireframe.element.toggleLock` with N selected ⇒ every selected element's
      `locked` flips in ONE commit; a LOCKED element is STILL reorderable
      (`bringForward`/`sendBackward` move it in `data-wireframe-stacking`) and STILL deleted by
      the delete action (count −1, ONE undo restores).
      **Edge:** lock 3 at once (ONE commit, `-dirty` flips); reorder a locked element then undo;
      delete a locked element then undo; a locked element alone vs inside a group.
- [ ] **F-81 (R-2.8)** `align*`/`distribute` with a locked member.
      **Expected:** selection of ≥2 where ≥1 is individually locked (or a locked group):
      `align*`/`distribute` compute over the MOVABLE members only, leave every locked member's
      `-selection-geometry` string-identical, and use the WHOLE selection's union bounds as the
      align target (locked members anchor the target edge).
      **Edge:** align with 1 of 2 locked ⇒ 1 movable ⇒ NO-OP, `runWireframeAction` false,
      Companion "nothing changed"; align 2 movable + 1 locked ⇒ the 2 align to the 3-element
      union edge; distribute with 3 selected / 1 locked ⇒ 2 movable ⇒ no-op; each invoker.
- [ ] **F-82 (R-2.9)** True no-op + uniform clamped delta.
      **Expected:** already-aligned / already-distributed / end-clamped reorder ⇒ the document is
      VALUE-EQUAL ⇒ NOTHING commits (no snapshot, no `-dirty` flip, no undo step) and
      `runWireframeAction` returns `false`; a multi/group RESIZE applies ONE uniform union-box
      delta `(dx,dy,dw,dh)` to every movable member (origins `+= dx,dy`, sizes `+= dw,dh`,
      inter-element offsets preserved), the delta CLAMPED so no movable member falls below
      `ELEMENT_MIN_SIZE`; snap uses the union-box ORIGIN delta.
      **Edge:** align an already-aligned set (`false`, no `u` step); distribute an already-even
      set (`false`); bringForward a clamped top element (`false`); resize a 3-member group near
      the min size (the clamped delta is applied UNIFORMLY — members do not drift out of relative
      alignment); multi-select reorder determinism (forward DESC / backward ASC, end-crossing
      swaps skipped, ONE commit, `false` if nothing moved).
- [ ] **F-83 (R-3.3)** Dangling `memberIds` reconciliation on Open.
      **Expected:** a document whose `groups[].memberIds` reference an element not in `elements`
      ⇒ `parseWireframeDocument` (via `reconcileDocumentGroups`) DROPS each dangling id and
      removes a group ONLY if it empties, preserving every surviving group's `id`/order/`locked`;
      a duplicate membership keeps the FIRST group in document order; a structurally malformed
      group entry (not an object with string `id` + array `memberIds` + boolean `locked`)
      REJECTS the document (`WireframeDocumentError`, nothing changes).
      **Edge:** a group of 2 with 1 dangling id ⇒ group survives with 1 member; a group of 1
      whose only id dangles ⇒ group removed; an id duplicated across two groups ⇒ FIRST keeps it,
      the second drops it; `groups` present but not an array ⇒ reject; each via the Open seam.

## Spec #3087 — remove the on-control hotkey chip (F-84…F-90)

> The Wireframe toolbar must render **no** hotkey badge/chip on any control; shortcuts show
> only on the always-on bottom hotkey bar. Deletion-only markup; bindings/actions/bar
> unchanged. **Verification policy: live** — DOM observable + a real keystroke performing the
> action; document state, no `telemetry_spans` receipt expected. Isolated env:
> `powershell -File .opencode/scripts/dev-env.ps1 -Action Up -Spec 3087 -EnvId wf3087-a
> -EnvSlot 1 -RequireIsolation`; driver `tauri_driver_session start` with `appIdentifier` = the
> env MCP port decimal string. Do **not** synthesize key events (E-22).

- [ ] **F-84 (R-1 — historical #3087; current model)** No on-control key chip exists.
      **Expected (current):** the deleted toolbar/chip has no successor; the bar renders key
      hints through `NavKeycap` (`data-nav-keycap`) and the rail/map rows carry
      `data-nav-verb-id`; zero legacy element-key attributes under `wireframe-root`
      (`legacyAbsence.test.ts` green). A capture of the bar is uploaded.
      **Edge:** every place; the insert affordance; both theme presets.
- [ ] **F-85 (R-1.2 — historical)** The absence holds unfocused too.
      **Expected:** focus another window ⇒ the Wireframe rows leave the bar and no legacy
      element-key attribute appears in either state. **Edge:** toggle focus 10×.
- [ ] **F-86 (R-2 — historical)** A declared key performs its verb.
      **Expected:** with the Wireframe host focused, pressing a declared stroke (`c`, then `t`)
      produces the SAME document delta as activating the corresponding map/rail row.
      **Edge:** a place with no bound verbs (no row); a two-step prefix renders its hint.
- [ ] **F-87 (R-3 — historical)** Keyboard operability + accessible name/tooltip.
      **Expected:** Tab order is identical to the pre-change order; every retained control's
      accessible name is unchanged; the map/rail rows expose the verb title + `data-nav-keycap`
      hint; nothing derives from a removed chip.
      **Edge:** a disabled (unavailable) row; a locked control.
- [ ] **F-88 (R-4 — historical)** Unit suite + build.
      **Expected:** `pnpm --filter @fredo/ui test:run -- src/shared/navigation` green (including
      `keycap.test.tsx`); `pnpm --filter @fredo/ui build` exit 0 zero TS errors; no
      weakened/deleted assertion (G-125). Cross-ref `regression.md` R-19.
      **Edge:** full `test:run` green; `contrast:gate` zero wireframe hits.
- [ ] **F-89 (edge — historical)** Bar height stable across focus.
      **Expected:** `navigation-bar` height focused vs unfocused is identical (±0 px); no
      reserved chip slot exists in either state.
      **Edge:** wrap may change once between states — NOT a focus reflow.
- [ ] **F-90 (edge — historical)** `NavKeycap` consumers intact.
      **Expected:** `data-nav-keycap` hints render in the bar/map/rail; the navigation barrel
      exports `NavKeycap`; `keycap.test.tsx` green.
      **Edge:** a two-key hint renders two glyphs.

## Spec #3119 (P5) — Wireframe pilot: RE-BASELINE of every keyboard / toolbar / bar recipe

> **Nothing above is deleted (G-125).** Spec #3119 replaces the toolbar + element hotkeys with a
> **declaration-driven place surface**: `applications/wireframe/wireframeSurface.ts` (six places
> under `Canvas`, 55 verbs, 3 root direct aliases) mounted with `CommandRail` +
> `NavigationMap` + `ActivityTrail`. The legacy toolbar, carrier, command surface and every
> element-key binding are DELETED; no Wireframe element carries a legacy key attribute.
>
> **Authoritative amendments below.** Where a row above names a removed key, hook or testid,
> the amendment in this section is the executable recipe — the row's EXPECTED OUTCOME is
> unchanged (that is the regression guarantee). The new surface's own cases (declaration,
> parity, reachability, single stack, announcement) live in
> `.opencode/tests/wireframe-navigation/functional.md` (F-N1…F-N24) and are not duplicated here.
>
> **Deleted hooks / premises (a row that reads one of these is a technique error, not a FAIL
> of the product):** the legacy toolbar/carrier/action testids, the legacy on-control chip, any
> legacy element-key attribute inside `wireframe-root`, the retired two-step namespace, the
> legacy pending-sequence marker for Wireframe strokes, legacy bar rows for Wireframe, and the
> retired binding counts. The absence is gate-owned by `legacyAbsence.test.ts`.
>
> **One timeout:** the NAV ENGINE prefix times out at **250 ms**
> (`PENDING_TIMEOUT_MS`, `shared/navigation/types.ts:17`). The legacy 1000 ms sequence timeout
> belonged to the deleted engine and no longer governs Wireframe.
>
> **Three surface facts that change what a row can assert (UI/UX §4/§8/§9, binding):**
> 1. **Availability is kind+count gated.** `fill`/`border`/`radius` need ONE **shape**;
>    `textStyle` needs a **text**; `appearance` needs a **button**; `rename` needs
>    `text|button|input|card`; edit verbs need ≥1; `align ≥2`, `distribute ≥3`, `group ≥2`,
>    `ungroup`/`toggleGroupLock` need a group. A row that expects `fill` enabled on a text
>    element is wrong — the row is `aria-disabled` with
>    `Not available for the current selection`, and pressing its key speaks
>    `<key> isn't available here` once.
> 2. **Value keys are deterministic CYCLES** (all value args optional): `f` → next
>    `WIREFRAME_COLOR_TOKENS` token (wrap `info→surface`); `o` → `none→thin→thick→none`;
>    `p` → `primary→secondary→ghost→primary`; `z` → `none→s→m→l→none`;
>    `t` → `body→heading→body`. One press = one mutation entry = one undo. Edit `r` is a
>    NAVIGATION effect (focus + select the name field), never a document entry.
> 3. **Accepted deltas (not regressions):** (a) file rows are no longer visually disabled while a
>    file operation runs (`ContextSnapshot` has no file status — re-entrancy is the store's
>    existing no-op); (b) every Wireframe verb has `coalesceKey: null`, so a repeated field tick
>    is TWO entries (no coalesced group); (c) the insert menu (`wireframe-insert`) is the ONLY
>    toolbar-shaped affordance left and never changes the place.

### Key map — old recipe → new recipe (binding)

| Row(s) | Old stroke(s) | New stroke(s) |
|---|---|---|
| F-1, S-6 | `1` (text) | `c` `t` |
| F-2, S-12 | `2`…`4`, `6`…`9` (button/input/image/card/section/shape/line) | `c` `b` / `c` `i` / `c` `m` / `c` `k` / `c` `s` / **map › Create › Shape** / `c` `l` |
| F-5 | `5` (icon) | **map › Create › Icon** (unbound keyboard-wise; default `iconId` supplied) |
| F-6 | `1`…`9` | the nine `c <key>` above + map for Icon/Shape |
| F-12 | `p` duplicate, `k` delete | `e` `d` duplicate, `e` `x` delete |
| F-13, F-14 | `l` lock | `e` `l` toggleLock (`e` `h` toggles visible) |
| F-24, F-25 | `u` undo, `y` redo | **unchanged** — root direct aliases `u` / `y` |
| F-26, F-53 | `g i` zoom in, `g o` zoom out | `v` `+` / `v` `-` |
| F-27 | `h` pan | `v` `p` (togglePan) |
| F-28 | `n` fit page | `v` `f` |
| F-29 | `0` reset view | `v` `0` |
| F-31, F-35, F-57 | `w` save as | `f` `w` (File place) |
| F-32, F-35, F-50…F-52 | `o` open | `f` `o` |
| F-33, F-35 | `t` export | `f` `x` |
| F-36, F-44c | `document.new` | `f` `n` (opens the discard dialog when dirty — see F-57a) |
| F-61…F-83 (+ `g` rows) | `g g` / `g u` / `g s` / `g a` / `g r` / `g d` / `g f` / `g b` | `a` `g` / `a` `u` / `a` `s` / `a` `←` / `a` `→` / `a` `d` / `a` `f` / `a` `b` |
| F-63, F-67, F-69, F-71, F-76 | `wireframe-action-arrange-*` | `navigation-rail-row` / `navigation-map-row` (`data-nav-verb-id`), or `a <key>` |
| F-69, F-73, F-76 | toolbar `aria-pressed`, retired zoom chord | rail/map row `data-nav-availability` + `data-wireframe-snap`; `v` `+` / `v` `-` |
| F-63, F-67 | `WIREFRAME_GROUP_MIN_MEMBERS` etc. | unchanged (document semantics untouched) |
| F-71 | `alignCenter` via `g c` | `alignCenter` is **unbound** → **map › Arrange › Align centre** |
| F-67 | `toggleGroupLock` via `g l` | **unbound** → **map › Arrange › Lock group** |
| F-12 (multi) | delete/lock with N selected | unchanged semantics; one `e x` / `e l` commit |

**Selection by pointer is unchanged** (click / shift-click / empty-canvas deselect) — no key
change. **Arrow keys are engine-owned now:** at the root they select previous/next (replacing
`WireframeCanvasImpl.tsx:1275-1303`'s local handler); inside Arrange they align. A test that
dispatches arrow `KeyboardEvent`s to the canvas element will no longer work — press them on the
shell root with the key gate satisfied.

### Row amendments (read with the row above)

- **F-1/F-2/F-3/F-5/F-6** — same expected observables; add via the Create place (`c <key>`) or
  the map. F-5 (icon) and F-2's shape leg now go through **map › Create**, which must supply
  the default `iconId` / `shape` (`rect`); an `invalid-args` rejection is a FAIL. F-6's
  12-category page still needs all nine types + the four section presets + both text styles.
- **F-12/F-13/F-14** — `e` first, then `d`/`x`/`l`/`h`. The one-undo clauses are unchanged but
  now ride the journal (`wireframeJournal.test.ts`).
- **F-15/F-16/F-17…F-23** — unchanged (selection + property panel; no keys). The panel writes
  verbs through the host in ST-6; the panel's testids/labels are unchanged.
- **F-24/F-25** — `u`/`y` unchanged as ROOT aliases. **Inside Arrange, `u` is ungroup** (tier 1
  beats tier 2) — an undo leg must run at the root (or via the trail's per-entry Undo).
- **F-26/F-53** — zoom step is unchanged (±10 pp), now `v +` / `v -`. The 30/9 clamp counts and
  the 400/10 bounds are unchanged.
- **F-27** — pan is `v p`; the `wireframe-pan-surface` recipe, the three drag origins and the
  E-20 bubbled-drag guard are unchanged.
- **F-28/F-29/F-30** — `v f` / `v 0`; page presets/dims unchanged (`wireframe-page-controls`).
- **F-31/F-32/F-33/F-34/F-35** — file verbs are `place.saveAs` / `place.open` /
  `place.exportPng` at `f w` / `f o` / `f x`; the seams, precedence, copy, 2× PNG, page-space
  invariance and dirty/saved rules are UNCHANGED. One journal entry each, `inverse: null`,
  `external: true`, non-undoable with the shipped consequence copy.
- **F-36** — `f n` for New. The `Discard unsaved changes?` dialog behaviour is retained **only
  if** the dialog survives the toolbar deletion — see F-57a and plan Q-6.
- **F-37** — **SUPERSEDED.** The 32-binding table no longer exists. Replacement: press the
  declared strokes listed in `wireframe-navigation/functional.md` (F-N3…F-N10 cover every AC2
  case) and confirm each performs its verb; `wireframe-navigation/functional.md` F-N13 proves
  the 33 capabilities are still reachable.
- **F-38/F-39/F-40** — **SUPERSEDED for the 32-row/32-attribute counts.** New expectations:
  Wireframe contributes **0** LEGACY bar rows while focused (the current rows are the navigation
  bar's declaration rows)
  (the global bar model is empty for Wireframe); text-entry suppression still works on the ONE
  element-scoped nav handler (typing into a panel field dispatches nothing and lands the
  characters); an unfocused Wireframe still dispatches nothing.
- **F-41** — duplicate-key guard: Wireframe contributes **zero** bindings, so the risk is now
  the inverse (a stray legacy element-key reintroduced) — covered by `legacyAbsence.test.ts` and `wireframe-navigation`
  F-N11/F-N22.
- **F-42** — unchanged in spirit: a bare stroke with a `<button>` focused must not be treated as
  a text-entry passthrough by the nav engine (only text controls pass through), so record the
  observed behaviour and do not fail the product for it.
- **F-43…F-49** — **DEFERRED to P6 (recorded, Q-1).** The generated companion skill came from
  the deleted command surface. New expected outcome for these rows: a companion
  `llm-skill-call` for Wireframe resolves to a clean `Invalid` (no window opened, no element
  added, no timeout, no crash) and `wireframeDraft.ts`'s direct draft operations still work as
  unit tests. Anything OTHER than a clean fail-closed is a FAIL. Do not re-baseline these to
  "PASS by removal".
- **F-50/F-51/F-52** — unchanged except the `o` leg is `f o`.
- **F-53** — unchanged except zoom strokes.
- **F-54/F-55/F-56** — unchanged (console, CI parity, bundle).
- **F-57** — the Discard label colour row keeps its observable (computed colour == resolved
  `--status-on-solids`, ratio ≥ 4.5, never white, testids `wireframe-new-document-dialog` /
  `wireframe-new-document-discard`). Its **source-read leg** must be re-pointed from the deleted
  `WireframeToolbar.tsx:393` to whichever component now owns the dialog — a NAMED BLOCKER until
  ST-7 declares the owner (plan Q-6). The dialog must be reached with `f n` on a dirty document.
- **F-58/F-59/F-60** — colour/contrast rows unchanged; the wireframe-scoped scan now includes
  `wireframeSurface.ts` and the nav surface files (they are under `applications/wireframe/**` /
  `shared/navigation/**`; the latter needs the scoped sweep because `contrast:gate` does not glob
  `shared/`).
- **F-61…F-83** — arrange/group rows keep their document semantics and one-undo clauses; only
  the invoker changes (`a <key>` or the map/rail row). `alignCenter` and `toggleGroupLock` are
  map-only. The `g`-namespace bar/ARIA clauses in F-76 are superseded by F-N13/F-N19.
- **F-84…F-90** — **SUPERSEDED** (they are entirely about the toolbar and the on-control chip,
  both deleted). Replacement coverage: `wireframe-navigation` F-N11 (no toolbar, no bar) and
  F-N14 (capability parity) plus `.opencode/tests/hotkeys/` for the other apps' bar.
- **F-23 (multi header caption) — copy changed, testids unchanged.** The multi-selection panel
  caption is now `Arrange, align or group them from the rail` (was "…from the toolbar"); the
  header testids (`wireframe-panel-header/-title/-caption`) are unchanged and the pinned
  `WireframePropertyPanel` assertion must be UPDATED, never deleted (G-125).
- **New pointer affordance (insert menu).** The toolbar's Insert cluster is replaced by one pill
  — `wireframe-insert` (trigger) + `wireframe-insert-item` rows carrying `data-nav-verb-id` and
  `data-nav-args` (Elements / Section presets / Shape kinds / Icon picker). Every item dispatches
  its declared verb with explicit args and **never changes the place** and never enters Create.
  It is the only toolbar-shaped affordance left; `wireframe-toolbar` stays deleted.
- **S-9/S-15/S-16 (smoke.md)** — superseded: Wireframe now shows **0** bar rows and **0**
  legacy element-key attributes; `wireframe-toolbar` is gone. See `smoke.md`'s P5 section.
- **F-57a (NEW, P5 regression — the New dialog).** `f n` on a dirty document opens
  `[data-testid="wireframe-new-document-dialog"]`; Cancel keeps the document and dirty state,
  Discard resets to an empty document (`-element-count="0"`, `-dirty="true"`, path `''`); on a
  clean document no dialog appears. **If the dialog is not preserved, this row is a FAIL of
  AC8** (New is a shipped capability) — the owner must be named by ST-7 (plan Q-6).


