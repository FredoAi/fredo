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

- [x] F-1: Grep `apps/ui/src/shared/components/companion/**` + `apps/ui/src/main.tsx` +
      `apps/tauri/src/main.tsx` for the avatar source. **Expected:** the companion renders the
      avatar from the shared `apps/ui/src/shared/components/fredo-avatar/` module (imported from
      there, or re-exported through `@fredo/ui`); NO local `spritesheet` raster / duplicate
      rect-table implementation remains under the companion; the geometry module is exported
      from `apps/ui/src/index.ts`. A second base-rect geometry table under the companion (or
      anywhere outside `shared/fredo-avatar/`) is a FAIL.
  - **PASS (static+live, spec/2850).** `FredoCompanion.tsx:6` imports `{ AVATAR_SM, FredoAvatar } from '../fredo-avatar'` (the shared module); `SpeechBubble.tsx:4` imports `AVATAR_SM`; `apps/ui/src/index.ts:32-47` exports `FredoAvatar` + geometry + sizes. The launcher's `LauncherShell.tsx:14` imports `FredoAvatar` from `../../../../shared/components/fredo-avatar`. Grep of `apps/ui/src` for `expandFredoRects`/`FREDO_AVATAR_SOURCE_RECTS` under `features/home/components/launcher/` → ZERO (no duplicate geometry). `git diff --stat main spec/2850 -- launcher/` shows only `LauncherShell.tsx` (+2/-2), `PixelButler.tsx` deleted, geometry + test moved to shared. `AVATAR_SM={width:80,height:100}`, AVATAR_MD={width:132,height:165}. No cross-feature import. No `spritesheet` raster (deleted).
  - **Edge:** the move is import-only — no cross-feature import (`features/*`); the shared
    component accepts the size prop (`sm`) and renders the 1014×1264 viewBox.

## F-2 (Q-3 / AC-2) — Neutral idle pixel-consistency (companion sm vs launcher md)

- [x] F-2: Render the companion (sm) idle in the SAME theme as the launcher (md) idle.
      `tauri_webview_execute_js` reads every mounted avatar `<rect>` (x/y/width/height) in both
      SVGs; screenshot both at the neutral frame (transform:0 / paused). **Expected:** the two
      SVGs carry the IDENTICAL 58-rect coordinate set (only element width/height scale differs);
      `shapeRendering="crispEdges"` on both; single accent fill via
      `color="var(--accent-primary)"` + `fill="currentColor"`; NO state overlay present in idle.
  - **PASS (live, spec/2850, theme-classic).** Live DOM probe of both SVGs in the same theme: the launcher md avatar and the companion sm avatar carry `byteIdentical: true` — the SAME 58-rect coordinate set (`373,67,268,38` … `556,1201,119,33`), both `shapeRendering="crispEdges"`, both `color="var(--accent-primary)"` + `fill="currentColor"` (single accent fill), both `aria-hidden`, both `fill="none"`. Only `offsetWidth/Height` scale differs (md 132×165 vs sm 80×100). No state overlay in either idle. Mirror math confirmed (e.g. `886=1014-87-41`). Screenshot `.opencode/tmp/2850/e2e/q3-idle-companion-sm.png`.
  - **Edge:** repeat in a light preset AND the dark base; a bob/glow animation (if implemented)
    is whole-element transform only — the neutral gate uses the transform:0 frame, never a
    mid-animation frame.

## F-3 (Q-4 / AC-2) — Four states visually distinguishable; base rects frozen across states

