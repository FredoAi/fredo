# Order Loop — Functional

> **Spec #3243 — the placed order loop: a typed or spoken order about the placed application, carried
> out and answered; an in-flight order that survives a move and is not announced; a fresh placement per
> placement; the confirmation gate, undo, and the spoken reply.**
>
> **Verification policy: live** (the majority of ACs are runtime observables a user sees/hears). Rows
> tagged `[static]` are the plan's genuinely static halves — a source sweep, a closed-schema pin, a
> config/doc property — and are justified at their own row (`> why static:`).
>
> **Binding names are the Architect's `### Binding Names` block** (`R-nx` requirement ids are verbatim).
> No row drives a name the block does not own. **`requestCompanionComposerOpen` is RETIRED (#3151) and
> has no production caller** — no row drives it; the live opener is `useCompanion().openComposer()`,
> reached by the avatar click (the only pointer opener) or by the seat→overlay teleport settle.
>
> **The order field IS the shipped composer.** `[data-testid="fredo-companion-composer-input"]` is the
> "focused, empty order field"; `[data-testid="fredo-companion-composer-dismiss"]` is the "visible close
> control". A *placement* = that box open with a RESOLVED app target (chip ≠
> `No app in front of Fredo`).
>
> **Driving levers (never a fabricated payload):**
> - the shipped `llm-skill-call` channel — `tauri_ipc_emit_event`
>   `{skill:"order", arguments:{action, arguments}}` — the ONE skill channel;
> - **`FREDO_ORDER_SKILL_LEVER` + `FREDO_ORDER_SKILL_SCRIPT` + the `order_skill_lever_take` command**
>   (ST-8's committed seam) — the sanctioned in-repo producer of a changing/destructive action with no
>   model and no human click. **The lever is INERT unless armed**; an unarmed read is the control.
> - the composer's real submit path (type → `composer-submit`) for a real model turn (PATH-A).
>
> **Receipts:** the ticker (`fredo-order-ticker`) with `data-order-state` / `data-order-target-app`, the
> undo control (`fredo-order-undo`), the field's `data-order-capture`, the dialog's `data-order-undoable`,
> the five `fredo-order-confirmation*` testids, the reply surface (`fredo-reply-surface`) text, the ONE
> polite region (`fredo-companion-live-region`) text, `readCompanionSpeechReceipt()` + the platform's own
> `speechSynthesis.speaking`, the Wireframe document hooks (`data-wireframe-element-count`,
> `data-wireframe-selection-fill`, `data-wireframe-stacking`), and a `telemetry_spans` query for
> `event_type='companion.injection'` through the telemetry-query skill.
>
> **CONDITIONAL ON A G-324 ADJUDICATION (QA-D1 in the plan's `## Discussion`).** The `data-order-*` /
> `fredo-order-ticker` / `fredo-order-undo` hooks and `orderFlight` are the UI/UX Expert's **requests**, not
> yet in the Architect's `### Binding Names` block. **If accepted**, these rows run as written. **If
> declined**, the affected rows degrade as QA-D1 states — F-13/F-14 lose the chip-VS-ticker
> discriminator (making the overloaded-chip defect undetectable), and F-6/F-8/F-9/F-10 lose the ARMED
> state (weakening "no silent capture" to "no silent LIVE capture"). **The rows as written are the
> accepted-hook form; a decline must be recorded against them at convergence, not silently absorbed.**

---

## AC-1 — a typed order is carried out; the outcome is shown AND spoken; never silence

- [ ] **F-1 (R-1a) — a placed typed order about the placed app is carried out exactly once.**
  Place Fredo over Wireframe (teleport or avatar click until `fredo-companion-composer` has count 1 and
  the chip reads `for Wireframe`). Submit a typed order naming `wireframe.element.fill` on a selected
  shape. **Expected:** the shape's `data-wireframe-selection-fill` changes to the requested token; the
  **exactly one** history entry is confirmed by the app's own Undo restoring the previous token (F-33);
  `telemetry_spans` for `companion.injection` shows ONE row for the turn with the resolving
  `placementId`. **FAIL if:** two dispatches for one submit (two fills / two undo steps needed), or the
  document is unchanged, or the order runs in an app other than the chip's target.
  **Edge:** an order naming an action of an app that declares no order surface (⇒ F-27); a second
  submit immediately after the first.

- [ ] **F-2 (R-1b) — the reply comes from the ONE copy source and names the ACTION and the APP.**
  Same run as F-1. Read `fredo-reply-surface` and the ticker's text node. **Expected:** the settle
  sentence is the `orderReply.ts` text for the outcome and contains **both** the action label and the
  app name (e.g. `Filled Rectangle in Wireframe`); the ticker's DOM text node equals the reply
  surface's text **exactly** (CSS `lineClamp` may clip paint; the text node must carry the full
  sentence — a clipped/`aria-label`-truncated tree is a FAIL). **FAIL if:** the sentence is model prose,
  or names only the action (`Done` / `Filled`), or the ticker text differs from the reply by any
  character.
  **Edge:** the ticker on a 320 px card (clip paint, not text); a settle after the user returned to a
  DIFFERENT app (the sentence must still read as *this* order).

- [ ] **F-3 (R-1c) — the outcome is SPOKEN, bound to two INDEPENDENT observables.**
  `[static half + live half]` **Observable A (the seam's own receipt):** `readCompanionSpeechReceipt()`
  returns `{ text, seq }` whose `text` is byte-identical to the reply surface's rendered text, and the
  reply surface carries `data-companion-spoken` + `data-companion-speech-seq` matching that `seq`.
  **Observable B (the platform's own fact):** the webview's `speechSynthesis.speaking` is `true` at
  some sample during the utterance, or `onstart` fired for it. **Expected:** BOTH hold ⇒ the outcome is
  spoken. **FAIL if:** A holds and B never does (a seam that records text but never reaches the
  platform), **or** A and B disagree in text.
  **Named blocker (pre-authorised, Architect D-6 / UI/UX §7):** if this host exposes no usable platform
  voice, Observable B is unproducible — record `AC-1 spoken leg UNVERIFIED — no platform voice on this
  host` with the probe's output (`speechSynthesis.getVoices().length`, the `speaking` samples). That is
  **not a PASS and not a product defect**. A silently blank B with no probe recorded is a FAIL of the
  row, not a blocker.
  **Edge:** Doom Mode active ⇒ output suppressed ⇒ the live region (not speech) carries the sentence
  (F-16's channel table); a superseded utterance (F-4).

- [ ] **F-4 (R-1d) — exactly one outcome is being spoken at a time.**
  Trigger two order settles inside one utterance window (the second order submitted while the first is
  speaking). **Expected:** the first utterance is cancelled (`speechSynthesis.speaking` for it goes
  false / no overlap), and `readCompanionSpeechReceipt().seq` advanced exactly once per settle. **FAIL
  if:** two utterances overlap, or a queue plays a backlog of stale outcomes.
  **Edge:** a settle during the 15 s watchdog terminal error; rapid double submit.

- [ ] **F-5 (NFR-3) — exactly one completion per user order.**
  For one submit, count the settle sentences and the speech receipts. **Expected:** exactly ONE reply
  rendered and exactly ONE utterance started (a superseded one cancelled per F-4). **FAIL if:** two
  sentences settle for one submit, or a reply plus a second utterance not attributable to a supersede.
  **Edge:** a turn that ends in the 15 s watchdog typed error (still exactly one terminal state).

---

## AC-2 — the spoken order is the typed equivalent (four drive steps + the precedence control)

> **The three cancels are THREE rows (F-8, F-9, F-10).** Drive each separately; never assert one by
> inference from another — they are different events with different consequences (UI/UX §3).

- [ ] **F-6 (R-2a) — a hold at/over `HOLD_THRESHOLD_MS` on the focused EMPTY order field captures speech
  and the release finalizes into the SAME dispatch funnel a typed submit uses.**
  Focus `fredo-companion-composer-input` (empty). Keydown Space, hold ≥ 400 ms, release, with the
  capture feed injected (`FREDO_STT_FEED_WAV` = the in-repo fixture). **Expected:** at some sample the
  field's `data-order-capture` is `armed` then `starting` then `listening`; the ONE announcement for the
  live edge fires exactly once; the release finalizes; the captured audio reaches the SAME turn funnel
  (`ask`/`llmChatWithStatus` — never a second route) and a settle arrives. **FAIL if:** no capture
  state appears, or the announcement fires more/fewer than once per capture, or the finalized text
  bypasses the composer's submit path.
  **Edge:** auto-repeat keydowns during the hold (never a restart); a hold begun while a reply
  generation is in flight (⇒ F-11, ordinary space); the release exactly at the boundary.

- [ ] **F-7 (R-2b) — a short press writes exactly ONE ordinary space AT THE CARET.**
  Put a caret MID-text in the order field (e.g. `ab|cd`), then press and release Space under the
  threshold. **Expected:** the value grows by exactly one character, the character is `' '`, it lands at
  the caret (the characters after the caret move right by one), and `selectionStart` advanced by 1.
  **FAIL if:** the value grows by 0 (a lost space) or 2 (a doubled space), **or** the space is appended
  at the END of the text instead of at the caret (a lost keystroke dressed as a kept one — a
  length-only assertion passes this defect).
  **Edge:** a selection (native replace behaviour); the caret at position 0; the field empty.

- [ ] **F-8 (R-2c · escape) — Escape cancels the gesture.**
  Arm the hold, press Escape while armed or listening. **Expected:** capture cancelled; the field's
  value is UNCHANGED (no space written); nothing dispatched; the microphone released
  (`stt:state{listening:false}`); the box stays open; `Dictation cancelled` announced. **FAIL if:** the
  value grew by one, or a dispatch occurred, or the mic stayed live.
  **Edge:** Escape after the live edge (the stale-hold guard: a session that goes live after the cancel
  is cancelled on its rise edge); a double Escape.

- [ ] **F-9 (R-2c · close-control) — the visible close control cancels, it does not finalize.**
  Arm the hold, click `fredo-companion-composer-dismiss` while listening. **Expected:** capture
  cancelled FIRST, **no space written**, nothing dispatched, then the shipped dismiss runs (focus
  returns to the pre-open element). `Dictation cancelled` is announced **exactly once** — the blur that
  the click causes must NOT cancel a second time. **FAIL if:** two `Dictation cancelled`
  announcements, or the post-cancel value is one character longer, or the click finalizes a capture.
  **Edge:** the click landing mid-arm; the close control activated from the keyboard.

- [ ] **F-10 (R-2c · blur) — the field losing focus to anything OUTSIDE the composer cancels.**
  Arm the hold, then focus an element outside the composer root. **Expected:** capture cancelled, no
  space written, nothing dispatched, the box stays open. **FAIL if:** the value grew by one, or the
  gesture survived the blur, or the box closed. **Note the two distinct requirements:** focus moving
  to a control INSIDE the composer root is NOT a cancel (UI/UX §3).
  **Edge:** blur to a different window; blur caused by the composer's own re-render (must not cancel).

- [ ] **F-11 (R-2d) — where the gesture must NOT arm, Space stays an ordinary native space.**
  Drive all three: (a) the field is NON-EMPTY; (b) voice is disabled/unusable (the fail-closed probe);
  (c) a reply generation is in flight. **Expected:** in each case Space inserts one ordinary character,
  NO capture state appears, NO error is surfaced, and the `Hold Space to speak` promise (placeholder
  AND its `aria-describedby` description) is ABSENT. **FAIL if:** a capture arms, or an error text is
  shown, **or** the promise is present in a state where it is not true (a false capability claim is a
  FAIL, not a cosmetic nit).
  **Edge:** a held modifier (`primary+space`) ⇒ `ordinary-space`; `event.repeat`.

- [ ] **F-12 (R-2 precedence control) — `[static]` the gesture delegates the shipped precedence and does
  not re-derive it.**
  > why static: this is a source + unit-suite property (an import and an equality), not a user-runnable
  > behaviour — driving it live would prove the same fact more weakly.
  Run `pnpm --filter @fredo/ui test:run launcherSpaceHold` and `pnpm --filter @fredo/ui test:run
  shared/order/orderGesture`. **Expected:** `ORDER_HOLD_PENDING_CUE_MS` is asserted EQUAL to the shipped
  `HOLD_PENDING_CUE_MS` **at import** (`expect(...).toBe(HOLD_PENDING_CUE_MS)`), never a second
  literal; the shipped `launcherSpaceHold` suite is green and BYTE-UNCHANGED (`git diff` empty for
  `launcherSpaceHold.ts` and its test); a precedence reorder makes BOTH suites red. **FAIL if:** a
  second literal for the cue constant, or any edit to `launcherSpaceHold.ts`, or the shipped suite
  edited to accommodate the new gesture.
  **Edge:** the 150–200 ms window's brief `starting voice input…` cue — the SHIPPED behaviour, recorded
  as authored, never scored as a verdict failure (UI/UX §3).

---

## AC-3 — an in-flight order completes in its ORIGIN app; the MOVE is not announced

> **G-520 hazard, stated as part of the recipe.** The settle writes to EXACTLY ONE of {live region,
> speech}. A row that compares the region's text before the move with its text AFTER the settle reads a
> lawful settle announcement as an "announced the move" violation. **The comparison interval is: freeze
> the pre-move value → drive the move → read IMMEDIATELY.** That interval is the only one in which the
> AC-3 claim lives.

- [ ] **F-13 (R-3a) — the order completes in the ORIGINAL app after the user moved.**
  Place over Wireframe (chip `for Wireframe`). Submit an order (PATH-A real model turn; the ticker
  enters `running`). While the turn is in flight, switch the focused app to a DIFFERENT app.
  **Expected:** a settle arrives; its sentence/ticker names the ORIGINAL app and the Wireframe
  document reflects the change; the order is **not cancelled** (no cancel copy, no `nothing` outcome).
  **FAIL if:** no settle arrives, or the settle names the NEW app, or the order is cancelled.
  **Disclosure:** if the model does not select the `order` skill this round, record `model-turn not
  exercised` for the selection-content half and drive the selection with the lever (F-13b); the
  *in-flight-survives* half stays valid because the ticker is created at submit.
  **Edge:** the move landing before the turn starts; two moves.

- [ ] **F-13b (R-3a · lever leg) — the same property with no model and no human click.**
  With `FREDO_ORDER_SKILL_LEVER` armed, drive the selection through `order_skill_lever_take` and the
  script file, with the app switch performed inside the SAME in-page `execute_js` task between the
  dispatch and the settle. **Expected:** identical to F-13. **FAIL if:** the lever is reached without
  being armed (the unarmed control must be inert — run it first), or the settle names the new app.
  **Edge:** the unarmed control run in the SAME round (G-469's positive control).

- [ ] **F-14 (R-3b + G-475(b)) — the BOTH-true pair: the chip names the NEW app, the ticker still names
  the ORIGINAL app.**
  In the F-13 window (after the move, while still `running`), read
  `fredo-companion-composer-target` and the ticker's `data-order-target-app`. **Expected:** chip = the
  NEW app; ticker = the ORIGINAL app; `data-order-state` = `running`. **FAIL if:** the ticker's target
  names the NEW app while the work is still running in the original one (the chip's datum copied onto
  the ticker — the UI would be lying), **or** the chip does not re-scope.
  **Edge:** the app the user moved to declares no order surface.

- [ ] **F-15 (R-3c) — the MOVE is not announced (the region).**
  Freeze `fredo-companion-live-region`'s text BEFORE the move; drive the move; read it AGAIN
  immediately (before the settle). **Expected:** byte-identical. **Precondition (G-469/G-170):** the
  pre-move read must be **NON-EMPTY** and attributable to the order's own submit (the shipped `Message
  sent to Fredo` submit announcement is the natural carrier). **A blank pre-move read is a FAILED DRIVE,
  not a pass** — two blanks are equal and prove nothing. **FAIL if:** the text changed across the move.
  **Edge:** a second move; a move during an utterance.

- [ ] **F-16 (R-3c) — the three announcement channels, each with its OWN non-vacuity control.**
  The closed set AC-3's silence must hold to is: the polite region, speech, and `showMessage`
  (`CompanionContext.tsx:506` — the welcome/guide bubble). For EACH channel, in the same round:
  **(1) non-vacuity control** — prove the channel CAN change in this session (region: a submit
  announcement; speech: F-3's receipt; `showMessage`: the turn-on welcome bubble). **(2) the move** —
  drive it and show the channel did NOT change for the move. **Expected:** every channel's control
  fired AND no channel changed across the move. **FAIL if:** any channel shows no control (its silence
  is then unproven) or any channel changed. The reading must state, per channel, the control's observed
  value and the post-move value.
  **Edge:** Doom Mode active (speech suppressed — the channel table then routes the settle to the
  region; the MOVE must still be silent on all three).

- [ ] **F-17 (R-3d) — a FAILED order still follows the user and reports the failure.**
  Induce an executor failure (an order whose action id is declared but whose execution the app refuses,
  via the lever's scripted entry). Move mid-flight. **Expected:** the settle names the failure and the
  app; the next order's default target is the NEW app (the re-scope happened anyway).
  **FAIL if:** the failure is swallowed, or the re-scope is skipped because the order failed.
  **Edge:** a failure and a success in the same session.

---

## AC-4 — placing always begins a fresh conversation; leaving discards it

- [ ] **F-18 (R-4a) — a placement mints a NEW identity; the UNGROUNDED composer reads the empty string.**
  Drive the grounded transitions: place over Wireframe, read the next turn's `companion.injection`
  span `attributes_json.placementId` (non-empty). Leave, place again over the same app, read the new
  turn's `placementId`. **Then** drive the UNGROUNDED case: open the composer with NO resolved target
  (chip = `No app in front of Fredo`) and read its turn's `placementId`. **Expected:** the two grounded
  placements carry two DISTINCT ids; the ungrounded turn carries `''`. **FAIL if:** the two placements
  share an id (a placement is not fresh), **or** an ungrounded turn carries a NON-empty id (the mint is
  unconditional, so the field's own contract — `''` when not placed — is false).
  **Edge:** the seat (home) surface, which never renders the composer; a teleport that closes the box.

- [ ] **F-19 (R-4b) — leaving discards; a later placement of the SAME app is a fresh conversation.**
  Complete an order in a placement (ticker shows the outcome). Leave (close the box / teleport away).
  Place again into the SAME app. **Expected:** the ticker is empty, the field is empty, and no
  surface shows the previous placement's outcome or its target app. **FAIL if:** the second placement's
  ticker/reply still shows the first placement's outcome.
  **Edge:** leaving with a pending confirmation (it is dropped and refused — F-26); leaving mid-flight.

- [ ] **F-20 (R-4c) — `[static]` nothing is recalled: the turn carries no prior turn.**
  > why static: the property is the shipped message-array shape and the absence of any module-scoped
  > transcript — a source fact, not a runtime one. The runtime half is F-18's receipt.
  Read `buildCompanionTurnMessages` and sweep `apps/ui/src` for a module-scoped turn/transcript array
  on the order or placement path. **Expected:** the builder emits exactly `[grounding?, screen?,
  persona, user]` — no history, no prior assistant turn; the sweep finds no turn array (the composer
  holds ONE local `value`). Instrument must hard-fail on absent input: a sweep whose scanned-file count
  is 0 is a FAILED DRIVE, never a pass, and it must print the root it scanned. **FAIL if:** a prior turn
  is appended for any path.
  **Edge:** a second submit in one placement (F-1's edge) — still no carried history.

---

## AC-5 — one action per order; lookup-then-act is the only allowed two-step

- [ ] **F-21 (R-5a) — a multi-action selection executes exactly ONE.**
  Via the lever, deliver a selection naming TWO declared actions in one turn. **Expected:** exactly one
  action runs (the document shows one change) and the reply is the typed one-action refusal for the
  rest. **FAIL if:** both run, or neither runs with no typed reply.
  **Edge:** two actions of the SAME app; two different apps (illegal — refuse).

- [ ] **F-22 (R-5b) — a lookup followed by an act is allowed, and only that shape.**
  Via the lever, deliver `read` then `changing`. **Expected:** both legs run in order, the read's
  observable is a snapshot description and the act's is a document change; exactly one dispatch funnel.
  A three-step chain is refused. **FAIL if:** the read-then-act pair is refused, or a third step runs.
  **Edge:** read-then-destructive (allowed); act-then-read (refused).

- [ ] **F-23 (R-5c) — a failed lookup never becomes a blind act.**
  Via the lever, make the first step name an action id the app does not declare. **Expected:** the
  second step does NOT run; the reply is the typed refusal; the document is unchanged. **FAIL if:** the
  second step executes without the first step's result.
  **Edge:** a first step that classifies `unknown`; a first step that throws.

---

## AC-6 — a changing or destructive action never runs without an explicit user confirmation

- [ ] **F-24 (R-6a) — a `changing` action is refused until the user confirms, and the confirmation is
  rendered.**
  Via the lever (armed), dispatch `wireframe.element.fill`. **Expected:** the document is UNCHANGED
  before any click; `fredo-order-confirmation` is present (role `dialog`, `aria-modal="true"`, computed
  name `Confirm this order` via `aria-labelledby` — the computed name, NOT the presence of an
  `aria-label`); `fredo-order-confirmation-verb` / `-consequence` / `-confirm` / `-cancel` present;
  confirm's accessible name is `Run <label>`; the ticker is `needs-confirmation`. Initial focus is
  Cancel. **FAIL if:** the action executes before a confirm, or the dialog is absent, or the root's
  computed name is not `Confirm this order`, or focus starts on Confirm.
  **Edge:** a `destructive` + undoable action (`wireframe.element.delete`); a scrim click (must do
  nothing — not cancel, not confirm); Escape (⇒ F-26).

- [ ] **F-25 (R-6b) — confirming executes exactly THAT invocation.**
  From F-24, click `fredo-order-confirmation-confirm`. **Expected:** exactly that invocation runs (the
  named element's fill changes; no other element changes; exactly one history entry); the ticker leaves
  `needs-confirmation` for `running`/`done`. **FAIL if:** a different invocation runs, or two actions
  run, or the ticker shows `running` when the grant did not mint (a refused confirm must land in
  `refused`, never `Working…`).
  **Edge:** a double click (must not double-execute — F-31); the confirm pressed after the placement
  ended (F-26 edge).

- [ ] **F-26 (R-6c + UIUX-D9) — cancelling executes nothing and says so in its OWN words.**
  From F-24, click `fredo-order-confirmation-cancel`; repeat with Escape. **Expected:** nothing runs
  (document unchanged, no undo record registered), no grant consumed (a following identical order still
  needs confirmation), and a reply settles whose subject is the USER's decision. **Positive absence
  assertion:** the text does NOT contain the unknown-refusal wording (`couldn't` / `can't carry`) and is
  not silent. **FAIL if:** the action ran, or nothing was said (silence is R-6c's defect), or the copy
  borrowed the unknown-refusal sentence (G-505 — the user's next action differs).
  **Edge:** Escape with a scrim click before it; cancel on the irreversible variant (F-35).

- [ ] **F-27 (R-6d) — an unregistered app or action id is refused, fail closed.**
  Dispatch an order naming an action id no app declares, and separately one against an app that
  declares no order surface. **Expected:** nothing runs; the reply is `orderRefusedUnknownReply` naming
  the app and that Fredo cannot carry it out there; the ticker is `refused`. **Positive absence
  assertion (G-505):** the text is NOT the app-OPEN "couldn't find `<name>`" sentence (the app was
  found). **FAIL if:** anything runs, or the refusal borrows the app-open copy, or the classifier
  defaults to `read` and executes.
  **Edge:** a blank action id; a declared id with a missing `risk`.

- [ ] **F-28 (R-6d + UIUX-D7) — the UNGROUNDED composer refuses an order instead of narrating it.**
  Open the composer with NO resolved target (chip `No app in front of Fredo`); dispatch an `order`
  selection. **Expected:** a typed refusal naming the missing app; the ticker is `refused`; nothing
  ran; NO prose describing what Fredo *would* do. **FAIL if:** the surface renders model prose that reads
  like a plan or an accomplishment, or the ticker shows any state other than `refused`.
  **Edge:** a target that resolves between submit and dispatch.

---

## AC-7 — the model cannot confirm its own action; confirmation is user-granted only

- [ ] **F-29 (R-7a) — `[static]` the offered `order` schema is CLOSED at `action` + `arguments`.**
  > why static: this is a schema/round-trip property. The live half rides the same run: the rendered
  > `tools` on a real turn is read in F-38's leg.
  Read the rendered `order` entry's `function.parameters` and the committed pin. **Expected:** the
  property set is EXACTLY `["action", "arguments"]` (a set equality, not a `toContain`); NO key matches
  `/confirm|approv|grant|authoriz/`; `required` names `action`. **FAIL if:** any additional property
  exists (there would then be a confirmation-shaped argument to supply).
  **Edge:** a nested property inside `arguments` (legal — `arguments` is an open object; the model still
  has no channel to mint a grant).

- [ ] **F-30 (R-7b) — `[static]` the grant's ONLY writer is the user's confirmation control (source sweep
  with a POSITIVE CONTROL).**
  > why static: this is a prove-a-negative over source — the strongest receipt is the sweep plus a
  > positive control that the sweep can see. The live consequence is F-31/F-32.
  Sweep `apps/ui/src` (repo-wide, every depth, `.ts` AND `.tsx`) for `mintOrderGrant`. **Expected:**
  the call sites are EXACTLY the definition + `confirmOrder` inside `confirmGate.ts` plus its own test;
  and the POSITIVE half — `confirmOrder` has exactly ONE non-test caller, the confirmation control's
  `onConfirm` wiring. **The sweep must fail on absent input:** it refuses to pass when its scanned-file
  count is 0, prints the root it scanned and the count, and runs a **positive control** (a seeded
  synthetic match placed under the swept root in the same run must be FOUND, and the sweep must then
  report a failure). A sweep matching nothing is a FAILED DRIVE, never a pass.
  **Wrong subject cross-check (G-469(d)):** one independent source — the `OrderGrant` type's
  `mintedBy: 'user'` literal — is read and reported alongside.
  **Allowlist (G-431):** the evidence allowlist for this sweep enumerates this spec's own seeded suite
  (`.opencode/tests/order-loop/`) as a permitted occurrence, so the suite's own prose cannot make the
  guard redden on itself.
  **FAIL if:** any production file other than `confirmGate.ts` calls `mintOrderGrant`, or the confirm
  control's handler is not the one non-test caller of `confirmOrder`. Report the mutation control:
  adding a synthetic model-driven `mintOrderGrant` call must redden it.

- [ ] **F-31 (R-7b) — single use: a second execution attempt is refused.**
  Confirm an order (it runs). Re-dispatch the IDENTICAL order with no new user click. **Expected:** the
  second attempt does NOT execute — the confirmation surface re-renders and the ticker is
  `needs-confirmation` (never `done`), and the document changed exactly ONCE. **FAIL if:** the second
  attempt executes on the stale grant, **or** the second attempt reports `done` without a new dialog.
  The discriminator is the ticker/dialog state paired with the change count — a grant that stays valid
  drives straight to `done` with no dialog.
  **Edge:** a different fingerprint (a grant for A must never authorise B — assert B needs ITS own
  confirmation); a grant minted then the placement ended.

- [ ] **F-32 (R-7c) — a model-supplied confirmation-looking argument is IGNORED.**
  Via the lever, dispatch `order` with `arguments: {…, confirmed: true}` (and, in a second run,
  `approved: true`). **Expected:** the document is UNCHANGED and `needs-confirmation` still holds — no
  argument in `arguments` is read by the classifier, the gate, or the executor. **Positive control in
  the SAME round (G-469):** the identical order without the injected key, followed by a real click on
  Confirm, DOES execute. **FAIL if:** the injected key short-circuits the gate (defect world), or the
  positive control fails to execute (the round then proves nothing).
  **Edge:** the injected key at every nesting depth the schema allows; a key named `grant`.

---

## AC-8 — a confirmed change is undoable, OR the user was warned before it ran

> **The two halves are ALTERNATIVES with different evidence.** F-33/F-34 evidence the undoable half;
> F-35 evidences the pre-warning half; F-36 is the aggregate that fails when NEITHER occurred.

- [ ] **F-33 (R-8a) — a confirmed `changing` order is undone through the APP's OWN inverse.**
  Read the target shape's `data-wireframe-selection-fill` BEFORE the order. Confirm the fill order. Read
  the fill AFTER (changed). Activate the order's Undo control (`fredo-order-undo`). **Expected:** the
  fill returns to the EXACT previous token — read from the DOCUMENT, not from the undo registry's own
  report; the reply is `orderUndoReply`; the control is removed from the tree (not merely disabled).
  **FAIL if:** the registry reports `undone` while the document is unchanged (a store-only assertion
  passes that defect), or the control stays rendered after its record is consumed.
  **Edge:** undo of a `destructive` + undoable action (`wireframe.element.delete`) — the SAME element id
  and geometry are restored; undo after the record is past `ORDER_UNDO_DEPTH`.

- [ ] **F-34 (R-8a · stale-safety) — the order's Undo must NOT revert the user's own later edit.**
  (1) Confirm a fill order (history entry 1). (2) The user makes their OWN edit through the app's
  pointer controls (history entry 2). (3) Press the order's `fredo-order-undo`. **Expected:** the order
  reports `nothing`/`failed` — it must NOT revert entry 2, because entry 2 is not the order's change.
  The user's own edit stands. **FAIL if:** the user's edit is reverted (a blind "one step back" reverts
  an unrelated change — the single worst outcome this affordance can produce), **or** the press is a
  silent no-op (`orderNothingToUndoReply` must render and be spoken/announced on the one-channel rule).
  **Edge:** the user presses the APP's own Undo first (F-40's shipped control) — the order must then
  still refuse to claim it undid its own change.

- [ ] **F-35 (R-8b) — the irreversible action is warned BEFORE it ran, evidenced by the DOCUMENT.**
  Confirm-path for `wireframe.document.new` on a dirty document (a `destructive`, NOT-undoable action
  with a declared `consequence`). **Expected, while the confirmation is on screen and BEFORE any
  click:** `fredo-order-confirmation-consequence` carries `orderIrreversibleWarning` + the declared
  consequence sentence; the dialog's `data-order-undoable` is `"false"`; AND the document state read at
  that moment is **UNCHANGED** (`data-wireframe-element-count` / `data-wireframe-dirty` still reflect
  the pre-order document). Only after the click does the document reset.
  **FAIL if:** the document already changed while the warning is on screen (the ordering collapsed — a
  post-run screenshot could show either, which is why the document is read, not the image), or the
  warning is absent/empty, or `data-order-undoable` is `"true"`.
  **Edge:** a document with zero elements (New on a clean document — the warning still applies to the
  action's declared risk); the two variants distinguishable in BOTH themes.

- [ ] **F-36 (R-8 aggregate) — a settle with NEITHER an undo affordance NOR a pre-run warning is a FAIL.**
  For each of the two confirmed actions in this round, read at settle: (a) is `fredo-order-undo`
  present, or was the pre-run warning rendered before the run? **Expected:** every confirmed settle
  satisfies (a) or (b); a `changing`/`destructive` settle with neither is a FAIL of AC-8. **Failure of
  this row is the AC's own failure** — do not downgrade it to a cosmetic finding.
  **Edge:** an action that performs nothing (a no-op fill) — the AC's subject is a *confirmed change*;
  record a no-op outcome as out of the AC's subject, with the reason.

- [ ] **F-37 (R-8c) — undo with no record says so and never claims an undo occurred.**
  With an empty registry (fresh placement), request undo. **Expected:** `orderNothingToUndoReply`
  renders (and is spoken/announced on the one-channel rule); no claim that anything was undone; no
  throw. **FAIL if:** silence, or any success wording.
  **Edge:** a registry aged past `ORDER_UNDO_DEPTH`; a record whose `undo()` returns false.

---

## The fourth static skill — the widening, re-cut in THIS suite

- [ ] **F-38 (the `order` offer) — the shipped offer is FOUR static skills in order, the first three
  byte-identical.**
  Read the real turn's offered `tools` (PATH-A) AND run the re-cut shipped pin. **Expected:** the
  offer is exactly `open_app`, `close_app`, `doom_mode`, `order` **in that order**; `len() == 4`;
  the first three entries are byte-identical (name + description + parameters) to the pre-change
  baseline; `companion_skill_registry()` is still **zero-argument** (a `companion_skill_registry(app)`
  arity is a FAIL); the offered `order` parameters are F-29's closed set. **FAIL if:** a rename,
  a reorder, a reworded description, a fifth name, or a parameter on the existing three changed — a
  plain count change is NOT enough.
  **Edge:** a second turn offers the identical four byte-for-byte; the unarmed lever changes nothing
  about the offer; the audio turn carries the SAME four (parity).

- [ ] **F-39 (the widening's user-visible surface) — `[static]` the fourth skill is not enumerated to the
  user, and the FAQ edit does not imply a fourth global chord.**
  > why static: a doc/copy property with no runtime surface — no in-app surface enumerates the skills.
  Read the FAQ paragraph carrying the capability list and the chords sentence (the same paragraph).
  **Expected:** the capability sentence names the order loop; the gesture sentence carries an explicit
  **scope qualifier** ("in the instruction box, while that field is focused and empty") and is NOT
  written as a key binding; the "only three global chords" sentence remains true; `PLATFORM_CHORDS` is
  byte-unchanged (F-43). **FAIL if:** a reader could conclude there is a fourth global chord, or a name
  check alone passes a sentence implying one.
  **Edge:** `ARCHITECTURE.md`'s offer row and `SECURITY.md`'s audio claim, re-worded to their surviving
  true scope (never deleted, never left asserting a false absolute).

- [ ] **F-40 (the invalidated live-suite rows) — `[static]` every `.opencode/tests/**` row this spec's
  fourth skill (and its first audio-OUTPUT surface) invalidates is superseded HERE.**
  > why static: a documentation/suite-content property. `.opencode/tests/**` is NOT edited by this spec;
  > the re-cuts live in this suite and are enumerated in its `regression.md`.
  Read this suite's `regression.md` supersession table and verify each named old row's claim against
  the shipped tree. **Expected:** every named old row's "exactly three static skills" / "no fourth
  name" / "no TTS output" clause is superseded by a row here, and the old suites' surviving intent
  (the ZERO-argument accessor; the three shipped names byte-identical; typed/audio parity) is preserved
  **unweakened**. **FAIL if:** a re-cut weakens an invariant (e.g. drops the parity leg, retires a suite
  to go green), or a named old row is left with no successor and no disposition.
  **Edge:** a row asserting absence inside a suite that now legitimately spells the new name (G-431).

---

## Non-functional

- [ ] **F-41 (NFR-1) — `[static]` local and offline only.**
  Sweep the spec's new files for a network client (`fetch(` to a remote origin, `net::`, `http://`,
  `https://`, a new `reqwest`/`hyper` dependency). **Expected:** ZERO; the seam is `speechSynthesis`
  (platform-local) and the turn is the shipped in-process funnel. **FAIL if:** any new remote origin or
  client.
  **Edge:** an unused import; a doc-comment URL (not a use — state the scan strips comments).

- [ ] **F-42 (NFR-2) — the slice adds ZERO resident engine/context; the per-turn payload stays bounded.**
  Same run as F-1/F-13: query `telemetry_spans` for `event_type='companion.injection'` for the round.
  **Expected:** every turn's `simplifiedHtmlBytes` ≤ 8192 and `simplifiedHtmlNodes` ≤ 120 (the shipped
  caps); the process tree shows ONE engine (no second engine process); the new receipt fields
  (`placementId`, `orderActionCount`, `orderSurfaceDigest`) are present on EVERY row (never absent, never
  null). **FAIL if:** a turn exceeds a cap, a second engine appears, or a new field is missing from a row
  (a `serde(default)`-ed `""` making a real placement read as unplaced is exactly the forbidden case).
  A blank query result is a FAILED DRIVE (non-zero rows required, with `max(ingested_at)` recent).
  **Edge:** an unplaced turn (`''` / `0` / the empty digest — present, not absent).

- [ ] **F-43 (NFR-6) — `[static]` no second dispatch funnel, no fourth platform chord, no `document`
  keydown listener on the order surface.**
  **Expected:** `platformChords.ts`'s `PLATFORM_CHORDS` is byte-unchanged and still exactly three; the
  order surface adds NO `document`-level keydown listener (the gesture's keydown is the textarea's own
  React `onKeyDown`, its keyup stays inside the composer); the order path reuses `ask` /
  `llmChatWithStatus` / `llm-skill-call` (no second route). **FAIL if:** a fourth chord entry, a new
  document listener the composer did not have, or a second dispatch funnel.
  **Edge:** `primary+space` from the focused order field — must be unreachable (text-entry suppression).

- [ ] **F-44 (theme + tokens) — the new surfaces are token-native in BOTH presets.**
  In light AND dark: the confirmation (undoable variant) and the irreversible variant are
  distinguishable on TEXT (the warning sentence) and icon, not colour alone; the ticker, the Undo
  control and the dialog read contract tokens only. **Expected:** ZERO raw hex/`rgba(`/`hsla(` and ZERO
  alpha-append onto a `var()` in the new files; the focus ring renders on every control; both presets
  separate the two variants. **FAIL if:** the variants collapse to identical text in either preset, or a
  raw colour appears.
  **Edge:** a preset where the error tint is close to the surface.

- [ ] **F-45 (layout) — the ticker row does not make the card overlap Fredo, the reply, or the bar.**
  At the narrowest supported viewport, with a 5-line draft AND a ticker row present, measure the
  composer card's rect against the avatar rect, the reply-surface rect and the command bar. **Expected:**
  zero intersection and the declared separation; the card's max height is derived from
  `COMPOSER_MAX_H + ORDER_TICKER_ROW_H` (a literal `96` in any clearance assertion is the defect — the
  row must read the DERIVED value). **FAIL if:** any overlap at that state, or the assertion pins a
  nominal sum. **The row must be run in EACH render state whose pinned stack differs** — with a ticker
  present and absent.
  **Edge:** a long outcome sentence (clip paint, not layout); reduced motion.
