# Companion — Functional

> Durable functional suite for the desktop companion overlay feature domain (Spec #2850 —
> companion adopts the shared FREDO vector avatar; legacy raster sprite pipeline + dead
> settings/state deleted). One `- [ ]` case per observable behavior; rows map 1:1 to the QA
> Plan in `.opencode/tmp/2850/triage.md` `## QA Expert` (Q-2..Q-20).
> **Verification policy: live** — every row is provable only on a running system. Evidence
> per case: `tauri_webview_dom_snapshot` + `tauri_webview_screenshot` + `tauri_webview_interact`/
> `tauri_ipc_monitor` capture + `tauri_read_logs(source="console")`. The tester's Evidence MUST
> reference `telemetry_spans` (a live-query result via the telemetry-query skill) — the
> mandatory LIVE-EVIDENCE LEG (F-17) is the receipt; a static-only PASS is a FALSE PASS.
> **Serving checkout:** `spec/2850` on a running Fredo desktop app (dev-env Up -Spec 2850,
> MCP driver `com.fredo.app`). LLM model + mmproj present/loaded for F-7/F-8; Run CLI/terminal
> window for F-10.

## F-1 (Q-2 / AC-1) — Companion imports the shared canonical avatar

- [ ] F-1: Grep `apps/ui/src/shared/components/companion/**` + `apps/ui/src/main.tsx` +
      `apps/tauri/src/main.tsx` for the avatar source. **Expected:** the companion renders the
      avatar from the shared `apps/ui/src/shared/components/fredo-avatar/` module (imported from
      there, or re-exported through `@fredo/ui`); NO local `spritesheet` raster / duplicate
      rect-table implementation remains under the companion; the geometry module is exported
      from `apps/ui/src/index.ts`. A second base-rect geometry table under the companion (or
      anywhere outside `shared/fredo-avatar/`) is a FAIL.
  - **Edge:** the move is import-only — no cross-feature import (`features/*`); the shared
    component accepts the size prop (`sm`) and renders the 1014×1264 viewBox.

## F-2 (Q-3 / AC-2) — Neutral idle pixel-consistency (companion sm vs launcher md)

- [ ] F-2: Render the companion (sm) idle in the SAME theme as the launcher (md) idle.
      `tauri_webview_execute_js` reads every mounted avatar `<rect>` (x/y/width/height) in both
      SVGs; screenshot both at the neutral frame (transform:0 / paused). **Expected:** the two
      SVGs carry the IDENTICAL 58-rect coordinate set (only element width/height scale differs);
      `shapeRendering="crispEdges"` on both; single accent fill via
      `color="var(--accent-primary)"` + `fill="currentColor"`; NO state overlay present in idle.
  - **Edge:** repeat in a light preset AND the dark base; a bob/glow animation (if implemented)
    is whole-element transform only — the neutral gate uses the transform:0 frame, never a
    mid-animation frame.

## F-3 (Q-4 / AC-2) — Four states visually distinguishable; base rects frozen across states

- [ ] F-3: Trigger each state and capture DOM + screenshot per state: idle (no overlay),
      talk (mouth overlay in the hollow lower-face region), teleport-out (closed-eye lines +
      shrink/fade + ≤1-frame energy streak), teleport-in (sparkle highlights + grow-in + settle).
      **Expected:** the four state DOMs differ ONLY by the expression overlay `<g>`/whole-element
      transform — probe the DOM rect set in each state: the 58 base rects are byte-identical
      across ALL four states (the UI/UX frozen-geometry invariant). A viewer can read the state
      from a glance at the 80×100 sm scale; idle = base figure only.
  - **Edge:** the mouth (talk) must be legible at sm (no subpixel smear — crispEdges); the
    teleport-out brightness flash shows ≤1 frame; the mouth keyframe (~180 ms per half-cycle)
    runs only WHILE streaming.
  - **Edge (a11y):** the interactive avatar wrapper is keyboard-focusable with an accessible name
    describing the three gestures; the state is exposed via the wrapper's label/data-state;
    `:focus-visible` uses an accent outline; the decorative `<svg>` stays `aria-hidden`.