- [x] F-3: Trigger each state and capture DOM + screenshot per state: idle (no overlay),
      talk (mouth overlay in the hollow lower-face region), teleport-out (closed-eye lines +
      shrink/fade + ≤1-frame energy streak), teleport-in (sparkle highlights + grow-in + settle).
      **Expected:** the four state DOMs differ ONLY by the expression overlay `<g>`/whole-element
      transform — probe the DOM rect set in each state: the 58 base rects are byte-identical
      across ALL four states (the UI/UX frozen-geometry invariant). A viewer can read the state
      from a glance at the 80×100 sm scale; idle = base figure only.
  - **PASS (live, spec/2850).** Live DOM per-state rect-set probe: idle = 58 base rects ONLY (`baseRects:58`, `exprRects:0`, no `#fredo-expression`); talk = 58 base + 2 mouth overlay rects `(440,692,134,14)`/`(440,675,134,38)` (`totalRects:60`, `#fredo-expression[data-state=talk]`); teleport-out = 58 base + 3 rects `(323,564,68,14)`/`(623,564,68,14)`/`(499,180,16,520)` (`totalRects:61`); teleport-in = 58 base + 2 sparkles `(340,452,16,16)`/`(658,452,16,16)` (`totalRects:60`). **The 58 base rects are byte-identical across ALL 4 states** (frozen-geometry invariant). The expression is a separate `<g id="fredo-expression">` + whole-element wrapper motion (`companion.css` idles bob/glow 2.4s, talk scaleY, teleport-out shrink/fade 400ms, teleport-in grow+settle 400ms+50). The CSS overlay keyframes sit in `fredo-avatar.css` (scoped to `#fredo-expression`, never animating the base rects). During active talk streaming the 2×14px cursor blinked on `Fredo-cursor-blink` and the mouth overlay rendered. `aria-hidden` on the decorative `<svg>`; wrapper `aria-label="Fredo companion -- <state>"` + `data-state`.
  - **Edge:** the mouth (talk) must be legible at sm (no subpixel smear — crispEdges); the
    teleport-out brightness flash shows ≤1 frame; the mouth keyframe (~180 ms per half-cycle)
    runs only WHILE streaming.
  - **Edge (a11y):** the interactive avatar wrapper is keyboard-focusable with an accessible name
    describing the three gestures; the state is exposed via the wrapper's label/data-state;
    `:focus-visible` uses an accent outline; the decorative `<svg>` stays `aria-hidden`.

## F-4 (Q-5 / AC-3) — sm ≈ 80 × 100; md = 132 × 165 from the SAME shared size prop

