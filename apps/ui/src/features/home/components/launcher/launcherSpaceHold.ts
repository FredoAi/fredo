/**
 * Spec #2882 ST-2 — the PURE hold-Space gesture decision (R-2.1, R-2.2, R-2.6,
 * R-2.7, R-3.1, R-3.2, R-3.3).
 *
 * The whole gesture is decided here so the headline typing-safety NFR ("zero lost
 * spaces") is a PRECEDENCE PROPERTY pinned by unit tests, not an invariant
 * re-derived at each call site:
 *
 *   1. a Space keydown may only be consumed when the FULL R-2.1 precondition
 *      holds (focused bar input + empty query + usable voice + unmodified +
 *      non-repeat + not already armed); every other input resolves to
 *      `ordinary-space`, which leaves the native character alone
 *      (R-3.1 non-empty query / R-3.2 voice disabled / R-3.3 model not ready);
 *   2. WHILE armed, EVERY keydown is swallowed (`hold-suppress`) — including the
 *      OS auto-repeats — so a repeat can never restart a capture and can never
 *      insert a run of spaces (R-2.2);
 *   3. the release resolves to exactly one of `tap-space` / `cancel-pending` /
 *      `finalize` / `none`, and `spaceWriteForVerdict` is the single source of the
 *      "exactly ONE ordinary space" rule (R-2.6/R-2.7).
 *
 * PURE by design: no DOM, no Tauri/IPC, no listener, no clock, no timer — this
 * module imports NOTHING and is deterministic. It also does NOT model the capture
 * lifecycle (`stt_start|stop|cancel`): ST-5 owns the wiring (the 200 ms hold
 * timer, the global keyup release owner, the mic-hot stale-hold guard, the cue).
 * The grid's focused-tile Space-opens-the-tile behaviour is untouched — a
 * non-bar-input target resolves to `ordinary-space`, i.e. this module never
 * intercepts a tile-focused Space.
 *
 * "EXACTLY ONE SPACE" CONTRACT (R-2.6/R-2.7): this module decides WHICH release
 * verdict applies and how much text that verdict writes; **ST-5 owns PERFORMING
 * the write**, through the ordinary typed path (`handleQueryChange(query + text)`)
 * so the character lands exactly like a keystroke. `spaceWriteForVerdict` returns
 * `' '` (exactly one character) for `tap-space` and `cancel-pending`, and `''` for
 * every other verdict — so "one space" is pinnable without a DOM and cannot drift
 * into zero (a lost space) or two (a doubled space).
 */

/**
 * The hold threshold (binding, contract point 4b): a press released BEFORE this
 * many milliseconds is a TAP — an ordinary space, no capture, the mic never
 * opened (R-2.7). At/above it the hold attempts a launcher-origin capture.
 */
export const HOLD_THRESHOLD_MS = 200;

/** The single ordinary space a no-capture release writes — exactly one character
 *  (R-2.6/R-2.7). Exported so the value and its length are pinnable. */
export const HOLD_FALLBACK_SPACE = ' ';

/**
 * The `starting voice input…` cue is shown only once the pending window outlives
 * this (Doherty: the loop must never look dead). Strictly BELOW
 * `HOLD_THRESHOLD_MS`, so the cue can never appear for a gesture that has not even
 * crossed the hold threshold.
 */
export const HOLD_PENDING_CUE_MS = 150;

/** The keydown verdict: what the shell must do with a Space keydown. */
export type SpaceDownVerdict = 'hold-arm' | 'hold-suppress' | 'ordinary-space';

/** The keyup verdict: what the shell must do with the release. */
export type SpaceUpVerdict = 'tap-space' | 'cancel-pending' | 'finalize' | 'none';

export interface SpaceKeyDownInput {
  /** A hold is armed and stays armed until the release (R-2.2). */
  holdArmed: boolean;
  /** The keydown target is the launcher's search input (never a grid tile / other input). */
  isBarInputTarget: boolean;
  /** The bar holds no characters — AC2's literal "contains no characters". */
  queryIsEmpty: boolean;
  /** `voiceEnabled && stt model ready` — the fail-closed ST-3 probe result. */
  voiceUsable: boolean;
  /** A companion generation is in flight (nothing may be promised or started). */
  busy: boolean;
  /** ctrl / meta / alt / shift held (ST-5 folds the four modifiers into this). */
  modified: boolean;
  /** The keydown carries `event.repeat` (an OS auto-repeat). */
  repeat: boolean;
}

/**
 * Resolve a Space keydown. PRECEDENCE IS BINDING (the plan's contract):
 *  1. `holdArmed`                           -> `hold-suppress` (swallow, no restart)
 *  2. `!isBarInputTarget || modified`       -> `ordinary-space` (native)
 *  3. `repeat`                              -> `ordinary-space` (suppressed by 1 when armed)
 *  4. `!queryIsEmpty || !voiceUsable || busy` -> `ordinary-space` (native, nothing promised)
 *  5. otherwise                             -> `hold-arm` (consume + start the hold timer)
 */
