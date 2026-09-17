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

- [x] F-16: Serve the UI via the Vite dev server (`pnpm dev:ui`, DevAdapter, no Tauri host).
      **Expected (PO-amended round 2, R2-3):** the companion renders (sm avatar + idle);
      single-click streams a MOCK joke token-by-token (DevAdapter 30 ms interval) into the bubble
      with the 2×14 px cursor blinking; double-click opens TicTacToe (208×268) and Fredo answers in
      a LEGAL EMPTY cell (in a real dev browser `TicTacToe.tsx:46-53` gates the move behind
      `adapterBridge.invoke('capture_screen_region')`, which `DevAdapter.invoke` no-ops
      (`DevAdapter.ts:35-38` → `undefined`) → the legal-move fallback at `TicTacToe.tsx:93-100`
      plays; the `DevAdapter.llmChatWithImage` mock `'4'` center is covered by the jsdom test with
      a stubbed capture); Ctrl+right-click teleports LOCALLY (`startTeleportOut`) with NO
      `companion-teleport` broadcast attempt and NO crash on the `import('@tauri-apps/api/event')`
      path (the `IS_TAURI` guard must select the dev path).
  - **PASS — round-2 in-environment jsdom evidence (R2-1/R2-2).** New evidence-only test
    `apps/ui/src/shared/components/companion/__tests__/FredoCompanion.devMode.test.tsx` (435 lines,
    5 tests) renders the REAL `FredoCompanion` in jsdom under a mocked `adapterBridge` registering
    the real `DevAdapter` (`setLlmChat`/`setLlmChatWithImage`/`setInvoke`/`setListen`) with
    `window.__TAURI_INTERNALS__` absent → `IS_TAURI === false` at `FredoCompanion.tsx:50`. Run:
    `pnpm --filter @fredo/ui exec vitest run src/shared/components/companion/__tests__/FredoCompanion.devMode.test.tsx`
    → **1 file / 5 tests passed (5), 0 failed**; full `pnpm --filter @fredo/ui test:run` → **53
    files / 762 tests passed, 0 failed**. Assertions: (1) dev render — persisted
    `Fredo_companion_visible='true'` path → `data-state="idle"`, `aria-label="Fredo companion --
    idle"`, `viewBox="0 0 1014 1264"`, **58 base rects byte-identical to `expandFredoRects(FREDO_AVATAR_SOURCE_RECTS)`**,
    no idle overlay, console clean; (2) mock joke stream — single-click → 250 ms discriminator →
    `talk` + `data-streaming="true"` + 2×14 px `Fredo-cursor-blink` cursor → token-by-token
    DevAdapter 30 ms fill → onDone talk hold → idle + bubble closes; (3) Ctrl+right-click at
    (500,400) → local `teleport-out` → clamped `teleport-in` at (460,350) (real sm 80×100 box) →
    idle via the preserved 400+50/400+50 chain, with `tauriEvent.imported === false` (the guarded
    dynamic import was NEVER attempted) and zero `emit('companion-teleport')`; (4) double-click →
    TicTacToe 208×268, X at cell 8 → Fredo (O) at cell 0 via the `capture_screen_region` no-op
    legal-move fallback (no `Uncaught`/`Unhandled`); (5) stubbed capture → `llmChatWithImage` mock
    `'4'` center (cell 4). **Static `IS_TAURI` guard re-confirmed on the round-2 tip:**
    `FredoCompanion.tsx:50` (`'__TAURI_INTERNALS__' in window`), `:154` (`if (!IS_TAURI) return;`
    before the guarded `import('@tauri-apps/api/event')`), `:200-208` (`if (IS_TAURI) emit(...)
    else startTeleportOut(...)`), `main.tsx:19-20` adapter selection, `DevAdapter.ts:35-38`
    invoke no-op / `:40-69` mock stream / `:71-80` `'4'` mock. Product code UNTOUCHED this round
    (`git diff 1bb8e2a bb6b9c7 -- apps/ui/src` = ONLY the added test file).
  - **Live Vite page remains a human/browser spot-run (environment blocker, G-053).** The standalone
    `pnpm dev:ui` page in a NON-Tauri browser still cannot be driven here (this sandbox exposes
    ONLY Tauri webview tools bound to the running desktop app; no non-Tauri browser driver). The
    jsdom test above deterministically covers the dev branch; the remaining live spot-run is the
    visual Vite page itself + the dev settings model-gate (`check_model_files` invoke no-ops → the
    warning banner may show; the companion toggle stays reachable).
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
  - **PASS (live receipt).** **Round 2 (spec/2850 @ bb6b9c7 — branch moved since round 1, re-run per Fix Plan R2-2(c)):** `fredo emit --event-type chat` (session `q19b-chat-2850`) → `{"queued":true}`; `fredo emit --event-type tool_use` (session `q19b-tool-2850`, tool `read_file`) → `{"queued":true}`. **`telemetry_spans` query = 9578 spans, max(ingested_at)=2026-09-09 23:46:19** (recent live span store). `chat_rows` = 1 under `q19b-chat-2850`; `tool_use_rows` = 1 under `q19b-tool-2850` (tool `read_file`) — the injected events classify into the RTDB row tables under the injected session ids. This is the mandatory live-policy receipt; a static-only PASS would be a FALSE PASS. **Round 1 (spec/2850 @ 25ba296)** receipt for the record: `q19-chat-2850`/`q19-tool-2850`, 8881 spans @ 2026-09-09 22:48:40.
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

---

## #2852 extension — cross-surface parity after the launcher adopts sm

> **Round 1 (spec/2852 @ 1677eca8) — F-20 PASS.** Both surfaces render the shared `FredoAvatar size="sm"`: `offsetWidth=80`/`offsetHeight=100`, the identical 58-rect coordinate set (`rectSetsIdentical=true`, `firstDiffIndex=-1`), `shape-rendering="crispEdges"`, `color="var(--accent-primary)"` + rect `fill="currentColor"`, `aria-hidden="true"`, no idle overlay. The previous 132×165-vs-80×100 difference is gone.

> Issue #2852 makes the LAUNCHER mascot render at the companion's `sm` size (80×100) + idle
> motion. This companion row locks the parity that #2850 F-2 established against the launcher
> `md` render — now BOTH surfaces render the identical `sm` geometry. The companion itself is
> unchanged (see regression R-11).

## F-20 (REQ-1/REQ-4) — Launcher sm and companion sm are the SAME 80×100 geometry

- [ ] F-20: Render the launcher mascot and the companion in the SAME theme. `tauri_webview_execute_js` reads every mounted avatar `<rect>` (x/y/width/height) in BOTH SVGs and both `offsetWidth`/`offsetHeight`; screenshot both at the neutral (transform:0) frame.
  **Expected:** both SVGs carry the IDENTICAL 58-rect coordinate set, both `offsetWidth = 80` / `offsetHeight = 100` (aspect 1014:1264), both `shapeRendering="crispEdges"`, both single-accent `color="var(--accent-primary)"` + `fill="currentColor"`, both `aria-hidden`, no state overlay in idle. The launcher is no longer `md` — the previous 132×165 vs 80×100 difference is gone.
  - **Edge:** repeat in a light preset AND the dark base; the companion's idle bob/glow is whole-element transform only — the neutral gate uses the transform:0 frame, never a mid-animation frame; reduced motion suppresses both without changing size. Reference #2850 F-2 + launcher F-44/F-47.

---

## #2853 extension — presence lifecycle (desktop mascot yields to the companion, then returns after idle)

