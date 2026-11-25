#!/usr/bin/env node
/**
 * #3206 ST-2 — deterministic Credits artifact generator.
 *
 * ONE content authority: `docs/THIRD_PARTY_NOTICES.md` (§1–§4 + §7) and the two
 * root licence files (`LICENSE-MIT`, `LICENSE-APACHE-2.0`). The generated module
 * `apps/ui/src/applications/settings-app/credits/credits.generated.ts` is
 * committed, and `credits/__tests__/creditsGenerator.test.ts` fails the suite
 * whenever the committed artifact is not byte-identical to a fresh generation
 * (EOL-normalised on both sides, so a CRLF checkout cannot produce a false
 * stale failure).
 *
 * Why a checked-in artifact and NOT a build-time regeneration: CI runs
 * `pnpm --filter @fredo/ui build` BEFORE `test:run`
 * (`.github/workflows/validate.yml:98-100`), so a `prebuild` hook that
 * regenerated the file would make a regenerate-and-compare gate pass
 * vacuously (G-476). Nothing in this repository regenerates on build or on
 * install — the only writer is `pnpm credits:generate`.
 *
 * Fails closed. Every doc-shape assumption is asserted: the five include
 * sections must all exist (§5 and §6 must exist too, and are skipped by
 * assertion, so a doc renumber cannot silently fold removed-obligation history
 * into the artifact), §2's table header is pinned, every entry must carry a
 * licence field, a `Distribution form` field and an `Upstream`/`Source` field
 * holding an `https://` URL, and every licence cell must match one of the five
 * declared identifiers. Any violation THROWS — a partial artifact is never
 * written.
 *
 * Bodies: the MIT and Apache-2.0 bodies are the verbatim root licence files,
 * and the BSD-3-Clause body is the doc's own §3 licence block. The
 * `id Software shareware` body is §4's redistribution note and the
 * `CC BY 4.0` body is §7's prose: those two are PROSE, not legal code, which is
 * why the pane's affordance label says `licence text` and never `Full text`.
 *
 * Usage:
 *   node scripts/generate-credits.mjs      # rewrite credits.generated.ts
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repository root (this script lives in `<root>/scripts`). */
export const REPO_ROOT = resolve(HERE, '..');

/** The canonical content authority, relative to the repo root. */
export const DOC_PATH = 'docs/THIRD_PARTY_NOTICES.md';

/** The committed artifact this generator owns, relative to the repo root. */
export const GENERATED_PATH = 'apps/ui/src/applications/settings-app/credits/credits.generated.ts';

/** Bumped only when the emitted module shape changes (type/export contract). */
export const GENERATOR_VERSION = 1;

const MIT_PATH = 'LICENSE-MIT';
const APACHE_PATH = 'LICENSE-APACHE-2.0';

/**
 * The doc sections the artifact is built from. §5 and §6 are deliberately
 * absent from this map: they record removed obligations and contribute no
 * entry, field or body (asserted present-but-skipped below).
 */
export const SECTION_SHAPES = {
  1: { shape: 'fields', nameLabel: 'Component' },
  2: { shape: 'table', nameColumn: 'Component' },
  3: { shape: 'fields', nameLabel: 'Component' },
  4: { shape: 'fields', nameLabel: 'File' },
  7: { shape: 'fields', nameLabel: 'Work', subsection: '7.1' },
};

/** Present in the doc, never read into the artifact. */
const SKIPPED_SECTIONS = [5, 6];

/** §2's table header is pinned — a column change is a doc-shape change. */
const SECTION_TWO_HEADER = ['Component', 'Role', 'License / terms', 'Upstream', 'Distribution form'];

/** The `| Field | Value |` two-column shape used by §1, §3, §4 and §7.1. */
const FIELD_TABLE_HEADER = ['Field', 'Value'];

/** A licence field label: `License`, `Licence`, `License / terms`. */
const LICENCE_LABEL = /^licen[cs]e(\s*\/\s*terms)?$/i;

/**
 * The closed identifier set, tested in this order. A licence cell that matches
 * none of these throws; the order also fixes `licenceIds` order in the artifact.
 */