## F-4 (Q-5 / AC-3) — sm ≈ 80 × 100; md = 132 × 165 from the SAME shared size prop

- [ ] F-4: Measure the companion avatar layout size (`offsetWidth`/`offsetHeight` per G-040,
      never a transform-scaled `getBoundingClientRect`). **Expected:** companion `offsetWidth` =
      80, `offsetHeight` = 100 (`Math.round(80 × 1264/1014)`); launcher md `offsetWidth` = 132,
      `offsetHeight` = 165; aspect 1014:1264 in both — undistorted, no letterbox/stretch. Height
      derives from the ONE shared aspect constant (`AVATAR_ASPECT_W/H`), never a separate literal.
  - **Edge:** measure at 100% OS scale AND at a fractional zoom/DPI — sm stays crisp (uniform
    crisp cells, no anti-alias fill-in of fragmentation gaps); the sm avatar is NOT clipped by an
    old 80×80 click-frame.

## F-5 (Q-7 / AC-3) — Click-target / teleport clamp / bubble anchor use the real rendered width AND height

- [ ] F-5: (a) Click-target: the interactive wrapper's box = 80×100 sm. (b) Teleport clamp:
      Ctrl+right-click at `(innerWidth−1, innerHeight−1)` clamps so the FULL avatar stays
      on-screen — `y ≤ innerHeight − 100` (the +20 px sm height vs the old 80×80 square must be
      respected). (c) Bubble anchor: `companionWidth`/`companionHeight` passed to `SpeechBubble`
      are the real dims (80/100), so the bubble tail tip sits at the avatar's TRUE vertical center
      (`cy + 50` for sm, not `cy + 40`).
  - **Edge:** grep `FredoCompanion.tsx` + `SpeechBubble` call site for a bare hardcoded `80` in
    the clamp/anchor/click-target — a leftover 80×80 literal is a FAIL. Window resize mid-idle:
    the next teleport/bubble re-derives from the measured size. DPI/zoom: the clamp in CSS px
    matches the rendered avatar.

## F-6 (Q-8 / AC-3) — Teleport timing preserved (out ~400 ms, hidden in transit, in ~400 ms + settle)

- [ ] F-6: Drive a same-window teleport; sample the avatar wrapper's state string
      (`aria-label` suffix / `data-state`) every ~50 ms with wall-clock timestamps
      (`tauri_webview_execute_js`). **Expected:** sequence `idle → teleport-out → (hidden in
      transit) → teleport-in → idle`; out ≈ 400 ms, in ≈ 400 ms + ~50 ms settle, then idle
      (tolerance ±150 ms for timers/paint). Source constants unchanged: `ANIM_DURATION` =
      idle:800 / talk:500 / teleport-out:400 / teleport-in:400.
  - **Edge:** a hidden-in-transit gap exists between out and in (avatar not rendered in either
    state during the ~50 ms gap); no talk/idle fires mid-teleport (`isTeleportingRef` guard);
    no timing drift across 3 consecutive teleports.

## F-7 (Q-9 / AC-4, M3) — Single-click → joke streams + talk expression (telemetry-backed)

- [ ] F-7: Start `tauri_ipc_monitor`; single-click the companion (no second click within 250 ms).
      **Expected:** `llm_chat` invoke captured (IPC) with the joke system+user messages; the
      companion state flips to talk and the mouth keyframe runs; joke tokens stream into the
      240×120 bubble char-by-char; the streaming cursor (2×14 px accent block) blinks on
      `Fredo-cursor-blink` 0.9s; on `llm-done` the mouth closes, talk holds ~5 s, then idle + the
      bubble closes. Console clean (no `Error:`/`Uncaught`/`Maximum update depth exceeded`).
  - **Edge:** double-click does NOT fire the joke (F-8); a model-mid-load
    `⏳ Loading model...`/3s-retry path ends in a stream or a clean done (no stuck talk/cursor);
    `<end_of_turn>`/`<start_of_turn>` control tokens are stripped from the displayed bubble text.

