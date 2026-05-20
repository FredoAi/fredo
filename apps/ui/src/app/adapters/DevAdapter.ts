import type { HostAdapter, LlmMessage } from './HostAdapter';

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
}