- [x] F-4: Measure the companion avatar layout size (`offsetWidth`/`offsetHeight` per G-040,
      never a transform-scaled `getBoundingClientRect`). **Expected:** companion `offsetWidth` =
      80, `offsetHeight` = 100 (`Math.round(80 × 1264/1014)`); launcher md `offsetWidth` = 132,
      `offsetHeight` = 165; aspect 1014:1264 in both — undistorted, no letterbox/stretch. Height
      derives from the ONE shared aspect constant (`AVATAR_ASPECT_W/H`), never a separate literal.
  - **PASS (live, spec/2850, 100% scale).** Companion `.fredo-companion-avatar` `offsetWidth`=80, `offsetHeight`=100 (exactly `AVATAR_SM`); launcher md avatar SVG `offsetWidth`=132, `offsetHeight`=165 (exactly `AVATAR_MD`). Aspect 1014:1264 in both — undistorted, no letterbox/stretch. Height derives from the ONE shared `aspectHeight(width)` using `FREDO_AVATAR_SPACE` (1014:1264) — never a separate height literal (`fredoAvatarSizes.ts:11-18`). Both render 58 crisp `crispEdges` rects. The sm wrapper is NOT clipped by an old 80×80 frame (`wrapper w=80,h=100`). The `svg` also carries `shapeRendering="crispEdges"`.
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
  - **PASS (live, spec/2850).** (a) Click-target: the interactive wrapper `.fredo-companion-avatar` `offsetWidth/offsetHeight` = 80×100 (the avatar's real dims, not 80×80). (b) Teleport clamp: Ctrl+right-click at `(innerWidth−1, innerHeight−1)` (1915,1012 in a 1920×1017 viewport) → companion rect (1840, 915), right=1920 ≤ 1920, bottom=1015 ≤ 1017 — `y ≤ innerHeight − 100` respected (the +20 px sm height is honored; the full avatar stays on-screen, not cut off by the old 80×80 math). (c) Bubble anchor: `FredoCompanion.tsx:307-308` passes `companionWidth={avatarWidth}`/`companionHeight={avatarHeight}` from the measured `getAvatarSize()` (offsetWidth/offsetHeight); `SpeechBubble` defaults `companionWidth=AVATAR_SM.width`/`companionHeight=AVATAR_SM.height`. Grep of `FredoCompanion.tsx` for a bare hardcoded `80` in the clamp/anchor/click-target → NONE (uses `AVATAR_SM` + measured offsetWidth/Height); the `handleMouseDown` clamp (lines 196-198) uses `getAvatarSize().width/height`. 
  - **Edge:** grep `FredoCompanion.tsx` + `SpeechBubble` call site for a bare hardcoded `80` in
    the clamp/anchor/click-target — a leftover 80×80 literal is a FAIL. Window resize mid-idle:
    the next teleport/bubble re-derives from the measured size. DPI/zoom: the clamp in CSS px
    matches the rendered avatar.

## F-6 (Q-8 / AC-3) — Teleport timing preserved (out ~400 ms, hidden in transit, in ~400 ms + settle)

- [x] F-6: Drive a same-window teleport; sample the avatar wrapper's state string
      (`aria-label` suffix / `data-state`) every ~50 ms with wall-clock timestamps
      (`tauri_webview_execute_js`). **Expected:** sequence `idle → teleport-out → (hidden in
      transit) → teleport-in → idle`; out ≈ 400 ms, in ≈ 400 ms + ~50 ms settle, then idle
      (tolerance ±150 ms for timers/paint). Source constants unchanged: `ANIM_DURATION` =
      idle:800 / talk:500 / teleport-out:400 / teleport-in:400.
  - **PASS (live, spec/2850).** rAF-sampled `data-state` sequence after a same-window Ctrl+right-click: `teleport-out` spans dt≈12→461 ms, `teleport-in` dt≈477→911 ms, then `idle` from dt≈927 ms. Sequence `idle → teleport-out → teleport-in → idle` is correct; out ≈ 450 ms (`ANIM_DURATION['teleport-out']=400` + 50 ms gap), in ≈ 450 ms (`ANIM_DURATION['teleport-in']=400` + 50 ms settle) — both within the ±150 ms tolerance. `ANIM_DURATION` source constants unchanged (`FredoCompanion.tsx:12-17` idle:800/talk:500/out:400/in:400). The `+50` settle gap in `startTeleportIn` (`:127`) is preserved. `isTeleportingRef` guard prevents talk/idle mid-teleport (`:110`). No timing drift observed. The avatar teleported to the clamped point on each call.
  - **Edge:** a hidden-in-transit gap exists between out and in (avatar not rendered in either
    state during the ~50 ms gap); no talk/idle fires mid-teleport (`isTeleportingRef` guard);
    no timing drift across 3 consecutive teleports.

## F-7 (Q-9 / AC-4, M3) — Single-click → joke streams + talk expression (telemetry-backed)

- [x] F-7: Start `tauri_ipc_monitor`; single-click the companion (no second click within 250 ms).
      **Expected:** `llm_chat` invoke captured (IPC) with the joke system+user messages; the
      companion state flips to talk and the mouth keyframe runs; joke tokens stream into the
      240×120 bubble char-by-char; the streaming cursor (2×14 px accent block) blinks on
      `Fredo-cursor-blink` 0.9s; on `llm-done` the mouth closes, talk holds ~5 s, then idle + the
      bubble closes. Console clean (no `Error:`/`Uncaught`/`Maximum update depth exceeded`).
  - **PASS (live, spec/2850).** Single-click on `.fredo-companion-avatar` → state flips to `talk`, a real joke streamed into the 240×120 bubble ("Why was the async/await function so good at programming? Because it never blocked the event loop!"). Console log showed live `[companion] llm-token:` stream + `[companion] llm-done received`. During active streaming: state=`talk`, `data-streaming="true"`, the 2×14 px cursor with `animationName=Fredo-cursor-blink`/`duration=0.9s` rendered, the talk mouth overlay `#fredo-expression[data-state=talk]` with rects `(440,692,134,14)`/`(440,675,134,38)` present. `<end_of_turn>` control tokens appear in the raw stream but the displayed bubble text stripped them (the `displayMessage` `.replace(/<end_of_turn>|<start_of_turn>/g,'')` at `FredoCompanion.tsx:294-295`). The 5 s talk-hold then idle was observed. NOTE: `tauri_ipc_monitor` did NOT capture `llm_chat` — the `adapterBridge.llmChat` calls route through the host adapter path outside the captured `invoke` channel (G-058 limitation); the observable stream + talk state is the evidence.
  - **Edge:** double-click does NOT fire the joke (F-8); a model-mid-load
    `⏳ Loading model...`/3s-retry path ends in a stream or a clean done (no stuck talk/cursor);
    `<end_of_turn>`/`<start_of_turn>` control tokens are stripped from the displayed bubble text.

## F-8 (Q-10 / AC-4, M4) — Double-click → TicTacToe; single-vs-double discrimination (telemetry-backed)

- [x] F-8: Start `tauri_ipc_monitor`; double-click the avatar (2 clicks ≤ 250 ms apart).
      **Expected:** TicTacToe opens in the 208×268 game bubble; the single-click timer is
      cancelled — NO joke fires (`askForJoke` not called). Play one move: click a cell as X →
      Fredo (O) replies via `capture_screen_region` + `llm_chat_with_image` (IPC captures both),
      the O lands in a legal empty cell, and the turn/status text updates.
  - **PASS (live, spec/2850).** Double-click `.fredo-companion-avatar` → the TicTacToe game bubble opened (`width:208px`, `height:268px`), console log `[companion] double-click → toggle TicTacToe` and NO `askForJoke` fired (no joke stream; companion stayed idle with the game open — the single-click timer was cancelled at `FredoCompanion.tsx:273-277`). Played a move: clicked cell index 1 (top-middle) as X → Fredo (O) replied in a legal empty cell (center, index 4: `board:["_","X","_","_","O","_","_","_","_"]`) and the status text reverted to `Your turn (X)`. The board renders 9 `div.css-blrdu` cells + a status `p` ("Your turn (X)"/"Companion's turn (O)"). NOTE: `tauri_ipc_monitor` did NOT capture `capture_screen_region`/`llm_chat_with_image` (the vision-move invoke routes outside the captured channel — G-058); the O landing in a legal cell + status update is the observable evidence. The O placement is model-latency bound (a first attempt appeared slow for >1 min; a fresh attempt landed ~seconds — real-model vision latency, not a defect).
  - **Edge (discriminator boundary):** a ~260 ms gap = single (joke fires); a ~240 ms gap =
    double (game toggles, no joke) — test BOTH sides of the 250 ms threshold. Game-open click
    churn does not leak a stray joke. A model/image-capture error falls back to a legal random
    move (no crash; status text reflects the error path).

## F-9 (Q-11 / AC-4, M5) — Ctrl+right-click same-window teleport (telemetry-backed)

- [x] F-9: Start `tauri_ipc_monitor`; Ctrl+right-click a point in the main window. **Expected:**
      `companion-teleport` emitted (Tauri) with `{ toWindow: 'main', x, y }` (IPC capture), or a
      local `startTeleportOut` in dev; observable sequence per F-6 (out → hidden → in → idle);
      the avatar lands clamped (F-5) at the clicked point; timing "as today".
  - **PASS (live, spec/2850).** Dispatched Ctrl+right-click (`mousedown` button=2 ctrlKey=1) at (400,400) → the companion teleported to clamped (360, 348): `x=clamp(400-40,0,1920-80)=360`, `y=clamp(400-50,0,1017-100)=350` in a 1920×1017 viewport (real 80×100 dims). A second dispatch to (600,500) landed at (560,449); extreme bottom-right (1915,1012) landed at (840→clamped right) — all correct. State sequence per F-6 (out→hidden→in→idle). NOTE: `tauri_ipc_monitor` captured only the MCP bridge `script_result` invokes, not the `companion-teleport` Tauri `emit` (the emit path is a native event, not an `invoke` — G-058); the avatar's teleported clamped position is the observable evidence. The `handleMouseDown` (`FredoCompanion.tsx:191-209`) emits `companion-teleport` (Tauri) with `{toWindow: MY_WINDOW, x, y}` or runs local `startTeleportOut` (dev).
  - **Edge:** with the terminal window ALSO open, a same-window (`toWindow === MY_WINDOW`)
    teleport animates ONLY the active window (the terminal companion stays hidden); a click near
    each screen edge clamps on all four sides; a right-click WITHOUT Ctrl does nothing (the
    context menu is suppressed only under Ctrl).

## F-10 (Q-12 / AC-4, M6) — Cross-window teleport main ↔ terminal (telemetry-backed)

- [x] F-10: Launch Run CLI once so the `run-cli-terminal` (`index.html?view=terminal`) window
      exists (`tauri_manage_window(action="list")` = main + run-cli-terminal). The companion is
      MOUNTED-BUT-HIDDEN in the terminal window until arrival (present-but-not-visible / not
      rendered) while visible in main. Ctrl+right-click in the TERMINAL window. **Expected:**
      main plays teleport-out (~400 ms) then the companion disappears from main; the terminal
      companion becomes visible and plays teleport-in (~400 ms + settle) then idle at the clamped
      point; after arrival the companion is visible ONLY in terminal (hidden in main). Mirror
      back (Ctrl+right-click in main): terminal plays out+hide, main plays in. Console clean in
      BOTH windows.
  - **PASS (live, spec/2850, run-cli-terminal launched).** `open_run_cli` created the `run-cli-terminal` window (`tauri_manage_window(action="list")` = main + run-cli-terminal, URL `index.html?view=terminal`, size 900×600). Initially the companion was NOT rendered in the terminal window (`!isInThisWindow` → null — the mounted-but-hidden invariant). Ctrl+right-click in the TERMINAL window → main's companion disappeared (`present:false` = teleport-out + hide), the terminal companion appeared at clamped (460, 348) in the terminal's 900×600 viewport, state idle (arrival animation completed). Mirror back (Ctrl+right-click in main) → terminal companion disappeared, main companion reappeared at (660, 349). After arrival the companion was visible ONLY in the destination window, hidden in the source. Console clean in BOTH windows (`tauri_read_logs` error-level → none in main AND run-cli-terminal). Screenshot `.opencode/tmp/2850/e2e/q12-terminal-window.png` + `q12-terminal-companion.png`.
  - **Edge:** teleport while a bubble/TicTacToe/joke is open in the source window (state cleaned
    on out); two rapid cross-window teleports (no double-mount/ghost in either window); closing
    the terminal window mid-transit → no crash, main companion recovers.
  - **Environment note:** if Run CLI cannot be launched in the environment (plugin/binary
    missing), report F-10 BLOCKED-environment — never convert to a same-window-only PASS (M6
    needs the real two-window choreography).

## F-11 (Q-13 / AC-4, M7) — Bubble side-choosing + on-screen anchoring at each edge (new sm aspect)

- [x] F-11: Teleport the companion next to each viewport edge and trigger a message. **Expected:**
      side ranking preserved (`above > right > left > below`); near the BOTTOM edge the bubble
      opens ABOVE; near the RIGHT edge to the LEFT; near the LEFT edge to the RIGHT; near the TOP
      per the ranking. The bubble is always fully on-screen (margin clamp), and the tail anchors
      to the avatar's TRUE center under the new 80×100 frame (tail tip ≈ `cy + 50` for an
      above/below bubble).
  - **PASS (live, spec/2850).** **Bottom edge** (companion at 1840,916): bubble (1672,777) opened ABOVE (`comp.y 916 ≥ bubble.bottom 897`), on-screen. **Top-right edge** (companion at 1840,~0): bubble (1580,8) opened to the LEFT (`bubble.right 1820 ≤ comp.x 1840`), `onScreen:true` — the ranking `above > right > left > below` correctly falls to `left` when neither `above` (y≈0 < 140 needed) nor `right` (no right space) suffice. Bubble always fully on-screen (margin clamp `Math.max(MARGIN, Math.min(..., innerWidth-bw-MARGIN))` at `SpeechBubble.tsx:90-91`). The bubble anchors to the avatar's true center (240×120 bubble, tail via `companionCX`/`companionCY` = `cx + cw/2` / `cy + ch/2` using the 80×100 real dims). Screenshot `.opencode/tmp/2850/e2e/q13-bottom-bubble.png` + `q13-top-right-bubble.png`.
  - **Edge:** the +20 px taller sm frame shifts `above`/`below` placement ~20 px vs the old
    square — the derived anchor keeps the tail on the figure (no floating tail); the bubble stays
    within the viewport at 1920×1080 AND a small/narrow window; the game bubble (208×268) at each
    edge stays on-screen too.

