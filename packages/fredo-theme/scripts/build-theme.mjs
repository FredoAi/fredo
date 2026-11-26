/**
 * build-theme.mjs — generates `@fredo/theme`'s `dist/` from the SHIPPED token
 * contract (`apps/ui/src/app/theme/contract/{surfaces,tokens}.ts`, Spec #3034).
 *
 * The package is a NAME contract, not a value source: every emitted value is a
 * `var(--…)` reference or a `color-mix()` whose operands are only `var()`s, so
 * `dist/` can never become a second source of colour (NFR-5).
 *
 * HOW THE CONTRACT IS READ, AND WHY THIS WAY
 *   The contract is a TypeScript module. The package must have ZERO non-`node:`
 *   imports (the kit is dependency-free, NFR-3) and the repo's CI runs Node 20,
 *   which has no TypeScript stripping. So the generator does not import the
 *   module: it reads the two DATA literals out of the source text
 *   (`SEMANTIC_TOKENS` in tokens.ts, `DERIVATIONS` in surfaces.ts) with a
 *   balanced-bracket scanner that understands strings and comments, and
 *   evaluates each literal as data with a provided `DERIVATIONS` binding.
 *
 *   That is safe here precisely because both literals are pure data (names,
 *   var names, numbers, booleans). The scanner FAILS CLOSED: a missing anchor,
 *   an unbalanced literal, or a parsed shape that is not the contract's shape
 *   is a build error — never a silent partial output. The result is then
 *   compared byte-for-byte with the committed `dist/` (the drift gate), so a
 *   contract change that this reader cannot see still reddens at `--check`.
 *
 * DRIFT GATE (G-480)
 *   `node packages/fredo-theme/scripts/build-theme.mjs --check` regenerates in
 *   memory and compares against the committed `dist/`. A stale artifact fails;
 *   nothing regenerates implicitly (no lifecycle hook writes `dist/`).
 *   Comparison is over LF-normalised text (G-481), because a Windows checkout
 *   may materialise the committed files with CRLF.
 *
 * Usage:
 *   node packages/fredo-theme/scripts/build-theme.mjs            write dist/
 *   node packages/fredo-theme/scripts/build-theme.mjs --check    verify dist/ is current
 *   node packages/fredo-theme/scripts/build-theme.mjs --contract <dir>   read another contract dir
 *   node packages/fredo-theme/scripts/build-theme.mjs --help
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const DEFAULT_CONTRACT_DIR = path.join(
  REPO_ROOT,
  'apps',
  'ui',
  'src',
  'app',
  'theme',
  'contract',
);
const DIST_DIR = path.join(PACKAGE_ROOT, 'dist');

/** The package's own name — pinned by the package test. */
export const PACKAGE_NAME = '@fredo/theme';

/** The 38 published token names and the 5 alias names, as a design commitment. */
const EXPECTED_TOKEN_COUNT = 38;
const EXPECTED_ALIAS_COUNT = 5;

/**
 * The custom properties the host writes that are NOT part of the published
 * contract (readable in a child document, unpromised). `--font-mono` is the
 * sharp case: the host never writes it (only `PANEL_CSS` reads it with a
 * fallback, `scheme.rs:420`), so naming it as a token would be false at every
 * theme.
 */
const THEME_EXCLUSIONS = Object.freeze([
  { varName: '--footer-bg', reason: 'host chrome; readable but not a published token' },
  { varName: '--gradient-text', reason: 'host chrome; readable but not a published token' },
  { varName: '--gradient-button', reason: 'host chrome; readable but not a published token' },
  { varName: '--node-bg', reason: 'Mission Monitor art; readable but not a published token' },
  { varName: '--node-box-shadow', reason: 'Mission Monitor art; readable but not a published token' },
  { varName: '--edge-gradient', reason: 'Mission Monitor art; readable but not a published token' },
  { varName: '--shadow-dialog', reason: 'host elevation; readable but not a published token' },
  { varName: '--font-family', reason: 'host typography; readable but not a published token' },
  {
    varName: '--font-mono',
    reason:
      'NEVER written by the host — only PANEL_CSS reads it with a fallback (scheme.rs:420); ' +
      'naming it as a token would be false at every theme',
  },
]);

/* ==========================================================================
 * Reading the contract's data literals out of its TypeScript source.
 * ========================================================================== */