export const LICENCE_IDENTIFIERS = [
  { id: 'mit', label: 'MIT', pattern: /(^|[^A-Za-z0-9])MIT([^A-Za-z0-9]|$)/ },
  { id: 'apache-2-0', label: 'Apache-2.0', pattern: /Apache-2\.0/ },
  { id: 'bsd-3-clause', label: 'BSD-3-Clause', pattern: /BSD-3-Clause/ },
  { id: 'cc-by-4-0', label: 'CC BY 4.0', pattern: /CC BY 4\.0/ },
  { id: 'shareware', label: 'id Software shareware', pattern: /id Software shareware/ },
];

/** The exact entry names the artifact must carry, in doc order. */
export const CREDIT_NAMES = [
  'llama.cpp',
  'Vulkan',
  'ggml',
  'neurodoom',
  'DOOM1.WAD',
  'Posable Doomguy',
];

const DOC_REFERENCE = 'docs/THIRD_PARTY_NOTICES.md';

/** Normalise every input to `\n` so a CRLF checkout cannot fork the hash. */
function normaliseEol(text) {
  return text.replace(/\r\n?/g, '\n');
}

function fail(message) {
  throw new Error(message);
}

/**
 * Flatten one markdown table cell to display text: bold/italic emphasis and
 * backticks removed, whitespace collapsed. A cell that still contains a
 * markdown link (`](`) is a hard failure — the pane renders plain text, never
 * markdown, so a raw link would ship its syntax to the screen.
 */