## F-8 (Q-10 / AC-4, M4) — Double-click → TicTacToe; single-vs-double discrimination (telemetry-backed)

- [ ] F-8: Start `tauri_ipc_monitor`; double-click the avatar (2 clicks ≤ 250 ms apart).
      **Expected:** TicTacToe opens in the 208×268 game bubble; the single-click timer is
      cancelled — NO joke fires (`askForJoke` not called). Play one move: click a cell as X →
      Fredo (O) replies via `capture_screen_region` + `llm_chat_with_image` (IPC captures both),
      the O lands in a legal empty cell, and the turn/status text updates.
  - **Edge (discriminator boundary):** a ~260 ms gap = single (joke fires); a ~240 ms gap =
    double (game toggles, no joke) — test BOTH sides of the 250 ms threshold. Game-open click
    churn does not leak a stray joke. A model/image-capture error falls back to a legal random
    move (no crash; status text reflects the error path).

## F-9 (Q-11 / AC-4, M5) — Ctrl+right-click same-window teleport (telemetry-backed)

- [ ] F-9: Start `tauri_ipc_monitor`; Ctrl+right-click a point in the main window. **Expected:**
      `companion-teleport` emitted (Tauri) with `{ toWindow: 'main', x, y }` (IPC capture), or a
      local `startTeleportOut` in dev; observable sequence per F-6 (out → hidden → in → idle);
      the avatar lands clamped (F-5) at the clicked point; timing "as today".
  - **Edge:** with the terminal window ALSO open, a same-window (`toWindow === MY_WINDOW`)
    teleport animates ONLY the active window (the terminal companion stays hidden); a click near
    each screen edge clamps on all four sides; a right-click WITHOUT Ctrl does nothing (the
    context menu is suppressed only under Ctrl).

## F-10 (Q-12 / AC-4, M6) — Cross-window teleport main ↔ terminal (telemetry-backed)

- [ ] F-10: Launch Run CLI once so the `run-cli-terminal` (`index.html?view=terminal`) window
      exists (`tauri_manage_window(action="list")` = main + run-cli-terminal). The companion is
      MOUNTED-BUT-HIDDEN in the terminal window until arrival (present-but-not-visible / not
      rendered) while visible in main. Ctrl+right-click in the TERMINAL window. **Expected:**
      main plays teleport-out (~400 ms) then the companion disappears from main; the terminal
      companion becomes visible and plays teleport-in (~400 ms + settle) then idle at the clamped
      point; after arrival the companion is visible ONLY in terminal (hidden in main). Mirror
      back (Ctrl+right-click in main): terminal plays out+hide, main plays in. Console clean in
      BOTH windows.
  - **Edge:** teleport while a bubble/TicTacToe/joke is open in the source window (state cleaned
    on out); two rapid cross-window teleports (no double-mount/ghost in either window); closing
    the terminal window mid-transit → no crash, main companion recovers.
  - **Environment note:** if Run CLI cannot be launched in the environment (plugin/binary
    missing), report F-10 BLOCKED-environment — never convert to a same-window-only PASS (M6
    needs the real two-window choreography).

## F-11 (Q-13 / AC-4, M7) — Bubble side-choosing + on-screen anchoring at each edge (new sm aspect)

