/**
 * Fredo OpenCode Plugin — event hooks for real-time observability.
 *
 * Hooks into OpenCode lifecycle events and forwards them to the Fredo desktop
 * app via the `fredo open-code-plugin` CLI command. Each hook maps OpenCode
 * event types to adapter-compatible payloads so the Rust backend can produce
 * visible FredoEvents (ToolUse + Init/Response, AgentSession, etc.).
 *
 * Plugin format: returns hooks object from async function (OpenCode v1.15+).
 * Local plugin: placed as .js file directly in ~/.config/opencode/plugins/
 */

import type { Plugin } from '@opencode-ai/plugin';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Forward an event to the Fredo desktop app.
 * Uses template literal interpolation for Bun shell command arguments.
 */
async function forwardEvent(
  $: any,
  eventType: string,
  payload: unknown,
): Promise<void> {
  try {
    const jsonString = JSON.stringify(payload);
    await $`fredo open-code-plugin ${eventType} --payload ${jsonString}`.quiet().nothrow();
  } catch {
    // fail silently
  }
}

// ── Plugin ─────────────────────────────────────────────────────────────────

export const FredoPlugin: Plugin = async ({ $ }) => {
  return {
    /** Catch-all event hook */
    event: async ({ event }: any) => {
      await forwardEvent($, 'event', event);
    },

    /** Session lifecycle */
    'session.created': async ({ event }: any) => {
      const session_id = event?.session?.id || event?.id || '';
      await forwardEvent($, 'SessionStart', { session_id, ...event });
    },
    'session.updated': async ({ event }: any) => {
      const session_id = event?.session?.id || event?.id || '';
      await forwardEvent($, 'SessionStart', { session_id, ...event });
    },
    'session.idle': async ({ event }: any) => {
      await forwardEvent($, 'session.idle', event);
    },
    'session.error': async ({ event }: any) => {
      await forwardEvent($, 'session.error', event);
    },
    'session.deleted': async ({ event }: any) => {
      const session_id = event?.session?.id || event?.id || '';
      await forwardEvent($, 'SessionEnd', { session_id, ...event });
    },

    /** Tool execution events -> PreToolUse / PostToolUse */
    'tool.execute.before': async (input: any, output: any) => {
      await forwardEvent($, 'PreToolUse', {
        tool_name: input?.tool || '',
        tool_input: input?.args || input,
        tool_use_id: input?.tool_use_id || '',
      });
    },
    'tool.execute.after': async (input: any, output: any) => {
      await forwardEvent($, 'PostToolUse', {
        tool_name: input?.tool || '',
        tool_response: output || '',
        tool_use_id: input?.tool_use_id || '',
      });
    },

    /** Permission events */
    'permission.asked': async ({ event }: any) => {
      await forwardEvent($, 'permission.asked', event);
    },
    'permission.replied': async ({ event }: any) => {
      await forwardEvent($, 'permission.replied', event);
    },

    /** Shell environment */
    'shell.env': async (input: any, output: any) => {
      await forwardEvent($, 'shell.env', { input, output });
    },

    /** File events */
    'file.edited': async ({ event }: any) => {
      await forwardEvent($, 'file.edited', event);
    },

    /** Command events */
    'command.executed': async ({ event }: any) => {
      await forwardEvent($, 'command.executed', event);
    },
  };
};

export default FredoPlugin;