function stripMarkdown(raw) {
  const withoutBold = raw.replace(/\*\*(.+?)\*\*/g, '$1');
  const withoutItalics = withoutBold.replace(/(^|[^A-Za-z0-9*])\*(?=\S)(.+?)(?<=\S)\*(?![A-Za-z0-9*])/g, '$1$2');
  const withoutCode = withoutItalics.replace(/`/g, '');
  if (withoutCode.includes('](')) {
    fail(`un-strippable markdown link in cell: ${raw.trim()}`);
  }
  return withoutCode.replace(/\s+/g, ' ').trim();
}

/** A bare label paragraph (`Notes.`/`References:`) is not prose. */
function isBareLabel(text) {
  return /^[^.!?]*:$/.test(text);
}

/** Split the doc into numbered `## N. Title` sections. */
function splitSections(docText) {
  const sections = new Map();
  let current = null;
  for (const line of docText.split('\n')) {
    const heading = /^##\s+(\d+)\.\s+(.*)$/.exec(line);
    if (heading) {
      const number = Number(heading[1]);
      if (sections.has(number)) fail(`doc-shape: duplicate section ${number}`);
      current = { number, title: heading[2].trim(), lines: [] };
      sections.set(number, current);
      continue;
    }
    if (/^#{1,2}\s/.test(line)) {
      current = null;
      continue;
    }
    // A top-level horizontal rule closes the section (the doc's trailing footer
    // sentence after §7's rule is not section content).
    if (current && line.trim() === '---') {
      current = null;
      continue;
    }
    if (current) current.lines.push(line);
  }
  return sections;
}

/** Split a `| a | b |` row into trimmed cells. */
function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

/** The first markdown table inside a section, as rows of cells. */
function firstTable(section) {
  const start = section.lines.findIndex((line) => line.trimStart().startsWith('|'));
  if (start < 0) fail(`doc-shape: §${section.number} carries no table`);
  const rows = [];
  for (let i = start; i < section.lines.length; i += 1) {
    const line = section.lines[i].trim();
    if (!line.startsWith('|')) break;
    rows.push(splitRow(line));
  }
  if (rows.length < 3) fail(`doc-shape: §${section.number}'s table carries no data rows`);
  return { header: rows[0], rows: rows.slice(1).filter((cells) => !isSeparatorRow(cells)) };
}

/** A `| Field | Value |` table → ordered `{ label, value }` rows. */
function fieldRows(section, where) {
  const { header, rows } = firstTable(section);
  if (header.length !== 2 || header[0] !== FIELD_TABLE_HEADER[0] || header[1] !== FIELD_TABLE_HEADER[1]) {
    fail(`doc-shape: ${where} must be a "| Field | Value |" table, found "${header.join(' | ')}"`);
  }
  return rows.map((cells) => {
    if (cells.length !== 2) fail(`doc-shape: ${where} row has ${cells.length} cells, expected 2`);
    return { label: stripMarkdown(cells[0]), value: stripMarkdown(cells[1]) };
  });
}

/** A column-shaped table → an ordered array of label→value rows. */
function columnRows(section, expectedHeader, where) {
  const { header, rows } = firstTable(section);
  if (header.length !== expectedHeader.length || header.some((cell, i) => cell !== expectedHeader[i])) {
    fail(
      `doc-shape: ${where}'s table header changed (expected "${expectedHeader.join(' | ')}", found "${header.join(' | ')}")`,
    );
  }
  return rows.map((cells) => {
    if (cells.length !== expectedHeader.length) {
      fail(`doc-shape: ${where} row has ${cells.length} cells, expected ${expectedHeader.length}`);
    }
    return expectedHeader.map((label, i) => ({ label, value: stripMarkdown(cells[i]) }));
  });
}

/**
 * Prose paragraphs inside a section: maximal runs of consecutive lines that are
 * not headings, table rows or list items (a list item's continuation lines are
 * part of the item and are skipped too). Bare labels (`References:`) and —
 * unless `includeTrademarks` — the trademark paragraph (rendered separately as
 * DOOM_TRADEMARK) are excluded.
 */
function proseBlocks(section, { includeTrademarks = false } = {}) {
  const blocks = [];
  let block = [];
  let inList = false;
  const flush = () => {
    if (block.length === 0) return;
    const text = stripMarkdown(block.join('\n'));
    block = [];
    if (text === '' || isBareLabel(text)) return;
    if (!includeTrademarks && text.startsWith('Trademarks.')) return;
    blocks.push(text);
  };
  for (const line of section.lines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      flush();
      inList = false;
      continue;
    }
    if (trimmed.startsWith('-')) {
      flush();
      inList = true;
      continue;
    }
    if (trimmed.startsWith('#') || trimmed.startsWith('|')) {
      flush();
      inList = false;
      continue;
    }
    if (inList) continue;
    block.push(trimmed);
  }
  flush();
  return blocks;
}

/** The `### 7.1 …` subsection of §7. */
function subsection(section, number, where) {
  const start = section.lines.findIndex((line) => /^###\s/.test(line));
  if (start < 0) fail(`doc-shape: ${where} carries no "### ${number}" subsection`);
  const heading = /^###\s+(\S+)\s+(.*)$/.exec(section.lines[start].trim());
  if (!heading || heading[1] !== number) {
    fail(`doc-shape: ${where}'s first "###" subsection is not "${number}"`);
  }
  const lines = [];
  for (let i = start + 1; i < section.lines.length; i += 1) {
    if (/^#{2,3}\s/.test(section.lines[i].trim())) break;
    lines.push(section.lines[i]);
  }
  return { number, title: heading[2].trim(), lines };
}

/** §3's own BSD 3-Clause licence block (`### BSD 3-Clause License`). */
function bsdBody(section) {
  const start = section.lines.findIndex((line) => /^###\s+BSD 3-Clause License\s*$/.test(line.trim()));
  if (start < 0) fail('doc-shape: §3 carries no "### BSD 3-Clause License" block');
  const lines = [];
  for (let i = start + 1; i < section.lines.length; i += 1) {
    const trimmed = section.lines[i].trim();
    if (/^#{2,3}\s/.test(trimmed) || trimmed === '---') break;
    lines.push(section.lines[i]);
  }
  const text = lines.join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
  if (!text.includes('Redistribution and use in source and binary forms')) {
    fail('doc-shape: §3 licence block lost its body');
  }
  return text;
}

/** Display name from a name cell: quotes, a trailing `(…)`, then the basename. */
function displayName(raw) {
  let name = stripMarkdown(raw).replace(/^["'“”]+|["'“”]+$/g, '').trim();
  name = name.replace(/\s*\([^()]*\)\s*$/, '').trim();
  const slash = name.lastIndexOf('/');
  if (slash >= 0) name = name.slice(slash + 1);
  return name.trim();
}

/** `llama.cpp` → `llama-cpp`, `DOOM1.WAD` → `doom1-wad`. */
function slug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

/** The first `https://` URL in a cell, or null. */
function firstHttpsUrl(value) {
  const match = /https:\/\/[^\s·]+/.exec(value);
  return match ? match[0].replace(/[),.;]+$/, '') : null;
}

/** The identifier descriptors a licence cell matches, in declared order. */
function licenceMatches(cell) {
  return LICENCE_IDENTIFIERS.filter((identifier) => identifier.pattern.test(cell));
}

/**
 * Build the artifact source from the doc text. Pure: the same `docText` +
 * `repoRoot` always produce the same string.
 */
export function generateCreditsSource({ repoRoot = REPO_ROOT, docText } = {}) {
  const rawDoc = docText === undefined ? readFileSync(join(repoRoot, DOC_PATH), 'utf8') : docText;
  const doc = normaliseEol(rawDoc);
  const docSha256 = createHash('sha256').update(doc, 'utf8').digest('hex');
  const sections = splitSections(doc);

  for (const number of [...Object.keys(SECTION_SHAPES).map(Number), ...SKIPPED_SECTIONS]) {
    if (!sections.has(number)) fail(`doc-shape: section ${number} is missing from ${DOC_PATH}`);
  }

  const mitText = normaliseEol(readFileSync(join(repoRoot, MIT_PATH), 'utf8'));
  const apacheText = normaliseEol(readFileSync(join(repoRoot, APACHE_PATH), 'utf8'));

  const sectionSeven = sections.get(7);
  const sharewareText = proseBlocks(sections.get(4)).join('\n\n');
  const ccByText = proseBlocks(sectionSeven).join('\n\n');
  if (sharewareText === '') fail('doc-shape: §4 carries no redistribution prose for the shareware body');
  if (ccByText === '') fail('doc-shape: §7 carries no prose for the CC BY 4.0 body');
  if (!ccByText.includes('CC BY 4.0')) fail('doc-shape: §7 prose no longer explains the CC BY 4.0 licence');

  const bodies = new Map([
    ['mit', { id: 'mit', label: 'MIT', source: MIT_PATH, text: mitText }],
    ['apache-2-0', { id: 'apache-2-0', label: 'Apache-2.0', source: APACHE_PATH, text: apacheText }],
    [
      'bsd-3-clause',
      { id: 'bsd-3-clause', label: 'BSD-3-Clause', source: 'docs/THIRD_PARTY_NOTICES.md#3', text: bsdBody(sections.get(3)) },
    ],
    [
      'cc-by-4-0',
      { id: 'cc-by-4-0', label: 'CC BY 4.0', source: 'docs/THIRD_PARTY_NOTICES.md#7', text: ccByText },
    ],
    [
      'shareware',
      { id: 'shareware', label: 'id Software shareware', source: 'docs/THIRD_PARTY_NOTICES.md#4', text: sharewareText },
    ],
  ]);

  /** One entry, with the three required fields enforced. */
  const buildEntry = (sectionNumber, nameCell, fields, where) => {
    const name = displayName(nameCell);
    if (name === '') fail(`doc-shape: ${where} carries an empty component name`);

    const licenceFields = fields.filter((field) => LICENCE_LABEL.test(field.label));
    if (licenceFields.length !== 1) {
      fail(`doc-shape: ${where} must carry exactly one licence field, found ${licenceFields.length}`);
    }
    const [licenceField] = licenceFields;
    if (licenceField.value === '') fail(`doc-shape: ${where}'s licence cell is empty`);

    const distributionFields = fields.filter((field) => field.label === 'Distribution form');
    if (distributionFields.length !== 1) {
      fail(`doc-shape: ${where} must carry exactly one "Distribution form" field, found ${distributionFields.length}`);
    }
    if (distributionFields[0].value === '') fail(`doc-shape: ${where}'s "Distribution form" cell is empty`);

    const upstreamFields = fields.filter((field) => field.label === 'Upstream' || field.label === 'Source');
    if (upstreamFields.length !== 1) {
      fail(`doc-shape: ${where} must carry exactly one "Upstream" or "Source" field, found ${upstreamFields.length}`);
    }
    const upstreamUrl = firstHttpsUrl(upstreamFields[0].value);
    if (upstreamUrl === null) fail(`doc-shape: ${where}'s upstream field holds no https:// URL`);

    const matched = licenceMatches(licenceField.value);
    if (matched.length === 0) {
      fail(`doc-shape: ${where}'s licence cell matches none of the five declared identifiers: "${licenceField.value}"`);
    }

    for (const field of fields) {
      if (field.value === '') fail(`doc-shape: ${where}'s "${field.label}" cell is empty`);
    }

    return {
      id: slug(name),
      name,
      section: sectionNumber,
      fields,
      upstreamUrl,
      licenceIds: matched.map((identifier) => identifier.label),
      licenceBodies: matched.map((identifier) => bodies.get(identifier.id)),
    };
  };

  const entries = [];

  // §1 — one component, a `| Field | Value |` table.
  {
    const section = sections.get(1);
    const rows = fieldRows(section, '§1');
    const nameRow = rows.find((row) => row.label === SECTION_SHAPES[1].nameLabel);
    if (!nameRow) fail('doc-shape: §1 carries no "Component" field');
    entries.push(
      buildEntry(
        1,
        nameRow.value,
        rows.filter((row) => row !== nameRow),
        '§1',
      ),
    );
  }

  // §2 — a column table with two component rows (Vulkan, ggml).
  {
    const section = sections.get(2);
    const nameColumn = SECTION_SHAPES[2].nameColumn;
    const nameIndex = SECTION_TWO_HEADER.indexOf(nameColumn);
    for (const row of columnRows(section, SECTION_TWO_HEADER, '§2')) {
      entries.push(
        buildEntry(
          2,
          row[nameIndex].value,
          row.filter((_, i) => i !== nameIndex),
          '§2',
        ),
      );
    }
  }

  // §3 — one component, a `| Field | Value |` table.
  {
    const section = sections.get(3);
    const rows = fieldRows(section, '§3');
    const nameRow = rows.find((row) => row.label === SECTION_SHAPES[3].nameLabel);
    if (!nameRow) fail('doc-shape: §3 carries no "Component" field');
    entries.push(
      buildEntry(
        3,
        nameRow.value,
        rows.filter((row) => row !== nameRow),
        '§3',
      ),
    );
  }

  // §4 — one component, a `| Field | Value |` table.
  {
    const section = sections.get(4);
    const rows = fieldRows(section, '§4');
    const nameRow = rows.find((row) => row.label === SECTION_SHAPES[4].nameLabel);
    if (!nameRow) fail('doc-shape: §4 carries no "File" field');
    entries.push(
      buildEntry(
        4,
        nameRow.value,
        rows.filter((row) => row !== nameRow),
        '§4',
      ),
    );
  }

  // §7.1 — one design-reference component, in the first `###` subsection.
  {
    const sectionSevenEntry = SECTION_SHAPES[7].subsection;
    const sub = subsection(sectionSeven, sectionSevenEntry, '§7');
    const rows = fieldRows(sub, '§7.1');
    const nameRow = rows.find((row) => row.label === SECTION_SHAPES[7].nameLabel);
    if (!nameRow) fail('doc-shape: §7.1 carries no "Work" field');
    entries.push(
      buildEntry(
        7,
        nameRow.value,
        rows.filter((row) => row !== nameRow),
        '§7.1',
      ),
    );
  }

  // Fails closed on a silent loss/addition of a component.
  if (entries.length === 0) fail('doc-shape: the include set produced zero entries');
  const names = entries.map((entry) => entry.name);
  if (names.length !== CREDIT_NAMES.length || names.some((name, i) => name !== CREDIT_NAMES[i])) {
    fail(`doc-shape: entry names changed (expected "${CREDIT_NAMES.join('", "')}", found "${names.join('", "')}")`);
  }
  const ids = entries.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) fail(`doc-shape: duplicate entry ids (${ids.join(', ')})`);

  // Fredo's own licence — the preamble's dual-licence sentence, verbatim.
  // The search runs on whitespace-flattened text because the sentence wraps.
  const flatDoc = doc.replace(/\s+/g, ' ');
  const statementMatches = flatDoc.match(/Fredo itself is dual-licensed[\s\S]*?licenses?\./g) ?? [];
  if (statementMatches.length !== 1) {
    fail(`doc-shape: the preamble must carry exactly one dual-licence sentence, found ${statementMatches.length}`);
  }
  const statement = statementMatches[0].trim();
  const fredoIdentifiers = licenceMatches(statement);
  if (fredoIdentifiers.length !== 2 || fredoIdentifiers[0].id !== 'mit' || fredoIdentifiers[1].id !== 'apache-2-0') {
    fail('doc-shape: the preamble dual-licence sentence must name exactly MIT and Apache-2.0');
  }
  if (!flatDoc.includes('`MIT OR Apache-2.0`')) {
    fail('doc-shape: the preamble must record the SPDX expression `MIT OR Apache-2.0`');
  }

  // The DOOM trademark notice — exactly one paragraph in §4 opens with it.
  const trademarkParagraphs = proseBlocks(sections.get(4), { includeTrademarks: true }).filter((text) =>
    text.startsWith('Trademarks.'),
  );
  if (trademarkParagraphs.length !== 1) {
    fail(`doc-shape: §4 must carry exactly one "**Trademarks.**" paragraph, found ${trademarkParagraphs.length}`);
  }

  const data = {
    entries,
    fredoLicence: {
      licenceIds: fredoIdentifiers.map((identifier) => identifier.label),
      statement,
      licenceBodies: fredoIdentifiers.map((identifier) => bodies.get(identifier.id)),
    },
    trademark: { text: trademarkParagraphs[0], source: 'docs/THIRD_PARTY_NOTICES.md#4' },
    source: { docPath: DOC_PATH, docSha256, generatorVersion: GENERATOR_VERSION },
  };

  return renderModule(data);
}

const INTERFACES = `export interface CreditField {
  readonly label: string;
  readonly value: string;
}

export interface LicenceBody {
  readonly id: string;
  readonly label: string;
  readonly source: string;
  readonly text: string;
}

export interface CreditEntry {
  readonly id: string;
  readonly name: string;
  readonly section: 1 | 2 | 3 | 4 | 7;
  readonly fields: readonly CreditField[];
  readonly upstreamUrl: string;
  readonly licenceIds: readonly string[];
  readonly licenceBodies: readonly LicenceBody[];
}

export interface FredoLicence {
  readonly licenceIds: readonly string[];
  readonly statement: string;
  readonly licenceBodies: readonly LicenceBody[];
}

export interface TrademarkNotice {
  readonly text: string;
  readonly source: 'docs/THIRD_PARTY_NOTICES.md#4';
}

export interface CreditsSource {
  readonly docPath: string;
  readonly docSha256: string;
  readonly generatorVersion: 1;
}`;

/** Emit the module. Every datum goes through `JSON.stringify` (valid TS). */
function renderModule({ entries, fredoLicence, trademark, source }) {
  const json = (value) => JSON.stringify(value, null, 2);
  return [
    `// GENERATED FILE — do not edit. Regenerate with "pnpm credits:generate". Source: ${DOC_REFERENCE} @ sha256:${source.docSha256}`,
    '',
    INTERFACES,
    '',
    `export const CREDIT_ENTRIES: readonly CreditEntry[] = ${json(entries)};`,
    '',
    `export const FREDO_LICENCE: FredoLicence = ${json(fredoLicence)};`,
    '',
    `export const DOOM_TRADEMARK: TrademarkNotice = ${json(trademark)};`,
    '',
    `export const CREDITS_SOURCE: CreditsSource = ${json(source)};`,
    '',
  ].join('\n');
}

/** Write the artifact. Always writes — a no-op skip would hide a dead generator. */
function main() {
  const repoRoot = REPO_ROOT;
  const doc = normaliseEol(readFileSync(join(repoRoot, DOC_PATH), 'utf8'));
  const docSha256 = createHash('sha256').update(doc, 'utf8').digest('hex');
  const source = generateCreditsSource({ repoRoot });
  const target = join(repoRoot, GENERATED_PATH);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source, 'utf8');
  console.log(`credits:generate wrote ${GENERATED_PATH} (${source.length} bytes, source ${DOC_PATH} @ sha256:${docSha256})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`credits:generate FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
