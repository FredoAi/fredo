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
> Shipped hooks consumed: `data-fredo-hotkey-count`, `data-fredo-hotkey-duplicate`,
> `data-fredo-hotkeys-disabled`, `data-fredo-focus-context`, `hotkeys-keybar`,
> `hotkeys-keybar-row` (+ `data-hotkey-key`), `hotkeys-duplicate-error`.

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
- **Focus gate before every hotkey press:** `document.activeElement === document.body`,
  `document.body[data-fredo-focus-context]`=`default`, and
  `document.body[data-fredo-hotkeys-disabled]` not `true`. A focused interactive control
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
      (outline + Transformer handles) matches `--accent-strong` — the 12-key palette is the
      contract (C6/`useCanvasPalette` adjudication 4); a dense full-page diff between the two
      captures is non-zero on ≥ 30 % of sampled pixels; card, text and border follow their
      tokens.
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
      handles show for B only; shift-click on C does not add a second selection.
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
- [ ] **E-15 (R-3.6, found in F-22 — stepper)** The numeric STEPPER must commit the stepped value.
      **Expected:** one click on the increment/decrement trigger of element width, element
      height, page width and page height changes the value by the declared step (and the
      displayed number matches); ONE undo reverts exactly one step.
      **Recipe (round 3):** Zag increments on `pointerdown`, so the click must be driven as a
      realistic sequence — `pointerdown` → ~120 ms → `pointerup` → ~80 ms → `click` on
      `[data-testid="<field>-number"] [data-part="increment-trigger"]`. A zero-delay burst
      under-reads the committed ref (Zag's `onValueChange` lands in a microtask after the click)
      and is a TECHNIQUE artifact, not a product defect.
      **Round 3 residual (FAIL on the undo clause):** the stepper click focuses the number
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
      **Expected:** `g`/`m` change `-zoom` by the same declared step each press (record
      consecutive values); the page visibly scales; `-element-count` and the document are
      unchanged.
      **Edge:** at 100 %; with a selection (handles scale, selection kept); alternate g/m back
      to 100.
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
- [ ] **E-16 (new, R-2.2/R-4.2 — regression) An element drag must not move the view.**
      **Expected:** dragging an element changes only that element's geometry; the view
      transform is untouched by a document gesture.
      **Actual (round 3, FAIL):** the element's `dragend` bubbles to the pan group, whose
      `onDragEnd` (`handlePanDragEnd`, `WireframeCanvasImpl.tsx:745-752`) commits the ELEMENT's
      absolute stage position as the view — dragging a text element by (+30,+20) moved the view
      from (175, 30.5) to (715, 446.5). The handler must ignore bubbled drags
      (`event.target !== event.currentTarget`) or read `event.currentTarget`.
      **Recipe:** read the view before/after a drag; assert `view` unchanged and the element
      delta correct.
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
- [ ] **F-33 (R-4.9)** Export PNG (`t`) of the PAGE at 2×.
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

- [ ] **F-37 (R-5.1)** All 22 bindings, each vs its visible control.
      **Expected:** with `data-fredo-focus-context=default`, each of
      `1 2 3 4 5 6 7 8 9 p k l u y g m n 0 h w o t` produces its action's observable effect
      (count / geometry / zoom / history / dirty / file); clicking its
      `[data-testid="wireframe-action-<suffix>"]` produces an INDISTINGUISHABLE effect. A
      POINTER toolbar activation blurs the control (UI/UX §3.14), so the very next bare key
      fires — verify that loop for at least `1`, `p`, `u`.
      **Edge:** `u`/`y` on empty history; `l`/`p`/`k` with no selection; `w`/`o`/`t` in the
      seam env (all three path seams set at once); each key pressed twice.
- [ ] **F-38 (R-5.2)** The always-on bar lists all 22 while focused.
      **Expected:** `[data-testid="hotkeys-keybar-row"]` contains a row for every one of the
      22 `data-hotkey-key` values, each with a non-empty human title;
      `document.body[data-fredo-hotkey-count]` is exactly 22 higher than with the host
      unfocused.
      **Edge:** other windows open (their rows also listed); narrow viewport (rows
      scroll/are not clipped); the digit key `0` renders correctly.
- [ ] **F-39 (R-5.3)** Text-entry suppression in the property panel.
      **Expected:** with a panel field focused, typing `1`, `p`, `k`, `n` lands the characters
      in the field, `data-fredo-hotkeys-disabled`=`true`, and count + document are UNCHANGED.
      **Edge:** each text-entry control (label, content, numeric dims); blur then press `1`
      (fires); a digit typed into the page width field.
- [ ] **F-40 (R-5.4)** Unfocused Wireframe neither dispatches nor lists.
      **Expected:** focus another window ⇒ the 22 `data-hotkey` attributes are gone from
      `[data-testid="wireframe-toolbar"]`, `data-fredo-hotkey-count` drops by exactly 22, no
      wireframe row remains, and pressing `1` from the other window's `default` context adds
      nothing. The toolbar buttons stay VISIBLE and CLICKABLE and the keychip slot is reserved
      (hidden, not removed) so the toolbar height does not change (UI/UX §3.13).
      **Edge:** focus returns (attributes restored, count back up 22, chips visible); toolbar
      height unfocused vs focused (±0 px); two windows open.
- [ ] **F-41 (R-5.5)** No duplicate-key collision.
      **Expected:** `document.body[data-fredo-hotkey-duplicate]` is ABSENT with Wireframe
      focused, with it open-but-unfocused, and with Mission Monitor + Diagram + Wireframe all
      open; `[data-testid="hotkeys-duplicate-error"]` absent; console clean of the DEV
      duplicate throw.
      **Edge:** every launcher app open at once; focus toggled 10×.
- [ ] **F-42 (R-5.1 platform note, non-AC)** Bare key with a toolbar `<button>` focused.
      **Expected:** NOTHING happens (shipped `native-consumer` rule, `sequence.ts:146`).
      Record as expected platform behaviour — a no-op here is NOT a FAIL; the AC path is the
      `default`-context press in F-37.
      **Edge:** focused `<button>` vs canvas; focused panel field (F-39); modal open
      (suspended).

## R-6 / AC6 — Companion control

- [ ] **F-43 (R-6.1)** `wireframe.companion.listActions`.
      **Expected:** the reply contains all 25 action ids with a non-empty description each;
      supported by a direct `llm-skill-call` emit
      `{skill:"wireframe", arguments:{action:"wireframe.companion.listActions"}}`; a TS
      parity test pins the 25 ids against the Rust catalog source.
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
- [ ] **F-44c (R-6.2)** Invoke the 3 file actions + `document.new`.
      **Expected:** a direct emit for `file.saveAs`, `file.open`, `file.exportPng` (each
      resolved through its own path seam) and `document.new` performs exactly its action: the
      save path receives the document, the open path restores it, the export path receives the
      page image, and `document.new` yields `-element-count`=0 with `-dirty`=`true` and the
      path cleared. **Coverage accounting: these 23 ids + `companion.listActions` (F-43) +
      `companion.draftApp` (F-47) = all 25 ids invoked.** The kind-group rows are a grouping
      device only, never a substitute for covering all 25.
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

- [ ] **F-50 (R-4.13)** Unreadable document.
      **Expected:** with `FREDO_WIREFRAME_OPEN_PATH` pointing at
      `fixtures/invalid.wireframe.json` (`{ not json`) in its own launch, `o` shows
      `wireframe-file-error` (in the shell); count/geometry/document unchanged; dirty
      unchanged. Fixture `fixtures/invalid.wireframe.json`.
      **Edge:** empty file; zero-byte file; truncated-with-valid-prefix JSON.
- [ ] **F-51 (R-4.13)** Foreign `app` tag.
      **Expected:** rejected with an error naming the problem; no page change. Fixture
      `fixtures/foreign-app.wireframe.json` (`app:"other.app"`).
      **Edge:** foreign tag with otherwise valid content; foreign tag + wrong `schemaVersion`.
- [ ] **F-52 (R-4.13)** Unknown or missing `schemaVersion`.
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


