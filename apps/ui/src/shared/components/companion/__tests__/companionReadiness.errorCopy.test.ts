/**
 * #2865 ST-2 (H3 / R-2.2) — `errorCopyFor` curated failure copy.
 *
 * The action handlers capture RAW backend/IPC strings (`result.error`, a thrown
 * `String(err)`). Those must never be the primary user-facing error sentence.
 * `errorCopyFor(id, code, errorText)` maps a step + optional backend code to a
 * curated, actionable sentence naming cause + next step, and returns the raw
 * string as a demoted `technicalDetail`.
 *
 * Proves:
 *   1. a download failure names the cause (disk space / writability / connection);
 *   2. a raw backend string is NEVER the primary `message` — it is demoted;
 *   3. the engine start routes through the typed engine-copy table (#3141 ST-6);
 *   4. absent detail → no `technicalDetail`.
 *
 * Spec #3141 ST-6 (G-411): the retired `llamaServer` install cases are gone with
 * the step; the engine-start leg keeps its assertion STRENGTH (the typed code's
 * exact sentence), re-pointed onto `engineFailureCopy`.
 */

import { describe, it, expect } from 'vitest';

import {
  engineFailureCopy,
  errorCopyFor,
} from '@/shared/components/companion/companionReadiness';

describe('#2865 errorCopyFor — curated actionable failure copy', () => {
  it('names a writability cause for a download that could not create files (H3 observed string)', () => {
    const raw =
      'failed to create C:\\Code\\fredo\\.opencode\\tmp\\2865\\fixture-unwritable\\gemma-4-e2b-it-qat';
    const copy = errorCopyFor('modelFiles', null, raw);
    expect(copy.message).toContain('writable');
    expect(copy.message).toContain('Retry');
    // The exact observed raw string must not be the primary sentence.
    expect(copy.message).not.toContain('failed to create');
    expect(copy.message).not.toBe(raw);
    expect(copy.technicalDetail).toBe(raw);
  });

  it('names a connection cause for a transport failure', () => {
    const copy = errorCopyFor('modelFiles', null, 'connection reset by peer');
    expect(copy.message).toContain('connection');
    expect(copy.message).toContain('Retry');
    expect(copy.technicalDetail).toBe('connection reset by peer');
  });

  it('names a disk-space cause for an out-of-space failure', () => {
    const copy = errorCopyFor('modelFiles', null, 'No space left on device (ENOSPC)');
    expect(copy.message).toContain('disk space');
    expect(copy.technicalDetail).toBe('No space left on device (ENOSPC)');
  });

  it('uses the safe generic fallback for an unclassifiable download failure', () => {
    const copy = errorCopyFor('modelFiles', null, 'boom');
    expect(copy.message).toBe(
      'Something went wrong during the model download. Choose Retry; if it persists, re-check.',
    );
    expect(copy.technicalDetail).toBe('boom');
  });

  it('omits the technical detail when there is no raw backend string', () => {
    const copy = errorCopyFor('modelFiles', null, null);
    expect(copy.message).toContain('Something went wrong');
    expect(copy.technicalDetail).toBeNull();
  });

  it('routes the engine start through the typed engine-copy table', () => {
    const copy = errorCopyFor('serverLaunch', 'gpuUnavailable', 'raw GPU refusal');
    expect(copy.message).toBe(engineFailureCopy('gpuUnavailable').sentence);
    expect(copy.message).toContain('no usable GPU');
    expect(copy.technicalDetail).toBe('raw GPU refusal');
  });

  it('uses the null-code engine row for an invoke rejection with no typed code', () => {
    const copy = errorCopyFor('serverLaunch', null, 'EPERM spawn');
    expect(copy.message).toBe(engineFailureCopy(null).sentence);
    expect(copy.technicalDetail).toBe('EPERM spawn');
  });
});