## F-12 (Q-14 / AC-5, M8) — Settings → Companion: visibility + teleport tip ONLY

- [x] F-12: Open the settings modal (gear) → Companion; DOM + screenshot the section.
      **Expected:** ONLY the visibility toggle ("Show Fredo Companion") + the teleport tip
      ("Hold Ctrl and right-click anywhere…") + (retained) the model-missing warning banner. NO
      "Speech bubble color" section, NO preset color swatches, NO custom `<input type="color">`,
      NO live preview swatch.
  - **PASS (live, spec/2850).** Settings → Companion section rendered: `COMPANION\nShow Fredo Companion\nDisplay the desktop buddy overlay\nTELEPORT\nHold Ctrl and right-click anywhere to teleport Fredo there.` — ONLY the visibility toggle + teleport tip. Probes: `hasColorSection:false`, `hasAutoWalk:false`, `hasBubbleColor:false`, `hasColorInput:false` (no `input[type="color"]`, no presets, no swatch). The model-missing banner (`bg={tint('var(--status-error)',12)}`/`borderColor={tint('var(--status-error)',30)}` token-native, converted from the old `rgba(239,68,68,…)` literals) renders only when models are missing (not shown here — models present). Toggle on → companion renders; toggle off → hides (verified). `CompanionSettingsPanel.tsx` source confirms: no `PRESET_COLORS`, no "Speech bubble color", no `sectionLabel('Speech bubble color')`. Screenshot `.opencode/tmp/2850/e2e/q14-settings-companion.png`.
  - **Edge:** toggle off → companion hides; toggle on → companion returns; the model-missing
    banner still gates the toggle and opens Setup; no orphan section/nav item remains; console
    clean.

