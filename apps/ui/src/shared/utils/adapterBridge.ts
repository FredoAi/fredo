/**
 * adapterBridge — lets non-React code (e.g. FredoFeatureClass instances) call
 * Tauri commands without needing access to the React context.
 *
 * AppProvider registers the adapter's invoke fn on mount so it's always
 * available before any feature class calls it.
 */

import type { LlmMessage } from '../../app/adapters/HostAdapter';

type InvokeFn = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type LlmChatFn = (
  messages: LlmMessage[],
  onToken: (token: string) => void,
  onDone: () => void,
) => Promise<void>;
type LlmChatWithImageFn = (
  messages: LlmMessage[],
  imageBase64: string,
  onToken: (token: string) => void,
  onDone: () => void,
) => Promise<void>;

let _invoke: InvokeFn | undefined;
let _llmChat: LlmChatFn | undefined;
let _llmChatWithImage: LlmChatWithImageFn | undefined;

type UnlistenFn = () => void;
type ListenFn = <T>(event: string, handler: (payload: T) => void) => Promise<UnlistenFn>;

let _listen: ListenFn | undefined;

export const adapterBridge = {
  setInvoke(fn: InvokeFn): void {
    _invoke = fn;
  },

  setLlmChat(fn: LlmChatFn): void {
    _llmChat = fn;
  },

  setLlmChatWithImage(fn: LlmChatWithImageFn): void {
    _llmChatWithImage = fn;
  },

  setListen(fn: ListenFn): void {
    _listen = fn;
  },

  async invoke<T = unknown>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T | undefined> {
    if (!_invoke) {
      // Fallback: if running inside Tauri, call the API directly (handles HMR resets)
      if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
        console.log(`[adapterBridge] fallback direct invoke: ${command}`);
        const { invoke } = await import('@tauri-apps/api/core');
        return invoke<T>(command, args);
      }
      console.warn('[adapterBridge] invoke called before adapter registered (dev mode?)');
      return undefined;
    }
    console.log(`[adapterBridge] invoke: ${command}`);
    return _invoke(command, args) as Promise<T>;
  },

  async listen<T = unknown>(
    event: string,
    handler: (payload: T) => void,
  ): Promise<UnlistenFn> {
    if (_listen) {
      return _listen<T>(event, handler);
    }
    // Fallback: direct Tauri import if inside Tauri
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      const { listen } = await import('@tauri-apps/api/event');
      return listen<T>(event, (e) => handler(e.payload));
    }
    console.warn('[adapterBridge] listen called outside Tauri environment');
    return () => {};
  },

  async llmChat(
    messages: LlmMessage[],
    onToken: (token: string) => void,
    onDone: () => void,
  ): Promise<void> {
    if (!_llmChat) {
      console.warn('[adapterBridge] llmChat called before adapter registered');
      onDone();
      return;
    }
    return _llmChat(messages, onToken, onDone);
  },

  async llmChatWithImage(
    messages: LlmMessage[],
    imageBase64: string,
    onToken: (token: string) => void,
    onDone: () => void,
  ): Promise<void> {
    if (!_llmChatWithImage) {
      // Fallback: direct Tauri invoke if running inside Tauri
      if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
        const { listen } = await import('@tauri-apps/api/event');
        const { invoke } = await import('@tauri-apps/api/core');
        let unToken: (() => void) | undefined;
        let unDone: (() => void) | undefined;
        unToken = await listen<string>('llm-token', (e) => onToken(e.payload));
        unDone = await listen<void>('llm-done', () => { unToken?.(); unDone?.(); onDone(); });
        await invoke('llm_chat_with_image', { messages, imageBase64 });
        return;
      }
      console.warn('[adapterBridge] llmChatWithImage called before adapter registered');
      onDone();
      return;
    }
    return _llmChatWithImage(messages, imageBase64, onToken, onDone);
  },
};

