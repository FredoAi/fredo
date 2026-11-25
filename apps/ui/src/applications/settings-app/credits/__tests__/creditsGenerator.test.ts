/**
 * #3206 ST-2 — the Credits staleness gate (AC-4 / R-4.1..R-4.3).
 *
 * "Generated, not hand-copied" is only true if drift FAILS the suite. This file
 * is that gate, and it is deliberately NON-VACUOUS (G-476):
 *
 *   1. the committed `credits.generated.ts` must EXIST (a pre-change tree with
 *      nothing generated is RED, not green),
 *   2. regenerating from the current doc must be a byte no-op,
 *   3. a mutated DOC must be RED (the artifact no longer equals a fresh
 *      generation, and structural mutations make the generator throw),
 *   4. a mutated ARTIFACT must be RED,
 *   5. restoring both sides must be GREEN again.
 *
 * The generator is pure over the doc string, so every negative leg runs
 * in-memory on a synthetic copy — this suite never writes a file.
 *
 * Nothing regenerates on build/install (CI runs `build` BEFORE `test:run`, so a
 * `prebuild` hook would make this gate vacuous — see the generator's header).
 * On drift the operator runs `pnpm credits:generate` and commits the artifact.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CREDIT_ENTRIES, CREDITS_SOURCE, DOOM_TRADEMARK, FREDO_LICENCE } from '../credits.generated';

/** vitest runs with cwd = `apps/ui` (the package root). */
const REPO_ROOT = resolve(process.cwd(), '..', '..');
const DOC_PATH = 'docs/THIRD_PARTY_NOTICES.md';
const ARTIFACT_PATH = 'apps/ui/src/applications/settings-app/credits/credits.generated.ts';
const DRIFT_MESSAGE = 'the doc drifted — run `pnpm credits:generate` and commit the artifact';

interface GeneratorModule {
  generateCreditsSource(options?: { repoRoot?: string; docText?: string }): string;
}

/**
 * Loaded lazily: `scripts/generate-credits.mjs` lives outside `apps/ui`, and a
 * dynamic file-URL import keeps the monorepo layout explicit.
 */
let generatorCache: Promise<GeneratorModule> | null = null;
function loadGenerator(): Promise<GeneratorModule> {
  if (generatorCache === null) {
    generatorCache = import(pathToFileURL(resolve(REPO_ROOT, 'scripts', 'generate-credits.mjs')).href) as Promise<GeneratorModule>;
  }
  return generatorCache;
}

const normalise = (text: string): string => text.replace(/\r\n?/g, '\n');

const readRepoFile = (relativePath: string): string => readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');

/** The doc, EOL-normalised — the same input the generator hashes. */
const readDoc = (): string => normalise(readRepoFile(DOC_PATH));

const readArtifact = (): string => readRepoFile(ARTIFACT_PATH);

/** A fresh generation from the doc text as committed. */
async function generate(docText?: string): Promise<string> {
  const { generateCreditsSource } = await loadGenerator();
  return normalise(generateCreditsSource({ repoRoot: REPO_ROOT, docText }));
}

/** A drift failure must read as one actionable sentence, not a 50 KB diff. */
function assertNoDrift(committed: string, fresh: string): void {
  if (committed !== fresh) {
    throw new Error(
      `${DRIFT_MESSAGE} (committed artifact ${committed.length} bytes ≠ fresh generation ${fresh.length} bytes)`,
    );
  }
}

/** Structural mutations: each MUST make the generator throw, never emit. */
function structuralMutations(doc: string): Array<{ name: string; mutate: (text: string) => string }> {
  return [
    {
      name: '§3 heading removed (include-set shape change)',
      mutate: (text) => text.replace('## 3. Doom Mode engine', '## Three. Doom Mode engine'),
    },
    {
      name: '§2 `Distribution form` column renamed',
      mutate: (text) => text.replace('| Upstream | Distribution form |', '| Upstream | Distribution |'),
    },
    {
      name: '§2 upstream cell downgraded to http://',
      mutate: (text) => text.replace('| https://github.com/ggml-org/ggml |', '| http://github.com/ggml-org/ggml |'),
    },
    {
      name: '§2 licence cell matching none of the five identifiers',
      mutate: (text) => text.replace('**MIT** (same upstream', '**Proprietary** (same upstream'),
    },
    {
      name: '§4 `Upstream` row removed',
      mutate: (text) => text.replace('| Upstream | https://www.doomworld.com/idgames/?id=7043 |\n', ''),
    },
    {
      name: '§5 heading removed (removed-obligation history cannot fold in)',
      mutate: (text) =>
        text.replace('## 5. Removed GPL corresponding-source obligation', '## Five. Removed GPL corresponding-source obligation'),
    },
    {
      name: '§6 heading removed (removed runtime history cannot fold in)',
      mutate: (text) =>
        text.replace('## 6. Removed out-of-process companion runtime', '## Six. Removed out-of-process companion runtime'),
    },
  ];
}

