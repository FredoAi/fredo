/**
 * Spec #2946 ST-13 — the SERVED Tauri entry must mount `HotkeysProvider`.
 *
 * STATIC / SOURCE-ASSERTION PIN. The Tauri webview loads `apps/tauri/index.html`
 * → `/src/main.tsx` (Vite :5174) and imports the UI library via `@fredo/ui`, so it
 * NEVER executes `apps/ui/src/main.tsx` (the standalone UI dev-server entry). The
 * round-1 defect: `HotkeysProvider` was mounted only in the library entry, so the
 * shipped webview had no engine listener, announcer or which-key overlay. A served
 * build cannot see an unmounted provider (it compiles fine), hence this source pin.
 *
 * Mirrors `src/shared/utils/__tests__/adapterEntryRegistration.test.ts`. Comments
 * are stripped so doc prose mentioning the provider cannot satisfy the pin.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** vitest runs with cwd = apps/ui (the package root) — same pattern as
 *  `adapterEntryRegistration.test.ts`. */
const TAURI_ENTRY_PATH = '../tauri/src/main.tsx';

/** Strip block + line comments so prose mentioning the provider cannot pass. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function readTauriEntry(): string {
  return stripComments(readFileSync(resolve(process.cwd(), TAURI_ENTRY_PATH), 'utf8'));
}

describe('#2946 ST-13 — served Tauri entry mounts the hotkey engine', () => {
  it('reads a real served entry (guards against a broken path passing vacuously)', () => {
    expect(readTauriEntry().length).toBeGreaterThan(0);
  });

  it("imports HotkeysProvider from '@fredo/ui'", () => {
    const source = readTauriEntry();
    expect(source).toMatch(
      /import\s*\{[^}]*\bHotkeysProvider\b[^}]*\}\s*from\s*'@fredo\/ui'/s,
    );
  });

  it('wraps <Router /> (and <Toaster />) in <HotkeysProvider>', () => {
    const source = readTauriEntry();
    expect(source).toMatch(/<HotkeysProvider>[\s\S]*<Router[\s\S]*<\/HotkeysProvider>/);
    expect(source).toMatch(/<HotkeysProvider>[\s\S]*<Toaster[\s\S]*<\/HotkeysProvider>/);
  });
});
