/**
 * HostAdapter — the contract that bridges AppProvider to any host environment.
 *
 * Implementations:
 *  - TauriAdapter  (apps/tauri)         — Tauri IPC events + invoke
 *  - DevAdapter    (apps/ui dev server) — in-memory emitter
 */
export interface HostAdapter {
  /** Subscribe to incoming messages from the host. Returns an unsubscribe function. */
  onMessage(handler: (msg: any) => void): () => void;

  /**
   * Invoke a Tauri command and return the result.
   * In Tauri: calls @tauri-apps/api/core invoke().
   * In dev: no-op, returns undefined.
   */
  invoke?(command: string, args?: Record<string, unknown>): Promise<unknown>;

  /**
   * Start a streaming LLM conversation.
   * Calls the local model with the given messages and streams the response
   * token-by-token via `onToken`, then calls `onDone` when generation is complete.
   * Domain-agnostic — callers supply their own system prompt.
   */
  llmChat(
    messages: LlmMessage[],
    onToken: (token: string) => void,
    onDone: () => void,
  ): Promise<void>;

  /**
   * Like `llmChat` but attaches a base64-encoded PNG image to the last user message.
   * Used by TicTacToe to send a screenshot of the board to the vision model.
   */
  llmChatWithImage(
    messages: LlmMessage[],
    imageBase64: string,
    onToken: (token: string) => void,
    onDone: () => void,
  ): Promise<void>;
}

/** A single turn in an LLM conversation. */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
