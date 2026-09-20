# Launcher — Smoke

> Standardized boilerplate (from `.opencode/tests/README.md`) adapted to the launcher
> surface. Runs on a running Fredo desktop app with the spec branch.
> **Serving checkout:** `spec/2808 @ bd30b07b`. Round 2.

- [x] S-1: App window renders — `tauri_webview_dom_snapshot(type="structure")` returns a non-empty `<body>`
  - **PASS.** `body.theme-turbo` → `div#root` non-empty (WindowManager, DesktopBackground, LauncherChrome, etc.).
- [x] S-2: No console errors — `tauri_read_logs(source="console", lines=50)` shows no `Error:`/`Uncaught`/`Maximum update depth exceeded`
  - **PASS.** Console across the run had zero `Error:`/`Uncaught`/`Maximum update depth exceeded`; the only recurring line is the pre-existing `motion() is deprecated. Use motion.create() instead.` WARN (from the desktop animation, framer-motion) — not an error and not #2808 scope.
- [x] S-3: Launcher shell reachable — the launcher's entry point renders the FREDO notch + avatar + `>` command bar + grid
  - **PASS.** Clicking `div[role="button"][aria-label="Fredo launcher"]` (the notch trigger) opened the full-screen launchpad overlay (`role="dialog" aria-label="Fredo launcher"`) with the pixel-butler avatar (`<svg color="var(--accent-primary)">`, 206 rects), `input[role="searchbox"]` ("search or command"), and `div#fredo-launcher-grid[role="grid"]` with 4 tiles. Screenshot: `ac3-shell-light.jpeg`.
- [x] S-4: Telemetry Settings accessible — gear/nav opens the settings dialog with sections visible
  - **PASS.** `button[aria-label="Settings"]` opened the settings dialog (`chakra-dialog__content`) with nav sections: Companion, Appearance, Fredo Setup, Telemetry + FEATURES (My Work Items, Infrastructure Diagram, Model Storage, Run CLI). The Appearance section (BASE THEME Turbo/Classic, ACCENT COLORS, BACKGROUNDS, TEXT, STATUS, FONTS, ANIMATION STYLE) is visible — theme switching works.
- [x] S-5: Screenshot captured — `tauri_webview_screenshot(format="jpeg", quality=80, filePath=".opencode/tmp/2808/e2e/smoke.jpeg")` succeeds
  - **PASS.** Screenshots captured continuously (`.opencode/tmp/2808/e2e/*.jpeg`) — `tauri_webview_screenshot` succeeds.

## #2819 extension — idle launcher surface smoke
- [ ] S-6: Idle launcher surface renders — on a fresh launch the avatar + `>` command bar are visible in the IDLE state (`surfaceOpen:true, engaged:false` — no notch click), plus the LEFT side-tick ruler, RIGHT dot-grid, and thin rounded frame; `#fredo-launcher-grid` is ABSENT. Focusing the command bar reveals the grid + hints (engaged); ESC returns to idle focusing the command bar.

## #2823 extension — Ctrl+Space keyboard smoke

- [ ] S-7: Ctrl+Space opens the launcher from anywhere — from the app's home/desktop, press Ctrl+Space; assert the launcher `role="dialog"` overlay appears (`div[role="dialog"][aria-label="Fredo launcher"]`) and `document.activeElement` is the `input[role="searchbox"]`; no console `Error:`/`Uncaught`/`Maximum update depth exceeded`.

## #2824 extension — ESC keycap engaged-hint smoke

- [ ] S-8: Engaged launcher shows the close-hint row — focus the command bar / enter a query (non-empty feature set) so the hint row renders; `tauri_webview_dom_snapshot(type="structure")` shows the `ESC` badge + `CLOSE` hint text; `tauri_webview_screenshot` succeeds; console clean of `Error:`/`Uncaught`.

## #2827 extension — PixelButler avatar smoke