describe('credits artifact — the committed file', () => {
  it('exists (the pre-change tree is RED, not vacuously green)', () => {
    expect(existsSync(resolve(REPO_ROOT, ARTIFACT_PATH)), `${ARTIFACT_PATH} is missing — run \`pnpm credits:generate\``).toBe(
      true,
    );
    // The header names the generator command and pins the source doc's hash.
    const firstLine = readArtifact().split('\n')[0];
    expect(firstLine).toContain('GENERATED FILE — do not edit. Regenerate with "pnpm credits:generate"');
    expect(firstLine).toContain(`sha256:${CREDITS_SOURCE.docSha256}`);
  });

  it('is byte-identical to a fresh generation (regenerating is a no-op)', async () => {
    expect(CREDITS_SOURCE.docPath).toBe(DOC_PATH);
    assertNoDrift(normalise(readArtifact()), await generate());
  });

  it('pins its header hash to the doc content (EOL-normalised)', () => {
    const digest = createHash('sha256').update(readDoc(), 'utf8').digest('hex');
    expect(CREDITS_SOURCE.docSha256, 'the recorded source hash is not the current doc hash').toBe(digest);
  });

  it('carries none of the §5/§6 removed-obligation markers', () => {
    const artifact = readArtifact();
    expect(artifact).not.toContain('RESTful-DOOM');
    expect(artifact).not.toContain('Removed out-of-process companion runtime');
  });
});

describe('credits artifact — the gate is content-bound', () => {
  it('is RED when the doc is edited without regeneration', async () => {
    const doc = readDoc();
    const mutated = doc.replace('| Use in Fredo |', '| Use in Fredo | QA-DRIFT-3206-MARKER ');
    expect(mutated).not.toBe(doc);
    const regenerated = await generate(mutated);
    expect(regenerated).not.toBe(normalise(readArtifact()));
    // The edit really reached the artifact (a marker-blind generator would pass the line above).
    expect(regenerated).toContain('QA-DRIFT-3206-MARKER');
  });

  it('is RED when the committed artifact is mutated', async () => {
    const artifact = readArtifact();
    const mutated = artifact.replace('"name": "Vulkan"', '"name": "Vulkan!"');
    expect(mutated).not.toBe(artifact);
    expect(normalise(mutated)).not.toBe(await generate());
  });

  it('is GREEN again once both sides are restored', async () => {
    assertNoDrift(normalise(readArtifact()), await generate());
    const digest = createHash('sha256').update(readDoc(), 'utf8').digest('hex');
    expect(CREDITS_SOURCE.docSha256).toBe(digest);
  });

  it('throws on every structural doc-shape change instead of emitting a partial artifact', async () => {
    const doc = readDoc();
    for (const { name, mutate } of structuralMutations(doc)) {
      const mutated = mutate(doc);
      expect(mutated, `mutation did not apply: ${name}`).not.toBe(doc);
      await expect(generate(mutated), name).rejects.toThrow(/doc-shape/);
    }
  });
});

