/**
 * Companion setup step registry (Spec #2855; in-process runtime since #3141) —
 * THE single ordered extension seam for the one user-facing setup wizard.
 *
 * The backend `check_companion_readiness` owns the prerequisite SET; this
 * registry supplies the presentation/action metadata keyed by prerequisite id.
 * #2856 supplies the `download_model` action for `modelFiles`; #2857 appended
 * the `serverLaunch` lifecycle row. #3141 ST-6 retired the `llamaServer`
 * (llama.cpp install) entry with the out-of-process runtime: the model files
 * are the ONLY prerequisite, and starting the engine is a LIFECYCLE row that
 * still participates in the composed `ready` gate — you cannot chat without a
 * running engine — but is excluded from the wizard's prerequisite summary
 * (see `role`).
 */

import type React from 'react';
import { LuFileArchive, LuServer } from 'react-icons/lu';

import type { PrerequisiteId } from './companionReadiness';

/**
 * #3141 ST-6 — the additive step-role discriminator (C-1 ACCEPTED).
 *
 * `'prerequisite'` is something the USER provisions (the model files — the only
 * one left). `'lifecycle'` is a runtime row the engine goes through; it stays in
 * the composed `ready` gate but is excluded from the prerequisite summary.
 *
 * Named `role` (not `kind`) so it cannot be confused with the existing
 * `action.kind` on the same object. NOT the same axis as `optional`: `optional`
 * excludes a step from BOTH the summary and the `ready` gate; `role:
 * 'lifecycle'` is excluded from the SUMMARY ONLY.
 */
export type CompanionSetupStepRole = 'prerequisite' | 'lifecycle';

export interface CompanionSetupStepAction {
  /**
   * `'install_llama_cpp'` is RETIRED (#3141 — nothing is installed). The
   * `kind: 'install'` union member is retained but DORMANT so
   * `SetupStepCard`'s install branch stays type-correct and simply never
   * renders (a documented dead branch, not a silent one).
   */
  command: 'download_model' | 'launch_llama_server';
  label: string;
  runningLabel: string;
  kind: 'install' | 'download' | 'launch';
}

export interface CompanionSetupStepMeta {
  id: PrerequisiteId;
  /** kebab-case id for the stable QA `data-testid` hooks. */
  testId: string;
  /** Prerequisite (user-provisioned) vs lifecycle (runtime) row. */
  role: CompanionSetupStepRole;
  label: string;
  description: string;
  icon: React.ElementType;
  /** undefined = detect-only step. */
  action?: CompanionSetupStepAction;
  /**
   * #2876 ST-5 — an OPTIONAL step. Optional steps are rendered in a separate
   * group and are EXCLUDED from the wizard's prerequisite summary and from the
   * `CompanionReadiness.ready` gate. Installing/removing one can never block or
   * unblock companion chat.
   */
  optional?: boolean;
}

/** ONE ordered registry — the single place future slices add steps/actions. */
export const COMPANION_SETUP_STEPS: CompanionSetupStepMeta[] = [
  {
    // #3141 — the ONLY provisioning prerequisite (the runtime ships inside Fredo).
    id: 'modelFiles',
    testId: 'model-files',
    role: 'prerequisite',
    label: 'Model files',
    description: 'The model, vision projector and speculative draft files the companion needs.',
    icon: LuFileArchive,
    action: {
      command: 'download_model',
      label: 'Download model files',
      runningLabel: 'Downloading…',
      kind: 'download',
    },
  },
  {
    // #2857 / #3141 — the LIFECYCLE row. Its state is composed in
    // `useCompanionReadiness` from `get_llama_server_status` (the backend
    // readiness command stays model-files-only).
    id: 'serverLaunch',
    testId: 'server-launch',
    role: 'lifecycle',
    label: 'Companion engine',
    description:
      'Runs the companion engine built into Fredo and confirms it is ready before Fredo can chat.',
    icon: LuServer,
    action: {
      command: 'launch_llama_server',
      label: 'Start companion engine',
      runningLabel: 'Starting engine…',
      kind: 'launch',
    },
  },
];

/** Convenience lookup; returns undefined for a prerequisite with no metadata. */
export function companionSetupStepMeta(
  id: PrerequisiteId,
): CompanionSetupStepMeta | undefined {
  return COMPANION_SETUP_STEPS.find((step) => step.id === id);
}