/**
 * Find `export const <name>` … `=` … `<literal>` and return the literal's text.
 *
 * Scans with awareness of strings and comments so a bracket inside a comment or
 * a template string cannot end the literal early, and REFUSES to guess: a
 * missing anchor, a missing `=`, a literal that does not open with `[`/`{`, an
 * unterminated string, an unbalanced bracket or trailing non-`;` source is a
 * thrown error.
 *
 * @param {string} source
 * @param {string} anchor e.g. `export const SEMANTIC_TOKENS`
 * @param {string} fileForErrors
 * @returns {{ literal: string, valueText: string }}
 */
function extractDataLiteral(source, anchor, fileForErrors) {
  const at = source.indexOf(anchor);
  if (at < 0) {
    throw new Error(`${fileForErrors}: anchor "${anchor}" not found`);
  }
  // Skip the TYPE ANNOTATION (`: readonly SemanticToken[]`, `: { … }`) to the
  // assignment: the first `=` at bracket depth 0 after the anchor. Tracking
  // `{`, `(`, `[` is enough — neither contract file carries an `=` inside a
  // type annotation that is not already bracketed.
  let i = at + anchor.length;
  let annotationDepth = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '{' || ch === '(' || ch === '[') annotationDepth += 1;
    else if (ch === '}' || ch === ')' || ch === ']') annotationDepth -= 1;
    else if (ch === '=' && annotationDepth === 0) break;
    else if (ch === ';' && annotationDepth === 0) {
      throw new Error(`${fileForErrors}: no assignment before the ";" after "${anchor}"`);
    }
    if (annotationDepth < 0) {
      throw new Error(`${fileForErrors}: unbalanced annotation after "${anchor}"`);
    }
    i += 1;
  }
  if (i >= source.length) {
    throw new Error(`${fileForErrors}: "${anchor}" has no value`);
  }
  i += 1; // past '='
  while (i < source.length && /\s/.test(source[i])) i += 1;
  const open = source[i];
  if (open !== '[' && open !== '{') {
    throw new Error(
      `${fileForErrors}: "${anchor}" value must open with "[" or "{" (found "${open}")`,
    );
  }
  const close = open === '[' ? ']' : '}';
  const start = i;
  let depth = 0;
  let mode = 'code';
  let quote = '';

  for (; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (mode === 'line-comment') {
      if (ch === '\n') mode = 'code';
      continue;
    }
    if (mode === 'block-comment') {
      if (ch === '*' && next === '/') {
        mode = 'code';
        i += 1;
      }
      continue;
    }
    if (mode === 'string' || mode === 'template') {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) mode = 'code';
      continue;
    }

    if (ch === '/' && next === '/') {
      mode = 'line-comment';
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      mode = 'block-comment';
      i += 1;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      quote = ch;
      mode = ch === '`' ? 'template' : 'string';
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        const literal = source.slice(start, i + 1);
        const rest = source.slice(i + 1);
        const trailing = rest.split('\n')[0].trim();
        if (trailing !== '' && trailing !== ';' && !trailing.startsWith(';')) {
          throw new Error(
            `${fileForErrors}: unexpected text after the "${anchor}" literal: "${trailing}"`,
          );
        }
        return { literal, valueText: literal };
      }
    }
  }

  throw new Error(`${fileForErrors}: unterminated ${open}${close} literal for "${anchor}"`);
}

/** Evaluate a pure data literal, with `DERIVATIONS` visible as a binding. */
function evaluateLiteral(literal, derivations, what) {
  let factory;
  try {
    // eslint-disable-next-line no-new-func -- a pure repo-side data literal, see the header.
    factory = new Function('DERIVATIONS', `"use strict";\nreturn (${literal});\n`);
  } catch (error) {
    throw new Error(`${what}: the literal is not valid JavaScript data: ${error.message}`);
  }
  return factory(derivations);
}

/**
 * Read the shipped contract and return its two data exports.
 *
 * @param {string} contractDir
 * @returns {{ derivations: object, tokens: object[] }}
 */
