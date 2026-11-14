/**
 * CompanionSetupWizard — the ONE user-facing Companion setup flow (Spec #2855).
 *
 * It renders exactly the prerequisite set the backend `check_companion_readiness`
 * reports, in the order of the `COMPANION_SETUP_STEPS` registry. #2856
 * (model download) and #2857 (engine start) append to that registry — they do
 * NOT add a second wizard, tab, or window.
 *
 * #3141 ST-6: the runtime ships inside Fredo, so the model files are the ONLY
 * provisioning prerequisite and the engine-start row is a LIFECYCLE row.
 * A `1/1` copy would be pure noise, so the `installed/total` fraction and its
 * five summary strings are replaced by the one-prerequisite banner: the role
 * discriminator (`role: 'prerequisite'`) decides what the banner counts.
 *
 * The gate lives in `CompanionSettingsPanel`: while not ready this component is
 * the ONLY content rendered.
 */

import React, { useMemo } from 'react';
import { Box, HStack, Heading, Icon, Text, VStack } from '@chakra-ui/react';
import {
  LuCircleCheck,
  LuFileArchive,
  LuRefreshCw,
  LuSettings2,
  LuTriangleAlert,
} from 'react-icons/lu';

import { tint } from '../../utils/colorTint';

import { SetupStepCard, type SetupStepUiState } from './SetupStepCard';
import { ModelFilesStepCard } from './ModelFilesStepCard';
import { ServerLaunchStepCard } from './ServerLaunchStepCard';
import { COMPANION_SETUP_STEPS, type CompanionSetupStepMeta } from './companionSetupSteps';
import type {
  CompanionServerLaunchInfo,
  ModelFilesStatus,
  PrerequisiteId,
  PrerequisiteUiState,
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
  /** Frontend-composed engine launch snapshot (#2857 / #3141). */
  serverLaunch?: CompanionServerLaunchInfo | null;
  onRunAction: (id: PrerequisiteId) => void;
  onRecheck: () => void;
}

const FALLBACK_META = (id: PrerequisiteId): CompanionSetupStepMeta => ({
  id,
  testId: id,
  role: 'lifecycle',
  label: id,
  description: '',
  icon: LuFileArchive,
});

/** The one-prerequisite banner mapping (UI/UX §4.2) — replaces the `n of m` count. */
export type SetupSummary = {
  statusVar: string;
  icon: React.ElementType;
  text: string;
};

/** Map the model-files prerequisite (+ probe state) onto the summary banner. */
export function deriveSetupSummary(input: {
  checking: boolean;
  /** The `modelFiles` prerequisite's UI state, or undefined when unreported. */
  modelFilesState: PrerequisiteUiState | undefined;
}): SetupSummary {
  if (input.checking) {
    return {
      statusVar: 'var(--text-subtle)',
      icon: LuSettings2,
      text: 'Checking prerequisites…',
    };
  }
  if (input.modelFilesState === 'installed') {
    return {
      statusVar: 'var(--status-success)',
      icon: LuCircleCheck,
      text: 'Model files ready — nothing else to install',
    };
  }
  if (input.modelFilesState === 'missing') {
    return {
      statusVar: 'var(--status-warning)',
      icon: LuTriangleAlert,
      text: 'Model files needed before the companion can run',
    };
  }
  // `error` / an unreported prerequisite — fail closed.
  return {
    statusVar: 'var(--status-warning)',
    icon: LuTriangleAlert,
    text: "Couldn't check the model files",
  };
}

export const CompanionSetupWizard: React.FC<CompanionSetupWizardProps> = ({
  prerequisites,
  runningActionId,
  actionError,
  modelFiles,
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
  // are EXCLUDED from the prerequisite summary. Only required steps can make
  // the wizard read incomplete, so an optional step never blocks companion chat.
  //
  // #3141 ST-6 — `role` is a DIFFERENT axis: `'lifecycle'` rows (the engine
  // start) stay in the composed `ready` gate — you cannot chat without a running
  // engine — but are excluded from the provisioning summary, because they are
  // not something the user installs.
  const optionalStepIds = useMemo(
    () =>
      new Set(
        COMPANION_SETUP_STEPS.filter((step) => step.optional).map((step) => step.id),
      ),
    [],
  );
  // #3141 ST-6 — the role split decides what the summary counts: only
  // `'prerequisite'` rows (the model files) can make the wizard read incomplete.
  // `'lifecycle'` rows stay in the composed `ready` gate but never inflate the
  // provisioning story — you cannot chat without a running engine, but you do not
  // install one.
  const provisioningStepIds = useMemo(
    () =>
      new Set(
        COMPANION_SETUP_STEPS.filter((step) => step.role === 'prerequisite').map(
          (step) => step.id,
        ),
      ),
    [],
  );

  const requiredPrerequisites = prerequisites.filter((p) => !optionalStepIds.has(p.id));
  const optionalPrerequisites = prerequisites.filter((p) => optionalStepIds.has(p.id));
  // Provisioning rows first, lifecycle rows after (the user acts on what they own
  // first; the engine start follows).
  const orderedRequiredPrerequisites = [
    ...requiredPrerequisites.filter((p) => provisioningStepIds.has(p.id)),
    ...requiredPrerequisites.filter((p) => !provisioningStepIds.has(p.id)),
  ];

  const isChecking = prerequisites.some((p) => p.uiState === 'checking');
  const modelFilesState = prerequisites.find((p) => p.id === 'modelFiles')?.uiState;

  const summary = useMemo(
    () =>
      deriveSetupSummary({
        checking: isChecking,
        modelFilesState: modelFilesState as PrerequisiteUiState | undefined,
      }),
    [isChecking, modelFilesState],
  );

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
    if (prerequisite.id === 'serverLaunch') {
      return (
        <ServerLaunchStepCard
          step={meta}
          uiState={uiState}
          detail={prerequisite.detail}
          errorText={errorText}
          serverState={serverLaunch?.state ?? 'notRunning'}
          serverCode={serverLaunch?.code ?? null}
          backend={serverLaunch?.backend ?? null}
          modelId={serverLaunch?.modelId ?? null}
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
        Fredo downloads the companion model files once, then starts the built-in
        engine. Nothing else to install.
      </Text>

      {/* Status banner (H4/H9): tinted from the LIVE status var so it re-tints
          with the user's accent/theme, with a real AA-legible contrast pair.
          #3141 ST-6: the `installed/total` fraction is gone — with ONE
          provisioning prerequisite it carried no information. */}
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
      </HStack>

      <Box as="ol" m={0} p={0} display="flex" flexDirection="column" gap={3}>
        {orderedRequiredPrerequisites.map((prerequisite) => (
          <React.Fragment key={prerequisite.id}>
            {renderStep(prerequisite)}
          </React.Fragment>
        ))}
      </Box>

      {/* #2876 ST-5 — the OPTIONAL group. Visually separated, excluded from the
          prerequisite summary, and never a companion-chat gate. */}
      {optionalPrerequisites.length > 0 && (
        <Box
          data-testid="companion-setup-optional"
          borderTop="1px solid"
          borderColor="var(--border-color)"
          pt={4}
        >
          <Text
            fontSize="xs"
            fontWeight="700"
            color="var(--text-subtle)"
            letterSpacing="wider"
            textTransform="uppercase"
            mb={3}
          >
            Optional
          </Text>
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
          contrast; it is not a control. #3141 ST-6: the lifecycle row's chip is
          "Running", not "Installed", so the copy names both conditions. */}
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
          When the model files are ready and the engine is running, this view hands
          off to your Companion controls automatically — nothing else to do here.
        </Text>
      </HStack>
    </VStack>
  );
};
