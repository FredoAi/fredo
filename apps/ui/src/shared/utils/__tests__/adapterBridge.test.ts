/**
 * PREREQUISITE: Requires vitest and jsdom to be installed in apps/ui/package.json.
 *   npm i -D vitest jsdom
 * Run with: npx vitest run
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { adapterBridge } from '../adapterBridge';
import type { LlmMessage } from '../../../app/adapters/HostAdapter';

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
