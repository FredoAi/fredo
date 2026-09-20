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
 *   1. a typed install code → curated copy naming cause + next step;
 *   2. an unknown code → the safe generic fallback (`Something went wrong during …`);
 *   3. a download failure names the cause (disk space / writability / connection);
 *   4. a raw backend string is NEVER the primary `message` — it is demoted;
 *   5. the server launch reuses the existing curated server copy;
 *   6. absent detail → no `technicalDetail`.
 */

import { describe, it, expect } from 'vitest';

import {
  errorCopyFor,
  serverLaunchFailureCopy,
} from '@/shared/components/companion/companionReadiness';

describe('#2865 errorCopyFor — curated actionable failure copy', () => {
  it('maps the typed install code to curated copy naming cause + next step', () => {
    const copy = errorCopyFor(
      'llamaServer',
      'wingetUnavailable',
      "Couldn't install llama.cpp — winget isn't available. Choose Re-check.",
    );
    expect(copy.message).toContain("winget isn't available");
    expect(copy.message).toContain('Re-check');
    // The raw backend string is demoted, never the primary sentence.
    expect(copy.technicalDetail).toBe(
      "Couldn't install llama.cpp — winget isn't available. Choose Re-check.",
    );
  });

  it('falls back to a safe generic sentence for an unknown install code', () => {
    const copy = errorCopyFor('llamaServer', 'mystery', 'boom');
    expect(copy.message).toBe(
      'Something went wrong during the llama.cpp install. Choose Retry; if it persists, re-check.',
    );
    expect(copy.technicalDetail).toBe('boom');
  });

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

  it('routes the server launch through the existing curated server copy', () => {
    const copy = errorCopyFor('serverLaunch', 'spawnFailed', 'EPERM spawn llama-server');
    expect(copy.message).toBe(
      serverLaunchFailureCopy('spawnFailed', 'http://127.0.0.1:8080'),
    );
    expect(copy.technicalDetail).toBe('EPERM spawn llama-server');
  });
});
