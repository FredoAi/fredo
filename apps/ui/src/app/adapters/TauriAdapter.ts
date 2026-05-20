import type { HostAdapter, LlmMessage } from './HostAdapter';

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
  ): Promise<void> {
    console.log('[TauriAdapter] llmChat start — messages:', messages.length);
    const { listen } = await import('@tauri-apps/api/event');
    const { invoke } = await import('@tauri-apps/api/core');

    // Set up listeners before invoking so no tokens are missed
    let unlistenToken: (() => void) | undefined;
    let unlistenDone: (() => void) | undefined;

    unlistenToken = await listen<string>('llm-token', (event) => {
      console.log('[TauriAdapter] llm-token event:', event.payload?.slice(0, 40));
      onToken(event.payload);
    });

    unlistenDone = await listen<void>('llm-done', () => {
      console.log('[TauriAdapter] llm-done event');
      unlistenToken?.();
      unlistenDone?.();
      onDone();
    });

    try {
      console.log('[TauriAdapter] invoking llm_chat');
      await invoke('llm_chat', { messages });
      console.log('[TauriAdapter] llm_chat invoke returned');
    } catch (err) {
      unlistenToken?.();
      unlistenDone?.();
      const msg = String(err);
      if (msg.includes('still loading')) {
        console.warn('[TauriAdapter] model still loading, retrying in 3s...');
        onToken('⏳ Loading model...');
        setTimeout(() => this.llmChat(messages, onToken, onDone), 3000);
      } else {
        console.error('[TauriAdapter] llm_chat error:', err);
        onDone();
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

    unlistenToken = await listen<string>('llm-token', (event) => {
      onToken(event.payload);
    });

    unlistenDone = await listen<void>('llm-done', () => {
      unlistenToken?.();
      unlistenDone?.();
      onDone();
    });

    try {
      await invoke('llm_chat_with_image', { messages, imageBase64 });
    } catch (err) {
      unlistenToken?.();
      unlistenDone?.();
      console.error('[TauriAdapter] llm_chat_with_image error:', err);
      onDone();
    }
  }
}