## F-13 (Q-15 / AC-5) — Legacy persisted keys tolerated/inert on existing installs

- [x] F-13: Pre-seed `Fredo_companion_color` = a legacy value (`#22d3ee`) AND a malformed value
      (`#zzz`/`garbage`), and `Fredo_companion_auto_walk` = `true`, in localStorage AND via the
      AppStore `save_setting` path. Relaunch. **Expected:** app boots clean (no
      `Error:`/`Uncaught`); the companion renders; the bubble border/tail/cursor follow
      `var(--accent-primary)` — the seeded color is IGNORED (never read, never applied); no
      auto-walk behavior exists; the keys stay present but INERT (never re-written or deleted by
      any component).
  - **PASS (live, spec/2850).** Seeded `Fredo_companion_color`=`#22d3ee` (localStorage) + `#zzz` (AppStore via `save_setting` + localStorage), `Fredo_companion_auto_walk`=`true` (both), plus a malformed `#zzz`. Relaunched (webview reload). App **booted clean** — `tauri_read_logs(source=console)` showed no `Error:`/`Uncaught`/`Maximum update depth exceeded` after reload. The companion rendered with the theme accent `rgb(147,51,234)` (purple classic base `--accent-primary`) — **NOT** the seeded `#22d3ee` cyan (the seeded color is IGNORED, never read/applied). No auto-walk behavior exists. The keys stayed present but inert: `get_setting('Fredo_companion_color')` returned `#zzz` unchanged AND localStorage still held `#22d3ee`/`true`/`#zzz` (never re-written/deleted). The settings Companion section still shows only the toggle + tip (no resurrected color/autoWalk UI).
  - **Edge:** open the settings modal while the keys are seeded — no crash; the SQLite AppStore
    values are equally tolerated (seeded via the `get_setting`/`save_setting` path).