describe('credits artifact — content contract', () => {
  it('holds exactly the six components, in doc order', () => {
    expect(CREDIT_ENTRIES.map((entry) => entry.id)).toEqual([
      'llama-cpp',
      'vulkan',
      'ggml',
      'neurodoom',
      'doom1-wad',
      'posable-doomguy',
    ]);
    expect(CREDIT_ENTRIES.map((entry) => entry.name)).toEqual([
      'llama.cpp',
      'Vulkan',
      'ggml',
      'neurodoom',
      'DOOM1.WAD',
      'Posable Doomguy',
    ]);
    expect(CREDIT_ENTRIES.map((entry) => entry.section)).toEqual([1, 2, 2, 3, 4, 7]);
  });

  it('gives every entry fields, a licence identifier set and an https upstream URL', () => {
    const expectedUrls: Record<string, string> = {
      'llama-cpp': 'https://github.com/ggml-org/llama.cpp',
      vulkan: 'https://www.vulkan.org/',
      ggml: 'https://github.com/ggml-org/ggml',
      neurodoom: 'https://codeberg.org/olanod/NeuroDoom',
      'doom1-wad': 'https://www.doomworld.com/idgames/?id=7043',
      'posable-doomguy': 'https://www.thingiverse.com/thing:4873090',
    };
    const expectedLicences: Record<string, string[]> = {
      'llama-cpp': ['MIT', 'Apache-2.0'],
      vulkan: ['Apache-2.0'],
      ggml: ['MIT'],
      neurodoom: ['BSD-3-Clause'],
      'doom1-wad': ['id Software shareware'],
      'posable-doomguy': ['CC BY 4.0'],
    };
    const expectedBodies: Record<string, string[]> = {
      'llama-cpp': ['mit', 'apache-2-0'],
      vulkan: ['apache-2-0'],
      ggml: ['mit'],
      neurodoom: ['bsd-3-clause'],
      'doom1-wad': ['shareware'],
      'posable-doomguy': ['cc-by-4-0'],
    };

    expect(CREDIT_ENTRIES).toHaveLength(6);
    for (const entry of CREDIT_ENTRIES) {
      expect(entry.fields.length, `${entry.id} has no fields`).toBeGreaterThan(0);
      for (const field of entry.fields) {
        expect(field.label, `${entry.id} has an empty field label`).not.toBe('');
        expect(field.value, `${entry.id}'s "${field.label}" is empty`).not.toBe('');
        expect(field.value, `${entry.id}'s "${field.label}" still carries markdown emphasis`).not.toMatch(/\*\*/);
      }
      expect(entry.upstreamUrl.startsWith('https://'), `${entry.id}'s upstream is not https`).toBe(true);
      expect(entry.upstreamUrl).toBe(expectedUrls[entry.id]);
      expect(entry.licenceIds).toEqual(expectedLicences[entry.id]);
      expect(entry.licenceBodies.map((body) => body.id)).toEqual(expectedBodies[entry.id]);
      for (const body of entry.licenceBodies) {
        expect(body.text.length, `${entry.id}'s "${body.label}" body is empty`).toBeGreaterThan(0);
      }
    }
  });

  it("carries Fredo's own dual licence, both bodies equal to their files", () => {
    expect(FREDO_LICENCE.licenceIds).toEqual(['MIT', 'Apache-2.0']);
    expect(FREDO_LICENCE.statement).toBe('Fredo itself is dual-licensed under the MIT and Apache-2.0 licenses.');
    // The statement is doc data, never an app-only sentence (AC-4).
    expect(readDoc()).toContain(FREDO_LICENCE.statement);
    // ST-1 records the SPDX expression in the canonical doc, so the pane can show it.
    expect(readDoc()).toContain('`MIT OR Apache-2.0`');

    expect(FREDO_LICENCE.licenceBodies.map((body) => body.source)).toEqual(['LICENSE-MIT', 'LICENSE-APACHE-2.0']);
    expect(FREDO_LICENCE.licenceBodies[0].text).toBe(normalise(readRepoFile('LICENSE-MIT')));
    expect(FREDO_LICENCE.licenceBodies[1].text).toBe(normalise(readRepoFile('LICENSE-APACHE-2.0')));
    expect(FREDO_LICENCE.licenceBodies[1].text).toContain('END OF TERMS AND CONDITIONS');
    expect(FREDO_LICENCE.licenceBodies[1].text).toContain('APPENDIX: How to apply the Apache License to your work.');
  });

  it('carries the §4 trademark + non-affiliation notice verbatim', () => {
    expect(DOOM_TRADEMARK.source).toBe('docs/THIRD_PARTY_NOTICES.md#4');
    expect(DOOM_TRADEMARK.text).toContain('not affiliated with, endorsed by, or sponsored by id Software');
    expect(DOOM_TRADEMARK.text).toContain('trademarks of id Software LLC / ZeniMax Media Inc');
  });

  it('carries the AC-3 "reference only" statement as the §7 distribution form', () => {
    const designReference = CREDIT_ENTRIES.find((entry) => entry.section === 7);
    expect(designReference?.id).toBe('posable-doomguy');
    const distributionForm = designReference?.fields.find((field) => field.label === 'Distribution form');
    expect(distributionForm?.value).toContain('Reference only — no geometry shipped');
  });
});
