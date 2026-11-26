/**
 * `@fredo/authoring` — the ONE specifier predicate (Spec #3145, ST-2 item 4).
 *
 * The S6 documented step ("confirm the package is self-contained") asks whether
 * every module specifier in an application is a RELATIVE path that resolves to a
 * file the package carries, and whether the package imports any host-internal
 * shape. This module is that check, and it is the single place the rule lives:
 * the exam runner re-implements the SAME rule independently (F-8.3 requires an
 * independent re-run) and asserts the two agree.
 *
 * A COMMENT IS NOT CODE.
 *   The extractor is comment/string-aware: a specifier-shaped token inside a
 *   line comment or a slash-star block comment is prose, never an import. Spec
 *   #3145 round 1 failed on exactly this — the generated theme header carried a
 *   quoted import-from EXAMPLE inside its block comment, and a line-comment-only
 *   stripper read it as a real import, resolving it relative to the comment's own
 *   file and reporting a missing file. Block comments are stripped here too.
 *   Strings are PRESERVED (a specifier IS a string literal), and the scanner knows
 *   when it is inside one, so a comment opener inside a string is not a comment.
 *
 * Node built-ins only (NFR-3).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** The file extensions the specifier scan reads. */
export const SCANNABLE_EXTENSIONS = Object.freeze(['.mjs', '.cjs', '.js', '.ts', '.tsx', '.jsx']);

/** Host-internal shapes an author must never import (F-8.3 / F-8.14). */
export const HOST_INTERNAL_TOKENS = Object.freeze([
  '@/',
  'apps/ui',
  'FredoApplicationClass',
  'registerApplication',
]);

/** The three problem kinds this predicate emits (never a 23rd refusal code). */
export const SPECIFIER_PROBLEM_KINDS = Object.freeze([
  'specifier_not_relative',
  'specifier_unresolved',
  'specifier_host_internal',
]);

/**
 * Blank every COMMENT in `source`, preserving character positions and newlines,
 * so the specifier regexes run over code only. Strings, template literals and
 * regex literals are skipped as opaque so a `//` or `/*` inside one cannot open a
 * comment.
 *
 * @param {string} source
 * @returns {string} the same text with comments replaced by spaces
 */
export function maskComments(source) {
  const chars = source.split('');
  const blank = (start, end) => {
    for (let index = start; index < end; index += 1) {
      if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
    }
  };

  const regexAllowedAfter = new Set([
    '',
    '(',
    ',',
    '=',
    ':',
    '[',
    '!',
    '&',
    '|',
    '?',
    '{',
    '}',
    ';',
    '+',
    '-',
    '*',
    '%',
    '<',
    '>',
    '~',
    '^',
  ]);

  const length = source.length;
  let index = 0;
  let previous = '';
  while (index < length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === '/' && next === '/') {
      const start = index;
      index += 2;
      while (index < length && source[index] !== '\n') index += 1;
      blank(start, index);
      continue;
    }
    if (char === '/' && next === '*') {
      const start = index;
      index += 2;
      while (index < length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index = Math.min(length, index + 2);
      blank(start, index);
      continue;
    }
    if (char === '"' || char === "'") {
      index += 1;
      while (index < length && source[index] !== char) {
        if (source[index] === '\\') index += 1;
        index += 1;
      }
      index += 1;
      previous = char;
      continue;
    }
    if (char === '`') {
      index += 1;
      while (index < length && source[index] !== '`') {
        if (source[index] === '\\') index += 1;
        index += 1;
      }
      index += 1;
      previous = '`';
      continue;
    }
    if (char === '/' && regexAllowedAfter.has(previous)) {
      // A regex literal: skip to its unescaped closing '/', honouring a class.
      index += 1;
      let inClass = false;
      while (index < length) {
        const inner = source[index];
        if (inner === '\\') {
          index += 1;
        } else if (inner === '[') {
          inClass = true;
        } else if (inner === ']') {
          inClass = false;
        } else if (inner === '/' && !inClass) {
          break;
        } else if (inner === '\n') {
          break; // unterminated: bail out rather than swallow real code
        }
        index += 1;
      }
      index += 1;
      previous = '/';
      continue;
    }
    if (!/\s/.test(char)) previous = char;
    index += 1;
  }
  return chars.join('');
}

const SPECIFIER_PATTERNS = [
  /(?:^|[^.\w$])(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/**
 * Extract every module specifier from JS/TS source, ignoring comments.
 * @param {string} source
 * @returns {string[]}
 */
export function extractSpecifiers(source) {
  const text = maskComments(source);
  const found = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    let match;
    while ((match = pattern.exec(text)) !== null) found.push(match[1]);
  }
  return found;
}

/** Every scannable source file under `directory`, as sorted POSIX-relative paths. */
export function listScannableFiles(directory) {
  const root = path.resolve(directory);
  const found = [];
  const visit = (absolute, relative) => {
    const entries = readdirSync(absolute, { withFileTypes: true })
      .slice()
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue;
      const childAbsolute = path.join(absolute, entry.name);
      const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        visit(childAbsolute, childRelative);
      } else if (entry.isFile() && SCANNABLE_EXTENSIONS.includes(path.extname(entry.name))) {
        found.push(childRelative);
      }
    }
  };
  visit(root, '');
  return found;
}

function isFile(target) {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * Scan a package for specifier problems — the `check --specifiers` body.
 *
 * @param {string} directory the package root
 * @returns {{ ok: boolean, imports: string[], problems: { file: string, specifier: string, problem: string }[] }}
 */
export function scanSpecifiers(directory) {
  const root = path.resolve(directory);
  const imports = [];
  const problems = [];

  for (const relative of listScannableFiles(root)) {
    const absolute = path.join(root, relative);
    let source;
    try {
      source = readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }

    for (const token of HOST_INTERNAL_TOKENS) {
      if (source.includes(token)) {
        problems.push({ file: relative, specifier: token, problem: 'specifier_host_internal' });
      }
    }

    for (const specifier of extractSpecifiers(source)) {
      imports.push(`${relative} -> ${specifier}`);
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
        problems.push({ file: relative, specifier, problem: 'specifier_not_relative' });
        continue;
      }
      const target = path.resolve(path.dirname(absolute), specifier);
      const relativeTarget = path.relative(root, target);
      if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
        problems.push({ file: relative, specifier, problem: 'specifier_unresolved' });
        continue;
      }
      if (!isFile(target)) {
        problems.push({ file: relative, specifier, problem: 'specifier_unresolved' });
      }
    }
  }

  return { ok: problems.length === 0, imports, problems };
}
