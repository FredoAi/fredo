/**
 * adapterBridge — lets non-React code (e.g. FredoFeatureClass instances) call
 * Tauri commands without needing access to the React context.
 *
 * AppProvider registers the adapter's invoke fn on mount so it's always
 * available before any feature class calls it.
 */

import type { LlmMessage, LlmSkillCall } from '../../app/adapters/HostAdapter';

type InvokeFn = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type LlmChatFn = (
  messages: LlmMessage[],
  onToken: (token: string) => void,
  onDone: () => void,
  onError?: (message: string) => void,
) => Promise<void>;
type LlmChatWithImageFn = (
  messages: LlmMessage[],
  imageBase64: string,
  onToken: (token: string) => void,
  onDone: () => void,
) => Promise<void>;
// #2893 ST-7 — the skill-aware variant. Same token/done/error channel, plus the
// validated selection callback (raw tool-call JSON is never a token).
type LlmChatWithSkillsFn = (
  messages: LlmMessage[],
  onToken: (token: string) => void,
  onDone: () => void,
  onSkillCall: (call: LlmSkillCall) => void,
  onError?: (message: string) => void,
) => Promise<void>;
// #2897 ST-3 — the model-audio variant: the captured clip is attached to the last
// user message by the backend renderer; token/done/error channels are unchanged.
type LlmChatWithAudioFn = (
  messages: LlmMessage[],
  audioBase64: string,
  onToken: (token: string) => void,
  onDone: () => void,
  onError?: (message: string) => void,
) => Promise<void>;

let _invoke: InvokeFn | undefined;
let _llmChat: LlmChatFn | undefined;
let _llmChatWithImage: LlmChatWithImageFn | undefined;
let _llmChatWithSkills: LlmChatWithSkillsFn | undefined;
let _llmChatWithAudio: LlmChatWithAudioFn | undefined;

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

  /** #2893 ST-7 — register the skill-aware streaming implementation. */
  setLlmChatWithSkills(fn: LlmChatWithSkillsFn | undefined): void {
    _llmChatWithSkills = fn;
  },

  /** #2897 ST-3 — register the model-audio streaming implementation. */
  setLlmChatWithAudio(fn: LlmChatWithAudioFn | undefined): void {
    _llmChatWithAudio = fn;
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
        const { invoke } = await import('@tauri-apps/api/core');
        return invoke<T>(command, args);
      }
      console.warn('[adapterBridge] invoke called before adapter registered (dev mode?)');
      return undefined;
    }
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
    onError?: (message: string) => void,
  ): Promise<void> {
    if (!_llmChat) {
      console.warn('[adapterBridge] llmChat called before adapter registered');
      onDone();
      return;
    }
    // #2871 ST-1r — forward the optional error channel only when the caller
    // actually supplies it, so callers without one keep the exact 3-arg
    // invocation contract (the existing `adapterBridge` test pins it).
    if (onError) return _llmChat(messages, onToken, onDone, onError);
    return _llmChat(messages, onToken, onDone);
  },

  /**
   * #2893 ST-7 — the skill-aware streaming path. Mirrors `llmChat`'s forwarding
   * (the optional error channel is passed only when supplied) and adds the
   * `onSkillCall` selection channel. A missing implementation is a safe no-op that
   * still completes (`onDone`) — never a hang.
   */
  async llmChatWithSkills(
    messages: LlmMessage[],
    onToken: (token: string) => void,
    onDone: () => void,
    onSkillCall: (call: LlmSkillCall) => void,
    onError?: (message: string) => void,
  ): Promise<void> {
    if (!_llmChatWithSkills) {
      console.warn('[adapterBridge] llmChatWithSkills called before adapter registered');
      onDone();
      return;
    }
    if (onError) return _llmChatWithSkills(messages, onToken, onDone, onSkillCall, onError);
    return _llmChatWithSkills(messages, onToken, onDone, onSkillCall);
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

  /**
   * #2897 ST-3 (REQ-5) — the model-audio streaming path. Forwards the captured
   * clip + the standard token/done channels; the optional error channel is passed
   * only when supplied (same contract as `llmChat` / `llmChatWithSkills`). A
   * missing implementation is a safe no-op that still completes (`onDone`) —
   * never a hang.
   */
  async llmChatWithAudio(
    messages: LlmMessage[],
    audioBase64: string,
    onToken: (token: string) => void,
    onDone: () => void,
    onError?: (message: string) => void,
  ): Promise<void> {
    if (!_llmChatWithAudio) {
      console.warn('[adapterBridge] llmChatWithAudio called before adapter registered');
      onDone();
      return;
    }
    if (onError) return _llmChatWithAudio(messages, audioBase64, onToken, onDone, onError);
    return _llmChatWithAudio(messages, audioBase64, onToken, onDone);
  },
};