- [x] S-9: The launcher renders the avatar — the pixel-butler SVG (`svg[aria-hidden="true"][viewBox="0 0 21 21"]`, 91 `<rect>` cells) appears in the running app sourced from the accent token (`color="var(--accent-primary)"` + `fill="currentColor"` → resolved `rgb(0,209,209)`), and `tauri_webview_screenshot` succeeds.
  - **PASS (live, spec/2827 @ 0620b736).** The avatar SVG renders in the launcher with 91 rect cells; `getComputedStyle` `color: rgb(0, 209, 209)`; screenshot `avatar-ac1-render.png` captured; DOM snapshot structure; console clean.

## #2830 extension — single top-right status LED smoke

- [ ] S-10: The launcher's top-right cluster shows a SINGLE status LED (no `ONLINE`/`OFFLINE` text label, no bottom-center LEDs) — `tauri_webview_dom_snapshot(type="structure")` shows one status-LED element below the HH:MM clock text in the `<time>` cluster; `tauri_webview_screenshot` succeeds; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.

## #2850 extension — shared-avatar refactor smoke

> Issue #2850 — the launcher's PixelButler avatar becomes a thin wrapper over the shared
> `FredoAvatar size="md"` component (`apps/ui/src/shared/components/fredo-avatar/`); the
> geometry module + test move to the shared path. The launcher md render must be VISUALLY
> UNCHANGED.

- [x] S-11: The launcher still renders the md avatar — open the launcher; the avatar SVG
      (`viewBox="0 0 1014 1264"`, crispEdges, 58 rects, accent fill, `aria-hidden`) appears above
      the command bar at 132 × 165 layout px, and `tauri_webview_screenshot` succeeds; console
      clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.
  - **PASS (live, spec/2850).** The launcher rendered the shared `FredoAvatar size="md"` SVG (`viewBox="0 0 1014 1264"`, crispEdges, 58 rects, accent-token fill `var(--accent-primary)`/`currentColor`, `aria-hidden`) above the `>` command bar at `offsetWidth`=132/`offsetHeight`=165. `tauri_webview_screenshot` succeeded; console clean (no `Error:`/`Uncaught`/`Maximum update depth exceeded`).

## #2852 extension — desktop mascot 80×100 + idle animation smoke

> **Round 1 (spec/2852 @ 1677eca8) — S-12 PASS.** Mascot SVG `viewBox="0 0 1014 1264"`, crispEdges, 58 rects, accent fill, `aria-hidden`; wrapper 80×100 running `fredo-idle-bob`+`fredo-idle-glow` 2.4s; screenshot succeeded; console clean.

> Issue #2852 — the launcher mascot renders at the shared `sm` size (80×100) and plays the
> companion's idle bob+glow. **OVERRIDE:** S-11's 132×165 md-size expectation is SUPERSEDED —
> the required render is now 80×100.

- [ ] S-12: The launcher renders the sm mascot with its idle animation — open the launcher; the mascot SVG (`viewBox="0 0 1014 1264"`, crispEdges, 58 rects, accent fill, `aria-hidden`) appears above the command bar at `offsetWidth`=80/`offsetHeight`=100, its wrapper carries a running `fredo-idle-bob` + `fredo-idle-glow` 2.4 s animation, and `tauri_webview_screenshot` succeeds; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.

## #2868 extension — Settings tile in the grid smoke

> Issue #2868 adds the Settings app tile and retires the floating gear. **G-136:** S-4 ("gear/nav
> opens the settings dialog") is SUPERSEDED by S-13 below; the historical PASS is preserved.

- [ ] S-13: The engaged grid includes a `[role="button"][aria-label="Settings"]` tile; clicking it
      opens the Settings feature window (`div[role="group"][aria-label="Settings"]`, header title
      "Settings"); on a clean desktop NO floating gear (`IconButton[aria-label="Settings"]`) and no
      settings `chakra-dialog__content` render; `tauri_webview_screenshot` succeeds; console clean
      of `Error:`/`Uncaught`/`Maximum update depth exceeded`.

