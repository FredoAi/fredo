/**
 * Fredo OpenCode Plugin — event hooks for real-time observability.
 *
 * Hooks into OpenCode lifecycle events and forwards them to the Fredo desktop
 * app via the `fredo open-code-plugin` CLI command.
 *
 * Plugin format: returns hooks object from async function (OpenCode v1.15+).
 * Local plugin: placed as .js file directly in ~/.config/opencode/plugins/
 *
 * Only 4 hooks remain — all session.*, permission.*, file.edited, command.executed,
 * shell.env, and user.message events arrive via the catch-all `event` hook
 * (forwarded by event.type discriminator).
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
    /** Catch-all event hook — forwards by event.type discriminator */
    event: async ({ event }: any) => {
      await forwardEvent($, event.type, event);
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

    /** Chat / user prompt events */
    'chat.message': async (input: any, output: any) => {
      await forwardEvent($, 'chat.message', { input, output });
    },

    /** Session compaction auto-continue event */
    'experimental.compaction.autocontinue': async (input: any, _output: any) => {
      await forwardEvent($, 'experimental.compaction.autocontinue', input);
    },
  };
};

export default FredoPlugin;
