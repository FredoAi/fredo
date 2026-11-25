/**
 * #3224 ST-2 — the DEV-only QA flow lever.
 *
 * The avatar's model-declared status is the ONLY product signal that can select an
 * emotion, and the local model cannot be scripted deterministically, so the live
 * acceptance matrix (all 23 states on every mount path) needs a drive that is not a
 * product surface. This module is that drive: a plain function that reads ONE
 * unprefixed page global, and nothing else.
 *
 * ## What this module deliberately is NOT
 *  - NOT a React module: no React import, no JSX, no hook, no component.
 *  - NOT a user surface: it renders nothing, emits no `data-*`/`aria-*`, logs
 *    nothing, is bound to no key/mouse/route, and never appears in a settings pane.
 *  - NOT persisted and NOT URL-reachable: the only interface is
 *    `window.__FREDO_QA_AVATAR_FLOW__`, so a page reload clears it.
 *  - NOT a priority override: the resolver injects the value at NORMAL rank on its
 *    candidate path, so a teleport still outranks it and the conflict order is
 *    unchanged even in DEV.
 *  - NOT in a production build: the module body is gated on `import.meta.env.DEV`,
 *    which the bundler constant-folds to `false`, so the key literal is collected
 *    and the resolver's call collapses to its flow fallback. The committed build
 *    pin (`__tests__/avatarAssetContract.test.ts`) greps the built chunks for the
 *    token and asserts zero hits; the token itself is also assigned through the
 *    DEV-gated expression below, so a future re-export cannot resurrect it.
 *
 * ## Usage (DEV only)
 *   window.__FREDO_QA_AVATAR_FLOW__ = 'uwu';   // must be an exact vocabulary member
 *   window.__FREDO_QA_AVATAR_FLOW__ = 'explode'; // rejected: the flow holds
 */

import { isFredoAvatarState, type FredoAvatarState } from './fredoAvatarStates';

/**
 * The DEV-only page-global key. Empty in a production build (the gate below is
 * constant-folded), which is why the literal can never reach a shipped chunk.
 */
export const QA_AVATAR_FLOW_GLOBAL = import.meta.env.DEV ? '__FREDO_QA_AVATAR_FLOW__' : '';

/**
 * The requested flow override, or `undefined` when there is none.
 *
 * Inert unless `import.meta.env.DEV` AND the global holds an EXACT vocabulary
 * member: `'  uwu  '`, `'IDLE'`, a non-string and a 24th invented id are all
 * rejected (no trimming, no case folding), and an unknown value can therefore never
 * reach the DOM as a stray `data-state`.
 */
export function readQaAvatarFlowOverride(): FredoAvatarState | undefined {
  if (!import.meta.env.DEV) return undefined;
  const value = (globalThis as Record<string, unknown>)[QA_AVATAR_FLOW_GLOBAL];
  if (typeof value !== 'string') return undefined;
  return isFredoAvatarState(value) ? value : undefined;
}

/**
 * Clear the page global. Tests call this in `afterEach` so a stale lever can never
 * poison a sibling row; a real page reload clears it too (nothing is persisted).
 */
export function clearQaAvatarFlowOverrideForTests(): void {
  if (!import.meta.env.DEV) return;
  delete (globalThis as Record<string, unknown>)[QA_AVATAR_FLOW_GLOBAL];
}
