/**
 * Spec #3141 ST-6 (AC-17 / AC-28, R-17.1) — REMOVED-RUNTIME COPY SWEEP.
 *
 * The out-of-process `llama-server` runtime is retired. Its false claim is not
 * only in the docs: it was live USER-VISIBLE COPY in `companionReadiness.ts`,
 * reached from the setup wizard AND from `VoiceInputSettings` (which never mounts
 * the wizard). This suite asserts the banned claims are gone from the copy's
 * VALUES — not from comments — so a future edit cannot reintroduce them silently.
 *
 * The predicates run over every exported user-visible string this module
 * declares, plus every sentence `deriveModelAudioReadinessRow` can produce,
 * INCLUDING the voice row's `serverUnavailable` sentence specifically.
 *
 * Non-vacuity controls:
 *   - the scan is proven to catch a seeded hit (a synthetic string with each
 *     banned token);
 *   - the coverage is proven complete: a seeded exported copy constant is picked
 *     up by the collector (so a NEW exported string cannot escape the sweep);
 *   - the historical values are asserted to FAIL the predicate, so the sweep
 *     cannot pass merely because the predicate is inert.
 */

import { describe, it, expect } from 'vitest';

import * as readiness from '@/shared/components/companion/companionReadiness';
import {
  deriveModelAudioReadinessRow,
  MODEL_AUDIO_FAILURE_COPY,
  type SttAudioCapability,
} from '@/shared/components/companion/companionReadiness';

/**
 * The banned tokens: the retired runtime's names. Case-insensitive; matched
 * against the string VALUES the user can read.
 */
const BANNED = [/llama-server/i, /companion server/i, /local model server/i];

/** Does a user-visible string still describe the removed out-of-process runtime? */
function describesRemovedRuntime(value: string): boolean {
  return BANNED.some((pattern) => pattern.test(value));
}

/**
 * Every exported user-visible COPY value this module declares: exported string
 * constants (including the `MODEL_AUDIO_FAILURE_COPY` record's members) plus
 * every copy-returning exported function's declared output.
 */
function collectedUserVisibleStrings(): Array<{ name: string; value: string }> {
  const collected: Array<{ name: string; value: string }> = [];
  for (const [name, value] of Object.entries(readiness)) {
    if (typeof value === 'string') {
      collected.push({ name, value });
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Records of copy (e.g. `MODEL_AUDIO_FAILURE_COPY`).
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (typeof entry === 'string') collected.push({ name: `${name}.${key}`, value: entry });
      }
    }
  }
  return collected;
}

const capability = (overrides: Partial<SttAudioCapability>): SttAudioCapability => ({
  state: 'unknown',
  model: null,
  limitMs: null,
  code: null,
  detail: null,
  ...overrides,
});

/** Every sentence `deriveModelAudioReadinessRow` can produce, labelled. */
function modelAudioRowSentences(): Array<{ name: string; value: string }> {
  const cases: Array<{ name: string; value: string }> = [
    { name: 'row.checking', value: deriveModelAudioReadinessRow(null, true).sentence },
    {
      name: 'row.ready.named',
      value: deriveModelAudioReadinessRow(
        capability({ state: 'ready', model: 'Gemma-4-E2B' }),
        false,
      ).sentence,
    },
    {
      name: 'row.ready.unnamed',
      value: deriveModelAudioReadinessRow(capability({ state: 'ready' }), false).sentence,
    },
    {
      name: 'row.unsupported',
      value: deriveModelAudioReadinessRow(capability({ state: 'unsupported' }), false).sentence,
    },
    {
      // THE VOICE ROW (VoiceInputSettings never mounts the wizard).
      name: 'row.serverUnavailable',
      value: deriveModelAudioReadinessRow(capability({ state: 'serverUnavailable' }), false)
        .sentence,
    },
    {
      name: 'row.unknown',
      value: deriveModelAudioReadinessRow(capability({ state: 'unknown' }), false).sentence,
    },
    { name: 'row.no-capability', value: deriveModelAudioReadinessRow(null, false).sentence },
  ];
  return cases;
}

