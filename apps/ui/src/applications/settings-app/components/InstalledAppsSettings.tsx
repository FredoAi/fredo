/**
 * Settings → Installed applications (Spec #3147, ST-6; UI/UX §3.1; Spec #3146
 * adds the consent section; Spec #3144 adds the lifecycle state and the three
 * management controls).
 *
 * The settings half of the two entry points the acceptance criteria describe:
 * choose a package, read the named refusal, and — since #3144 — see each
 * installed application's state, turn it off or on, or remove it. This pane is
 * still a **registry view, not an open surface** — installed applications are
 * opened from the launcher (§3.2), so there is exactly one open path and
 * therefore exactly one place that renders an open failure. The row's controls
 * are only **off / on / remove**; there is deliberately no Open control here.
 *
 * # Anatomy, in DOM order (§3.1, plus #3146's consent section and #3144's state)
 *
 * 1. Header + the one-line trust-tier statement.
 * 2. The install action row — the pane's FIRST control.
 * 3. The unsigned-package note, immediately under the button.
 * 4. The verdict slot — install success (`role="status"` polite), an install
 *    refusal, a failed LIST fetch, and (new) a refused MANAGEMENT action
 *    (`installed-apps-action-refusal`, `role="alert"`). The instal-verdict pair
 *    still has exactly one member with content; the action-refusal is its own
 *    slot beneath it.
 * 5. The list (`role="list"`) with one `installed-apps-entry` per application —
 *    identity, state word, failure reason and the row's own controls — then the
 *    inventory legend (`installed-apps-state-legend`), rendered iff the list is
 *    non-empty. The list is NOT rendered when empty (the shipped absence rule).
 * 6. The grants section (`What each application can reach`) — one row per
 *    application, one line per **declared** capability, tagged `ordinary` /
 *    `high-risk`. Never inside an entry row: the management controls live in the
 *    row, the consent controls live here, and they never mix.
 * 7. The v1 limitations block — always visible, never dismissible, not focusable.
 *
 * # States
 *
 * `loading` (three Skeleton rows), `empty`, `populated`, `refusal`, `success`,
 * `list-load-failed`, plus #3144's refused-management-action state. A refusal
 * never leaves a control disabled or spinning (`finally` clears the in-flight
 * flag whichever way the call went) — R-3.5.
 *
 * # A state change is CONFIRMED, not optimistic (#3144, UI/UX §4; G-475)
 *
 * The state word is a claim about the HOST'S RECORD, so it flips only on the
 * command's returned entry — never before. The pressed control still
 * acknowledges synchronously (`loading` + disabled in the same frame), and every
 * OTHER control stays live.
 *
 * # The absent-key rule at the render boundary (G-413)
 *
 * `description` and `failureCode` arrive as ABSENT KEYS when unset, so each
 * renders only when present — a `null`/`undefined` never reaches the DOM.
 * `capabilities` is the opposite guarantee: ALWAYS present, read directly.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  Heading,
  HStack,
  Icon,
  Skeleton,
  Text,
  VStack,
} from '@chakra-ui/react';
import {
  LuCircleAlert,
  LuCircleCheck,
  LuPackageOpen,
  LuPackagePlus,
  LuPowerOff,
  LuShieldCheck,
  LuShieldOff,
} from 'react-icons/lu';

import { tint } from '../../../shared/utils/colorTint';
import {
  disableInstalledApp,
  enableInstalledApp,
  grantCapabilityConsent,
  installPackage,
  installedAppErrorFrom,
  removeInstalledApp,
  revokeCapabilityConsent,
} from '../../../shared/installed-apps/client';
import {
  declaredCapabilityCopy,
  HIGH_RISK_CAPABILITY_IDS,
} from '../../../shared/installed-apps/capabilityRefusals';
import { installedAppFailureReason } from '../../../shared/installed-apps/failureReasons';
import { InstalledAppRefusal } from '../../../shared/installed-apps/RefusalBlocks';
import { refusalCopy } from '../../../shared/installed-apps/refusals';
import {
  forgetInstalledApp,
  recordInstalledApp,
  refreshInstalledApps,
  replaceInstalledApp,
} from '../../../shared/installed-apps/store';
import { useInstalledAppsStatus } from '../../../shared/installed-apps/useInstalledApps';
import type {
  InstalledAppCapabilityStatus,
  InstalledAppEntry,
  InstalledAppError,
  InstalledAppLifecycleState,
  InstalledAppRefusalCode,
} from '../../../shared/installed-apps/types';
import { RemoveInstalledAppDialog } from './RemoveInstalledAppDialog';

/** The install button's visible label — the accessible name, verbatim (three ASCII dots). */
export const INSTALL_BUTTON_LABEL = 'Install application package...';

