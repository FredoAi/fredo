/**
 * PREREQUISITE: Requires vitest and jsdom to be installed in apps/ui/package.json.
 *   npm i -D vitest jsdom
 * Run with: npx vitest run
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { adapterBridge } from '../adapterBridge';
import type { LlmMessage, LlmSkillCall } from '../../../app/adapters/HostAdapter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockMessages(): LlmMessage[] {
  return [{ role: 'user', content: 'hello' }];
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('adapterBridge', () => {
  beforeEach(() => {
    // Reset all internal registrations so each test starts clean
    adapterBridge.setInvoke(undefined as any);
    adapterBridge.setListen(undefined as any);
    adapterBridge.setLlmChat(undefined as any);
    adapterBridge.setLlmChatWithImage(undefined as any);
    adapterBridge.setLlmChatWithSkills(undefined);
    adapterBridge.setLlmChatWithAudio(undefined);
    adapterBridge.setLlmChatWithStatus(undefined);
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Setters
  // -----------------------------------------------------------------------

  describe('setInvoke', () => {
    it('registers an invoke function that is called on invoke()', async () => {
      const mockInvoke = vi.fn().mockResolvedValue('mock-result');
      adapterBridge.setInvoke(mockInvoke);

      const result = await adapterBridge.invoke('test-cmd', { key: 'val' });

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke).toHaveBeenCalledWith('test-cmd', { key: 'val' });
      expect(result).toBe('mock-result');
    });
  });

  describe('setListen', () => {
    it('registers a listen function that is called on listen()', async () => {
      const mockUnlisten = vi.fn();
      const mockListen = vi.fn().mockResolvedValue(mockUnlisten);
      adapterBridge.setListen(mockListen);

      const handler = vi.fn();
      const unlisten = await adapterBridge.listen('test-event', handler);

      expect(mockListen).toHaveBeenCalledTimes(1);
      expect(mockListen).toHaveBeenCalledWith('test-event', handler);
      expect(unlisten).toBe(mockUnlisten);
    });
  });

  describe('setLlmChat', () => {
    it('registers an llmChat function that is called on llmChat()', async () => {
      const onToken = vi.fn();
      const onDone = vi.fn();
      const mockChat = vi.fn(
        async (
          _messages: LlmMessage[],
          _onToken: (token: string) => void,
          _onDone: () => void,
        ) => {
          _onToken('token-1');
          _onToken('token-2');
          _onDone();
        },
      );
      adapterBridge.setLlmChat(mockChat);

      const messages = createMockMessages();
      await adapterBridge.llmChat(messages, onToken, onDone);

      expect(mockChat).toHaveBeenCalledTimes(1);
      expect(mockChat).toHaveBeenCalledWith(messages, onToken, onDone);
      expect(onToken).toHaveBeenCalledTimes(2);
      expect(onToken).toHaveBeenNthCalledWith(1, 'token-1');
      expect(onToken).toHaveBeenNthCalledWith(2, 'token-2');
      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });

  describe('setLlmChatWithImage', () => {
    it('registers an llmChatWithImage function that is called on llmChatWithImage()', async () => {
      const onToken = vi.fn();
      const onDone = vi.fn();
      const mockChat = vi.fn(
        async (
          _messages: LlmMessage[],
          _imageBase64: string,
          _onToken: (token: string) => void,
          _onDone: () => void,
        ) => {
          _onToken('img-token');
          _onDone();
        },
      );
      adapterBridge.setLlmChatWithImage(mockChat);

      const messages = createMockMessages();
      await adapterBridge.llmChatWithImage(messages, 'base64img==', onToken, onDone);

      expect(mockChat).toHaveBeenCalledTimes(1);
      expect(mockChat).toHaveBeenCalledWith(messages, 'base64img==', onToken, onDone);
      expect(onToken).toHaveBeenCalledTimes(1);
      expect(onToken).toHaveBeenCalledWith('img-token');
      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });

  // #2893 ST-7 — the skill-aware forwarding path.
  describe('setLlmChatWithSkills', () => {
    it('forwards messages + the skill-call channel and completes the caller', async () => {
      const onToken = vi.fn();
      const onDone = vi.fn();
      const onSkillCall = vi.fn();
      const call: LlmSkillCall = { skill: 'open_app', arguments: { app: 'Mission Monitor' } };
      const mockChat = vi.fn(
        async (
          _messages: LlmMessage[],
          _onToken: (token: string) => void,
          _onDone: () => void,
          _onSkillCall: (c: LlmSkillCall) => void,
        ) => {
          _onSkillCall(call);
          _onDone();
        },
      );
      adapterBridge.setLlmChatWithSkills(mockChat);

      const messages = createMockMessages();
      await adapterBridge.llmChatWithSkills(messages, onToken, onDone, onSkillCall);

      expect(mockChat).toHaveBeenCalledTimes(1);
      expect(mockChat).toHaveBeenCalledWith(messages, onToken, onDone, onSkillCall);
      expect(onSkillCall).toHaveBeenCalledWith(call);
      expect(onDone).toHaveBeenCalledTimes(1);
    });

    it('forwards the optional error channel only when supplied', async () => {
      const onError = vi.fn();
      const mockChat = vi.fn(
        async (
          _messages: LlmMessage[],
          _onToken: (token: string) => void,
          _onDone: () => void,
          _onSkillCall: (c: LlmSkillCall) => void,
          _onError?: (message: string) => void,
        ) => {
          _onError?.('boom');
        },
      );
      adapterBridge.setLlmChatWithSkills(mockChat);

      await adapterBridge.llmChatWithSkills(createMockMessages(), vi.fn(), vi.fn(), vi.fn(), onError);

      expect(mockChat).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        onError,
      );
      expect(onError).toHaveBeenCalledWith('boom');
    });

    it('unregistered — warns and still completes (never hangs)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const onDone = vi.fn();

      await adapterBridge.llmChatWithSkills(createMockMessages(), vi.fn(), onDone, vi.fn());

      expect(warnSpy).toHaveBeenCalledWith(
        '[adapterBridge] llmChatWithSkills called before adapter registered',
      );
      expect(onDone).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });
  });

  // #2897 ST-3 — the model-audio forwarding path.
  describe('setLlmChatWithAudio', () => {
    it('forwards messages + the clip + completes the caller', async () => {
      const onToken = vi.fn();
      const onDone = vi.fn();
      const mockChat = vi.fn(
        async (
          _messages: LlmMessage[],
          _audioBase64: string,
          _onToken: (token: string) => void,
          _onDone: () => void,
        ) => {
          _onToken('audio-token');
          _onDone();
        },
      );
      adapterBridge.setLlmChatWithAudio(mockChat);

      const messages = createMockMessages();
      await adapterBridge.llmChatWithAudio(messages, 'UklGRg==', onToken, onDone);

      expect(mockChat).toHaveBeenCalledTimes(1);
      expect(mockChat).toHaveBeenCalledWith(messages, 'UklGRg==', onToken, onDone);
      expect(onToken).toHaveBeenCalledWith('audio-token');
      expect(onDone).toHaveBeenCalledTimes(1);
    });

    it('forwards the optional error channel only when supplied', async () => {
      const onError = vi.fn();
      const mockChat = vi.fn(
        async (
          _messages: LlmMessage[],
          _audioBase64: string,
          _onToken: (token: string) => void,
          _onDone: () => void,
          _onError?: (message: string) => void,
        ) => {
          _onError?.('boom');
        },
      );
      adapterBridge.setLlmChatWithAudio(mockChat);

      await adapterBridge.llmChatWithAudio(createMockMessages(), 'QUJD', vi.fn(), vi.fn(), onError);

      expect(mockChat).toHaveBeenCalledWith(
        expect.anything(),
        'QUJD',
        expect.anything(),
        expect.anything(),
        onError,
      );
      expect(onError).toHaveBeenCalledWith('boom');
    });

    // #2903 ST-2 — the additive trailing skill channel (AFTER `onError`) that
    // makes the model-audio path skill-aware.
    it('forwards the additive onSkillCall channel on the model-audio path (#2903)', async () => {
      const onToken = vi.fn();
      const onDone = vi.fn();
      const onError = vi.fn();
      const onSkillCall = vi.fn();
      const call: LlmSkillCall = { skill: 'open_app', arguments: { app: 'Settings' } };
      const mockChat = vi.fn(
        async (
          _messages: LlmMessage[],
          _audioBase64: string,
          _onToken: (token: string) => void,
          _onDone: () => void,
          _onError?: (message: string) => void,
          _onSkillCall?: (c: LlmSkillCall) => void,
        ) => {
          _onSkillCall?.(call);
          _onDone();
        },
      );
      adapterBridge.setLlmChatWithAudio(mockChat);

      const messages = createMockMessages();
      await adapterBridge.llmChatWithAudio(messages, 'QUJD', onToken, onDone, onError, onSkillCall);

      expect(mockChat).toHaveBeenCalledTimes(1);
      expect(mockChat).toHaveBeenCalledWith(
        messages,
        'QUJD',
        onToken,
        onDone,
        onError,
        onSkillCall,
      );
      expect(onSkillCall).toHaveBeenCalledWith(call);
      expect(onDone).toHaveBeenCalledTimes(1);
    });

    it('keeps the 4-arg model-audio call contract byte-identical when no onSkillCall is supplied (#2903)', async () => {
      const onToken = vi.fn();
      const onDone = vi.fn();
      const mockChat = vi.fn(async () => {});
      adapterBridge.setLlmChatWithAudio(mockChat);

      const messages = createMockMessages();
      await adapterBridge.llmChatWithAudio(messages, 'QUJD', onToken, onDone);

      expect(mockChat).toHaveBeenCalledTimes(1);
      expect(mockChat).toHaveBeenCalledWith(messages, 'QUJD', onToken, onDone);
      // Byte-identical: exactly four arguments — no trailing `undefined` slots are
      // introduced by the additive skill channel.
      expect(mockChat.mock.calls[0]).toHaveLength(4);
    });

    it('unregistered — warns and still completes (never hangs)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const onDone = vi.fn();

      await adapterBridge.llmChatWithAudio(createMockMessages(), 'QUJD', vi.fn(), onDone);

      expect(warnSpy).toHaveBeenCalledWith(
        '[adapterBridge] llmChatWithAudio called before adapter registered',
      );
      expect(onDone).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });
  });

  // #2918 ST-3 — the structured-status forwarding path.
  describe('setLlmChatWithStatus', () => {
    it('forwards messages + options + the status channel and completes the caller', async () => {
      const onToken = vi.fn();
      const onDone = vi.fn();
      const onStatus = vi.fn();
      const mockChat = vi.fn(
        async (
          _messages: LlmMessage[],
          _options: { offerSkills: boolean; audioBase64?: string },
          _onToken: (token: string) => void,
          _onDone: () => void,
          _onStatus: (status: string) => void,
        ) => {
          _onToken('reply-token');
          _onStatus('joking');
          _onDone();
        },
      );
      adapterBridge.setLlmChatWithStatus(mockChat);

      const messages = createMockMessages();
      const options = { offerSkills: true };
      await adapterBridge.llmChatWithStatus(messages, options, onToken, onDone, onStatus);

      expect(mockChat).toHaveBeenCalledTimes(1);
      expect(mockChat).toHaveBeenCalledWith(messages, options, onToken, onDone, onStatus);
      expect(onToken).toHaveBeenCalledWith('reply-token');
      expect(onStatus).toHaveBeenCalledWith('joking');
      expect(onDone).toHaveBeenCalledTimes(1);
    });

    it('forwards the additive onSkillCall channel, then onError, only when supplied', async () => {
      const onDone = vi.fn();
      const onStatus = vi.fn();
      const onSkillCall = vi.fn();
      const onError = vi.fn();
      const call: LlmSkillCall = { skill: 'open_app', arguments: { app: 'Settings' } };
      const mockChat = vi.fn(
        async (
          _messages: LlmMessage[],
          _options: { offerSkills: boolean; audioBase64?: string },
          _onToken: (token: string) => void,
          _onDone: () => void,
          _onStatus: (status: string) => void,
          _onSkillCall?: (c: LlmSkillCall) => void,
          _onError?: (message: string) => void,
        ) => {
          _onSkillCall?.(call);
          _onDone();
        },
      );
      adapterBridge.setLlmChatWithStatus(mockChat);

      const messages = createMockMessages();
      const options = { offerSkills: true, audioBase64: 'QUJD' };
      await adapterBridge.llmChatWithStatus(
        messages,
        options,
        vi.fn(),
        onDone,
        onStatus,
        onSkillCall,
        onError,
      );

      expect(mockChat).toHaveBeenCalledWith(
        messages,
        options,
        expect.anything(),
        onDone,
        onStatus,
        onSkillCall,
        onError,
      );
      expect(onSkillCall).toHaveBeenCalledWith(call);
      // The optional error channel is forwarded only when supplied (mirrors llmChat).
      expect(onError).not.toHaveBeenCalled();
      expect(onDone).toHaveBeenCalledTimes(1);
    });

    it('unregistered — warns, never synthesizes a status, and still completes', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const onDone = vi.fn();
      const onStatus = vi.fn();

      await adapterBridge.llmChatWithStatus(
        createMockMessages(),
        { offerSkills: false },
        vi.fn(),
        onDone,
        onStatus,
      );

      expect(warnSpy).toHaveBeenCalledWith(
        '[adapterBridge] llmChatWithStatus called before adapter registered',
      );
      // R-7 — the bridge forwards only what the backend emits; it never invents one.
      expect(onStatus).not.toHaveBeenCalled();
      expect(onDone).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // invoke
  // -----------------------------------------------------------------------

  describe('invoke', () => {
    it('registered path — returns mock result', async () => {
      const mockInvoke = vi.fn().mockResolvedValue('registered-result');
      adapterBridge.setInvoke(mockInvoke);

      const result = await adapterBridge.invoke('some.command', { foo: 1 });

      expect(result).toBe('registered-result');
    });

    it('unregistered — no Tauri environment — warns and returns undefined', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Simulate no Tauri runtime
      const originalTauriInternals = (window as any).__TAURI_INTERNALS__;
      delete (window as any).__TAURI_INTERNALS__;

      const result = await adapterBridge.invoke('missing.command');

      expect(result).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        '[adapterBridge] invoke called before adapter registered (dev mode?)',
      );

      // Restore
      (window as any).__TAURI_INTERNALS__ = originalTauriInternals;
      warnSpy.mockRestore();
    });

    it('unregistered — Tauri environment — attempts dynamic import (does not throw)', async () => {
      // Simulate Tauri runtime (dynamic import will fail in jsdom but that's fine;
      // the important thing is the code path is taken)
      const originalTauriInternals = (window as any).__TAURI_INTERNALS__;
      (window as any).__TAURI_INTERNALS__ = {};

      // This should attempt a dynamic import and fail gracefully in jsdom
      // (import('@tauri-apps/api/core') will fail, but the code should not
      // throw from the function itself — it will reject the promise, which
      // we catch via try/catch)
      await expect(adapterBridge.invoke('some.command')).rejects.toThrow();

      // Restore
      (window as any).__TAURI_INTERNALS__ = originalTauriInternals;
    });
  });

  // -----------------------------------------------------------------------
  // listen
  // -----------------------------------------------------------------------

  describe('listen', () => {
    it('registered path — delegates to _listen', async () => {
      const mockUnlisten = vi.fn();
      const mockListen = vi.fn().mockResolvedValue(mockUnlisten);
      adapterBridge.setListen(mockListen);

      const handler = vi.fn();
      const unlisten = await adapterBridge.listen('my.event', handler);

      expect(mockListen).toHaveBeenCalledWith('my.event', handler);
      expect(unlisten).toBe(mockUnlisten);
    });

    it('unregistered — no Tauri environment — logs warn and returns no-op', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const originalTauriInternals = (window as any).__TAURI_INTERNALS__;
      delete (window as any).__TAURI_INTERNALS__;

      const handler = vi.fn();
      const unlisten = await adapterBridge.listen('no-registered', handler);

      expect(typeof unlisten).toBe('function');
      // Calling the no-op should not throw
      expect(() => unlisten()).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        '[adapterBridge] listen called outside Tauri environment',
      );

      (window as any).__TAURI_INTERNALS__ = originalTauriInternals;
      warnSpy.mockRestore();
    });

    it('unregistered — Tauri environment — attempts dynamic import (does not throw)', async () => {
      const originalTauriInternals = (window as any).__TAURI_INTERNALS__;
      (window as any).__TAURI_INTERNALS__ = {};

      const handler = vi.fn();
      await expect(adapterBridge.listen('some.event', handler)).rejects.toThrow();

      (window as any).__TAURI_INTERNALS__ = originalTauriInternals;
    });
  });

  // -----------------------------------------------------------------------
  // llmChat
  // -----------------------------------------------------------------------

  describe('llmChat', () => {
    it('registered path — calls mock and fires callbacks', async () => {
      const onToken = vi.fn();
      const onDone = vi.fn();
      const mockChat = vi.fn(
        async (
          _messages: LlmMessage[],
          _onToken: (token: string) => void,
          _onDone: () => void,
        ) => {
          _onToken('a');
          _onToken('b');
          _onToken('c');
          _onDone();
        },
      );
      adapterBridge.setLlmChat(mockChat);

      const messages = createMockMessages();
      await adapterBridge.llmChat(messages, onToken, onDone);

      expect(onToken).toHaveBeenCalledTimes(3);
      expect(onToken).toHaveBeenNthCalledWith(1, 'a');
      expect(onToken).toHaveBeenNthCalledWith(2, 'b');
      expect(onToken).toHaveBeenNthCalledWith(3, 'c');
      expect(onDone).toHaveBeenCalledTimes(1);
    });

    it('unregistered path — calls onDone and logs warning', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const onToken = vi.fn();
      const onDone = vi.fn();

      await adapterBridge.llmChat(createMockMessages(), onToken, onDone);

      expect(onDone).toHaveBeenCalledTimes(1);
      expect(onToken).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        '[adapterBridge] llmChat called before adapter registered',
      );

      warnSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // llmChatWithImage
  // -----------------------------------------------------------------------

  describe('llmChatWithImage', () => {
    it('registered path — calls mock with imageBase64 and fires callbacks', async () => {
      const onToken = vi.fn();
      const onDone = vi.fn();
      const mockChat = vi.fn(
        async (
          _messages: LlmMessage[],
          _imageBase64: string,
          _onToken: (token: string) => void,
          _onDone: () => void,
        ) => {
          _onToken('img-token-1');
          _onToken('img-token-2');
          _onDone();
        },
      );
      adapterBridge.setLlmChatWithImage(mockChat);

      const messages = createMockMessages();
      await adapterBridge.llmChatWithImage(messages, 'dGVzdA==', onToken, onDone);

      expect(onToken).toHaveBeenCalledTimes(2);
      expect(onToken).toHaveBeenNthCalledWith(1, 'img-token-1');
      expect(onToken).toHaveBeenNthCalledWith(2, 'img-token-2');
      expect(onDone).toHaveBeenCalledTimes(1);
    });

    it('unregistered path — no Tauri environment — calls onDone and logs warning', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const originalTauriInternals = (window as any).__TAURI_INTERNALS__;
      delete (window as any).__TAURI_INTERNALS__;

      const onToken = vi.fn();
      const onDone = vi.fn();

      await adapterBridge.llmChatWithImage(createMockMessages(), 'img==', onToken, onDone);

      expect(onDone).toHaveBeenCalledTimes(1);
      expect(onToken).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        '[adapterBridge] llmChatWithImage called before adapter registered',
      );

      (window as any).__TAURI_INTERNALS__ = originalTauriInternals;
      warnSpy.mockRestore();
    });

    it('unregistered path — Tauri environment — attempts dynamic import (does not throw)', async () => {
      const originalTauriInternals = (window as any).__TAURI_INTERNALS__;
      (window as any).__TAURI_INTERNALS__ = {};

      const onToken = vi.fn();
      const onDone = vi.fn();

      // In jsdom the dynamic import of @tauri-apps/api/event and /core will fail
      await expect(
        adapterBridge.llmChatWithImage(createMockMessages(), 'img==', onToken, onDone),
      ).rejects.toThrow();

      (window as any).__TAURI_INTERNALS__ = originalTauriInternals;
    });
  });
});
