/**
 * CompanionSetupWizard — the ONE user-facing Companion setup flow (Spec #2855).
 *
 * It renders exactly the prerequisite set the backend `check_companion_readiness`
 * reports, in the order of the `COMPANION_SETUP_STEPS` registry. #2856
 * (model download) and #2857 (server launch) append to that registry — they do
 * NOT add a second wizard, tab, or window.
 *
 * The gate lives in `CompanionSettingsPanel`: while not ready this component is
 * the ONLY content rendered.
 */

import React, { useMemo } from 'react';
import { Box, HStack, Heading, Icon, Text, VStack } from '@chakra-ui/react';
import {
  LuCircleCheck,
  LuFileArchive,
  LuMic,
  LuRefreshCw,
  LuSettings2,
  LuTriangleAlert,
} from 'react-icons/lu';

import { tint } from '../../utils/colorTint';

import { SetupStepCard, type SetupStepUiState } from './SetupStepCard';
import { ModelFilesStepCard } from './ModelFilesStepCard';
import { ServerLaunchStepCard } from './ServerLaunchStepCard';
import { VoiceModelStepCard } from './VoiceModelStepCard';
import { COMPANION_SETUP_STEPS, type CompanionSetupStepMeta } from './companionSetupSteps';
import type {
  CompanionServerLaunchInfo,
  ModelFilesStatus,
  PrerequisiteId,
  PrerequisiteUiState,
  SttModelReadiness,
} from './companionReadiness';

export interface CompanionSetupWizardPrerequisite {
  id: PrerequisiteId;
  uiState: PrerequisiteUiState;
  detail?: string;
  resolvedPath?: string | null;
}

export interface CompanionSetupWizardProps {
  prerequisites: CompanionSetupWizardPrerequisite[];
  runningActionId: PrerequisiteId | null;
  actionError: Partial<Record<PrerequisiteId, string>>;
  /** Per-file model status from `check_model_files` (#2856). */
  modelFiles?: ModelFilesStatus | null;
  /** Per-file OPTIONAL STT model status (#2877 ST-2/ST-7) — non-gating. */
  sttModel?: SttModelReadiness | null;
  /** Frontend-composed server launch snapshot (#2857). */
  serverLaunch?: CompanionServerLaunchInfo | null;
  onRunAction: (id: PrerequisiteId) => void;
  onRecheck: () => void;
}

const FALLBACK_META = (id: PrerequisiteId): CompanionSetupStepMeta => ({
  id,
  testId: id,
  label: id,
  description: '',
  icon: LuFileArchive,
});

