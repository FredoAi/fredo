/**
 * Tests for the surviving ECE graph helpers.
 *
 * Covers the delivery-verification helpers that remain public API after the
 * contract* stub cleanup: isChatNodeDelivery, deliverySessionId,
 * deliveryCorrelationId, and extractDeliveryPayload.
 */
import { describe, it, expect } from 'vitest';
import type { ContractDelivery } from '../../../../shared/classes/EventSubscription';
import {
  isChatNodeDelivery,
  deliverySessionId,
  deliveryCorrelationId,
  extractDeliveryPayload,
  normalizeTokenCount,
} from '../graph';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDelivery(overrides: Partial<ContractDelivery> = {}): ContractDelivery {
  return {
    id: 'test-id',
    contractName: 'chat-node',
    lifecycle: 'init',
    key: { sessionId: 's1', correlationId: 'corr-1' },
    payload: {},
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ── isChatNodeDelivery ────────────────────────────────────────────────────────

describe('isChatNodeDelivery', () => {
  it('returns true for chat-node contract', () => {
    expect(isChatNodeDelivery(makeDelivery({ contractName: 'chat-node' }))).toBe(true);
  });

  it('returns false for any other contract', () => {
    expect(isChatNodeDelivery(makeDelivery({ contractName: 'tool-use-lifecycle' }))).toBe(false);
    expect(isChatNodeDelivery(makeDelivery({ contractName: 'subagent-lifecycle' }))).toBe(false);
    expect(isChatNodeDelivery(makeDelivery({ contractName: 'custom-event' }))).toBe(false);
    expect(isChatNodeDelivery(makeDelivery({ contractName: 'unknown' }))).toBe(false);
  });
});

// ── deliverySessionId ─────────────────────────────────────────────────────────

describe('deliverySessionId', () => {
  it('extracts sessionId from any contract', () => {
    const d = makeDelivery({ key: { sessionId: 'sess-42', correlationId: 'c1' } });
    expect(deliverySessionId(d)).toBe('sess-42');
  });

  it('falls back to unknown when key.sessionId is missing', () => {
    const d = makeDelivery({ key: { correlationId: 'c1' } as Record<string, string> });
    expect(deliverySessionId(d)).toBe('unknown');
  });
});

// ── deliveryCorrelationId ─────────────────────────────────────────────────────

describe('deliveryCorrelationId', () => {
  it('extracts correlationId from any contract', () => {
    const d = makeDelivery({ key: { sessionId: 's1', correlationId: 'sub-corr' } });
    expect(deliveryCorrelationId(d)).toBe('sub-corr');
  });

  it('falls back to delivery id when key.correlationId is missing', () => {
    const d = makeDelivery({ id: 'fallback-id', key: { sessionId: 's1' } as Record<string, string> });
    expect(deliveryCorrelationId(d)).toBe('fallback-id');
  });
});

// ── extractDeliveryPayload ────────────────────────────────────────────────────

describe('extractDeliveryPayload', () => {
  it('reads the inner payload from the ECE 2-level nesting', () => {
    const d = makeDelivery({
      payload: {
        payload: { userMessage: 'Hello, can you help me?', agentReply: 'Sure!' },
      },
    });
    const inner = extractDeliveryPayload(d);
    expect(inner.userMessage).toBe('Hello, can you help me?');
    expect(inner.agentReply).toBe('Sure!');
  });

  it('falls back to the outer payload when the inner payload is missing', () => {
    const d = makeDelivery({
      payload: { userMessage: 'outer', state: 'Init' },
    });
    const inner = extractDeliveryPayload(d);
    expect(inner.userMessage).toBe('outer');
  });

  it('returns empty object when both payloads are missing', () => {
    const d = makeDelivery({ payload: {} });
    expect(extractDeliveryPayload(d)).toEqual({});
  });
});

// ── normalizeTokenCount (Spec #2717 R-3.3) ───────────────────────────────────

describe('normalizeTokenCount (#2717 R-3.3)', () => {
  it('passes non-negative numbers through unchanged', () => {
    expect(normalizeTokenCount(0)).toBe(0);
    expect(normalizeTokenCount(420)).toBe(420);
    expect(normalizeTokenCount(1_234)).toBe(1_234);
    expect(normalizeTokenCount(2_500_000)).toBe(2_500_000);
  });

  it('maps absent, non-number, negative, and NaN figures to 0', () => {
    expect(normalizeTokenCount(undefined)).toBe(0);
    expect(normalizeTokenCount(null)).toBe(0);
    expect(normalizeTokenCount('100')).toBe(0);
    expect(normalizeTokenCount(NaN)).toBe(0);
    expect(normalizeTokenCount(-1)).toBe(0);
    expect(normalizeTokenCount(-0)).toBe(0);
    expect(normalizeTokenCount(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
