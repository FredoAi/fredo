/**
 * The SERVED Tauri entry must load the same global stylesheets as the UI dev
 * entry.
 *
 * `apps/tauri/src/main.tsx` is what `vite build` bundles into `apps/tauri/dist`
 * and what the installer ships (`frontendDist: "../dist"`). It imports the app
 * through the `@fredo/ui` barrel, and a barrel cannot carry CSS side effects —
 * so without explicit imports here the released artifact renders with
 * browser-default fonts, no layout reset and no theme tokens, while the UI dev
 * server (`apps/ui/src/main.tsx`, port 5173) looks correct. That shipped
 * unstyled in the 0.2.2 artifact and was only caught by installing it.
 *
 * This is a source-level guard on purpose: the defect is an absent import, and
 * nothing in the bundle can prove the difference between "CSS missing" and
 * "CSS legitimately small" at build time.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readServedEntry(): string {
  const candidates = [
    resolve(process.cwd(), '../tauri/src/main.tsx'),
    resolve(process.cwd(), 'apps/tauri/src/main.tsx'),
  ];
  const hit = candidates.find((candidate) => existsSync(candidate));
  if (!hit) {
    throw new Error(
      `served entry not found; looked in: ${candidates.join(', ')} (cwd=${process.cwd()})`,
    );
  }
  return readFileSync(hit, 'utf8');
}

describe('served Tauri entry — global stylesheets', () => {
  const entry = readServedEntry();

  it('imports the global stylesheet', () => {
    expect(entry).toMatch(/import\s+['"][^'"]*ui\/src\/style\.css['"]/);
  });

  it('imports the mono font stylesheet', () => {
    expect(entry).toMatch(/import\s+['"][^'"]*assets\/fonts\/fira-mono\.css['"]/);
  });

  it('keeps the UI dev entry and the served entry in agreement', () => {
    const devEntry = readFileSync(
      resolve(process.cwd(), 'src/main.tsx'),
      'utf8',
    );
    for (const sheet of ['style.css', 'fonts/fira-mono.css']) {
      expect(devEntry, `dev entry should import ${sheet}`).toContain(sheet);
      expect(entry, `served entry should import ${sheet}`).toContain(sheet);
    }
  });
});

describe('release CSP — Chakra/emotion runtime styles', () => {
  /**
   * Chakra v3 emits its component styles at runtime through emotion, which
   * creates `<style data-emotion>` elements. Tauri rewrites the CSP to attach a
   * nonce to the tags it owns; under the CSP spec a nonce in `style-src`
   * DISABLES `'unsafe-inline'` for elements without that nonce — so emotion's
   * tags are refused and the shipped app renders unstyled while the same
   * bundle is correct in a browser (verified: a CDP-injected `<style>` was
   * blocked and every emotion sheet stayed at zero rules).
   *
   * `dangerousDisableAssetCspModification: ["style-src"]` stops Tauri touching
   * that directive, so the declared `'unsafe-inline'` stays effective. Script
   * and other directives keep their asset modification.
   */

  function readTauriConf(): {
    csp: string;
    dangerousDisableAssetCspModification?: boolean | string[];
  } {
    const candidates = [
      resolve(process.cwd(), '../tauri/src-tauri/tauri.conf.json'),
      resolve(process.cwd(), 'apps/tauri/src-tauri/tauri.conf.json'),
    ];
    const hit = candidates.find((candidate) => existsSync(candidate));
    if (!hit) throw new Error(`tauri.conf.json not found (cwd=${process.cwd()})`);
    const conf = JSON.parse(readFileSync(hit, 'utf8')) as {
      app: {
        security: {
          csp: string;
          dangerousDisableAssetCspModification?: boolean | string[];
        };
      };
    };
    return conf.app.security;
  }

  const security = readTauriConf();

  it('declares an inline-permitting style-src', () => {
    expect(security.csp).toMatch(/style-src[^;]*'unsafe-inline'/);
  });

  it('stops Tauri rewriting style-src (nonce would void unsafe-inline)', () => {
    const disabled = security.dangerousDisableAssetCspModification;
    expect(disabled, 'style-src must be exempted from CSP asset modification').toBeDefined();
    if (Array.isArray(disabled)) {
      expect(disabled).toContain('style-src');
    } else {
      expect(disabled).toBe(true);
    }
  });
});