- [ ] F-11: Teleport the companion next to each viewport edge and trigger a message. **Expected:**
      side ranking preserved (`above > right > left > below`); near the BOTTOM edge the bubble
      opens ABOVE; near the RIGHT edge to the LEFT; near the LEFT edge to the RIGHT; near the TOP
      per the ranking. The bubble is always fully on-screen (margin clamp), and the tail anchors
      to the avatar's TRUE center under the new 80×100 frame (tail tip ≈ `cy + 50` for an
      above/below bubble).
  - **Edge:** the +20 px taller sm frame shifts `above`/`below` placement ~20 px vs the old
    square — the derived anchor keeps the tail on the figure (no floating tail); the bubble stays
    within the viewport at 1920×1080 AND a small/narrow window; the game bubble (208×268) at each
    edge stays on-screen too.

## F-12 (Q-14 / AC-5, M8) — Settings → Companion: visibility + teleport tip ONLY

- [ ] F-12: Open the settings modal (gear) → Companion; DOM + screenshot the section.
      **Expected:** ONLY the visibility toggle ("Show Fredo Companion") + the teleport tip
      ("Hold Ctrl and right-click anywhere…") + (retained) the model-missing warning banner. NO
      "Speech bubble color" section, NO preset color swatches, NO custom `<input type="color">`,
      NO live preview swatch.
  - **Edge:** toggle off → companion hides; toggle on → companion returns; the model-missing
    banner still gates the toggle and opens Setup; no orphan section/nav item remains; console
    clean.

## F-13 (Q-15 / AC-5) — Legacy persisted keys tolerated/inert on existing installs

- [ ] F-13: Pre-seed `Fredo_companion_color` = a legacy value (`#22d3ee`) AND a malformed value
      (`#zzz`/`garbage`), and `Fredo_companion_auto_walk` = `true`, in localStorage AND via the
      AppStore `save_setting` path. Relaunch. **Expected:** app boots clean (no
      `Error:`/`Uncaught`); the companion renders; the bubble border/tail/cursor follow
      `var(--accent-primary)` — the seeded color is IGNORED (never read, never applied); no
      auto-walk behavior exists; the keys stay present but INERT (never re-written or deleted by
      any component).
  - **Edge:** open the settings modal while the keys are seeded — no crash; the SQLite AppStore
    values are equally tolerated (seeded via the `get_setting`/`save_setting` path).

## F-14 (Q-16 / AC-5, M9) — Theme light↔dark + changed accent re-tint (no stale color)

- [ ] F-14: Render the companion (avatar + a streaming/static bubble) under a light preset
      (`light-default`), the dark base (`classic`/`dark`), and a changed accent (Matrix preset or
      an explicit accent override via the shipped `ThemePresetSelector`). Capture each.
      **Expected:** avatar + bubble border + tail + streaming cursor ALL derive from the SAME
      `--accent-primary` token and re-tint together on every change; bubble body stays
      `var(--card-bg)` with `var(--text-primary)` text; legible in both themes (border/tail/cursor
      vs the bubble body ≥ 3:1; text ≥ 4.5:1); no per-feature color override remains.
  - **Edge:** re-theme WHILE a bubble is open and WHILE streaming — the open bubble re-tints live
    with no stale color; re-theme mid-teleport does not distort the avatar; no
    `var(--accent-primary)NN` alpha-append anywhere.

## F-15 (Q-17 / AC-5) — Zero hardcoded hex/rgba in the changed companion files

- [ ] F-15: Static grep of the changed companion/avatar/settings files
      (`shared/components/companion/**`, `shared/components/fredo-avatar/**`,
      `CompanionContext.tsx`, `CompanionSettingsPanel.tsx`) for `#[0-9a-fA-F]{3,8}`, `rgba(`,
      `rgb(`, `hsla(`. **Expected:** ZERO hardcoded color literals (comment issue-refs exempt);
      colors flow theme token → CSS var + the shared `tint()` helper for translucent accent
      surfaces; the SpeechBubble default `color` prop = `var(--accent-primary)`.
  - **Edge (known pre-existing literals in scope):** the model-warning banner
    `bg="rgba(239,68,68,0.12)"`/`borderColor="rgba(239,68,68,0.3)"`
    (CompanionSettingsPanel.tsx:134-136), `boxShadow="0 4px 24px rgba(0,0,0,0.45)"`
    (SpeechBubble.tsx:130), and the TicTacToe `whiteAlpha.*`/`blue.300`/`red.400` X/O colors
    must be token-native (`tint()`, `--status-*`, accent tokens) if the Architect scopes them in;
    any literal left in the listed files = FAIL (see the QA Expert Discussion point on cleanup
    scope).

