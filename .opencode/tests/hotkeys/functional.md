# Hotkeys — Functional

> Live-plan suite for the keyboard-first hotkey contract (issue #2946): discoverable,
> configurable hotkeys with two tiers, multi-key sequences, macros, conflict handling and
> typing/terminal safety. Cases map 1:1 to the QA Plan in
> `.opencode/tmp/2946/triage.md` `## QA Expert` (QREQ-1..QREQ-27; AC1..AC5 + PO
> resolutions Q2/Q5/Q6/Q7). Binding icons match `QREQ-n`; the SI realigns to the
> Architect's `REQ-n` at convergence.
>
> **Verification policy: live.** Execute on a RUNNING Fredo desktop app on the `spec/2946`
> build (dev-env UP, MCP driver `com.fredo.app`). Every case's evidence MUST carry BOTH
> (a) the DOM/screenshot/measurement assertion and (b) a `telemetry_spans` live-run receipt
> for its drive window:
>
> ```
> powershell -File .opencode/skills/telemetry-query/telemetry-query.ps1 `
>   -Query "SELECT span_name, provider, transport, status_code, datetime(start_time_ns/1000000000,'unixepoch') AS started FROM telemetry_spans WHERE start_time_ns > (strftime('%s','<T0>')*1000000000) AND start_time_ns < (strftime('%s','<T1>')*1000000000) ORDER BY start_time_ns" `
>   -Format md
> ```
>
> Each drive includes one sanctioned span-producing lever (an active companion generation
> or a `fredo emit` event on the real channel). PO Q13 forbids shortcut-usage telemetry, so
> the receipt proves the app was LIVE — the hotkey assertion itself is DOM/screenshot-measured.
> A row missing the receipt, or a static-only PASS, FAILS CLOSED.
>
> Evidence tools: `tauri_webview_keyboard`, `tauri_webview_dom_snapshot(type="structure"|"
> accessibility")`, `tauri_webview_execute_js`, `tauri_webview_screenshot`,
> `tauri_read_logs(source="console")`, `upload-evidence`.

## F-1 (QREQ-1 / AC1) — Cross-feature focus traversal

- [ ] F-1: With ≥2 windows open (Launcher, Terminal, Mission Monitor, Diagram, Settings), drive ONLY by keyboard (Tab / arrows / the app's focus-next binding) across them. **Expected:** focus moves into each open feature/window in turn; every interactive control in the focused window is reachable by keyboard alone (no pointer event in the drive log); every focused element has a perceptible focus indicator (measured outline/box-shadow/ring, not colour-only). **Data:** `document.activeElement` + accessibility snapshot after each step; pointer-event counter. *(live receipt)*
  - **Edge:** maximized window; ≥2 stacked windows; launcher overlay open vs closed; `disabled` controls skipped; off-screen control scrolled into view before focus lands.

## F-2 (QREQ-2 / AC1) — No focus trap + predictable Escape return

- [ ] F-2: From inside a focused feature press Escape; then Shift+Tab from the first focusable. **Expected:** Escape returns focus to the DECLARED predictable target (per surface: window header / launcher searchbox / prior focus) and never strands focus in an unmounted or `aria-hidden` subtree; Shift+Tab from the first focusable reaches the window boundary/last focusable — focus never loops silently in one widget. **Data:** `document.activeElement`, window stack. *(live receipt)*
  - **Edge:** modal open (modal owns keyboard, closes first); Escape at top-level desktop (no-op); closing the focused window falls focus to a LIVE element (never ringless `body`); Tab/Shift+Tab wrapping.

## F-3 (QREQ-3 / AC1) — Mouse-free core flow (E2E success metric)

- [ ] F-3: Cold app → open launcher → open a feature window → operate one control → close → return, keyboard ONLY; read an injected capture-phase pointer counter after. **Expected:** ZERO `mousedown`/`click`/`pointerdown` dispatches; each step visible in DOM snapshot; console clean. *(live receipt)*
  - **Edge:** first attempt (no warm-up); repeat 2×; once through the launcher path and once via an app-global chord.

## F-4 (QREQ-4 / AC2) — One listing shows both tiers + precedence

- [ ] F-4: Open Settings → Hotkeys. **Expected:** ONE listing shows app-global bindings AND the focused feature's local bindings; each row labelled with its tier and, where local/global overlap, the precedence label; global rows visible regardless of focus. **Data:** both tiers declared. *(live receipt)*
  - **Edge:** no feature focused (only global rows); feature A focused → A's local rows present, B's absent; a global chord shadowed by a local one labelled with the resolved winner.

## F-5 (QREQ-5 / AC2) — Declarative auto-listing + zero-contribution

- [ ] F-5: Compare a feature that declares hotkeys against one that declares none. **Expected:** the declaring feature's bindings appear AUTOMATICALLY (no per-feature listing code); the feature declaring none contributes ZERO rows and no empty/placeholder artifact. *(live receipt)*
  - **Edge:** hotkey pointing at a non-existent action → validation state (never a silent dead row); two features declaring the same LOCAL chord (no cross-contamination).

## F-6 (QREQ-6 / AC2) — Feature-local tier scoped to focus (E2E)

- [ ] F-6: With ≥2 feature windows open, fire a local chord while window A is focused, then focus B (keyboard-only) and refire. **Expected:** the local chord fires ONLY while its own feature is focused; with B focused it does nothing (or B's binding); a global chord fires from any non-suppressed focus. *(live receipt)*
  - **Edge:** window open but not focused; launcher overlay focused; local chord equal to a global chord → focused local wins (PO#8).

## F-7 (QREQ-7 / AC3) — Leader sequence + pending hints

- [ ] F-7: Press the leader prefix, then a valid next key; screenshot + DOM the pending overlay mid-sequence. **Expected:** pending state with a which-key overlay naming the pending prefix + valid next keys; the valid next key executes the bound action EXACTLY once. *(live receipt)*
  - **Edge:** leader while a text field is focused → suppressed (no pending state); a prefix that is itself a complete binding; overlay not colour-only, legible in both themes.

## F-8 (QREQ-8 / AC3) — `g g` multi-key sequence (E2E)

- [ ] F-8: Press `g` then `g`; read the pending hint after the first `g`. **Expected:** the hint names `g` as a valid continuation; the second `g` executes the `g g` action exactly once. *(live receipt)*
  - **Edge:** `g` then a different valid key; `g` alone then wait past the timeout → reset; `g` while a text field is focused → suppressed (typed verbatim).

## F-9 (QREQ-9 / AC3) — Invalid / abandoned reset

- [ ] F-9: While pending press an invalid key; separately let the sequence time out. **Expected:** both perform NO action and visibly reset (overlay disappears; non-colour-only "cancelled/reset" indication); app returns to prior state. *(live receipt)*
  - **Edge:** Escape during pending resets and is consumed; focus change / window switch mid-sequence resets; a slow valid continuation still counts before the timeout.

## F-10 (QREQ-10 / AC4) — Hotkeys surface list + precedence + resets

- [ ] F-10: Open Settings → Hotkeys. **Expected:** the surface renders in the Settings window and lists BOTH tiers with search, rebind, reset-one and reset-all affordances; rows show tier + precedence labels; the list scrolls without clipping. *(live receipt)*
  - **Edge:** empty override set (defaults shown); long list; light + dark legibility; no re-render loop while filtering.

## F-11 (QREQ-11 / AC4) — Search

- [ ] F-11: Type a query into the Hotkeys search. **Expected:** filtering to matching rows (action name, binding string, or feature name); clearing restores the full list; a no-match query shows a graceful empty state. *(live receipt)*
  - **Edge:** case-insensitive; query = `Ctrl+Space`; query matching a feature with zero bindings; whitespace-only query.

## F-12 (QREQ-12 / AC4) — Rebind

- [ ] F-12: Capture a new chord for a row (keyboard) and commit; then fire the new chord. **Expected:** after resolve-before-save the new chord performs the action and the row reflects the new binding. *(live receipt)*
  - **Edge:** rebind to the SAME chord (no-op); rebind while the old chord is captured (no ghost); rebind a SEQUENCE; rebind a reserved combo (rejected per F-16).

## F-13 (QREQ-13 / AC4) — Reset one / reset all

- [ ] F-13: Change ≥2 bindings, reset ONE, then reset ALL. **Expected:** reset-one restores only that binding to default (others unchanged); reset-all restores every binding to shipped defaults; both reflected immediately. *(live receipt)*
  - **Edge:** reset with a custom override present; reset-all with no overrides (no-op, no crash); reset-one after a sequence rebind.

## F-14 (QREQ-14 / AC4) — Persistence across FULL app restart (E2E)

- [ ] F-14: Rebind a binding, reset another, enable the Vim preset; fully exit the app process and relaunch (`dev-env.ps1 -Down` then `-Up`); read the listing + fire the chords. **Expected:** the rebinding, the reset result and the preset state all survive; persisted per-user local only. *(live receipt)*
  - **Edge:** restart mid-edit (uncommitted change must NOT persist); corrupt/legacy config → safe fallback without crash; reset-after-restart; two restarts in a row.

## F-15 (QREQ-15 / AC5) — Conflict before effect + non-silent existing binding + resolve-before-save

- [ ] F-15: Bind a chord already in use; inspect BEFORE committing (the AC's complex scenario). **Expected:** the collision is surfaced BEFORE the new binding takes effect, naming which binding and which tier; the existing binding is NOT silently replaced; the user resolves (replace/reassign/cancel) and only then does the new binding commit. *(live receipt)*
  - **Edge:** local-vs-global (focused local wins, PO#8); local-vs-local in one feature; cancel leaves BOTH unchanged; collision with a sequence PREFIX surfaced too.

## F-16 (QREQ-16 / AC5) — Reserved keys unavailable with reason

- [ ] F-16: Inspect the reserved list; attempt to bind a reserved combo. **Expected:** the fixed platform-reserved list is shown UNAVAILABLE with a human-readable reason; attempting to bind a reserved combo is rejected with the same reason and nothing commits. *(live receipt)*
  - **Edge:** reserved modifier chord vs a free one; primary-modifier abstraction (Ctrl on Windows, platform-neutral — PO#12); reserved combo entered via capture vs typed.

## F-17 (QREQ-17 / AC5) — Typing-field suppression + terminal full passthrough + one escape chord (E2E)

- [ ] F-17: Focus an `input`, a `textarea`, a `contenteditable`, then a live terminal session; type bare keys and chords; fire the designated escape chord in the terminal. **Expected:** while a text field is focused bare-key/sequence shortcuts do NOT fire and the typed character reaches the field VERBATIM (no `preventDefault` swallowing); while a terminal session has focus ALL keys including modifier chords pass through (hotkeys suspended) EXCEPT the one designated escape chord, which still fires; modifier chords remain global OUTSIDE text/terminal. *(live receipt)*
  - **Edge:** each of `input` / `textarea` / `contenteditable`; password field; terminal + modifier chord → terminal receives it; escape chord in terminal → hotkey fires; blur to non-text lifts suppression; suppression after window switch.

## F-18 (QREQ-18 / AC5) — Modal owns keyboard; modifier chords global

- [ ] F-18: Open a modal/dialog, then fire a background hotkey and a global modifier chord. **Expected:** while a modal is open only the modal's keyboard contract is active (background hotkeys suppressed); closing returns keyboard to the prior focus; global modifier chords (e.g. Ctrl+Space) still fire from any non-suppressed focus. *(live receipt)*
  - **Edge:** modal over a maximized window; modal open while a sequence is pending (pending resets); navigating between two modals; Escape closes the modal without also firing a launcher action.

## F-19 (QREQ-19 / Q2) — Named action-sequence macro

- [ ] F-19: Bind and invoke a named macro. **Expected:** the named macro runs its ORDERED action sequence once per invocation; the listing shows it as a binding; a failing action is surfaced (no silent partial run) with the documented abort-or-continue behaviour. *(live receipt)*
  - **Edge:** empty macro; macro referencing an unavailable action; nested macro (allowed or explicitly rejected); invoking while a text field is focused (suppressed).

## F-20 (QREQ-20 / Q2) — Raw recording: explicit confirmation + replay

- [ ] F-20: Start a raw recording, then use/replay it. **Expected:** starting REQUIRES an explicit confirmation prompt; USING/replaying REQUIRES explicit confirmation; on confirm the recorded keystrokes replay; cancel performs no capture and no replay. *(live receipt)*
  - **Edge:** cancel at start; cancel at use; record zero keystrokes; stop via the designated stop; replay after the target surface changed (documented behaviour).

## F-21 (QREQ-21 / Q2/Q5) — Raw recording never captures text-entry

- [ ] F-21: Record while typing into a text field, plus some non-text chords. **Expected:** keystrokes typed into ANY text-entry field are NOT added to the recorded keystroke stream (the field still receives them); non-text keystrokes ARE captured and replay. *(live receipt)*
  - **Edge:** recording started before focus enters a field; focus enters/exits repeatedly; password field; `contenteditable`; IME composition input.

## F-22 (QREQ-22 / Q7) — Vim preset opt-in

- [ ] F-22: Read the default; enable the Vim preset; inspect + fire `hjkl` and the Space leader; disable. **Expected:** OFF by default; enabling sets leader = Space and adds `hjkl` navigation bindings that appear in the listing; disabling reverts to defaults; enabling with existing overrides surfaces conflicts (no silent clobber); the state persists across restart. *(live receipt)*
  - **Edge:** enable/disable cycles; `hjkl` while a text field is focused (suppressed); Space leader vs hold-Space dictation / Space-does-not-open-a-tile guard; restart with the preset on.

## F-23 (QREQ-23 / Q6) — Typed-character / logical-key model

- [ ] F-23: Bind a letter + a punctuation key; inspect how they display and match. **Expected:** bindings match on typed characters / logical keys (not raw physical scan codes); the listing displays the typed character; a layout change does not silently remap a binding to a different printed character. *(live receipt)*
  - **Edge:** a binding needing a modifier on the active layout; a punctuation binding; the platform-neutral primary-modifier abstraction; upper/lower-case display consistency.

## F-24 (QREQ-24 / NFR latency) — No typing / sequence latency

- [ ] F-24: Instrument keydown→effect timestamps for a chord and for a bare keystroke in a text field. **Expected:** chord action begins ≤100 ms after keydown; pending sequence hint appears ≤50 ms after the prefix; a bare keystroke in a text field is never delayed or blocked by the shortcut layer. *(live receipt)*
  - **Edge:** under an active pending sequence; during heavy agent streaming; rapid repeated chords (no dropped/double action).

## F-25 (QREQ-25 / NFR regression) — Existing shortcuts + no OS-wide hotkeys

- [ ] F-25: Fire Ctrl+Space from several surfaces; grep for global-shortcut registration. **Expected:** Ctrl+Space still opens + focuses the launcher from any focus (subject to typing suppression); the launcher's Esc/notch/grid keyboard behaviour and existing ESC listeners (`DetailPanel.tsx:202,223`) are unchanged; NO OS-wide/unfocused hotkey (Tauri global-shortcut) is registered. *(live receipt)*
  - **Edge:** Ctrl+Space while a text field is focused (launcher must NOT open); over a maximized window (re-raises above the stack); rapid double-press (exactly one toggle per press).

## F-26 (QREQ-26 / NFR a11y/theme) — Accessibility + token hygiene

- [ ] F-26: Static grep of the changed files + live focus/theme pass. **Expected:** every focus indicator visible and NOT colour-only; pending/conflict/reset states carry text/ARIA; the Hotkeys surface + which-key overlay use theme tokens/CSS vars/`tint()` (ZERO hardcoded hex/rgba, NO `var(--x)NN` alpha-append) and are legible in light + dark; bindings exposed to assistive tech (`aria-keyshortcuts` / accessible names). *(live receipt)*
  - **Edge:** both shipped themes; narrow/zoomed viewport; screen-reader name on the which-key overlay; focus-ring contrast on every theme.

## F-27 (QREQ-27 / Q13 negative) — No shortcut-usage telemetry

- [ ] F-27: Diff `telemetry_spans`/`telemetry_metrics` span + metric names before vs after rebinding + replaying a macro + a conflict. **Expected:** NO span/event/metric carries shortcut usage or binding identity; the tables gain no shortcut-usage rows; only canonical app/agent spans appear. *(live receipt)*
  - **Edge:** after a rebind; after a macro replay; after a conflict resolution; after a full restart.

## F-28 (promoted round 1, served-app boot) — Served app boots + engine mount

- [x] F-28: Load the SERVED app (`dev-env.ps1 -Up -Spec 2946`, port 5174, the
      `apps/tauri` entry) and assert the React tree mounts. **Expected:** `#root` has
      children; `document.documentElement[data-fredo-hotkeys-engine]="1"`; no
      `vite-error-overlay`. **Result (round 2, PASS):** on `spec/2946 @ 4ad4f802`
      `#root` = 2 children, `data-fredo-hotkeys-engine="1"`, `data-fredo-focus-context="default"`,
      `vite-error-overlay` absent, screenshot shows the Fredo desktop. **Origin:** E-1 round 1.
  - **Edge:** the served `apps/tauri` Vite `@` alias points at `apps/tauri/src` while
    `apps/ui` sources use `@/...` — round 2 fixed it with relative imports in `Keycap.tsx`
    and mounted `HotkeysProvider` in `apps/tauri/src/main.tsx`; `ui-validate` now runs
    `pnpm --filter @fredo/tauri build:webview`.

## F-29 (promoted round 2, feature tier absent) — AC2 feature hotkeys unsupported in the shipped app

- [ ] F-29: Open Settings → Hotkeys and inspect the tier sections; then `grep` the
      production feature sources for a `hotkeys` declaration. **Expected:** ONE listing
      shows the Fredo tier AND the focused feature's local bindings; a feature declaring
      hotkeys appears automatically. **Actual (round 2): FAIL** — the listing contains only
      a `FREDO (GLOBAL)` section (12 rows, all `data-hotkey-tier="global"`); zero
      production features declare `hotkeys` (`registerFeatureHotkeys`/`hotkeys:` appear
      only in `__tests__`), so no feature-tier row can render. **Repro:** Settings → Hotkeys
      → `document.querySelectorAll('[data-testid="hotkeys-row"]')` all `global`.
      This blocks H-4/H-5/H-6 (AC2).

## F-30 (promoted round 2, `g g` absent) — Non-leader multi-key sequence not shipped

- [ ] F-30: On a non-text surface press `g` then `g`. **Expected:** the first `g` arms a
      pending sequence naming `g` and the second executes the `g g` action once. **Actual
      (round 2): FAIL** — no non-leader multi-key binding is shipped
      (`MINIMAL_DEFAULT_BINDINGS` has only `@leader ?` under the Vim preset), so `g`
      arms nothing and `g g` performs no action. **Repro:** focus a window content region,
      dispatch `g`,`g` → no `data-fredo-pending-sequence`, no effect. This blocks H-8 (AC3).

## F-31 (promoted round 2, dead cheatsheet action) — `fredo.help.cheatsheet` has no run handler

- [ ] F-31: Fire the leader then `?`. **Expected:** a cheat-sheet surface opens. **Actual
      (round 2): PARTIAL** — the leader + which-key hint work (`pending="@leader"`, overlay
      names `?`), but completing the sequence executes a **no-op**: `fredo.help.cheatsheet`
      is registered with no `run` and `registerHotkeyHandler('fredo.help.cheatsheet', …)` is
      never called (no cheat-sheet component ships). **Repro:** complete `Leader`,`?` → no
      dialog/surface.

## F-32 (promoted round 2, reset-all / preset inconsistency) — reset-all leaves the Vim preset half-applied

- [ ] F-32: Enable the Vim preset, then Reset all → confirm, then inspect the toggle + rows.
      **Expected:** reset restores a clean shipped-default state. **Actual (round 2): FAIL
      (inconsistent)** — `vimPresetEnabled` stays `true` while `bindings` are cleared, so
      the toggle reads ON but `fredo.focus.left/right` render unbound and `hjkl` no longer
      fire. Macros are correctly kept (trigger cleared), matching R-4.4. **Repro:** enable
      Vim preset → Reset all → `get_setting fredo.hotkeys.keymap` → `vimPresetEnabled:true`,
      `bindings['fredo.focus.left']` absent.

---

## #2946 testing round 1 — result

**Verdict: FAIL (0 of 27 QA rows verifiable).** The served app on `spec/2946` tip
`e823a07a` does not boot: Vite fails import-analysis on `Keycap.tsx`'s unresolved
`@/shared/utils/colorTint` (the served `apps/tauri` alias maps `@` → `apps/tauri/src`,
whereas the module lives in `apps/ui/src`). Every F-1..F-27 live leg is therefore
blocked — none could be driven. Rows remain unchecked; re-run after the boot fix.

## #2946 testing round 2 — result

**Verdict: FAIL (21/27 QA rows PASS).** The served app boots on `spec/2946 @ 4ad4f802`
(F-28 PASS). AC4 (configuration + full-restart persistence), AC1 (traversal), and the
AC5 conflict/reserved/typing/modal legs all pass with live evidence. The feature fails on:
- **AC2 (F-29):** no shipping feature declares hotkeys → the feature tier is absent from the
  shipped listing (H-4/H-5/H-6).
- **AC3 (F-30):** `g g` is not shipped; the only multi-key binding is the Vim `@leader ?`.
- **AC3 (F-31):** `fredo.help.cheatsheet` is a dead action (no cheat-sheet surface).
- **AC5 (H-17 terminal leg):** no live PTY session was available to verify terminal full
  passthrough (blocker: `list_terminal_sessions` → `[]`, `[data-fredo-terminal-root]` count 0).
- **AC4 (F-32):** reset-all leaves the Vim preset flag ON while clearing its bindings.

Passing rows: H-1, H-2, H-3, H-7 (caveat), H-9, H-10, H-11, H-12, H-13 (finding), H-14,
H-15, H-16, H-18, H-19, H-20, H-21, H-22, H-23, H-24, H-25, H-26, H-27.
Failing: H-4, H-5, H-6, H-8, H-17.

---

## Requirement-ID reconciliation

`QREQ-1..QREQ-27` map 1:1 to AC1..AC5 plus PO resolutions Q2/Q5/Q6/Q7 as declared in
`.opencode/tmp/2946/triage.md` `## QA Expert`. The SI realigns these to the Architect's
`REQ-n` at convergence; until then bind to either the published `REQ-n` or the `QREQ-n`
above.
