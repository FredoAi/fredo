/**
 * MissionMonitorFeature.test.ts — ECE chat-node contract declaration shape.
 *
 * #2688 AC1/AC5: the chat-node contract MUST declare eventTypes ['chat'] and
 * transports ['otlp_grpc'] so that agent_session events and non-gRPC transports
 * produce no chat-node deliveries (kills duplicate + phantom chat nodes). The
 * remaining declaration fields (contractName, streamFields, key, completeWhen,
 * timeout) are locked so a future change to the contract shape is a test failure.
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
});
