/**
 * #2893 ST-7 rework — the SERVED Tauri entry must register every adapter bridge fn.
 *
 * STATIC / SOURCE-ASSERTION PIN. `adapterBridge` is a per-module-graph singleton
 * (`apps/ui/src/shared/utils/adapterBridge.ts`). The Tauri webview loads
 * `apps/tauri/index.html` → `/src/main.tsx` (Vite :5174) and imports the UI library
 * via `@fredo/ui`, so it NEVER executes `apps/ui/src/main.tsx` (the standalone UI
 * dev-server entry, Vite :5173). Each served entry therefore needs its own
 * registration block, and the Tauri one must cover the skill-aware path too.
 *
 * Round-1 defect: `setLlmChatWithSkills` was registered only in the UI dev entry,
 * so the running app warned `llmChatWithSkills called before adapter registered`
 * and the Companion's skill-aware `ask` path was inert (no model request, no
 * `open_app` selection, no reply, no window).
 *
 * This guard reads the served entry and fails if ANY registration silently
 * disappears. Comments are stripped so the doc prose cannot satisfy the pin.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** vitest runs with cwd = apps/ui (the package root) — same pattern as
 *  `companion.cursorReducedMotion.test.ts`. */
const TAURI_ENTRY_PATH = '../tauri/src/main.tsx';

/** Strip block + line comments so prose mentioning a setter cannot pass the pin. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function readTauriEntry(): string {
  return stripComments(readFileSync(resolve(process.cwd(), TAURI_ENTRY_PATH), 'utf8'));
}

describe('#2893 ST-7 rework — served Tauri entry register every adapter bridge fn', () => {
  it('registers all five bridge setters in apps/tauri/src/main.tsx', () => {
    const source = readTauriEntry();

    // The full set the served entry must wire. `setLlmChatWithSkills` is the one
    // the round-1 defect missed; `setLlmChatWithAudio` is the #2897 ST-3 addition.
    // The others are pinned so a future registration block cannot silently drop
    // any of them.
    const requiredRegistrations = [
      'setInvoke(',
      'setLlmChat(',
      'setLlmChatWithImage(',
      'setLlmChatWithSkills(',
      'setLlmChatWithAudio(',
    ];

    for (const registration of requiredRegistrations) {
      expect(
        source,
        `apps/tauri/src/main.tsx must register adapterBridge.${registration.slice(0, -1)}(...)`,
      ).toContain(registration);
    }
  });

  it('binds the skill-aware registration to the concrete adapter (the TauriAdapter implements it)', () => {
    const source = readTauriEntry();
    expect(source).toMatch(/adapterBridge\.setLlmChatWithSkills\(\s*adapter\.llmChatWithSkills\.bind\(adapter\)/);
  });

  it('#2897 ST-3 — binds the model-audio registration to the concrete adapter', () => {
    const source = readTauriEntry();
    expect(source).toMatch(/adapterBridge\.setLlmChatWithAudio\(\s*adapter\.llmChatWithAudio\.bind\(adapter\)/);
  });

  it('#2918 ST-3 — binds the structured-status registration to the concrete adapter', () => {
    const source = readTauriEntry();
    expect(source).toMatch(
      /adapterBridge\.setLlmChatWithStatus\(\s*adapter\.llmChatWithStatus\.bind\(adapter\)/,
    );
  });
});
