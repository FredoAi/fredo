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

> **#3009 supersedes (OBSOLETE — do NOT re-run on `spec/3009`).** The configurable-hotkeys
> platform (#2946/#2958/#2959/#2960/#2961/#2962) is REMOVED and replaced by the always-on
> element-declared model. Retained for history, these #2946 row groups are OBSOLETE:
> config listing/rebind/reset/preset/persistence F-4/F-5/F-10..F-16/F-22; macro rows
> F-19..F-21; the feature-local tier F-6 and typed-key model F-23; which-key/cheat-sheet
> F-7/F-30/F-31; `g g` / leader sequences F-8/F-9; typing/modal rows F-17/F-18. The whole
> `#2958` context section (F-33..F-43), `#2959` keyboard-mode/bar section (F-44..F-54),
> `#2960` regime/discovery/intro section (F-55..F-71), `#2961` per-app action section
> (F-72..F-87), and `#2962` nested-context section (F-88..F-94) are likewise OBSOLETE.
> Their surviving invariants are restated in the Spec #3009 section below (F-95..F-110) and
> in `regression.md` R-39..R-49. Do NOT delete these rows — they are the historical record.

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

- [x] F-29: Open Settings → Hotkeys and inspect the tier sections; then `grep` the
      production feature sources for a `hotkeys` declaration. **Expected:** ONE listing
      shows the Fredo tier AND the focused feature's local bindings; a feature declaring
      hotkeys appears automatically. **Round 3 (PASS, `spec/2946 @ 45d5120`):** the
      listing renders 3 tiers — `global` (13 rows), `feature:mission-monitor` (3:
      focusSessionSearch `s`, nextSession `n`, previousSession `p`) and `feature:diagram`
      (2: search `s`, fitView `f`); features declaring none (My Work Items, Model Storage,
      Terminal) contribute zero rows. With Mission Monitor focused, `s` focuses the session
      filter and `n`/`p` change the selected session (wrap-around); the same chord is inert
      while Settings is focused and while a text field is focused. **Repro:** Settings →
      Hotkeys → `document.querySelectorAll('[data-testid="hotkeys-row"]')` tier histogram =
      `{global:13, feature:diagram:2, feature:mission-monitor:3}`.

## F-30 (promoted round 2, `g g` absent) — Non-leader multi-key sequence not shipped

- [x] F-30: On a non-text surface press `g` then `g`. **Expected:** the first `g` arms a
      pending sequence naming `g` and the second executes the `g g` action once. **Round 3
      (PASS, `spec/2946 @ 45d5120`):** `MINIMAL_DEFAULT_BINDINGS` now ships
      `'fredo.window.first': ['g g']`; the first `g` sets `data-fredo-pending-sequence="g"`
      with the which-key overlay (`prefix=G`, candidate `G — Focus first window — Global`,
      announcer `Prefix: G. Valid next keys: G (Focus first window).`); the second `g`
      clears pending and focused the first window (`window-frame-setup`, one
      `data-focused false→true` transition). `g`+invalid clears pending with the
      non-colour toast `No binding for G — sequence cancelled`. The listing shows `G G`
      for `fredo.window.first`. **Observation:** bare `g` does not arm while a `<button>`
      is focused (engine native-consumer rule); the AC's "non-text surface" = BODY/default
      context, which arms correctly.

## F-31 (promoted round 2, dead cheatsheet action) — `fredo.help.cheatsheet` has no run handler

- [x] F-31: Fire the leader then `?`. **Expected:** a cheat-sheet surface opens. **Round 3
      (PASS, `spec/2946 @ 45d5120`):** ST-14 ships `CheatSheetOverlay`
      (`hotkeys-cheatsheet-overlay`/`-search`/`-list`/`-row`/`-empty`/`-close`), mounted in
      `HotkeysProvider` and wired via `registerHotkeyHandler('fredo.help.cheatsheet', …)`.
      `?` on a non-text surface opens `role="dialog" aria-modal="true"` with 20 rows
      (grouped Fredo-then-feature, incl. `Focus first window G G` and the feature rows);
      the search focuses on open; `session` filters to the 3 session rows; `zzzznomatch`
      shows `hotkeys-cheatsheet-empty` (`role="status"`) `No hotkeys match "zzzznomatch".`;
      Escape closes and returns focus to the invoker (`window-content-setup`). With the Vim
      preset ON, `Space` then `?` (`@leader ?`) opens the same overlay. The pane-local
      cheat sheet/testids are preserved.

## F-32 (promoted round 2, reset-all / preset inconsistency) — reset-all leaves the Vim preset half-applied

- [x] F-32: Enable the Vim preset, then Reset all → confirm, then inspect the toggle + rows.
      **Expected:** reset restores a clean shipped-default state. **Round 3 (PASS,
      `spec/2946 @ 45d5120`):** enabling the preset applies `leader=space`,
      `focus.left/right/down/up = h/l/j/k`, `fredo.help.cheatsheet=['@leader ?']` and writes
      the snapshot. `Reset all` → `get_setting fredo.hotkeys.keymap` =
      `{leader:null, vimPresetEnabled:false, 'fredo.focus.left':absent,
      'fredo.help.cheatsheet':['?']}`, macros kept (`e2e-macro`, `e2e-raw`, triggers null);
      `get_setting fredo.hotkeys.vimPreset.snapshot` absent; the toggle reads OFF; toast
      `All hotkeys reset to defaults. Macros were kept.`. ST-17 clears the snapshot from
      `confirmResetAll` (no store→vimPreset cycle).

---

## Spec #2958 — named interaction contexts + Escape-back — **#3009 supersedes (OBSOLETE)**

> Live-plan extension for issue #2958: the context model, parent/child link, navigation
> stack, and Escape-back. Builds on the shipped hotkeys subsystem (#2946). Rows F-33..F-43
> map 1:1 to the QA Plan in `.opencode/tmp/2958/triage.md` `## QA Expert` (`R-1`..`R-6`,
> where `R-6` = the complex multi-step unwind). Names are the Architect's BINDING block
> (`useActiveHotkeyContext()`, `getHotkeyContextSnapshot()`, `subscribeHotkeyContext()`,
> `HotkeyContextSnapshot { contextId, depth, reason }`, root id `'fredo.root'`, base
> `depth = 1`, `context:changed`, `ContextIndicator`, `contextAnnouncement(snapshot)`;
> testids `hotkeys-context-indicator` / `-label` / `-depth`; body hooks
> `data-fredo-hotkey-context` / `data-fredo-hotkey-context-depth`); the shipped
> `hotkeys-announcer` single region carries the AT announcement. A rename updates selectors,
> not behaviors.
> **G-220 pre-existing Escape owners (must not be masked):** F-A pending-cancel → R-12/F-43;
> F-B base Escape native → F-36; F-C native consumer (`<button>` Space) → F-37/F-42;
> F-D modal owns Escape → F-42; F-E terminal passthrough → F-42.
> **Verification policy: live** — evidence carries the DOM/a11y/screenshot assertion PLUS a
> `telemetry_spans` live receipt from a sanctioned span-producing lever in the drive window
> (the hotkeys layer itself emits no telemetry — #2946 F-27 / PO Q13).

## F-33 (R-1 / AC1) — Key reuse across levels inside ONE focused app

- [ ] F-33: Focus one app (e.g. Mission Monitor) with the app top level in force. Fire the app's top-level chord (e.g. `s`); then descend into the deeper context (S-11 recipe) and fire the SAME chord. **Expected:** the top-level chord runs the top-level action; after descent the same chord runs the DEEPER context's action — the level in force decides; no other app's action runs; `hotkeys-context-indicator-label` shows the deeper context and `hotkeys-context-indicator-depth` increments. **Data:** DOM hook + accessibility snapshot after each press; action-visible effect (e.g. which control gained focus). *(live receipt)*
  - **Edge:** chord bound at BOTH levels; a deeper-only action; a chord bound at the parent but not the child → while descended it performs NO action (see F-37); rebind while inside a context.

## F-34 (R-2 / AC2) — Descent changes what is available

- [ ] F-34: From a top-level app context, descend into a deeper context, then run a deeper-only action. Separately attempt to descend from a context that has no deeper level. **Expected:** descent moves into the deeper context; the deeper context's actions are available and the deeper-only action runs; the parent remains the ancestor. Descending where no deeper level exists performs no context change (parent actions stay in force). **Data:** `hotkeys-context-indicator-label`/`-depth` before/after; action effect. *(live receipt)*
  - **Edge:** no-deeper-level context; descend then focus another window; descend while a text field is focused (must not hijack typing); two consecutive descents.

## F-35 (R-3 / AC3) — Escape returns exactly one level and restores actions

- [ ] F-35: Descend two levels, then press Escape once and inspect; press Escape again. **Expected:** ONE Escape returns to the context the user came from and its actions are available again; a further Escape unwinds to that context's parent; `hotkeys-context-indicator-label`/`-depth` change one level per Escape. **Data:** `hotkeys-context-indicator-label`/`-depth` after each Escape; re-fire the parent chord to prove restoration. *(live receipt)*
  - **Edge:** Escape at the root leaves the key native (no context change); 1-level-deep → root; Escape while a pending sequence is armed (see F-36 / R-12).

## F-36 (R-6 / AC3 complex scenario) — Full unwind; base Escape is not hijacked

- [ ] F-36: Given the user descended from a top-level context into a deeper context. When the user presses Escape, then returned to the context they came from and its actions are available; and a further Escape returns to that context's parent; and at the top-level context Escape is left to its existing behaviour — including the shipped pending-multi-key Esc cancel and the launcher Escape. **Expected:** the context stack unwinds exactly one level per Escape; at the root, Escape is NOT consumed by the context model (the pending sequence still cancels; the launcher ESC still closes/restores). **Data:** `hotkeys-context-indicator-label`/`-depth` + the shipped `data-fredo-pending-sequence` after each step. *(live receipt)*
  - **Edge:** 2- and 3-level unwind; pending `g`/`g g` sequence armed at top level then Escape (`data-fredo-pending-sequence` clears, context unchanged); modal open; Escape twice at root (no extra effect).

## F-37 (R-5 / AC5) — No silent fall-through; parent in force only when no deeper level

- [ ] F-37: While descended, press (a) a key with no meaning in the current context, and (b) a key bound only at the PARENT context. Separately, stand in a context with no deeper level and fire the parent's action. **Expected:** (a) and (b) perform NO action and never silently fall through to the parent's/another app's binding; the no-deeper-level case leaves the parent's actions in force and the parent action fires normally. **Data:** action-effect counter; `hotkeys-context-indicator` unchanged. *(live receipt)*
  - **Edge:** unbound key while descended; parent-only key while descended; a key bound only in another app; focus churn inside the app then repeat the key.

## F-40 (R-2.2 / G-123 continuous state) — The context's actions are in force WHILE in that context

- [ ] F-40: Descend, then (without leaving) wait past the sequence timeout, move focus within the app, and switch theme; then fire the deeper action and the parent-only key. **Expected:** for the whole time the context is in force the in-force action set is that context's (deeper action still resolves; parent-only key still does nothing); the context indicator persists; the state is not re-derived only at the transition. **Data:** `hotkeys-context-indicator-label`/`-depth` sampled after each perturbation; action effect. *(live receipt)*
  - **Edge:** wait past the sequence timeout; focus move within the app; theme switch; two contexts live in two windows.

## F-38 (R-4 / AC4) — Context change communicated, not colour-only

- [ ] F-38: Descend and Escape, capturing the visible context indicator after each change in BOTH shipped themes. **Expected:** every change updates a visible TEXT label (`hotkeys-context-indicator-label`) plus a direction icon shape and depth pips (`hotkeys-context-indicator-depth`) — at least three non-colour channels; the meaning is read from the label/pips, not from colour alone; legible in light + dark; the indicator does not clip at a narrow viewport. **Data:** `[data-testid="hotkeys-context-indicator"]` text + screenshot per change; light + dark. *(live receipt)*
  - **Edge:** both shipped themes; narrow/zoomed viewport; root label; rapid repeated changes.

## F-39 (R-4.2 / AC4 a11y) — Announced to assistive technology on EVERY change

- [ ] F-39: Descend then unwind, reading the shared announcer after each change. **Expected:** each descent and each Escape emits a distinct announcement through the shipped polite live region (`role="status"`, `aria-live="polite"`, `[data-testid="hotkeys-announcer"]`); the visual indicator is `aria-hidden` and does not double-announce; re-firing the SAME context does not re-announce stale text. **Data:** announcer textContent after each change; accessibility snapshot of the region. *(live receipt)*
  - **Edge:** descend + unwind sequence; same-context re-fire; modal open; accessible region name present.

## F-41 (NFR) — Latency + determinism of enter/leave/unwind

- [ ] F-41: Instrument keydown→effect timestamps for a chord in a deeper context and a bare keystroke in a text field; then run a repeated enter/leave/unwind cycle N times. **Expected:** the deeper-context chord begins ≤100 ms after keydown (no added latency vs top level); a bare keystroke in a text field is never delayed; repeated identical cycles produce an identical context stack + action (no drift); stack depth stays bounded. **Data:** timestamp deltas; context-stack samples per cycle. *(live receipt)*
  - **Edge:** under a pending sequence; rapid repeated Escape; under heavy streaming; many cycles.

## F-42 (NFR) — Typing safety + shipped Escape precedence preserved

- [ ] F-42: Focus an `input`, a `textarea`, a `contenteditable`, then a live terminal session; type bare keys and press Escape; then open a modal over a descended context and press Escape. **Expected:** bare keys typed in text-entry/terminal pass through VERBATIM (the context model never hijacks them); Escape while a text field is focused does NOT unwind a context; modal-open Escape belongs to the modal (closes it, does not unwind); terminal passthrough unchanged. **Data:** field content; no pop (indicator unchanged, no `context:changed` announcement); modal state. *(live receipt)*
  - **Edge:** input / textarea / contenteditable; password; terminal session; modal over a descended context.

## F-43 (R-3.3 pending-Esc precedence) — Pending sequence vs context unwind on Escape

- [ ] F-43: Descend to `depth > 0`, arm a multi-key sequence (e.g. `g`), then press Escape once and inspect; press Escape again with no pending. **Expected:** with a sequence pending at ANY depth the shipped pending-sequence Escape cancel wins — the prefix clears (`data-fredo-pending-sequence` clears), the shipped `sequence:reset('escape')` announcement fires, and NO context level is popped (`hotkeys-context-indicator-depth` unchanged); the NEXT clean Escape pops exactly one level. The two behaviours are distinguishable in one drive. **Data:** `data-fredo-pending-sequence` + indicator depth after each Escape; announcer text. *(live receipt)*
  - **Edge:** pending at the base (same rule, no pop); pending below the base; pending clears then clean Escape; base clean Escape left native (R-12).

---

## Spec #2959 — keyboard mode + persistent contextual key bar — **#3009 supersedes (OBSOLETE)**

> Live-plan extension for issue #2959 (S2 of the keyboard-first effort; builds on the merged
> S1 context model #2958). Rows F-44..F-52 map 1:1 to the QA Plan in
> `.opencode/tmp/2959/triage.md` `## QA Expert` (`REQ-1`..`REQ-5` = AC1..AC5 + `NFR-1`..`NFR-4`).
> Binding/testid names bind to the Architect's BINDING block (mode entry/exit chord + bar
> indicator) and the shipped S1 anchors (`data-fredo-hotkey-context` / `-depth`,
> `hotkeys-context-indicator[-label|-depth|-pip|-icon]`,
> `[data-testid="hotkeys-announcer"]`, `data-fredo-pending-sequence`,
> `data-fredo-focus-context`, `data-fredo-hotkeys-engine`); a rename updates selectors, not
> behaviors. **Out of scope (must not be re-specced):** S3 typing-vs-navigating signal /
> zero-knowledge discovery / first-run intro; S4 per-app action sets; S5 deep nesting /
> cross-level key reuse; no new bindable actions beyond the mode chord; no re-spec of
> which-key / cheat sheet; no new Settings surface.
>
> **Verification policy: live** — evidence carries the DOM/a11y/measured-rect/screenshot
> assertion PLUS a `telemetry_spans` live receipt from a sanctioned span-producing lever in
> the drive window (the hotkeys layer itself emits no telemetry — #2946 F-27 / PO Q13).

## F-44 (REQ-1 / AC1) — Entry/exit chord with a clearly-indicated mode

- [ ] F-44: On the resting desktop fire the keyboard-mode ENTRY chord; capture the indication; fire the EXIT chord. **Expected:** mode enters on ONE dedicated chord with a persistent NON-colour-only indication (a text label + an icon/shape channel, ≥2 channels); exit hides the bar, clears the mode hook, and `document.activeElement` equals the pre-entry element (focus where it was). **Data:** `document.activeElement` before/after entry+exit; the mode hook + indicator DOM; screenshot. *(live receipt)*
  - **Edge:** chord from a focused text field (a modifier chord stays global per R-5.5; a bare-key chord is suppressed); chord with a modal open (modal owns the keyboard → suppressed, modal unaffected); chord while a terminal is focused (passthrough → suppressed); rapid double-press = exactly one toggle; the pre-entry focus origin unmounts between entry and exit; entry while a sequence is pending.

## F-45 (REQ-2 / AC2) — Persistent bar lists the current context's actions (not only mid-sequence)

- [ ] F-45: Enter mode, then WAIT past the sequence timeout with `data-fredo-pending-sequence` null (no multi-key sequence armed); sample the bar rows; dwell ~10 s and re-sample. **Expected:** the bar is CONTINUOUSLY present while mode is on and lists the current context's available actions each with its key label — present with NO pending sequence (not only a mid-sequence which-key hint); survives the idle dwell; absent when mode is off and at boot. **Data:** `data-fredo-pending-sequence` (null), bar row count/text, two timed samples. *(live receipt)*
  - **Edge:** a one-action context; a many-action context (rows scroll / do not clip); re-entering mode does not duplicate rows; mode off during a context change leaves no stale bar.

## F-46 (REQ-3 / AC3) — Live context follow without re-entering mode

- [ ] F-46: Enter mode; capture bar rows; descend (`primary+K` → `fredo.root.reference`); Escape to return; then change the focused app (focus another feature window) — all WITHOUT re-entering mode (complex scenario). **Expected:** on descent the bar rows switch to the deeper context's actions; one Escape restores the prior context's rows; a focused-app change switches to the new app's actions — mode stays ON throughout; the context change is announced to AT. **Data:** `hotkeys-context-indicator-label`/`-depth` + bar rows after each step; announcer text. *(live receipt)*
  - **Edge:** descending into a context with ZERO actions; focused-app change while a sequence is pending; rapid descend/unwind (no stale rows); two windows with different contexts; mode toggled off then on across a context change.

## F-47 (REQ-4 / AC4) — Non-intrusive + accessible + non-colour-only

- [ ] F-47: Enter mode; attempt Tab into and a click at the bar; read `document.activeElement` across entry and every context change; read the announcer; render both themes. **Expected:** the bar is NOT focusable (never in the tab order) and its pointer region does not steal interaction (a click at the bar's RESTING rect reaches the element beneath); `activeElement` never changes because of the bar; the shared polite live region announces ENTRY and EVERY context change; the bar's meaning is readable from text + icon shape + keycaps — not colour alone; legible in light + dark. **Data:** `document.activeElement` samples; `elementFromPoint(barRect centre)`; accessibility snapshot; announcer text; light + dark screenshots. *(live receipt)*
  - **Edge:** bar overlapping an adjacent control — assert the adjacent content's rect vs the bar's RESTING box = zero overlap/clip (G-170/G-253); narrow/zoomed viewport; accessibility-tree names for the bar and any empty/unavailable state; both shipped themes.

## F-48 (REQ-5 / AC5) — Unavailable-with-reason / hidden-by-rule + empty state

- [ ] F-48: In a context with a declared-but-unavailable action, inspect the bar; then force a context with NO actions. **Expected:** the unavailable action is either shown UNAVAILABLE-WITH-REASON (a visible reason string) or hidden by the DECLARED rule — never a dead actionable entry (activating it, mouse or keyboard, performs nothing); the empty context renders a DEFINED empty-state element carrying text (and an announcement), never a blank bar. **Data:** the unavailable row's text/state + an activation attempt result; the empty-state element text/role; screenshot. *(live receipt)*
  - **Edge:** ALL actions unavailable; a long reason string; availability flips after a context change (the row updates); a greyed entry is not keyboard-activatable; the empty state is announced and non-colour-only.

## F-49 (NFR-1 / performance) — No perceptible latency + no re-render storm

- [ ] F-49: Instrument keydown→bar-update timestamps for entry and for a context change; count bar + feature-tree renders. **Expected:** entry-chord effect begins ≤100 ms after keydown; a context-change bar update lands within ~1 frame; NO per-keystroke re-render storm and no `Maximum update depth exceeded` (epoch-keyed memo; no `.length`/new-object deps — AGENTS.md #523). **Data:** timestamp deltas; render counts; console. *(live receipt)*
  - **Edge:** under heavy agent streaming; rapid context changes; a large action set; repeated toggles.

## F-50 (NFR-2 / reduced-motion) — Reduced-motion respected

- [ ] F-50: Set `prefers-reduced-motion: reduce`; enter/exit and change context. **Expected:** with reduce, the bar's appear/update/exit transitions are instant/non-animated (no transform/opacity animation) while fully functional; the announcement still fires; focus non-stealing still holds. **Data:** computed animation/transition properties + rendered-over-time screenshot pair; announcer text. *(live receipt)*
  - **Edge:** reduce enabled at boot vs toggled live mid-transition; mode entry transition; context-change update animation; reduced-motion off = motion allowed.

## F-51 (NFR-3 / theming) — Token/CSS-var hygiene

- [ ] F-51: Static grep of the changed files + a live light/dark + accent pass. **Expected:** ZERO hardcoded hex/rgba/hsla and ZERO `var(--x)NN` alpha-append in the new bar/mode files; colours come from theme tokens / CSS vars / `tint()`; the bar restyles by changing only token definitions; legend + keycaps legible in light AND dark. **Data:** grep output; light/dark/accent screenshots. *(live receipt)*
  - **Edge:** both shipped themes; a user accent change; narrow/zoomed viewport; keycap foreground/contrast.

## F-52 (NFR-4 / reliability) — Bar never disagrees with the engine

- [ ] F-52: Drive entry → descend → return → focused-app change → unwind; after EACH step compare the bar's displayed context id/label against the engine snapshot (`getHotkeyContextSnapshot()` / `data-fredo-hotkey-context`). **Expected:** the bar's listed context ALWAYS equals the engine's current context — no stale rows after an unwind, no disagreement, deterministic across identical cycles. **Data:** per-step bar context + `data-fredo-hotkey-context` / snapshot. *(live receipt)*
  - **Edge:** same-context re-fire; rapid descend/unwind; entry during a pending sequence; a context change while mode is off.

## F-53 (REQ-2 edge, promoted round 1) — many-action context clips; context-scoped action dropped

- [x] F-53: Enter keyboard mode on the resting desktop (a realistic root context: shipped
      `primary+1..9` cycleNth + the fredo tier + feature rows) and inspect the bar list.
      **Expected (QA edge "rows scroll / do not clip"; UI/UX §3 context-first ordering + §6
      `more` chip):** the rows scroll or are not clipped, and the context-scoped chips are
      not dropped by overflow. **Round 1 (FAIL, `spec/2959 @ 4238d8c`):** the list is
      `overflow: hidden`; at 1920 px `scrollWidth=4976` vs `clientWidth=1574` → 3402 px
      (68%) clipped, no scroll, no "more" chip; `fredo.context.descendReference` (the
      context-relevant descent action) is the LAST row (rect.right=5152) and is entirely
      off-screen behind the exit chip (rect.left=1763). At 1280 px the same applies.
      **Repro:** enter mode → read
      `getComputedStyle(document.querySelector('[data-testid="hotkeys-keyboard-bar-list"]'))`
      (`overflowX === 'hidden'`, `scrollWidth > clientWidth`); compare the last
      `[data-testid="hotkeys-keyboard-bar-row"]` rect to
      `[data-testid="hotkeys-keyboard-bar-exit"]`. Origin: E-34 round 1.
      **Round 3 (PASS, `spec/2959 @ 0ead7b0`):** at `fredo.root.reference` the bar is
      bounded with an explicit `+N more` affordance and no silent clip — 1920×1080:
      total 24, visible 2, `+22 more` (2+22=24), list `scrollWidth==clientWidth==1445`,
      `descendReference` rect `{213,983,212,29}` in viewport and not behind the exit chip
      (`{left:1747}`); 1280×800: total 24, visible 1, `+23 more` (1+23=24), list `805==805`,
      `descendReference` `{213,703,212,29}` in viewport, exit left `1107`. Context-first
      ordering holds (`descendReference` is row #1 at both widths). Origin: E-34 round 1.

## F-54 (promoted round 2, REQ-5 regression) — unavailable reason hard-clipped by the row clamp

- [x] F-54: Enter keyboard mode, focus a text-entry field so bare-key rows flip to
      `data-availability="unavailable"`, and read the unavailable row's reason. **Expected:**
      the declared reason is readable (REQ-5 "a visible reason string"; QA edge "a long reason
      string"). **Round 2 (FAIL, `spec/2959 @ a693d30`):** the round-2 F-3 chip clamp
      (`KeyboardBar.tsx:165` `maxWidth={KEYBOARD_BAR_ROW_MAX_WIDTH_PX}` 240 px + `overflow:hidden`;
      reason `<Text>` at `:187-194` with no min-width/ellipsis) hard-clips the default reason
      `Unavailable while typing` to **8/25** characters (`Unavaila`) — the reason `<p>` measures
      x `1069..1198` (129 px) against a row content clip edge of `1117`; the explaining
      `while typing` is unreadable, and the action title collapses to `0px` width. Round 1
      (`4238d8c`) rendered the reason in full (no `maxWidth`), so this is a regression.
      Non-activatable safety holds (row is a non-focusable `DIV`). **Repro:** enter mode →
      focus `TEXTAREA[data-testid="launcher-command-input"]` → locate
      `[data-testid="hotkeys-keyboard-bar-row-unavailable"]` → compare its
      `getBoundingClientRect()` / visible chars (Range bisection) against the parent row's
      content right edge. Origin: E-34 round 1, re-raised round 2.
      **Round 3 (PASS, `spec/2959 @ 0ead7b0`):** the unavailable chip uses the dedicated
      480 px budget; on the live text-entry lever (`TEXTAREA[launcher-command-input]`) the
      reason `<p>` renders the FULL `Unavailable while typing` (**24/24** chars via Range
      bisection; 8/25 in round 2) with its right edge `818` ≤ chip clip edge `824` (≤ content
      edge `818`); the action title width is **130.5 px** (0 px in round 2, `minWidth:48px`).
      Second context re-check (mission-monitor / `mission-monitor.focusSessionSearch`): chip
      `{l:464.6,w:369,r:833.6}`, title `109.2`, reason right `827.6 ≤ clip 833.6`. Safety half
      holds (row is a non-focusable `DIV`; a bare `y` in text-entry runs nothing). Origin:
      E-26 round 2.

---

## #2959 testing round 2 — result (served spec/2959 @ a693d30)

**Verdict: FAIL (8/9 plan rows PASS; REQ-5 FAIL — regression; NFR-2 UNVERIFIED pin-only blocker).**
Driven live (dev-env UP, `spec/2959 @ a693d30`, driver `com.fredo.app`). Live receipt: 204
`telemetry_spans` in the drive window 2026-09-27 02:20:07 → 02:32:34 (`otlp_grpc`). Console clean.

- **REQ-1 PASS**, **REQ-3 PASS**, **REQ-4 PASS**, **NFR-1/3/4 PASS** — see the `## Tests Runs`
  verdict on the issue for full measurements.
- **REQ-2 / F-45 / F-53 — PASS (the round-1 FAIL is fixed).** At `fredo.root.reference`:
  1920-wide → total 24, visible 5, `+19 more` (5+19=24), list `scrollWidth==clientWidth`
  (no clip), `descendReference` rect `{213,920,212,29}` in viewport and not behind the exit
  chip; 1280×800 → total 24, visible 2, `+22 more` (2+22=24), no clip, `descendReference`
  `{213,703,212,29}` visible. Dwell stable over 21.3 s with `pending=null`; re-entry 0
  duplicates; context change while OFF leaves no stale bar.
- **REQ-5 / F-48 — FAIL.** See F-54 (unavailable reason hard-clipped). The empty-context leg
  remains a named blocker (no live zero-binding context).
- **NFR-2 / F-50 — UNVERIFIED (named pin-only blocker):** live media = no-preference; no
  media-emulation lever in the Tauri MCP driver. Residual pin: `KeyboardBar.test.tsx`
  `reducedMotion` render asserts `root.style.animation === 'none'`.

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

## #2946 testing round 3 — result

**Verdict: PASS (27/27 QA rows).** Run on the served app `spec/2946 @ 45d5120` (dev-env
UP, driver `com.fredo.app`, main + terminal windows). The round-3 fix (ST-14 cheat-sheet
overlay, ST-15 real feature declarations, ST-16 `g g`, ST-17 reset-all) closed every
round-2 failure and the regression sweep held.

Re-run live this round (previously failing):
- **AC2 H-4/H-5/H-6 (F-29): PASS** — 3 tiers in one listing (global 13,
  `feature:mission-monitor` 3, `feature:diagram` 2); zero-contribution holds; with Mission
  Monitor focused `s` focuses the session filter and `n`/`p` change the selection with
  wrap-around; inert while Settings is focused; typed verbatim in a text field.
- **AC3 H-7 (F-31): PASS** — `?` opens `hotkeys-cheatsheet-overlay` (20 rows, search
  focused); search filter + `hotkeys-cheatsheet-empty`; Escape closes and returns focus to
  the invoker; `@leader ?` opens the same overlay with the Vim preset ON.
- **AC3 H-8 (F-30): PASS** — first `g` arms `data-fredo-pending-sequence="g"` + which-key
  naming `g`; second `g` focuses the first window once; `g`+invalid resets with the text
  toast; listing shows `G G` for `fredo.window.first`.
- **AC4 H-13/F-32: PASS** — reset-all → `vimPresetEnabled:false`, `leader:null`, defaults
  bound (`?`), macros kept, snapshot absent, toggle OFF.
- **AC5 H-17: PASS** — terminal full passthrough driven with a live
  `spawn_terminal_session{cli:"shell"}` session: `[data-fredo-terminal-root="true"]`
  count 1, `document.body[data-fredo-passthrough="true"]` when the session is focused; a
  bare key reaches the PTY (buffer 277→286, echoed), no hotkey fires; `Ctrl+Shift+F10`
  exits passthrough (`data-fredo-passthrough` clears, focus on
  `hotkeys-terminal-passthrough-exit`); the `Passthrough | Ctrl+Shift+F10 | Release
  keyboard` pill renders. Typing-field suppression PASS.

Regression sweep re-run live:
- **AC1 H-3: PASS** — keyboard-only flow (Ctrl+Space → type → Enter → operate → collapse)
  with `{mousedown:0, click:0, pointerdown:0}`.
- **H-15 conflict-before-effect: PASS** — Ctrl+Space collided with `Toggle launcher`
  (Global, `fredo.launcher.toggle`); target row stayed `primary+P`; Cancel left both
  unchanged.
- **H-14 full-restart persistence: PASS** — after `dev-env Down`+`Up` the rebind
  (`primary+alt+o`), Vim preset ON (`leader=space`, `hjkl`) and macros (`e2e-macro`,
  `e2e-raw`) all survived; the listing rendered them.
- **H-27 no shortcut-usage telemetry: PASS** — 0 `telemetry_spans` span names and 0
  `telemetry_metrics` metric names matching hotkey/shortcut/keymap/macro/binding.
- **Console: clean** — no `Error:`/`Uncaught`/`Maximum update depth exceeded`.

Technique note (H-17): the MCP driver emits non-standard modifier keystrokes
(`code` = the literal key, e.g. `"c"` instead of `"KeyC"`, `keyCode:0`), so ghostty-web
does not map the driver's synthetic modifier chords to control bytes; a well-formed
`Ctrl+C` (`code:"KeyC"`, keyCode 67) DOES reach the PTY (`^C`, buffer grew). The exit
chord (also a modifier chord) fires through the driver, and no non-exit chord is consumed
by the engine. This is a harness fidelity note, not a product defect.

---

## Requirement-ID reconciliation

`QREQ-1..QREQ-27` map 1:1 to AC1..AC5 plus PO resolutions Q2/Q5/Q6/Q7 as declared in
`.opencode/tmp/2946/triage.md` `## QA Expert`. The SI realigns these to the Architect's
`REQ-n` at convergence; until then bind to either the published `REQ-n` or the `QREQ-n`
above.

---

## #2958 testing round 1 — result (served spec/2958 @ ea0db5c)

**Verdict: PASS.** Driven live on the served app (dev-env UP, `spec/2958 @ ea0db5ca`, driver
`com.fredo.app`, main window + embedded Terminal pane). **Live receipt:** 195 `telemetry_spans`
landed in the drive window 2026-09-26 23:52:46 → 2026-09-27 00:08:54 (`fredo.tool.*` / `fredo.llm`;
providers `fredo-opencode-plugin` / `opencode-go`; transport `otlp_grpc`; status `OK`). Console
clean — only the pre-existing `motion() is deprecated` + `ghostty-vt` unimplemented-mode warnings.
Env note: a persisted non-default keymap (test residue) binds the cheat sheet to `@leader ?`
(leader = Space), so F-D opened it with that chord (not bare `?`); all #2958 bindings
(`primary+K`, `y`) were the shipped defaults.

- **F-33 / R-1 — PASS.** At the base context bare `y` is inert (`defaultPrevented=false`, no
  announcer change, context unchanged) although `y` is bound deeper; after `primary+K` descends to
  `fredo.root.reference` the SAME `y` runs `fredo.context.referenceAction` (shared announcer →
  `Reference action ran.`; consumed=true). The level in force decides.
- **F-34 / R-2 — PASS.** `primary+K` → `data-fredo-hotkey-context="fredo.root.reference"`,
  `data-fredo-hotkey-context-depth="2"`, indicator label `Reference`, 2 pips; deeper-only `y`
  runs; re-invoking `primary+K` is idempotent (depth stays 2, no new announcement).
- **F-35 / F-36 / R-3 + R-6 — PASS.** One Escape pops exactly one descent (2→1) and restores the
  base; announcement `Back to <label>. Top level.`; at depth 1 a further Escape is NOT consumed
  (`defaultPrevented=false`), no `context:changed`. R-6.1 N≥1 satisfied (the shipped tree offers
  one explicit descent).
- **F-37 / R-5 — PASS.** `y` is bound only in `fredo.root.reference`; at the base it performs no
  action and never falls through. `primary+K` stays resolvable while descended (ancestor/base
  bindings remain in force). Row note: single shipped deeper context — the sibling-context matrix
  is covered by the resolver rule, not a second live feature context.
- **F-38 / R-4 — PASS.** Indicator render: `hotkeys-context-indicator` with icon
  (`hotkeys-context-indicator-icon`, `data-direction="enter"|"back"`), label
  (`hotkeys-context-indicator-label` = `Reference`/`terminal`) and depth pips
  (`hotkeys-context-indicator-depth` `data-depth` + N `hotkeys-context-indicator-pip`); root is
  `aria-hidden="true"` and declares NO `aria-live`.
- **F-39 / R-4.2 — PASS.** `[data-testid="hotkeys-announcer"]` (`role="status"`,
  `aria-live="polite"`, `aria-label="Hotkey sequence help"`) text transitioned
  `Entered setup. Level 1.` → `Entered Reference. Level 2.` → `Back to setup. Top level.` →
  `Reference action ran.` No second live region added by the context model (the other `aria-live`
  nodes are pre-existing app regions).
- **F-40 / R-2.2 — PASS.** Descended; focus moved to a real `<button>` and back (depth stayed 2);
  `y` still resolved (consumed=true) after the churn.
- **F-41 — PASS.** 5 identical enter/leave/unwind cycles: enter 0–0.2 ms (synchronous, ≪100 ms),
  depth sequence 1→2→1 each cycle, no drift.
- **F-42 — PASS.** Text-entry: Escape does not unwind (depth unchanged); descended + text-entry:
  Escape still does not unwind (depth stays 2). Modal/terminal covered by F-D/F-E.
- **F-43 / R-3.3 — PASS.** Descended (depth 2), `g` arms `data-fredo-pending-sequence="g"`;
  Escape clears pending with context UNCHANGED (depth 2); the next clean Escape pops one level.
- **G-220 F-A..F-E — PASS.** F-A pending-cancel (base + descended); F-B base Escape not consumed;
  F-C `<button>` Space → native-consumer passthrough (not consumed; harness: driver synthetic
  events don't synthesise browser default activation); F-D cheat sheet closed by its own handler
  with NO unwind (base + descended); F-E terminal root focused → `data-fredo-passthrough="true"`,
  Escape not consumed, real key `x` reached the PTY (buffer 279→288, `ESC[93mxESC[m`).

---

## #2959 testing round 3 — result (served spec/2959 @ 0ead7b0)

**Verdict: PASS (9/9 plan rows: REQ-1..5 PASS, NFR-1/3/4 PASS; NFR-2 UNVERIFIED with a
named pin-only blocker; REQ-5 empty-context leg = pre-authorised named blocker).**
Driven live (dev-env UP `-Spec 2959`, driver `com.fredo.app`, main window). Live receipt: 180
`telemetry_spans` in the drive window 2026-09-27 02:55:34 → 03:05:54 (`otlp_grpc`). Console clean.
Round-3 focus (F-5) is PASS — the REQ-5 regression is closed.

- **REQ-1 PASS.** `ctrl+shift+f8` enters (mode `"true"`, count 23, bar `{0,917,1920,34}`,
  `aria-hidden`, `pointer-events:none`, non-colour channels: `Keyboard` word + icon + strip +
  exit chip + pip); exit clears mode/count/bar and restores `activeElement` (BODY).
- **REQ-2 / F-45 / F-53 PASS.** `fredo.root.reference` 1920×1080 → total 24, visible 2,
  `+22 more` (2+22=24), list `scrollWidth==clientWidth==1445`, `descendReference` visible &
  clear of the exit chip; 1280×800 → total 24, visible 1, `+23 more` (1+23=24), list `805==805`,
  `descendReference` visible. No silent clip.
- **REQ-3 / F-46 PASS.** `primary+K` → `fredo.root.reference`/2 (24 rows); one Escape →
  `setup`/1 (23 rows); launcher **Mission Monitor** tile → `mission-monitor`/1 (26 rows incl.
  S/N/P). Mode stayed ON throughout (no re-entry); announcer updated each change.
- **REQ-4 / F-47 PASS.** 0 focusables, `Tab` leaves `activeElement` BODY, `elementFromPoint`
  at the bar centre is outside, ONE announcer (`role=status`/`aria-live=polite`), keep-out vs
  `app-dock` (**#2954 rebind:** the dock is REMOVED — the keep-out is re-bound to the engaged-launcher
  open-apps row `launcher-open-apps`; assert no intersection at 1920×1080 AND 1280×800) = no
  intersection at 1920×1080 AND 1280×800; light + dark legible.
- **REQ-5 / F-48 / F-54 PASS (the round-2 FAIL is fixed).** On the live text-entry lever the
  reason `Unavailable while typing` renders **24/24** chars (right `818` ≤ clip `824`) and the
  title is **130.5 px** (was 0). Safety half holds (non-focusable `DIV`; bare `y` runs nothing).
  Empty-context leg = named blocker (no shipped zero-binding context; residual pin).
- **NFR-1 PASS.** Entry 0.2 ms / descent 0.3 ms; 20 bare keys → 0 bar mutations.
- **NFR-2 / F-50 UNVERIFIED (named pin-only blocker):** live media `no-preference`; no
  media-emulation lever in the Tauri MCP driver. Residual pin: `KeyboardBar.test.tsx:521-526`.
- **NFR-3 / F-51 PASS.** Zero hex/rgb/hsl/`var()NN` in the hotkeys sources; live
  `light-default`→`dark` restyled the bar's computed colours with no code change.
- **NFR-4 / F-52 PASS.** Bar context/depth == engine context/depth at every step; 3 rapid
  descend/unwind cycles deterministic.

---

## Spec #2960 — typing-vs-navigating signal + zero-knowledge discovery on-ramp — **#3009 supersedes (OBSOLETE)**

> Live-plan extension for issue #2960 (S3 of the keyboard-first cluster; builds on the merged
> #2946 suppression, #2958 context model, #2959 keyboard mode + bar). Rows F-55..F-71 map 1:1 to
> the QA Plan in `.opencode/tmp/2960/triage.md` `## QA Expert` (`R-1..R-5` (AC1..AC5) +
> `NFR-1..NFR-5` + the E2E row). **REQ IDs and selectors are REALIGNED at convergence to the
> Architect's EARS IDs and the FINAL BINDING names block (panel form, G-255/G-187):** body hook
> `data-fredo-input-regime="typing"|"navigating"` (absent for `terminal`); signal testids
> `hotkeys-input-regime` / `-label` / `-mode` (no separate icon testid — the icon shape is asserted
> via the root); discovery `hotkeys-keys-discovery` (button) / `-panel` / `-list` / `-row` /
> `-mode-chord` / `-empty` / `-close` (non-modal panel listing `resolveActiveBindings()` + the
> pinned `KEYBOARD_MODE_CHORD` row); first-run `hotkeys-intro` / `-body` / `-dismiss` (AppStore key
> `fredo.hotkeys.introSeen`); the ONE shipped announcer `[data-testid="hotkeys-announcer"]` carries
> every announcement.
> **Out of scope (must not be re-specced):** S1 context model, S2 entry chord/bar, S4 per-app
> action sets, S5 deep nesting; #2946 text-entry suppression (only its signalling is new).
>
> **Verification policy: live.** Every row carries the DOM/a11y/measured-rect/screenshot assertion
> PLUS a `telemetry_spans` live receipt from a sanctioned span-producing lever in the drive window
> (an active companion generation — the CLI `fredo emit` path writes no spans, G-256). **Live read
> lever (G-284 disclosure):** the app boots on the PostgreSQL-default path, so read `telemetry_spans`
> via the managed `psql` (db `postgres`, URI from `pg_supervisor_status`, password from the
> `postgres.password` AppStore key) through the allowlisted `run-exitcode.ps1 -Command` wrapper —
> NOT the SQLite `telemetry-query` skill. A static-only PASS fails closed. G-263: every live leg is
> bounded; a reproducer that wrote its artifact but does not exit is killed, never waited on.

## F-55 (R-1 / AC1) — Typing is stated

- [ ] F-55: Focus a text field (`TEXTAREA[data-testid="launcher-command-input"]`, a Settings input,
      a Mission Monitor filter input, a `contenteditable`); read the regime signal. **Expected:** the
      signal reads "typing" and states that letters are text / navigation keys inactive; the state is
      NOT colour-only (a text label and an icon shape carry it); the change is announced through the
      ONE `hotkeys-announcer`. **Data:** `data-fredo-input-regime`, `hotkeys-input-regime-label` text,
      the `hotkeys-input-regime` root's icon-shape channel, announcer textContent. *(live receipt)*
  - **Edge:** input / textarea / contenteditable / SELECT / `role=textbox`; password field; first
    focus vs a move into the field.

## F-56 (R-1 / AC1, G-123 continuous) — Typing holds WHILE the field owns focus

- [ ] F-56: With the field still focused, wait past the sequence timeout, type several chars, move
      the caret/selection within the field, switch theme; re-sample the signal after EACH
      perturbation. **Expected:** the signal reads "typing" at every sample — it never flips to
      "navigating" while the field holds focus; `data-fredo-focus-context` stays `text-entry`; no
      re-announcement storm. **Data:** sampled regime + focus context + announcer after each step.
      *(live receipt)*
  - **Edge:** dwell > sequence timeout; caret move inside the field; theme switch; heavy streaming.

## F-57 (R-2 / AC2) — Navigating is stated

- [ ] F-57: From the resting desktop / a non-text focus (button, list) read the signal; then enter
      S2 keyboard mode (`ctrl+shift+f8`) and re-read. **Expected:** the signal reads "navigating" in
      both; it is visibly distinct from typing; with keyboard mode ON the signal still reads
      "navigating" and mode stays ON. **Data:** `data-fredo-input-regime`, `data-fredo-keyboard-mode`,
      signal label/icon. *(live receipt)*
  - **Edge:** default vs interactive focus; keyboard mode ON/OFF; terminal focused; modal open.

## F-58 (R-2 / AC2) — The two regimes are never ambiguous

- [ ] F-58: Render both states (typing + navigating) in one drive; compare label text, icon shape,
      and the body hook. **Expected:** the two states differ in non-colour channels (text label +
      icon shape) and are mutually exclusive — never both / never neither; `data-fredo-input-regime`
      is exactly one of `typing` / `navigating`. **Data:** label text + icon + hook for each state.
      *(live receipt)*
  - **Edge:** rapid alternation; the transition frame carries no blank/indeterminate state; light +
    dark.

## F-59 (R-3 / AC3) — Honest field→non-field move

- [ ] F-59: Focus a field (typing), then move focus to a non-field (button / body) by keyboard.
      **Expected:** the signal updates to "navigating" immediately (≤1 frame) and deterministically;
      the signal and `data-fredo-focus-context` agree. **Data:** `document.activeElement` + regime +
      focus context before/after; repeat N× identical cycles. *(live receipt)*
  - **Edge:** Tab out; focus a button; focus body; window switch; repeated identical cycles.

## F-60 (R-3 / AC3) — Honest field→field move

- [ ] F-60: Focus field A, then move directly to field B (Tab / click). **Expected:** the signal
      stays "typing" throughout and reports the current owner honestly; it never flickers to
      "navigating" between the two fields. **Data:** regime sampled at each step; `activeElement`.
      *(live receipt)*
  - **Edge:** two adjacent fields; Tab forward/back; click between fields; field A unmounts as focus
    leaves it.

## F-61 (R-1/R-2/R-3 / complex scenario) — The AC's complex scenario

- [ ] F-61: Given focus inside a text field and signal "typing"; type a character bound to a
      navigation action (e.g. `g`, `s`, `?`); then move focus to a non-field and press the same
      character. **Expected:** while typing the char is entered as text, no navigation action runs,
      and the signal continues to read "typing"; after the move the signal reads "navigating" and
      the same char runs its action exactly once. **Data:** field value + action-effect counter +
      regime after each step. *(live receipt)*
  - **Edge:** char = `g` (`g g`), `s` (feature), `?`; move by Tab vs click; repeat with a second
    field.

## F-62 (R-4 / AC4) — Zero-knowledge discovery affordance is always present

- [ ] F-62: On first paint, with NO chord pressed and no prior knowledge, locate the discovery
      affordance. **Expected:** a persistent affordance is rendered on the resting desktop AND in
      every focus state; it is visible without hover/focus; it never blocks the app (no modal trap,
      no keystroke interception). **Data:** `hotkeys-keys-discovery` presence + rendered rect;
      pointer/keydown interception counter. *(live receipt)*
  - **Edge:** cold boot; after dismissing the first-run hint; typing vs navigating; modal/terminal
    focus.

## F-63 (R-4 / AC4) — Discovery reveals the current context's keys

- [ ] F-63: Activate the affordance by keyboard alone (no mouse) and by click. **Expected:** the
      current context's keys (or the documented route to them / to keyboard-mode entry) are revealed;
      the affordance needs no prior chord knowledge; keyboard activation works; closing it returns
      focus to the invoker. **Data:** `hotkeys-keys-discovery-panel` content; `activeElement` before/after;
      focus context. *(live receipt)*
  - **Edge:** keyboard-only activation; mouse activation; a context with few/no keys; keyboard mode
    already ON.

## F-64 (R-5 / AC5) — First-run intro: non-modal, once, dismissible, never blocks

- [ ] F-64: On a fresh profile (flag cleared) boot the app; dismiss the hint; fully restart. 
      **Expected:** the hint is non-modal (no focus trap; the app is usable with it present);
      dismissible without a mouse; announced accessibly; shown at most once; after dismissal it never
      reappears across a full restart. **Data:** `hotkeys-intro` presence,
      `hotkeys-intro-dismiss`, `fredo.hotkeys.introSeen`, announcer text. *(live
      receipt)*
  - **Edge:** dismiss by keyboard; dismiss by click; full restart; cleared-storage fresh state;
    reduced motion.

## F-65 (R-5 / AC5, G-170) — The typing affordance does not compete with the field

- [ ] F-65: Focus a field with the discovery affordance present; measure the field's resting rect vs
      the affordance's resting rect. **Expected:** the affordance is present but does NOT overlay or
      cover the field or its caret area: the field element is rendered and its rect has ZERO overlap
      with the affordance's RESTING box; the field stays the focused editable surface. **Data:**
      `getBoundingClientRect()` of the field and the affordance; `activeElement`. *(live receipt)*
  - **Edge:** long/multiline textarea; narrow viewport; zoom; affordance in typing vs navigating;
    field first-open vs persisted-content state (G-253).

## F-66 (NFR-1 / a11y) — Announced + non-colour-only + mouse-free dismiss + reduced motion

- [ ] F-66: Read the accessibility tree + announcer across regime changes and first-run dismissal;
      set reduced motion. **Expected:** every regime change is announced via the ONE polite region
      (`role=status aria-live=polite`); the signal is non-colour-only; the hint and affordance are
      keyboard-dismissible/activatable; with reduced motion transitions are instant but functional.
      **Data:** announcer text; a11y snapshot; computed transition props. *(live receipt)*
  - **Edge:** both themes; screen-reader names; reduced motion on/off; same-state re-fire does not
    re-announce stale text.

## F-67 (NFR-2 / typing safety) — No new capture of typed text

- [ ] F-67: Type into each text-entry kind with the affordance present; inject a capture-phase
      keydown counter. **Expected:** every typed char reaches the field verbatim; the
      affordance/interception layer performs no `preventDefault`/capture; the #2946 suppression is
      preserved; no new handler captures typed text. **Data:** field value; capture-phase counter.
      *(live receipt)*
  - **Edge:** input / textarea / contenteditable / password; IME composition; affordance focused vs
    field focused.

## F-68 (NFR-3 / latency) — No perceptible latency / no re-render storm

- [ ] F-68: Instrument keydown→signal-update and keydown→field-echo timestamps; count renders.
      **Expected:** the signal update lands ≤1 frame after the focus change; a bare keystroke in a
      field is never delayed; no `Maximum update depth exceeded`; no per-keystroke re-render storm.
      **Data:** timestamp deltas; render counts; console. *(live receipt)*
  - **Edge:** heavy streaming; rapid focus churn; rapid regime alternation.

## F-69 (NFR-4 / theme) — Token/CSS-var hygiene + legibility

- [ ] F-69: Static grep of the new files + a live light/dark/accent pass. **Expected:** zero
      hardcoded hex/rgba/hsla and zero `var(--x)NN` alpha-append; colours from theme tokens / CSS
      vars / `tint()`; signal + affordance + hint legible in light AND dark. **Data:** grep output;
      light/dark/accent screenshots; computed colours. *(live receipt)*
  - **Edge:** both shipped themes; accent change; narrow/zoomed viewport; contrast floor per G-235
    (two-tier gate — see the plan's non-functional checks).

## F-70 (NFR-5 / reliability) — The signal never disagrees with the engine

- [ ] F-70: Drive typing↔navigating transitions incl. mode toggle, context descent, and focus
      churn; after EACH step compare the signal/body hook against the engine
      (`data-fredo-focus-context`, `getHotkeyContextSnapshot()`). **Expected:** the signal ALWAYS
      equals the engine's current context-derived regime — no stale/duplicate state, deterministic
      across identical cycles. **Data:** per-step regime + engine context/depth. *(live receipt)*
  - **Edge:** mode ON + field; modal; terminal; rapid alternation; owning window closes.

## F-71 (E2E, human directive — REQUIRED) — Mission-Monitor E2E on the PostgreSQL-default boot path

- [ ] F-71: Boot the app on the default path; open Mission Monitor; drive a live session. **Expected:**
      the app boots and Mission Monitor renders the live session(s) sourced from the RTDB row
      pipeline; the drive window carries a `telemetry_spans` receipt read via the managed `psql`
      lever. **Data:** `telemetry_spans` rows (db `postgres`, via `run-exitcode.ps1 -Command`); the
      Mission Monitor live-session DOM. *(live receipt)*
  - **Edge:** cold boot; G-280 orphan `postgres.exe`/stale socket (clear via a full dev-env
    Down → Up and report — environment artifact, NOT a spec FAIL); zero-live-session initial state
    (G-265: start from the pre-feature state and assert the trigger is reachable there).

---

## Spec #2961 — per-app contextual actions (S4 of the keyboard-first cluster) — **#3009 supersedes (OBSOLETE)**

> Live-plan extension for issue #2961 (S4 of 5; builds on the merged #2958 contexts,
> #2959 keyboard mode + bar, #2960 typing-vs-navigating). Rows F-72..F-87 map 1:1 to the
> QA Plan in `.opencode/tmp/2961/triage.md` `## QA Expert` (`R-1..R-5` = AC1..AC5 +
> `NFR-1..NFR-5` + the ST-4 G-123 continuous pin + the human-directive E2E row).
> **Names bind to the Architect's BINDING names block (G-187/G-255).** Named target apps
> (5 apps, 17 actions): `mission-monitor` (`s` focus session search, `n` next session,
> `p` previous session), `diagram` (`s` search diagram, `f` fit view), `my-workitems`
> (`r` refresh, `a` all sources, `z` Azure DevOps, `j` Jira), `optimizely` (`r` refresh,
> `s` focus search, `e` expand all, `c` collapse all), `dev-mode` (`s` focus filter,
> `c` clear events, `a` show all states, `v` switch rows/feature-data view). Declared-absence
> exemplars (must contribute 0 app rows): `docs-viewer`, `github-viewer`, `browser-preview`,
> `model-storage`, `setup`, `theming`, `query-viewer`, `terminal`. Reused DOM hooks:
> `[data-testid="hotkeys-keyboard-bar-row"]` carrying `data-hotkey-action="<actionId>"` +
> `data-availability="available|unavailable"`, `[data-testid="hotkeys-keyboard-bar-row-unavailable"]`,
> `[data-testid="hotkeys-keyboard-bar-empty"]`, body `data-fredo-hotkey-context` / `-depth`,
> `[data-testid="hotkeys-announcer"]`. NEW hooks: ST-1 `my-workitems-refresh`,
> `my-workitems-source-all`, `my-workitems-source-azdo`, `my-workitems-source-jira`; ST-2
> `optimizely-refresh`, `optimizely-search-input`, `optimizely-expand-all`,
> `optimizely-collapse-all`; ST-3 `dev-mode-filter-input`, `dev-mode-clear-events`,
> `dev-mode-show-all-states`, `dev-mode-view-toggle`. No new type/enum/command.
>
> **Verification policy: live** — every row carries the DOM/a11y/measured-rect/screenshot
> assertion PLUS a `telemetry_spans` live receipt from a sanctioned span-producing lever in the
> drive window (an active companion generation). **Live read lever (G-284):** the app boots on
> the PostgreSQL-default path, so read `telemetry_spans` via the managed `psql` (db `postgres`,
> URI from `pg_supervisor_status`) through `run-exitcode.ps1 -Command` — NOT the SQLite
> `telemetry-query` skill. A static-only PASS fails closed (G-033). G-263: every live leg is
> bounded.

## F-72 (R-1.1 / R-1.2 / AC1) — App-specific actions appear, and only the focused app's

- [ ] F-72: Focus each named app window (`mission-monitor`, `diagram`, `my-workitems`,
      `optimizely`, `dev-mode`) one at a time; enter keyboard mode (`ctrl+shift+f8`); read
      `[data-testid="hotkeys-keyboard-bar-row"]` + `data-hotkey-action` + `data-availability`.
      **Expected:** the bar lists that app's declared actions ALONGSIDE the platform/global rows;
      the app rows carry the EXACT action ids from the Names Block; NO other app's feature-tier
      rows are present. **Data:** per-app row histogram keyed by `data-hotkey-action`; mode hook;
      screenshot. *(live receipt)*
  - **Edge:** focused app window but mode OFF (no bar); two app windows open → only the focused
    one contributes; cold boot. **Lever:** launcher tile / window focus + `ctrl+shift+f8`.

## F-73 (R-1.3 / AC1) — Focus A→B replaces app rows deterministically

- [ ] F-73: Focus app A, sample rows; focus app B by keyboard only, re-sample; repeat A→B→A ≥3
      cycles. **Expected:** A's app-specific rows are REPLACED by B's deterministically;
      identical focus + keymap ⇒ identical row set each cycle; no stale A rows. **Data:** row sets
      per cycle. *(live receipt)*
  - **Edge:** rapid A↔B churn; A (mode ON) → B; window closed mid-switch. **Lever:** keyboard
    focus switch (Ctrl+Tab / `g g` / launcher).

## F-74 (R-2.1 / AC2) — A declared key runs the action with zero pointer

- [ ] F-74: For each named app, with that app focused + mode ON, press each declared bare key via
      `tauri_webview_keyboard`; inject a capture-phase pointer counter. **Expected:** the app's
      action runs; ZERO `mousedown`/`click`/`pointerdown`; console clean. **Data:** action-effect
      assertion + pointer counter. *(live receipt)*
  - **Edge:** bare key with `default` vs `interactive` focus; key with mode OFF (inert); repeat
    each key 2×. **Lever:** `tauri_webview_keyboard` + pointer counter.

## F-75 (R-2.2 / AC2) — Each action performs the app's EXISTING core operation

- [ ] F-75: After each F-74 press assert the app's real operation: MM `s` focus session search /
      `n`,`p` move selection; Diagram `s` search / `f` fit; My Work Items `r` refresh / `a`,`z`,`j`
      source filter; Feature Flags `r` refetch / `s` focus search / `e` expand all / `c` collapse
      all; Dev Mode `s` focus filter / `c` clear events / `a` show all states / `v` view toggle.
      **Expected:** each key performs the app's REAL existing operation (observable DOM/state
      change), never a stub, never a new in-app navigation engine. **Data:** the operation's DOM
      effect. *(live receipt)*
  - **Edge:** action with no effect in current state (→ F-80); long list; streaming.

## F-76 (R-3.1 / AC3) — Contextual reuse: only the focused app's action runs

- [ ] F-76: Press `s` while `mission-monitor`, then `optimizely`, then `dev-mode` focused; repeat
      `r` (`my-workitems` vs `optimizely`), `c` (`optimizely` vs `dev-mode`), `a` (`my-workitems`
      vs `dev-mode`). **Expected:** only the FOCUSED app's action for that key runs; the other
      app's action never runs. **Data:** action-effect counter per app. *(live receipt)*
  - **Edge:** same key in two apps; focus switch mid-press; mode OFF. **Lever:** keyboard focus
    switch + the shared key.

## F-77 (R-3.2 / AC3) — The bar names each key's current meaning + the app context

- [ ] F-77: With a named app focused + mode ON, read each row's title text, its key, and the app
      context title. **Expected:** each row renders the action TITLE next to its KEY and the app
      context title is visible, so the same key's current meaning is named where visible — never
      silent. **Data:** row text + key + `data-fredo-hotkey-context`; screenshot. *(live receipt)*
  - **Edge:** two apps with the same key; overflow (`+N more`) still names the app context;
    narrow viewport (no clip; app rows sorted first and never dropped).

## F-78 (R-3.3 / AC3) — Context + action digest announced via the ONE live region

- [ ] F-78: Enter mode and switch the focused app; sample `[data-testid="hotkeys-announcer"]`
      after each change. **Expected:** the app context + its action digest is announced through the
      ONE shared polite live region (`role=status`, `aria-live=polite`); no second live region; not
      colour-only. **Data:** announcer textContent; a11y snapshot. *(live receipt)*
  - **Edge:** entry announcement; focus change; same-app re-fire (no stale re-announce).
    **Lever:** mode entry + keyboard focus switch.

## F-79 (R-4.1 / AC4) — Graceful absence: an app declaring nothing contributes none

- [ ] F-79: Focus `docs-viewer` (then `github-viewer`) + mode ON; read the bar. **Expected:** only
      global/platform rows render; NO app-specific row, NO separator / placeholder / empty-state
      artifact. **Data:** row histogram (global-only); absence of any feature-tier row. *(live receipt)*
  - **Edge:** each declared-absence exemplar (`docs-viewer`, `github-viewer`, `browser-preview`,
    `model-storage`, `setup`, `theming`, `query-viewer`, `terminal`); switch from a named app to an
    absence app. **Lever:** launcher tile focus to the absence app.

## F-80 (R-5.1 / AC5) — State-gated actions are unavailable-with-reason, never dead

- [ ] F-80: Drive each gated action's `enabled()` FALSE and inspect the row: (a) `my-workitems.refresh`
      with `loading=true`; (b) `optimizely.collapseAll` with nothing expanded (initial state);
      (c) `dev-mode.clearEvents` with `eventCount=0`; (d) `dev-mode.showAllStates` with all states
      active. **Expected:** the row is `data-availability="unavailable"` with the declared reason
      (`Work items are still loading` / `Nothing is expanded` / `No events to clear` /
      `All states are already shown`) OR hidden by a DEFINED rule — NEVER actionable; pressing the
      key performs nothing. **Data:** row availability + reason text (Range-bisection) + activation
      attempt result. *(live receipt)*
  - **Edge:** flip available→unavailable→available live; all-unavailable; long reason fully
    readable; unavailable row non-focusable. **Lever:** drive `loading` / expand state /
    `eventCount` / `allStatesActive`.

## F-81 (R-5.2 / AC5) — Typing safety: a bare app key does not fire in a text field

- [ ] F-81: Focus a text field inside a named app (`dev-mode-filter-input`,
      `optimizely-search-input`, my-workitems search) and press that app's bare key (`r`, `s`,
      `c`); read the row + field value. **Expected:** the bare-key app action does NOT run; the
      character lands VERBATIM; the row shows `data-availability="unavailable"` with reason
      `Unavailable while typing`; `data-fredo-focus-context="text-entry"`. **Data:** field value +
      row state + focus context. *(live receipt)*
  - **Edge:** input / textarea / contenteditable / password; blur lifts suppression; terminal
    passthrough unchanged. **Lever:** focus the app's own text field.

## F-82 (R-5.3 / AC5) — Keyboard-only focus switch is deterministic and never runs the previous app's action

- [ ] F-82: Keyboard-only focus switch between two named apps (A→B) with mode ON; press A's key
      immediately after B gains focus; repeat N≥3 cycles. **Expected:** the bar updates
      deterministically to B's actions; A's action NEVER runs after the switch; identical cycles ⇒
      identical rows/selection. **Data:** row set + action-effect counter per cycle. *(live receipt)*
  - **Edge:** rapid churn; same key in both apps; switch while a sequence is pending; switch during
    streaming. **Lever:** Ctrl+Tab / `g g` / launcher (no pointer).

## F-83 (R-5.4 / AC5) — Action on a closed/unmounted app is a safe no-op

- [ ] F-83: With a named app's action registered, CLOSE that app's window (unmount), then invoke
      the action's dispatch path; read the console. **Expected:** safe no-op — no throw, no
      unhandled rejection, no console `Error:`; nothing else changes. **Data:** console log +
      absence of side effects. *(live receipt)*
  - **Edge:** close then dispatch the bridge event; window closed then reopened (action works
    again); dispatch for a never-mounted app. **Lever:** close the window (launcher/window control)
    + invoke the shipped `<featureId>-hotkey-action` dispatch from the webview.

## F-84 (G-123 / ST-4 continuous pin) — The app's action set is in force WHILE the app is focused

- [ ] F-84: Dwell in a named app with mode ON across the sequence timeout, a within-app focus move,
      and a theme switch; re-sample rows. Also confirm the ST-4 platform pins
      `appContextReuse.test.ts` + `appActionSafety.test.ts` are green. **Expected:** for the WHOLE
      time the app is focused the in-force action set is that app's (not re-derived only at the
      transition); the ST-4 pins pass (focus-scoping, availability, typing). **Data:** row set
      sampled after each perturbation; test-run output. *(live receipt)*
  - **Edge:** dwell > timeout; focus move; theme switch; two apps live in two windows; heavy
    streaming.

## F-85 (NFR-3 / NFR-5 / a11y + theme) — Reachable, announced, non-colour-only, token-hygienic

- [ ] F-85: Live focus/theme pass + static grep of the changed files. **Expected:** app actions are
      reachable + announced (bar text + the ONE announcer), NOT colour-only; ZERO hardcoded
      hex/rgba/hsla and ZERO `var(--x)NN` alpha-append in the changed files; legible in light AND
      dark; the bar stays `aria-hidden` / non-focusable. **Data:** grep output; light/dark
      screenshots; a11y snapshot. *(live receipt)*
  - **Edge:** both themes; accent change; narrow/zoomed viewport; contrast floor; screen-reader
    name on rows.

## F-86 (NFR-1 / NFR-2 / NFR-4) — Latency, typing safety, reliability

- [ ] F-86: Instrument keydown→effect timestamps for an app chord; count renders; drive the
      text-entry + closed-window paths. **Expected:** the app chord effect begins ≤100 ms after
      keydown; no per-keystroke re-render storm / no `Maximum update depth exceeded`; typing
      suppression holds; a closed-app action is a no-op; no unhandled rejection. **Data:** timestamp
      deltas; render counts; console. *(live receipt)*
  - **Edge:** under streaming; rapid repeats; large action set; text-entry + terminal. **Lever:**
    timestamp instrumentation + focus text field + close window.

## F-87 (E2E, human directive — REQUIRED) — Running-app end-to-end on the PostgreSQL-default boot path

- [ ] F-87: Boot the app on the PG-default path (dev-env Up); open Mission Monitor; drive a live
      session; enter keyboard mode in a named app and read its bar rows. **Expected:** (a) the app
      boots on the default path; (b) Mission Monitor still renders live sessions — the session list
      derives from the CURRENT backend-declared `sessions` rollup (`useSessionHistory.ts` →
      `useDeliverySessions`, backend `session_rollup.rs`; consumed by `MissionMonitorPanel.tsx`),
      NOT the retired `useEventRows('Chat'|'ToolUse', {replay})` path (G-299); (c) the keyboard
      action surface works (the named app's rows appear); the drive window carries a
      `telemetry_spans` receipt via the managed `psql` lever; console clean.
      **Data:** `telemetry_spans` rows (db `postgres`, via `run-exitcode.ps1 -Command`); the MM
      live-session DOM; the named app's bar rows. *(live receipt)*
  - **Edge:** cold boot; G-280 orphan `postgres.exe` / stale socket → full dev-env Down→Up then
    report (environment artifact, NOT a spec FAIL); zero-live-session initial state (G-265).
    **Seed lever (G-285):** the OTLP fixture MUST emit a rollup-QUALIFYING turn (a terminal chat
    span with a non-blank agent reply) so a declared `sessions` row is created; the fixture's
    ungated guard asserts the CONSUMER invariant (a `sessions` row renders), not merely fixture
    self-shape.

---

## #2961 testing round 1 — result (served spec/2961 @ b1234f44)

**Verdict: PASS (F-72..F-87 all PASS).** Driven live on the served app (dev-env UP
`-Spec 2961`, driver `com.fredo.app`, main window). Live `telemetry_spans` receipt via the
managed `psql` lever (db `postgres`, port 64217): 138 `fredo.llm` + 65
`fredo.tool.tauri_webview_execute_js` + 24 `fredo.tool.tauri_webview_keyboard` in the drive
window 2026-10-04T02:00–02:35Z (`otlp_grpc`); store total 3951. Console clean of product
errors (a ReactFlow `target.hasAttribute` error is a synthetic-document-keydown harness
artifact, `reactflow.js:3524`).

- **F-72/F-73 PASS.** Per-app bar **model** (`buildKeyboardBarModel` over
  `resolveActiveBindings`) carries the exact Names-Block ids per focused app, no cross-app
  rows; focus A↔B replaces rows deterministically over 3 cycles (0 stale rows). The shipped
  #2959 bar DOM renders `capacity`=2 rows at 1920 px + the accepted `+N more` chip, so the
  visible DOM shows `fredo.context.descendReference` + the first app row; the full declared
  set is in the model (context-scoped first). Observation, not a declaration defect.
- **F-74/F-75/F-76 PASS.** Zero pointer events on every key; `my-workitems` `z`/`j`/`a`
  change the source tab, `r` dispatches `my-workitems-hotkey-action` once; `optimizely` `s`
  → `optimizely-search-input`; `dev-mode` `s`→filter, `v`→view toggle; `mission-monitor`
  `s`→session filter, `n`→session selection; `diagram` `s`→`diagram-search-input`.
- **F-77/F-78 PASS.** Rows render keycap + title; `data-fredo-hotkey-context` names the app;
  the ONE `hotkeys-announcer` (`role=status`, `aria-live=polite`) announces the context +
  digest on every focus change.
- **F-79 PASS.** `docs-viewer`/`github-viewer` contribute 0 app rows; no empty/placeholder
  artifact (the `|` separator renders because the shipped `descendReference` is itself
  context-scoped).
- **F-80 PASS.** `optimizely.collapseAll`=`Nothing is expanded`, `dev-mode.clearEvents`=
  `No events to clear`, `dev-mode.showAllStates`=`All states are already shown` (live
  unavailable-with-reason); pressing an unavailable key dispatches nothing. `my-workitems`
  `refresh` loading gate is declared + unit-pinned but not live-observable without
  azdo/jira credentials (named lever limit).
- **F-81 PASS.** Typing in `dev-mode-filter-input` lands verbatim, action suppressed, row
  `unavailable`/`Unavailable while typing`, `data-fredo-focus-context="text-entry"`.
- **F-82/F-83/F-84 PASS.** Keyboard focus switch deterministic; closed `dev-mode` dispatch
  is a safe no-op; 3 s dwell + within-app focus move keep the app's action set in force;
  `appContextReuse.test.ts` (6) + `appActionSafety.test.ts` (5) green.
- **F-85/F-86 PASS.** #2961-added lines introduce zero hex/rgba/`var(--x)NN`; app actions
  announced + non-colour-only; keydown→effect **13.7 ms** (≤100 ms).
- **F-87 PASS.** App boots on the PG-default path; MM SESSIONS list matches the 7
  `feature_mission_monitor_sessions` rollup rows (current declared `sessions` rollup, not
  the retired `useEventRows` path); the drive window produced qualifying `chat_rows`
  (provider `open_code`, non-blank replies); MM bar shows `mission-monitor` + `S Focus
  session search`; live `telemetry_spans` receipt via the managed `psql` lever.

---

## Spec #2962 — deep nested contexts + intentional key reuse (S5 of the keyboard-first cluster) — **#3009 supersedes (OBSOLETE)**

> Live-plan extension for issue #2962 (S5 of 5; builds on the merged #2958 contexts, #2959
> keyboard mode + bar, #2960 typing-vs-navigating, #2961 per-app actions). Rows F-88..F-94 map
> 1:1 to the QA Plan in `.opencode/tmp/2962/triage.md` `## QA Expert` (`R-1..R-5` = AC1..AC5 +
> the NFR row + the human-directive E2E row). **Names bind to the Architect's BINDING block
> (G-255).** Demonstration flow (decided): Mission Monitor, 3 levels —
> `mission-monitor` (base title renders as the raw id; "Sessions" is a human label only) → `mission-monitor.graph` (Graph) → `mission-monitor.detail`
> (Node detail); keys `n`/`p`/`o` intentionally reused at every level. Max supported depth = 4
> levels (base + 3 descents); the runtime cap `MAX_CONTEXT_STACK_FRAMES = 8` is unchanged
> (`contextStack.ts:50`). Action ids: `mission-monitor.openGraph` (L1 `o`, opens GRAPH),
> `mission-monitor.nextNode`/`previousNode` (L2 `n`/`p`), `mission-monitor.openDetail` (L2 `o`,
> opens DETAIL), `mission-monitor.nextSection`/`previousSection`/`toggleSection` (L3 `n`/`p`/`o`).
> Reused DOM hooks: body `data-fredo-hotkey-context` / `-depth`,
> `hotkeys-keyboard-bar-context` (`data-depth`), `hotkeys-keyboard-bar-row`
> (`data-hotkey-action` / `data-availability`), `hotkeys-keyboard-bar-row-unavailable`,
> `hotkeys-context-indicator-label` / `-depth`, `[data-testid="hotkeys-announcer"]`,
> `[data-testid="detail-panel"]`. NEW (ST-3): `data-mm-graph-cursor` (L2 keyboard cursor),
> `data-mm-detail-section` / `data-mm-active-section` (L3). NEW (ST-1): the `Shadowed by`
> reason prefix (`SHADOWED_UNAVAILABLE_PREFIX`) on the losing parent binding.
>
> **Verification policy: live.** Every row carries the DOM/a11y/measured assertion PLUS a
> `telemetry_spans` live receipt from a sanctioned span-producing lever in the drive window.
> **Live read lever (G-284):** the app boots on the PostgreSQL-default path, so read
> `telemetry_spans` via the managed `psql` (db `postgres`, URI from `pg_supervisor_status`,
> password from the `postgres.password` AppStore key) through the allowlisted
> `run-exitcode.ps1 -Command` wrapper — NOT the SQLite `telemetry-query` skill. A static-only
> PASS fails closed (G-033). G-263: every live leg is bounded. The hotkeys layer emits no
> telemetry (PO Q13 / R-9), so the receipt proves the app was LIVE; the assertion is DOM-measured.
> **G-223:** the `## Tests Runs` draft carries the literal footer `*Authored by Tester*`; frames
> are named in prose without image extensions and `.png`/`.jpeg` tokens appear only on lines
> carrying an `https://` URL. Baseline lever (if a row needs before→after):
> `dev-env.ps1 -Action Up -Spec 2962 -At <pre-change-tip>`, restored to the tested tip afterwards.

## F-88 (R-1 / AC1) — Multi-level nesting: two descents, each changing the action set

- [x] F-88: **PASS (2026-10-04, spec/2962 @ e39dc7e).** Focus Mission Monitor + mode ON (`ctrl+shift+f8`). Descend the declared chain: press
      `o` at L1 → read; press `o` again at L2 → read. At each level read
      `data-fredo-hotkey-context` / `-depth`, `hotkeys-keyboard-bar-context` (`data-depth`), and
      the `data-hotkey-action` row histogram. **Expected:** L1 `mission-monitor` (base title
      renders as the raw id; "Sessions" is a human label only) →
      L2 `mission-monitor.graph` (Graph, depth 2) → L3 `mission-monitor.detail` (Node detail,
      depth 3); each descent enters the DECLARED direct child (`contextStack.ts:161-173`) and the
      resolved action set CHANGES — L1-only `openGraph`, L2-only `nextNode`/`previousNode` +
      `openDetail`, L3-only `nextSection`/`previousSection`/`toggleSection`; ≥1 action available
      at a deeper level is absent at its parent and vice versa (resolver orders feature bindings
      by context depth DESC, `contexts.ts:353`). Depth ≤ 4. **Data:** body hook + bar context +
      row histogram per level; `hotkeysContexts` declaration. *(live receipt)*
  - **Edge:** a third descent beyond the declared chain is refused (depth unchanged,
    `contextStack.ts:162-168`); descend while a text field is focused → suppressed
    (`sequence.ts:195-201`); mode OFF → context still enters (assert via body hook + indicator,
    bar absent); re-entering the same context id is a no-op (`contextStack.ts:166`).

## F-89 (R-2 / AC2) — Intentional key reuse + the current meaning is named

- [x] F-89: **PASS (2026-10-04, spec/2962 @ e39dc7e).** At each level press the reused keys `n`/`p`/`o`. At L2 assert `n` runs
      `mission-monitor.nextNode` (`data-mm-graph-cursor` changes) and NOT L1's `nextSession`; at
      L3 assert `n` runs `mission-monitor.nextSection` (`data-mm-active-section` changes). Read
      `hotkeys-keyboard-bar-context` text + `data-depth`, each row's keycap + action title, and
      the ONE `hotkeys-announcer`. **Expected:** the active (deepest) context's action runs and
      the parent's does NOT (`contexts.ts:353`; first-exact match `sequence.ts:65-88`); the
      current level is named where visible (bar context title + depth; each row names its key's
      current meaning) and the level is spoken through the shared polite region — with mode OFF
      `contextAnnouncement` (`contextStack.ts:257-265`), with mode ON the bar's mode-aware digest
      (`keyboardBarAnnouncement`, `keyboardBarModel.ts:309-315`); never colour-only. **Data:**
      per-level row set + titles; bar context text/`data-depth`; announcer textContent;
      `data-mm-graph-cursor` / `data-mm-active-section`. *(live receipt)*
  - **Edge:** reused key at all 3 levels (deepest wins); a key the child does NOT bind → parent
    stays in force (cumulative S1 contract, `contexts.test.ts:247-251`); key bound at current +
    parent; mode OFF naming via indicator + announcer; same-level re-fire does not re-announce
    stale text.

## F-90 (R-3 / AC3) — Full unwind: Escape pops exactly one level, no trap at any depth

- [x] F-90: **PASS (2026-10-04, spec/2962 @ e39dc7e).** Descend L1→L2→L3 (depth 3). Press Escape once and re-read the body hook/indicator;
      press again; press again at L1. After each pop re-fire the restored level's action (`n`).
      **Expected:** each Escape pops EXACTLY one level (`engine.ts:592-596` → `exitHotkeyContext`,
      `contextStack.ts:180-185`) — 3→2 restores `mission-monitor.graph` L2 actions; 2→1 restores
      `mission-monitor` L1 actions; at L1 Escape is NOT consumed by the context model
      (`canUnwindContext` armed only while depth > 1, `engine.ts:652`; branch `sequence.ts:212-219`);
      no depth traps Escape and no non-current level's action runs. **Data:** body hook/indicator
      depth after each press; re-fired action effect per level. *(live receipt)*
  - **Edge:** 2- and 3-level unwind; Escape with a pending sequence armed → pending-cancel wins
    with NO pop (`sequence.ts:228-238`, F-43/R-12); Escape in text-entry/modal/terminal → no
    unwind (`sequence.ts:176-201`); rapid repeated Escape (N=5) at L1 all left native.

## F-91 (R-4 / AC4) — Defined, observable precedence + the complex scenario

- [x] F-91: **PASS (2026-10-04, spec/2962 @ e39dc7e).** The AC's complex scenario — stand at L3 and press a key bound at the current level
      AND its parent (`n` at L3 = `nextSection`; `n` at L2 = `nextNode`). Read
      `data-hotkey-action` + `data-availability` and the `hotkeys-keyboard-bar-row-unavailable`
      reason for the losing level. Then Escape once and re-fire `n` (L2 binding now in force).
      **Expected:** the DEEPEST level wins (feature-tier depth DESC, `contexts.ts:353`) and is
      observable — the losing parent binding renders `data-availability="unavailable"` with
      reason `Shadowed by <winner title>` (`SHADOWED_UNAVAILABLE_PREFIX`, ST-1 `shadowingBinding`);
      no action from a non-current level runs for a key the active level binds (R-4.2); the
      action that ran is announced/named for ITS level; a parent-only key (e.g. `s` at L1, or
      `primary+K`) still resolves while descended (cumulative S1 contract,
      `contexts.test.ts:247-251`). **Data:** `data-hotkey-action`/`data-availability`; the
      unavailable-reason text; action-effect counter; announcer. *(live receipt)*
  - **Edge:** key bound at all 3 levels → L3 wins; parent-only key while descended still works
    (cumulative); current binding unavailable (typing) → precedence still deepest with the
    declared reason; `shadowingBinding` returns null when no earlier deeper binding shares the
    `serialized` → no false `Shadowed by`; two keys with the same sequence but different ids.

## F-92 (R-5 / AC5) — Stale-state discard on focus change / window close; same-focus preserves

- [x] F-92: **PASS (2026-10-04, spec/2962 @ e39dc7e).** Descend to L3. (a) **Focus-change lever:** focus a second feature window by keyboard
      (Ctrl+Space → launcher tile → Enter, or `g g`), then re-focus Mission Monitor. (b)
      **Window-close lever:** activate the Mission Monitor close control
      `aria-label="Close Mission Monitor"` (`WindowChrome.tsx:228`;
      `workspace-pane-close-<id>` `WorkspacePane.tsx:594-595` → `closeWindow` `WindowFrame.tsx:229-230`),
      then re-open Mission Monitor. (c) Re-run a no-op same-focus sync. **Expected:** (a)/(b)
      while nested, a focused-feature change or the window close DISCARDS every explicit descent
      and re-derives the base (`applyFocus`, `contextStack.ts:189-197`; window-store subscription
      `:225-227`); re-entering starts at L1 `mission-monitor`, depth 1 — never a stale deeper
      level. (c) a same-focus sync PRESERVES the active descent (`contextStack.ts:191`). **Data:**
      body hook/depth before/after; the close control + `closeWindow`; `data-fredo-hotkey-context`. *(live receipt)*
  - **Edge:** focus A→B→A; close then reopen; close a DIFFERENT window while nested in MM;
    dev-env restart mid-descent (stack is transient module state → boots at base); no dangling
    context after close; rapid focus churn. **Lever (G-275/G-300):** the two levers named above
    are the in-repo induction levers; the 8-frame cap + direct-child refusal are unit-pinned
    (`contextStack.test.ts`) and marked **non-AC**.

## F-93 (NFR) — A11y + typing safety + latency + theme + determinism at every level

- [x] F-93: **PASS (2026-10-04, spec/2962 @ e39dc7e).** At EACH level: read the accessibility tree + announcer; focus a text field and press
      `n`/`p`/`o`; instrument keydown→effect; run N identical descend/unwind cycles; static-grep
      the changed files; render light + dark. **Expected:** the level is announced at every depth
      through the ONE polite region (`role=status`, `aria-live=polite`, `announcer.tsx:62-73`);
      no keyboard trap at any depth; the whole flow is mouse-free (zero
      `mousedown`/`click`/`pointerdown`); typing safety holds at each level (bare keys land
      VERBATIM, no action, no unwind, `data-fredo-focus-context="text-entry"`); keydown→effect
      ≤100 ms at every level (no growth vs the `primary+K` baseline); zero hardcoded hex/rgba/hsla
      and zero `var(--x)NN` alpha-append in the changed files (tokens/`tint()` only); N identical
      cycles → identical context id/depth + action (no drift); `MAX_CONTEXT_STACK_FRAMES=8`
      unchanged. **Data:** announcer text; a11y snapshot; pointer-event counter; field value;
      timestamp deltas; grep output; light/dark screenshots; console. *(live receipt)*
  - **Edge:** both shipped themes; accent change; narrow/zoomed viewport; heavy agent streaming;
    rapid cycles; pending sequence at depth; reduced motion; no `Maximum update depth
    exceeded`/`Uncaught`/`Error:` (AGENTS.md #523).

## F-94 (E2E, human directive — REQUIRED) — Running-app end-to-end on the PostgreSQL-default boot path

- [x] F-94: **PASS (2026-10-04, spec/2962 @ e39dc7e).** Boot the app on the PG-default path (`dev-env Up`); open Mission Monitor; drive a
      live session; descend twice (L1→L2→L3) keyboard-only; press a reused key (`n`/`p`/`o`) at
      each level; Escape unwind level-by-level back to L1. **Expected:** (a) the app boots on the
      PostgreSQL-default path; (b) Mission Monitor still renders live sessions — the session list
      derives from the CURRENT backend-declared `sessions` rollup (`useSessionHistory.ts` →
      `useDeliverySessions`, backend `session_rollup.rs`; consumed by `MissionMonitorPanel.tsx`),
      NOT the retired `useEventRows('Chat'|'ToolUse')` path (G-299); (c) the nested keyboard
      navigation works end-to-end (descend twice, reused key runs the current level's action,
      Escape unwinds exactly one level per press to L1); the drive window carries a
      `telemetry_spans` receipt via the managed `psql` lever; console clean. **Data:**
      `telemetry_spans` rows (db `postgres`, via `run-exitcode.ps1 -Command`); the MM live-session
      DOM; body context/depth at each step; bar rows. *(live receipt)*
  - **Edge:** cold boot; G-280 orphan `postgres.exe`/stale socket → full dev-env Down→Up then
    report (environment artifact, NOT a spec FAIL); zero-live-session initial state (G-265).
    **Seed lever (G-285):** the OTLP fixture MUST emit a rollup-QUALIFYING turn (a terminal chat
    span with a non-blank agent reply) so a declared `sessions` row is created; the fixture's
      ungated guard asserts the CONSUMER invariant (a `sessions` row renders).

## #2962 testing round 1 — results (spec/2962 @ e39dc7e)

Run on the served app (dev-env UP `-Spec 2962`, PG-default boot, driver `com.fredo.app`
on the scanned MCP port :9224). Live `telemetry_spans` receipt via the managed `psql`
lever (db `postgres`, port 52824; drive window 2026-10-04T04:40–05:30Z; 51
`tauri_webview_keyboard` + 90 `tauri_webview_execute_js` spans; store 4963, max
`ingested_at` 05:30:00Z). Console: one third-party ReactFlow `Uncaught` reproduced ONLY by
the tester's synthetic `document`-dispatched Escape events (harness artifact).

- [x] **F-88 PASS** — two descents `mission-monitor` (23 actions) → `mission-monitor.graph`
      / `Graph` depth 2 (26) → `mission-monitor.detail` / `Node detail` depth 3 (29); action
      sets change each level.
- [x] **F-89 PASS** — L2 `n`=nextNode (`data-mm-graph-cursor` `_4`→`_6`→`_8`, no DOM focus);
      L3 `n`=nextSection (overview→content), `p`=previousSection, `o`=toggleSection; each
      action announced for its level.
- [x] **F-90 PASS** — Escape 3→2→1, one level per press; L1 Escape native no-op; 5 identical
      cycles `1→2→3→2→1` no drift.
- [x] **F-91 PASS** — L2 `nextNode` renders unavailable `Shadowed by Next section` at L3;
      after one Escape `nextNode` is available and `n` moves the cursor.
- [x] **F-92 PASS** — focus change (`open-app settings`) and window close both discard to
      depth 1; same-focus sync preserves the descent.
- [x] **F-93 PASS** — ONE polite announcer (`role=status`, `aria-live=polite`); bar
      `aria-hidden`; typing `npo` verbatim; keydown→effect ~9.8 ms; zero colour literals /
      `var(--x)NN` in changed files; identical cycles; cap 8 unchanged.
- [x] **F-94 PASS** — PG-default boot; MM renders the declared `sessions` rollup
      (`useDeliverySessions`; `feature_mission_monitor_sessions` 7 rows == 7 DOM rows);
      keyboard-only nested nav end-to-end; live receipt.

---

## Spec #3009 — always-on element-declared hotkeys (replaces the configurable platform)

> Live-plan extension for issue #3009. The ENTIRE configurable-hotkeys platform
> (#2946/#2958/#2959/#2960/#2961/#2962) is REMOVED and replaced by an always-on,
> element-declared model. Rows **F-95..F-110** map 1:1 to the QA Plan in
> `.opencode/tmp/3009/triage.md` `## QA Expert` (`R-1.1..R-5.4` ↔ AC1..AC5 + NFR rows +
> the human-directive E2E row). Names bind to the Architect's BINDING NAMES BLOCK
> (G-187/G-255): grammar `data-hotkey` (`[a-z0-9]` + optional `+[a-z0-9]`) /
> `data-hotkey-label`; body hooks `data-fredo-hotkey-count` /
> `data-fredo-hotkeys-disabled` / `data-fredo-hotkey-duplicate`; bar
> `hotkeys-keybar` / `-list` / `-row` (+ `data-hotkey-key` / `-action` / `-availability`) /
> `-pending`; `hotkeys-duplicate-error`; `hotkeyBarModel` (`rows` element-only, document
> order, `empty` at 0). **Storage unit = raw `data-hotkey` + serialized binding; display
> unit = Keycap label (`displayStroke`/`displaySequence`); disabled unit =
> `data-fredo-hotkeys-disabled="true"` ↔ row `data-hotkey-availability="disabled"`**
> (G-187 cross-check).
>
> **Verification policy: live** — every row carries the DOM/a11y/measured/screenshot
> assertion PLUS a `telemetry_spans` receipt from a sanctioned span-producing lever in the
> drive window (the hotkey layer itself emits no telemetry — R-4.1 / PO Q13). Receipt lever:
> `.opencode/skills/telemetry-query/telemetry-query.ps1`; when the app boots on the
> PostgreSQL-default path and the SQLite store is empty, read via the managed `psql` (db
> `postgres`, URI from `pg_supervisor_status`) through `run-exitcode.ps1 -Command` (G-284).
> **G-223:** the `## Tests Runs` draft ends with the literal footer `*Authored by Tester*`.
> **G-104:** frames are named in prose without image extensions; `.png`/`.jpeg` tokens appear
> only on lines that also carry an `https://` URL.
> **Error/edge levers (G-275/G-300/G-316):** typing → `TEXTAREA[data-testid=
> "launcher-command-input"]`; terminal → `spawn_terminal_session{cli:"shell"}` then focus;
> duplicate → inject a second `data-hotkey="a"` via `tauri_webview_execute_js` (or the ST-1
> `?hotkeyDupProbe=1`); zero-hotkey → a window with no `data-hotkey` element; invalid →
> `data-hotkey="!"` / `"A"`.

## F-95 (R-1.1 / AC1) — Bare key runs its element's action (no modifier)

- [ ] F-95: Load the served app (`dev-env.ps1 -Up -Spec 3009`). Locate the Mission Monitor
      session-search control carrying `data-hotkey="s"` (ST-5); give it a non-text focus
      (resting desktop). Press bare `s` via `tauri_webview_keyboard`. **Expected:** the
      element's action runs — the session-search control gains focus / the app's real
      operation runs — with NO modifier; the `keydown` is consumed; the `s` key is listed in
      the bar. **Data:** `document.activeElement` before/after; the action's DOM effect;
      `data-hotkey` attribute; bar row for `s`. *(live receipt)*
  - **Edge:** `default` vs `interactive` focus; uppercase `S` is inert (no match); repeat 2×
    (exactly one action per press); blurred resting desktop.

## F-96 (R-1.2 + R-2.1 + R-2.2 + R-2.5 / AC1+AC2) — Always-on bar aggregates app-wide

- [ ] F-96: With ≥1 `data-hotkey` element mounted, read the bar. Then open a second window
      that also mounts element hotkeys and re-read. Then open a window mounting ZERO
      `data-hotkey` elements (or unmount the last one) and re-read. **Expected:** the bar
      `hotkeys-keybar` renders app-wide with `role="region"` and `aria-label="Available
      hotkeys"`; `hotkeys-keybar-row` = EVERY mounted element key in DOCUMENT order,
      element-only (never a pinned global); `data-fredo-hotkey-count` = N; at 0 elements the
      bar renders nothing (hidden) and the count is `0`. **Data:** bar presence/rect;
      `hotkeys-keybar-row[data-hotkey-key]` list; `data-fredo-hotkey-count`. *(live receipt)*
  - **Edge:** 1 vs many elements; aggregation across two windows; document-order stability
    across a re-mount; a pinned global never appears as a row; a window with no elements
    (Doom `?view=doom` is one such state).

## F-97 (R-2.3 + R-2.4 / AC2) — Disabled bar in text-entry + terminal; no fire

- [ ] F-97: Focus the typing lever `TEXTAREA[data-testid="launcher-command-input"]`; press an
      element's bare key and read the bar. Then `spawn_terminal_session{cli:"shell"}` and focus
      the session; press the same bare key and read the bar + the PTY buffer. **Expected:** the
      bar stays VISIBLE; every row is `data-hotkey-availability="disabled"`; the body hook
      `data-fredo-hotkeys-disabled="true"`; NO element hotkey fires; the typed character lands
      VERBATIM in the field and reaches the PTY. **Data:** row availability; body hook; field
      value / terminal buffer delta; `data-fredo-focus-context`. *(live receipt)*
  - **Edge:** input / textarea / contenteditable / password; blur lifts suppression; a window
    switch while suppressed; a modifier chord (`Ctrl+Space`) remains global in text-entry but is
    suppressed in the terminal (adjudication A1).

## F-98 (R-3.1 + R-3.2 / AC3) — Two-step `a+b` sequence + pending prefix

- [ ] F-98: Mount a control with `data-hotkey="a+b"` (inject via `tauri_webview_execute_js` if
      no shipped two-key control exists). Press `a`; sample. Press `b`. **Expected:** after `a`
      the bar's pending chip `hotkeys-keybar-pending` shows the prefix and
      `data-fredo-pending-sequence="a"`; after `b` the element's action runs exactly ONCE and
      pending clears (`data-fredo-pending-sequence` null). **Data:** pending chip text; body
      hook; action effect. *(live receipt)*
  - **Edge:** slow valid continuation still within the timeout; a prefix that is itself a
    complete binding; `Esc` during pending resets; focus change mid-sequence resets.

## F-99 (R-3.3 / AC3) — Invalid / abandoned sequence resets without acting

- [ ] F-99: Mount `data-hotkey="a+b"`. (i) Press `a`, then an invalid key `q`. (ii) Press `a`,
      then wait past the timeout. (iii) Press `a`, then change focus. **Expected:** NO action in
      ANY leg; the pending state resets visibly (`hotkeys-keybar-pending` clears;
      `data-fredo-pending-sequence` clears); the app returns to its prior state.
      **Data:** pending chip + body hook after each leg; action-effect counter. *(live receipt)*
  - **Edge:** invalid second key; timeout; focus change / window switch; Escape during pending
    resets and is consumed (does not act); a valid continuation after the timeout does not fire.

## F-100 (R-3.4 / AC3) — Duplicate key: dev error + body hook

- [ ] F-100: Inject a second `data-hotkey="a"` element via `tauri_webview_execute_js` (or the
      ST-1 dev-only `?hotkeyDupProbe=1`). **Expected:** `document.body[data-fredo-hotkey-duplicate=
      "true"]`; in DEV a `DuplicateHotkeyError` is thrown (console) and `hotkeys-duplicate-error`
      renders; the duplicate is surfaced, never a silent pick. **Data:** body hook; the DEV error
      banner + `tauri_read_logs(source="console", level="error")`; removed-duplicate recovery.
      *(live receipt)*
  - **Edge:** in PROD the error is logged once (no throw); two elements with the same `grammar.key`;
    recovery when the duplicate is removed (`data-fredo-hotkey-duplicate` clears).

## F-101 (R-1.3) — Invalid attribute excluded from dispatch + bar

- [ ] F-101: Seed `data-hotkey="!"` and `data-hotkey="A"` (grammar miss) via
      `tauri_webview_execute_js`. **Expected:** both are excluded from dispatch AND from the bar
      (no row); a dev diagnostic (`console.error`) is surfaced; `data-fredo-hotkey-count` excludes
      them. **Data:** bar rows; count; console. *(live receipt)*
  - **Edge:** empty value; `a+b+c` (3 steps — invalid); whitespace; `a++b`; `data-hotkey-label`
    present with no valid key; `a+b` (valid, for contrast).

## F-102 (R-4.1 + R-4.2 + R-4.3 + R-4.4 / AC4) — Config + cluster removed; palette via `>`

- [ ] F-102: Inspect the Settings surface and every window for a hotkey config affordance and
      the top-left cluster. Open the launcher and type `>`. **Expected:** NO Settings→Hotkeys nav
      item or surface; NO Vim preset / keymap editor / persistence / macros / contexts /
      keyboard-mode toggle; NO top-left regime/discovery/Keys/intro cluster in EVERY window (the
      Doom window is noted — #3007's scope); retired bindings (`Ctrl+Shift+P`, `?`, `g g`,
      `ctrl+shift+f8`) are inert; typing `>` in the launcher command bar opens the action palette.
      **Data:** Settings nav list + section DOM; per-window cluster testids
      (`hotkeys-input-regime`/`hotkeys-keys-discovery`/`hotkeys-intro` absent); palette DOM after
      `>`. *(live receipt)*
  - **Edge:** each window incl. Doom; `Ctrl+Shift+P` / `?` / `g g` / `ctrl+shift+f8` inert;
    palette reachable keyboard-only; a text field still accepts `>` as text.

## F-103 (R-5.1 + R-5.2 + R-5.3 + R-5.4 / AC5) — Kept globals; digits free

- [ ] F-103: Fire `Ctrl+Space` (resting desktop + text-entry + terminal), `Escape` (base + modal),
      `Ctrl+Tab` / `Ctrl+Shift+Tab` (≥2 windows), and `Ctrl+1..9`. **Expected:** `Ctrl+Space`
      opens+focuses the launcher (`TEXTAREA[data-testid="launcher-command-input"]`) and is
      suppressed ONLY under terminal passthrough (adjudication A1); `Escape` keeps native
      behaviour (base context is not consumed); `Ctrl+Tab`/`Ctrl+Shift+Tab` cycle window focus;
      `Ctrl+1..9` do NOT switch windows (digits are free for element hotkeys). **Data:**
      launcher presence/focus; `defaultPrevented`; `data-focused` window transitions; active
      window per digit. *(live receipt)*
  - **Edge:** `Ctrl+Space` in text-entry fires (modifier chord) vs terminal suppressed; modal
    Escape; each digit 1..9 inert; rapid double-press = one toggle.

## F-104 (Complex scenario / AC1+AC2+AC3) — Bare key + list + typing suppression together

- [ ] F-104: Give a non-text focus to a control carrying `data-hotkey="s"`; press `s` and read
      the bar. Then focus `TEXTAREA[data-testid="launcher-command-input"]` and press the SAME `s`.
      **Expected:** outside text-entry the action runs and the `s` row is present/available; with
      focus in the text field the character types verbatim, NO hotkey runs, and that row shows
      `data-hotkey-availability="disabled"`. **Data:** action effect; field value; row
      availability; body hooks. *(live receipt)*
  - **Edge:** a second key; move focus back out and re-fire; repeat; the terminal variant
    (`spawn_terminal_session{cli:"shell"}`).

## F-105 (NFR / no-second-resolver — static pin) — Exactly ONE dispatch listener

- [ ] F-105: Static audit of `apps/ui/src/shared/hotkeys/`: count `document.addEventListener('keydown'`
      and any second `dispatch`/action-table export. **Expected:** exactly ONE dispatch listener
      (the engine scope, `engine.ts:701`); the `traversal.ts:367` Tab listener is the only other,
      non-dispatch (documented); the registry holds ONE action table; no module exports a second
      `dispatch`. **Data:** grep output; the engine install-site citation. *(static pin — the one
    non-live leg; declared, not a manufactured live row)*
  - **Edge:** grep the whole `shared/hotkeys/` tree; the deleted `macros.ts` capture listener is
    gone (its row is removed with the macro subsystem).

## F-106 (NFR a11y) — Perceivable, non-focus-stealing, no aria-live chatter

- [ ] F-106: Read the accessibility tree + tab order; attempt Tab into and a click at the bar;
      sample the live regions across keypresses. **Expected:** the bar is a named
      `role="region"`, `pointerEvents:none`, has ZERO focusable descendants, and
      `document.activeElement` never changes because of the bar; the bar is NOT `aria-live`; the
      ONE shipped `hotkeys-announcer` remains the only polite channel (no chatter on keypresses);
      each row exposes `aria-label="<Key>: <title>"`. **Data:** a11y snapshot;
      `document.activeElement`; `elementFromPoint(barRect centre)`; announcer textContent.
      *(live receipt)*
  - **Edge:** screen-reader names; Tab past the bar; rapid keypresses produce no live-region
    spam; both shipped themes.

## F-107 (NFR theming + reduced-motion) — Token hygiene + reduced motion

- [ ] F-107: Static grep the new bar/model source files + a live light/dark/accent pass; set
      `prefers-reduced-motion: reduce` and enter/leave. **Expected:** ZERO hex/rgba/hsla and ZERO
      `var(--x)NN`; colours from theme tokens / CSS vars / `tint()`; the disabled pair reuses the
      shipped `fg.muted`/`bg.muted` (G-235 two-tier); under reduce, the bar's fade is
      instant/non-animated while fully functional. **Data:** grep output; light/dark/accent
      computed colours; computed transition props. *(live receipt)*
  - **Edge:** both shipped presets; accent change; reduced-motion on/off mid-transition; narrow/
    zoomed viewport.

## F-108 (NFR latency + loop + telemetry + CI) — Fast, loop-free, telemetry-free, green

- [ ] F-108: Instrument keydown→effect timestamps and render counts; diff `telemetry_spans` /
      `telemetry_metrics` names before vs after a hotkey drive; run the CI legs. **Expected:**
      keydown→effect ≤100 ms; NO `Maximum update depth exceeded` (bar recompute keys off the
      monotonic element-revision counter, never `.length`/fresh objects — AGENTS.md #523); NO
      span/metric carries shortcut usage or binding identity; `pnpm --filter @fredo/ui build`
      exit 0, `pnpm --filter @fredo/ui test:run` green, served `pnpm --filter @fredo/tauri
      build:webview` exit 0. **Data:** timestamp deltas; render counts; console; span/metric name
      diff; build/test output. *(live receipt for the latency/loop legs; CI output for the gate)*
  - **Edge:** heavy agent streaming; rapid keypresses; theme switch; duplicate probe present
    (still no loop).

## F-109 (E2E — human MISSION-MONITOR DIRECTIVE, REQUIRED) — Running app on the PostgreSQL-default boot path

- [ ] F-109: Boot the app on the PostgreSQL-default path (`dev-env Up -Spec 3009`); open Mission
      Monitor; drive a live session; fire a bare-key element hotkey; read the always-on bar.
      **Expected:** (a) the app boots on the PG-default path; (b) Mission Monitor still renders
      LIVE sessions — sourced from the CURRENT declared `sessions` rollup (`useSessionHistory.ts`
      → `useDeliverySessions`, backend `session_rollup.rs`, consumed by `MissionMonitorPanel.tsx`),
      NOT the retired `useEventRows('Chat'|'ToolUse')` path (G-299); (c) the always-on bar + the
      bare-key operation work end-to-end; the drive window carries a `telemetry_spans` receipt;
      console clean. **Data:** `telemetry_spans` rows (via `telemetry-query.ps1`, or the managed
      `psql`/`run-exitcode.ps1` fallback on the PG-default path); the MM live-session DOM; the
      bar rows. *(live receipt — MANDATORY)*
  - **Edge:** cold boot; G-280 orphan `postgres.exe`/stale socket → full dev-env Down→Up then
    report (environment artifact, NOT a spec FAIL); zero-live-session initial state (G-265: start
    from the pre-feature state and assert the trigger is reachable there). **Seed lever (G-285):**
    the OTLP fixture MUST emit a rollup-QUALIFYING turn (a terminal chat span with a non-blank
    agent reply) so a declared `sessions` row is created; the fixture's ungated guard asserts the
    CONSUMER invariant (a `sessions` row renders), not merely the fixture's own shape.

## F-110 (R-4.1 + R-4.2 + R-4.3 / AC4 — residual-sweep source pin, G-337) — No LIVE retired-symbol references survive in scope

- [ ] F-110: STATIC residual grep over the architect's G-337 grep scope — `docs/**`,
      `.opencode/skills/**`, `.opencode/tests/**`, `.opencode/scripts/**`, `apps/**`, `README*`,
      `CONTRIBUTING*` — for any LIVE reference to a retired runtime symbol / attribute / config
      mechanism: `VIM_PRESET` / `VIM_PRESET_SNAPSHOT_KEY`; keymap/persistence identifiers
      (`loadKeymap` / `saveKeymap` / `KEYMAP_STORAGE_KEY`); macro-recorder symbols;
      `resolveContextBindings` / `enterHotkeyContext` / `syncHotkeyContextFromFocus`;
      `BODY_KEYBOARD_MODE_ATTR`; the regime/discovery/first-run cluster components
      (`HotkeysCluster` / `InputRegimeIndicator` / `KeysDiscovery` / `KeyboardIntro`); which-key /
      cheat-sheet overlay identifiers; reserved combos. **Expected (DENY property — what MUST be
      flagged):** ZERO surviving non-comment LIVE import/usage of any retired symbol within scope;
      a surviving non-comment live import/usage is a FAIL. The ONLY tolerated hits are the EXPLICIT
      EXCLUSIONS — the `#3009 supersedes` / `#3009` annotations in `.opencode/tests/hotkeys/**`
      (EXPECTED by design — the suite marks superseded rows rather than deleting them) and
      issue-reference (`// #3009`) or historical/legacy comments that name the removal itself.
      Prefer REWORDING a residual comment over allowlisting it (G-330): only the expected
      supersede/issue-reference annotations are allowlisted. The **ST-6 (CU-3) sweep owns the
      fix.** **Data:** grep output per scope path, with the EXCLUSIONS annotated. *(static pin —
      declared non-live leg; NO live receipt)*
  - **Edge:** comment-only vs live import/usage; a reworded residual vs an allowlisted one (G-330);
    the excluded `#3009` supersede annotations in `.opencode/tests/hotkeys/**`; Doom-window
    references (#3007 scope, not flagged); a retired name appearing inside an allowlist literal
    (still flagged unless it names the removal itself).


