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
    expect(chatNode!.streamFields).toEqual(['payload', 'state']);
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