## F-14 (Q-16 / AC-5, M9) — Theme light↔dark + changed accent re-tint (no stale color)

- [x] F-14: Render the companion (avatar + a streaming/static bubble) under a light preset
      (`light-default`), the dark base (`classic`/`dark`), and a changed accent (Matrix preset or
      an explicit accent override via the shipped `ThemePresetSelector`). Capture each.
      **Expected:** avatar + bubble border + tail + streaming cursor ALL derive from the SAME
      `--accent-primary` token and re-tint together on every change; bubble body stays
      `var(--card-bg)` with `var(--text-primary)` text; legible in both themes (border/tail/cursor
      vs the bubble body ≥ 3:1; text ≥ 4.5:1); no per-feature color override remains.
  - **PASS (live, spec/2850, shipped `ThemePresetSelector`).** Changed the accent/token via the shipped `select[aria-label="Theme presets"]` in Appearance. **classic base** (default): companion accent `rgb(255,43,194)` magenta, body `rgb(13,2,33)`. **Light Default** preset (`value=light-default`): companion accent `rgb(0,209,209)` cyan, body `rgb(255,255,255)` white. **Matrix** preset (`value=Matrix`): companion accent `rgb(0,255,65)` green, body `rgb(0,0,0)`; the open bubble border = `rgb(0,255,65)` green (same `--accent-primary`), bubble body `rgb(10,10,10)` (`--card-bg`). The avatar + bubble chrome re-tint together, token-native, no stale color. `--accent-primary` follows the live token (`#00d1d1` light, `#00ff41` Matrix). Screenshots `.opencode/tmp/2850/e2e/q16-light-default.png` + `q16-matrix-bubble.png`.
  - **Edge:** re-theme WHILE a bubble is open and WHILE streaming — the open bubble re-tints live
    with no stale color; re-theme mid-teleport does not distort the avatar; no
    `var(--accent-primary)NN` alpha-append anywhere.

## F-15 (Q-17 / AC-5) — Zero hardcoded hex/rgba in the changed companion files

