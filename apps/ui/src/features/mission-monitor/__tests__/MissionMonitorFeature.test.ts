/**
 * MissionMonitorFeature.test.ts — ECE chat-node contract declaration shape.
 *
 * #2688 AC1/AC5: the chat-node contract MUST declare eventTypes ['chat'] and
 * transports ['otlp_grpc'] so that agent_session events and non-gRPC transports
 * produce no chat-node deliveries (kills duplicate + phantom chat nodes). The
 * remaining declaration fields (contractName, streamFields, key, completeWhen,
 * timeout) are locked so a future change to the contract shape is a test failure.
 *
 * #2723 AC5 (Spec #523 reversal): the contract MUST also declare excludePayload
 * rules (is_subagent / agent.type) so subagent chat events are filtered at the
 * engine level — zero subagent-derived deliveries ever reach Mission Monitor.
 */
import { describe, it, expect } from 'vitest';
import { missionMonitorFeature } from '../MissionMonitorFeature';

describe('MissionMonitorFeature chat-node ECE contract', () => {
  const chatNode = missionMonitorFeature.eventContracts.find(
    (c) => c.contractName === 'chat-node',
  );

  it('declares exactly one chat-node contract', () => {
    expect(chatNode).toBeDefined();
  });

  it('restricts eventTypes to chat only (no agent_session)', () => {
    expect(chatNode!.eventTypes).toEqual(['chat']);
    expect(chatNode!.eventTypes).not.toContain('agent_session');
  });

  it('restricts transports to otlp_grpc only', () => {
    expect(chatNode!.transports).toEqual(['otlp_grpc']);
  });

  it('keeps the chat-node contract shape unchanged', () => {
    expect(chatNode!.contractName).toBe('chat-node');
    // #2743 ST-1 (AC-12): the whole `payload` stream field keeps delivering
    // every flat fredo-native attr; the four dotted 2-level declarations
    // satisfy AC-12's declaration clause (extracted when a chat span carries
    // them — the frontend never depends on their presence).
    expect(chatNode!.streamFields).toEqual([
      'payload',
      'state',
      'payload.cost_usd',
      'payload.total_tokens',
      'payload.total_messages',
      'payload.total_cost_usd',
    ]);
    expect(chatNode!.deferredFields).toEqual([]);
    expect(chatNode!.key).toEqual(['sessionId', 'correlationId']);
    expect(chatNode!.completeWhen).toBe("state === 'Response'");
    expect(chatNode!.timeout).toBe(300000);
  });

  it('AC5: declares excludePayload rules excluding subagent chat events', () => {
    expect(chatNode!.excludePayload).toEqual([
      { path: 'is_subagent', equals: true },
      { path: 'agent.type', equals: 'subagent' },
    ]);
  });

  it('AC5: the exclusion rules match the OTLP adapter flat span attributes', () => {
    // The OTLP adapter injects `is_subagent` (boolean) and `agent.type`
    // (string) as flat payload attributes on subagent session spans. The
    // contract's rules must target those exact paths so ANY subagent event
    // matches at least one rule (ANY-rule semantics in the ECE engine).
    const rules = chatNode!.excludePayload!;
    const paths = rules.map((r) => r.path);
    expect(paths).toContain('is_subagent');
    expect(paths).toContain('agent.type');
    const boolRule = rules.find((r) => r.path === 'is_subagent');
    const typeRule = rules.find((r) => r.path === 'agent.type');
    expect(boolRule!.equals).toBe(true);
    expect(typeRule!.equals).toBe('subagent');
  });
});

// ── #2743 ST-1 (AC-10): tool-use-lifecycle contract declaration shape ────────
//
// The tool-use-lifecycle contract must deliver the whole `payload` (flat
// tool.success / tool.error / duration_ms keys) and additionally declare the
// safe 2-level dotted `payload.duration_ms` streamField. `tool.success` /
// `tool.error` are NEVER declared as ECE paths — the literal dot in the key
// would mis-split into a 3-level path and silently strip (the repo's 2-level
// rule). Locked here so a future change to the declaration shape is a test
// failure.

describe('MissionMonitorFeature tool-use-lifecycle ECE contract (#2743 ST-1)', () => {
  const toolContract = missionMonitorFeature.eventContracts.find(
    (c) => c.contractName === 'tool-use-lifecycle',
  );

  it('declares exactly one tool-use-lifecycle contract', () => {
    expect(toolContract).toBeDefined();
  });

  it('keeps the tool-use-lifecycle contract shape', () => {
    expect(toolContract!.contractName).toBe('tool-use-lifecycle');
    expect(toolContract!.streamFields).toEqual([
      'payload',
      'state',
      'payload.duration_ms',
    ]);
    expect(toolContract!.deferredFields).toEqual([]);
    expect(toolContract!.key).toEqual(['sessionId', 'correlationId']);
    expect(toolContract!.completeWhen).toBe("state === 'Response'");
    expect(toolContract!.timeout).toBe(300000);
    expect(toolContract!.transports).toEqual(['otlp_grpc']);
    expect(toolContract!.eventTypes).toEqual(['tool_use']);
  });

  it('AC-9/AC-10: never declares tool.success / tool.error as ECE paths', () => {
    // The literal-dot keys can never be dotted streamFields (3-level strip
    // trap). They are read from the whole `payload` in upsertToolCallSummary.
    expect(toolContract!.streamFields).not.toContain('payload.tool.success');
    expect(toolContract!.streamFields).not.toContain('payload.tool.error');
    expect(toolContract!.streamFields).toContain('payload.duration_ms');
  });

  it('keeps the subagent excludePayload rules (Spec #523 reversal)', () => {
    expect(toolContract!.excludePayload).toEqual([
      { path: 'is_subagent', equals: true },
      { path: 'agent.type', equals: 'subagent' },
    ]);
  });
});
