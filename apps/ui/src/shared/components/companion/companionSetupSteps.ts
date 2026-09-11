/**
 * Companion setup step registry (Spec #2855) — THE single ordered extension
 * seam for the one user-facing setup wizard.
 *
 * The backend `check_companion_readiness` owns the prerequisite SET; this
 * registry supplies the presentation/action metadata keyed by prerequisite id.
 * #2856 supplies the `download_model` action for `modelFiles`; #2857 appends a
 * `serverLaunch` prerequisite + `launch_llama_server` action. Neither adds a
 * second wizard, tab, or window — they append here.
 */

import type React from 'react';
import { LuCpu, LuFileArchive } from 'react-icons/lu';

import type { PrerequisiteId } from './companionReadiness';

export interface CompanionSetupStepAction {
  command: 'install_llama_cpp' | 'download_model' | 'launch_llama_server';
  label: string;
  runningLabel: string;
  kind: 'install' | 'download' | 'launch';
}

export interface CompanionSetupStepMeta {
  id: PrerequisiteId;
  /** kebab-case id for the stable QA `data-testid` hooks. */
  testId: string;
  label: string;
  description: string;
  icon: React.ElementType;
  /** undefined = detect-only step this slice. */
  action?: CompanionSetupStepAction;
}

/** ONE ordered registry — the single place future slices add steps/actions. */
export const COMPANION_SETUP_STEPS: CompanionSetupStepMeta[] = [
  {
    id: 'llamaServer',
    testId: 'llama-server',
    label: 'llama.cpp runtime',
    description: 'A usable llama-server executable the companion can run.',
    icon: LuCpu,
    action: {
      command: 'install_llama_cpp',
      label: 'Install llama.cpp',
      runningLabel: 'Installing llama.cpp…',
      kind: 'install',
    },
  },
  {
    id: 'modelFiles',
    testId: 'model-files',
    label: 'Model files',
    description: 'The required GGUF + mmproj model files for the companion.',
    icon: LuFileArchive,
    // Action reserved for #2856 (download_model) — detect-only this slice.
  },
];

/** Convenience lookup; returns undefined for a prerequisite with no metadata. */
export function companionSetupStepMeta(
  id: PrerequisiteId,
): CompanionSetupStepMeta | undefined {
  return COMPANION_SETUP_STEPS.find((step) => step.id === id);
}
