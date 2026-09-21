/**
 * #2897 ST-6 (REQ-7) — the model-audio readiness row + the curated fallback copy.
 * Re-pointed by #2914 ST-3 (R-3): the local fallback is gone, so the row offers
 * no local switch and every fallback sentence names a REACHABLE remediation.
 *
 * The UI NEVER infers capability from a model name: `deriveModelAudioReadinessRow`
 * maps the BACKEND's typed verdict onto the frozen `data-state` vocabulary and
 * the exact sentences/actions the plan specifies. The fallback copy table is the
 * ONE source both the settings row and the launcher alert read, so the two
 * degradation moments can never disagree — and a raw IPC string is never the
 * primary sentence.
 */

import { describe, it, expect } from 'vitest';

import {
  deriveModelAudioReadinessRow,
  isModelAudioFailureCode,
  MODEL_AUDIO_FAILURE_COPY,
  modelAudioFailureCopy,
} from '@/shared/components/companion/companionReadiness';
import type { SttAudioCapability } from '@/shared/components/companion/companionReadiness';

const capability = (overrides: Partial<SttAudioCapability>): SttAudioCapability => ({
  state: 'unknown',
  model: null,
  limitMs: null,
  code: null,
  detail: null,
  ...overrides,
});

describe('#2897 ST-6 — model-audio readiness row', () => {
  it('checking: names the in-flight probe and offers no action', () => {
    const row = deriveModelAudioReadinessRow(null, true);
    expect(row).toEqual({
      state: 'checking',
      sentence: "Checking the companion model's audio support…",
      offerChangeModel: false,
      offerRetry: false,
    });
  });

  it('ready: names the reported model and claims nothing about the transcript', () => {
    const row = deriveModelAudioReadinessRow(
      capability({ state: 'ready', model: 'Gemma-4-E2B' }),
      false,
    );
    expect(row.state).toBe('ready');
    expect(row.sentence).toBe(
      'Gemma-4-E2B can interpret audio. Recordings stay on this machine.',
    );
    expect(row.offerChangeModel).toBe(false);
    expect(row.offerRetry).toBe(false);

    // No model name reported: a generic subject, never a fabricated name.
    const unnamed = deriveModelAudioReadinessRow(capability({ state: 'ready' }), false);
    expect(unnamed.sentence).toBe(
      'The installed companion model can interpret audio. Recordings stay on this machine.',
    );
  });

  it('unsupported: says recordings will not be sent + offers change model only', () => {
    const row = deriveModelAudioReadinessRow(capability({ state: 'unsupported' }), false);
    expect(row).toEqual({
      state: 'unsupported',
      sentence: "The installed companion model can't interpret audio. Recordings won't be sent.",
      offerChangeModel: true,
      offerRetry: false,
    });
  });

  it('serverUnavailable maps to `server-unavailable` + offers try again', () => {
    const row = deriveModelAudioReadinessRow(
      capability({ state: 'serverUnavailable' }),
      false,
    );
    expect(row).toEqual({
      state: 'server-unavailable',
      sentence: "The local model server isn't running, so Fredo can't interpret audio.",
      offerChangeModel: false,
      offerRetry: true,
    });
  });

  it('unknown / no result: can-not-check copy + Try again (fail-closed, never ready)', () => {
    const unknown = deriveModelAudioReadinessRow(capability({ state: 'unknown' }), false);
    expect(unknown).toEqual({
      state: 'unknown',
      sentence: "Can't check audio support right now.",
      offerChangeModel: false,
      offerRetry: true,
    });
    // A missing capability (no probe / rejected invoke) is `unknown`, NOT ready.
    expect(deriveModelAudioReadinessRow(null, false)).toEqual(unknown);
    // The Rust `checking` value on the wire without an in-flight flag is unknown.
    expect(deriveModelAudioReadinessRow(capability({ state: 'checking' }), false)).toEqual(
      unknown,
    );
  });

  it('never offers the removed local fallback for any verdict (R-3)', () => {
    const states: Array<SttAudioCapability['state']> = [
      'checking',
      'ready',
      'unsupported',
      'serverUnavailable',
      'unknown',
    ];
    for (const state of states) {
      const row = deriveModelAudioReadinessRow(capability({ state }), false);
      expect(row).not.toHaveProperty('offerLocal');
      expect(Object.keys(row).sort()).toEqual(
        ['offerChangeModel', 'offerRetry', 'sentence', 'state'],
      );
    }
  });
});

describe('#2897 ST-6 — curated model-audio fallback copy', () => {
  it('pins the three curated sentences (never the raw IPC string, never local)', () => {
    expect(MODEL_AUDIO_FAILURE_COPY.modelAudioUnsupported).toBe(
      "The companion model can't interpret audio — your recording wasn't sent. Install a model with audio support from Companion setup, or choose Change model.",
    );
    expect(MODEL_AUDIO_FAILURE_COPY.modelAudioUnavailable).toBe(
      "The local model server isn't running, so Fredo couldn't interpret that. Start the companion server, then try again.",
    );
    expect(MODEL_AUDIO_FAILURE_COPY.modelAudioFailed).toBe(
      "Fredo couldn't interpret that recording. Try again.",
    );
    // #2914 ST-3 (R-3) — the removed local fallback is never offered by name.
    for (const sentence of Object.values(MODEL_AUDIO_FAILURE_COPY)) {
      expect(sentence).not.toContain('Local transcription');
    }
    // The still-valid half is kept: name the audio-capable model remedy.
    expect(MODEL_AUDIO_FAILURE_COPY.modelAudioUnsupported).toMatch(
      /install a model with audio support/i,
    );
  });

  it('classifies the three causes and returns null for an unrelated code', () => {
    expect(isModelAudioFailureCode('modelAudioUnsupported')).toBe(true);
    expect(isModelAudioFailureCode('modelAudioUnavailable')).toBe(true);
    expect(isModelAudioFailureCode('modelAudioFailed')).toBe(true);
    expect(isModelAudioFailureCode('noDevice')).toBe(false);
    expect(isModelAudioFailureCode(null)).toBe(false);
    expect(isModelAudioFailureCode(undefined)).toBe(false);

    expect(modelAudioFailureCopy('modelAudioUnsupported')).toBe(
      MODEL_AUDIO_FAILURE_COPY.modelAudioUnsupported,
    );
    expect(modelAudioFailureCopy('modelAudioFailed')).toBe(
      MODEL_AUDIO_FAILURE_COPY.modelAudioFailed,
    );
    expect(modelAudioFailureCopy(null)).toBeNull();
  });
});
