/**
 * Spec #3244 ST-6 — the screen-read MEASUREMENT surface pins (AC-4).
 *
 * AC-4's record must be DERIVED FROM A RUN (G-511), and (schema v2) the recorded
 * NUMBER must be one that can express a screen-read limit. These pins drive the
 * REAL `screenReadRecord`:
 *   1. the AC-4 number is the outline's `utf8Bytes` — derived from the outline the
 *      run produced — carried with `nodeCount`/`truncated`/`bytesHeadroom` and the
 *      DERIVED `bindingCap`, and the caps in force come from the ONE constants;
 *   2. `screenshot.encodedImageTokens` is retained as RIG CONTEXT (NFR-1), never
 *      the limit — a constant across differently-sized screens must not change the
 *      AC-4 number;
 *   3. it REFUSES a run with no engine image-token readout (no fabricated number)
 *      and REFUSES an outline that claims to exceed the caps;
 *   4. a record round-trips through `serialize`/`parse`; a placeholder stub, an
 *      over-cap record, a self-inconsistent one, and a **v1** record all FAIL.
 */

import { describe, expect, it } from 'vitest';

import {
  SCREEN_READ_RECORD_AC,
  SCREEN_READ_RECORD_SCHEMA_VERSION,
  deriveBindingCap,
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
  it('records the OUTLINE bytes as the AC-4 number, with the caps in force', () => {
    const record = screenReadRecord({
      runIdentity: RUN,
      outline: OUTLINE,
      encodedImageTokens: 1120,
    });
    expect(record.schemaVersion).toBe(2);
    expect(record.schemaVersion).toBe(SCREEN_READ_RECORD_SCHEMA_VERSION);
    expect(record.ac).toBe(SCREEN_READ_RECORD_AC);
    expect(record.runIdentity).toEqual(RUN);
    // THE NUMBER.
    expect(record.outline.utf8Bytes).toBe(outlineBytes(OUTLINE));
    expect(record.outline.nodeCount).toBe(2);
    expect(record.outline.truncated).toBe(false);
    expect(record.outline.bytesHeadroom).toBe(SCREEN_OUTLINE_MAX_BYTES - outlineBytes(OUTLINE));
    expect(record.outline.bindingCap).toBe('none');
    // The screenshot leg's number is the value READ BACK from the run, retained as
    // rig-cost context — explicitly not the limit.
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

describe('the AC-4 number discriminates a screen, the image-token count does not', () => {
  // Two rungs of the same live ladder: identical encoded image tokens (the engine's
  // fixed cost for one window capture), very different outline sizes. This is the
  // discriminator schema v2 exists for — and it is proven with NO live app, using
  // the exact numbers the round-2 run observed on two different apps.
  const small: ScreenOutline = {
    nodes: Array.from({ length: 11 }, (_, index) => ({
      role: 'button',
      name: `small control ${index}`,
      tag: 'button',
      bbox: [0, index * 20, 80, 20],
    })),
    truncated: false,
  };
  const dense: ScreenOutline = {
    nodes: Array.from({ length: 68 }, (_, index) => ({
      role: 'button',
      name: `dense control ${index} with a longer accessible name`,
      tag: 'button',
      bbox: [0, index * 20, 200, 20],
    })),
    truncated: true,
  };

  it('differs by utf8Bytes while encodedImageTokens is identical', () => {
    const smallRecord = screenReadRecord({
      runIdentity: RUN,
      outline: small,
      encodedImageTokens: 840,
    });
    const denseRecord = screenReadRecord({
      runIdentity: RUN,
      outline: dense,
      encodedImageTokens: 840,
    });
    // The rig constant is EXPECTED to be identical — never a FAIL.
    expect(denseRecord.screenshot.encodedImageTokens).toBe(
      smallRecord.screenshot.encodedImageTokens,
    );
    // ...and the AC-4 number still discriminates.
    expect(denseRecord.outline.utf8Bytes).toBeGreaterThan(smallRecord.outline.utf8Bytes);
    expect(denseRecord.outline.nodeCount).toBeGreaterThan(smallRecord.outline.nodeCount);
    expect(denseRecord.outline.bytesHeadroom).toBeLessThan(smallRecord.outline.bytesHeadroom);
  });

  it('derives all three bindingCap branches by ONE rule', () => {
    expect(deriveBindingCap(false, 10, SCREEN_OUTLINE_MAX_NODES)).toBe('none');
    // truncated with the node count AT the node cap: the node cap bound.
    expect(deriveBindingCap(true, SCREEN_OUTLINE_MAX_NODES, SCREEN_OUTLINE_MAX_NODES)).toBe('nodes');
    // truncated with the node count under the cap: the byte fitter trimmed, so the
    // byte cap was the last binder.
    expect(deriveBindingCap(true, 68, SCREEN_OUTLINE_MAX_NODES)).toBe('bytes');
  });
});

describe('the record refuses an outline that could not have crossed', () => {
  it('REFUSES an over-cap byte outline', () => {
    const huge: ScreenOutline = {
      nodes: [
        {
          role: 'text',
          name: 'x'.repeat(SCREEN_OUTLINE_MAX_BYTES + 16),
          tag: 'p',
          bbox: [0, 0, 1, 1],
        },
      ],
      truncated: true,
    };
    expect(() =>
      screenReadRecord({ runIdentity: RUN, outline: huge, encodedImageTokens: 840 }),
    ).toThrow(/over the \d+-byte cap/);
  });

  it('REFUSES an over-cap node count', () => {
    const tooMany: ScreenOutline = {
      nodes: Array.from({ length: SCREEN_OUTLINE_MAX_NODES + 1 }, (_, index) => ({
        role: 'button',
        name: `node ${index}`,
        tag: 'button',
        bbox: [0, 0, 1, 1],
      })),
      truncated: true,
    };
    expect(() =>
      screenReadRecord({ runIdentity: RUN, outline: tooMany, encodedImageTokens: 840 }),
    ).toThrow(/over the \d+-node cap/);
  });
});

describe('the committed record round-trips and refuses everything that is not a measurement', () => {
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
      outline: {
        utf8Bytes: 'PENDING',
        nodeCount: null,
        truncated: false,
        bytesHeadroom: null,
        bindingCap: 'none',
      },
      screenshot: { encodedImageTokens: 'PENDING' },
      capsInForce: { maxNodes: SCREEN_OUTLINE_MAX_NODES, maxBytes: SCREEN_OUTLINE_MAX_BYTES },
    });
    expect(() => parseScreenReadRecord(stub)).toThrow(/no measured number/);
  });

  it('REFUSES a v1 record — the retired premise must not be re-blessable', () => {
    const v1 = JSON.stringify({
      schemaVersion: 1,
      ac: SCREEN_READ_RECORD_AC,
      runIdentity: RUN,
      // v1's shape: no bytesHeadroom / bindingCap, image tokens as "the number".
      outline: { utf8Bytes: 1049, nodeCount: 11, truncated: false },
      screenshot: { encodedImageTokens: 840 },
      capsInForce: { maxNodes: SCREEN_OUTLINE_MAX_NODES, maxBytes: SCREEN_OUTLINE_MAX_BYTES },
    });
    expect(() => parseScreenReadRecord(v1)).toThrow(/v2|AC-4 schema/);
  });

  it('REFUSES a record that is not the AC-4 schema', () => {
    expect(() => parseScreenReadRecord('{"hello":"world"}')).toThrow(/AC-4 schema/);
    expect(() => parseScreenReadRecord('not json')).toThrow(/not valid JSON/);
  });

  it('REFUSES a record whose derived fields contradict its own numbers', () => {
    const record = screenReadRecord({
      runIdentity: RUN,
      outline: OUTLINE,
      encodedImageTokens: 640,
    });
    // A self-consistent-but-wrong headroom (the class v2 retires).
    const wrongHeadroom = { ...record, outline: { ...record.outline, bytesHeadroom: 1 } };
    expect(() => parseScreenReadRecord(JSON.stringify(wrongHeadroom))).toThrow(/bytesHeadroom/);
    // A binding cap that contradicts (truncated, nodeCount, maxNodes).
    const wrongBinding = {
      ...record,
      outline: { ...record.outline, truncated: true, bindingCap: 'none' },
    };
    expect(() => parseScreenReadRecord(JSON.stringify(wrongBinding))).toThrow(/bindingCap/);
  });

  it('REFUSES a record that claims an over-cap outline crossed', () => {
    const record = screenReadRecord({
      runIdentity: RUN,
      outline: OUTLINE,
      encodedImageTokens: 640,
    });
    const overCap = {
      ...record,
      outline: {
        ...record.outline,
        utf8Bytes: SCREEN_OUTLINE_MAX_BYTES + 1,
        bytesHeadroom: 0,
      },
    };
    expect(() => parseScreenReadRecord(JSON.stringify(overCap))).toThrow(/over-cap/);
  });
});