/** The unsigned-package note (UI/UX §8(i)) — verbatim, always visible. */
export const UNSIGNED_PACKAGE_NOTE =
  "Fredo doesn't verify who built a package. Install only packages you trust.";

/** The empty state's headline (UI/UX §5). */
export const EMPTY_HEADLINE = 'No applications installed yet.';

/** The empty state's next-action line — the pane is never a dead end. */
export const EMPTY_NEXT_ACTION = 'Install a package (a .zip file) to add one.';

/** The v1 limitations heading (UI/UX §8(ii)). */
export const LIMITATIONS_HEADING = 'Not yet supported for installed applications';

/** The v1 limitations sentence (UI/UX §8(ii)) — verbatim. */
export const LIMITATIONS_SENTENCE =
  "They open in their own window and can't be placed as in-window panels. They don't take part in Fredo's keyboard navigation, so they have no shortcuts of their own.";

/** The success strip's sentence — it names the destination, because this pane is not an open surface. */
export function installSuccessSentence(displayName: string): string {
  return `${displayName} is installed. Open it from the launcher, under Installed apps.`;
}

// ── The lifecycle state (Spec #3144, UI/UX §2.2) ────────────────────────────

/**
 * The visible WORD per state — the ONLY carrier of the state (the glyph shape
 * and tint reinforce it; nothing is carried by colour alone). These words are
 * the binding spelling (`data-app-state` vs word):
 *
 *   working  → "Working"      (a claim about Fredo's RECORD, never that it runs)
 *   failing  → "Failing"
 *   disabled → "Turned off"
 */
export const STATE_WORDS: Record<InstalledAppLifecycleState, string> = {
  working: 'Working',
  failing: 'Failing',
  disabled: 'Turned off',
};

/**
 * The inventory legend (Adjudication §8; the G-475 mitigation) — ONE muted line
 * framing the three words as Fredo's record, so `Working` is never read as a
 * liveness promise.
 */
export const STATE_LEGEND_LINE =
  'Working — Fredo has no record of a problem. Failing — Fredo couldn\u2019t start it. Turned off — you turned it off.';

/** The muted helper shown under a `disabled` row (only true while it is off). */
export const DISABLED_HELPER_LINE = "It can't be opened while it's turned off.";

/** The turn-off control's accessible name (contains the visible label). */
export function turnOffLabel(displayName: string): string {
  return `Turn off ${displayName}`;
}

/** The turn-on control's accessible name (contains the visible label). */
export function turnOnLabel(displayName: string): string {
  return `Turn on ${displayName}`;
}

/** The remove control's accessible name (contains the visible label). */
export function removeLabel(displayName: string): string {
  return `Remove ${displayName}`;
}

/**
 * The management-action refusal copy (#3144) — the ONLY override of the shipped
 * install/open vocabulary in this pane.
 *
 * A refused disable/enable/remove reuses the frozen codes (`io_error`,
 * `id_not_installed`; R-8.2 — no 23rd code). But two of `INSTALL_REFUSAL_COPY`'s
 * sentences describe an INSTALL/OPEN refusal and would be FALSE in this context
 * (the copy-honesty ruling; R-10.10):
 *
 *   - `io_error` → "Fredo couldn't finish that install." — nothing was installed;
 *   - `id_not_installed` → "That application isn't installed any more."
 *
 * The override supplies honest sentences for exactly those two; every OTHER code
 * keeps the shipped sentence (so the ONE refusal vocabulary is unchanged, and
 * `refusals.ts` stays the install/open authority).
 */
export const MANAGEMENT_REFUSAL_COPY_OVERRIDES: Partial<
  Record<InstalledAppRefusalCode, string>
> = {
  io_error: "Fredo couldn't complete that change.",
  id_not_installed: 'That application is no longer in the installed list.',
};

/** The honest sentence for a refused management action (override, else shipped). */
export function managementRefusalCopy(code: InstalledAppRefusalCode): string {
  return MANAGEMENT_REFUSAL_COPY_OVERRIDES[code] ?? refusalCopy(code);
}

// ── The grants section's copy (Spec #3146 + #3144 adjudication) — verbatim ──

/**
 * The grants section's heading (Adjudication 10.3 — the shipped
 * `'Extra permissions'` is SUPERSEDED: a claim about the high-risk half only,
 * false once the section is widened to ALL declared capabilities). The constant
 * NAME and the element id are retained for import/hook stability.
 */
export const CONSENT_SECTION_HEADING = 'What each application can reach';

