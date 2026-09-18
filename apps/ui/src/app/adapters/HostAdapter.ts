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
   *
   * `onError` (#2871) is the additive typed error channel: when a server/transport
   * failure occurs, the RAW backend/IPC detail is delivered here (never mixed into
   * the token stream) so the caller can map it to readable copy. It is optional —
   * a caller that omits it keeps the legacy behavior (the error text arrives via
   * `onToken`).
   */
  llmChat(
    messages: LlmMessage[],
    onToken: (token: string) => void,
    onDone: () => void,
    onError?: (message: string) => void,
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

  /**
   * #2893 ST-7 — the skill-aware streaming variant. Token/done/error semantics are
   * identical to `llmChat`; the ADDITIVE `onSkillCall` channel carries a VALIDATED
   * `llm-skill-call` (`{ skill, arguments }`) when the model selects a registered
   * companion skill. Raw tool-call JSON is NEVER streamed as a token, so a caller
   * that ignores `onSkillCall` sees an ordinary (silent) generation.
   *
   * Optional so existing `HostAdapter` implementations and test doubles stay valid;
   * in-repo adapters (`TauriAdapter`, `DevAdapter`) implement it.
   */
  llmChatWithSkills?(
    messages: LlmMessage[],
    onToken: (token: string) => void,
    onDone: () => void,
    onSkillCall: (call: LlmSkillCall) => void,
    onError?: (message: string) => void,
  ): Promise<void>;
}

/** A single turn in an LLM conversation. */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * #2893 ST-7 — a VALIDATED companion-skill selection delivered by the skill-aware
 * inference path (mirrors the backend `SkillCall` wire struct: `skill` + parsed
 * `arguments`, e.g. `{ skill: 'open_app', arguments: { app: 'Mission Monitor' } }`).
 */
export interface LlmSkillCall {
  skill: string;
  arguments: Record<string, unknown>;
}