export function readContract(contractDir = DEFAULT_CONTRACT_DIR) {
  const surfacesPath = path.join(contractDir, 'surfaces.ts');
  const tokensPath = path.join(contractDir, 'tokens.ts');

  const surfacesSource = readFileSync(surfacesPath, 'utf8');
  const tokensSource = readFileSync(tokensPath, 'utf8');

  const derivationsLiteral = extractDataLiteral(
    surfacesSource,
    'export const DERIVATIONS',
    'contract/surfaces.ts',
  );
  const derivations = evaluateLiteral(
    derivationsLiteral.valueText,
    undefined,
    'contract/surfaces.ts DERIVATIONS',
  );
  if (typeof derivations !== 'object' || derivations === null || Array.isArray(derivations)) {
    throw new Error('contract/surfaces.ts: DERIVATIONS must be an object');
  }
  for (const key of ['accentStrong', 'textSubtle', 'hoverBgPct']) {
    if (!(key in derivations)) {
      throw new Error(`contract/surfaces.ts: DERIVATIONS is missing "${key}"`);
    }
  }

  const tokensLiteral = extractDataLiteral(
    tokensSource,
    'export const SEMANTIC_TOKENS',
    'contract/tokens.ts',
  );
  const tokens = evaluateLiteral(
    tokensLiteral.valueText,
    derivations,
    'contract/tokens.ts SEMANTIC_TOKENS',
  );
  if (!Array.isArray(tokens)) {
    throw new Error('contract/tokens.ts: SEMANTIC_TOKENS must be an array');
  }

  assertContractShape(tokens);
  return { derivations, tokens };
}

/** Fail closed unless the parsed literal really is the contract's shape. */
function assertContractShape(tokens) {
  if (tokens.length !== EXPECTED_TOKEN_COUNT) {
    throw new Error(
      `contract/tokens.ts: expected ${EXPECTED_TOKEN_COUNT} semantic tokens, found ${tokens.length}. ` +
        'A change to the published token set is a contract change: update this generator and ' +
        'the package test in the same commit.',
    );
  }
  const seen = new Set();
  for (const [index, token] of tokens.entries()) {
    if (typeof token !== 'object' || token === null || Array.isArray(token)) {
      throw new Error(`contract/tokens.ts: SEMANTIC_TOKENS[${index}] is not an object`);
    }
    if (typeof token.name !== 'string' || !/^[a-zA-Z]+\.[a-zA-Z]+$/.test(token.name)) {
      throw new Error(`contract/tokens.ts: SEMANTIC_TOKENS[${index}].name is not a dotted name`);
    }
    if (seen.has(token.name)) {
      throw new Error(`contract/tokens.ts: duplicate token name "${token.name}"`);
    }
    seen.add(token.name);
    if (typeof token.varName !== 'string' || !/^--[a-z0-9-]+$/.test(token.varName)) {
      throw new Error(`contract/tokens.ts: ${token.name}.varName is not a custom property`);
    }
    if (typeof token.authored !== 'boolean') {
      throw new Error(`contract/tokens.ts: ${token.name}.authored must be a boolean`);
    }
    if (token.authored && token.derivation !== undefined) {
      throw new Error(`contract/tokens.ts: authored token ${token.name} carries a derivation`);
    }
    if (!token.authored && (token.derivation === undefined || token.derivation === null)) {
      throw new Error(`contract/tokens.ts: derived token ${token.name} has no derivation`);
    }
  }
}

/* ==========================================================================
 * Projection: the contract → the published token set.
 * ========================================================================== */

/**
 * The `color-mix()` expression for a derivation — BYTE-IDENTICAL to
 * `app/theme/system.ts`'s `colorMixExpression` (`system.ts:42-50`), because a
 * package that composed the mix differently would publish a different name.
 *
 * @param {{ derivations: any }} contract
 * @param {any} derivation
 */
function colorMixExpression(derivation) {
  const stops = derivation.sources.map((source, index) => {
    const weight = derivation.weights?.[index];
    return weight === undefined ? `var(${source})` : `var(${source}) ${Math.round(weight * 100)}%`;
  });
  if (stops.length === 1) stops.push('transparent');
  return `color-mix(in srgb, ${stops.join(', ')})`;
}

/**
 * Project the contract's tokens into the published set.
 *
 * Class legend (UI/UX §1):
 *   A — authored by a theme record; `value` is `var(--x)`.
 *   D — derived by the host engine into its own var; `value` is `var(--x)`.
 *   N — NAME-ONLY alias: no own var, published as the `color-mix()` expression.
 *
 * @param {object[]} tokens
 */
export function projectTokens(tokens) {
  const authoredVars = new Set(tokens.filter((token) => token.authored).map((t) => t.varName));

  return tokens.map((token) => {
    const isAlias =
      !token.authored &&
      token.derivation?.fn === 'color-mix' &&
      authoredVars.has(token.varName);
    const className = isAlias ? 'N' : token.authored ? 'A' : 'D';
    const value = isAlias ? colorMixExpression(token.derivation) : `var(${token.varName})`;
    const projected = {
      name: token.name,
      varName: token.varName,
      class: className,
      authored: token.authored,
      value,
    };
    if (token.derivation !== undefined) {
      projected.derivation = {
        fn: token.derivation.fn,
        sources: [...token.derivation.sources],
        ...(token.derivation.weights === undefined
          ? {}
          : { weights: [...token.derivation.weights] }),
      };
    }
    return projected;
  });
}

