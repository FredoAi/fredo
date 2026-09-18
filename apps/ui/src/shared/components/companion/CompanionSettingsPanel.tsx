import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box, HStack, Heading, Icon, Text, VStack, Switch, NumberInput, chakra,
} from '@chakra-ui/react';
import { LuBot } from 'react-icons/lu';
import {
  useCompanion, MIN_IDLE_TIMEOUT_S, MAX_IDLE_TIMEOUT_S, clampIdleTimeout,
  clampReplyLeaveGraceMs, MIN_REPLY_LEAVE_GRACE_MS, MAX_REPLY_LEAVE_GRACE_MS,
  REPLY_LEAVE_GRACE_STEP_MS,
} from '../../contexts/CompanionContext';
import type { CompanionSendDisposition } from '../../contexts/CompanionContext';
import { CompanionSetupWizard } from './CompanionSetupWizard';
import type { CompanionSetupWizardPrerequisite } from './CompanionSetupWizard';
import { COMPANION_SETUP_STEPS } from './companionSetupSteps';
import { useCompanionReadiness } from './useCompanionReadiness';
import type { PrerequisiteUiState } from './companionReadiness';
import { VoiceInputSettings } from './VoiceInputSettings';

// ── Helpers ──────────────────────────────────────────────────────────────────

const COMPANION_SETTINGS_HEADING_ID = 'companion-settings-heading';

/** Uppercase mini-label for a settings group — a label, never a heading (#2864 H4). */
const sectionLabel = (text: string) => (
  <Text
    fontSize="xs"
    fontWeight="700"
    color="var(--text-subtle)"
    letterSpacing="wider"
    textTransform="uppercase"
    mb={2}
  >
    {text}
  </Text>
);

// ── Idle auto-return control (#2853 ST-5) ────────────────────────────────────

/** Stepper increment for the idle timeout (seconds). */
const IDLE_TIMEOUT_STEP_S = 5;
const IDLE_TIMEOUT_INPUT_ID = 'companion-idle-timeout-seconds';
const IDLE_TIMEOUT_HELP_ID = 'companion-idle-timeout-help';
/** How long the transient commit confirmation stays in the live region. */
const IDLE_COMMIT_CONFIRMATION_MS = 2500;

// ── Send-during-reply + reply hold-open grace (#2892 ST-6) ───────────────────
// The two AC8/AC9 controls inside the SAME "Behavior" group, after the idle
// auto-return row. Both commit immediately (no Save footer) and announce through
// ONE shared polite live region.

/** Frozen accessibility ids (QA-bound — do not rename). */
const SEND_DURING_REPLY_INPUT_ID = 'companion-send-during-reply';
const SEND_DURING_REPLY_HELP_ID = 'companion-send-during-reply-help';
const REPLY_GRACE_INPUT_ID = 'companion-reply-leave-grace';
const REPLY_GRACE_HELP_ID = 'companion-reply-leave-grace-help';

/** Shared commit confirmation lifetime (matches the idle control's region). */
const SETTINGS_COMMIT_CONFIRMATION_MS = 2500;

/** Exact copy (UI/UX §1d/§5) — sentence case, no exclamation marks. */
const SEND_DURING_REPLY_LABEL = 'Sending while Fredo is replying';
const SEND_DURING_REPLY_HELP =
  'Choose what happens when you send a message before Fredo finishes the last one.';
const SEND_DURING_REPLY_OPTION_QUEUE = 'Queue until Fredo finishes';
const SEND_DURING_REPLY_OPTION_INTERRUPT = 'Interrupt and send now';

const REPLY_GRACE_LABEL = 'Keep replies open after the pointer leaves';
/** The `aria-label` names the FIELD unit; the visible label stays unit-free. */
const REPLY_GRACE_ARIA_LABEL = `${REPLY_GRACE_LABEL} (seconds)`;
const REPLY_GRACE_HELP =
  'Fredo keeps a finished reply on screen for this long after your pointer leaves it.';
const REPLY_GRACE_UNIT = 's';