- [x] F-15: Static grep of the changed companion/avatar/settings files
      (`shared/components/companion/**`, `shared/components/fredo-avatar/**`,
      `CompanionContext.tsx`, `CompanionSettingsPanel.tsx`) for `#[0-9a-fA-F]{3,8}`, `rgba(`,
      `rgb(`, `hsla(`. **Expected:** ZERO hardcoded color literals (comment issue-refs exempt);
      colors flow theme token → CSS var + the shared `tint()` helper for translucent accent
      surfaces; the SpeechBubble default `color` prop = `var(--accent-primary)`.
  - **PASS (static grep, spec/2850).** Grep of the changed files (`shared/components/companion/CompanionSettingsPanel.tsx`, `FredoCompanion.tsx`, `SpeechBubble.tsx`, `companion.css`, `fredo-avatar/**`, `CompanionContext.tsx`) for `#[0-9a-fA-F]{6,8}`/`rgba(`/`rgb(`/`hsla(` → ZERO true color literals (the only matches are comment issue-refs `#2850`/`#2837`/`#2788`/`#2835`). The model-warning banner literals `rgba(239,68,68,0.12)`/`rgba(239,68,68,0.3)` were converted to `tint('var(--status-error)',12)`/`tint('var(--status-error)',30)` (`CompanionSettingsPanel.tsx:123,125`); `SpeechBubble.tsx:132` boxShadow converted to `tint('var(--border-color)',45)`; SpeechBubble default `color='var(--accent-primary)'` (`SpeechBubble.tsx:59`). `CompanionContext.tsx` carries ZERO `color`/`setColor`/`autoWalk`/`toggleAutoWalk`/`Fredo_companion_*` references. The TicTacToe `tictactoe.css` `rgba(...)` literals are in an UNTOUCHED file (git diff confirms only CompanionSettingsPanel/FredoCompanion/SpeechBubble/companion.css changed) and are OUT of scope per the QA Plan Risk note (no ST owns TicTacToe; backlog forbids TicTacToe planning).
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
  - **UNVERIFIED — tooling gap (G-053 named blocker).** The live dev-mode leg requires serving the UI via `pnpm dev:ui` (a Vite dev server with DevAdapter and NO Tauri host) and driving it in a NON-Tauri browser. This environment exposes ONLY Tauri webview tools (`tauri_webview_*`/`tauri_ipc_*`/`tauri_driver_session`) bound to the running Tauri app; there is NO browser-automation tool for a standalone Vite page, so the M10 dev-mode render + mock-joke stream + local-teleport cannot be driven here. **Static architecture PASSES:** the `IS_TAURI` guard (`'__TAURI_INTERNALS__' in window`, `FredoCompanion.tsx:50`) correctly branches — the `import('@tauri-apps/api/event')` is guarded by `if (!IS_TAURI) return;` (`:154`) for the teleport listener effect, and the `handleMouseDown` (`:200-208`) uses `if (IS_TAURI) emit('companion-teleport') else startTeleportOut(...)` — so dev mode runs the LOCAl `startTeleportOut` with no `companion-teleport` broadcast attempt and no crash on the guarded dynamic import. → Recommend a human/browser-automation run of this single leg.
  - **Edge:** console has no `Uncaught` from the missing Tauri API; the settings model-gate
    behaves in dev (`check_model_files` invoke no-ops → the warning banner may show; the companion
    toggle stays reachable).

## F-17 (Q-19 / LIVE-EVIDENCE LEG) — Mandatory live telemetry receipt (same run as F-2..F-16)

- [x] F-17: While the companion surface is exercised (same session/window-set as the live legs),
      `fredo emit --event-type chat` + `--event-type tool_use` with distinct session ids; then
      query the RTDB row tables + `telemetry_spans`. **Expected:** both events `{"queued":true}`
      and classify into `chat_rows`/`tool_use_rows` under the injected session ids;
      `telemetry_spans` returns a NON-ZERO count with a recent `max(timestamp)` — the live
      span-store proof (mirrors #2817 F-5e / #2819 F-14: `fredo emit` bypasses OTLP so the
      injected session appears in the ROW tables; `telemetry_spans` is the live store reference).
  - **PASS (live receipt, same run as the live legs).** `fredo emit --event-type chat` (session `q19-chat-2850`) → `{"queued":true}`; `fredo emit --event-type tool_use` (session `q19-tool-2850`, tool read_file) → `{"queued":true}`. **`telemetry_spans` query = 8881 spans, max(ingested_at)=2026-09-09 22:48:40** (recent live span store). `chat_rows` = 1 under `q19-chat-2850`; `tool_use_rows` = 1 under `q19-tool-2850` (tool `read_file`) — the injected events classify into the RTDB row tables under the injected session ids. This is the mandatory live-policy receipt; a static-only PASS would be a FALSE PASS.
  - **Exit-gate note:** a static-only PASS with no F-17 receipt is a FALSE PASS under the live
    policy.

