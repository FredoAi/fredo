/**
 * #2918 ST-3 — focused pins for the structured-status transport on `TauriAdapter`.
 *
 * The `@tauri-apps/api` event/core modules are mocked so the dynamic imports in
 * `TauriAdapter` resolve to an in-memory listener registry. The pins assert the
 * two contract-critical properties of the new path:
 *   1. the `llm-status` listener is registered BEFORE the `llm_chat_with_status`
 *      invoke (so a status emitted before `llm-done` is never missed), and
 *   2. the additive channel forwards exactly what the backend sends — the adapter
 *      never synthesizes a status when the backend emits none (R-7),
 *      with the single `finish()` settle guard preserved.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LlmMessage, LlmSkillCall } from '../HostAdapter';

type Handler = (event: { payload: unknown }) => void;

const h = vi.hoisted(() => ({
  listeners: new Map<string, Handler>(),
  unlisten: new Map<string, ReturnType<typeof vi.fn>>(),
  listenMock: vi.fn(),
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: h.listenMock }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invokeMock }));

import { TauriAdapter } from '../TauriAdapter';

const messages: LlmMessage[] = [{ role: 'user', content: 'hello' }];

function emit(event: string, payload: unknown): void {
  const handler = h.listeners.get(event);
  if (!handler) throw new Error(`no listener registered for ${event}`);
  handler({ payload });
}

describe('#2918 ST-3 — TauriAdapter.llmChatWithStatus', () => {
  beforeEach(() => {
    h.listeners.clear();
    h.unlisten.clear();
    h.listenMock.mockReset();
    h.invokeMock.mockReset();
    h.listenMock.mockImplementation(async (event: string, handler: Handler) => {
      h.listeners.set(event, handler);
      const un = vi.fn();
      h.unlisten.set(event, un);
      return un;
    });
    h.invokeMock.mockResolvedValue(undefined);
  });

  it('registers the llm-status listener BEFORE invoking, then forwards status → done', async () => {
    const adapter = new TauriAdapter();
    const onToken = vi.fn();
    const onDone = vi.fn();
    const onStatus = vi.fn();

    const pending = adapter.llmChatWithStatus(
      messages,
      { offerSkills: true },
      onToken,
      onDone,
      onStatus,
    );

    await vi.waitFor(() => expect(h.invokeMock).toHaveBeenCalledTimes(1));

    // Registration order: the status listener must exist before the invoke.
    const statusCallIndex = h.listenMock.mock.calls.findIndex((c) => c[0] === 'llm-status');
    const doneCallIndex = h.listenMock.mock.calls.findIndex((c) => c[0] === 'llm-done');
    expect(statusCallIndex).toBeGreaterThanOrEqual(0);
    expect(doneCallIndex).toBeGreaterThan(statusCallIndex);
    expect(h.listenMock.mock.invocationCallOrder[statusCallIndex]).toBeLessThan(
      h.invokeMock.mock.invocationCallOrder[0],
    );

    // The command + the request-shape options reach the backend verbatim.
    expect(h.invokeMock).toHaveBeenCalledWith('llm_chat_with_status', {
      messages,
      offerSkills: true,
      audioBase64: undefined,
    });

    // Backend stream: decoded reply tokens, the parsed status, then done.
    emit('llm-token', 'hi');
    emit('llm-status', 'joking');
    emit('llm-done', undefined);
    await pending;

    expect(onToken).toHaveBeenCalledWith('hi');
    expect(onStatus).toHaveBeenCalledWith('joking');
    expect(onDone).toHaveBeenCalledTimes(1);
    // Every listener is torn down on settle.
    expect(h.unlisten.get('llm-status')).toHaveBeenCalledTimes(1);
    expect(h.unlisten.get('llm-token')).toHaveBeenCalledTimes(1);
    expect(h.unlisten.get('llm-done')).toHaveBeenCalledTimes(1);
  });

  it('R-7 — no synthesized status: a turn with no llm-status call completes silently', async () => {
    const adapter = new TauriAdapter();
    const onStatus = vi.fn();
    const onDone = vi.fn();

    const pending = adapter.llmChatWithStatus(
      messages,
      { offerSkills: false },
      vi.fn(),
      onDone,
      onStatus,
    );
    await vi.waitFor(() => expect(h.invokeMock).toHaveBeenCalledTimes(1));

    emit('llm-token', 'plain reply');
    emit('llm-done', undefined);
    await pending;

    expect(onStatus).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('preserves the single finish() guard across an llm-error → llm-done pair', async () => {
    const adapter = new TauriAdapter();
    const onDone = vi.fn();
    const onError = vi.fn();

    const pending = adapter.llmChatWithStatus(
      messages,
      { offerSkills: true },
      vi.fn(),
      onDone,
      vi.fn(),
      undefined,
      onError,
    );
    await vi.waitFor(() => expect(h.invokeMock).toHaveBeenCalledTimes(1));

    emit('llm-error', 'boom');
    emit('llm-done', undefined);
    await pending;

    expect(onError).toHaveBeenCalledWith('boom');
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('binds the optional llm-skill-call channel before the invoke when supplied', async () => {
    const adapter = new TauriAdapter();
    const onSkillCall = vi.fn();
    const call: LlmSkillCall = { skill: 'open_app', arguments: { app: 'Settings' } };

    const pending = adapter.llmChatWithStatus(
      messages,
      { offerSkills: true, audioBase64: 'QUJD' },
      vi.fn(),
      vi.fn(),
      vi.fn(),
      onSkillCall,
    );
    await vi.waitFor(() => expect(h.invokeMock).toHaveBeenCalledTimes(1));

    const skillIndex = h.listenMock.mock.calls.findIndex((c) => c[0] === 'llm-skill-call');
    expect(skillIndex).toBeGreaterThanOrEqual(0);
    expect(h.listenMock.mock.invocationCallOrder[skillIndex]).toBeLessThan(
      h.invokeMock.mock.invocationCallOrder[0],
    );
    expect(h.invokeMock).toHaveBeenCalledWith('llm_chat_with_status', {
      messages,
      offerSkills: true,
      audioBase64: 'QUJD',
    });

    emit('llm-skill-call', call);
    emit('llm-done', undefined);
    await pending;

    expect(onSkillCall).toHaveBeenCalledWith(call);
  });
});
