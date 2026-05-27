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
import { appendFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ── Debug log ──────────────────────────────────────────────────────────────

const DEBUG_LOG = join(homedir(), '.config', 'opencode', 'plugins', 'fredo-debug.log');

function debug(msg: string): void {
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // fail silently
  }
}

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
    debug(`SEND ${eventType} ${jsonString.slice(0, 200)}`);
    await $`fredo open-code-plugin ${eventType} --payload ${jsonString}`.nothrow();
    debug(`SENT ${eventType}`);
  } catch (err: any) {
    debug(`ERR ${eventType}: ${err?.message || err}`);
  }
}

// ── Plugin ─────────────────────────────────────────────────────────────────

debug('LOADED — fredo plugin entry point evaluated');

export const FredoPlugin: Plugin = async ({ $ }) => {
  debug('INIT — FredoPlugin async function called');
  console.log('[fredo] Plugin initialized — forwarding events to Fredo desktop app');

  return {
    /** Catch-all event hook */
    event: async ({ event }: any) => {
      debug(`HOOK event type=${event?.type}`);
      await forwardEvent($, 'event', event);
    },

    /** Session lifecycle */
    'session.created': async ({ event }: any) => {
      const session_id = event?.session?.id || event?.id || '';
      debug(`HOOK session.created id=${session_id}`);
      await forwardEvent($, 'SessionStart', { session_id, ...event });
    },
    'session.updated': async ({ event }: any) => {
      const session_id = event?.session?.id || event?.id || '';
      debug(`HOOK session.updated id=${session_id}`);
      await forwardEvent($, 'SessionStart', { session_id, ...event });
    },
    'session.idle': async ({ event }: any) => {
      debug(`HOOK session.idle`);
      await forwardEvent($, 'session.idle', event);
    },
    'session.error': async ({ event }: any) => {
      debug(`HOOK session.error`);
      await forwardEvent($, 'session.error', event);
    },
    'session.deleted': async ({ event }: any) => {
      const session_id = event?.session?.id || event?.id || '';
      debug(`HOOK session.deleted id=${session_id}`);
      await forwardEvent($, 'SessionEnd', { session_id, ...event });
    },

    /** Tool execution events -> PreToolUse / PostToolUse */
    'tool.execute.before': async (input: any, output: any) => {
      debug(`HOOK tool.execute.before tool=${input?.tool}`);
      await forwardEvent($, 'PreToolUse', {
        tool_name: input?.tool || '',
        tool_input: input?.args || input,
        tool_use_id: input?.tool_use_id || '',
      });
    },
    'tool.execute.after': async (input: any, output: any) => {
      debug(`HOOK tool.execute.after tool=${input?.tool}`);
      await forwardEvent($, 'PostToolUse', {
        tool_name: input?.tool || '',
        tool_response: output || '',
        tool_use_id: input?.tool_use_id || '',
      });
    },

    /** Permission events */
    'permission.asked': async ({ event }: any) => {
      debug(`HOOK permission.asked`);
      await forwardEvent($, 'permission.asked', event);
    },
    'permission.replied': async ({ event }: any) => {
      debug(`HOOK permission.replied`);
      await forwardEvent($, 'permission.replied', event);
    },

    /** Shell environment */
    'shell.env': async (input: any, output: any) => {
      debug(`HOOK shell.env`);
      await forwardEvent($, 'shell.env', { input, output });
    },

    /** File events */
    'file.edited': async ({ event }: any) => {
      debug(`HOOK file.edited`);
      await forwardEvent($, 'file.edited', event);
    },

    /** Command events */
    'command.executed': async ({ event }: any) => {
      debug(`HOOK command.executed`);
      await forwardEvent($, 'command.executed', event);
    },
  };
};

export default FredoPlugin;
