# Wireframe — Exploratory

Feature domain: `wireframe` (the paged wireframe editor: document model, Konva canvas,
property panel, view/file commands, 22 element hotkeys, one Companion skill).
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
      in the field, and is the wireframe hotkey attribute set restored correctly when focus leaves?
- [ ] **E-8 Hotkey churn across windows.** Open Wireframe + Mission Monitor, toggle focus 20×
      while pressing keys. Does `data-fredo-hotkey-count` ever stick, does
      `data-fredo-hotkey-duplicate` ever appear, and does any key land in the wrong app?
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

## Teardown (run after this suite)

- [ ] Close every Wireframe window, delete the probe fixtures under
      `.opencode/tmp/3070/e2e/` that are not part of the functional plan, restore the appearance
      preset to the served default, and `Down` the isolated env. Confirm no settings key, DB row
      or capability file was left modified by a probe.