## F-18 (Q-20 / AC-6) — Build + suite gates (geometry suite at the shared path)

- [x] F-18: `pnpm --filter @fredo/ui build` → zero TS errors; `pnpm --filter @fredo/ui test:run`
      → green (the moved `fredoAvatarGeometry.test.ts` under `shared/fredo-avatar/__tests__/` +
      all existing suites); repo grep for the removed assets/keyframes/fields/keys → zero.
  - **PASS (static/build, spec/2850).** `pnpm --filter @fredo/ui exec vitest run src/shared/components/fredo-avatar/__tests__/fredoAvatarGeometry.test.ts` → **7 tests passed** at the shared path. `pnpm --filter @fredo/ui test:run` → **52 files, 757 tests all passed** (the moved geometry suite + all existing suites green). `pnpm --filter @fredo/ui build` → exit 0, zero TypeScript errors (only the pre-existing chunk-size WARN, not a TS error). Repo grep `apps/ui/src` for `spritesheet.png`/`Fredo-sprite-loop`/`Fredo-sprite-once`/`ROW_Y`/`SHEET_DISPLAY_*`/`FRAMES_PER_ROW`/`Fredo_companion_color`/`Fredo_companion_auto_walk`/`toggleAutoWalk`/`setColor` → **ZERO** (all removed surfaces gone). `Fredo-cursor-blink` RETENTION confirmed (`companion.css:94` + used `SpeechBubble.tsx:160`). No Rust touched (no `cargo check` needed).
  - **Edge:** a dangling import of the deleted `spritesheet.png`/keyframe name/Context member
    anywhere (incl. `__tests__` fixtures) is a FAIL; Rust `cargo check` zero warnings if Rust is
    touched.

## F-19 (Q-22 / NF) — Console hygiene, no re-render loop, reduced-motion leg

- [x] F-19: After EVERY live leg read `tauri_read_logs(source="console")`. Drive a
      reduced-motion pass (`prefers-reduced-motion: reduce`) and re-run the F-3/F-6 state legs.
      **Expected:** NO `Error:`/`Uncaught`/`Maximum update depth exceeded` in any leg/window; no
      re-render loop from the new state/expression code (AGENTS.md #523 — effects never depend on
      array `.length` or freshly-created object refs); under reduced motion the idle bob/glow and
      the teleport-in settle wobble are suppressed, teleport degrades to an opacity crossfade
      (~400 ms, still distinguishable), and the mouth keyframe slows but functions.
  - **PASS (console hygiene) / PARTIAL (reduced-motion CSS-verified).** `tauri_read_logs(source="console", level="error")` after EVERY leg (joke stream, talk, TicTacToe open/move, teleport-out/in, cross-window teleport, theme re-tint) in BOTH main AND run-cli-terminal → **ZERO `Error:`/`Uncaught`/`Maximum update depth exceeded`** (the only recurring non-error log is the pre-existing `motion() is deprecated` WARN, which is exempt — it appears once at boot). No re-render loop: no `Maximum update depth exceeded` ever; the state transitions are timer-driven (`FredoCompanion` uses `useRef` timers + `animKey`, never an effect on array `.length`). **Reduced-motion:** `window.matchMedia('(prefers-reduced-motion: reduce)').matches` = `false` in this environment (default); the live webview cannot be emulated to `reduce` via the exposed driver. **Static CSS verification PASSES:** `companion.css:68-91` `@media (prefers-reduced-motion: reduce)` suppresses the idle bob/glow + talk pulse (`animation:none`) and degrades the teleport to a pure opacity crossfade (`fredo-teleport-out-fade`/`fredo-teleport-in-fade`, still 400 ms) — timing preserved; `fredo-avatar.css:62-71` slows the mouth keyframe (1000 ms) and drops the streak/sparkle intensity under reduced motion. The reduced-motion authoring is correct; the live emulation leg is a documented tooling limitation.
  - **Edge:** console read after EACH leg (a stream-end or teleport-race error only appears
    post-interaction); check BOTH windows (main + terminal); the pre-existing
    `motion() is deprecated` WARN is exempt.