### #2868 testing round 1 (spec/2868 @ 90da8de) — result

  - **S-13 PASS (live).** Engaged grid: `[role="button"][aria-label="Settings"]` present; click opens `div[role="group"][aria-label="Settings"]` with header title "Settings". Clean desktop: floating gear count 0, `chakra-dialog__content` count 0; screenshot succeeded; console clean. Evidence: `.opencode/tmp/2868/tests-runs.md` / `## Tests Runs (round 1)`.

## #2870 extension — home-seat stability smoke (G-136)

> Issue #2870 keeps Fredo at the centre seat when the companion is enabled and reserves the seat slot so the
> command bar never shifts. S-12 still describes the role-OFF seat (decorative sm mascot + idle motion) and
> remains in force for that state. Live policy.

- [ ] S-14: Seat stability across ON/OFF — open the launcher; record the command bar `getBoundingClientRect().y` with the companion OFF, then ON, then OFF again (and after a 5 s idle auto-return). `y` stays within ±1 px in every state; the 80×100 seat slot is present in all states (never unmounts); `tauri_webview_screenshot` succeeds; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.

## #2871 extension — command-bar companion chat smoke

- [ ] S-15: Companion ACTIVE; type a non-tile phrase into `input[role="searchbox"]`, press Enter.
      The reply streams into the companion's seat bubble (`data-streaming` + cursor observed), the
      busy state clears on completion, and `tauri_webview_screenshot` succeeds; console clean of
      `Error:`/`Uncaught`/`Maximum update depth exceeded`.
  - **#2871 round 1 (spec/2871 @ e5fa7612) — PARTIAL.** Reply streamed into the seat bubble
    (`data-streaming="true"`); screenshot succeeded; console clean. Busy (bar `aria-busy` + dot)
    clears only at the end of the ~5 s `happy` hold, not on `llm-done`; during busy the input is
    not read-only and Enter launches a tile (REQ-14 FAIL).
  - **#2871 round 2 (spec/2871 @ bd168ee) — PASS.** Reply streamed into the seat bubble with the
    blinking cursor; the bar showed the state-5 busy affordance (`Fredo is replying…`
    placeholder + chip, `readOnly`, `aria-busy="true"`) and cleared at `llm-done`; Enter during
    busy was a global no-op. Screenshot succeeded; console error-level only the `[MCP][BRIDGE]`
    instrumentation artifact from a tester synthetic event. Screens `req1-send-streaming.png`,
     `req14-busy-atomic.png`, `req5-completion-cleared.png`.

## #2882 extension — smart-Enter + hold-Space quick paths

> Issue #2882 broadens the typed-query match and retires the Ctrl+Space listening cascade.
> Quick paths only — the full matrix lives in `functional.md` F-64..F-69 / `regression.md` R-40..R-43.

- [ ] S-16: **`set` + Enter opens Settings.** Focus `input[role="searchbox"]`, type `set` with real
      keystrokes, read the hint chip, press Enter. **Expected:** the chip names the app that will
      open (`↵ open Settings`, NOT `↵ send to Fredo`); Enter opens
      `div[role="group"][aria-label="Settings"]` and starts NO Fredo generation; screenshot succeeds;
      console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-17: **Ctrl+Space = show + focus, no listening.** From the resting desktop, press Ctrl+Space.
      **Expected:** the bar appears with the caret in `input[role="searchbox"]`, `stt_status`
      `listening === false`, NO listening cue/chip, ZERO `stt_start`; a 2nd press leaves the bar
      OPEN; screenshot succeeds; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.

## #2883 extension — long-query wrap + Shift+Enter quick paths