## F-16 (Q-18 / AC-4, M10) — Dev mode (non-Tauri): renders, local teleport, joke streams

- [ ] F-16: Serve the UI via the Vite dev server (`pnpm dev:ui`, DevAdapter, no Tauri host).
      **Expected:** the companion renders (sm avatar + idle); single-click streams a MOCK joke
      token-by-token (DevAdapter interval) into the bubble with the cursor blinking; double-click
      opens TicTacToe and Fredo answers (DevAdapter returns the center `4`); Ctrl+right-click
      teleports LOCALLY (`startTeleportOut`) with NO `companion-teleport` broadcast attempt and NO
      crash on the `import('@tauri-apps/api/event')` path (the `IS_TAURI` guard must select the
      dev path).
  - **Edge:** console has no `Uncaught` from the missing Tauri API; the settings model-gate
    behaves in dev (`check_model_files` invoke no-ops → the warning banner may show; the companion
    toggle stays reachable).

## F-17 (Q-19 / LIVE-EVIDENCE LEG) — Mandatory live telemetry receipt (same run as F-2..F-16)

- [ ] F-17: While the companion surface is exercised (same session/window-set as the live legs),
      `fredo emit --event-type chat` + `--event-type tool_use` with distinct session ids; then
      query the RTDB row tables + `telemetry_spans`. **Expected:** both events `{"queued":true}`
      and classify into `chat_rows`/`tool_use_rows` under the injected session ids;
      `telemetry_spans` returns a NON-ZERO count with a recent `max(timestamp)` — the live
      span-store proof (mirrors #2817 F-5e / #2819 F-14: `fredo emit` bypasses OTLP so the
      injected session appears in the ROW tables; `telemetry_spans` is the live store reference).
  - **Exit-gate note:** a static-only PASS with no F-17 receipt is a FALSE PASS under the live
    policy.

## F-18 (Q-20 / AC-6) — Build + suite gates (geometry suite at the shared path)

- [ ] F-18: `pnpm --filter @fredo/ui build` → zero TS errors; `pnpm --filter @fredo/ui test:run`
      → green (the moved `fredoAvatarGeometry.test.ts` under `shared/fredo-avatar/__tests__/` +
      all existing suites); repo grep for the removed assets/keyframes/fields/keys → zero.
  - **Edge:** a dangling import of the deleted `spritesheet.png`/keyframe name/Context member
    anywhere (incl. `__tests__` fixtures) is a FAIL; Rust `cargo check` zero warnings if Rust is
    touched.

## F-19 (Q-22 / NF) — Console hygiene, no re-render loop, reduced-motion leg

- [ ] F-19: After EVERY live leg read `tauri_read_logs(source="console")`. Drive a
      reduced-motion pass (`prefers-reduced-motion: reduce`) and re-run the F-3/F-6 state legs.
      **Expected:** NO `Error:`/`Uncaught`/`Maximum update depth exceeded` in any leg/window; no
      re-render loop from the new state/expression code (AGENTS.md #523 — effects never depend on
      array `.length` or freshly-created object refs); under reduced motion the idle bob/glow and
      the teleport-in settle wobble are suppressed, teleport degrades to an opacity crossfade
      (~400 ms, still distinguishable), and the mouth keyframe slows but functions.
  - **Edge:** console read after EACH leg (a stream-end or teleport-race error only appears
    post-interaction); check BOTH windows (main + terminal); the pre-existing
    `motion() is deprecated` WARN is exempt.