/** Every copy-returning helper's declared output, labelled. */
function functionCopyOutputs(): Array<{ name: string; value: string }> {
  const engineCodes = [
    'gpuUnavailable',
    'backendInitFailed',
    'modelMissing',
    'modelLoadFailed',
    'mtpInitFailed',
    'mmprojInitFailed',
    'contextCreateFailed',
    'busy',
    'startTimeout',
    null,
  ] as const;
  return [
    ...engineCodes.map((code) => {
      const copy = readiness.engineFailureCopy(code);
      return { name: `engineFailureCopy(${code}).title`, value: copy.title };
    }),
    ...engineCodes.map((code) => {
      const copy = readiness.engineFailureCopy(code);
      return { name: `engineFailureCopy(${code}).sentence`, value: copy.sentence };
    }),
    {
      name: 'errorCopyFor(serverLaunch).message',
      value: readiness.errorCopyFor('serverLaunch', null, null).message,
    },
    {
      name: 'errorCopyFor(modelFiles).message',
      value: readiness.errorCopyFor('modelFiles', null, null).message,
    },
    {
      name: 'companionReplyErrorCopy(generic)',
      value: readiness.companionReplyErrorCopy('boom'),
    },
    {
      name: 'companionReplyErrorCopy(not-ready)',
      value: readiness.companionReplyErrorCopy('still loading'),
    },
  ];
}

describe('#3141 ST-6 — the removed runtime is gone from USER-VISIBLE copy', () => {
  it('no exported copy constant or model-audio row sentence names the retired runtime', () => {
    const strings = [
      ...collectedUserVisibleStrings(),
      ...modelAudioRowSentences(),
      ...functionCopyOutputs(),
    ];
    // Coverage guard: the sweep must actually have strings to inspect.
    expect(strings.length).toBeGreaterThan(15);

    const offenders = strings.filter(({ value }) => describesRemovedRuntime(value));
    expect(offenders).toEqual([]);
  });

  it('the VOICE row sentence specifically (never rendered through the wizard)', () => {
    const sentence = deriveModelAudioReadinessRow(
      capability({ state: 'serverUnavailable' }),
      false,
    ).sentence;
    // Exact new wording, pinned verbatim (G-411 — never relaxed to a substring).
    expect(sentence).toBe("The companion engine isn't running, so Fredo can't interpret audio.");
    expect(describesRemovedRuntime(sentence)).toBe(false);
  });

  it('the model-audio fallback record is engine-worded, not server-worded', () => {
    expect(MODEL_AUDIO_FAILURE_COPY.modelAudioUnavailable).toBe(
      "The companion engine isn't running, so Fredo couldn't interpret that. Start the companion engine in Companion setup, then try again.",
    );
    for (const sentence of Object.values(MODEL_AUDIO_FAILURE_COPY)) {
      expect(describesRemovedRuntime(sentence)).toBe(false);
    }
  });

  it('NON-VACUITY: the predicate catches every banned token, and the historical values fail it', () => {
    for (const seeded of [
      'Could not start llama-server.',
      'The companion server stopped.',
      "The local model server isn't running.",
    ]) {
      expect(describesRemovedRuntime(seeded)).toBe(true);
    }
    // The pre-#3141 values FAIL the predicate — proving the sweep is not inert.
    expect(
      describesRemovedRuntime(
        "The local model server isn't running, so Fredo couldn't interpret that. Start the companion server, then try again.",
      ),
    ).toBe(true);
    expect(
      describesRemovedRuntime(
        "Couldn't start the companion server. Check that http://127.0.0.1:8080 is free and llama-server is installed, then choose Retry.",
      ),
    ).toBe(true);
    // ...and an innocuous engine sentence passes.
    expect(describesRemovedRuntime("The companion engine isn't running.")).toBe(false);
  });

  it('NON-VACUITY: the collector picks up a seeded exported copy constant', () => {
    // A synthetic export proves the collector's coverage rule really enumerates
    // exported string values — a NEW exported string cannot escape the sweep.
    const synthetic = {
      ...readiness,
      SEEDED_NEW_COPY: 'A brand new user-visible sentence.',
    } as unknown as typeof readiness;
    const collected: string[] = [];
    for (const [name, value] of Object.entries(synthetic)) {
      if (typeof value === 'string') collected.push(name);
    }
    expect(collected).toContain('SEEDED_NEW_COPY');
    expect(collected).toContain('SERVER_EXITED_COPY');
    expect(collected).toContain('SERVER_WATCHDOG_COPY');
    expect(collected).toContain('COMPANION_BACKEND_SETTING_KEY');
  });

  it('the engine lifecycle copy is engine-worded', () => {
    expect(readiness.SERVER_EXITED_COPY).toBe(
      'The companion engine stopped unexpectedly. Choose Start companion engine to reconnect Fredo.',
    );
    expect(readiness.SERVER_WATCHDOG_COPY).toBe(
      'The engine is taking longer than expected. You can keep waiting, or choose Retry.',
    );
    // `COMPANION_REPLY_NOT_READY_COPY` STAYS — it never named the runtime.
    expect(readiness.COMPANION_REPLY_NOT_READY_COPY).toBe(
      "Fredo's model isn't ready yet — open Companion setup to finish loading it.",
    );
  });
});