export function resolveSpaceKeyDown(input: SpaceKeyDownInput): SpaceDownVerdict {
  // 1. Already armed: swallow EVERY keydown until the release. An auto-repeat (or
  //    any other key) must never restart the capture and must never insert a space.
  if (input.holdArmed) return 'hold-suppress';

  // 2. Not the bar's search input, or a modified chord. Ctrl+Space is the
  //    launcher toggle (handled by the document listener); Shift+Space belongs to
  //    #2883; a tile-focused Space keeps its opens-the-tile meaning. In every case
  //    the native behaviour applies and this module never consumes the keydown.
  if (!input.isBarInputTarget || input.modified) return 'ordinary-space';

  // 3. An OS auto-repeat whose FIRST keydown was not armed is an ordinary repeat:
  //    holding Space in a non-empty bar is expected to insert a run of spaces (AC3).
  if (input.repeat) return 'ordinary-space';

  // 4. The full R-2.1 precondition is not met — nothing is promised, so the space
  //    stays native and no error is ever surfaced: R-3.1 (non-empty query), R-3.2
  //    (voice disabled), R-3.3 (model missing/corrupt/incomplete — `voiceUsable` is
  //    the fail-closed probe), plus a companion generation in flight.
  if (!input.queryIsEmpty || !input.voiceUsable || input.busy) return 'ordinary-space';

  // 5. R-2.1 — the ARM: consume the keydown (ST-5 calls `preventDefault()`) and
  //    start the bounded hold timer.
  return 'hold-arm';
}

export interface SpaceKeyUpInput {
  /** The gesture's own arm flag — cleared by ST-5 on a disarm (Escape). */
  holdArmed: boolean;
  /** The launcher-origin capture went live (the engine confirmed `listening:true`). */
  captureLive: boolean;
  /** The 200 ms hold timer fired before the release (R-2.6 vs R-2.7). */
  thresholdCrossed: boolean;
}

/**
 * Resolve the Space release (the gesture's single release owner is ST-5's global
 * keyup listener). PRECEDENCE IS BINDING:
 *  - `captureLive`        -> `finalize`       (R-2.3 — stop, keep the words, NO space)
 *  - `!holdArmed`         -> `none`           (a keyup that does not belong to this gesture)
 *  - `thresholdCrossed`   -> `cancel-pending` (R-2.6 — cancel the late session + ONE space)
 *  - otherwise            -> `tap-space`      (R-2.7 — ONE space, the mic was never opened)
 *
 * A disarmed gesture (Escape / the visible `×`) is ST-5's to swallow: it clears
 * `holdArmed`, so resolving the trailing keyup here yields `none` and no space
 * lands.
 */
export function resolveSpaceKeyUp(input: SpaceKeyUpInput): SpaceUpVerdict {
  // The capture went live: the release IS the finalize control. The transcript
  // lands as ordinary editable text (ST-5/ST-4) and NO space is inserted (R-2.3).
  if (input.captureLive) return 'finalize';

  // Not armed and nothing live: this keyup does not belong to a gesture we own —
  // a stray keyup, a tap in an unarmed bar, or the trailing keyup of a disarmed
  // hold. Leave it alone (no space, no stop).
  if (!input.holdArmed) return 'none';

  // The threshold was crossed but the engine never went live (R-2.6): ST-5 cancels
  // the session on its rise edge (the mic must never stay hot) and exactly ONE
  // ordinary space is written — the hold never captured.
  if (input.thresholdCrossed) return 'cancel-pending';

  // The release beat the threshold (R-2.7): a TAP — exactly ONE ordinary space,
  // no capture attempted, the mic never opened.
  return 'tap-space';
}

/**
 * The exact text a release verdict writes into the bar — the out-of-band half of
 * the "exactly ONE ordinary space" contract (R-2.6/R-2.7). ST-5 owns PERFORMING
 * the write through the ordinary typed path; this function owns HOW MUCH:
 *  - `tap-space`      -> `' '` (one space: the tap types the character it always did)
 *  - `cancel-pending` -> `' '` (one space: the hold never captured, so it types too)
 *  - `finalize`       -> `''`  (the utterance replaced the text; a space would be a lie)
 *  - `none`           -> `''`  (the keyup is not ours)
 */
export function spaceWriteForVerdict(verdict: SpaceUpVerdict): string {
  switch (verdict) {
    case 'tap-space':
    case 'cancel-pending':
      return HOLD_FALLBACK_SPACE;
    case 'finalize':
    case 'none':
      return '';
  }
}
