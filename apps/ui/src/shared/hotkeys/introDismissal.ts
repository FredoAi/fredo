/**
 * Spec #2960 ST-4 — the persisted first-run intro dismissal (EARS R-5.1/R-5.2).
 *
 * The first-run card is shown at most ONCE per profile. Its "seen" state is a
 * single sibling KV entry in the ONE settings channel (`settingsService`,
 * `applications/settings/index.tsx`) — no new Rust command, no new table.
 *
 * Storage unit: the LITERAL string `'true'` when seen; the key is ABSENT when
 * the intro has never been dismissed (the plan's Controls table).
 *
 * The read passes an identity deserializer deliberately: `settingsService`'s
 * default deserializer JSON-parses, so `JSON.parse('true')` yields the BOOLEAN
 * `true` and a `=== 'true'` string comparison would never match. Passing
 * `(stored) => stored` keeps the stored unit a verbatim string so the documented
 * `=== 'true'` test is honest (mirrors `TelemetrySettings.tsx:89`'s explicit
 * `(raw) => raw === 'true'` flag read).
 *
 * `settingsService.get` never throws (it resolves to the caller default on a
 * miss); `set` swallows a missing host. Both helpers are therefore safe to call
 * from a mount effect.
 */

import { settingsService } from '../../applications/settings';

/** The AppStore/localStorage key recording that the one-time intro was seen. */
export const INTRO_SEEN_STORAGE_KEY = 'fredo.hotkeys.introSeen';

/** The literal storage unit written once the intro has been dismissed. */
export const INTRO_SEEN_STORAGE_VALUE = 'true';

/** Return the stored string verbatim (the default deserializer JSON-parses). */
const verbatim = (stored: string): string => stored;

/**
 * Read whether the intro has already been seen. `true` ONLY for the literal
 * stored string `'true'`; a miss or any other value is `false`.
 */
export async function readIntroSeen(): Promise<boolean> {
  const raw = await settingsService.get<string>(INTRO_SEEN_STORAGE_KEY, '', verbatim);
  return raw === INTRO_SEEN_STORAGE_VALUE;
}

/**
 * Persist the dismissal. Defensive catch: the settings channel is documented as
 * never throwing, but a write failure must never block hiding the card.
 */
export async function persistIntroSeen(): Promise<void> {
  try {
    await settingsService.set(INTRO_SEEN_STORAGE_KEY, INTRO_SEEN_STORAGE_VALUE);
  } catch {
    /* never let a persistence failure break dismissal */
  }
}
