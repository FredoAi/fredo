# desktop-chrome — Functional

Durable per-feature suite for the desktop-chrome / window-chrome z-order surface
(FREDO logo band, clock + ONLINE readout, bottom LED pair from #2821, and the
webview window min/max/close controls). Seeded from issue #2825.

> Stacking model under test (file:line): LauncherChrome desktop chrome `zIndex:1200`,
> `position:fixed; inset:0; pointer-events:none` (LauncherChrome.tsx:220); StreamStatus
> bottom LED pair `zIndex:1210; pointer-events:none` (StreamStatus.tsx:134-138); window
> controls are webview-rendered Chakra `IconButton`s (WindowChrome.tsx:103-126) in the
> window stack (z=1). Both desktop-chrome layers are `pointer-events:none` passive
> indicators → guardrail **G-106** applies: use the pointer-events-toggle probe (method a),
> pixel/colour sample (method b), or computed-z-index comparison (method c), NOT a bare
> `elementFromPoint`.

- [x] F-1 (AC1): FREDO logo band does NOT render on top of feature windows. Open ≥1 feature window; screenshot the window's top-center region and pixel/colour sample it — the window header shows its own `--header-bg`/content, NOT the FREDO notch silhouette. Compare to `C:\Code\fredo\.opencode\wireframes\bugs\fredo-logo-ontop.png` (fixed = no band over window). Also computed stacking: the window frame's stacking position is ABOVE `LauncherChrome`. Edge: multiple windows, maximized, small window under the notch, light + dark themes. **PASS (spec/2825 @ 531c37e):** maximized Mission Monitor — `getComputedStyle` chrome root z=0, window frame z=1, notch (aria-label="Fredo launcher") `elementFromPoint(960,29)` returns a window content `<p>` (not notch, `notchIsTopmost:false`). Evidence: `https://github.com/FredoAi/fredo/raw/spec/2825/.opencode/evidence/2825/04-max-window-f1-topcenter.jpeg`. Light theme re-verified (chrome z=0, frame z=1, bodyBg #ffffff).
- [x] F-2 (AC2): clock + LED indicators never overlay window min/max/close. Position a feature window so its titlebar top-right control cluster sits under the clock/ONLINE readout; screenshot compare to `C:\Code\fredo\.opencode\wireframes\bugs\windows-buttons-time-overlap.png` (fixed = controls unoccluded). G-106 method a: set the `LauncherChrome` readout `style.pointerEvents='auto'`, `elementFromPoint` at each control center returns the WINDOW CONTROL (`[aria-label="Close …"]` / `[aria-label="Minimize …"]` / `[aria-label="Maximize …"]` / `[aria-label="Restore …"]`), NOT the readout; restore `pointerEvents`. Edge: maximized, window dragged under the clock, #2821 bottom pair (bottom-center, not top-right), multiple windows, light + dark themes. **PASS (spec/2825 @ 531c37e):** maximized Mission Monitor; with chrome overlay forced `pointerEvents='auto'`, `elementFromPoint` at Min/Restore/Close centers returns the window control (isControl:true) each time, never the clock/LED readout. Evidence: `https://github.com/FredoAi/fredo/raw/spec/2825/.opencode/evidence/2825/11-ac2-max-controls-unoccluded.jpeg`.
- [x] F-3 (AC3): window chrome always above desktop chrome. G-106 method c: within the same nearest stacking-context ancestor, `getComputedStyle(windowFrame).zIndex` > `getComputedStyle(launcherChrome).zIndex` (1200) AND > `getComputedStyle(streamStatus).zIndex` (1210); no desktop-chrome layer paints over the titlebar buttons. Plus screenshot of the unoccluded titlebar. Edge: multiple windows (focused vs background), maximized, window crossing under the notch + clock, light + dark themes, no feature window open (desktop only). **PASS (spec/2825 @ 531c37e):** computed stacking `getComputedStyle` — window frame z=1, LauncherChrome z=0, StreamStatus z=0 (window shown). Two-window (Sessions + Query Viewer) case re-probed: `elementFromPoint` at Query Viewer Min/Restore/Close with overlay pointerEvents auto returns the window control (isControl:true). Light theme re-verified. Evidence: `https://github.com/FredoAi/fredo/raw/spec/2825/.opencode/evidence/2825/09-two-windows.jpeg`.
- [x] F-4 (AC4): no #2821 dual-bottom-LED regression. Two 8px status dots at bottom-center (~24px above bottom edge, ~16px apart), `pointer-events:none`, `role="status"` + `aria-live="polite"`; LED-1 connection color (`--accent-primary` / `--status-error`), LED-2 activity color (`--status-info` / `--card-hover-bg`). DOM assert both dots at bottom-center (NOT top-right); screenshot compare. Inject a live row mutation (`fredo emit`) to drive LED-2 active — the activity dot pulses (suppressed under `prefers-reduced-motion`). Edge: connected vs disconnected, streaming vs idle, reduced-motion on, multiple windows, maximized, light + dark themes. **PASS (spec/2825 @ 531c37e):** wrapper center x=960 = viewport center, bottomOffset=24px, `pointer-events:none`, `role="status"`, `aria-live="polite"`; LED-1 "Online" x=944, LED-2 "Streaming" x=967 (mid-pulse ~9px), ~16px gap, both bottom-center NOT top-right (`ledAtTopRight:false`). `fredo emit --event-type tool_use --state init` advanced the row-mutation epoch → LED-2 became "Streaming" (active) with reduced-motion false. Evidence: `https://github.com/FredoAi/fredo/raw/spec/2825/.opencode/evidence/2825/06-led-pulse-active.jpeg`.
- [x] F-5 (AC5): window controls remain clickable — no invisible desktop-chrome layer intercepts the pointer. G-106 method a: (a) set the desktop-chrome overlay `pointerEvents='auto'` → `elementFromPoint` at a control center returns the OVERLAY (confirm the overlay is the top visual layer there in the build); restore `pointerEvents`. (b) Then a REAL click (`webview_interact` on `[aria-label="Close …"]` / `[aria-label="Minimize …"]` / `[aria-label="Maximize …"]`) dispatches to its handler (window closes / minimizes / maximizes-restores). Edge: pointer near the titlebar corners (resize-grip corners not covered), maximized, multiple windows focused/unfocused, window partially under the notch, light + dark themes. **PASS (spec/2825 @ 531c37e):** real `webview_interact` clicks — Minimize dispatched (desktop chrome restored to 1200/1210, window minimized to dock), Restore/Maximize dispatched (float→maximized), Close dispatched (window closed; all window controls gone; desktop chrome restored to 1200/1210). No overlay swallowed any click. Evidence: `https://github.com/FredoAi/fredo/raw/spec/2825/.opencode/evidence/2825/07-window-closed-desktop.jpeg`.

---

## #2830 extension — consolidate to a SINGLE top-right status LED

> Issue #2830 — consolidate ALL connection-status signaling to ONE top-right status LED:
> drop the bottom-center LED pair (`StreamStatus.tsx` is REMOVED — the #2821 dual-bottom-LED
> AC is SUPERSEDED), drop the `Online` text label on the top-right cluster (`LauncherChrome.tsx`
> `onlineLabel`, line 371), render the remaining LED LARGER (UI/UX §1: 12px dot in a 16px hit
> target, 2x the old 6px dot), and add a Chakra v3 `Tooltip` (`placement="bottom"`, `hasArrow`)
> on hover (AC5). Map 1:1 to `.opencode/tmp/2830/triage.md` `## QA Expert` (REQ-1..REQ-5,
> AC1..AC8).
>
> **Verification policy: live** — PURE-RENDERING, NO telemetry surface, NO `telemetry_spans`
> leg (references.md G-099: a rendered static policy passes with rendered-webview receipts).
> Evidence: `tauri_webview_dom_snapshot` + `tauri_webview_screenshot` +
> `upload-evidence --base spec/2830 --body-file <draft> --image <png>` raw URL +
> `getBoundingClientRect`/computed-style for the size/position/token checks.
>
> **Reference assets (Read by EXPLICIT absolute path, NEVER glob — `.opencode` is
> dot-prefixed, G-105):** `desktop-light.png`, `desktop-light-dark-theme-compare.png`,
> `bugs/led-overlay.png`. The wireframes are the **PRE-fix** baseline (they still show the
> `ONLINE •` text + small dot); the removed `ONLINE` label + enlarged LED are the REQUIRED AC,
> NOT a fidelity deviation — do NOT fail a side-by-side for them.
>
> **Serving checkout:** `spec/2830` (the spec integration branch) on a running Fredo desktop
> app with the MCP driver session connected (`com.fredo.app`, port 9223).

## F-6 (AC1) — Exactly ONE status LED, top-right only, and it sinks below windows

- [x] F-6: With NO feature window open, `tauri_webview_dom_snapshot(type="structure")` the desktop and count the status-LED **trigger** (the focusable 16px hit target — the visual 12px dot is `aria-hidden`). **Expected:** EXACTLY ONE status-LED trigger in the top-right region inside the `<time aria-label*="online\|offline">` clock cluster; its `getBoundingClientRect` places it top-right (right edge near viewport right, top near viewport top, BELOW the clock HH:MM text — `mt="6px"`); ZERO status LEDs at bottom-center, center, or elsewhere.
  - **Edge:** (a) desktop-only — LED at full band z (1200); (b) a non-minimized feature window open — the whole band (clock + LED + frame + side ticks) sinks to z=0 below the z=1 window stack (`coveredByWindow`, #2825 R-2 lockstep), so the LED never paints over the titlebar min/max/close (`bugs/led-overlay.png` must NOT reproduce); (c) narrow viewport — LED not clipped/off-screen; (d) light + dark theme. **PASS (spec/2830 round 1, live):** `ledCount=1`; trigger 16×16 at `{top:38, right:1916, left:1900}` (below the `02:49` clock, 20px from viewport right); `statusRoles=["Online"]`; `bottomCenterRadiusDots=0`. Edge (b): chrome band z 1200→0 with a maximized window, `elementFromPoint` at "Close Sessions" = window control (`led-overlay.png` NOT reproduced). Edge (d): light+dark verified. Offline sub-case = PO-scope documented-partial (no `isConnected=false` toggle). Evidence: `https://github.com/FredoAi/fredo/raw/spec/2830/.opencode/evidence/2830/ac1-desktop-led.png`, `https://github.com/FredoAi/fredo/raw/spec/2830/.opencode/evidence/2830/ac1-window-open-led-sink.png`.

## F-7 (AC2) — All bottom-center status LEDs removed

- [x] F-7: DOM-snapshot + source grep. **Expected:** ZERO status-LED elements at the bottom-center — the old `StreamStatus` wrapper (`role="status"` `aria-label="Desktop status"`, StreamStatus.tsx:134-138, `position="fixed" left="50%" bottom="24px"`) is GONE; there is NO `<StreamStatus />` mounted (`Home.tsx` no longer renders it, line 193); zero 8px `border-radius:50%` dots at `bottom:24px; left:50%`. Grep `apps/ui/src/features/home/components/` for `StreamStatus` — zero references (the component is deleted / no longer imported).
  - **Edge:** (a) desktop-only — no bottom LEDs; (b) with a feature window open then closed — no bottom LED resurfaces on window-close; (c) after a `fredo emit` row-mutation burst (the old activity signal) — NO activity dot appears anywhere and the single top-right LED does NOT pulse (the streaming/activity LED is intentionally REMOVED by design — consolidation = one status source). **PASS (spec/2830 round 1):** `StreamStatus.tsx` deleted; grep → 5 comment-only hits; `statusRoles=["Online"]`; `bottomCenterRadiusDots=0`; `ledCount=1` after window open/close; LED driven only by `isOnline` (no pulse).

## F-8 (AC3) — Top-right `Online` text label removed (only the LED remains)

- [x] F-8: DOM-snapshot the top-right `<time>` cluster + screenshot. **Expected:** NO visible `ONLINE`/`OFFLINE` text node (the `onlineLabel` Text element, LauncherChrome.tsx:371, is removed) — only the HH:MM clock text + the single status LED render. The `<time>` `aria-label` MAY still expose the readable state (`…, online\|offline`) — that is the ACCESSIBLE NAME, NOT a visible label, and is REQUIRED for a11y (do NOT fail it). The HH:MM clock time is retained (only the label row is dropped).
  - **Edge:** (a) online AND offline — no visible label in either; (b) the clock time still advances (only the `Online` label removed — do NOT break the clock); (c) the LED's own accessible name (`aria-label` `Connected`/`Disconnected`) carries the state once the text is gone. **PASS (spec/2830 round 1):** `<time aria-label="02:49, online">` (accessible name, retained) + clock text `02:49` (advances to `02:55`); NO `ONLINE`/`OFFLINE` text node; LED `aria-label="Online"`. Offline label-absence sub-case = PO-scope documented-partial (label fully removed from markup — state-independent).

## F-9 (AC4) — The remaining LED is visibly LARGER (12px dot in a 16px hit target)

- [x] F-9: `getBoundingClientRect` on the LED **visual dot** (the `aria-hidden` 12px circle) AND its 16px trigger hit target. **Expected:** visual dot is a circle — `width == height`, `borderRadius:50%`, aspect 1:1 — and measures **12px × 12px** (UI/UX §1, 2x the pre-fix 6px dot at LauncherChrome.tsx:375-376), strictly `> 6px` in both dims; the focusable trigger is **16px × 16px** (12px dot centered, fully contained, not overflowing). Record exact px; compare against the pre-fix 6px baseline (or a `main`-build capture — a stale capture is OK only as the baseline, the fix measurement must be from `spec/2830`).
  - **Edge:** (a) online vs offline — same size; (b) light + dark — same size, no clipping; (c) narrow viewport — dot not scaled/clipped, trigger stays 16px; (d) `width != height` (stretched oval) ⇒ FAIL; (e) 12px dot fully inside the 16px trigger. **PASS (spec/2830 round 1, live):** dot `{w:12, h:12}` (width==height → circle), `borderRadius=50%`, `aria-hidden=true`; trigger `{w:16, h:16}` (flex center → dot fully contained, no overflow); dot strictly `>6px` (12px = 2× pre-fix 6px); `mt=6px` (below clock). Size is state-independent (fixed 12/16px).

## F-10 (AC5) — Hover shows a Chakra tooltip; it never clips/overlays

- [x] F-10: `tauri_webview_interact(action="hover")` on the LED trigger (16px hit target), then `tauri_webview_dom_snapshot` to locate the Chakra tooltip node (`[role="tooltip"]` / `.chakra-tooltip` / tooltip root) + `tauri_webview_screenshot`. **Expected:** a Chakra v3 `Tooltip` appears on hover, `placement="bottom"` (OPENS BELOW the LED — a top-opening tooltip that clips off the top viewport edge is a FAIL; UI/UX contract = `bottom` + `hasArrow`), with state-driven content (`Connected` / `Agent telemetry streaming` when online; `Disconnected` / `Waiting for stream to reconnect` when offline); readable (adequate contrast). Pointer-leave hides it (`closeDelay={0}`, no sticky tooltip).
  - **Edge:** (a) hover-on reveals / hover-off hides; (b) online vs offline content reflects the live state; (c) light + dark — tooltip readable & legible in BOTH; (d) top-right placement — tooltip does NOT clip at the viewport right/top edge and opens below the LED (never above); (e) keyboard — Tab focuses the trigger → tooltip opens on focus, blur closes it; (f) `prefers-reduced-motion` — no distracting animation. **PASS (spec/2830 round 1, online):** tooltip `text="ConnectedAgent telemetry streaming"`, `tooltipRect={top:66, bottom:118}` vs `ledRect={top:38,bottom:54}` → opens BELOW (`tooltipBelowLed=true`); `hasArrow=true` (`chakra-tooltip__arrow`); `noClip=true` (fully inside 1936×1056, no top/right clip); token colours (`card-bg`/`text-primary`/`border-color`). Close: focus opens, blur closes, Escape closes (no sticky). Offline-content + literal pointer-leave + light re-open = PO-scope documented-partial / tooling notes (see verdict).

## F-11 (AC6) — Token-native colors; readable in light + dark

- [x] F-11: Computed-style on the LED (`backgroundColor`) + the tooltip panel: assert the resolved value derives from a `var(--…)` / `color-mix` / `tint()` token (NOT a literal hex/`rgb(a)`). Online LED resolves to `var(--accent-primary)` + a halo via `tint('var(--accent-primary)', 22)`; offline resolves to `var(--status-error)` (the removed StreamStatus `CONNECTION_COLOR` disconnect token — a deliberate change from the old `var(--text-secondary)` dot). Static grep of the changed files (`apps/ui/src/features/home/components/launcher/LauncherChrome.tsx`, the removed `StreamStatus.tsx`, any new tooltip/LED component under `home/components/**`) for `#[0-9a-fA-F]{3,8}`, `rgba(`, `rgb(`, and invalid `var(--x)NN` alpha-append (#2770) → ZERO true color literals (comment issue-refs like `#2821` are exempt). Then re-theme via the shipped `ThemePresetSelector` — both light + dark legs render the LED + tooltip legibly.
  - **Edge:** (a) re-theme (a LIGHT preset e.g. `light-default` ↔ the DARK base e.g. `default`/`dark`) — LED + tooltip re-tint token-native with no stale/dead color; (b) NO `var(--x)NN` alpha-append anywhere; (c) Chakra v3 API only (no v2 `isDisabled`/`colorScheme`). **PASS (spec/2830 round 1):** online LED `rgb(0,209,209)` (accent token) + halo `color(srgb 0 0.819608 0.819608 / 0.22) 0 0 0 4px` (≡ `tint('var(--accent-primary)',22)` color-mix) in BOTH dark and light; re-themed live via `select[aria-label="Theme presets"]` light-default (`#ffffff`/`#f7f8fa`/`#0c1117`/`#00d1d1`/`#ef4444`) — LED re-tinted, no dead colour; static grep zero true literals; `tint()` confirmed returns `color-mix(...)`; Chakra v3 only. Offline LED colour `var(--status-error)` token-confirmed (`#ef4444`) but not rendered (no toggle) → PO-scope documented-partial; light-tooltip re-open = tooling note.

## F-12 (AC7) — No regression to window lifecycle / Ctrl+Space / #2821 fidelity

- [x] F-12: Run the `desktop-chrome` + `launcher` regression cases (`regression.md` #2830 R-7+). **Expected:** window lifecycle (open/close/minimize/restore via the own-kernel, #2807), the #2823 Ctrl+Space launcher toggle (opens + focuses the searchbox, ESC closes, focus restores), and the #2821 desktop-fidelity fixes (clean top-right clock; no clock/LED overlap of window controls) all still hold. The ONLY intended behavioural change is the status-LED consolidation. `tauri_read_logs(source="console")` — no `Error:`/`Uncaught`/`Maximum update depth exceeded`.
  - **Edge:** (a) Ctrl+Space over a maximized window still re-raises the launcher; (b) window min/max/close still clickable (no overlay swallows the pointer — the LED re-enables `pointerEvents="auto"` on its OWN element only, the band stays `pointerEvents="none"`); (c) the clock still advances; (d) `desktop-light.png` fidelity re-check EXCEPT the deliberately removed `ONLINE` label + enlarged LED. **PASS (spec/2830 round 1):** window lifecycle open→close→minimize→restore intact (chrome z 1200↔0); launcher ESC-close + searchbox focus intact; #2821 fidelity (clock clean, no clock/LED overlap — `elementFromPoint` at "Close Sessions" = window control); console clean of `Uncaught`/`Maximum update depth exceeded`. #2823 Ctrl+Space synthetic keypress note: searchbox focus not landed by the synthetic `press " " +Control` (documented OS/WebView2 IME gate, launcher F-19 edge); #2830 did not touch the Ctrl+Space handler (git diff clean) — not a #2830 regression.

## F-13 (AC8) — build + test:run green

- [x] F-13: `pnpm --filter @fredo/ui build` (TypeScript) + the Rust backend check / `test:run` from the repo root. **Expected:** zero TypeScript errors in the changed frontend; `build` exits 0; `test:run` green. No cross-feature import introduced (the LED/tooltip stay under `home/components/`).
  - **Edge:** no transpile-only `any` leakage; the change touches no IPC/API (no backend surface). **PASS (spec/2830 round 1):** `pnpm --filter @fredo/ui build` → `tsc && vite build` **exit 0** ("✓ built in 8.59s", 2559 modules); `pnpm --filter @fredo/ui test:run` → **48 files / 709 tests passed**. Matches the developer's CI-parity receipt. No backend/IPC change (git diff shows only frontend LED files + deleted StreamStatus + AppDrawer comment).

---

## #2838 extension — left-edge auto-hide dock does not disturb the desktop chrome

> Issue #2838 — left-edge auto-hide app dock REPLACES the #2821 bottom-docked tray. The dock
> is a left-edge rail (`DOCK_Z_INDEX = 1200`, Architect binding — above window stack z=1 and
> resting launcher z=1100, below the Ctrl+Space overlay z=1300, co-equal with the
> `pointer-events:none` chrome band) revealed ONLY while >=1 window is open; at rest it is
> off-canvas + `pointer-events:none` + `visibility:hidden`. Run the #2830 F-6..F-13 +
> regression R-7..R-14 legs alongside (single top-right LED, band passive, band z sink/cover).
> Map 1:1 to `.opencode/tmp/2838/triage.md` `## QA Expert` (QA-Plan row R-14; EARS D-10 / AC6).

- [x] F-14 (R-14 / D-10 / AC6): With the dock at rest AND revealed (>=1 window open incl minimized), verify the desktop chrome is unaffected and never occluded. EXPECTED: EXACTLY ONE top-right status LED + advancing clock as in F-6..F-10; the dock at rest occludes nothing and intercepts no pointer (G-106 method a probe: force `pointerEvents='auto'` on the dock rail only while revealed, `elementFromPoint` at the rail vs left-edge content — at rest no rail layer is hit); the revealed left-edge rail does NOT overlap the top-right clock/LED cluster (computed `getBoundingClientRect` disjoint — rail ~88px top/bottom insets) nor the window min/max/close controls; the chrome band z model holds (band z 1200 uncovered / 0 covered); the dock never paints above the band or the Ctrl+Space overlay (z=1300); window controls remain clickable. Edge: maximized window full-bleed with the dock revealed; all-minimized (band back at 1200 while the dock may reveal — rail geometry never reaches the top-right cluster); light + dark; narrow viewport; console clean of `Error:`/`Uncaught`/`Maximum update depth exceeded`.
  - **PASS (spec/2838 @ 6ccf4820, round 1).** (a) At rest (dock hidden, `visibility:hidden`/`pointer-events:none`/x=-60): `elementFromPoint(6/10/30, 500)` hits the maximized WINDOW surface, never a rail layer (F-31 window-manager evidence); (b) revealed dock rail rect `{x:0,y:482,w:52,h:54}` is DISJOINT from the top-right clock `{x:1863,y:16,w:37}` and the single status LED trigger `{x:1884,y:38,w:16}` (`disjointFromClock:true`, `disjointFromLed:true`) — the ~88px top inset keeps the rail clear of the top-right cluster; (c) EXACTLY ONE top-right status LED (`ledTriggers:1`, `statusRoles:["Online"]`), clock advancing (03:51→04:41), zero bottom-center dots; (d) band z model intact (launcher/surface z 1100 rest → 0 with a visible window → 1300 under Ctrl+Space, dock z=1200 between); (e) window min/max/close controls hit-test SELF at center (clickable, un-occluded) while a window is open and the dock hidden (screenshot `f33-window-controls-unoccluded.jpeg`); (f) dock revealed while launcher overlay open: `launcherZ:1300 > dockZ:1200` — dock never paints above the Ctrl+Space overlay; console clean of dock-caused errors (attribution in window-manager F-34).

---

## #2841 extension — desktop chrome polish: resting-visible rail, centered clock/LED, always-visible settings

> Issue #2841 — desktop chrome polish. The #2838 dock (off-canvas auto-hide, edge-peek reveal)
> is REDESIGNED to be **resting-visible on a clean desktop** (`coveredByWindow === false`),
> reverting to the peek-only model when a maximized window covers the desktop
> (`coveredByWindow === true`). The top-right clock/LED cluster is **visually centered**
> within the corner. The floating settings button is hoisted to the **chrome tier**
> (`zIndex: coveredByWindow ? 0 : 1200`) so it is always-visible on the clean desktop.
> **Verification policy: live** — pure-rendering chrome, NO telemetry surface, NO
> `telemetry_spans` row leg (the required live-gate reference is the established
> desktop-shell F-14 pattern: `SELECT COUNT(*) FROM telemetry_spans` non-zero + recent
> `max(timestamp)`). Evidence: `tauri_webview_dom_snapshot` + `tauri_webview_screenshot` +
> `upload-evidence --base spec/2841` raw URL + `getBoundingClientRect`/computed-style +
> `elementFromPoint` + real `webview_interact` click. Reference assets read by EXPLICIT
> absolute path (never glob — `.opencode` is dot-prefixed): PREREQUISITE the #2838/#2830
> legs F-6..F-14 + regression R-7..R-15 hold unchanged. Serving checkout `spec/2841`,
> MCP driver `com.fredo.app` port 9223. Map 1:1 to `.opencode/tmp/2841/triage.md` `## QA Expert` (R-1..R-7).

## F-15 (AC1) — Rail resting-visible on a clean desktop

- [ ] F-15: With all feature windows minimized (NO maximized / no showing feature window → `coveredByWindow === false`, launcher surface rests at z1100), `tauri_webview_dom_snapshot(type="structure")` + `getBoundingClientRect` the app-dock rail (`[data-testid="app-dock"]` / `role="region" aria-label="Open applications"`) WITHOUT moving the pointer to the left edge. **Expected:** the rail is VISIBLE at rest — root `getBoundingClientRect` in-viewport (left edge ~0, NOT `translate(-100%,-50%)` off-canvas), computed `visibility:visible`, `transform` at the resting translation (not `-100%`), `pointer-events:auto`, and the entry list renders the open apps. The prior off-canvas rest state (`visibility:hidden`, `pointer-events:none`, `translate(calc(-100% - 8px),-50%)`) must NOT be the resting state on a clean desktop.
  - **Edge:** (a) **0 windows** — rail ABSENT (`AppDock` returns `null`, no listener, empty gate); (b) **exactly 1 minimized** — rail visible + 1 entry; (c) **2–5 minimized** — rail visible, all entries in store order; (d) **mixed** (≥1 showing → desktop NOT clean) — rail is under the window / edge-peek coexistence, resting-visible NOT required; (e) **all closed** — returns to 0-window absent; (f) **light + dark** preset; (g) **narrow viewport** — rail not clipped.
  - **Component-test leg (AC1 guard):** extend `dock/__tests__/AppDock.test.tsx` with a resting-visible assertion — rail renders `visibility:visible` + resting transform with NO `pointermove` dispatch, and is ABSENT when `useWindows()` returns `[]`.

## F-16 (AC2) — Rail stays the live open-apps surface (restore/focus/close preserved)

- [ ] F-16: With the rail resting-visible, click a non-top entry → `focusWindow(id)` (restore-from-minimize); click the top focused non-minimized entry → NO-OP; activate the close affordance → `closeWindow(id)` for ONLY that app; verify the entry set == window-store set after each settle; close the last app → rail unmounts (`dockPresent:false`). **Expected:** #2838 behavior preserved (R-2) — entry restores/focuses; close only removes the targeted app and its icon; the rail is the single open-apps surface; closing the last leaves a clean desktop with no ghost.
  - **Edge:** focused vs background vs minimized entry; close of focused/backgrounded/minimized; close-of-minimized racing restore; rapid open/close/minimize/restore/focus interleaves; same-feature double-open (single instance per id); settle at 0 windows. **≥6 windows** — see the F-28 blockable-edge note below (component-test leg with a mocked entry list; `revealDock()` helper needs review if the rail no longer requires the edge gesture).

## F-17 (AC3) — Clock/LED cluster visually centered within the corner

- [ ] F-17: `getBoundingClientRect` on the top-right cluster (HH:MM clock + single consolidated status LED) on a clean desktop. **Expected:** the cluster is VISUALLY CENTERED within the corner — a measurable `topMargin` and `rightMargin` exists (it neither hugs `top:0` nor `right:0`). Per Design §3 the cluster box is `top:20px; right:24px; align-items:center; gap:6px` — assert `|topMargin - rightMargin| ≤ 6px` (the `top:20/right:24` 4px asymmetry is the design intent; a >6px deviation or an edge-hugging `top:0/right:0` is a FAIL) and the LED centers UNDER the clock (stacked, not right-aligned). Clock still advances on the 60s timer; exactly ONE status LED.
  - **Edge:** (a) centering geometry identical in light + dark; (b) clock fully rendered (no clip); (c) exactly ONE LED trigger (no bottom LEDs / no second status surface); (d) the #2838 dock rail stays DISJOINT from the top-right cluster.
  - **Component-test leg (AC3 guard):** assert the cluster's `getBoundingClientRect` carries a measurable `topMargin`/`rightMargin` with `|topMargin - rightMargin| ≤ 6px` and does not hug `top:0`/`right:0`.

## F-18 (AC3/#2825) — Cluster + rail never paint over a maximized window's titlebar controls

- [ ] F-18: With a maximized feature window, `elementFromPoint` at each titlebar min/max/close control center → returns the WINDOW CONTROL (isControl:true), NEVER the clock/LED cluster or the rail. `bugs/windows-buttons-time-overlap.png` + `bugs/led-overlay.png` must NOT reproduce (the whole band sinks to z0 under the window stack; the rail reverts to peek-only when covered). **Expected:** the `coveredByWindow === true` state reverts the rail to the exact #2838 peek model (full-bleed window preserved), and the cluster never paints over the controls.
  - **Edge:** maximized full-bleed; window dragged under the cluster; the rail revealed vs hidden (peek) while covered; light + dark; narrow viewport.

## F-19 (AC4) — Settings button always-visible on the clean desktop; opens the modal

- [ ] F-19: On a clean desktop, `elementFromPoint` at the settings button center (`IconButton` `aria-label="Settings"`) → returns the BUTTON (it paints ABOVE the launcher surface z1100 / chrome band z1200 — the prior `zIndex:10`-under-launcher bug must be fixed); then a real `webview_interact` click → the `ProfileSettingsModal` opens with sections visible. **Expected:** reach Settings in one click with no window open; opening Settings launches the settings modal; the button does NOT occlude the window min/max/close controls when a window is open (it sinks to z0 with the band). Verify `coveredByWindow` is derived from `useWindows()` (not a threaded prop).
  - **Edge:** clean desktop (one-click); with a feature window open (button does not cover controls); maximized window; click opens the modal (not just hover); light + dark; narrow viewport; button re-tints token-native.

## F-20 (AC5) — Token-native colors; readable in light + dark; zero hardcoded literals

- [ ] F-20: (Live) Computed-style the rail surfaces (rail bg `--card-bg`, active-well `tint(accent)` color-mix, accent inset bar, close-destructive tint), the corner cluster (clock `--text-secondary`, LED online `var(--accent-primary)` + halo `tint()`, offline `var(--status-error)`), and the settings button in a light preset + the dark base. (Static) Grep `dock/AppDock.tsx`, `dock/DockEntry.tsx`, `launcher/LauncherChrome.tsx`, `settings/FloatingSettingsButton.tsx`, `Home.tsx` for color literals. **Expected:** every surface resolves from token → CSS var → `tint()`/`color-mix`; ZERO `#[0-9a-fA-F]{3,8}` color literals (issue-ref comments exempt), ZERO `rgba(`/`rgb(`/`hsla(`, ZERO `var(--x)NN` alpha-appends (#2770) — INCLUDING the `FloatingSettingsButton.tsx:31` `rgba(0,0,0,0.2)` box-shadow (this is the known in-scope literal to convert to `tint()`/token). Both presets render legible.
  - **Edge:** light↔dark re-theme re-tints with no stale/dead color; `var(--x)NN` absent; Chakra v3 API only; destructive affordance uses `tint('var(--status-error)',N)` NOT `variant="outline" colorPalette="red"` (#431).

## F-21 (NFR) — A11y keyboard-navigable rail + cluster; no re-render loop; no focus steal

- [ ] F-21: Accessibility snapshot of the resting-visible rail + corner cluster; keyboard-drive the rail (Tab / ArrowDown-Up / Home / End / Enter / Space / Escape); read `tauri_read_logs(source="console")` after every leg. **Expected:** rail `region "Open applications"` → `list` → `listitem` → icon button (accessible name = app title + state via `dockEntryLabel`), `aria-current="step"` on the focused window, close button `aria-label="Close <title>"` reachable via `:focus-within` (opacity-hidden, NOT `display:none`); keyboard roving + Enter/Space = focus+restore, Escape hides + restores focus; the rail does NOT auto-focus on minimize (no focus steal). Corner cluster: clock `<time aria-label="HH:MM, online|offline">`, LED `role="status"` `aria-live="polite"` `aria-label="Online|Offline"`, Chakra tooltip opens on focus + closes on blur (no sticky/double-announce). **Loop:** console clean — NO `Error:`/`Uncaught`/`Maximum update depth exceeded` (NFR-2 transition-only reveal pattern preserved; no effect depends on array `.length` or freshly-created object refs).
  - **Edge:** hidden (covered) rail absent from a11y tree + not tabbable; keyboard focus-in suspends auto-hide; `prefers-reduced-motion` — no transform/visibility animation; no re-render loop from the resting-visible bool-toggles; Escape restores focus to the correct origin.

## F-22 (AC build/CI) — Build + test green; no cross-feature import; kernel READ-ONLY

- [ ] F-22: `pnpm --filter @fredo/ui build` then `pnpm --filter @fredo/ui test:run`. **Expected:** `build` exit 0 (zero TS errors); `test:run` green; no cross-feature import (rail/clock/settings stay under `home/components/`); the window kernel stays READ-ONLY (no Rust diff — NFR-1); the existing `AppDock.test.tsx` still passes.
  - **Edge:** no transpile-only `any` leakage; the rail remains a pure consumer of `useWindows()`/`useWindowActions()` (never calls a lifecycle setter beyond `focusWindow`/`closeWindow`).

## F-23 (live gate) — `telemetry_spans` live-query reference for the live policy

- [ ] F-23: Reference `telemetry_spans` as the live span-store proof (desktop-shell F-14 pattern): `SELECT COUNT(*) FROM telemetry_spans` returns a non-zero count with a recent `max(timestamp)`. **NOTE:** the rail/clock/LED are NOT row-driven — no `fredo emit` injection is needed; `telemetry_spans` is the live-store reference, not a row-equality assertion.

## F-28 blockable-edge note (≥6 windows — component-test contingency)

> The shipped feature catalog CANNOT open ≥6 DISTINCT in-dock windows live (kernel
> single-instance-per-id cap + ~4 showable grid). Per the #2838 F-28 precedent, any
> AC leg needing ≥6 windows (e.g. rail overflow-scroll / no-entry-lost with the new
> resting-visible design) is cleared by a **component test** driving the rail with a
> mocked 8-entry list (`dock/__tests__/AppDock.test.tsx` pattern) + the live 4-window
> reachability evidence. The existing test's `revealDock()` helper dispatches a
> `pointermove` to reveal the rail — review whether it needs updating for the new
> resting-visible rest state (if the rail no longer requires the edge gesture to be
> visible, the helper is a behavioral regression trap on AC1).
