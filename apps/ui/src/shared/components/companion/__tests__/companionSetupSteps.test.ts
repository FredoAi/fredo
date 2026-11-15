/**
 * Companion setup registry — the #3141 ST-6 one-prerequisite contract.
 *
 * Proves the accepted C-1 additive field on `CompanionSetupStepMeta`:
 *   - `role: 'prerequisite'` for the ONLY provisioning row (`modelFiles`);
 *   - `role: 'lifecycle'` for the engine-start row (`serverLaunch`);
 *   - the retired `llamaServer` entry, its `install_llama_cpp` action and its
 *     `llama-server` testid are GONE (AC-17: nothing is installed);
 *   - the `install` action kind is retained but DORMANT (no step uses it), so the
 *     `SetupStepCard` install branch stays type-correct;
 *   - `role` is NOT the same axis as `optional` (no step is optional here, and a
 *     lifecycle row must remain in the `ready` gate).
 */

import { describe, it, expect } from 'vitest';

import {
  COMPANION_SETUP_STEPS,
  companionSetupStepMeta,
} from '@/shared/components/companion/companionSetupSteps';

describe('#3141 ST-6 — the setup-step registry after the runtime retirement', () => {
  it('registers exactly the model files (prerequisite) and the engine (lifecycle)', () => {
    expect(COMPANION_SETUP_STEPS.map((step) => step.id)).toEqual([
      'modelFiles',
      'serverLaunch',
    ]);
    expect(COMPANION_SETUP_STEPS.map((step) => step.role)).toEqual([
      'prerequisite',
      'lifecycle',
    ]);
  });

  it('has EXACTLY ONE prerequisite — the model files (AC-17)', () => {
    const prerequisites = COMPANION_SETUP_STEPS.filter(
      (step) => step.role === 'prerequisite',
    );
    expect(prerequisites).toHaveLength(1);
    expect(prerequisites[0]?.id).toBe('modelFiles');
  });

  it('drops the retired llama.cpp install entry, its action and its testid', () => {
    expect(COMPANION_SETUP_STEPS.some((step) => step.id === 'llamaServer')).toBe(false);
    expect(COMPANION_SETUP_STEPS.some((step) => step.testId === 'llama-server')).toBe(false);
    for (const step of COMPANION_SETUP_STEPS) {
      // `install_llama_cpp` is no longer a reachable command.
      expect(step.action?.command).not.toBe('install_llama_cpp');
    }
    expect(companionSetupStepMeta('modelFiles')?.action?.command).toBe('download_model');
    expect(companionSetupStepMeta('serverLaunch')?.action?.command).toBe('launch_llama_server');
  });

  it('retains the `install` kind as a DORMANT union member (never used)', () => {
    // The member still exists in the type; no step carries it any more.
    expect(COMPANION_SETUP_STEPS.every((step) => step.action?.kind !== 'install')).toBe(true);
  });

  it('keeps the lifecycle row in the gate (it is NOT an `optional` step)', () => {
    const engine = COMPANION_SETUP_STEPS.find((step) => step.id === 'serverLaunch');
    expect(engine?.optional).toBeUndefined();
    expect(engine?.label).toBe('Companion engine');
  });

  it('names the engine, never the retired runtime, in every user-visible string', () => {
    for (const step of COMPANION_SETUP_STEPS) {
      const copy = [step.label, step.description, step.action?.label ?? '', step.action?.runningLabel ?? '']
        .join(' ')
        .toLowerCase();
      expect(copy).not.toContain('llama-server');
      expect(copy).not.toContain('llama.cpp');
      expect(copy).not.toContain('companion server');
    }
    expect(companionSetupStepMeta('serverLaunch')?.description).toContain(
      'built into Fredo',
    );
  });
});