/** The grants section's intro (Adjudication 10.3) — a claim about all declarations. */
export const CONSENT_SECTION_INTRO =
  'Every application declares what it needs. It can only reach what it declared for itself. Anything that can change data or run programs is refused until you allow it, for that application only.';

/** The scope line — KEPT verbatim (Adjudication 10.3). */
export const CONSENT_SCOPE_LINE = 'Allowing or revoking here never removes an application or its data.';

/** The chip's state word when the pair is consented (the TEXT is the state). */
export const CONSENT_STATE_ALLOWED = 'Allowed';

/** The chip's state word when the pair is not consented — the default, and neutral. */
export const CONSENT_STATE_NOT_ALLOWED = 'Not allowed';

/** R-4.4's timing guarantee, and nothing else (it is NOT a claim the app is running). */
export const CONSENT_ENABLED_LINE =
  'The application can use this from its next request. No restart needed.';

/** R-4.3: the application's requests are refused until the user allows it. */
export const CONSENT_BLOCKED_LINE =
  "The application's requests for this are refused until you allow it.";

/** The grant control's visible label. */
export const ALLOW_BUTTON_TEXT = 'Allow';

/** The revoke control's visible label. */
export const REVOKE_BUTTON_TEXT = 'Revoke';

/**
 * The line shown for a declared capability id this build cannot name.
 *
 * Never a reason to omit the id: silently dropping a declared grant decision is
 * the worst reachable failure of this surface.
 */
export const UNKNOWN_CAPABILITY_LINE =
  "Fredo doesn't know what this permission allows, so it stays refused.";

/** The class tag on an ordinary declared line (TEXT, never colour alone). */
export const ORDINARY_CLASS_TAG = 'Ordinary access';

/** The class tag on a high-risk declared line (TEXT, never colour alone). */
export const HIGH_RISK_CLASS_TAG = 'Extra permission';

/** The line a row shows when the application declares NO capability (Adjudication 10.1). */
export const GRANTS_EMPTY_LINE = 'This application asked for no access.';

/** The allow control's accessible name: the application, the capability's consequence. */
export function allowConsentLabel(displayName: string, verb: string): string {
  return `Allow ${displayName} to ${verb}`;
}

/** The revoke control's accessible name (contains the visible label verbatim). */
export function revokeConsentLabel(displayName: string, verb: string): string {
  return `Revoke permission for ${displayName} to ${verb}`;
}

/**
 * One consent row's `data-consent-state` (Adjudication 10.2): the value the
 * widened section MUST report. The shipped `every()`-on-empty returned a
 * misleading `allowed` for an app with NO high-risk capability — that app is now
 * `none`.
 */
export function consentStateValue(
  status: InstalledAppCapabilityStatus,
): 'allowed' | 'not-allowed' | 'none' {
  if (status.highRisk.length === 0) return 'none';
  return status.highRisk.every((capability) => status.consented.includes(capability))
    ? 'allowed'
    : 'not-allowed';
}

/**
 * The in-flight key for one (application, capability) pair.
 *
 * Keyed by the PAIR — never by the consent state — so a toggle changes the same
 * DOM node's label in place and focus is never lost mid-interaction.
 */
function consentPairKey(appId: string, capability: string): string {
  return `${appId}\u0000${capability}`;
}

type Verdict =
  | { readonly kind: 'success'; readonly entry: InstalledAppEntry }
  | { readonly kind: 'refusal'; readonly error: InstalledAppError }
  | null;

/** The state chip — the ONE state node per row (glyph shape + tint reinforce the word). */
const StateChip: React.FC<{ state: InstalledAppLifecycleState }> = ({ state }) => {
  const config: Record<
    InstalledAppLifecycleState,
    { glyph: React.ElementType; bg: string; borderColor: string; iconColor: string }
  > = {
    working: {
      glyph: LuCircleCheck,
      bg: tint('var(--status-success)', 12),
      borderColor: 'border.subtle',
      iconColor: 'var(--status-success)',
    },
    failing: {
      glyph: LuCircleAlert,
      bg: tint('var(--status-error)', 10),
      borderColor: 'status.errorStrong',
      iconColor: 'status.errorStrong',
    },
    disabled: {
      glyph: LuPowerOff,
      bg: 'bg.subtle',
      borderColor: 'border.subtle',
      iconColor: 'fg.muted',
    },
  };
  const { glyph, bg, borderColor, iconColor } = config[state];
  return (
    <HStack
      data-testid="installed-apps-entry-state"
      mt={0.5}
      px={2}
      py={0.5}
      flexShrink={0}
      display="inline-flex"
      borderRadius="full"
      borderWidth="1px"
      borderColor={borderColor}
      bg={bg}
      gap={1}
    >
      <Icon as={glyph} boxSize="3.5" aria-hidden="true" color={iconColor} />
      <Text fontSize="xs" fontWeight={600} color="fg.default">
        {STATE_WORDS[state]}
      </Text>
    </HStack>
  );
};