> Issue #2853 adds a **presence lifecycle** for the companion + one new setting: exactly one Fredo
> at a time (companion visible ⇒ desktop/launcher mascot not rendered; companion hidden ⇒ mascot
> shown at its place); the companion auto-hides after the configured idle period and the mascot
> returns home with no user action; the idle period is configurable in Settings → Companion and
> persists across restart; any companion interaction (drag/move, click/joke, double-click/game,
> teleport) resets the idle timer.
> **Verification policy: live** — every row is provable only on a running app (single-Fredo render
> state + a real idle countdown + persistence across restart). Evidence per case:
> `tauri_webview_dom_snapshot` / `tauri_webview_execute_js` / `tauri_webview_screenshot` /
> `tauri_webview_interact` + `tauri_read_logs(source="console")`. The mandatory live receipt is
> F-29; a static-only PASS is a FALSE PASS.
> **PO amendment (2026-09-10):** default idle timeout = **60 s** (supersedes the issue's 2 min);
> interaction = drag/move, click/joke, double-click/game, teleport; auto-return while the launcher
> is covered by a window may leave the mascot behind the window — the human ACCEPTS that; test the
> observable single-Fredo + auto-return behavior, **not** window Z-order.
> **Test data:** running app on the spec branch, MCP driver `com.fredo.app`; short configured idle
> value (e.g. 5 s) for the interactive countdown legs; persisted visibility key
> `Fredo_companion_visible`; idle-timeout key `Fredo_companion_idle_timeout` (integer seconds,
> default 60, range [5, 3600]). Reference prompts E-12..E-17.

## F-21 (REQ-1 / AC-1) — Exactly one Fredo: companion visible ⇒ desktop mascot not rendered; hidden ⇒ mascot shown

- [x] F-21: With the companion toggled ON, snapshot the DOM/`execute_js` and count every rendered Fredo mascot (`.fredo-companion-avatar` + the desktop/launcher mascot element); take a screenshot. Toggle the companion OFF and recount + rescreenshot.
  **Expected:** **exactly one Fredo at a time.** Companion ON → `.fredo-companion-avatar` present AND the desktop/launcher mascot is **NOT rendered** (absent from the DOM / a11y tree — not merely behind a window). Companion OFF → the desktop/launcher mascot is present **at its usual place** (same slot/geometry as the pre-slice baseline; default companion position unchanged) and the companion is absent. Never two, never zero when one is expected. **Screenshot leg:** the screenshot shows exactly ONE Fredo *visible* — if the companion node exists but is occluded by the resting launcher surface (z-index risk raised by UI/UX), that is ZERO visible Fredos = report as a finding, not a PASS.
  - **Edge:** rapid ON/OFF toggling settles to the correct single-Fredo state; with the terminal window open, per-window rules hold (exactly one Fredo per window — cross-ref F-10); companion enabled for the first time before the idle timer arms; launcher covered by another window → assert DOM presence, **not** Z-order. Required data: companion ON, one DOM snapshot + one count probe.

## F-22 (REQ-2 / AC-2) — Auto-return after the configured idle period

- [x] F-22: Companion ON + desktop mascot hidden; configure a short idle value (e.g. 5 s). Do not interact. Sample companion + desktop-mascot presence at t < timeout, then again after the timeout (timestamp the samples).
  **Expected:** the scenario holds end-to-end — after the configured idle period with no interaction the companion is no longer visible **and** the desktop mascot is shown at its place, **with no user action**. No premature return before the timeout; the swap observed within ~timeout (+ ~1 s tolerance).
  - **Edge:** just under vs just over the timeout boundary; webview unfocused / OS idle does not suppress the return; auto-return while the launcher is covered by a window → observe the result, do **not** fail on Z-order (PO note). Required data: companion visible, mascot hidden, timeout value, wall-clock timestamps of the samples.

## F-23 (REQ-3 / AC-3) — Idle period configurable in Companion settings + persists across restart

- [x] F-23: On a fresh profile, read the idle-timeout control in Settings → Companion and its value. Set a distinct non-default value (e.g. 30 s), close settings, **restart the app**, reopen Settings → Companion and re-read; then wait out the countdown.
  **Expected:** a timeout control exists in the Companion settings panel; fresh-profile **default = 60 s** (PO amendment); the changed value **persists across restart** and still governs the timer after restart (the re-armed countdown uses the persisted value).
  - **Edge:** change the value while the companion is visible → the timer re-arms with the new value (no stale countdown); the persisted value survives a webview reload; the AppStore/localStorage read path returns the persisted value. Required data: fresh profile, settings panel, one changed value, one restart.

## F-24 (REQ-4 / AC-4) — Any companion interaction resets the idle timer

- [x] F-24: With a short timeout, wait to ~80 % of the countdown, then perform each interaction — (a) click/joke, (b) double-click/game, (c) Ctrl+right-click teleport, (d) drag/move. Sample presence after each, then go quiet for a full timeout.
  **Expected:** **every** listed interaction resets the idle timer — Fredo does not return home while in use. After the interaction, auto-return fires only after a **full quiet period** post-interaction (never from the pre-interaction deadline).
  - **Edge:** interaction landing exactly at the timeout boundary; interaction during the countdown; an active joke stream (`isStreaming`) or open TicTacToe (`showTicTacToe`) suppresses auto-return — treated as continuous interaction, re-arms only after it settles (Architect-confirmed); Ctrl+right-click teleport resets the timer in both source/destination windows. Required data: short timeout, one gesture of each of the four kinds.

## F-25 (REQ-5 / AC-5) — Invalid / cleared / out-of-range timeout values fall back or clamp without crashing

- [x] F-25: Seed the timeout with each bad/edge value in turn — cleared/empty, `0`, negative, non-numeric, below-min (`1`), above-max (`99999`), fractional — apply/relaunch, then exercise the control and run a countdown.
  **Expected (Architect's `clampIdleTimeout` contract, key `Fredo_companion_idle_timeout`):** `!Number.isFinite(s) || s <= 0` → **default 60**; otherwise **round then clamp to [5, 3600]** (so `1`→`5`, `99999`→`3600`, `30.6`→`31`). No crash, no wedge, no infinite loop, no never-firing / fires-forever timer, no unhandled error; the control reflects the resolved/clamped value.
  - **Edge:** clear the field (empty string) then restart; `0`; negative; non-numeric (`"abc"`); `1`; `99999`; a fractional value; `Fredo_companion_visible` seeded `false` at boot (companion hidden ⇒ mascot shown, timer not armed). Required data: each value, console read after each.

## F-26 (REQ-6 / AC-5) — Auto-return is transient; the visibility preference and toggle are preserved

- [x] F-26: (a) With the companion visible, trigger auto-return, then read the persisted `Fredo_companion_visible`. (b) Toggle "Show Fredo Companion" OFF then ON; inspect the settings switch and the re-armed countdown.
  **Expected:** (a) auto-return is **transient** — `Fredo_companion_visible` is **NOT** overwritten (still the user's `true`); the settings switch still reads the persisted preference ON after an auto-return. (b) Toggling still shows/hides exactly as today; `SET_VISIBLE(true)` re-shows the companion **and restarts the idle timer** (clears `isAutoHidden`). The auto-return path never resets the timeout value.
  - **Edge:** auto-return then immediate toggle; toggle OFF during a countdown then ON; repeated auto-return cycles leave the preference + timeout intact; reload the app after an auto-return → the companion returns per preference. Required data: `Fredo_companion_visible` snapshots before/after, the settings switch state.

## F-27 (REQ-7) — No idle timer runs while the companion is hidden

- [x] F-27: Hide the companion by **preference OFF** and, separately, by letting a countdown fire; then wait well past the timeout without re-showing. Watch for any timer activity (console/state).
  **Expected:** while hidden (preference off OR auto-hidden) **no idle timer runs** — no background arming/polling, no late `SET_AUTO_HIDDEN`, nothing that fires against a later re-show. Arming happens only while designated present (`isVisible && !isAutoHidden`), and the timer is cleared on unmount / preference-off (mirroring `dismissTimerRef`).
  - **Edge:** preference off at boot; auto-hidden then left alone for multiple timeout periods; teleport-to-terminal while the main companion is auto-hidden (per-window timer rules). Required data: hidden-by-preference and hidden-by-auto-return states, console read.

## F-28 (REQ-NF) — Console hygiene + no re-render loop; timer in refs

- [x] F-28: After every live leg read `tauri_read_logs(source="console")` in BOTH main and terminal windows; inspect the idle-timer/interaction implementation (refs/timers vs `useEffect`/`useMemo` deps); drive a countdown through unrelated re-renders.
  **Expected:** no `Error:`/`Uncaught`/`Maximum update depth exceeded`; **no re-render loop**; the idle timer + interaction listeners live in refs/timers — never in effect/memo deps keyed on `.length` or freshly-created refs (AGENTS.md #523); unrelated re-renders do not reset the countdown; one `setTimeout` ref, cleared before re-arm and on unmount, no `setInterval`.
  - **Edge:** many re-renders during the countdown; interaction exactly at a reset boundary; console checked post-interaction, not only at boot. Required data: console access per window.

## F-29 (REQ-LIVE) — Mandatory live telemetry + rendered-webview receipt (same run as F-21..F-28)

- [x] F-29: On the running app, exercise the presence slice (F-21..F-28); run `fredo emit --event-type chat` + `--event-type tool_use` with distinct session ids; query the RTDB row tables + `telemetry_spans` (telemetry-query skill); capture DOM/screenshot/geometry of the single-Fredo state and the idle swap.
  **Expected:** `telemetry_spans` returns a NON-ZERO count with a recent `max(timestamp)`; the injected events classify into `chat_rows`/`tool_use_rows` under their session ids; a rendered-webview receipt (DOM snapshot / screenshot / measured geometry) of the companion→mascot swap exists. This is the mandatory live-policy receipt — a static-only PASS is a FALSE PASS.
  - **Edge:** re-run the receipt on the tested tip (the branch may move); keep the emit + query output in the `## Tests Runs` evidence.

### Round 2 (spec/2853 @ 4c9ba542) — presence lifecycle re-verification

Verdict: **PASS (9/9)**. The round-1 FAIL (F-24 "in use" suppression) is **FIXED** by the transient `isInUse` folded into the arm gate (`CompanionContext.tsx:301,305`) + `FredoCompanion.tsx:105` reporting `showTicTacToe || isStreaming || animState === 'talk'`.

- **F-21 PASS (live).** Companion ON: `.fredo-companion-avatar`=1 (80×100 at 1800,856), `.fredo-avatar-idle`=0 (mascot absent from the DOM); OFF: companion=0, mascot=1 (58-rect SVG), persisted `Fredo_companion_visible`="false". Exactly one Fredo at a time.
- **F-22 PASS (live).** Timeout 20 s, no interaction: present at t+14.8 s, returned by t+32.1 s; post-return mascot back at (920,343).
- **F-23 PASS (live).** Control `#companion-idle-timeout-seconds` enabled; committed 5 then 20 (read back from SQLite + localStorage); 20 governed the re-armed countdown after reload. Default 60 + clamp matrix unit-covered.
- **F-24 PASS (live — was FAIL round 1).** Timeout 20 s; TicTacToe opened by double-click at t0; **still open + companion present at t+28.3 s and t+29.0 s** (past the 20 s deadline; no return). Closed the game: companion present immediately and at t+14.8 s (<20 s, no early return); returned at t+32.1 s. Joke stream (recorder + console): click `00:29:28.376`, streaming `28.630→32.945`, `talk→idle` `37.945`, return `42.945` (= 5.0 s after settle, not click+5 s) — stream/talk suppressed, timer re-armed on settle.
- **F-25 PASS (live+unit).** Seeded `0` → control resolves 60 (stored `0` inert); `clampIdleTimeout` matrix green in the ST-6 suite.
- **F-26 PASS (live).** Persisted `Fredo_companion_visible` stayed "true" across auto-returns; switch still ON; toggle OFF/ON still shows/hides.
- **F-27 PASS (live+unit).** Preference OFF ⇒ companion=0/mascot=1 sustained, no late churn; gate has no timer while `!isVisible`/`!isHosting`.
- **F-28 PASS (live).** Console error-level reads empty in main + run-cli-terminal; timer in a `useRef`, gate deps primitives only, report effect excludes `isInUse`.
- **F-29 PASS (live).** `telemetry_spans` = 11,180 spans, max(ingested_at)=2026-09-11T00:37:51; `chat_rows` q2853r2-chat=1; `tool_use_rows` q2853r2-tool/read_file=1.
- **Cross-window (R-16/E-14) PASS (canonical).** Main companion visible → Ctrl+right-click in `run-cli-terminal` → exactly one Fredo globally (terminal companion, main mascot suppressed); terminal host-owned 20 s timer returned it and the main mascot came home via the `companion-presence {idle-settle}` broadcast. Edge (see exploratory E-18): a window (re)loaded AFTER main auto-returned misses the `idle-settle` broadcast, so a teleport into it renders the companion while main's mascot is still home (one Fredo per window per the F-21 edge; two avatars globally) — pre-existing presence-sync gap, not introduced by the round-2 diff.

---

## #2854 extension — extended avatar status vocabulary (thinking / happy / playful / joking)

> Issue #2854 adds four new statuses to the shared avatar — `thinking`, `happy`,
> `playful`, `joking` — alongside the existing `idle`/`talk`/`teleport-out`/`teleport-in`,
> wired on BOTH the companion and the desktop mascot (PO amendment). Rows map 1:1 to the QA
> Plan `Q1..Q6` in `.opencode/tmp/2854/triage.md` `## QA Expert`.
> **Verification policy: live** — every row is provable only on a running app. Evidence per
> case: `tauri_webview_execute_js` DOM/geometry probes + `tauri_webview_screenshot` +
> `tauri_read_logs(source="console")`. The mandatory live receipt is F-41; a static-only PASS
> is a FALSE PASS.
> **Serving checkout:** `spec/2854` on a running Fredo desktop app (dev-env Up -Spec 2854,
> MCP driver `com.fredo.app`); LLM model + mmproj loaded for F-31..F-34; short idle timeout
> for F-39.

## F-30 (REQ-1 / AC-1, Q1) — Four new statuses exposed; all 8 states pairwise distinct

- [ ] F-30: Drive each of the 8 states — `idle`, `talk`, `teleport-out`, `teleport-in`,
      `thinking`, `happy`, `playful`, `joking` — on the shared avatar. Per state, via
      `tauri_webview_execute_js`, record the consumer wrapper `data-state` + `aria-label`;
      `#fredo-expression` presence + its `data-state`; every overlay `<rect>` x/y/width/height;
      `getComputedStyle(wrapper).animationName` and each overlay child's computed
      `animationName`. Screenshot each and compare the 8 fingerprints.
  **Expected:** `FredoAvatarState` (and `CompanionState`, re-exported from `apps/ui/src/index.ts`)
  include `thinking`/`happy`/`playful`/`joking`; every new state renders a NON-empty, UNIQUE
  fingerprint — a distinct `#fredo-expression[data-state=<s>]` overlay rect set and/or a
  distinct whole-element `animationName`; all 8 fingerprints are pairwise different (no new
  state collapses to `talk`/`idle`); `idle` = the 58 base rects only, no overlay; each is
  distinguishable at the 80×100 sm render. Probe at the mounted companion + mascot sm scale
  AND the shared component at md (132×165) — the vocabulary is scale-agnostic.
  **Probe contract (UI/UX §3):** thinking → `.fredo-thinking-dot` ×3 + `.fredo-thinking-bubble`
  ×3 + `fredo-thinking-ponder`; joking → `.fredo-joking-mouth` + `.fredo-joking-tongue` +
  `.fredo-joking-laugh` ×2 + `fredo-joking-jiggle`; happy → `.fredo-happy-mouth` ×5 +
  `.fredo-happy-star` ×3 + `fredo-happy-bounce`; playful → `.fredo-playful-smirk` ×2 +
  `.fredo-playful-brow` + `.fredo-playful-star` + `fredo-playful-wobble`.
  - **Edge:** a new state reusing the `talk` overlay DOM (same rect set AND same animationName)
    = FAIL; overlay rects at integer viewBox coords (crisp at sm); `teleport-out`/`teleport-in`
    and all four new states remain mutually distinct. Reference #2850 F-3 + #2852 F-20.

## F-31 (REQ-2 / AC-2, Q2) — Companion LLM wait shows `thinking` (not `talk`)

- [ ] F-31: Start `tauri_ipc_monitor`; single-click the companion. Interval/rAF-sample the
      wrapper `data-state` + the bubble text from the click through the pending phase.
  **Expected:** during the pending phase (bubble `💭 Thinking...`, before the first real token)
      `data-state="thinking"` and `#fredo-expression[data-state=thinking]` render — NOT `talk`.
      The state is observable from the click until the first streamed token.
  - **Edge:** the model-mid-load `⏳ Loading model...` path shows `thinking` (never a stuck
    `talk`/`idle`); Ctrl+right-click during the wait hands off cleanly (no stuck `thinking`).
    Reference #2850 F-7.

## F-32 (REQ-2 / AC-2, Q2) — Active joke delivery shows `joking`

- [ ] F-32: While F-31's joke stream is live (first token → `llm-done`), sample the wrapper
      `data-state` + overlay.
  **Expected:** from the first real token through stream-end `data-state="joking"` with its
      distinct overlay — NOT `talk`. On `llm-done` the state shows `happy` (~1400 ms hold) then
      returns to rest (the existing 5 s message-hide); console clean.
  - **Edge:** an instant/zero-token stream still transitions `thinking`→`joking`→rest; the
    streaming cursor (`Fredo-cursor-blink`) still blinks; control tokens stripped from the
    bubble text. Reference #2850 F-7.

## F-33 (REQ-2 / AC-2, Q2) — TicTacToe LLM wait shows `thinking` (backlog trigger)

- [ ] F-33: Double-click the companion to open TicTacToe; play a move as X and sample the
      wrapper `data-state` during Fredo's vision/LLM turn (status text `Companion is thinking…`,
      no O placed yet).
  **Expected:** `data-state="thinking"` (+ its overlay) while the TicTacToe response is
      pending — the wait moment is not generic `talk`. Once O is placed / the turn completes,
      the state returns to rest.
  - **Edge:** the `capture_screen_region` no-op / error fallback still ends in a legal move
    + rest (no stuck thinking); the game's `🤔 Analyzing board...` text is not required to
    change, only the avatar state. Reference #2850 F-8.

## F-34 (REQ-3 / AC-3, Q3) — `happy` renders on the defined positive outcome

- [ ] F-34: Play TicTacToe to each outcome (X win / Fredo win / draw) and complete a joke;
      probe the wrapper `data-state` + overlay on each completion.
  **Expected:** on ANY TicTacToe outcome (X win / Fredo win / draw — UI/UX §4 default) and on
      joke completion `data-state="happy"` + `#fredo-expression[data-state=happy]` render,
      distinct from `idle` and `playful`. `happy` is transient — it returns to the resting
      state after its moment.
  - **Edge:** win vs loss vs draw classification per the UI/UX draft (Discussion #4);
    `happy` on the companion AND the mascot surface (F-36); a joke that ends in an error
    does not falsely show `happy`. Reference #2850 F-7/F-8.

## F-35 (REQ-3 / AC-3, Q3) — `playful` renders on the defined resting trigger

- [ ] F-35: Let the companion rest (no interaction) past its status moment and probe; repeat
      on the mascot with the companion OFF/auto-hidden.
  **Expected:** on the `useFredoRestingCadence` resting trigger (delay ≈12 s sustained rest →
      `playful` for ≈1.8 s, then back to `idle`) `data-state="playful"` + its distinct
      overlay/motion render, visibly distinguishable from `idle` and `happy` per F-30.
  - **Edge:** playful-vs-idle semantics keyed to the drafted definition (Discussion #1);
    grounded in the real resting lifecycle, not a hardcoded class. Reference F-30.

## F-36 (REQ-3 / AC-3, PO amendment, Q3) — BOTH surfaces wired to the shared vocabulary

- [ ] F-36: With the companion OFF (or auto-hidden) so the desktop/launcher mascot renders,
      drive/expose each new status on the mascot surface and probe the mascot wrapper
      `data-state` + the `#fredo-expression` overlay; then repeat on the companion.
  **Expected:** the mascot wrapper (`.fredo-avatar-idle`, currently a hardcoded
      `data-state="idle"`) and the companion wrapper (`.fredo-companion-avatar`) BOTH carry
      the new statuses via the same shared `FredoAvatarState` and render the matching
      expression overlay. Exactly one Fredo at a time is preserved (#2853 F-21).
  - **Edge:** the mascot's status source/trigger is defined by the Architect (Discussion #3);
    switching the companion ON/OFF mid-status does not leave the mascot stuck in a status;
    per-window presence rules hold. Reference #2852 F-20 + #2853 F-21/F-22.

## F-37 (REQ-4 / AC-4, Q4) — Frozen 58 base rects byte-identical across ALL 8 states

- [ ] F-37: In each of the 8 states read every mounted avatar `<rect>` (x/y/width/height) and
      diff the base rects against `expandFredoRects(FREDO_AVATAR_SOURCE_RECTS)`.
  **Expected:** the 58 base rects are byte-identical across ALL states
      (idle/talk/teleport-out/teleport-in/thinking/happy/playful/joking) — a new status only
      adds its `#fredo-expression` overlay; it never replaces or mutates a base rect. The
      first 58 rects in every state equal the 58-item source set.
  - **Edge:** a status that adds/removes/reorders base rects = FAIL; overlay rects are appended
    after the 58; probe both sm (companion/mascot) and md renders. Reference #2850 F-3.

## F-38 (REQ-4 / AC-4, Q4) — Reduced motion respected; expression still legible

- [ ] F-38: Drive a `prefers-reduced-motion: reduce` pass and re-run the F-30 state legs;
      read the computed `animation-name` on the wrapper + overlay.
  **Expected:** under reduced motion the whole-element motion is suppressed (computed
      `animation-name:none`, or the teleport opacity crossfade at ~400 ms) while each state's
      expression overlay stays legible and distinguishable; the new statuses do not become
      motion-only.
  - **Edge:** every new state under reduced motion must remain readable via the overlay
      (not motion alone); the teleport timing is preserved. Reference #2850 F-19 + #2852 E-11.

## F-39 (REQ-4 / AC-4, Q4) — No state sticks; teleport timing unchanged

- [ ] F-39: After each new status moment (joke done, game end, wait done) go quiet and sample
      the wrapper `data-state` until rest. Then drive a same-window teleport and timestamp the
      `data-state` sequence every ~50 ms.
  **Expected:** every new status returns to the resting state after its moment (nothing
      stuck — including after an error/fallback path); teleport sequence
      `idle → teleport-out → (hidden in transit) → teleport-in → idle`, out ≈400 ms, in ≈400 ms
      + ~50 ms settle (±150 ms tolerance); `ANIM_DURATION` constants unchanged.
  - **Edge:** a new status at the exact teleport boundary; repeated status cycles show no
    drift; teleport while `joking`/`thinking` hands off cleanly. Reference #2850 F-6.

## F-40 (REQ-NF, Q5) — Console clean, no re-render loop, token-native, build gates

- [ ] F-40: After EVERY live leg read `tauri_read_logs(source="console")` in every open window;
      inspect the new status code for effect/memo deps on array `.length`/fresh refs;
      static-grep the changed files for `#[0-9a-fA-F]{3,8}`, `rgba(`, `rgb(`, `hsla(`; run
      `pnpm --filter @fredo/ui build` + `pnpm --filter @fredo/ui test:run`.
  **Expected:** no `Error:`/`Uncaught`/`Maximum update depth exceeded` in any leg/window (the
      pre-existing `motion() is deprecated` WARN is exempt); no re-render loop from the new
      status code (AGENTS.md #523); ZERO hardcoded color literals in the changed files (theme
      token → CSS var + `tint()` only; no `var(--x)NN` alpha-append); build exit 0 / zero TS
      errors; suite green.
  - **Edge:** console read post-interaction, not only at boot; both windows; `#2850`/`#2854`
    comment refs are not color literals. Reference #2850 F-15/F-18/F-19.

## F-41 (REQ-LIVE, Q6) — Mandatory live telemetry + rendered-webview receipt

- [ ] F-41: On the running app exercise F-30..F-40; run `fredo emit --event-type chat` +
      `--event-type tool_use` with distinct session ids; query the RTDB row tables +
      `telemetry_spans` (telemetry-query skill); retain DOM/screenshot/geometry captures of
      each new status.
  **Expected:** `telemetry_spans` returns a NON-ZERO count with a recent `max(timestamp)`;
      both emitted events classify into `chat_rows`/`tool_use_rows` under their session ids;
      a rendered-webview receipt (DOM snapshot / screenshot / measured geometry) of each new
      status exists. **A static-only PASS with no `telemetry_spans` receipt is a FALSE PASS**
      under the live policy.
  - **Edge:** re-run the receipt on the tested tip (the branch may move); keep the emit +
      query output in `## Tests Runs`. Reference #2850 F-17 + #2853 F-29.

### Round 1 (spec/2854 @ 0e52c599) — results

- **F-30 PASS (live).** Real shared `FredoAvatar` rendered at sm (80×100) + md (132×165) for all 8 states. Fingerprints: idle = no overlay + `fredo-idle-bob, fredo-idle-glow`; talk = 2 mouth rects + `fredo-talk-pulse`; teleport-out = streak + `fredo-teleport-out-motion`; teleport-in = 2 sparkles + `fredo-teleport-in-motion`; thinking = 6 (3 dot + 3 bubble) + `fredo-thinking-ponder`; joking = 4 (mouth/tongue/2 laugh) + `fredo-joking-jiggle`; happy = 8 (5 mouth + 3 star) + `fredo-happy-bounce`; playful = 4 (2 smirk + brow + star) + `fredo-playful-wobble`. All pairwise distinct; idle overlayCount 0; md rect coords identical (scale-agnostic).
- **F-31 PASS (live).** Single-click → `data-state="thinking"` + `#fredo-expression[data-state=thinking]` (6 rects) before the first token; never `talk`.
- **F-32 PASS (live).** First token → `joking` (4 rects); `llm-done` → `happy` (8 rects) for 4998 ms (`HAPPY_HOLD_MS` 5000) → `idle`. Real joke streamed; console clean.
- **F-33 PASS (live).** TicTacToe companion turn → `thinking` (6 rects) each O move (recorder).
- **F-34 PASS (live).** Terminal board `XOO.O.XXX` (X wins 6-7-8) → `happy` (5 mouth + 3 star) 3993 ms (`TALK_HOLD_MS` 4000) → idle. (Companion O-move intermittently no-ops on the vision path — pre-existing, see exploratory E-26; the happy render was reached.)
- **F-35 PASS (live).** Companion + desktop mascot rest cadence: `playful` every 12000 ms for 1800 ms (`delayMs`/`holdMs`), returning to idle.
- **F-36 PASS (live).** `.fredo-companion-avatar` (all 8 states) and `.fredo-avatar-idle` (`thinking` on command-query, `happy` on tile-open 1618 ms, `playful` rest) both carry `data-state` + the shared overlay; exactly one Fredo per surface.
- **F-37 PASS (live).** 16/16 (sm+md × 8 states) `baseCount=58`, `bytesEq=true`, `firstDiff=-1` vs `expandFredoRects(FREDO_AVATAR_SOURCE_RECTS)`.
- **F-38 PASS (static).** `matchMedia reduce=false` (driver cannot flip it — named blocker); CSS verified: `companion.css:112-129` all status states `animation:none` + teleport 400 ms opacity crossfade; `fredoAvatarIdle.css:42-49` mascot states `animation:none`; `fredo-avatar.css:109-127` thinking dots/bubbles + joking mouth `animation:none` with resting frames kept (never `opacity:0`).
- **F-39 PASS (live).** Joke `happy→idle` 4998 ms; TicTacToe `happy→idle` 3993 ms; teleport out 0→460 ms, in 460→920 ms, clamp (400,400)→(360,350); `ANIM_DURATION` unchanged.
- **F-40 PASS (live+static).** Console: only LOG, no `Error:`/`Uncaught`/`Maximum update depth exceeded`; zero true color literals in the 9 changed files; `pnpm --filter @fredo/ui build` exit 0; `pnpm --filter @fredo/ui test:run` 54 files / 787 passed.
- **F-41 PASS (live).** `fredo emit` chat+tool `{"queued":true}`; `telemetry_spans` = 11,750, max(ingested_at)=2026-09-11T05:23:52; `chat_rows` q2854-chat=1; `tool_use_rows` q2854-tool/read_file=1.

---

## #2864 extension — Settings → Companion chrome + theming conformance

> Issue #2864 audits Settings → Companion + the shared Settings dialog chrome in every
> theme/accent. Rows map 1:1 to the QA Plan `Q-1..Q-13` in `.opencode/tmp/2864/triage.md`
> `## QA Expert`. **Verification policy: live** — screenshots (raw URLs via `upload-evidence`)
> + DOM/computed-style/geometry + the mandatory `telemetry_spans` receipt (F-48). The shared
> dialog-chrome rows live in `.opencode/tests/settings/functional.md`; this file owns the
> Companion-panel content. Audited companion files: `CompanionSettingsPanel.tsx`,
> `CompanionSetupWizard.tsx`, `SetupStepCard.tsx`, `ModelFilesStepCard.tsx`,
> `ServerLaunchStepCard.tsx`.

## F-42 (Q-1 / AC-1) — BEFORE capture: Companion panel across the state × theme matrix

- [ ] F-42: On the pre-dev `spec/2864` tip (= `main`, before any developer commit), with the
      MCP driver on a running app, open Settings → Companion and screenshot each Companion-panel
      state: ON (toggle on, tip full-opacity), OFF (toggle off, tip STILL full-opacity — only the
      toggle position + tip content visibility change, never a dim), auto-return input idle,
      auto-return input editing (focus/type in `#companion-idle-timeout-seconds`), and the
      not-ready gate (wizard is the only content). Do each in dark (`classic`) and light
      (`light-default`), plus the non-default accent (Matrix / `accentPrimary` override).
  **Expected:** one readable screenshot per state×theme under
  `.opencode/tmp/2864/e2e/before/`, uploaded via `upload-evidence` (raw URLs recorded); each
  shows the toggle + help text + auto-return row + Teleport tip (or the wizard in the not-ready
  cell); ON vs OFF are visually distinct (toggle position + tip content visibility only — the tip
  keeps `opacity: 1`/full contrast in BOTH states, H6); idle vs editing differ by the input focus
  ring.
  Capture-only — no verdict at this stage.
  - **Edge:** capture at 960×620 AND a narrower window; a state believed unreachable (not-ready)
    is BLOCKED with a named cause — never silently omitted.

## F-43 (Q-4 / AC-2) — Companion panel follows the live accent; `--hover-bg` resolves

- [ ] F-43: For dark, light, and the non-default accent, read live computed styles of the
      companion setting rows (`background`), the section labels, the `Switch` track/thumb (ON and
      OFF), the auto-return `NumberInput` (bg/border/focus ring), the Teleport tip surface, and
      the `kbd` chip; then change the accent live with Settings open.
  **Expected:** every color derives from the theming feature (token/CSS var/`tint()`) and the
      accent-linked surfaces re-tint together with no stale color. **`--hover-bg` (T1) must
      resolve** — `getComputedStyle(row).backgroundColor` is NOT `rgba(0, 0, 0, 0)`/`transparent`
      (T1 is a single derived `color-mix(in srgb, var(--text-primary) 6%, transparent)` set once in
      the `ThemeProvider` base pass, so it resolves per-theme — NOT the `--card-hover-bg` alias,
      which freezes the classic dark gray). A row that computes transparent where a surface is
      intended is a FAIL.
  - **Edge:** switch accent WHILE the NumberInput is focused (no stale border); toggling companion
    ON/OFF changes ONLY the toggle position + tip content visibility — the tip's `opacity` /
    `pointerEvents` / contrast must NOT change (H6 resolved: always `opacity: 1`,
    `pointerEvents: auto`; F-47).

## F-44 (Q-3 / AC-2) — Zero hardcoded color literals in the companion files

- [ ] F-44: Grep the audited companion files (`CompanionSettingsPanel.tsx`,
      `CompanionSetupWizard.tsx`, `SetupStepCard.tsx`, `ModelFilesStepCard.tsx`,
      `ServerLaunchStepCard.tsx`) for `#[0-9a-fA-F]{3,8}`, `rgba(`, `rgb(`, `hsla(`, and the
      invalid alpha-append `var\(--[a-z-]+\)[0-9a-fA-F]{2}`.
  **Expected:** ZERO true color literals (comment issue-refs like `#2864` exempt); translucent
      surfaces use `tint()` and `var()` only. Any literal left in a listed file is a FAIL; name
      the file:line.
  - **Edge:** `transparent`/`inherit`/`currentColor`/`none` are allowed; distinguish the
      `var(--x)NN` FAIL from a JS-concatenated 8-digit hex (OK).

## F-45 (Q-5, Q-6 / AC-3) — Companion control contrast (AA) + local feedback < 400 ms

- [ ] F-45: From live computed colors, compute contrast for: setting-row title vs its `--hover-bg`
      surface; help text vs the same surface; the Switch track vs surrounding; NumberInput text
      vs input bg; the `s` suffix/label; tip body text vs tip surface. Then timestamp
      click→visible-change for the toggle and the input focus ring.
  **Expected:** text ≥ 4.5:1 and non-text UI ≥ 3:1 in dark AND light AND the non-default accent;
      toggle/focus-ring feedback ≤ 400 ms (CSS transition 0.15–0.2 s). Quote the measured ratio
      and ms. A failing pair is a FAIL naming the ratio.
  - **Edge:** light theme + a light/desaturated accent preset; the `kbd` chip legibility; rapid
    repeated toggles.

## F-46 (Q-7 / AC-3) — Companion reading order, single-wizard gate, a11y wiring

- [ ] F-46: DOM/a11y + screenshot the Companion panel and the not-ready wizard. Inspect reading
      order (section header → setting rows → Teleport tip), grouping/spacing vs sibling sections,
      keyboard tab order, and the `aria-describedby` link on the idle input.
  **Expected:** clear reading order with consistent grouping; the ready view AND the not-ready
      gate render the SAME unified section header — `<Heading as="h2">` + 22px accent icon
      (`var(--accent-primary)`, `aria-hidden`) + `fg.default` title (+ `fg.subtle` description)
      (H4 resolved: one treatment, no `fg.default`-vs-`var(--text-primary)` conflict and no bare
      uppercase mini-label standing in for the heading); the not-ready gate renders ONE wizard (no
      toggle/tip duplication — `CompanionSettingsPanel.tsx:77-104`); keyboard order matches visual
      order; `#companion-idle-timeout-seconds` is described by `#companion-idle-timeout-help`.
  - **Edge:** long help text wrapping; a feature-settings section present in the sidebar.

## F-47 (Q-12 / AC-5) — Teleport-tip is never dimmed; input states do not regress under theme/accent change

- [ ] F-47: Toggle the companion ON/OFF and inspect the Teleport tip computed `opacity` +
      `pointerEvents` + foreground/contrast in BOTH states; focus/blur the auto-return input and
      read its border; type an out-of-range draft. Repeat after a theme and accent change.
  **Expected:** the tip is NEVER dimmed (H6 resolved) — computed `opacity: 1` /
      `pointerEvents: auto` and full text contrast (≥4.5:1 body vs tip surface) in BOTH companion
      ON and OFF; toggling changes only the switch position and the tip's content visibility, never
      its opacity/pointer-events/contrast. The input's focus ring uses the live accent. An invalid
      draft (non-numeric or outside 5–3600, e.g. `9999`) shows a `var(--status-error)` border (+ a
      matching `status.error` focus ring) and swaps the help to the range message ("Enter 5–3600
      s"); committing it clamps to the valid range and a polite `aria-live` region announces the
      committed value ("Auto-return set to 3600 s") within 400 ms. The states survive a
      theme/accent change with no stale color and no console error.
  - **Edge:** theme change while OFF; theme change mid-edit with a half-typed invalid draft;
    reduced motion (E-29).

## F-48 (Q-13 / LIVE) — Mandatory `telemetry_spans` + rendered-webview receipt

- [ ] F-48: Same run as F-42..F-47: `fredo emit --event-type chat` + `--event-type tool_use`
      with distinct session ids; query `telemetry_spans` + row tables (telemetry-query skill);
      retain screenshot raw URLs + DOM/computed-style/geometry for the companion states.
  **Expected:** `telemetry_spans` returns a NON-ZERO count with a recent `max(timestamp)`; the
      emitted events classify into `chat_rows`/`tool_use_rows` under their session ids; a
      rendered receipt exists for each companion state. A static-only PASS is a **FALSE PASS**.
  - **Edge:** re-run on the tested tip; keep the emit + query output verbatim.

### Testing round 1 (spec/2864 @ f2c8923, product 5c0fb5b) — results

- **F-42 PASS (live).** The 21-frame BEFORE matrix was captured and read by the UI/UX Expert (`visual-eval-before.md`, 21/21). Representative frames re-uploaded (see `.opencode/tests/settings/functional.md` F-1).
- **F-43 PASS (live).** Setting rows / tip compute `background: var(--hover-bg)` = `color(srgb .8 .8 .8/.06)` (dark) / `color(srgb .047 .067 .090/.06)` (light) — real fills, NOT `rgba(0,0,0,0)`. Switch checked track = live accent (`rgb(147,51,234)` / `rgb(0,209,209)` / `rgb(234,179,8)`), checked thumb = `--accent-contrast` (`rgb(255,255,255)` dark, `rgb(12,17,23)` light/accent). NumberInput bg `--card-bg`, border `--border-color`.
- **F-44 PASS (static).** Zero true color literals in `CompanionSettingsPanel.tsx`, `CompanionSetupWizard.tsx`, `SetupStepCard.tsx`, `ModelFilesStepCard.tsx`, `ServerLaunchStepCard.tsx` (only comment issue-refs); no `var(--x)NN` alpha-append.
- **F-45 PASS with named residuals (live).** Text pairs ≥4.5:1 in dark+light+accent (help `fg.subtle` 4.57/7.31:1; row titles 13.01:1 dark); Switch non-text 5.38/9.96/9.88:1. Toggle DOM change 1.2 ms + 0.15 s transition; input focus ring instant. Residuals (pre-existing): inactive-nav 4.05:1 dark; gate body 1.53:1 dark (R3).
- **F-46 PASS (live).** Ready view renders the unified `<h2>` + 22px `var(--accent-primary)` icon + `--text-subtle` description; section `aria-labelledby`; ONE wizard in the gate (`companion-controls` absent); `#companion-idle-timeout-seconds` described by `#companion-idle-timeout-help`; tab order = visual order.
- **F-47 PASS (live).** Teleport tip has NO opacity/pointer-events dimming (full-opacity in ON and OFF). Invalid draft `9999` → `aria-invalid="true"`, border + focus ring `rgb(239,68,68)`, help "Enter 5–3600 s"; Enter commit clamps + announces **`Auto-return set to 3600 s`** via the `role=status aria-live=polite` region (transient 2500 ms). Survives theme/accent change; console clean.
- **F-48 PASS (live).** `telemetry_spans` 17,236, `max(ingested_at)` 2026-09-13T00:28:33.795Z; `chat_rows` q13-2864-chat=1; `tool_use_rows` q13-2864-tool/read_file=1.

---

## #2865 extension — Companion-section wizard UX visual audit

> Issue #2865 audits the not-ready wizard content that renders INSIDE the Companion settings
> section. These rows own the Companion-section context + the R3-residual card contrast; the full
> wizard state matrix / copy / progress / a11y rows live in `.opencode/tests/llama-setup/`
> `#2865` F-47..F-63. Rows map to the QA Plan `R-1..R-5` in `.opencode/tmp/2865/triage.md`.
> **Verification policy: live.** The UI/UX-authored visual evaluation/verdict are the AC1/AC4
> evidence; a testid/geometry-only check is a FAIL. **G-136 reconciliation:** F-45's round-1
> "gate body 1.53:1 dark (R3)" is now an explicit requirement (F-55), superseding the
> accepted-residual disposition — the historical record is kept, not deleted.

- [ ] **F-49 (R-1.1/R-1.2 / AC1):** From the PRE-FIX tip (G-110), `stop_llama_server` → open
      Settings → Companion and capture the not-ready wizard in dark + light + one non-default
      accent into `.opencode/tmp/2865/e2e/before/` (`before-*` names); confirm the UI/UX Expert's
      `.opencode/tmp/2865/visual-eval-before.md` READS every frame.
  **Expected:** the Companion section renders the wizard as its ONLY content (no toggle/tip/
      auto-return) in every frame; the visual evaluation is observation-based and names the files
      it read. A testid/geometry-only artifact = FAIL.
  - **Edge:** unreachable `checking` frame → BLOCKED-with-cause; re-capture invalidates the pair.

- [ ] **F-50 (R-2.4/R-2.6 / AC2):** In each wizard state read the Companion section's summary +
      step status; screenshot and repeat desaturated.
  **Expected:** every state communicates with icon + text (summary checking / partial /
      all-installed; per-step label); states are distinguishable at a glance without color. A
      color-only state = FAIL. Cross-ref llama-setup F-49/F-52.
  - **Edge:** the `checking` summary and per-step `Checking…` both visible; no blank first paint.

- [ ] **F-51 (R-2.2 / AC2, H3):** Force a step failure and a server `failed`/`exited`; read every
      visible detail + console.
  **Expected:** actionable copy naming the cause + next step with Retry; ZERO raw stack/IPC
      strings visible (no `at …`, `.rs:`, raw `Error:`/JSON envelope/`invoke`). Cross-ref
      llama-setup F-50.
  - **Edge:** an error after partial progress still actionable; error state visually distinct.

- [ ] **F-52 (R-2.1/R-2.3 / AC2, H6):** During a per-file download read the determinate progress; during
      install/server-starting sample the caption.
  **Expected:** determinate progress advances with real bytes; unknown-duration work shows a moving
      affordance + changing phase narration, never a frozen screen. Cross-ref llama-setup F-51.
  - **Edge:** the watchdog wait has its own narration; a static caption during work = FAIL.

- [ ] **F-53 (R-3.4 / AC3, H4/H5):** Compare the wizard content against Settings → Fredo Setup in
      the SAME dialog (typography/spacing/radii/heading treatment); screenshot side-by-side +
      computed values, dark and light.
  **Expected:** same tokens/typography/spacing/radii family; name every divergence with its delta.
      The `bg.subtle` summary bar (`CompanionSetupWizard.tsx:145`) is a named H4 target. Any
      off-brand divergence = FAIL naming it.
  - **Edge:** the dialog chrome is #2864 scope (out of scope here); only the wizard content.

- [ ] **F-54 (R-3.1 / AC3):** Static grep the wizard files hosted in the Companion section
      (`CompanionSetupWizard.tsx`, `SetupStepCard.tsx`, `ModelFilesStepCard.tsx`,
      `ServerLaunchStepCard.tsx`) for hex/rgba/rgb/hsla + `var(--x)NN`.
  **Expected:** ZERO true color literals; token/CSS-var/`tint()` only. Any literal = FAIL file:line.
  - **Edge:** comment issue-refs exempt; distinguish `var(--x)NN` from a JS 8-digit hex concat.

- [ ] **F-55 (R-3.2 / AC3, H3/H9 — supersedes the F-45 residual):** Measure the not-ready-gate
      card body/path/detail text vs its tinted card in dark + light + accent, specifically
      `rgb(82,82,91)` on the success-tinted card `rgb(42,59,53)`, 12px (**1.53:1** BEFORE).
  **Expected:** ≥4.5:1 (or ≥3:1 for large/bold); the BEFORE 1.53:1 is RESOLVED and the AFTER ratio
      reported. Root cause: `fg.muted`/`fg.subtle`/`fg.default` semantic-token bridge not
      resolving to Fredo vars (theming E-12/R3). Any pair < AA = FAIL naming it.
  - **Edge:** measure dark classic AND dark+amber plus light and the accent override; the
    before/after ratio pair is required evidence.

- [ ] **F-56 (R-5.1/R-5.2 / AC5):** Confirm the gate still shows the wizard ONLY while not ready and
      swaps to the controls in place; verify the frozen Companion hooks still present; run
      `pnpm --filter @fredo/ui build` + `pnpm --filter @fredo/ui test:run`.
  **Expected:** no reload on swap (timeOrigin/nav unchanged); hooks retained
      (`companion-setup-wizard`, `companion-step-*`, `data-state`, `data-server-state`); build exit
      0; suite green; no assertion weakened (G-125). A dropped hook / weakened test = FAIL.
  - **Edge:** a moved hook with an owned refresh named per G-125 is acceptable.

- [ ] **F-57 (R-4.1/R-4.2 / AC4):** Capture the AFTER wizard frames into
      `.opencode/tmp/2865/e2e/after/` (`after-*`, distinct from BEFORE per G-135); confirm the
      UI/UX Expert's `.opencode/tmp/2865/before-after-verdict.md` pairs them and dispositions every
      AC-1 issue.
  **Expected:** every BEFORE cell has a comparable AFTER; the verdict names improvements +
      regressions and gives each issue exactly one disposition. A testid-derived verdict = FAIL.
  - **Edge:** re-run on the tested tip; keep BEFORE frames untouched.

- [ ] **F-58 (R-5.4 / LIVE):** Same run: `fredo emit` chat + tool_use; query `telemetry_spans` +
      `chat_rows`/`tool_use_rows`; keep screenshots + the receipt.
  **Expected:** `telemetry_spans` NON-ZERO with a recent `max(ingested_at)`; rows classify under the
      session ids. A static-only PASS is a **FALSE PASS**.
  - **Edge:** re-run on the tested tip; keep the output verbatim.

---

## #2870 extension — one Fredo at home: in-place companion, empty seat, welcome bubble, no-shift

> **Binding corrected intent (human directive 2026-09-12):** one Fredo; companion enabling does NOT
> relocate him (home = desktop centre, always); teleport is the only relocation; NO drag; when he is
> away the centre renders an empty-seat placeholder at the exact 80×100 `AVATAR_SM` footprint so the
> launcher bar never shifts; every turn-on shows a ~4 s welcome bubble (no TTS); no corner state.
> **G-136 supersede:** F-21's "companion ON ⇒ desktop mascot not rendered / OFF ⇒ mascot shown" gate is
> SUPERSEDED — enabling the companion now keeps Fredo AT the centre seat (role active in place). The
> historical PASS record above is preserved, not deleted.
> **Verification policy: live** — evidence per case: `tauri_webview_execute_js` DOM/geometry probes +
> `tauri_webview_screenshot` (distinct BEFORE/AFTER dirs, G-134/G-135) + `tauri_read_logs(source="console")`
> in BOTH windows. The mandatory live receipt is F-67; a static-only PASS is a FALSE PASS.
> **Serving checkout:** spec branch on a running Fredo desktop app (MCP driver `com.fredo.app`); LLM model +
> mmproj loaded for F-59 interactivity; Run CLI terminal for F-65; idle timeout 5 s for the auto-return legs.
> **Reach recipes (G-138):** (a) away-within-main = Ctrl+right-click in main; (b) hosted-in-terminal =
> Ctrl+right-click inside the `run-cli-terminal` window; (c) auto-return = 5 s idle timeout in Settings →
> Companion (or MCP `tauri_ipc_emit_event` on `companion-teleport`).

## F-59 (R-1a / AC1, Q-1) — Companion ON keeps Fredo at the centre home seat, role active in place

- [ ] F-59: Toggle the companion ON (Settings → Companion Switch). Probe the launcher centre column: seat-slot DOM, the seat entity's role, its bounding box, and screenshot.
  **Expected:** Fredo renders AT the centre home seat (the interactive seat entity inside the always-present seat box in `LauncherShell`'s centred column); the role is active IN PLACE — single-click streams a joke with the talk/joking expression, double-click opens TicTacToe (208×268); NO `position:fixed` bottom-right/corner wrapper appears; the seat box did NOT unmount on the flip. Screenshot shows Fredo centred, not in a corner.
  - **Edge:** toggle ON with the terminal window open; ON while a joke stream is live; rapid ON/OFF settles to exactly one entity; ON at 700×900. Reference #2850 F-7/F-8 (joke/game behavior).

## F-60 (R-1b/R-1c / AC1, Q-2/Q-3) — OFF ⇒ decorative mascot at the SAME seat; no corner state anywhere

- [ ] F-60: Toggle the companion OFF; probe the seat. Then, after both an ON and an OFF, probe for any bottom-right/corner position state (DOM + grep the changed companion files for the removed corner default).
  **Expected:** OFF ⇒ the decorative mascot (`.fredo-avatar-idle`, `<FredoAvatar size="sm">`, 58 rects) renders at the SAME centre home seat; the interactive seat entity is gone; persisted `Fredo_companion_visible="false"`. No component reads/writes a bottom-right default position (the old `{x: innerWidth−120, y: innerHeight−160}` corner default is REMOVED, not merely unused); no corner wrapper node exists at settle; the centre-seat x/y is the slot's flow position, not fixed corner coords.
  - **Edge:** OFF with the terminal open; OFF immediately after an auto-return; OFF while a game bubble is open (bubble cleaned); grep the changed files for the corner default.

## F-61 (R-2a/R-2b/R-2c / AC2, Q-4/Q-5/Q-6) — Turn-on welcome bubble, ~4 s auto-hide, no TTS (G-140 transient capture)

- [ ] F-61: Transition OFF→ON via the settings Switch and capture the bubble in the SAME `execute_js` task (G-140): poll ≤100 ms until the bubble node appears, return `{bubbleText, present, t: performance.now()}`, screenshot immediately; then sample presence every 250 ms until it disappears and compute the hold duration. Inspect the path for audio/TTS.
  **Expected:** a welcome bubble appears at the seat immediately on turn-on (`showMessage(WELCOME_TEXT, 4000)`) anchored ABOVE the slot (tail down, 240×120, `position:absolute` → zero layout participation) with the exact copy `At your service. How can I help?`; it auto-hides at ≈4 s (4000 ms ±500 ms), governed by the single cleared `dismissTimerRef` `setTimeout`; NO audio element/`speechSynthesis`/TTS call is made (visual only). If the async screenshot lands after the hide, the DOM capture + timestamped duration sampling is the evidence.
  - **Edge:** toggle OFF and ON again mid-bubble (timer cleared, new bubble re-armed); bubble at the narrow window stays on-screen; reduced motion does not remove the bubble (only motion). Reference #2850 F-7 (bubble) + the `Home.tsx` greeting precedent.

## F-62 (R-3a / AC3, Q-7) — Away ⇒ empty-seat placeholder at the exact 80×100 footprint

- [ ] F-62: Reach away-within-main (recipe a) and away-in-terminal (recipe b). Probe the main seat slot: placeholder `offsetWidth`/`offsetHeight` (G-040), the seat box's `mb`/margin, and the command-bar `getBoundingClientRect().y`.
  **Expected:** WHILE away, the launcher centre column renders the empty-seat placeholder at EXACTLY `AVATAR_SM` 80×100 (`offsetWidth`=80, `offsetHeight`=100) at the SAME slot INCLUDING the existing `mb="4"` spacing (column height unchanged from the home states); the placeholder is token-native and visually distinguishable from Fredo; observable hooks `data-state="away"`, `role="img"`, `aria-label="Fredo is away"` (not focusable, not a button).
  - **Edge:** away at default AND 700×900; placeholder when the away overlay is itself auto-hidden (still shows at the main seat); reset then re-probe for determinism.

## F-63 (R-3b/R-3c / AC3, Q-8/Q-9) — Home ⇒ Fredo (interactive ON / decorative OFF), never placeholder; OFF is NOT the placeholder

- [ ] F-63: At home, probe the seat with role ON and role OFF. Then probe preference OFF vs role-ON-away vs role-ON-away-auto-hidden.
  **Expected:** home + ON ⇒ interactive Fredo at the seat; home + OFF ⇒ the decorative mascot at the seat; the placeholder is NEVER rendered while home. Preference OFF ⇒ the decorative mascot at the seat, NOT the placeholder (**SI CONFIRMED**); the placeholder renders ONLY when the role is ON AND Fredo is away; an auto-hidden away Fredo still shows the placeholder at the main seat.
  - **Edge:** OFF with a stale away flag in the context (SET_VISIBLE ⇒ `isAway=false`); a remote `companion-presence {away:true}` while OFF must not render the placeholder; alternate ON/OFF at home.

## F-64 (R-4a/R-4b / AC4, Q-10/Q-11) — Launcher command-bar `y` invariant across ON/OFF and idle auto-return

- [ ] F-64: Measure `LauncherCommandBar` `getBoundingClientRect().y` with companion ON vs OFF (same window/size). Then set the idle timeout to 5 s, let auto-return settle, and re-measure.
  **Expected:** |y_ON − y_OFF| ≤ 1 px; the `mb="4"` slot margin and the centred-column height are constant in both states (the seat box is rendered unconditionally). After the #2853 idle-auto-return settle the command-bar `y` is unchanged (≤1 px) vs both the pre-return ON state and the OFF baseline — the seat slot never unmounts across the return.
  - **Edge:** rapid ON/OFF 5×; ON/OFF with the grid engaged; auto-return while the launcher is covered by a window (assert geometry, NOT Z-order, per the #2853 PO note); repeat at 700×900. Reference launcher R-35.

## F-65 (R-5a/R-5b/R-5c / AC5, Q-12/Q-13/Q-14) — Cross-window: main shows the empty seat, never a second Fredo; auto-return re-occupies it

- [ ] F-65: `open_run_cli` → `run-cli-terminal`; confirm both windows (`tauri_manage_window(action="list")`). Ctrl+right-click INSIDE the terminal. Probe main + terminal in the same sampling task: interactive-Fredo count per window, main seat state. Then set idle timeout 5 s, let the host auto-return settle, and re-probe main. Read `tauri_read_logs(source="console")` on BOTH windows after every leg.
  **Expected:** WHILE hosted in the terminal, the main desktop renders the EMPTY SEAT at the centre slot and does NOT render a second Fredo — global interactive-Fredo count == 1 (terminal hosts it; main = 0 interactive + 1 placeholder), with no transient second Fredo (the leaving window's `markAway()` sets `isAway` locally before the broadcast lands). WHEN the host idle auto-return settles, the main seat is RE-OCCUPIED by Fredo via `companion-presence {idle-settle}`. Both windows' consoles are free of `Error:`/`Uncaught`/`Maximum update depth exceeded`.
  - **Edge:** teleport mid-joke/game; two rapid cross-window teleports (no ghost); close the terminal mid-transit (main recovers); auto-return with the main window unfocused; **environment note:** if Run CLI cannot launch, mark F-65 BLOCKED-environment — never downgrade to a same-window PASS. Reference window-manager S-12 + #2850 F-10/R-4.

## F-66 (R-NF, Q-15/Q-16) — Token-native + reduced-motion + CLS/no-shift + no re-render loop

- [ ] F-66: Static-grep the changed files for `#[0-9a-fA-F]{3,8}`/`rgba(`/`rgb(`/`hsla(`/`var(--x)NN`; drive a reduced-motion pass and read the placeholder/seat computed `animation-name`; probe `scrollHeight`/scrollbar/overflow in OFF, ON-home, ON-away at default AND 700×900; inspect the location-state code for effect/memo deps; count window listeners.
  **Expected:** EmptySeat + seat chrome are token-native (outline `var(--text-subtle)` + fill `tint('var(--accent-primary)', 5)`) — ZERO color literals, NO `var(--x)NN` alpha-append (#2770); EmptySeat is STATIC (no animation → reduced motion trivially satisfied; any future motion must be opacity/transform-only + `animation:none` under reduced motion); the welcome bubble's entry spring is fade-only under reduced motion; the outline resolves ≥3:1 vs `--card-bg` in light AND dark, accent-independent; re-theming re-tints with no stale color. No new scrollbar/overflow/clip in any state at either width (reserved slot); no effect/memo depends on array `.length` or freshly-created objects (AGENTS.md #523); console shows no `Maximum update depth exceeded`; window listeners (`mousedown`, `companion-teleport`, `companion-presence`) are registered once per window, never per surface.
  - **Edge:** comment issue-refs are not literals; reduced-motion emulation is a named blocker if the driver cannot flip `matchMedia` → static-CSS verification + a findings note; accent light/purple/amber; many re-renders during a bubble/teleport.

## F-67 (R-LIVE, Q-17) — Mandatory live telemetry + rendered-webview receipt

- [ ] F-67: Same run as F-59..F-66: `fredo emit --event-type chat` + `--event-type tool_use` with distinct session ids; query `telemetry_spans` + `chat_rows`/`tool_use_rows` (telemetry-query skill); retain DOM + screenshot receipts (BEFORE/AFTER dirs).
  **Expected:** `telemetry_spans` returns a NON-ZERO count with a recent `max(ingested_at)`; the injected events classify into `chat_rows`/`tool_use_rows` under their session ids; a rendered-webview receipt (DOM snapshot / screenshot / measured geometry) of the seat states exists. **A static-only PASS with no `telemetry_spans` receipt is a FALSE PASS.**
  - **Edge:** re-run the receipt on the tested tip (the branch may move); keep the emit + query output verbatim.

## F-68 (R-NF / lifecycle — promoted from the round-2 exploratory finding, defect F-68) — Auto-return settle → teleport MUST re-arm the away overlay and the idle gate (no stuck zero-Fredo)

> **Origin (promoted exploratory).** Round-2 exploratory finding (defect **F-68**, SI observations
> 2026-09-13, root-cause class `defect`): after `AUTO_RETURN_SETTLED` set `isAutoHidden=true`, a
> subsequent `TELEPORT` set `isAway=true` WITHOUT clearing `isAutoHidden`, so the away overlay's
> gate (`isVisible && !isAutoHidden && isHosting`) hid it and the idle gate never re-armed →
> **zero Fredos, stuck until a companion toggle**. Promoted to a durable functional row (#2870
> round 3). Reference F-22/F-26/F-65 + window-manager S-12.

- [x] F-68: Set idle timeout 5 s (Settings → Companion) with the companion ON. Let the idle
      auto-return settle (Fredo home; `isAutoHidden=true`). Then teleport away (recipe a —
      Ctrl+right-click in main; or the sanctioned recipe c — MCP `tauri_ipc_emit_event` on
      `companion-teleport`). In the SAME `tauri_webview_execute_js` task / after the settle, sample:
      the global interactive-Fredo count (`.fredo-companion-avatar` across every window), the main
      seat content (`.fredo-avatar-idle` | `[data-state="away"]` | `.fredo-companion-avatar`), the
      seat-slot wrapper geometry, and `tauri_read_logs(source="console")`. Then stay quiet for a full
      idle period and re-probe.
  **Expected:** the teleport transition CLEARS the transient `isAutoHidden` flag as well as setting
      `isAway=true`; after the teleport settles there is **exactly ONE interactive Fredo present —
      the away overlay** (`.fredo-companion-avatar` count == 1, in the destination/host window),
      the main seat renders the `EmptySeat` placeholder (`data-state="away"`), and the global
      interactive-Fredo count is NEVER left at 0; the idle gate RE-ARMS for the away host, so after
      a full quiet period `AUTO_RETURN_SETTLED` returns Fredo home (seat re-occupied by the seat
      entity, no placeholder) — i.e. the state machine recovers WITHOUT a companion toggle.
      Console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.
  - **Edge (the F-68 signature):** after the auto-return settle, the FIRST teleport is the
    regression trigger — assert count == 1 (never 0) after it; a subsequent auto-return must
    re-arm the timer (repeat the settle→teleport→settle cycle and confirm it recovers every time,
    no drift/stuck). Auto-hidden away (`isVisible && isAway && isAutoHidden`) still shows the
    placeholder at the main seat (F-63).
  - **Round-3 pin:** this row is the durable pin for the `isAutoHidden`-vs-`TELEPORT` interaction;
    a post-auto-return teleport that yields zero interactive Fredos (or never re-arms the idle
    gate) is a FAIL.

### #2870 round 3 (spec/2870 @ e27ff0a9) — results

Verdict: **PASS** — round-2's two defects are fixed: the seat/placeholder footprint is exactly
80×100 (Chakra CSS-px strings, `AVATAR_SM_CSS`/`toCssPx` in `fredoAvatarSizes.ts`) and the
`TELEPORT`/`MARK_AWAY` transitions clear the stale `isAutoHidden`/`isAutoReturning` (F-68).

- **F-59 PASS (live).** ON-home seat: `.fredo-companion-avatar` = 1 at the centre seat, seat-slot
  WRAPPER `offsetWidth`=80 / `offsetHeight`=100, wrapper centre-x 960 == centred-column centre-x
  960 (Δ0), 0 `position:fixed` wrappers. Single-click → real joke stream (`[companion] llm-token:`
  …, state `joking` → `happy`); double-click → TicTacToe 208×268 with 9 cells. Screenshot
  `after-r3-01-ac1-on-home.png`, `.opencode/tmp/2870/tests-runs.md`.
- **F-60 PASS (live + static).** OFF ⇒ `.fredo-avatar-idle` (64 rects incl. the `thinking`
  desktopState expression) at the SAME seat, WRAPPER 80×100, centre-x 960; persisted
  `Fredo_companion_visible="false"`. Grep `apps/ui/src/shared` for the old corner default
  (`innerWidth - 120` / `innerHeight - 160`) → ZERO; no corner wrapper node at settle.
  Screenshot `after-r3-02-ac1-off-mascot.png`.
- **F-61 PASS (live).** Same-task OFF→ON capture: bubble text exactly `At your service. How can I
  help?`, `position:absolute`, rect left 841.6 / top 217.2 / w 236.8 / h 118.4 / centre-x 960
  anchored above the seat slot (bottom 335.6 ≤ seat top 345.8), hold 4382–4387 ms (two runs;
  4000 ±500). `speechSynthesis.speaking=false`, `audio` elements 0, no audio/TTS source.
  Screenshot `after-r3-03-ac2-welcome-bubble.png`.
- **F-62 PASS (live).** Away (recipe a) placeholder `offsetWidth`=80 / `offsetHeight`=100,
  `data-state="away"`, `role="img"`, `aria-label="Fredo is away"`, not focusable
  (`tabindex` null); seat-slot wrapper 80×100 + `margin-bottom:16px`; centre-x Δ0. Away at
  700×900 also 80×100. Screenshot `after-r3-06-ac3-away-empty-seat.png`.
- **F-63 PASS (live).** home+ON ⇒ interactive entity; home+OFF ⇒ mascot; placeholder absent while
  home; ON+away ⇒ placeholder; ON+away+auto-hidden (MCP `companion-presence {away:true,
  autoHidden:true}`) ⇒ placeholder STILL at the seat (0 interactive); preference OFF + remote
  `companion-presence {away:true}` ⇒ mascot, NOT the placeholder.
- **F-64 PASS (live).** Command-bar `getBoundingClientRect().y`: OFF 485.77, ON-home 485.77,
  ON-away 485.77, through the welcome bubble show/hide 485.8, after the 5 s idle auto-return
  485.77 → |Δ| = 0 ≤ 1 px in every state (the seat slot never unmounts).
- **F-65 PASS (live).** `run-cli-terminal` opened via the Run CLI launcher tile; Ctrl+right-click
  INSIDE the terminal (recipe b) → aligned 80 ms samplers: main `away` (0 interactive) 791207→
  796622 while terminal `.fredo-companion-avatar`=1 791176→796591 — global interactive count
  == 1, never 2; the 5 s host idle auto-return re-occupied the main seat. Both consoles
  error-free. Screenshots `after-r3-07-*`, `after-r3-08-*`.
- **F-66 PASS / reduced-motion finding (live + static).** Zero true color literals in
  `EmptySeat.tsx` + the seat region of `LauncherShell.tsx` (only comment issue-refs); no
  `var(--x)NN` alpha-append; EmptySeat STATIC (no keyframes/transition). 700×900: seat 80×100,
  centre-x == column centre-x, `scrollHeight == clientHeight` (no scrollbar), no H-scroll, seat
  + bar fully visible in ON-home and ON-away. Light preset (`light-default`) outline
  `color(srgb .2586 .2961 .3425)` on `--card-bg` `#f7f8fa` ≈ **8.3:1** (≥3:1); dark base
  outline `srgb(.6267)` on the dark card ≥3:1; fill = `tint(var(--accent-primary),5)` re-tints.
  Console clean (no `Maximum update depth exceeded`); listeners registered once per window
  (stable-deps effects). **Finding (not an AC):** `matchMedia reduce=false` (driver cannot flip
  it — named blocker) so the reduced-motion leg is static-verified; the welcome bubble's
  framer-motion entry spring (`SpeechBubble.tsx:125-128`) is NOT gated by `useReducedMotion`
  (scale/translate, not fade-only) — the seat/companion CSS (`companion.css:112-129`) IS
  reduced-motion-safe and EmptySeat is static. Screenshots `after-r3-11-*`, `after-r3-09-*`,
  `after-r3-10-*`.
- **F-67 PASS (live).** `fredo emit --event-type chat` (session `q17-r3-chat-2870`) +
  `--event-type tool_use` (session `q17-r3-tool-2870`, `read_file`) → both `{"queued":true}`;
  `telemetry_spans` = **21,930**, `max(ingested_at)` = 2026-09-13T19:15:40Z; `chat_rows`
  `q17-r3-chat-2870` = 1; `tool_use_rows` `q17-r3-tool-2870` = 1. Rendered receipts = the
  round-3 screenshots/DOM under `.opencode/tmp/2870/`.
- **F-68 PASS (live — the round-2 defect is fixed).** Controlled in-page lifecycle sampler
  (`window.__f68`, 100 ms): start ON-home(1) → teleport-1 @308 ms → ON-away @805 ms
  (interactive=1) → idle auto-return settle @6303 ms → ON-home(1) → **teleport-2 @7608 ms (the
  post-auto-return trigger) → ON-away @8108 ms with interactive=1** → auto-return AGAIN @13610 ms
  (idle gate re-armed). `interactive==0` samples = **0** across the whole run, max = 1. The
  auto-hidden away state also renders the placeholder (F-63).

### #2870 round 4 (spec/2870 @ 7fddf3ab) — results

Verdict: **PASS** — round-3's reduced-motion finding is fixed: `SpeechBubble` now branches its
`motion.div` props on framer-motion `useReducedMotion()` (fade-only `opacity 0→1→0`, non-spring
`duration 0.2s easeOut` under reduced motion; the original spring `scale 0.88 / y initDelta` with
`type:'spring' stiffness 380 damping 30` otherwise; the absolute seat anchor `left:50% x:'-50%'` is
preserved in both). The shared component changed, so the full Q-1..Q-17 matrix was re-run live.

- **F-59 PASS (live).** ON-home: `.fredo-companion-avatar` = 1 at the centre seat, seat-frame WRAPPER
  `offsetWidth`=80 / `offsetHeight`=100, `margin-bottom:16px`, centre-x 960 == column centre-x 960
  (Δ0), 0 overlay `position:fixed` entities. Single-click → a real joke streamed from the companion
  LLM ("Why did the programmer quit their job? Because they didn't get enough recursion!") with the
  seat-anchored 240×120 bubble — role active in place, no corner. Screenshots
  `after-r4-01-ac1-on-home.png`, `after-r4-01b-ac1-seat-joke.png`.
- **F-60 PASS (live + static).** OFF ⇒ `.fredo-avatar-idle` mascot at the SAME seat (80×100, centre-x
  960), interactive entity gone, persisted `Fredo_companion_visible="false"`. Grep of
  `apps/ui/src/shared` for the removed corner default (`innerWidth - 120` / `innerHeight - 160`) →
  ZERO.
- **F-61 PASS (live — the round-4 shared-bubble regression).** Same-task OFF→ON sampler (50 ms):
  bubble text exactly `At your service. How can I help?`, `position:absolute`, rect x840 / y215.8 /
  w240 / h120 / bottom 335.8 / centre-x 960 (seat top 345.8 → 10 px tail gap), hold **4508 ms**
  (4000 ±500; hide recorded 4561 ms after the click). Non-reduced entry is the SPRING: transform
  `matrix(0.898→0.947→0.989→0.998→1.002 overshoot→1, …, translateX(-120))` with y `5.11→0` — the
  bubble still animates. `speechSynthesis.speaking=false`, `<audio>` count 0. DOM receipts: the
  `tauri_webview_dom_snapshot` structure tree (`div.css-dmjht2 > div [motion] > div.css-ql5g4s >
  p.css-y1403h` + tail `div.css-1mt6uv2`) and the accessibility snapshot
  (`paragraph → text: "At your service. How can I help?"`, entity `Fredo companion -- talk`), plus
  the bubble `outerHTML` (`style="position:absolute; bottom:calc(100% + 10px); left:50%; width:240px;
  height:120px; z-index:101; pointer-events:none; opacity:1; transform:translateX(-50%)"`).
  Screenshot `after-r4-02-ac2-welcome-bubble.png`.
- **F-62 PASS (live).** Away (recipe a) placeholder `offsetWidth`=80 / `offsetHeight`=100,
  `data-state="away"`, `role="img"`, `aria-label="Fredo is away"`, not focusable, `pointer-events:none`;
  wrapper 80×100 + `margin-bottom:16px`, centre-x Δ0; command-bar `y` unchanged.
- **F-63 PASS (live).** home+ON ⇒ interactive entity; home+OFF ⇒ mascot; ON+away ⇒ placeholder
  (never a second interactive Fredo in main); OFF is never the placeholder.
- **F-64 PASS (live).** Command-bar `getBoundingClientRect().y`: OFF 485.77, ON-home 485.77,
  ON-away 485.77, post-host-auto-return 485.77 → |Δ| = 0 ≤ 1 px in every state.
- **F-65 PASS (live).** `run-cli-terminal` opened via the Run CLI launcher tile (windows = main +
  run-cli-terminal 900×600); Ctrl+right-click INSIDE the terminal → main placeholder + 0 interactive,
  terminal `.fredo-companion-avatar`=1 at the clamped point. Aligned 100 ms samplers across the
  terminal→main leg: terminal 1→0 @t and main 0→1 @t+43 ms — globally never 2 (a sub-sample 0 gap at
  the hand-off, destination arrives the next sample); at every settle global == 1. The host idle
  auto-return re-occupied the main seat. Screenshots `after-r4-05a-*`, `after-r4-05b-*`,
  `after-r4-06-*`.
- **F-66 PASS (live + static + product-unit).** Zero true color literals in `EmptySeat.tsx` +
  the seat region of `LauncherShell.tsx` + `SpeechBubble.tsx` (only comment issue-refs); no
  `var(--x)NN` alpha-append. EmptySeat STATIC; computed outline `border-style:dashed`, border
  `color(srgb 0.626667 …)` on `--card-bg`, fill `color(srgb 0.576 0.2 0.917 / 0.05)` (accent tint
  5%, re-tints). 700×900: seat 80×100, centre-x 350 == column centre-x, `scrollHeight == clientHeight`
  (no scrollbar), no H-overflow, seat + bar fully visible in ON-home and ON-away; console free of
  `Maximum update depth exceeded`; listeners once per window. Screenshots `after-r4-07-*`,
  `after-r4-08-*`. **Reduced motion (the round-4 fix):** the live leg is still NOT drivable — the
  driver cannot flip `matchMedia` (#2850 F-19 / #2854 F-38); a manual `window.matchMedia` override
  was attempted (reporting `matches:true` for `prefers-reduced-motion: reduce`) and the bubble STILL
  rendered the spring (`matrix(0.91→1.002→1, translateX(-120))`), confirming framer-motion caches
  the media query. **NAMED BLOCKER** for the live leg; the verification is the product-unit pin
  `SpeechBubble.reducedMotion.test.tsx` (reduced → opacity-only, no `scale`/`y`, non-spring;
  motion-enabled → scale 0.88/y6 + spring; absolute anchor preserved) — **6/6 PASS** on the tip, and
  the companion-focused regression suite **13 files / 109 tests PASS**.
- **F-67 PASS (live).** `fredo emit --event-type chat` (session `q17-r4-chat-2870`) +
  `--event-type tool_use` (session `q17-r4-tool-2870`, `read_file`) → both `{"queued":true}`;
  `telemetry_spans` = **22,637**, `max(ingested_at)` = 2026-09-13T19:49:26Z; `chat_rows`
  `q17-r4-chat-2870` = 1; `tool_use_rows` `q17-r4-tool-2870` = 1.
- **F-68 PASS (live — regression).** After a host idle auto-return settled Fredo home, a subsequent
  Ctrl+right-click teleport yielded exactly ONE interactive Fredo (the fixed overlay; 0 → never) plus
  the main `[data-state="away"]` placeholder (80×100). Code unchanged this round; the round-3
   full lifecycle cycle (teleport → auto-return → teleport → auto-return, `interactive==0` samples 0)
   remains the durable pin.

---

## #2871 extension — the command bar as a second companion message source

> Issue #2871 sends a launcher-bar message to the companion LLM while the companion is ACTIVE;
> the reply MUST use the companion's existing bubble/stream machinery (binding #2). These rows
> map to `.opencode/tmp/2871/triage.md` `## QA Expert` REQ-1..REQ-13 and REUSE the #2850/#2854
> streaming evidence approach. Live policy. **G-136:** no prior companion resolution is
> superseded — F-7/F-8/F-24 + R-33/R-34 remain in force; these are additive.

## F-69 (REQ-3) — Bar-sent message streams into the existing SpeechBubble (single-shot)

- [ ] F-69: Companion ON at the seat; send a real prompt from the launcher command bar; sync-sample
      the `SpeechBubble` `p` text + the wrapper state.
  **Expected:** the reply renders in the SAME seat-anchored 240×120 `SpeechBubble` used by the
      joke path (via `showMessage()`/the streaming state), growing token-by-token; ≥3 distinct
      partial contents (G-130); the request is single-shot (no prior transcript); no second
      bubble/surface is introduced.
  - **Edge:** long reply wraps without resize; control tokens stripped; a second send starts a
    fresh independent reply.

## F-70 (REQ-4/REQ-5) — Bar-sent generation drives the SAME busy/status flow + idle reset

- [ ] F-70: During a bar-sent stream sample the wrapper `data-state`/`data-streaming`; after
      `llm-done` sample the return; with a 5 s idle timeout, send a message near the deadline.
  **Expected:** the SAME flow as the joke path — `thinking` (wait) → `joking` (first token) →
      `happy` (on done, existing hold) → idle; the busy marker (`data-streaming`) clears on done;
      the send RESETS the idle auto-return timer (a message is an interaction, #2853 F-24).
  - **Edge:** send at the idle boundary; send while the welcome bubble is up; send right after an
    auto-return (with a fresh ACTIVE toggle).

## F-71 (REQ-6) — Bar-sent error/not-ready is readable and recovers to rest

- [ ] F-71: Stop the managed server (or set a bad `llama_server_path`) while the companion is ON;
      send from the bar. Separately kill it mid-stream. Read the bubble + console.
  **Expected:** the readable `llm-error` / `⏳ Loading model...` line surfaces in the bubble; the
      flow leaves `thinking`/`joking` cleanly (no false `happy`), returns to rest, and the idle
      timer re-arms; no stuck cursor/status; console clean.
  - **Edge:** error before any token; error after partial tokens; repeated error sends; the
    `llm-error`+`llm-done` pair completes once.

## F-72 (REQ-9) — One in-flight generation across BOTH sources (bar + click)

- [ ] F-72: Start a bar-sent stream; while it runs, single-click the avatar (joke trigger) and
      press Enter again in the bar; sample the bubble/state.
  **Expected:** at most ONE generation in flight — the click/2nd Enter is ignored (`isGenerating`
      guard) rather than interleaving; the in-flight bubble is not clobbered by a second stream.
  - **Edge:** click first then Enter; rapid alternation; a stale token from the first stream never
    lands in a later bubble. Reference F-7 + R-2.

### #2871 testing round 1 (spec/2871 @ e5fa7612) — results

Live (real managed `llama-server`). Verdict **FAIL** (REQ-6/REQ-14/REQ-15/REQ-16).

- **F-69 PASS (live).** Bar prompt → reply in the SAME seat-anchored 240×120 `SpeechBubble`
  (`position:absolute`, above the slot, tail down); 3 incremental content partials + thinking = 4
  distinct (G-130). Single-shot; no second surface.
- **F-70 PASS (live).** `thinking` (wait, `data-streaming=true`) → `joking` (first token) →
  `happy` (on done, existing ~5 s hold) → `idle`; the send resets the idle timer.
- **F-71 FAIL (live).** Error/not-ready is NOT readable-as-curated: the `llm-error` payload is
  forwarded verbatim (`TauriAdapter.ts:79-82`) and the bubble shows the RAW backend string
  (`failed to start C:\…\bad-llama-server.exe: spawn …`); the flow renders **`happy`** on error
  (F-71 expects no false `happy`); the error is not announced in the live region. Recovery is fast
  (~700 ms; no hang).
- **F-72 PASS (live).** Enter-spam / click during a stream never started a 2nd generation; the
  `isGeneratingRef` + `generationRef` guards hold. (The extra Enter launched a tile — launcher F-58.)

### #2871 testing round 2 (spec/2871 @ bd168ee) — results

Verdict: the round-1 F-71 defect is **FIXED**. Live (real managed `llama-server`, `/health` 200
:8080). Full live evidence + per-AC screenshots in the issue's `## Tests Runs (round 2)`.

- **F-69 PASS (live).** Bar sends stream the reply into the SAME seat-anchored 240×120
  `SpeechBubble` (`Fira Mono` text node), single-shot. G-130 over-satisfied: a long closure prompt
  produced **11 distinct partial contents** (recorder `__rec2871`, 70 ms cadence; the 1,000-word
  prompt reached 2,638 chars). Control tokens stripped; no second reply surface.
- **F-70 PASS (live).** `thinking` (wait, `data-streaming="true"`) → `joking` (first token) →
  `happy` (on done, existing ~5 s hold) → `idle`; recorder showed the busy window opens at send and
  the bar `aria-busy`/`readOnly`/chip clear at `llm-done` (the ST-1r up-front `setState('idle')`).
  A send resets the idle timer (a message is an interaction).
- **F-71 PASS (live — was FAIL round 1).** With the managed server stopped and
  `llama_server_path` set to a REAL non-executable file
  (`C:\Code\fredo\.opencode\tmp\2871\bad-llama-server.exe`), a bar send surfaced EXACTLY the
  curated generic sentence `Fredo couldn't reply just now. Try again in a moment.` in the bubble
  (`<p>` Fira Mono text) — NOT the raw `failed to start …: spawn …` string. Recorder: `thinking`
  → `idle` with ZERO `happy` samples across BOTH error legs (`happyCount:0`); the single
  `role="status" aria-live="polite"` region (`data-testid="fredo-companion-live-region"`)
  announced the same readable sentence once; the bar returned to `search or command` /
  `readOnly=false` / `aria-busy` absent. Path restored to the real winget binary + relaunched
  (`healthy:true`). Cross-ref launcher F-53/F-56.
- **F-72 PASS (live).** Three REAL Enter keydowns were instrumented; during an in-flight stream an
  Enter landed with `streamingAtKeydown="true"`, `busyAtKeydown="true"`, `roAtKeydown=true` and
  `winsAtKeydown` unchanged — no second generation (`runGeneration` count unchanged) and no window
  opened. Console: one `runGeneration` + one `llm-done` per send across 12+ sends.

---

## #2878 extension — companion-origin dictation commit (PO case 1)

> Issue #2878 ST-3 completes the companion-origin commit on the shipped #2877
> `CompanionListeningBubble`: when a `companion`-origin utterance finalizes and
> `Fredo_companion_voice_autosend` is ON, the finalized transcript is dispatched EXACTLY ONCE
> through the ONE existing `askActiveCompanion()` path (no bar involvement, no focus steal);
> with autosend OFF nothing is dispatched and the text stays in the bubble's read-only preview
> (documented limitation). **Verification policy: live.** Serving `spec/2878 @ 33cf86d5`.

- [x] **F-73 (REQ-4.3 ON) — companion-origin finalize dispatches exactly once through `askActiveCompanion()` (live).** PASS. `stt_start {origin:"companion"}` → `companion-listening-bubble` (dot + preview + Stop) with the launcher bar cue ABSENT (0 `launcher-command-listening*` testids); a final + `stt_stop` with autosend ON → exactly ONE `runGeneration`; the bubble cleared.
- [x] **F-74 (REQ-4.3 OFF) — autosend OFF keeps the finalized text in the read-only preview, zero dispatch (live).** PASS-as-documented. A companion-origin final + `stt_stop` with autosend OFF → ZERO `runGeneration`; the bubble rendered `companion-listening-finalized` + `companion-listening-finalized-preview` = the finalized text ("Transcribed" header, no Stop control).
- [x] **F-75 (one-indicator routing / no focus steal) — companion-origin never surfaces the bar (live).** PASS. During a companion-origin session the bar cue is absent and `document.activeElement` is unchanged; on Ctrl+Space with the companion away the same holds (the #2878 F-62/REQ-CTRL.2 receipt).

### #2878 testing round 1 (spec/2878 @ 33cf86d5) — results

F-73..F-75 PASS (live). The round's FAIL is on the launcher surface (`launcher` F-63 /
`voice-input` F-53) — not on the companion bubble. Full receipts in the issue's `## Tests Runs`.

### #2878 testing round 2 (spec/2878 @ 99144a19, fix 99144a1) — results

- **F-73 re-verified PASS (live).** `stt_start {origin:"companion"}` → `companion-listening-bubble`
  with `companion-listening-stop`, the launcher bar cue ABSENT (0 `launcher-command-listening*`),
  `document.activeElement` unchanged; final `companion origin probe 3232` + real `stt_stop` with
  autosend ON → exactly ONE `runGeneration`; the bubble cleared. The ST-1r launcher fix does not
  touch the bubble (F-74/F-75 stand from round 1).

---

## #2882 extension — Enter's rule is independent of the companion; no dictation launches an app (G-136)

> Issue #2882 makes Enter's app-open rule independent of the companion (present / away / off /
> replying) and rules that a dictated transcript is ALWAYS a message to Fredo. Rows F-76..F-78 map
> 1:1 to the QA-Plan `REQ-6`/`REQ-7`/`REQ-9` of `.opencode/tmp/2882/triage.md` `## QA Expert`.
> **Verification policy: live** — real keystrokes + a HELD Space (`down` → wait → `up` with a recorded
> duration), DOM snapshots, screenshots, `tauri_read_logs(console)`, plus the mandatory
> `telemetry_spans` receipt.
>
> **G-136 SUPERSESSION (historical PASS/FAIL records above are PRESERVED):**
> - **F-73 / F-74 / F-75** pinned a companion-ORIGIN dictation session (`stt_start
>   {origin:"companion"}`) started by the Ctrl+Space cascade, and F-75's "on Ctrl+Space with the
>   companion away the same holds". **SUPERSEDED** — the Ctrl+Space listening cascade is RETIRED, so
>   that ROUTE no longer exists; the rows' PASS records stand as history and are NOT re-run as PASS
>   or FAIL. Dictation now lives in the bar (Ctrl+Space → hold Space → speak → Enter/the autosend
>   setting). If the Architect keeps the companion-origin code unreachable, that is a one-line
>   disposition at convergence (QA Discussion QA-6), not a tester FAIL.
> - **F-69 / F-70 / F-71 / F-72** (bar sends, streaming, error copy, one-in-flight) remain in force
>   unchanged — a dictated transcript now reaches Fredo through the SAME dispatch.

## F-76 (REQ-7 / AC5) — Enter opens the typed app in EVERY companion state

- [ ] F-76: For each companion state — present at the seat, AWAY (Ctrl+right-click), OFF
      (`Fredo_companion_visible=false`), and mid-reply (send a long prompt first) — type `set` with
      real keystrokes into `input[role="searchbox"]` and press Enter; repeat with `Miss` and
      `monitor`.
  **Expected:** the Settings window / Mission Monitor window opens in EVERY state with ZERO dispatch
      to Fredo (`runGeneration` unchanged); `set` is NEVER sent to Fredo. Enter's app-open rule does
      not depend on the companion.
  - **Edge:** away while hosted in `run-cli-terminal`; the busy window; the companion toggled OFF
    immediately before Enter.
  - **Receipt:** per state — the quoted window title, the window count, the `runGeneration` count.

## F-77 (REQ-6 / AC4 + PO amendment 1) — A dictated phrase never launches an app, whatever the companion is doing

- [ ] F-77: Autosend ON and OFF. In each companion state (present / away / off / mid-reply), hold
      Space on the focused empty bar, inject a synthetic final naming an app (`Settings`, `set`,
      `Miss`), release; with autosend OFF follow with a manual Enter.
  **Expected:** exactly ONE dispatch to Fredo (autosend ON: on release; OFF: on Enter after the text
      waits in the bar) and ZERO windows in EVERY state — `Settings`/Mission Monitor NEVER opens from
      a dictated phrase; with no active companion nothing is launched (the transcript is simply not
      delivered).
  - **Edge:** a dictated phrase that would match via prefix AND whole-word run; a dictated phrase
    edited by the user (still Fredo's); the in-flight busy window during a release.

## F-78 (REQ-9 / AC6 hint) — The hint tells the truth for the companion state actually in effect

- [ ] F-78: With the companion present / away / off / replying, read the hint chip +
      `#fredo-command-hint` for: a matching typed query (`set`), an unmatched typed query
      (`Missing all the time`), and a dictated transcript in the bar (`Settings`); then press Enter
      and record the action.
  **Expected:** the hint names the app that will open when the typed query matches, and reads as
      sending to Fredo when nothing matches or when the bar holds a dictated transcript — including
      when the companion is AWAY or OFF (where the hint must not promise a send that will not happen,
      nor a launch that will not happen). Assert the (hint, action) PAIR per state.
  - **Edge:** companion toggled between the sample and the Enter; busy → `Fredo is replying…`; the SR
    mirror equals the chip char-for-char; a theme/accent switch re-tints without changing the text.

### #2882 binding addendum (read before executing F-76..F-78)

- **Exact chip copy:** `↵ open <App name>` (typed match — visible **even with the companion OFF**;
  the `chatAvailable` gate is retired), `↵ send to Fredo` (unmatched typed text + active companion),
  `↵ send transcript to Fredo` (dictated, incl. after an edit), `no match` (unmatched typed text, no
  companion), `Fredo is replying…` (busy), `release Space to finish` (listening).
- **While `companionBusy`, a typed app MATCH still LAUNCHES** — the old busy GLOBAL Enter no-op
  becomes SEND-path-only. A typed NON-match while busy must NOT launch.
- **`VoiceOrigin` keeps the wire value `'companion'`** even though the frontend never requests it —
  do not fail on its presence in Rust (`commands.rs:73-74`); the retired surface is the FRONTEND
  bubble (ST-6 deletes `CompanionListeningBubble`).
- **`askActiveCompanion` must survive** (the bar's send path uses it) — its removal would be a FAIL
  of F-77.

### #2882 round 1 — tester run record (`spec/2882 @ f076fa08`, live)

**Rows F-76..F-78 PASS.** Verdict + per-REQ values: the `## Tests Runs (round 1)` comment on #2882.
Key receipts:
- Companion PRESENT: `set`/`Miss`/`monitor` each open the named window (`Settings` group /
  `mm-canvas-wrapper`) with `llmChat:0`; ambiguous `s` (renders `Mission Monitor, Settings,
  Stepper Probe`) → chip `↵ open Settings`, `aria-activedescendant="fredo-launcher-tile-1"`,
  Settings opens — the first RULE-matching entry, not the first rendered one.
- Companion OFF (`Fredo_companion_visible=false`, `.fredo-companion-avatar` absent): the chip is
  VISIBLE reading `↵ open Settings` (the `chatAvailable` gate is retired) and Enter opens Settings
  with 0 dispatch. Unmatched typed text with no companion → chip `no match`, Enter = no-op, text
  retained.
- Dictated `Settings` in the bar — companion present, autosend ON — released ⇒ 1 dispatch, ZERO
  windows; the same holds with autosend OFF (the text waits, then Enter sends it). No dictated
  phrase opened an app in any state.
- Away/OFF chord legs: ZERO listening emissions, NO companion listening bubble/dot anywhere in the
  DOM; `VoiceOrigin` on the wire was `"launcher"` in every observed `stt:state`.
- `askActiveCompanion` still works (it carried every send leg above).

**Lever note:** the chord had to be a dispatched correctly-shaped `KeyboardEvent`
(`code:'Space'`) — the MCP keyboard emits `code:" "`. See the `launcher` suite's #2882 round-1
      record for the full lever set. R-40's seat-geometry measurement was not re-run this round.

---

## #2883 extension — the reply gets room, stays put while read, and never collides with the bar

> Issue #2883 makes the companion reply surface grow with the reply, stay inside the window, never
> collide with the command bar, scroll when the answer is longer than the largest surface that fits,
> hold still while the reader is on it (pointer OR keyboard focus), and keep the scrolled-back
> reading position stable while new content arrives. Map 1:1 to `.opencode/tmp/2883/triage.md`
> `## QA Expert` REQ-4..REQ-11, REQ-15..REQ-18, REQ-21 (+ the bar-side rows in
> `.opencode/tests/launcher/` F-70..F-78). **Verification policy: live** — evidence via the MCP
> driver (`tauri_webview_execute_js` geometry/scroll samples, `dom_snapshot`, `screenshot`,
> `interact`, `wait_for`), `tauri_read_logs(source="console")`, per-REQ `upload-evidence --base
> spec/2883` raw URLs, and the live `telemetry_spans`/`chat_rows` receipt (F-90). Serving checkout:
> the `spec/2883` tip. Idle timeout 5 s only for the dismissal legs.
>
> **G-136 reconciliation (historical PASS records above are PRESERVED, never rewritten):**
> - **F-61** (welcome bubble 240×120, `showMessage(WELCOME_TEXT, 4000)`) is the AUTO-HIDE reference.
>   The new dismissal PROTECTION is ADDITIVE (F-83/F-84); the welcome bubble's own ~4 s auto-hide
>   stays in force when nothing is hovering/focused (R-44).
> - **F-69** pinned "the reply renders in the SAME seat-anchored **240×120** `SpeechBubble` ... long
>   reply wraps without resize". **SUPERSEDED for the TEXT reply surface** — the text reply now
>   grows and scrolls (F-79/F-82). The **208×268 game bubble** is OUT of scope and stays fixed
>   (R-42). F-69's "same bubble machinery, single-shot, no second surface" half remains in force.
> - **R-38 / R-40 / F-64** pin the RESTING/short-state geometry; extended, not deleted (see the
>   launcher #2883 R-45; do NOT fail this spec for reply-surface growth).

## F-79 (REQ-4 / AC2) — The reply surface GROWS with a long streaming reply (real volume class)

- [ ] F-79: Companion ON at the seat, managed `llama-server` healthy. Send
      `Write a 300-word story about a lighthouse.` from the bar; sample
      `[data-testid="fredo-reply-surface"]` `getBoundingClientRect` + `data-reply-tier` +
      `data-reply-kind` + the rendered text length at t0 and ~every 250 ms until done
      (≥5 samples, ≥3 WHILE still arriving); compare against the BEFORE baseline rect (pre-fix tip,
      `before-*` frame, distinct dir).
  **Expected:** the text reply surface GROWS with the arriving content (monotonic size increase;
      **≥3 distinct rect/text-length samples while the stream is still arriving** — the REAL
      streaming class, G-130 — not a short pre-filled bubble); it flips to
      `data-reply-tier="grown"` (`data-reply-kind="reply"`) with width `min(560, available)` and
      height `clamp(120, contentHeight, available)`, **substantially larger** than the base tier's
      fixed **240×120** (quote the before/after px); it never remains a fixed box showing only the
      opening lines while the bar reads `Fredo is replying...`.
  - **Edge:** TTFT >1 s (the wait is observable); a reply wrapping to ≥20 lines; a new turn
      REPLACING a long reply (the surface re-derives for the new content); a control token in the raw
      stream must not inflate the visible size; the game card `[data-testid="fredo-game-bubble"]`
      must NOT grow.
  - **Receipt:** the per-sample (t, rect, textLength) table + the before/after rects + the
    screenshot names.

## F-80 (REQ-5 / AC2) — The reply stays entirely within the window (all four edges)

- [ ] F-80: Capture ONE frame containing `[data-testid="fredo-reply-surface"]` AND all four window
      edges — at the default size (1400×900), at the shipped minimum **900×600**, and with Fredo
      teleported to each of the four screen edges (Ctrl+right-click at each corner, then send a long
      reply). Measure the reply rect + `window.innerWidth`/`innerHeight`.
  **Expected:** `reply.left ≥ 0`, `reply.top ≥ 0`, `reply.right ≤ innerWidth`,
      `reply.bottom ≤ innerHeight` in EVERY case — fully inside, nothing off-screen, no clipping at
      any edge. **900×600 is the scoring bound** (the shipped OS-enforced floor); a 700-wide
      viewport or the requester's 988×533 capture is a dev-viewport ADVISORY only, never PASS/FAIL.
  - **Edge:** near each corner — NOTE the SEAT candidate set is **`above > right > left` only**
    (`below` is exclusive to the fixed away-overlay path, so a seat `below` fall-through is NOT a
    scoring case; the `below` fall-through is scored by the overlay row, not here); a long reply at
    900×600; a window resize while the reply is up; both themes.
  - **Receipt:** the reply rect + the viewport per case + the frame names.

## F-81 (REQ-6 / AC2) — The reply NEVER overlaps or collides with the command bar

- [ ] F-81: In the EXACT state under test (a long wrapped query in the bar AND a long reply on
      screen), capture ONE frame containing BOTH `[data-testid="fredo-reply-surface"]` AND the bar
      (`[data-testid="launcher-command-bar"]` / field `[data-testid="launcher-command-input"]` /
      hint `[data-testid="launcher-command-hint"]` / the `Minimize launcher` control). Measure the
      reply rect, the bar rect, the field rect, the hint rect; compute the intersection areas.
  **Expected:** intersection area of the reply with the bar = **0**, with the field = **0**, and
      with the hint + collapse controls = **0** — the reply anchors per the bound SEAT candidate set
      **`above > right > left`** (`below` is exclusive to the fixed away-overlay path; do NOT score a
      seat `below` fall-through); the reply never paints beneath or over the bar at any anchor or
      window size. **Any collision ⇒ FAIL** (G-153 named combined frame + measured geometry; G-158 —
      a confirmed collision is a FAIL even if every other row passes).
  - **Edge:** reply anchored above AND to a side; the reply arriving while the bar GROWS (multi-line
    query, launcher F-72 cap 108 px); the shipped minimum 900×600; companion away/off (no reply —
    assert no residual surface); a window resize mid-reply.
  - **Receipt:** the named combined frame + the four rects + the intersection areas.

## F-82 (REQ-7 / AC3) — A reply longer than the largest surface that fits stays scrollable to the end

- [ ] F-82: At the shipped minimum **900×600**, send a reply longer than the largest surface that
      fits (heavily wrapped); read `[data-testid="fredo-reply-scroll"]`
      `scrollHeight`/`clientHeight`/`scrollTop`; set `scrollTop = scrollHeight`; compare the visible
      tail against the COMPLETED generation text.
  **Expected:** the grown reply has an internal scroller (`scrollHeight > clientHeight`,
      `overflow-y: auto`) and the scroll range reaches the end; the LAST words of the completed reply
      are in view — the whole answer is reachable. No content is clipped behind a fixed frame.
  - **Edge:** a reply with explicit newlines / list formatting; wheel AND keyboard scroll; after the
    stream ends; a very long reply at 900×600; a 700-wide viewport is advisory only.
  - **Receipt:** the `scrollHeight`/`clientHeight` pair + the visible tail text vs the completed
    text + the screenshot names (top + bottom).

## F-83 (REQ-8 / AC4) — Pointer over the reply suspends a countdown that ALREADY started

- [ ] F-83: Display a reply and let its dismiss countdown START (record the observable — the reply
      present with the timer armed / the state before the deadline). Move the pointer OVER
      `[data-testid="fredo-reply-surface"]` BEFORE/AT the deadline; sample presence at ≥3 intervals
      spanning ≥2× the dismiss period; read `isInUse`.
  **Expected (the binding scenario):** the reply STAYS visible for the whole time the pointer is over
      it (every sample present; no hide/remove) — specifically the countdown that had already started
      is SUSPENDED, not completed; it does not dismiss under the pointer. **R-4.4:** while protected
      the companion's idle auto-return is suppressed (`isInUse` true, the ONLY writer joins the
      predicate) — the reply is never unmounted mid-read.
  - **Edge:** pointer enters mid-countdown (the headline case); pointer enters exactly at the
    deadline; pointer over the reply while it is still streaming; an idle auto-return deadline in
    flight simultaneously (suppressed, then re-armed after protection ends); the reply anchored to a
    side.
  - **Receipt:** the per-sample (t, present) table across ≥2× the dismiss period + the countdown
    observable + the frame names.

## F-84 (REQ-9 / AC4) — It dismisses ONLY after the pointer leaves (with the grace period)

- [ ] F-84: From F-83, move the pointer OFF the reply; sample presence immediately after the leave,
      then across the bound grace period.
  **Expected:** the reply is still present IMMEDIATELY after the leave (the grace protects a brief
      off-target move) and is gone after the bound **`REPLY_LEAVE_GRACE_MS = 2000 ms`** — the timer
      is a FRESH full restart (a due clear is RE-ARMED, never resumed), so it dismisses ONLY after
      the pointer leaves + 2000 ms. A reply that vanishes the instant the pointer moves (no grace) OR
      never dismisses at all is a FAIL.
  - **Edge:** pointer leaves then re-enters within the 2000 ms grace; pointer leaves to another
    launcher surface; keyboard focus still on the reply while the pointer leaves (F-87's interaction).
  - **Receipt:** the leave timestamp + the presence samples + the measured clear delay (~2000 ms).

## F-85 (REQ-10 / AC5) — A scrolled-back reading position stays stable while new content arrives

- [ ] F-85: Start a long reply; WHILE it is still arriving, scroll back to an earlier offset in
      `[data-testid="fredo-reply-scroll"]`; record `scrollTop` + the top visible line text; keep
      sampling as new tokens arrive (≥3 arrivals). Also read the `atBottom`/`following` ref state.
  **Expected:** `scrollTop` and the top visible text do NOT jump to the bottom when new content
      arrives while the reader is scrolled back — the reading position is stable across ≥3 arrivals
      (no forced auto-scroll; `atBottom=false` ⇒ `scrollTop` kept and `following=false` reported, so
      the parent freezes the surface height). **A lost reading position ⇒ FAIL** (G-158).
  - **Edge:** scroll back mid-stream then let it finish; scroll back while a NEW turn starts; the
    shipped minimum 900×600; keyboard scroll-back; scroll back to the very top.
  - **Receipt:** the (t, scrollTop, topVisibleText, textLength) table across the arrivals.

## F-86 (REQ-11 / AC5) — A deliberate action returns the reader to the newest content

- [ ] F-86: From F-85's scrolled-back state, invoke the deliberate return-to-newest affordance — the
      labelled **`Newest`** `<button>` (rendered only when not at bottom) or its bound keyboard
      action. Read `scrollTop` + the visible text + `following`.
  **Expected:** the view returns to the newest content (bottom; the newest text + the streaming
      cursor visible); `following=true` resumes ONLY after this deliberate action (it did not
      silently resume earlier); a NEW generation resets `following=true`. The affordance is a
      labelled `<button>` (discoverable and named — REQ-17); under reduced motion the jump is
      instant (no smooth scroll).
  - **Edge:** return while still streaming; return after the stream ends; return then scroll back
    again (the protection re-arms).
  - **Receipt:** the pre/post `scrollTop` + the visible tail + the affordance's accessible name.

## F-87 (REQ-15/REQ-16/REQ-17) — Keyboard-only reach + keyboard protection + no colour/animation-only state

- [ ] F-87: Keyboard only (no pointer): focus `[data-testid="fredo-reply-scroll"]`
      (`role="region"` + `aria-label` + `tabIndex={0}`) and scroll to the end via the keyboard
      (`PageDown`/`ArrowDown`/`End`); record `document.activeElement`, its role/`aria-label`/
      `tabIndex`, and the `scrollTop`. Separately, while the countdown runs, move keyboard FOCUS onto
      the reply surface and sample presence across ≥2× the dismiss period, then move focus away. Then
      inspect the streaming, `Newest` and protected states in both themes + a non-default accent,
      reading labels/roles/`aria-*`; and under reduced motion.
  **Expected:** (a) the whole reply is reachable with the keyboard ALONE; the scroller is
      `role="region"` + `aria-label` + `tabIndex={0}`; Tab leaves it without a focus trap; the
      wrapper's `aria-hidden` is dropped while it renders a text message and the region is never
      `aria-live`/`role="log"` (no per-token announcements). (b) the reply stays visible while
      keyboard focus is inside it and dismisses only after focus leaves + the bound
      **`REPLY_LEAVE_GRACE_MS = 2000 ms`**; asserted INDEPENDENTLY of F-83/F-84. (c) each state
      carries a non-colour, non-animation-only affordance (the `Newest` control is a labelled
      `<button>`; streaming is exposed via `aria-busy`/text; protection is signalled by the reply
      staying plus ONE polite announcement per generation); under reduced motion the jump is instant
      and no state depends on motion.
  - **Edge:** very long reply; a side-anchored reply; while still streaming; companion away/off (no
    reply ⇒ no trap); reduced-motion `matchMedia` flip is a NAMED BLOCKER if the driver cannot drive
    it (G-148) → static CSS + a product-unit pin, never a PASS on the live leg alone.
  - **Receipt:** `activeElement` + `scrollTop` per step; the (t, present) samples for the focus leg;
    the accessible names/roles read per state.

## F-88 (REQ-18 / NFR perf) — Growing/scrolling/reading must not stall the stream or the bar

- [ ] F-88: Record the `llm-token` arrival timeline / the rendered partial contents (≥3 distinct)
      while the reader SCROLLS a long reply during ≥ half of the stream; time a bar interaction (a
      keystroke/click) during the scroll; read the console.
  **Expected:** the stream keeps advancing at ~the unscrolled cadence — text length increases
      monotonically and ≥3 distinct partials appear ACROSS the scroll window; the bar responds within
      a bounded window (record the ms); no dropped-frame stall; no
      `Maximum update depth exceeded` / re-render loop.
  - **Edge:** repeated scroll churn; a very long reply at the shipped minimum 900×600; scroll +
    resize; scroll while the reply is still arriving; a theme switch mid-scroll.
  - **Receipt:** the (t, textLength, partialCount) table across the scroll window + the bar
    interaction latency + the console read.

## F-89 (REQ-12 / AC5 second half) — A SHORT reply renders exactly as today (restraint)

- [ ] F-89: On the AFTER tip and the BEFORE tip (pre-fix, distinct `before-*`/`after-*` dirs per
      G-135): send `Reply with exactly: Hi there!`; measure
      `[data-testid="fredo-reply-surface"]`'s rect + `data-reply-tier`, the presence of any scrollbar
      (`scrollHeight` vs `clientHeight`), and the seat/launcher geometry.
  **Expected:** the short reply renders as today — `data-reply-tier="base"` at exactly **240×120**
      (the R-1 pin's dimensions) within **±2 px** of the BEFORE values; NO scrollbar appears; no
      needless resize. The surface grows ONLY when the content needs it. A regression here is a FAIL
      (explicitly required).
  - **Edge:** a one-line reply with the pointer over it (still protected, F-83); a short reply after
    a long one (the surface shrinks back — no residual size); companion away/off.
  - **Receipt:** the BEFORE/AFTER rects + the scrollHeight/clientHeight pair + both frame names.

## F-90 (REQ-21) — Mandatory live telemetry + rendered-webview receipt

- [ ] F-90: Same run as F-79..F-89: send at least one REAL managed-`llama-server` reply AND
      `fredo emit --event-type chat --session-id e2e-2883-chat`; query `telemetry_spans` +
      `chat_rows` (telemetry-query skill); retain every per-REQ `upload-evidence --base spec/2883`
      raw URL + the DOM/geometry samples.
  **Expected:** a live-query receipt exists — non-zero `telemetry_spans` with a recent
      `max(ingested_at)` and the chat row classified under its session id — AND every verdict row
      carries a rendered-webview receipt (G-108 accepts DOM/screenshot/`getBoundingClientRect` for
      this pure-rendering feature). **A static-only PASS with no live receipt is a FALSE PASS.**
      Never fabricate a telemetry query.
  - **Edge:** re-run on the tested tip; keep the emit + query output verbatim; the stream's real
    arrival is the `llm-token` timeline.
  - **Receipt:** the query outputs verbatim + the raw evidence URLs.

### #2883 testing round 1 — result (tip `326822ff`)

- [x] Verdict **FAIL** on the launcher-side D-1 (bar field never shrank). The reply rows all
      passed live: F-79 (growth), F-80 (inside window), F-81 (collision), F-82 (scroll reach),
      F-83/F-84 (pointer), F-85 (reading position), F-86 (`Newest`), F-87a/b (name/focus/keyboard
      protection), F-88, F-89, F-90. The `SpeechBubble.twoTier` height-freeze flake was seen once.

### #2883 testing round 2 — result (tip `9108bfe4`) — ordering fix + regression sweep

- [x] **F-79** PASS — real managed-`llama-server` stream: `base 238×119 @14` → `grown 560×120 @140`
      → `560×133` → `560×152` → `560×209` → `560×230 @728` … ≥14 distinct increasing samples while
      still arriving; `data-reply-kind="reply"`; width `min(560, available)`, height clamped.
- [x] **F-80** PASS — 900×600: 22 samples, 0 outside the window; grown `{170,166,730,294}`.
- [x] **F-81** PASS — one frame with both surfaces: reply `{420,166,980,396}` vs bar
      `{252,446,1148,580}`, field, hint and collapse → intersections all 0.
- [x] **F-82** PASS — scroller `overflow-y auto`, `scrollHeight 579 > clientHeight 200`,
      `scrollTop` reaches `379 == scrollHeight − clientHeight`; tail is the completion text.
- [x] **F-83** PASS — pointer enters at t=828 ms on a reply whose countdown had started;
      **84/84 present over 16.2 s** (>2× the ~5 s period), never dismissed.
- [x] **F-84** PASS — leave → present immediately, last present +2498 ms, absent +2700 ms
      ⇒ clear ≈ **2.5 s** = 2000 ms grace + ~0.5 s exit.
- [x] **F-85** PASS — stepped (user-like) scroll-back; **`scrollTop` held at 0** across arrivals
      `textLen 1522 → 2205` while `scrollHeight` grew `541 → 769`; `Newest` present throughout.
      (Round 2 fix: the follow flip is delivered synchronously/change-only, so a measure can never
      run with a stale follow state; two new honesty pins cover it.)
- [x] **F-86** PASS — `Newest` labelled button; click → `scrollTop 0→226→360→379` (bottom) and the
      button unmounts.
- [x] **F-87a** PASS (name/focus/trap) — `role="region"`, `aria-label="Fredo's reply"`,
      `tabindex="0"`, wrapper `aria-hidden` dropped; keyboard scroll-to-end UNVERIFIED (G-161).
- [x] **F-87b** PASS — scroller focused: **57/57 present over 11.25 s**; blur → present at +54…+856,
      last present +2456 ms, absent +2656 ms ⇒ ≈2.5 s grace.
- [x] **F-87c** PASS (labels/roles) — labelled `Newest`, `aria-busy`, one polite announcement;
      reduced-motion flip UNVERIFIED (G-148) with static/unit pins.
- [x] **F-88** PASS — length advanced monotonically during the scrolled-back window; console clean.
- [x] **F-89** PASS — `Reply with exactly: Hi there!` → `data-reply-tier="base"`, rect **240×120**,
      no scroller/`Newest`.
- [x] **F-90** PASS — `telemetry_spans` 1891 rows, `max(ingested_at)=2026-09-17T08:53:14.601Z`;
      `chat_rows` 1 for `e2e-2883-chat`.
- [x] Unit flake gone — two consecutive full runs: 1284/1284 both; `SpeechBubble.twoTier` 13/13,
      `ReplyScrollArea` 19/19.
