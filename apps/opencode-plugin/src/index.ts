/**
 * Fredo OpenCode Plugin — event hooks for real-time observability.
 *
 * Hooks into all OpenCode lifecycle events and forwards them to the
 * Fredo desktop app via the `fredo opencode-plugin` CLI command.
 * Each hook uses safe argument passing (SEC-REQ-3) to prevent
 * shell injection — never interpolates user data into command strings.
 */

import type { Plugin } from '@opencode-ai/plugin';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Forward an event to the Fredo desktop app.
 * SEC-REQ-3: Uses .args() for safe argument passing — no string interpolation.
 */
async function forwardEvent(
  ctx: any,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const jsonString = JSON.stringify(payload);
    await ctx.$`fredo opencode-plugin`.args([eventType, '--payload', jsonString]).nothrow();
  } catch {
    // Silently swallow errors — plugin hooks must not crash OpenCode.
  }
}

// ── Hook implementations ──────────────────────────────────────────────────

const hooks: Record<string, (ctx: any, payload: Record<string, unknown>) => Promise<void>> = {
  'event': async (ctx, payload) => {
    await forwardEvent(ctx, 'event', payload);
  },

  'chat.message': async (ctx, payload) => {
    await forwardEvent(ctx, 'chat.message', payload);
  },

  'chat.params': async (ctx, payload) => {
    await forwardEvent(ctx, 'chat.params', payload);
  },

  'chat.headers': async (ctx, payload) => {
    await forwardEvent(ctx, 'chat.headers', payload);
  },

  'tool.execute.before': async (ctx, payload) => {
    await forwardEvent(ctx, 'tool.execute.before', payload);
  },

  'tool.execute.after': async (ctx, payload) => {
    await forwardEvent(ctx, 'tool.execute.after', payload);
  },

  'permission.ask': async (ctx, payload) => {
    await forwardEvent(ctx, 'permission.ask', payload);
  },

  'command.execute.before': async (ctx, payload) => {
    await forwardEvent(ctx, 'command.execute.before', payload);
  },

  'shell.env': async (ctx, payload) => {
    await forwardEvent(ctx, 'shell.env', payload);
  },
};

// ── Plugin entry ───────────────────────────────────────────────────────────

export default function Plugin(ctx: any): void {
  for (const [hookName, handler] of Object.entries(hooks)) {
    ctx.on(hookName, handler);
  }
}

export const metadata = {
  name: 'fredo',
  version: '3.0.0',
  description: 'Fredo mission control — hooks into OpenCode events and forwards them to the Fredo desktop app for real-time observability',
};