/* ==========================================================================
 * Emission.
 * ========================================================================== */

const SCOPE_NOTE =
  'A NAME contract, not a value source: the host writes every token value onto your ' +
  'document\u2019s documentElement, and this package only names those values. Every ' +
  'entry\u2019s `value` is a var() reference or a color-mix() whose operands are var()s — ' +
  'the package contains no colour literal and cannot become a second source of colour.';

/** The five alias custom properties published by `theme.css` / `THEME_STYLESHEET`. */
function aliasPropertyName(tokenName) {
  return `--fredo-alias-${tokenName.toLowerCase().replace(/\./g, '-')}`;
}

/** @param {object[]} projected */
function buildTokensJson(projected) {
  const aliases = projected.filter((token) => token.class === 'N');
  return {
    schemaVersion: 1,
    package: PACKAGE_NAME,
    scope: SCOPE_NOTE,
    counts: {
      tokens: projected.length,
      varCarrying: projected.length - aliases.length,
      aliases: aliases.length,
    },
    exclusions: THEME_EXCLUSIONS.map((entry) => ({ ...entry })),
    tokens: projected,
  };
}

/** @param {object[]} projected */
function buildStylesheet(projected) {
  const aliases = projected.filter((token) => token.class === 'N');
  const lines = [];
  lines.push('/*');
  lines.push(' * @fredo/theme — generated. Do not edit by hand:');
  lines.push(' *   node packages/fredo-theme/scripts/build-theme.mjs');
  lines.push(' *');
  lines.push(' * The host writes every token VALUE into your document\u2019s documentElement before');
  lines.push(' * your code runs, so this stylesheet never supplies a colour. It (1) declares the');
  lines.push(' * five published alias NAMES as custom properties computed from the host\u2019s own');
  lines.push(' * vars, and (2) offers the zero-colour panel recipe built only from published');
  lines.push(' * token names. Including it is an ergonomic choice, never a source of values.');
  lines.push(' *');
  lines.push(' * Do NOT redefine a published token on :root or body: the host pushes a resolved');
  lines.push(' * token stream, so redefining one leaves its derived neighbours stale.');
  lines.push(' */');
  lines.push('');
  lines.push(':root {');
  for (const token of aliases) {
    lines.push(`  ${aliasPropertyName(token.name)}: ${token.value};`);
  }
  lines.push('}');
  lines.push('');
  lines.push('/* The zero-colour panel recipe (UI/UX §1) — published token names only. */');
  lines.push('.fredo-theme-panel {');
  lines.push('  background: var(--body-bg);');
  lines.push('  color: var(--text-primary);');
  lines.push('}');
  lines.push('.fredo-theme-panel__surface {');
  lines.push('  background: var(--card-bg);');
  lines.push('  border: 1px solid var(--border-strong);');
  lines.push('}');
  lines.push('.fredo-theme-panel__text {');
  lines.push('  color: var(--text-primary);');
  lines.push('}');
  lines.push('.fredo-theme-panel__muted {');
  lines.push('  color: var(--text-secondary);');
  lines.push('}');
  lines.push('.fredo-theme-panel__focus:focus-visible {');
  lines.push('  outline: 2px solid var(--accent-strong);');
  lines.push('  outline-offset: 2px;');
  lines.push('}');
  lines.push('.fredo-theme-panel__accent {');
  lines.push('  background: var(--accent-primary);');
  lines.push('  color: var(--accent-contrast);');
  lines.push('}');
  lines.push('.fredo-theme-panel__tint {');
  lines.push(`  background: var(${aliasPropertyName('accent.subtle')});`);
  lines.push('}');
  lines.push('.fredo-theme-panel__disabled {');
  lines.push('  color: var(--text-subtle);');
  lines.push('  border-color: var(--border-color);');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

/** @param {object[]} projected */
function buildIndexMjs(projected, stylesheet) {
  const tokensJson = JSON.stringify(projected, null, 2);
  const exclusionsJson = JSON.stringify(THEME_EXCLUSIONS, null, 2);
  return `/**
 * ${PACKAGE_NAME} — generated. Do not edit by hand:
 *   node packages/fredo-theme/scripts/build-theme.mjs
 *
 * ${SCOPE_NOTE.replace(/\u2019/g, "'")}
 *
 * The consumption route is VENDORING: copy this file (and \`theme.css\`) into your
 * package as \`vendor/fredo-theme/\`, then import the vendored file
 * \`vendor/fredo-theme/index.mjs\` RELATIVELY from your own module. A bare
 * \`${PACKAGE_NAME}\` specifier never resolves in an installed application's document —
 * there is no bundler and no import map — and the host's serve whitelist is the
 * install record, so a file outside the package has no route.
 */

/** The ${projected.length} published token names, in contract order. */
export const SEMANTIC_TOKENS = Object.freeze(${tokensJson});

/** The same tokens, keyed by published name. */
export const tokensByName = Object.freeze(
  Object.fromEntries(SEMANTIC_TOKENS.map((token) => [token.name, token])),
);

/** The readable-but-unpublished custom properties — a promise of privacy. */
export const THEME_EXCLUSIONS = Object.freeze(${exclusionsJson});

/** The generated stylesheet (the same text as \`theme.css\`). */
export const THEME_STYLESHEET = ${JSON.stringify(stylesheet)};

/** Every published name. */
export const TOKEN_NAMES = Object.freeze(SEMANTIC_TOKENS.map((token) => token.name));

/**
 * Resolve a published token to the CSS form you should write.
 *
 * - a published NAME ('bg.surface') → \`var(--card-bg)\`, or — for one of the five
 *   NAME-ONLY aliases (\`accent.subtle\`, \`accent.muted\`, \`accent.tint\`,
 *   \`status.errorTint\`, \`status.errorStrong\`) — the published \`color-mix()\`
 *   expression, never a bare \`var()\`;
 * - a custom property ('--card-bg') → \`var(--card-bg)\`, so a host-written var that
 *   is not one of the published names still composes.
 *
 * An unknown name THROWS: silently returning something for a typo is how an
 * author ships a colour the contract never promised.
 *
 * @param {string} name a published token name, or a \`--custom-property\`
 * @returns {string}
 */
export function cssVar(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('cssVar(name) needs a token name such as "bg.surface" or a var such as "--card-bg"');
  }
  if (name.startsWith('--')) {
    return \`var(\${name})\`;
  }
  const token = tokensByName[name];
  if (token === undefined) {
    throw new RangeError(
      \`"\${name}" is not one of the published theme tokens. The published names are: \` +
        TOKEN_NAMES.join(', ') +
        ' — see tokens.json for the full contract.',
    );
  }
  return token.value;
}
`;
}

/** @param {object[]} projected */
function buildIndexDts(projected) {
  const names = projected.map((token) => `  | '${token.name}'`).join('\n');
  return `/**
 * ${PACKAGE_NAME} — generated type surface. Do not edit by hand:
 *   node packages/fredo-theme/scripts/build-theme.mjs
 *
 * ${SCOPE_NOTE.replace(/\u2019/g, "'")}
 */

/** A CSS custom property name, e.g. \`--card-bg\`. */
export type CssVarName = \`--\${string}\`;

/** The class of a published token (UI/UX §1). */
export type ThemeTokenClass =
  | 'A' // authored by a theme record
  | 'D' // derived by the host engine into its own var
  | 'N'; // NAME-ONLY alias: no own var, published as a color-mix() expression

/** Every published token name. */
export type ThemeTokenName =
${names};

/** The derivation function a derived token resolves through. */
export type ThemeDerivationFn = 'color-mix' | 'wcag-max-contrast' | 'alpha-composite' | 'literal';

/** The single home for a derived token's rule (weights mirror the contract). */
export interface ThemeTokenDerivation {
  readonly fn: ThemeDerivationFn;
  readonly sources: readonly CssVarName[];
  readonly weights?: readonly number[];
}

/** One published token. */
export interface ThemeToken {
  readonly name: ThemeTokenName;
  readonly varName: CssVarName;
  readonly class: ThemeTokenClass;
  readonly authored: boolean;
  /** A \`var(--…)\` reference, or a \`color-mix()\` over \`var()\`s for a class-N alias. */
  readonly value: string;
  readonly derivation?: ThemeTokenDerivation;
}

/** One readable-but-unpublished custom property. */
export interface ThemeExclusion {
  readonly varName: CssVarName;
  readonly reason: string;
}

/** The ${projected.length} published tokens, in contract order. */
export declare const SEMANTIC_TOKENS: readonly ThemeToken[];

/** The same tokens, keyed by published name. */
export declare const tokensByName: Readonly<Record<ThemeTokenName, ThemeToken>>;

/** Every published name, in contract order. */
export declare const TOKEN_NAMES: readonly ThemeTokenName[];

/** The readable-but-unpublished custom properties — a promise of privacy. */
export declare const THEME_EXCLUSIONS: readonly ThemeExclusion[];

/** The generated stylesheet (the same text as \`theme.css\`). */
export declare const THEME_STYLESHEET: string;

/**
 * Resolve a published token name (or a \`--custom-property\`) to the CSS form to
 * write. Throws for an unknown token name.
 */
export declare function cssVar(name: ThemeTokenName | CssVarName | (string & {})): string;
`;
}

/* ==========================================================================
 * Driver.
 * ========================================================================== */

/** LF-normalise for comparison (G-481): a Windows checkout may hold CRLF. */
function normalise(text) {
  return text.replace(/\r\n/g, '\n');
}

/**
 * Build the four artifacts in memory.
 * @param {string} contractDir
 * @returns {{ file: string, content: string }[]}
 */
export function buildArtifacts(contractDir = DEFAULT_CONTRACT_DIR) {
  const { tokens } = readContract(contractDir);
  const projected = projectTokens(tokens);
  const aliases = projected.filter((token) => token.class === 'N');
  if (aliases.length !== EXPECTED_ALIAS_COUNT) {
    throw new Error(
      `expected exactly ${EXPECTED_ALIAS_COUNT} name-only aliases, found ${aliases.length}: ` +
        aliases.map((token) => token.name).join(', '),
    );
  }
  const tokensJson = buildTokensJson(projected);
  const stylesheet = buildStylesheet(projected);
  return [
    { file: 'index.mjs', content: buildIndexMjs(projected, stylesheet) },
    { file: 'index.d.ts', content: buildIndexDts(projected) },
    { file: 'theme.css', content: stylesheet },
    { file: 'tokens.json', content: JSON.stringify(tokensJson, null, 2) + '\n' },
  ];
}

const HELP = `build-theme.mjs — generate ${PACKAGE_NAME}'s dist/ from the shipped token contract.

Usage:
  node packages/fredo-theme/scripts/build-theme.mjs [options]

Options:
  --check              regenerate in memory and verify the committed dist/ is current
                       (exit 1 on any drift); writes nothing
  --contract <dir>     read the token contract from <dir> instead of
                       apps/ui/src/app/theme/contract
  --help               this text

The drift gate is --check: it is the only verifier, and nothing regenerates dist/
implicitly. Compare with an LF-normalised read (G-481).`;

function parseArgs(argv) {
  const options = { check: false, help: false, contractDir: DEFAULT_CONTRACT_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--contract') {
      const value = argv[++index];
      if (!value) throw new Error('--contract needs a directory');
      options.contractDir = path.resolve(process.cwd(), value);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(HELP);
    return;
  }

  let artifacts;
  try {
    artifacts = buildArtifacts(options.contractDir);
  } catch (error) {
    console.error(`GENERATE FAILED: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  if (options.check) {
    const drifted = [];
    for (const artifact of artifacts) {
      const target = path.join(DIST_DIR, artifact.file);
      let committed;
      try {
        committed = readFileSync(target, 'utf8');
      } catch {
        drifted.push(`${artifact.file} (missing)`);
        continue;
      }
      if (normalise(committed) !== normalise(artifact.content)) {
        drifted.push(`${artifact.file} (differs)`);
      }
    }
    if (drifted.length > 0) {
      console.error(`DRIFT: the committed dist/ is stale — ${drifted.join(', ')}`);
      console.error('Regenerate with: node packages/fredo-theme/scripts/build-theme.mjs');
      process.exitCode = 1;
      return;
    }
    console.log(`DRIFT OK: ${artifacts.length} artifacts match the contract at ${options.contractDir}`);
    return;
  }

  mkdirSync(DIST_DIR, { recursive: true });
  for (const artifact of artifacts) {
    const target = path.join(DIST_DIR, artifact.file);
    let current = null;
    try {
      current = readFileSync(target, 'utf8');
    } catch {
      current = null;
    }
    if (current !== null && normalise(current) === normalise(artifact.content)) {
      console.log(`unchanged ${artifact.file}`);
      continue;
    }
    writeFileSync(target, artifact.content, 'utf8');
    console.log(`wrote     ${artifact.file}`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main();
}
