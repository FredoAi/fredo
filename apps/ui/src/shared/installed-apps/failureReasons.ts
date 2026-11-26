/**
 * `INSTALLED_APP_FAILURE_REASON` — the INVENTORY's copy authority (Spec #3144,
 * Adjudication 10.4) — the sentence a `failing` inventory row shows.
 *
 * # Why this module exists separately from `refusals.ts`
 *
 * A reused wire code stays reused (R-8.2: no 23rd `InstalledAppRefusalCode`),
 * but a **code is not a message**. The install/open copy in `refusals.ts` makes
 * claims about a PACKAGE BEING REFUSED — e.g. `id_not_installed` reads "That
 * application isn't installed any more." and `io_error` reads "Fredo couldn't
 * finish that install." Both are FALSE about an application that **is installed**
 * but whose record could not be read. Rendering them in the inventory would be
 * exactly the class of lie this slice exists to remove.
 *
 * This is therefore **one source per claim, not two sources for one claim**:
 *
 * - `refusals.ts` (`INSTALL_REFUSAL_COPY`) is the single source for the
 *   *install/open refusal* claim;
 * - this module is the single source for the *installed-application is failing*
 *   claim.
 *
 * The two contexts assert DIFFERENT propositions, and each context imports only
 * its own map (`code → copy`, resolved per context), so neither can silently
 * borrow the other's text. A later "unification" that folds these maps together
 * and reintroduces "not installed" for an installed app is pinned out loudly by
 * the suite's absence row (`R-10.10`).
 *
 * # The exact sentences (binding)
 *
 * | code | sentence |
 * |---|---|
 * | `integrity_record_corrupt` | "Its install record is unreadable, so Fredo can't check its files." |
 * | `integrity_mismatch` | "Its files changed after it was installed, so Fredo won't run it." |
 * | `io_error` | "Fredo couldn't read this application's files, so it can't be started." |
 * | (fallback, incl. `id_not_installed`) | "Fredo couldn't start this application." |
 *
 * `id_not_installed` is deliberately NOT a key: an application with no install
 * directory cannot be listed at all, so it is never a landable inventory
 * `failureCode` (Adjudication 10.4). The neutral fallback covers any future
 * unlisted code without ever claiming a package was refused.
 */

import type { InstalledAppRefusalCode } from './types';

/**
 * The inventory reason sentences, keyed by the host's witness code.
 *
 * EXACTLY three keys: the codes a listing read can put on a `failing` row
 * (`integrity_mismatch | integrity_record_corrupt | io_error`). `Partial` so an
 * unlandable code cannot be forced in without an explicit decision.
 */
export const INSTALLED_APP_FAILURE_REASON: Partial<Record<InstalledAppRefusalCode, string>> = {
  integrity_record_corrupt: "Its install record is unreadable, so Fredo can't check its files.",
  integrity_mismatch: "Its files changed after it was installed, so Fredo won't run it.",
  io_error: "Fredo couldn't read this application's files, so it can't be started.",
};

/**
 * The sentence for a code this map does not key (including `id_not_installed`).
 * Neutral and TRUE for any installed application: it never claims a package was
 * refused and never claims the app is not installed.
 */
export const INSTALLED_APP_FAILURE_REASON_FALLBACK = "Fredo couldn't start this application.";

/**
 * The inventory sentence for a failing row's witness code. Never blank, never an
 * install-time claim — an unrecognised code falls back to the neutral sentence.
 */
export function installedAppFailureReason(code: unknown): string {
  return typeof code === 'string' &&
    Object.prototype.hasOwnProperty.call(INSTALLED_APP_FAILURE_REASON, code)
    ? INSTALLED_APP_FAILURE_REASON[code as InstalledAppRefusalCode]!
    : INSTALLED_APP_FAILURE_REASON_FALLBACK;
}
