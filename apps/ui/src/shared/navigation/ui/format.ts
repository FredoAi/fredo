/**
 * Spec #3118 (P4), ST-1 — the plain-text formatters every surface renders through.
 *
 * One formatter per display concern, so the rail, the map and the trail cannot format the
 * same datum two ways. `navTooltip` composes the shipped `discover.formatTooltip` (the ONE
 * tooltip rule from P3) instead of re-deriving the string, and only appends the generic
 * unavailable reason.
 *
 * PURE: no clock read (`formatTrailTime` formats a supplied ISO string), no DOM, no I/O.
 */

import { formatTooltip } from '../discover';
import type { Risk, VerbDescriptor } from '../types';
import { NAV_RISK_LABELS } from './constants';
import type { NavPlaceRef } from './types';

/** The minimal subject `formatTooltip` actually reads (`title`, `risk`). */
type TooltipSubject = Pick<VerbDescriptor, 'title' | 'risk'>;

/** The only tooltip rule (P3 `discover.formatTooltip`); the P4 layer adds no variant. */
function baseTooltip(subject: TooltipSubject, keys: readonly string[]): string {
  // The shipped formatter reads only `title` and `risk`; the cast states that narrow contract
  // so the P4 layer cannot drift into a second tooltip rule.
  return formatTooltip(subject as VerbDescriptor, keys);
}

/**
 * Bindable-token glyphs (§4.4). Reserved strokes canonicalise to their declared casing, so
 * match case-insensitively; `+`/`-` are single characters and pass through verbatim.
 */
const TOKEN_GLYPHS: Readonly<Record<string, string>> = {
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  '+': '+',
  '-': '-',
};

/** Display one token: a bound glyph when the token is reserved, else Title-case ('w' → 'W'). */
function displayToken(token: string): string {
  const glyph = TOKEN_GLYPHS[token.toLowerCase()];
  if (glyph !== undefined) return glyph;
  const lower = token.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * §8 — display text of the FIRST binding only; tokens joined by `' then '`.
 * `['w n']` → `'W then N'`; `[]` → `''` (an unbound verb shows no key hint).
 */
export function formatKeyHint(keys: readonly string[]): string {
  const first = keys[0];
  if (first === undefined) return '';
  return first
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map(displayToken)
    .join(' then ');
}

/** §11.1 — a place path as one label line, `' › '` separated. */
export function formatPlacePathLabel(path: readonly NavPlaceRef[]): string {
  return path.map((place) => place.label).join(' › ');
}

/**
 * §8 — `'HH:mm'` in the host's locale, with the hour cycle PINNED to `'h23'`.
 *
 * `hour12: false` would leave the cycle locale-derived (an h24 locale formats midnight as
 * `24:00`); `hourCycle: 'h23'` makes midnight `00:00` on every host (Architect C5 / QA GAP 8).
 */
export function formatTrailTime(ts: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ts));
}

/** §11.1 — the risk word, or `null` for `safe` (a safe verb renders no risk word). */
export function riskLabel(risk: Risk): string | null {
  return risk === 'safe' ? null : NAV_RISK_LABELS[risk];
}

/**
 * §8 — `formatTooltip(title, keys, risk)` plus `' — <reason>'` iff `reason !== null`.
 *
 * The glyphs `?`/`/` are never key names, so a tooltip always names the bindable stroke
 * (`m`/`k`); the caller passes the reason only for a disabled control.
 */
export function navTooltip(
  title: string,
  keys: readonly string[],
  risk: Risk,
  reason: string | null,
): string {
  const base = baseTooltip({ title, risk }, keys);
  return reason === null ? base : `${base} — ${reason}`;
}
