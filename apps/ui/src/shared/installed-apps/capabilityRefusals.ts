/**
 * The capability copy contracts (Spec #3146, UI/UX §3): the six-code refusal
 * sentences and the per-high-risk-capability consent copy.
 *
 * # Why two maps, and why no interpolation
 *
 * Every sentence is keyed by CODE / CAPABILITY ID, never by interpolated text, so
 * a unit pin can assert each map exhaustively (`refusals.ts` is the shipped
 * precedent). A sentence stands alone as the category verdict; specifics — which
 * field, which action, which table — come from the host-authored `detail` and
 * render beside it. That split is what stops a copy map from leaking a value the
 * caller did not supply.
 *
 * # Where each map is consumed
 *
 * - `CAPABILITY_CONSENT_COPY` is consumed by the settings consent section: one
 *   consequence sentence plus one verb (the verb appears only inside an
 *   accessible name).
 * - `CAPABILITY_REFUSAL_COPY` has NO host renderer, and that is intentional. The
 *   refusal is raised inside the calling application's own document (a rejected
 *   promise), so a Fredo-rendered refusal would be Fredo attributing a failure it
 *   did not cause. The map's consumers are the exhaustiveness pin, the adversarial
 *   fixture packages' in-app display, and the app-author reference.
 *
 * # Copy rules this file must keep (checkable by grep)
 *
 * 1. No verification and no safety vocabulary — `verified`, `signed`, `publisher`,
 *    `trusted author`, `safe`, `secure`, `sandbox`, `read-only`.
 * 2. No blanket scope: `allow` / `grant` / `revoke` never stand alone — each is
 *    used with an application and a capability in the same sentence or name.
 * 3. The application is never the speaker of a Fredo claim.
 * 4. `scope_denied` copy never names or implies another application.
 */

import type {
  CapabilityRefusalCode,
  HighRiskCapabilityId,
} from './types';

/**
 * The six authority refusal sentences — the app-side display copy.
 *
 * Third person about the application (they render INSIDE that application's
 * document), and never a claim that a refusal was a judgement about the package's
 * author.
 */
export const CAPABILITY_REFUSAL_COPY: Record<CapabilityRefusalCode, string> = {
  action_not_declared:
    "This application's package doesn't include that action, so Fredo refused it.",
  action_not_grantable:
    "That action can't be given to an installed application, so Fredo refused it.",
  consent_required:
    "You haven't allowed this application to do that yet. Allow it in Settings → Installed applications.",
  scope_denied:
    'This application can only reach the data it declared for itself, so Fredo refused that request.',
  caller_unknown:
    "Fredo couldn't tell which application was calling, so it refused the request.",
  app_not_installed: "This application isn't installed any more, so Fredo refused the request.",
};

/**
 * The sentence for a code this build does not recognise (an older app bundle
 * against a newer host). Never blank, and the promise still rejects.
 */
export const CAPABILITY_REFUSAL_FALLBACK =
  "Fredo refused that action for a reason this application doesn't recognise.";

/** The sentence for a refusal code, with the unknown-code fallback. */
export function capabilityRefusalCopy(code: unknown): string {
  return typeof code === 'string' &&
    Object.prototype.hasOwnProperty.call(CAPABILITY_REFUSAL_COPY, code)
    ? CAPABILITY_REFUSAL_COPY[code as CapabilityRefusalCode]
    : CAPABILITY_REFUSAL_FALLBACK;
}

/** One consent line's copy: what the capability unlocks, and the verb for names. */
export interface CapabilityConsentCopy {
  /**
   * The row's body sentence — what allowing this capability actually lets the
   * application do, bound to the shipped command body rather than assumed.
   */
  readonly consequence: string;
  /**
   * The action phrase used ONLY inside an accessible name
   * (`Allow <application> to <verb>`), never as the visible label.
   */
  readonly verb: string;
}

/**
 * The consent copy for every consentable capability.
 *
 * `Record<HighRiskCapabilityId, …>` is the compile-time guarantee: a new
 * `high-risk.*` id added to `CapabilityId` fails the typecheck until it has a
 * consequence sentence here, so a dangerous capability can never reach the
 * consent surface as a bare id.
 *
 * `data.tables` is deliberately NOT a key: it is never consentable and is never
 * rendered in the consent section.
 */
export const CAPABILITY_CONSENT_COPY: Record<HighRiskCapabilityId, CapabilityConsentCopy> = {
  'high-risk.database-query': {
    consequence:
      'Run any SQL against the database connections you have open in Fredo — including statements that change or delete data.',
    verb: 'run any SQL against the database connections you have open in Fredo',
  },
  'high-risk.database-reset': {
    consequence:
      "Delete Fredo's database and start an empty one. Your recorded sessions and activity live there, so this erases them.",
    verb: "delete Fredo's database and start an empty one",
  },
  'high-risk.process-spawn': {
    consequence:
      'Start a terminal session on your computer, in a folder of its choosing. A plain shell session can run any command there, and an agent session can change your files.',
    verb: 'start a terminal session on your computer',
  },
};

/**
 * The consent copy for a declared capability id, or `null` when this build
 * cannot name it.
 *
 * `null` is NOT a filter: an id this build does not recognise must still be
 * SHOWN (raw id + the unknown-permission line, no control), because silently
 * omitting a declared high-risk grant hides a decision from the user.
 */
export function consentCopyFor(capability: string): CapabilityConsentCopy | null {
  return Object.prototype.hasOwnProperty.call(CAPABILITY_CONSENT_COPY, capability)
    ? CAPABILITY_CONSENT_COPY[capability as HighRiskCapabilityId]
    : null;
}