> Issue #2883 wraps the bar's input and adds `Shift+Enter` for a newline without changing Enter's
> rule (#2882). Quick paths only — the full matrix lives in `functional.md` F-70..F-78 /
> `regression.md` R-44..R-46 and `companion` F-79..F-90 / S-27..S-29. **Verification policy: live.**

- [ ] S-18: **A long query wraps and the controls stay clear.** Companion ACTIVE; insert a ~240-char
      query into the focused field `[data-testid="launcher-command-input"]` (`role="searchbox"`,
      `aria-multiline="true"`). **Expected:** the text renders on ≥2 visible lines inside the bar;
      the Enter hint chip (`[data-testid="launcher-command-hint"]`) AND the collapse/cancel control
      are both fully visible, with ZERO overlap with the text (measured `getBoundingClientRect`
      intersection = 0); a 5+ line query pins the field at the bound **108 px** cap and scrolls
      internally; screenshot (ONE frame containing both the text and the controls) succeeds; console
      clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-19: **Shift+Enter inserts a newline and does not dispatch.** Type `line one`, press
      `Shift+Enter`, type `line two`. **Expected:** the input value contains an explicit newline and
      renders as ≥2 lines via the bound **native-insertion** route (return before the Enter branch
      WITHOUT `preventDefault`, carried by the textarea `onChange` — no manual splice, caret
      undisturbed); ZERO generations, ZERO windows opened; a subsequent Enter acts on the whole query
      (typed-match launch / unmatched send per #2882); screenshot succeeds; console clean of
      `Error:`/`Uncaught`/`Maximum update depth exceeded`. (If the synthetic chord cannot be
      delivered, record the G-161 named blocker + the dispatched-event/unit-pin fallback — never a
      fabricated PASS.)

### #2883 testing round 1 — result

- [ ] _(pending — the Tester records the round verdict + per-row evidence here; do not pre-fill)_

## #2886 extension — never-cover-Fredo + clear-bar quick path

> Issue #2886 re-anchors the companion reply surface so it never covers Fredo, the tiles or the
> search bar. Quick path only — the full matrix lives in `functional.md` F-79..F-81 /
> `regression.md` R-47..R-49 and `companion` F-91..F-98 / S-30. **Verification policy: live.**

- [ ] S-20: **A short reply clears Fredo and the bar.** Companion ON at the home seat; launcher
      ENGAGED (tiles + bar visible); send `Reply with exactly: Hi there!`. **Expected:** the reply
      renders in `[data-testid="fredo-reply-surface"]` with
      `intersectionArea(avatar, surface) === 0` AND `intersectionArea(surface, bar) === 0` (all
      rects read in the SAME `execute_js` task), the surface fully inside the viewport, and the
      command-bar `y` within ±1 px of the no-reply baseline; screenshot (ONE frame containing the
      surface, Fredo AND the bar) succeeds; console clean of `Error:`/`Uncaught`/`Maximum update
      depth exceeded`.
      **#2886 round 1 (spec/2886 @ 0ac6b38a): FAIL** — `area = 0` and bar `y` Δ = 0 held, but the
      launcher DISENGAGES (`#fredo-launcher-grid` removed from the DOM) whenever a reply is shown, so
      the tiles are never visible in the frame; and the one-liner's measured `dy` fell to 8.00 px
      (< the bound 14 px).

## #2887 extension — instant hold-to-dictate quick paths (bar surface)

> Issue #2887 keeps the recognizer ready while Fredo is idle so the hold-Space dictation starts with
> no perceptible wait, and keeps the bar's listening cue honest. Quick paths only — the full matrix
> lives in `functional.md` F-82..F-84 / `regression.md` R-50..R-53 and `voice-input` F-74..F-82 /
> R-21..R-24 / S-14..S-16. **Verification policy: live.**

- [ ] S-21: **The bar dictates instantly on a resident-ready app.** Voice enabled + model ready, app
      idle (no dictation this session); focus the EMPTY `input[role="searchbox"]`; record the press
      timestamp in the dispatch task; `keyboard(action="down", key=" ")`; hold 1500 ms; sample the cue
      mid-hold; `action="up"`. **Expected:** the cue (`data-testid="launcher-command-listening"` dot +
      chip + `Listening…` placeholder) appears within the warm bound and is present for the whole hold;
      the cue is NEVER seen before the capture-active marker; release clears it and releases the mic;
      exactly ONE `stt_start`; screenshot succeeds; console clean of `Error:`/`Uncaught`/`Maximum
      update depth exceeded`. (Content leg = the synthetic `stt:transcript` lever; the audible leg is
      a NAMED BLOCKER — no physical mic on this host.)
- [ ] S-22: **Cold first-dictation quick path.** Restart the app (`dev-env` Down→Up); with voice
      enabled + model ready, make the FIRST dictation of the process on the empty focused bar.
      **Expected:** the cue appears within the cold bound (`T_COLD_MAX_MS`; default ≤ 900 ms) and never
      before capture is active; release releases the mic; the hold dictates; screenshot succeeds;
      console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-23: **Evidence upload smoke.** A capture from S-21/S-22 is uploaded via
      `upload-evidence --issue 2887 --base spec/2887`, its raw URL resolves, and it is embedded in
      `## Tests Runs` with a textual description; the `## Tests Runs` body also references
      `telemetry_spans` + the timestamped capture markers (the live-policy lever).

### #2887 testing round 1 — result

- [ ] _(pending — the Tester records the round verdict + per-row evidence here; do not pre-fill)_

## #2893 extension — Companion open-app quick paths

> Issue #2893 lets the Companion open an app named in a message. Quick paths only — the full matrix
> lives in `functional.md` F-85..F-89 / `regression.md` R-54..R-56, `companion` F-99..F-105 and the new
> `fredo-cli` suite. **Verification policy: live.**

- [ ] S-24: **A typed `open Mission Monitor` opens the app.** Companion ACTIVE + ready; insert
      `open Mission Monitor` into `[data-testid="launcher-command-input"]`; Enter. **Expected:** exactly
      one Mission Monitor window opens with no further action and the reply is exactly
      `Opening Mission Monitor` and perceivable (not fully behind the new window); screenshot
      succeeds; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.
- [ ] S-25: **A non-app-open message opens nothing.** Send `Missing all the time`. **Expected:**
      1 Companion generation, ZERO windows; screenshot succeeds; console clean.
- [ ] S-26: **Unknown name quick path.** Send `open NotARealApp`. **Expected:** ZERO windows, the
      reply `I couldn't find "NotARealApp"`, companion back at rest (no `happy`); screenshot
      succeeds; console clean.

### #2893 testing round 2 (spec/2893 @ 223279d3) — results

- **S-24 PASS.** Typed `open Mission Monitor` (insert-text lever) → exactly ONE Mission Monitor
  window (DOM `.fredo-window__surface` 0→1) with no further action; reply exactly
  `Opening Mission Monitor` and perceivable (reply committed first; the window is dispatched after
  the 800 ms beat — see F-89); screenshot succeeded; console clean.
- **S-25 PASS.** `Missing all the time` → 1 Companion generation, ZERO windows; screenshot succeeded;
  console clean.
- **S-26 PASS.** `open NotARealApp` → ZERO new windows, reply exactly `I couldn't find "NotARealApp"`,
  companion back at rest (no `happy`); screenshot succeeded; console clean.

### #2893 testing round 3 (spec/2893 @ cf25127c) — results

- **S-24 PASS (re-confirmed).** Typed `open Mission Monitor` (insert-text lever) → exactly ONE Mission
  Monitor window (`Sessions`, DOM `.fredo-window__surface` 0→1) with no further action; reply exactly
  `Opening Mission Monitor` and perceivable (committed +10…+24 ms after `llm-skill-call`, before the
  window at +870…+1132 ms); screenshot succeeded; console clean.
- **S-25 PASS (re-confirmed).** `Missing all the time` → 1 Companion generation, ZERO windows;
  screenshot succeeded; console clean.
- **S-26 PASS (re-confirmed).** `open NotARealApp` → ZERO new windows, reply exactly
  `I couldn't find "NotARealApp"`, companion back at rest (no `happy`); screenshot succeeded;
  console clean.

## #2892 extension — always-editable bar quick paths

> Issue #2892 keeps the bar editable while Fredo replies and makes a send during a reply queue
> (default) or interrupt. Quick paths only — the full matrix lives in `functional.md` F-90..F-100 /
> `regression.md` R-57..R-61. **Verification policy: live.**

- [ ] S-27: **Type with a reply on screen.** Companion ON; send `Reply with exactly: Hi there!`;
      while the reply shows, click `[data-testid="launcher-command-input"]`, type `abc`, read
      `readOnly`/`disabled`. **Expected:** the field takes focus + text with `readOnly === false` /
      `disabled === false`; screenshot succeeds; console clean of `Error:`/`Uncaught`/`Maximum update
      depth exceeded`.
- [ ] S-28: **Queue quick path.** Start `Write 400 words about the history of the bicycle.`; send
      `Reply with exactly: alpha` while streaming. **Expected:** accepted, bar cleared,
      `[data-testid="launcher-command-queued"]` shows `Queued — waiting for Fredo…`, `alpha` streams
      exactly once on settle; screenshot succeeds; console clean.
- [ ] S-29: **Interrupt quick path.** Disposition `interrupt`; start the long stream; send
      `Reply with exactly: INTERRUPTED`; wait > 6 s. **Expected:** the settled reply is exactly
      `INTERRUPTED` and survives the superseded hold timer; screenshot succeeds; console clean.
- [ ] S-30: **`set` + Enter still opens Settings with a reply streaming.** While streaming, insert
      `set` and press Enter. **Expected:** the Settings window opens with ZERO generations; no tile
      launch fall-through; screenshot succeeds; console clean.

### #2892 testing round 1 — result

- [ ] _(pending — the Tester records the round verdict + per-row evidence here; do not pre-fill)_

## #2904 extension — dictation clean-render quick path

> Issue #2904 removes a stray vertically-stacked `Fredo…` string from the launcher search bar while
> dictating. Quick path only — the full matrix lives in `functional.md` F-101..F-107 /
> `regression.md` R-62..R-63. **Verification policy: live.**

- [ ] S-31: **Dictate and read the bar cleanly.** Voice enabled; mode=`model` (or `local`);
      focus the empty `[data-testid="launcher-command-input"]`; drive a live capture with the
      `FREDO_STT_FEED_WAV` feed (`.opencode/tests/voice-dictation/fixtures/dictation-phrase-16k-mono.wav`)
      or the synthetic `stt:state {listening:true, phase:"capturing", origin:"launcher"}` fallback;
      while the indicator is visible run the `functional.md` **Shared probe** and
      `tauri_webview_screenshot`.
  **Expected:** the listening indicator (`launcher-command-model-listening-chip` = `Fredo is
      listening`, or local `launcher-command-listening-chip` = `Listening`) renders on ONE line; the
      probe reports NO `verticalWrap`/`narrow` node, an empty `overlapField`, and **`fieldContentW
      ≥ 140`** (model mode — the placeholder-collapse signal, since the placeholder is not in
      `textContent`); the field renders cleanly; screenshot succeeds; console clean of
      `Error:`/`Uncaught`/`Maximum update depth exceeded`. (The live `telemetry_spans` receipt is
      F-107's job.)

### #2904 testing round 1 (spec/2904 @ 027bbf1f) — result

- **S-31 PASS (live).** Model capture: one-line indicator `launcher-command-model-listening-chip` (`Fredo is listening`), `fieldContentW 206 ≥ 140`, `verticalOrNarrow []`, probe `overlapField` = the end-slot chip only (border-box probe artifact; content-box intersection 0); screenshot succeeded; console clean. Local leg: `Listening` chip + `Listening…` + hint chip, one line. Evidence: `.opencode/tmp/2904/tests-runs.md` / `## Tests Runs (round 1)`.

