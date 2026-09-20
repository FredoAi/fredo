import type { HostAdapter, LlmMessage, LlmSkillCall } from './HostAdapter';

/**
 * TauriAdapter — HostAdapter implementation for the Tauri desktop app.
 *
 * Bridges the Tauri IPC event system to the AppProvider message interface.
 * The Rust backend emits "fredo-stream-event" via app_handle.emit(), which
 * this adapter receives and forwards to the StreamContext.
 *
 * Uses a dynamic import of @tauri-apps/api/event so this module can be
 * imported in any build context without breaking non-Tauri environments.
 */
export class TauriAdapter implements HostAdapter {
  onMessage(handler: (msg: any) => void): () => void {
    // Hold the Tauri unlisten function once the async import resolves
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<unknown>('fredo-stream-event', (event) => {
          handler(event.payload);
        }),
      )
      .then((fn) => {
        if (cancelled) {
          // Unsubscribed before we finished setting up — clean up immediately
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((err) => {
        console.error('[TauriAdapter] Failed to subscribe to fredo-stream-event:', err);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }

  async invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke(command, args);
  }

  async llmChat(
    messages: LlmMessage[],
    onToken: (token: string) => void,
    onDone: () => void,
    onError?: (message: string) => void,
  ): Promise<void> {
    const { listen } = await import('@tauri-apps/api/event');
    const { invoke } = await import('@tauri-apps/api/core');

    // Set up listeners before invoking so no tokens are missed
    let unlistenToken: (() => void) | undefined;
    let unlistenDone: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;
    let settled = false;

    // Complete exactly once. A server failure emits `llm-error` followed by
    // `llm-done`, so this guard prevents a double `onDone`.
    const finish = () => {
      if (settled) return;
      settled = true;
      unlistenToken?.();
      unlistenDone?.();
      unlistenError?.();
      onDone();
    };

    unlistenToken = await listen<string>('llm-token', (event) => {
      onToken(event.payload);
    });

    // Additive server-error channel: route ONE raw failure line through the typed
    // `onError` channel when the caller provides it, then complete — never hang.
    // Callers without `onError` keep the legacy behavior (the line arrives via
    // `onToken`).
    unlistenError = await listen<string>('llm-error', (event) => {
      if (onError) onError(event.payload);
      else onToken(event.payload);
      finish();
    });

    unlistenDone = await listen<void>('llm-done', () => {
      finish();
    });

    try {
      await invoke('llm_chat', { messages });
    } catch (err) {
      const msg = String(err);
      if (msg.includes('still loading')) {
        unlistenToken?.();
        unlistenDone?.();
        unlistenError?.();
        console.warn('[TauriAdapter] model still loading, retrying in 3s...');
        onToken('⏳ Loading model...');
        setTimeout(() => this.llmChat(messages, onToken, onDone, onError), 3000);
      } else {
        console.error('[TauriAdapter] llm_chat error:', err);
        onError?.(msg);
        finish();
      }
    }
  }

  /**
   * #2893 ST-7 — the skill-aware streaming path. Same listener lifecycle, single
   * `finish()` guard and "still loading" retry as `llmChat`, plus the additive
   * `llm-skill-call` listener registered BEFORE the invoke so a fast selection is
   * never missed. `onSkillCall` receives the validated `{ skill, arguments }`;
   * tool-call JSON is never routed to `onToken` (backend guarantees it).
   */
  async llmChatWithSkills(
    messages: LlmMessage[],
    onToken: (token: string) => void,
    onDone: () => void,
    onSkillCall: (call: LlmSkillCall) => void,
    onError?: (message: string) => void,
  ): Promise<void> {
    const { listen } = await import('@tauri-apps/api/event');
    const { invoke } = await import('@tauri-apps/api/core');

    let unlistenToken: (() => void) | undefined;
    let unlistenDone: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;
    let unlistenSkill: (() => void) | undefined;
    let settled = false;

    // Complete exactly once (see `llmChat`): a server failure emits `llm-error`
    // followed by `llm-done`, so a double `onDone` is impossible.
    const finish = () => {
      if (settled) return;
      settled = true;
      unlistenToken?.();
      unlistenDone?.();
      unlistenError?.();
      unlistenSkill?.();
      onDone();
    };

    unlistenToken = await listen<string>('llm-token', (event) => {
      onToken(event.payload);
    });

    // Additive server-error channel: route ONE raw failure line through the typed
    // `onError` channel when the caller provides it, then complete — never hang.
    // Callers without `onError` keep the legacy behavior (the line arrives via
    // `onToken`).
    unlistenError = await listen<string>('llm-error', (event) => {
      if (onError) onError(event.payload);
      else onToken(event.payload);
      finish();
    });

    // The validated selection channel — never a token.
    unlistenSkill = await listen<LlmSkillCall>('llm-skill-call', (event) => {
      onSkillCall(event.payload);
    });

    unlistenDone = await listen<void>('llm-done', () => {
      finish();
    });

    try {
      await invoke('llm_chat_with_skills', { messages });
    } catch (err) {
      const msg = String(err);
      if (msg.includes('still loading')) {
        unlistenToken?.();
        unlistenDone?.();
        unlistenError?.();
        unlistenSkill?.();
        console.warn('[TauriAdapter] model still loading, retrying in 3s...');
        onToken('⏳ Loading model...');
        setTimeout(() => this.llmChatWithSkills(messages, onToken, onDone, onSkillCall, onError), 3000);
      } else {
        console.error('[TauriAdapter] llm_chat_with_skills error:', err);
        onError?.(msg);
        finish();
      }
    }
  }

  async llmChatWithImage(
    messages: LlmMessage[],
    imageBase64: string,
    onToken: (token: string) => void,
    onDone: () => void,
  ): Promise<void> {
    const { listen } = await import('@tauri-apps/api/event');
    const { invoke } = await import('@tauri-apps/api/core');

    let unlistenToken: (() => void) | undefined;
    let unlistenDone: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;
    let settled = false;

    // Complete exactly once (see llmChat).
    const finish = () => {
      if (settled) return;
      settled = true;
      unlistenToken?.();
      unlistenDone?.();
      unlistenError?.();
      onDone();
    };

    unlistenToken = await listen<string>('llm-token', (event) => {
      onToken(event.payload);
    });

    // Additive server-error channel: one readable line, then complete.
    unlistenError = await listen<string>('llm-error', (event) => {
      onToken(event.payload);
      finish();
    });

    unlistenDone = await listen<void>('llm-done', () => {
      finish();
    });

    try {
      await invoke('llm_chat_with_image', { messages, imageBase64 });
    } catch (err) {
      console.error('[TauriAdapter] llm_chat_with_image error:', err);
      finish();
    }
  }

  /**
   * #2897 ST-3 (REQ-5) — the model-audio streaming path. Same listener lifecycle
   * and single `finish()` guard as `llmChatWithImage`; the clip is attached to the
   * last user message by the backend renderer (no transcript text is sent). The
   * additive `llm-error` channel is routed to `onError` when the caller supplies
   * it, else the readable line arrives via `onToken` (the #2871 contract).
   *
   * #2903 ST-2 — the ADDITIVE trailing `onSkillCall` channel (AFTER `onError`)
   * makes the audio turn skill-aware. The `llm-skill-call` listener is registered
   * BEFORE the invoke (mirroring `llmChatWithSkills`) so a fast validated
   * selection is never missed; raw tool-call JSON is never routed to `onToken`.
   * The listener is bound only when the caller supplies the optional channel, so a
   * 4-arg/5-arg caller sees the exact #2897 behavior.
   */
  async llmChatWithAudio(
    messages: LlmMessage[],
    audioBase64: string,
    onToken: (token: string) => void,
    onDone: () => void,
    onError?: (message: string) => void,
    onSkillCall?: (call: LlmSkillCall) => void,
  ): Promise<void> {
    const { listen } = await import('@tauri-apps/api/event');
    const { invoke } = await import('@tauri-apps/api/core');

    let unlistenToken: (() => void) | undefined;
    let unlistenDone: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;
    let unlistenSkill: (() => void) | undefined;
    let settled = false;

    // Complete exactly once (see llmChat): a server failure emits `llm-error`
    // followed by `llm-done`, so a double `onDone` is impossible.
    const finish = () => {
      if (settled) return;
      settled = true;
      unlistenToken?.();
      unlistenDone?.();
      unlistenError?.();
      unlistenSkill?.();
      onDone();
    };

    unlistenToken = await listen<string>('llm-token', (event) => {
      onToken(event.payload);
    });

    // Additive server-error channel: route ONE raw failure line through the typed
    // `onError` channel when the caller provides it, then complete — never hang.
    // Callers without `onError` keep the legacy behavior (the line arrives via
    // `onToken`).
    unlistenError = await listen<string>('llm-error', (event) => {
      if (onError) onError(event.payload);
      else onToken(event.payload);
      finish();
    });

    // #2903 ST-2 — the validated selection channel (registered BEFORE the invoke,
    // exactly as `llmChatWithSkills` does). Never a token.
    if (onSkillCall) {
      unlistenSkill = await listen<LlmSkillCall>('llm-skill-call', (event) => {
        onSkillCall(event.payload);
      });
    }

    unlistenDone = await listen<void>('llm-done', () => {
      finish();
    });

    try {
      await invoke('llm_chat_with_audio', { messages, audioBase64 });
    } catch (err) {
      console.error('[TauriAdapter] llm_chat_with_audio error:', err);
      onError?.(String(err));
      finish();
    }
  }
}