/** SECONDS are the editing unit; the persisted value is integer milliseconds. */
const REPLY_GRACE_MIN_S = MIN_REPLY_LEAVE_GRACE_MS / 1000;
const REPLY_GRACE_MAX_S = MAX_REPLY_LEAVE_GRACE_MS / 1000;
const REPLY_GRACE_STEP_S = REPLY_LEAVE_GRACE_STEP_MS / 1000;

const sendDuringReplyOptionLabel = (disposition: CompanionSendDisposition): string =>
  (disposition === 'interrupt' ? SEND_DURING_REPLY_OPTION_INTERRUPT : SEND_DURING_REPLY_OPTION_QUEUE);

export const CompanionSettingsPanel: React.FC = () => {
  const {
    state, setVisible, idleTimeoutSeconds, setIdleTimeoutSeconds,
    sendDuringReply, setSendDuringReply, replyLeaveGraceMs, setReplyLeaveGraceMs,
  } = useCompanion();
  const { isVisible } = state;

  // Readiness gate (#2855): the backend is authoritative. While not ready — and
  // while the first probe is still in flight — the wizard is the ONLY content.
  const {
    readiness, checking, refresh, runAction, runningActionId, actionError, modelFiles,
    serverLaunch, sttModel, sttDevices, refreshSttDevices,
  } = useCompanionReadiness();

  // ── Idle auto-return duration (#2853 ST-5) ─────────────────────────────────
  // A local draft mirrors the persisted value while the user edits; the value is
  // written ONLY on commit (blur / Enter / stepper), never per keystroke.
  // `setIdleTimeoutSeconds` clamps (default 60, range [5, 3600]) so a cleared /
  // non-numeric / out-of-range entry heals instead of wedging the timer.
  const [idleDraft, setIdleDraft] = useState<string>(String(idleTimeoutSeconds));
  const idleDraftRef = useRef<string>(String(idleTimeoutSeconds));
  // Transient commit confirmation announced via the polite live region (#2864 ST-3).
  const [idleCommitMessage, setIdleCommitMessage] = useState('');

  // Re-sync the draft whenever the persisted value changes (async load on mount,
  // or a clamp applied on commit). The ref keeps stepper commits from going stale.
  useEffect(() => {
    const next = String(idleTimeoutSeconds);
    idleDraftRef.current = next;
    setIdleDraft(next);
  }, [idleTimeoutSeconds]);

  // Clear the transient confirmation shortly after a commit announces it.
  useEffect(() => {
    if (!idleCommitMessage) return undefined;
    const timer = setTimeout(() => setIdleCommitMessage(''), IDLE_COMMIT_CONFIRMATION_MS);
    return () => clearTimeout(timer);
  }, [idleCommitMessage]);

  const handleIdleChange = useCallback((value: string) => {
    idleDraftRef.current = value;
    setIdleDraft(value);
  }, []);

  const commitIdleTimeout = useCallback((raw: string) => {
    // NaN / empty (Number('') === 0) / non-positive → default; else round + clamp.
    // `clampIdleTimeout` is the exact guard `setIdleTimeoutSeconds` applies, so the
    // announced value is the value that was persisted.
    const resolved = clampIdleTimeout(Number(raw));
    setIdleTimeoutSeconds(resolved);
    setIdleCommitMessage(`Auto-return set to ${resolved} s`);
  }, [setIdleTimeoutSeconds]);

  // ── Send-during-reply disposition + reply hold-open grace (#2892 ST-6) ─────
  // The disposition commits on change. The grace mirrors the idle draft/commit
  // pattern (persist ONLY on blur / Enter / stepper, never per keystroke). Both
  // announce through ONE shared polite live region, cleared after 2500 ms.
  const [graceDraft, setGraceDraft] = useState<string>(String(replyLeaveGraceMs / 1000));
  const graceDraftRef = useRef<string>(String(replyLeaveGraceMs / 1000));
  const [commitMessage, setCommitMessage] = useState('');

  // Re-sync the draft whenever the persisted grace changes (async load on mount,
  // or a clamp applied on commit). The ref keeps stepper commits from going stale.
  useEffect(() => {
    const next = String(replyLeaveGraceMs / 1000);
    graceDraftRef.current = next;
    setGraceDraft(next);
  }, [replyLeaveGraceMs]);

  // Clear the shared transient confirmation shortly after a commit announces it.
  useEffect(() => {
    if (!commitMessage) return undefined;
    const timer = setTimeout(() => setCommitMessage(''), SETTINGS_COMMIT_CONFIRMATION_MS);
    return () => clearTimeout(timer);
  }, [commitMessage]);

  const commitSendDuringReply = useCallback((disposition: CompanionSendDisposition) => {
    setSendDuringReply(disposition);
    setCommitMessage(
      `${SEND_DURING_REPLY_LABEL} set to ${sendDuringReplyOptionLabel(disposition)}`,
    );
  }, [setSendDuringReply]);

  const handleGraceChange = useCallback((value: string) => {
    graceDraftRef.current = value;
    setGraceDraft(value);
  }, []);

  const commitGrace = useCallback((raw: string) => {
    // The field is SECONDS; the persisted setting is integer milliseconds. The
    // clamp heals a cleared / non-numeric / out-of-range entry, and the resolved
    // value is exactly what `setReplyLeaveGraceMs` stores, so the announcement is
    // the persisted truth.
    const resolvedMs = clampReplyLeaveGraceMs(Math.round(Number(raw) * 1000));
    setReplyLeaveGraceMs(resolvedMs);
    setCommitMessage(`Reply hold-open grace set to ${resolvedMs / 1000} s`);
  }, [setReplyLeaveGraceMs]);

  // Invalid draft: non-numeric / outside [0, 60] seconds. The clamp still heals
  // the persisted value on commit; this only drives the editing treatment.
  const parsedGraceDraft = Number(graceDraft);
  const isGraceDraftInvalid = !Number.isFinite(parsedGraceDraft)
    || parsedGraceDraft < REPLY_GRACE_MIN_S
    || parsedGraceDraft > REPLY_GRACE_MAX_S;
  const graceBorderColor = isGraceDraftInvalid ? 'var(--status-error)' : 'var(--border-color)';
  const graceHighlightColor = isGraceDraftInvalid
    ? 'var(--status-error)'
    : 'var(--accent-primary)';

  const isReady = !checking && readiness?.ready === true;

  // Invalid draft: non-numeric / cleared (Number('') === 0) / outside [5, 3600].
  // The clamp still heals the persisted value on commit; this only drives the
  // visible editing treatment (H8).
  const parsedIdleDraft = Number(idleDraft);
  const isIdleDraftInvalid = !Number.isFinite(parsedIdleDraft)
    || parsedIdleDraft < MIN_IDLE_TIMEOUT_S
    || parsedIdleDraft > MAX_IDLE_TIMEOUT_S;
  const idleBorderColor = isIdleDraftInvalid ? 'var(--status-error)' : 'var(--border-color)';
  const idleHighlightColor = isIdleDraftInvalid ? 'var(--status-error)' : 'var(--accent-primary)';

  // ── Voice input (#2876 ST-5 → #2877 ST-4) ──────────────────────────────────
  // The voice group is informational: it NEVER gates this panel (the readiness
  // gate above is fed by the backend + serverLaunch only). `sttModel` is optional
  // — null when the probe is unavailable.
  const sttRunning = runningActionId === 'sttModel';

  if (!isReady) {
    // While checking (or not ready), render ONLY the wizard — never the toggle
    // or the Teleport tip (AC-1 / REQ-6). During the first probe, derive the
    // steps from the registry so each row shows its `checking` state.
    const prerequisites: CompanionSetupWizardPrerequisite[] = checking
      ? COMPANION_SETUP_STEPS.map((step) => ({
          id: step.id,
          uiState: 'checking' as PrerequisiteUiState,
        }))
      : (readiness?.prerequisites ?? []).map((p) => ({
          id: p.id,
          uiState: p.state as PrerequisiteUiState,
          detail: p.detail,
          resolvedPath: p.resolvedPath,
        }));

    return (
      <CompanionSetupWizard
        prerequisites={prerequisites}
        runningActionId={runningActionId}
        actionError={actionError}
        modelFiles={modelFiles}
        serverLaunch={serverLaunch}
        sttModel={sttModel}
        onRunAction={(id) => { void runAction(id); }}
        onRecheck={() => { void refresh(); }}
      />
    );
  }

  return (
    <VStack
      as="section"
      aria-labelledby={COMPANION_SETTINGS_HEADING_ID}
      data-testid="companion-controls"
      align="stretch"
      gap={6}
      p={6}
    >
      {/* Section header (#2864 H4/F7 — unified `Heading as="h2"` + accent icon). */}
      <VStack align="stretch" gap={1}>
        <HStack gap={3}>
          <Icon as={LuBot} boxSize="22px" color="var(--accent-primary)" aria-hidden />
          <Heading
            id={COMPANION_SETTINGS_HEADING_ID}
            as="h2"
            size="md"
            color="var(--text-primary)"
            fontFamily="heading"
          >
            Companion
          </Heading>
        </HStack>
        <Text fontSize="sm" color="var(--text-subtle)">
          Show or hide the desktop buddy and set how it behaves.
        </Text>
      </VStack>

      {/* Behavior group — toggle + auto-return. */}
      <Box>
        {sectionLabel('Behavior')}
        <VStack align="stretch" gap={2}>
          {/* Enable / Disable */}
          <HStack
            justify="space-between"
            p={3}
            borderRadius="md"
            background="var(--hover-bg)"
            border="1px solid var(--border-color)"
          >
            <VStack align="start" gap={0}>
              <Text fontSize="sm" fontWeight="600" color="var(--text-primary)">
                Show Fredo Companion
              </Text>
              <Text fontSize="xs" color="var(--text-subtle)">
                Display the desktop buddy overlay
              </Text>
            </VStack>
            <Switch.Root
              checked={isVisible}
              onCheckedChange={(e) => setVisible(e.checked)}
              colorPalette="accent"
              size="md"
            >
              <Switch.HiddenInput aria-label="Show Fredo Companion" />
              {/* #2864 R1 — non-text contrast (REQ-5). Checked thumb = the computed
                  on-accent foreground (T5): white on classic purple, near-black on
                  pale accents (cyan/amber) → 5.4–12.7:1 vs the accent track. The
                  unchecked thumb keeps `--card-bg`; its track uses `--text-primary`
                  so the OFF thumb also clears 3:1 in EVERY preset (card-bg vs
                  border-color is only ~1.3–1.7:1 — a below-AA pair). The live-accent
                  (checked) track is unchanged. */}
              <Switch.Control
                bg="var(--text-primary)"
                _checked={{ bg: 'var(--accent-primary)' }}
                _focusVisible={{ outline: '2px solid var(--accent-primary)', outlineOffset: '2px' }}
              >
                <Switch.Thumb bg="var(--card-bg)" _checked={{ bg: 'var(--accent-contrast)' }} />
              </Switch.Control>
            </Switch.Root>
          </HStack>

          {/* Idle auto-return duration — #2853 ST-5. */}
          <HStack
            justify="space-between"
            p={3}
            borderRadius="md"
            background="var(--hover-bg)"
            border="1px solid var(--border-color)"
          >
            <VStack align="start" gap={0}>
              <Text fontSize="sm" fontWeight="600" color="var(--text-primary)">
                Auto-return after inactivity
              </Text>
              <Text
                id={IDLE_TIMEOUT_HELP_ID}
                fontSize="xs"
                color={isIdleDraftInvalid ? 'var(--status-error)' : 'var(--text-subtle)'}
              >
                {isIdleDraftInvalid
                  ? `Enter ${MIN_IDLE_TIMEOUT_S}–${MAX_IDLE_TIMEOUT_S} s`
                  : 'Fredo returns to the desktop after this many seconds without interaction.'}
              </Text>
            </VStack>
            <HStack gap={1} align="center" flexShrink={0}>
              <NumberInput.Root
                value={idleDraft}
                onValueChange={(e) => handleIdleChange(e.value)}
                onValueCommit={(e) => commitIdleTimeout(e.value)}
                min={MIN_IDLE_TIMEOUT_S}
                max={MAX_IDLE_TIMEOUT_S}
                step={IDLE_TIMEOUT_STEP_S}
                size="sm"
                width="110px"
              >
                {/* Zag only invokes onValueCommit on blur/Enter, so persist the
                    latest value explicitly when the stepper control is clicked. */}
                <NumberInput.Control onClick={() => commitIdleTimeout(idleDraftRef.current)} />
                <NumberInput.Input
                  id={IDLE_TIMEOUT_INPUT_ID}
                  aria-label="Auto-return after inactivity (seconds)"
                  aria-describedby={IDLE_TIMEOUT_HELP_ID}
                  aria-invalid={isIdleDraftInvalid}
                  bg="var(--card-bg)"
                  color="var(--text-primary)"
                  borderColor={idleBorderColor}
                  _hover={{ borderColor: idleHighlightColor }}
                  _focus={{
                    borderColor: idleHighlightColor,
                    boxShadow: `0 0 0 1px ${idleHighlightColor}`,
                  }}
                />
              </NumberInput.Root>
              <Text as="span" fontSize="sm" color="var(--text-subtle)">
                s
              </Text>
            </HStack>
          </HStack>

          {/* Transient commit confirmation (#2864 ST-3, REQ-8) — polite live region. */}
          <Text
            role="status"
            aria-live="polite"
            aria-atomic="true"
            fontSize="xs"
            color="var(--text-subtle)"
          >
            {idleCommitMessage}
          </Text>

          {/* Send-during-reply disposition (#2892 ST-6, REQ-9/REQ-12) — a themed
              native select: it inherits no Chakra tokens, so every color is an
              explicit CSS var. Commits immediately on change. */}
          <HStack
            justify="space-between"
            p={3}
            borderRadius="md"
            background="var(--hover-bg)"
            border="1px solid var(--border-color)"
          >
            <VStack align="start" gap={0}>
              <Text fontSize="sm" fontWeight="600" color="var(--text-primary)">
                {SEND_DURING_REPLY_LABEL}
              </Text>
              <Text id={SEND_DURING_REPLY_HELP_ID} fontSize="xs" color="var(--text-subtle)">
                {SEND_DURING_REPLY_HELP}
              </Text>
            </VStack>
            <chakra.select
              data-testid="companion-send-during-reply"
              id={SEND_DURING_REPLY_INPUT_ID}
              aria-label={SEND_DURING_REPLY_LABEL}
              aria-describedby={SEND_DURING_REPLY_HELP_ID}
              value={sendDuringReply}
              onChange={(e) => commitSendDuringReply(e.target.value as CompanionSendDisposition)}
              bg="var(--card-bg)"
              color="var(--text-primary)"
              border="1px solid"
              borderColor="var(--border-color)"
              _hover={{ borderColor: 'var(--accent-primary)' }}
              _focus={{
                borderColor: 'var(--accent-primary)',
                boxShadow: 'none',
                outline: '2px solid var(--accent-primary)',
                outlineOffset: '2px',
              }}
              borderRadius="md"
              px="3"
              height="32px"
            >
              <option value="queue">{SEND_DURING_REPLY_OPTION_QUEUE}</option>
              <option value="interrupt">{SEND_DURING_REPLY_OPTION_INTERRUPT}</option>
            </chakra.select>
          </HStack>

          {/* Reply hold-open grace (#2892 ST-6, REQ-10/REQ-12) — the FIELD edits
              seconds; the persisted setting is integer milliseconds. Commits on
              blur / Enter / stepper, never per keystroke. */}
          <HStack
            justify="space-between"
            p={3}
            borderRadius="md"
            background="var(--hover-bg)"
            border="1px solid var(--border-color)"
          >
            <VStack align="start" gap={0}>
              <Text fontSize="sm" fontWeight="600" color="var(--text-primary)">
                {REPLY_GRACE_LABEL}
              </Text>
              <Text
                id={REPLY_GRACE_HELP_ID}
                fontSize="xs"
                color={isGraceDraftInvalid ? 'var(--status-error)' : 'var(--text-subtle)'}
              >
                {isGraceDraftInvalid
                  ? `Enter ${REPLY_GRACE_MIN_S}–${REPLY_GRACE_MAX_S} s`
                  : REPLY_GRACE_HELP}
              </Text>
            </VStack>
            <HStack gap={1} align="center" flexShrink={0}>
              <NumberInput.Root
                data-testid="companion-reply-leave-grace"
                value={graceDraft}
                onValueChange={(e) => handleGraceChange(e.value)}
                onValueCommit={(e) => commitGrace(e.value)}
                min={REPLY_GRACE_MIN_S}
                max={REPLY_GRACE_MAX_S}
                step={REPLY_GRACE_STEP_S}
                size="sm"
                width="110px"
              >
                {/* Zag only invokes onValueCommit on blur/Enter, so persist the
                    latest value explicitly when the stepper control is clicked. */}
                <NumberInput.Control onClick={() => commitGrace(graceDraftRef.current)} />
                <NumberInput.Input
                  id={REPLY_GRACE_INPUT_ID}
                  aria-label={REPLY_GRACE_ARIA_LABEL}
                  aria-describedby={REPLY_GRACE_HELP_ID}
                  aria-invalid={isGraceDraftInvalid}
                  bg="var(--card-bg)"
                  color="var(--text-primary)"
                  borderColor={graceBorderColor}
                  _hover={{ borderColor: graceHighlightColor }}
                  _focus={{
                    borderColor: graceHighlightColor,
                    boxShadow: `0 0 0 1px ${graceHighlightColor}`,
                  }}
                />
              </NumberInput.Root>
              <Text as="span" fontSize="sm" color="var(--text-subtle)">
                {REPLY_GRACE_UNIT}
              </Text>
            </HStack>
          </HStack>

          {/* Shared commit confirmation (#2892 ST-6) — ONE politely-announced,
              visually-hidden live region serving both new controls. */}
          <Box
            role="status"
            aria-live="polite"
            aria-atomic="true"
            data-testid="companion-settings-commit-announcer"
            position="absolute"
            width="1px"
            height="1px"
            padding="0"
            margin="-1px"
            overflow="hidden"
            clipPath="inset(50%)"
            whiteSpace="nowrap"
            borderWidth="0"
          >
            {commitMessage}
          </Box>
        </VStack>
      </Box>

      {/* Voice input group (#2877 ST-4) — enable switch, model row, input device
          and autosend. Extracted into `VoiceInputSettings`; still a THIRD group
          inside this existing Companion section (no new nav item/section). */}
      <VoiceInputSettings
        sttModel={sttModel}
        sttDevices={sttDevices}
        sttDownloading={sttRunning}
        sttError={actionError.sttModel ?? null}
        onDownloadModel={() => { void runAction('sttModel'); }}
        onRecheck={() => { void refresh(); }}
        onRescanDevices={() => { void refreshSttDevices(); }}
      />

      {/* Teleport tip — always full contrast (#2864 H6: no dimming, ever). */}
      <Box
        p={3}
        borderRadius="md"
        background="var(--hover-bg)"
        border="1px solid var(--border-color)"
      >
        {sectionLabel('Teleport')}
        <Text fontSize="xs" color="var(--text-subtle)">
          Hold{' '}
          <Text as="kbd" fontFamily="monospace" px={1} py={0.5} borderRadius="sm" background="var(--card-bg)" border="1px solid var(--border-color)">
            Ctrl
          </Text>{' '}
          and right-click anywhere to teleport Fredo there.
        </Text>
      </Box>
    </VStack>
  );
};