interface InstalledAppRowProps {
  entry: InstalledAppEntry;
  /** The pane-wide management action is in flight for THIS app. */
  busy: boolean;
  onToggle: (entry: InstalledAppEntry) => void;
  onRemove: (entry: InstalledAppEntry) => void;
  /** Registers the row's state-toggle control for post-removal focus hand-off. */
  registerToggle: (id: string, node: HTMLButtonElement | null) => void;
}

/** One row: identity, state, failure reason and the row's own management controls. */
const InstalledAppRow: React.FC<InstalledAppRowProps> = ({
  entry,
  busy,
  onToggle,
  onRemove,
  registerToggle,
}) => {
  const isDisabled = entry.state === 'disabled';
  return (
    <HStack
      role="listitem"
      data-testid="installed-apps-entry"
      data-app-id={entry.id}
      data-app-state={entry.state}
      px={5}
      py={3}
      gap={3}
      align="flex-start"
      borderBottom="1px solid"
      borderColor="border.subtle"
    >
      <Icon
        as={LuPackageOpen}
        boxSize="18px"
        color="fg.muted"
        aria-hidden="true"
        flexShrink={0}
        mt="0.5"
      />
      <Box minW={0} flex="1">
        <HStack gap={2} align="flex-start">
          {/* The ONE ellipsizing child (the shipped AppRow convention — G-274). */}
          <Text fontWeight={600} color="fg.default" lineClamp={1} minW={0}>
            {entry.displayName}
          </Text>
          <StateChip state={entry.state} />
        </HStack>
        <Text fontFamily="mono" fontSize="xs" color="fg.muted" lineClamp={1}>
          {entry.id} @ {entry.version}
          {entry.enginesFredo ? ` · Fredo ${entry.enginesFredo}` : ''}
        </Text>
        {/* Present-key only: an absent description never becomes a DOM value. */}
        {entry.description !== undefined ? (
          <Text fontSize="xs" color="fg.muted" lineClamp={2} mt={0.5}>
            {entry.description}
          </Text>
        ) : null}
        {/* Present iff failing; the code is the machine witness, the sentence is
            the inventory's own copy (never an install-time claim — Adjudication 10.4). */}
        {entry.state === 'failing' ? (
          <HStack
            data-testid="installed-apps-entry-failure"
            data-failure-code={entry.failureCode ?? ''}
            mt={1}
            gap={1.5}
            align="flex-start"
          >
            <Icon
              as={LuCircleAlert}
              boxSize="3.5"
              color="status.errorStrong"
              aria-hidden="true"
              flexShrink={0}
              mt="0.5"
            />
            <Text fontSize="xs" color="fg.default">
              {installedAppFailureReason(entry.failureCode)}
            </Text>
          </HStack>
        ) : null}
        {isDisabled ? (
          <Text fontSize="xs" color="fg.muted" mt={0.5}>
            {DISABLED_HELPER_LINE}
          </Text>
        ) : null}
      </Box>
      <HStack gap={2} flexShrink={0} alignSelf="flex-start">
        {/* ONE control in ONE DOM slot — its testid and label swap on state, so a
            toggle never reflows the row and focus is never lost. Only THIS control
            acknowledges (loading + disabled); no other control is touched. */}
        <Button
          ref={(node) => registerToggle(entry.id, node)}
          size="sm"
          data-testid={isDisabled ? 'installed-apps-enable' : 'installed-apps-disable'}
          aria-label={isDisabled ? turnOnLabel(entry.displayName) : turnOffLabel(entry.displayName)}
          loading={busy}
          disabled={busy}
          onClick={() => onToggle(entry)}
        >
          {isDisabled ? 'Turn on' : 'Turn off'}
        </Button>
        <Button
          size="sm"
          data-testid="installed-apps-remove"
          aria-label={removeLabel(entry.displayName)}
          onClick={() => onRemove(entry)}
        >
          Remove
        </Button>
      </HStack>
    </HStack>
  );
};

