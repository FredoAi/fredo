import type {
  HostAdapter,
  LlmChatWithStatusOptions,
  LlmMessage,
  LlmSkillCall,
} from './HostAdapter';

/**
 * #2918 ST-3 — the FIXED status the dev twin emits on every structured turn. It is
 * the converged default (`happy`), so the dev experience matches today's success
 * settle while still exercising the additive `llm-status` channel.
 */
export const DEV_REPLY_STATUS = 'happy';

/**
 * DevAdapter — HostAdapter implementation for the standalone Vite dev server.
 *
 * Messages delivered via a simple in-memory emitter.
 *
 * To test the full flow during development, call devAdapter.emit() from the
 * browser console to simulate a Fredo_HANDSHAKE:
 *
 *   window.__devAdapter.emit({ type: 'Fredo_HANDSHAKE', data: { connectionId: 'test-id' } })
 */
export class DevAdapter implements HostAdapter {
  private handlers: ((msg: any) => void)[] = [];

  constructor() {
    // Expose on window for quick manual testing in dev
    if (typeof window !== 'undefined') {
      (window as any).__devAdapter = this;
    }
  }

  onMessage(handler: (msg: any) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  /** Manually emit any message — useful for dev-time testing */
  emit(msg: any): void {
    this.handlers.forEach((h) => h(msg));
  }

  async invoke(command: string, _args?: Record<string, unknown>): Promise<unknown> {
    console.warn(`[DevAdapter] invoke('${command}') called — no-op in dev mode`);
    return undefined;
  }

  async llmChat(
    messages: LlmMessage[],
    onToken: (token: string) => void,
    onDone: () => void,
    // #2871 ST-1r — typed error channel. The dev mock never fails, so this is
    // accepted for interface parity and intentionally ignored.
    _onError?: (message: string) => void,
  ): Promise<void> {
    // Pick a mock response based on the last user message so dev mode shows variety
    const userMsg = [...messages].reverse().find((m: LlmMessage) => m.role === 'user')?.content ?? '';
    const mocks = [
      "Why do programmers prefer dark mode?\nBecause light attracts bugs! 🐛",
      "A SQL query walks into a bar, walks up to two tables and asks... \"Can I join you?\"",
      "Why did the developer go broke?\nBecause he used up all his cache!",
      "There are only 10 types of people in the world:\nThose who understand binary and those who don't.",
      "Why do Java developers wear glasses?\nBecause they don't C#!",
      "A git commit walks into a bar.\nBartender: \"We don't serve your type here.\"\nCommit: \"That's fine, I'll just branch off.\"",
    ];
    const mock = mocks[Math.floor(Math.random() * mocks.length)];
    void userMsg; // consumed for future use
    let i = 0;
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        if (i < mock.length) {
          onToken(mock[i++]);
        } else {
          clearInterval(interval);
          onDone();
          resolve();
        }
      }, 30);
    });
  }

  async llmChatWithImage(
    _messages: LlmMessage[],
    _imageBase64: string,
    onToken: (token: string) => void,
    onDone: () => void,
  ): Promise<void> {
    const mock = '4'; // dev: always pick center cell
    for (const ch of mock) onToken(ch);
    onDone();
  }

  /**
   * #2897 ST-3 (REQ-5) — model-audio parity for the dev mock. The dev server has
   * no managed model server, so it streams an ordinary mock reply through the
   * unchanged `llmChat` (the captured clip is never a dev-time asset).
   *
   * #2903 ST-2 — the additive trailing `onSkillCall` channel is accepted for
   * interface parity; the dev mock has no backend tools path and so never selects
   * a skill (mirrors `llmChatWithSkills`).
   */
  async llmChatWithAudio(
    messages: LlmMessage[],
    _audioBase64: string,
    onToken: (token: string) => void,
    onDone: () => void,
    onError?: (message: string) => void,
    _onSkillCall?: (call: LlmSkillCall) => void,
  ): Promise<void> {
    return this.llmChat(messages, onToken, onDone, onError);
  }

  /**
   * #2893 ST-7 — skill-aware parity for the dev mock. The dev server never
   * performs a real selection (no backend tools path), so it streams an ordinary
   * mock reply through the unchanged `llmChat` and never emits a skill call.
   */
  async llmChatWithSkills(
    messages: LlmMessage[],
    onToken: (token: string) => void,
    onDone: () => void,
    _onSkillCall: (call: LlmSkillCall) => void,
    onError?: (message: string) => void,
  ): Promise<void> {
    return this.llmChat(messages, onToken, onDone, onError);
  }

  /**
   * #2918 ST-3 — the deterministic status-producing twin (the G-172 in-repo
   * fixture). The dev server has no managed model server, so it streams the
   * ordinary mock reply through the unchanged `llmChat` and then emits the FIXED
   * {@link DEV_REPLY_STATUS} on `onStatus` BEFORE `onDone`, matching the backend's
   * `llm-status`-before-`llm-done` order. The skill channel is accepted for
   * interface parity and never selected (no backend tools path in dev).
   */
  async llmChatWithStatus(
    messages: LlmMessage[],
    _options: LlmChatWithStatusOptions,
    onToken: (token: string) => void,
    onDone: () => void,
    onStatus: (status: string) => void,
    _onSkillCall?: (call: LlmSkillCall) => void,
    onError?: (message: string) => void,
  ): Promise<void> {
    // Hold the settle so the fixed status is always emitted BEFORE completion
    // (the same order the backend guarantees).
    await this.llmChat(messages, onToken, () => {}, onError);
    onStatus(DEV_REPLY_STATUS);
    onDone();
  }
}
