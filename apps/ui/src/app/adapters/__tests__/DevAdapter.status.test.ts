/**
 * #2918 ST-3 — the DevAdapter deterministic status twin (the G-172 in-repo
 * fixture). The dev server has no managed model server, so the twin must exercise
 * the SAME channel order the backend guarantees: reply tokens and then the status,
 * BEFORE the single completion.
 */

import { describe, it, expect, vi } from 'vitest';
import { DEV_REPLY_STATUS, DevAdapter } from '../DevAdapter';
import type { LlmMessage } from '../HostAdapter';

const messages: LlmMessage[] = [{ role: 'user', content: 'hello' }];

describe('#2918 ST-3 — DevAdapter.llmChatWithStatus twin', () => {
  it('emits the fixed status AFTER streaming and BEFORE the completion', async () => {
    const adapter = new DevAdapter();
    const order: string[] = [];
    // Spy the unchanged `llmChat` so the twin's ordering is pinned deterministically.
    vi.spyOn(adapter, 'llmChat').mockImplementation(
      async (_messages, onToken, onDone) => {
        onToken('mock');
        order.push('stream');
        onDone();
      },
    );

    const onStatus = vi.fn((status: string) => order.push(`status:${status}`));
    const onDone = vi.fn(() => order.push('done'));

    await adapter.llmChatWithStatus(
      messages,
      { offerSkills: true },
      vi.fn(),
      onDone,
      onStatus,
    );

    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledWith(DEV_REPLY_STATUS);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['stream', `status:${DEV_REPLY_STATUS}`, 'done']);
  });

  it('is deterministic across two turns (the same fixed status each time)', async () => {
    const adapter = new DevAdapter();
    vi.spyOn(adapter, 'llmChat').mockImplementation(async (_m, _onToken, onDone) => {
      onDone();
    });
    const first = vi.fn();
    const second = vi.fn();

    await adapter.llmChatWithStatus(messages, { offerSkills: false }, vi.fn(), vi.fn(), first);
    await adapter.llmChatWithStatus(messages, { offerSkills: false }, vi.fn(), vi.fn(), second);

    expect(first).toHaveBeenCalledWith(DEV_REPLY_STATUS);
    expect(second).toHaveBeenCalledWith(DEV_REPLY_STATUS);
    expect(DEV_REPLY_STATUS).toBe('happy');
  });
});