export const InstalledAppsSettings: React.FC = () => {
  const status = useInstalledAppsStatus();
  const [installing, setInstalling] = useState(false);
  const [verdict, setVerdict] = useState<Verdict>(null);
  // Consent lives for this mount only: the next pane open re-reads the projection
  // from disk, which is the same authority (UI/UX §8).
  const [consentOverrides, setConsentOverrides] = useState<
    Readonly<Record<string, InstalledAppCapabilityStatus>>
  >({});
  const [consentInFlight, setConsentInFlight] = useState<ReadonlySet<string>>(() => new Set());
  const [consentError, setConsentError] = useState<InstalledAppError | null>(null);

  // #3144 management state.
  const [manageBusyId, setManageBusyId] = useState<string | null>(null);
  const [actionRefusal, setActionRefusal] = useState<InstalledAppError | null>(null);
  const [removalTarget, setRemovalTarget] = useState<InstalledAppEntry | null>(null);

  const installButtonRef = useRef<HTMLButtonElement | null>(null);
  const toggleRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());
  const registerToggle = useCallback((id: string, node: HTMLButtonElement | null) => {
    if (node) toggleRefs.current.set(id, node);
    else toggleRefs.current.delete(id);
  }, []);

  // The panel asks for the list when it mounts — nothing reads the registry at
  // startup (R-5.5). A plain `[]` dependency: the store notifies subscribers on
  // its own, so a store update never re-runs this effect (the #523 loop class).
  useEffect(() => {
    void refreshInstalledApps();
  }, []);

  const handleInstall = useCallback(async () => {
    if (installing) return;
    setInstalling(true);
    // The picker opens only after the button has acknowledged the click; the
    // verdict slot is emptied so the next attempt's result is the only verdict.
    setVerdict(null);
    try {
      const entry = await installPackage();
      recordInstalledApp(entry);
      setVerdict({ kind: 'success', entry });
    } catch (rejection) {
      setVerdict({ kind: 'refusal', error: installedAppErrorFrom(rejection) });
    } finally {
      // R-3.5: a refusal is data on screen, never a wedged install surface.
      setInstalling(false);
    }
  }, [installing]);

  // ── #3144 — the three management actions ──────────────────────────────────

  const handleToggle = useCallback(
    async (entry: InstalledAppEntry) => {
      if (manageBusyId !== null) return;
      setActionRefusal(null);
      setManageBusyId(entry.id);
      try {
        const next =
          entry.state === 'disabled'
            ? await enableInstalledApp(entry.id)
            : await disableInstalledApp(entry.id);
        // The command's returned entry is the authority for the row's state.
        replaceInstalledApp(next);
      } catch (rejection) {
        // Nothing was painted optimistically, so there is nothing to roll back.
        setActionRefusal(installedAppErrorFrom(rejection));
      } finally {
        // A refusal is data on screen, never a wedged control.
        setManageBusyId(null);
      }
    },
    [manageBusyId],
  );

  const handleRemoveRequest = useCallback((entry: InstalledAppEntry) => {
    setActionRefusal(null);
    setRemovalTarget(entry);
  }, []);

  const handleRemoveCancel = useCallback(() => {
    if (manageBusyId !== null) return;
    setRemovalTarget(null);
  }, [manageBusyId]);

  const handleRemoveConfirm = useCallback(async () => {
    const target = removalTarget;
    if (target === null || manageBusyId !== null) return;
    // The focus hand-off target is resolved BEFORE the row leaves the list.
    const rows = status.entries;
    const index = rows.findIndex((candidate) => candidate.id === target.id);
    const nextId = index >= 0 && index + 1 < rows.length ? rows[index + 1].id : null;

    setManageBusyId(target.id);
    try {
      await removeInstalledApp(target.id);
      setRemovalTarget(null);
      forgetInstalledApp(target.id);
      // Never leave focus on a detached node: the next row's toggle, else install.
      const frame = window.requestAnimationFrame(() => {
        const nextToggle = nextId ? toggleRefs.current.get(nextId) : null;
        (nextToggle ?? installButtonRef.current)?.focus();
      });
      // Best-effort: cancel the frame if the pane unmounts first.
      void frame;
    } catch (rejection) {
      // The dialog closes on submit; the pane reports the refusal (one slot).
      setRemovalTarget(null);
      setActionRefusal(installedAppErrorFrom(rejection));
    } finally {
      setManageBusyId(null);
    }
  }, [manageBusyId, removalTarget, status.entries]);

  // A local refusal/success wins over a list-read failure: the user's last action
  // is the more specific fact. A list failure is a verdict of its own otherwise.
  const refusal: InstalledAppError | null =
    verdict?.kind === 'refusal' ? verdict.error : status.error;

  const showSkeletons = status.loading && !status.settled;
  const showEmpty = !showSkeletons && status.error === null && status.entries.length === 0;
  const showList = !showSkeletons && status.entries.length > 0;

  // The grants section describes the SAME snapshot the list describes (Adjudication
  // 10.1: it renders when the list is settled and non-empty — EVERY entry gets a
  // row, a row whose app declares nothing renders `grants-empty`). Absent in
  // loading / empty / list-load-failed.
  const showConsent = !showSkeletons && status.entries.length > 0;

  const consentStatusFor = useCallback(
    (entry: InstalledAppEntry): InstalledAppCapabilityStatus =>
      consentOverrides[entry.id] ?? entry.capabilities,
    [consentOverrides],
  );

  const handleConsent = useCallback(
    async (appId: string, capability: string, currentlyAllowed: boolean) => {
      const key = consentPairKey(appId, capability);
      if (consentInFlight.has(key)) return;

      // Synchronous acknowledgement: THIS control acknowledges, nothing else.
      setConsentInFlight((previous) => {
        const next = new Set(previous);
        next.add(key);
        return next;
      });
      setConsentError(null);
      try {
        const next = currentlyAllowed
          ? await revokeCapabilityConsent(appId, capability)
          : await grantCapabilityConsent(appId, capability);
        // The command's returned status is the authority for this row.
        setConsentOverrides((previous) => ({ ...previous, [appId]: next }));
      } catch (rejection) {
        // Nothing was painted optimistically, so there is nothing to roll back.
        setConsentError(installedAppErrorFrom(rejection));
      } finally {
        setConsentInFlight((previous) => {
          const next = new Set(previous);
          next.delete(key);
          return next;
        });
      }
    },
    [consentInFlight],
  );

  return (
    <VStack data-testid="installed-apps-pane" align="stretch" gap={0}>
      {/* 1 — header + the trust-tier statement */}
      <VStack align="stretch" gap={1} px={5} pt={5} pb={3}>
        <Heading as="h2" size="md" fontFamily="heading" color="fg.default">
          Installed applications
        </Heading>
        <Text fontSize="sm" color="fg.muted">
          Applications you added yourself. Each opens in its own window, separate from Fredo.
        </Text>
      </VStack>

      {/* 2 + 3 — the install action and the note that belongs beside it */}
      <VStack align="stretch" gap={1.5} px={5} pb={3}>
        <HStack>
          <Button
            ref={installButtonRef}
            data-testid="installed-apps-install-button"
            size="sm"
            loading={installing}
            disabled={installing}
            onClick={() => void handleInstall()}
            background="var(--accent-primary)"
            color="var(--accent-contrast)"
            _hover={{ opacity: 0.9 }}
          >
            <Icon as={LuPackagePlus} aria-hidden="true" boxSize="4" />
            {INSTALL_BUTTON_LABEL}
          </Button>
        </HStack>
        <Text fontSize="xs" color="fg.muted">
          {UNSIGNED_PACKAGE_NOTE}
        </Text>
      </VStack>

      {/* 4 — the verdict slot. The install verdict pair is always in the DOM region
          and exactly ONE member has content, so the region never reflows the list.
          A failed list read and a refused management action each render here too. */}
      <Box px={5} pb={2}>
        <Box>
          {refusal ? (
            <InstalledAppRefusal code={refusal.code} detail={refusal.detail} field={refusal.field} />
          ) : null}
        </Box>
        <Box>
          {refusal === null && verdict?.kind === 'success' ? (
            <HStack
              data-testid="installed-apps-install-success"
              role="status"
              aria-live="polite"
              gap={2}
              px={3}
              py={2.5}
              bg={tint('var(--status-success)', 10)}
              borderWidth="1px"
              borderStyle="solid"
              borderColor="border.default"
              borderRadius="md"
            >
              <Icon as={LuCircleCheck} boxSize="4" color="var(--status-success)" aria-hidden="true" />
              <Text fontSize="sm" color="fg.default">
                {installSuccessSentence(verdict.entry.displayName)}
              </Text>
            </HStack>
          ) : null}
        </Box>
        {/* The ONE management-refusal slot (Adjudication 10.7) — a refused
            disable/enable/remove. Never wedges a control (all stay live). */}
        <Box>
          {actionRefusal ? (
            <InstalledAppRefusal
              code={actionRefusal.code}
              detail={actionRefusal.detail}
              field={actionRefusal.field}
              testId="installed-apps-action-refusal"
              reasonText={managementRefusalCopy(actionRefusal.code)}
            />
          ) : null}
        </Box>
      </Box>

      {/* 5 — loading / list (+ legend) / empty */}
      {showSkeletons ? (
        <VStack data-testid="installed-apps-loading" align="stretch" gap={0}>
          {[0, 1, 2].map((row) => (
            <HStack
              key={row}
              px={5}
              py={3}
              gap={4}
              borderBottom="1px solid"
              borderColor="border.subtle"
            >
              <Skeleton boxSize="18px" borderRadius="full" />
              <Skeleton height="14px" width="160px" />
              <Skeleton height="12px" width="200px" ml="auto" />
            </HStack>
          ))}
        </VStack>
      ) : showList ? (
        <>
          <VStack role="list" data-testid="installed-apps-list" align="stretch" gap={0}>
            {status.entries.map((entry) => (
              <InstalledAppRow
                key={entry.id}
                entry={entry}
                busy={manageBusyId === entry.id}
                onToggle={(target) => void handleToggle(target)}
                onRemove={handleRemoveRequest}
                registerToggle={registerToggle}
              />
            ))}
          </VStack>
          {/* The inventory legend — ONE muted line, iff the list is non-empty (Adjudication §8). */}
          <Text
            data-testid="installed-apps-state-legend"
            px={5}
            pt={3}
            fontSize="xs"
            color="fg.muted"
          >
            {STATE_LEGEND_LINE}
          </Text>
        </>
      ) : showEmpty ? (
        <Box
          data-testid="installed-apps-empty"
          role="status"
          px={5}
          py={8}
          display="flex"
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          gap={2}
        >
          <Icon as={LuPackageOpen} boxSize="28px" color="var(--text-secondary)" aria-hidden="true" />
          <Text fontSize="13px" color="fg.muted">
            {EMPTY_HEADLINE}
          </Text>
          <Text fontSize="xs" color="fg.muted">
            {EMPTY_NEXT_ACTION}
          </Text>
        </Box>
      ) : null}

      {/* 6 — the grants section (Spec #3146, widened by #3144). Its OWN section:
          one row per application, one line per DECLARED capability. Never inside
          an entry row — the management controls live in the row, the consent
          controls live here. */}
      {showConsent ? (
        <Box
          as="section"
          data-testid="installed-apps-consent-section"
          aria-labelledby="installed-apps-consent-heading"
          borderTop="1px solid"
          borderColor="border.subtle"
          px={5}
          pt={4}
          pb={3}
        >
          <Heading
            as="h3"
            id="installed-apps-consent-heading"
            size="sm"
            fontFamily="heading"
            color="fg.default"
          >
            {CONSENT_SECTION_HEADING}
          </Heading>
          <Text fontSize="xs" color="fg.muted" mt={1}>
            {CONSENT_SECTION_INTRO}
          </Text>
          <Text fontSize="xs" color="fg.muted" mt={0.5}>
            {CONSENT_SCOPE_LINE}
          </Text>

          {/* S5 — a refused consent command. `role="alert"` because the user did
              not cause it; the shipped install-vocabulary sentence + mono field. */}
          {consentError ? (
            <Box mt={3}>
              <InstalledAppRefusal
                code={consentError.code}
                detail={consentError.detail}
                field={consentError.field}
                testId="installed-apps-consent-refusal"
              />
            </Box>
          ) : null}

          <VStack role="list" align="stretch" gap={0} mt={3}>
            {status.entries.map((entry) => {
              const entryStatus = consentStatusFor(entry);
              return (
                <Box
                  key={entry.id}
                  role="listitem"
                  data-testid="installed-apps-consent-row"
                  data-app-id={entry.id}
                  data-consent-state={consentStateValue(entryStatus)}
                  py={3}
                  borderBottom="1px solid"
                  borderColor="border.subtle"
                >
                  <Text fontSize="sm" fontWeight={600} color="fg.default" lineClamp={1}>
                    {entry.displayName}
                  </Text>
                  <Text fontFamily="mono" fontSize="xs" color="fg.muted" lineClamp={1}>
                    {entry.id}
                  </Text>

                  {entryStatus.declared.length === 0 ? (
                    <Text
                      data-testid="installed-apps-grants-empty"
                      fontSize="sm"
                      color="fg.default"
                      mt={2}
                    >
                      {GRANTS_EMPTY_LINE}
                    </Text>
                  ) : (
                    entryStatus.declared.map((capability) => {
                      // The backend's OWN classification is authoritative; the
                      // known-union check covers a crafted projection carrying an
                      // id this build's union does not know (F-7.29 S8) — it is
                      // still a high-risk line, just with no nameable copy.
                      const isHighRisk =
                        entryStatus.highRisk.includes(capability) ||
                        (HIGH_RISK_CAPABILITY_IDS as readonly string[]).includes(capability);
                      const copy = declaredCapabilityCopy(capability);
                      const allowed = entryStatus.consented.includes(capability);
                      const key = consentPairKey(entry.id, capability);
                      const busy = consentInFlight.has(key);
                      return (
                        <HStack
                          key={key}
                          mt={2}
                          gap={2}
                          align="flex-start"
                          data-capability={capability}
                          data-capability-class={isHighRisk ? 'high-risk' : 'ordinary'}
                        >
                          <Icon
                            as={isHighRisk ? (allowed ? LuShieldCheck : LuShieldOff) : LuCircleCheck}
                            boxSize="4"
                            aria-hidden="true"
                            color={
                              isHighRisk && allowed
                                ? 'var(--status-success)'
                                : isHighRisk
                                  ? 'fg.muted'
                                  : 'fg.muted'
                            }
                            mt="0.5"
                            flexShrink={0}
                          />
                          <Box minW={0} flex="1">
                            {/* The class TAG is TEXT — the AC-4 distinction is never colour alone. */}
                            <Text
                              fontSize="xs"
                              fontWeight={600}
                              color="fg.default"
                              textTransform="uppercase"
                              letterSpacing="0.04em"
                            >
                              {isHighRisk ? HIGH_RISK_CLASS_TAG : ORDINARY_CLASS_TAG}
                            </Text>
                            {/* An id this build cannot name is SHOWN, never filtered out. */}
                            <Text fontSize="sm" color="fg.default">
                              {copy ? copy.consequence : UNKNOWN_CAPABILITY_LINE}
                            </Text>
                            {/* The exact grant, in mono — the readback, never the label. */}
                            <Text fontFamily="mono" fontSize="xs" color="fg.muted" mt={0.5}>
                              {capability}
                            </Text>
                            {/* Only a high-risk grant carries a chip + control; an ordinary
                                declared capability is always held and is never shown as a grant. */}
                            {isHighRisk ? (
                              <>
                                <HStack
                                  mt={1}
                                  px={2}
                                  py={0.5}
                                  display="inline-flex"
                                  borderRadius="full"
                                  borderWidth="1px"
                                  borderColor="border.subtle"
                                  bg={allowed ? tint('var(--status-success)', 12) : 'transparent'}
                                >
                                  <Text fontSize="xs" fontWeight={600} color="fg.default">
                                    {allowed ? CONSENT_STATE_ALLOWED : CONSENT_STATE_NOT_ALLOWED}
                                  </Text>
                                </HStack>
                                <Text
                                  fontSize="xs"
                                  color="fg.muted"
                                  mt={1}
                                  role="status"
                                  aria-live="polite"
                                >
                                  {allowed ? CONSENT_ENABLED_LINE : CONSENT_BLOCKED_LINE}
                                </Text>
                              </>
                            ) : null}
                          </Box>
                          {/* One control per (application, capability) pair, in the SAME
                              DOM slot either way. High-risk + nameable only. */}
                          {isHighRisk && copy ? (
                            <Button
                              size="xs"
                              alignSelf="flex-start"
                              flexShrink={0}
                              data-testid={
                                allowed
                                  ? 'installed-apps-consent-revoke'
                                  : 'installed-apps-consent-grant'
                              }
                              data-app-id={entry.id}
                              data-capability={capability}
                              aria-label={
                                allowed
                                  ? revokeConsentLabel(entry.displayName, copy.verb)
                                  : allowConsentLabel(entry.displayName, copy.verb)
                              }
                              loading={busy}
                              disabled={busy}
                              onClick={() => void handleConsent(entry.id, capability, allowed)}
                            >
                              {allowed ? REVOKE_BUTTON_TEXT : ALLOW_BUTTON_TEXT}
                            </Button>
                          ) : null}
                        </HStack>
                      );
                    })
                  )}
                </Box>
              );
            })}
          </VStack>
        </Box>
      ) : null}

      {/* 7 — the v1 limitations. Always visible, never dismissible, not focusable. */}
      <Box
        data-testid="installed-apps-limitations"
        mx={5}
        my={4}
        px={3}
        py={2.5}
        bg="bg.subtle"
        borderWidth="1px"
        borderStyle="solid"
        borderColor="border.subtle"
        borderRadius="md"
      >
        <Text fontSize="xs" fontWeight={600} color="fg.default">
          {LIMITATIONS_HEADING}
        </Text>
        <Text fontSize="xs" color="fg.muted" mt={1}>
          {LIMITATIONS_SENTENCE}
        </Text>
      </Box>

      {/* AC-3 — the removal confirmation. Rendered only while a target is set. */}
      <RemoveInstalledAppDialog
        entry={removalTarget}
        busy={manageBusyId !== null}
        onCancel={handleRemoveCancel}
        onConfirm={() => void handleRemoveConfirm()}
      />
    </VStack>
  );
};