export const CompanionSetupWizard: React.FC<CompanionSetupWizardProps> = ({
  prerequisites,
  runningActionId,
  actionError,
  modelFiles,
  sttModel,
  serverLaunch,
  onRunAction,
  onRecheck,
}) => {
  const metaById = useMemo(() => {
    const map = new Map<PrerequisiteId, CompanionSetupStepMeta>();
    for (const step of COMPANION_SETUP_STEPS) map.set(step.id, step);
    return map;
  }, []);

  // #2876 ST-5 — OPTIONAL steps (voice input) are rendered in their own group and
  // are EXCLUDED from the `installed/total` summary. Only required steps can make
  // the wizard read incomplete, so an optional step never blocks companion chat.
  const optionalStepIds = useMemo(
    () =>
      new Set(
        COMPANION_SETUP_STEPS.filter((step) => step.optional).map((step) => step.id),
      ),
    [],
  );
  const requiredPrerequisites = prerequisites.filter((p) => !optionalStepIds.has(p.id));
  const optionalPrerequisites = prerequisites.filter((p) => optionalStepIds.has(p.id));

  const total = requiredPrerequisites.length;
  const installed = requiredPrerequisites.filter((p) => p.uiState === 'installed').length;
  const isChecking = prerequisites.some((p) => p.uiState === 'checking');

  const summary = useMemo(() => {
    if (isChecking) {
      return {
        statusVar: 'var(--text-subtle)',
        icon: LuSettings2,
        text: 'Checking prerequisites…',
      };
    }
    if (total > 0 && installed === total) {
      return {
        statusVar: 'var(--status-success)',
        icon: LuCircleCheck,
        text: 'All prerequisites installed',
      };
    }
    if (installed > 0) {
      return {
        statusVar: 'var(--status-warning)',
        icon: LuTriangleAlert,
        text: `${installed} of ${total} prerequisites ready — setup required`,
      };
    }
    return {
      statusVar: 'var(--status-warning)',
      icon: LuTriangleAlert,
      text: `${total} prerequisites need attention`,
    };
  }, [isChecking, installed, total]);

  const renderStep = (prerequisite: CompanionSetupWizardPrerequisite) => {
    const meta = metaById.get(prerequisite.id) ?? FALLBACK_META(prerequisite.id);
    const errorText = actionError[prerequisite.id];
    const baseState: PrerequisiteUiState = isChecking ? 'checking' : prerequisite.uiState;
    const uiState: SetupStepUiState =
      runningActionId === prerequisite.id
        ? 'running'
        : errorText && baseState !== 'installed'
          ? 'error'
          : baseState;
    if (prerequisite.id === 'modelFiles') {
      return (
        <ModelFilesStepCard
          step={meta}
          uiState={uiState}
          detail={prerequisite.detail}
          errorText={errorText}
          modelFiles={modelFiles ?? null}
          onRunAction={onRunAction}
          onRecheck={onRecheck}
        />
      );
    }
    if (prerequisite.id === 'sttModel') {
      // #2877 ST-7 (DR-4) — the OPTIONAL voice-input model gets the per-file
      // repair surface. It stays non-gating: it is never counted in
      // `installed/total` and never contributes to `CompanionReadiness.ready`.
      return (
        <VoiceModelStepCard
          step={meta}
          uiState={uiState}
          detail={prerequisite.detail}
          errorText={errorText}
          sttModel={sttModel ?? null}
          onRunAction={onRunAction}
          onRecheck={onRecheck}
        />
      );
    }
    if (prerequisite.id === 'serverLaunch') {
      return (
        <ServerLaunchStepCard
          step={meta}
          uiState={uiState}
          detail={prerequisite.detail}
          resolvedPath={prerequisite.resolvedPath}
          errorText={errorText}
          serverState={serverLaunch?.state ?? 'notRunning'}
          serverPort={serverLaunch?.port ?? null}
          serverCode={serverLaunch?.code ?? null}
          onRunAction={onRunAction}
          onRecheck={onRecheck}
        />
      );
    }
    return (
      <SetupStepCard
        step={meta}
        uiState={uiState}
        detail={prerequisite.detail}
        resolvedPath={prerequisite.resolvedPath}
        errorText={errorText}
        onRunAction={onRunAction}
        onRecheck={onRecheck}
      />
    );
  };

  return (
    <VStack
      as="section"
      aria-labelledby="companion-setup-heading"
      align="stretch"
      gap={5}
      p={6}
      data-testid="companion-setup-wizard"
    >
      <HStack gap={3}>
        <Icon as={LuSettings2} boxSize="22px" color="var(--accent-primary)" aria-hidden />
        <Heading
          id="companion-setup-heading"
          as="h2"
          size="md"
          color="var(--text-primary)"
          fontFamily="heading"
        >
          Set up Fredo Companion
        </Heading>
      </HStack>

      <Text fontSize="sm" color="var(--text-subtle)">
        Fredo needs llama.cpp + model files before the companion can run.
      </Text>

      {/* Status banner (H4/H9): tinted from the LIVE status var so it re-tints
          with the user's accent/theme, with a real AA-legible contrast pair. */}
      <HStack
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="companion-setup-summary"
        gap={3}
        align="center"
        p={4}
        borderRadius="lg"
        border="1px solid"
        borderColor={tint(summary.statusVar, 30)}
        bg={tint(summary.statusVar, 10)}
      >
        <Icon as={summary.icon} boxSize="18px" color={summary.statusVar} aria-hidden />
        <Text fontSize="sm" fontWeight="600" color="var(--text-primary)" flex={1}>
          {summary.text}
        </Text>
        {!isChecking && total > 0 && (
          <Text fontSize="xs" fontWeight="600" color="var(--text-subtle)" flexShrink={0}>
            {installed}/{total}
          </Text>
        )}
      </HStack>

      <Box as="ol" m={0} p={0} display="flex" flexDirection="column" gap={3}>
        {requiredPrerequisites.map((prerequisite) => (
          <React.Fragment key={prerequisite.id}>
            {renderStep(prerequisite)}
          </React.Fragment>
        ))}
      </Box>

      {/* #2876 ST-5 — the OPTIONAL group. Visually separated, excluded from the
          `installed/total` summary, and never a companion-chat gate. */}
      {optionalPrerequisites.length > 0 && (
        <Box
          data-testid="companion-setup-optional"
          borderTop="1px solid"
          borderColor="var(--border-color)"
          pt={4}
        >
          <HStack gap={2} align="center" mb={1}>
            <Icon as={LuMic} boxSize="15px" color="var(--text-subtle)" aria-hidden />
            <Text
              fontSize="xs"
              fontWeight="700"
              color="var(--text-subtle)"
              letterSpacing="wider"
              textTransform="uppercase"
            >
              Optional
            </Text>
          </HStack>
          <Text fontSize="xs" color="var(--text-subtle)" mb={3}>
            Not required for companion chat.
          </Text>
          <Box as="ol" m={0} p={0} display="flex" flexDirection="column" gap={3}>
            {optionalPrerequisites.map((prerequisite) => (
              <React.Fragment key={prerequisite.id}>
                {renderStep(prerequisite)}
              </React.Fragment>
            ))}
          </Box>
        </Box>
      )}

      {/* Handoff callout (H7/§2.10) — informational, visually separated, full
          contrast; it is not a control. */}
      <HStack
        gap={2}
        align="center"
        borderTop="1px solid"
        borderColor="var(--border-color)"
        pt={3}
        data-testid="companion-setup-handoff"
      >
        <Icon as={LuRefreshCw} boxSize="15px" color="var(--accent-primary)" aria-hidden />
        <Text fontSize="sm" color="var(--text-subtle)">
          When every step shows Installed, this view hands off to your Companion
          controls automatically — nothing else to do here.
        </Text>
      </HStack>
    </VStack>
  );
};
