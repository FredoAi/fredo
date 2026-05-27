/**
 * Fredo OpenCode Plugin — event hooks for real-time observability.
 *
 * Hooks into all OpenCode lifecycle events and forwards them to the
 * Fredo desktop app via the `fredo opencode-plugin` CLI command.
 * Each hook uses safe argument passing (.args()) to prevent shell injection.
 *
 * Plugin format: returns hooks object from async function (OpenCode v1.15+).
 * Local plugin: placed as .js file directly in ~/.config/opencode/plugins/
 */

import type { Plugin } from '@opencode-ai/plugin';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Forward an event to the Fredo desktop app.
 * Uses .args() for safe argument passing — no string interpolation.
 */
async function forwardEvent(
  $: any,
  eventType: string,
  payload: unknown,
): Promise<void> {
  try {
    const jsonString = JSON.stringify(payload);
    await $`fredo open-code-plugin`.args([eventType, '--payload', jsonString]).nothrow();
  } catch {
    // Silently swallow errors — plugin hooks must not crash OpenCode.
  }
}

// ── Plugin ─────────────────────────────────────────────────────────────────

export const FredoPlugin: Plugin = async ({ $ }) => {
  return {
    /** Forward all generic events */
    event: async ({ event }: any) => {
      await forwardEvent($, 'event', event);
    },

    /** Forward session lifecycle events */
    'session.created': async ({ event }: any) => {
      await forwardEvent($, 'session.created', event);
    },
    'session.updated': async ({ event }: any) => {
      await forwardEvent($, 'session.updated', event);
    },
    'session.idle': async ({ event }: any) => {
      await forwardEvent($, 'session.idle', event);
    },
    'session.error': async ({ event }: any) => {
      await forwardEvent($, 'session.error', event);
    },
    'session.deleted': async ({ event }: any) => {
      await forwardEvent($, 'session.deleted', event);
    },

    /** Forward message events */
    'message.updated': async ({ event }: any) => {
      await forwardEvent($, 'message.updated', event);
    },
    'message.removed': async ({ event }: any) => {
      await forwardEvent($, 'message.removed', event);
    },

    /** Forward tool execution events */
    'tool.execute.before': async (input: any, output: any) => {
      await forwardEvent($, 'tool.execute.before', { input, output });
    },
    'tool.execute.after': async (input: any, output: any) => {
      await forwardEvent($, 'tool.execute.after', { input, output });
    },

    /** Forward permission events */
    'permission.asked': async ({ event }: any) => {
      await forwardEvent($, 'permission.asked', event);
    },
    'permission.replied': async ({ event }: any) => {
      await forwardEvent($, 'permission.replied', event);
    },

    /** Forward shell environment events */
    'shell.env': async (input: any, output: any) => {
      await forwardEvent($, 'shell.env', { input, output });
    },

    /** Forward file events */
    'file.edited': async ({ event }: any) => {
      await forwardEvent($, 'file.edited', event);
    },

    /** Forward command events */
    'command.executed': async ({ event }: any) => {
      await forwardEvent($, 'command.executed', event);
    },
  };
};

export default FredoPlugin;