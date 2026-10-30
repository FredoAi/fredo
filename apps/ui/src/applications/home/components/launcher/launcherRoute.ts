/**
 * Spec #3120 (P6), ST-5 — the launcher Enter route.
 *
 * ONE pure precedence table. The shell calls this BEFORE the shipped `paletteActive`
 * branch (Discussion D6) so a live capture can never run a palette action:
 *
 *   1. `captureLive`     → the shipped `none/listening` Enter verdict (no dispatch);
 *   2. `>` prefix        → `{ kind:'palette' }` (the grouped Place → Verb listbox);
 *   3. undo rule matched → `{ kind:'undo', args }` (dispatch `journal.undo`);
 *   4. `no-match-undo`   → `{ kind:'clarify', message: UNDO_NO_MATCH_COPY }`;
 *   5. `ambiguous`       → `{ kind:'clarify', message: UNDO_AMBIGUOUS_COPY }`;
 *   6. otherwise         → the shipped `resolveEnterAction` verdict, unchanged.
 *
 * PURE: no React, no DOM, no clock, no I/O. The host gate lives in the shell (D1): this
 * module is only consulted when `getNavigationHost(activeAppId) !== null`.
 */

import type { FredoApplicationClass } from '../../../../shared/classes/FredoApplicationClass';
import {
  resolveEnterAction,
  type EnterTextOrigin,
  type LauncherEnterAction,
} from './launcherEnterAction';
import {
  UNDO_AMBIGUOUS_COPY,
  UNDO_NO_MATCH_COPY,
  matchUndoPhrase,
  type UndoQueryArgs,
} from './launcherUndoQuery';

/** The resolved launcher Enter route (binding shape — §3.6). */
export type LauncherRoute =
  | { readonly kind: 'undo'; readonly args: UndoQueryArgs }
  | { readonly kind: 'palette' }
  | { readonly kind: 'enter'; readonly action: LauncherEnterAction }
  | { readonly kind: 'clarify'; readonly message: string };

/** The route inputs (binding shape — §3.6). */
export interface ResolveLauncherRouteInput {
  readonly query: string;
  readonly entries: readonly FredoApplicationClass[];
  readonly textOrigin: EnterTextOrigin;
  readonly companionActive: boolean;
  readonly captureLive?: boolean;
  readonly paletteActive: boolean;
}

/**
 * Resolve one Enter press into a launcher route.
 *
 * `paletteActive` is accepted for contract parity with the shell's shipped branch; the
 * precedence here is query-derived (`>` prefix), so a still-typed `>` cannot dispatch a
 * palette row through this function. The shell owns the actual palette execution.
 */
export function resolveLauncherRoute(input: ResolveLauncherRouteInput): LauncherRoute {
  // 1. A live launcher-origin capture outranks every content rule (shipped QA-10 rule).
  if (input.captureLive === true) {
    return { kind: 'enter', action: resolveEnterAction(input) };
  }

  // 2. The first non-whitespace character `>` switches the results region to the palette.
  if (/^\s*>/.test(input.query)) return { kind: 'palette' };

  // 3–5. Undo-by-description. The two miss variants must never be conflated.
  const phrase = matchUndoPhrase(input.query);
  if (phrase.kind === 'undo') return { kind: 'undo', args: phrase.args };
  if (phrase.kind === 'no-match-undo') return { kind: 'clarify', message: UNDO_NO_MATCH_COPY };
  if (phrase.kind === 'ambiguous') return { kind: 'clarify', message: UNDO_AMBIGUOUS_COPY };

  // 6. The shipped Enter decision, unchanged.
  return { kind: 'enter', action: resolveEnterAction(input) };
}
