/**
 * Spec #3244 ST-6 — the screen-read MEASUREMENT surface pins (AC-4).
 *
 * AC-4's record must be DERIVED FROM A RUN (G-511), so these pins drive the REAL
 * `screenReadRecord`:
 *   1. it derives the outline's byte count + node count from the outline the run
 *      produced, and reads the caps in force from the ONE constants;
 *   2. it REFUSES a run with no engine image-token readout (no fabricated number);
 *   3. a record round-trips through `serialize`/`parse`, and a placeholder stub
 *      (no measured numbers) FAILS to parse.
 */

import { describe, expect, it } from 'vitest';

import {
  SCREEN_READ_RECORD_AC,
  SCREEN_READ_RECORD_SCHEMA_VERSION,
  parseScreenReadRecord,
  screenReadRecord,
  serializeScreenReadRecord,
  type ScreenReadRunIdentity,
} from '@/shared/app-intelligibility/measurement';
import {
  SCREEN_OUTLINE_MAX_BYTES,
  SCREEN_OUTLINE_MAX_NODES,
  outlineBytes,
  type ScreenOutline,
} from '@/shared/app-intelligibility/screenOutline';

const RUN: ScreenReadRunIdentity = {
  commit: '8f7173829e3f341e3fc4bde68af3dd5b7c191d6f',
  capturedAt: '2026-11-26T12:00:00.000Z',
  appId: 'mission-monitor',
  injectionSpanId: '11111111-2222-3333-4444-555555555555',
};

const OUTLINE: ScreenOutline = {
  nodes: [
    { role: 'heading', name: 'Mission Monitor', tag: 'h1', bbox: [0, 0, 200, 24] },
    { role: 'button', name: 'Start run', tag: 'button', bbox: [0, 40, 80, 24] },
  ],
  truncated: false,
};

describe('screenReadRecord — derived from a run, never hand-authored (G-511)', () => {
  it('derives the outline size from the outline and reads the caps in force', () => {
    const record = screenReadRecord({
      runIdentity: RUN,
      outline: OUTLINE,
      encodedImageTokens: 1120,
    });
    expect(record.schemaVersion).toBe(SCREEN_READ_RECORD_SCHEMA_VERSION);
    expect(record.ac).toBe(SCREEN_READ_RECORD_AC);
    expect(record.runIdentity).toEqual(RUN);
    expect(record.outline.utf8Bytes).toBe(outlineBytes(OUTLINE));
    expect(record.outline.nodeCount).toBe(2);
    expect(record.outline.truncated).toBe(false);
    // The screenshot leg's number is the value READ BACK from the run.
    expect(record.screenshot.encodedImageTokens).toBe(1120);
    // The caps are the ONE constants — never a second copy.
    expect(record.capsInForce).toEqual({
      maxNodes: SCREEN_OUTLINE_MAX_NODES,
      maxBytes: SCREEN_OUTLINE_MAX_BYTES,
    });
  });

  it('REFUSES a run with no engine image-token readout — no fabricated number', () => {
    expect(() =>
      screenReadRecord({ runIdentity: RUN, outline: OUTLINE, encodedImageTokens: null }),
    ).toThrow(/image-token count/);
  });

  it('re-derives the byte count when the outline changes (freshness is observable)', () => {
    const before = screenReadRecord({ runIdentity: RUN, outline: OUTLINE, encodedImageTokens: 3 });
    const after = screenReadRecord({
      runIdentity: RUN,
      outline: { nodes: OUTLINE.nodes.slice(0, 1), truncated: true },
      encodedImageTokens: 3,
    });
    expect(after.outline.utf8Bytes).not.toBe(before.outline.utf8Bytes);
    expect(after.outline.nodeCount).toBe(1);
    expect(after.outline.truncated).toBe(true);
  });
});

describe('the committed record round-trips and refuses a placeholder', () => {
  it('serialize then parse returns the same record', () => {
    const record = screenReadRecord({
      runIdentity: RUN,
      outline: OUTLINE,
      encodedImageTokens: 640,
    });
    const text = serializeScreenReadRecord(record);
    expect(parseScreenReadRecord(text)).toEqual(record);
  });

  it('REFUSES a hand-authored stub with no measured numbers', () => {
    const stub = JSON.stringify({
      schemaVersion: SCREEN_READ_RECORD_SCHEMA_VERSION,
      ac: SCREEN_READ_RECORD_AC,
      runIdentity: RUN,
      outline: { utf8Bytes: 'PENDING', nodeCount: null, truncated: false },
      screenshot: { encodedImageTokens: 'PENDING' },
      capsInForce: { maxNodes: SCREEN_OUTLINE_MAX_NODES, maxBytes: SCREEN_OUTLINE_MAX_BYTES },
    });
    expect(() => parseScreenReadRecord(stub)).toThrow(/no measured number/);
  });

  it('REFUSES a record that is not the AC-4 schema', () => {
    expect(() => parseScreenReadRecord('{"hello":"world"}')).toThrow(/AC-4 schema/);
    expect(() => parseScreenReadRecord('not json')).toThrow(/not valid JSON/);
  });
});
