#!/usr/bin/env node
/**
 * scoped-source-sweep.mjs -- the #3244 committed AC-5 / AC-2b sweep artifact.
 *
 * WHY THIS FILE EXISTS (and why it is a .mjs, not a .ps1)
 * ------------------------------------------------------
 * The plan binds TWO rows to the same negative witness:
 *
 *   - **AC-5 part (ii)** (durable suite `F-7`): the subject is the built-in
 *     `mission-monitor`, and the witness is a source sweep over the
 *     **description+pair path modules only** for that subject id -> ZERO hits.
 *   - **AC-2b** (durable suite `F-4`): the subject is the installed fixture
 *     `qa3244-untaught`, and the witness is that the id appears NOWHERE on the
 *     description+pair path -> ZERO hits.
 *
 * The tester's sandbox allows `bun*` but NOT `powershell -File .opencode/tests/**`,
 * so a `.ps1` here would be unrunnable FOR ITS CONSUMER. This file therefore uses
 * **Node built-ins only** (`node:fs`, `node:path`, `node:os`, `node:url`) and no npm
 * package, so it runs on a bare checkout:
 *
 *     bun .opencode/tests/app-intelligibility/scripts/scoped-source-sweep.mjs
 *
 * `.opencode/**` IS A FALSE NEGATIVE FOR REPO-WIDE GREPS (G-024)
 * -------------------------------------------------------------
 * A repo-wide `rg`/`grep` that excludes dotted directories by default never sees
 * this file, so "the pipeline's grep found nothing" must never be read as "the
 * sweep is missing". The sweep lives here, by design, under `.opencode/tests/`.
 * The same convention is why the plan's SEC-1 evidence allowlist names
 * `.opencode/tests/**` explicitly.
 *
 * THE SCOPING REASON — READ THIS BEFORE WIDENING ANYTHING
 * ------------------------------------------------------
 * The claim is scoped to the **description+pair path only**. It is NOT a claim
 * that Fredo holds no per-app code for any app.
 *
 * `mission-monitor` legitimately carries a hand-written per-app **grounding
 * registrar** at `apps/ui/src/applications/mission-monitor/components/
 * MissionMonitorPanel.tsx:881` (`registerCompanionGrounding('mission-monitor',
 * ...)`). That registrar supplies **selection metadata only** -- no description,
 * no per-turn pair -- so it is **not enablement** and it does not make
 * `mission-monitor` operable without the description+pair path. It lives in
 * `apps/ui/src/applications/**`, which is outside this sweep's scope.
 *
 * An **unscoped** repo-wide grep for `mission-monitor` would therefore red on a
 * legitimate file and prove NOTHING about the path under test. The scope below is
 * the description+pair path, declared once, for exactly that reason:
 *
 *   NEVER WIDEN THE SCOPE TO MAKE THIS SCRIPT GREEN.
 *   NEVER WIDEN IT TO MAKE IT RED EITHER -- if a hit appears inside the declared
 *   scope, that is the finding; do not move the boundary around it.
 *
 * ONE MORE MODULE SITS ON THE PATH AND IS DELIBERATELY OUT OF SCOPE (verified clean)
 * ----------------------------------------------------------------------------------
 * `apps/ui/src/shared/components/companion/CompanionEntity.tsx` is the dispatch SITE:
 * it derives the turn's facts (`screenTurnExtras`, `CompanionEntity.tsx:287`) and
 * passes the `injection` argument. The plan's declared sweep list does not name it,
 * so it is NOT swept here. It was read once by hand while authoring this artifact and
 * contains ZERO occurrences of either subject id -- recorded as an observation, not as
 * a sweep result. If the plan is ever amended to widen the scope, add it to SCOPE
 * above rather than grepping it ad hoc; an unrecorded out-of-scope grep is exactly
 * the kind of "proven by a command nobody can re-run" claim this artifact exists to
 * replace.
 *
 * HIT CLASSES (why "hits" is not one number)
 * ------------------------------------------
 * A subject id can appear on this path in three materially different ways, and the
 * sweep prints ALL of them (nothing is hidden) while grading only one:
 *
 *   product  -- the id appears in CODE (a string literal, a comparison, a table).
 *               This is the subject-id SPECIAL CASE the plan's R-5b forbids. Graded:
 *               it FAILS the sweep.
 *   comment  -- the id appears only inside a line or block COMMENT on that line.
 *               A comment cannot special-case an app.
 *   test     -- the id appears in a `__tests__/` / `*.test.ts(x)` file, or inside a
 *               Rust `#[cfg(test)] mod ...` block. A test naming an app id uses it
 *               as a FIXTURE, not as runtime knowledge Fredo holds.
 *
 * WHY THE GRADED PREDICATE IS `product`, AND WHY `--strict` REDS ON A CORRECT TREE
 * ------------------------------------------------------------------------------
 * The plan defines the hit it forbids (R-5b): "IF any module on the description+pair
 * path contains a subject-id SPECIAL CASE (a `mission-monitor` branch/branch table
 * in the resolver, the projector, the capture seam, the transport...)". A branch has
 * to be CODE. So the graded reading is: no subject-id code special case.
 *
 * This matters because the shipped tree legitimately mentions both subjects, in this
 * exact scope, in ways that are not special cases — the G-431 class of hazard (a
 * guard's own subject spelled in the very artifacts that describe it):
 *
 *   - `shared/app-intelligibility/injection.ts:25` documents the MM confound in a
 *     doc comment (the plan REQUIRES that confound be named, so the comment is
 *     correct, not a defect);
 *   - the unit tests in `shared/app-intelligibility/__tests__/` and the Rust
 *     `#[cfg(test)] mod tests` blocks in `injection.rs` / `beacon.rs` use
 *     `mission-monitor` / `qa3244-untaught` as fixture values.
 *
 * A literally-any-mention sweep therefore CANNOT be green on a correct tree, and a
 * criterion that a correct product cannot satisfy is not a criterion. So the graded
 * predicate is the plan's, and the any-mention reading is kept as `--strict` — a
 * DIAGNOSTIC that is expected to red, which also proves the matcher can see all
 * three classes. Nothing is concealed: every hit is printed either way.
 *
 * The relaxation is principled, not cosmetic (G-509): the compared dimension is the
 * one the product itself uses — the product branches on **ids in code**. A comment
 * and a test are not code the runtime executes. `--self-check` PROVES the matcher can
 * still FAIL: it plants a real product-code special case (reported), a comment-only
 * mention (excluded), a test-only mention (excluded), a product mention placed AFTER
 * a Rust `#[cfg(test)] mod tests` block (reported — the test region ends where its
 * braces end), and it asserts `--strict` counts strictly more than the default.
 *
 * USAGE
 *   bun .opencode/tests/app-intelligibility/scripts/scoped-source-sweep.mjs
 *   bun ... --self-check
 *   bun ... --help
 *   bun ... qa3244-untaught                 (positional subjects replace the defaults)
 *   bun ... --subjects mission-monitor,qa3244-untaught
 *   bun ... --repo-root C:\Code\fredo       (defaults to this file's repo root)
 *   bun ... --strict                        (diagnostic: count comment/test mentions too)
 *
 * EXIT CODES
 *   0  every subject is absent from every module in scope (no subject-id code hit)
 *   1  at least one graded hit (a product-code hit; with --strict, any mention)
 *   2  usage or IO error (a missing scope path is a SCOPE error, never a pass --
 *      an absent input must never coerce to a green reading, G-470)
 *
 * WHAT THIS SWEEP CANNOT SEE (its stated limit -- do not over-read a PASS)
 * ----------------------------------------------------------------------
 * It is a LITERAL sweep. It proves no in-scope module spells the subject id in code.
 * It does NOT prove the absence of a per-app branch built without spelling the id --
 * `'mission' + '-monitor'`, a char-code assembly, a hash prefix, or a registry keyed
 * by something else. Those are not "hits this sweep missed"; they are outside what a
 * source sweep of this shape can decide at all. The complementary runtime half of the
 * witness is part (i) of the row -- `taught:false` / `perAppEntries:0` on the turn's
 * OWN injection span, emitted by the path that actually resolved the app. The row is
 * only satisfied with BOTH; this file alone is one leg, never the whole criterion.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `scripts/` -> `app-intelligibility/` -> `tests/` -> `.opencode/` -> repo root. */
const DEFAULT_REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

/** The two subjects the plan binds: AC-5 (built-in) and AC-2b (installed fixture). */
const DEFAULT_SUBJECTS = ['mission-monitor', 'qa3244-untaught'];

/**
 * The declared scope: the description+pair path, and nothing else.
 *
 * `kind: 'dir'` walks recursively and keeps code files only. `role` is printed in
 * the report so a reader sees WHY each module is in scope (and can judge a
 * boundary, rather than trusting one).
 */
const SCOPE = [
  {
    path: 'apps/ui/src/shared/app-intelligibility',
    kind: 'dir',
    lang: 'ts',
    role:
      'the description+pair path: description.ts (resolver), screenOutline.ts (projector), ' +
      'screenContext.ts (composition), captureTarget.ts (THE HOST CAPTURE SEAM — rect resolution + ' +
      'captureTargetRegion for BOTH the built-in and installed branches), injection.ts (the turn ' +
      'facts / the taught + perAppEntries witness), installedOutline.ts (the installed-tier outline ' +
      'client), measurement.ts (the AC-4 record parser), index.ts (barrel)',
  },
  {
    path: 'apps/ui/src/shared/companion/grounding.ts',
    kind: 'file',
    lang: 'ts',
    role: 'the app-level companion grounding source (the other half of a turn\'s context)',
  },
  {
    path: 'apps/ui/src/shared/components/companion/companionDispatch.ts',
    kind: 'file',
    lang: 'ts',
    role:
      'the turn assembly: buildCompanionTurnMessages + fitScreenContextOutline (the ONE shared ' +
      'path the pair is injected through)',
  },
  {
    path: 'apps/tauri/src-tauri/src/applications/llm_server/status.rs',
    kind: 'file',
    lang: 'rs',
    role: 'the llm_chat_with_status command and its image_base64 media arg',
  },
  {
    path: 'apps/tauri/src-tauri/src/applications/llm_server/skills.rs',
    kind: 'file',
    lang: 'rs',
    role: 'skill_turn — the ONE media shaping rule that carries image_base64 onto the turn',
  },
  {
    path: 'apps/tauri/src-tauri/src/applications/llm_server/injection.rs',
    kind: 'file',
    lang: 'rs',
    role: 'the companion.injection span persistence (the live receipt the rows read back)',
  },
  {
    path: 'apps/tauri/src-tauri/src/applications/installed_apps/beacon.rs',
    kind: 'file',
    lang: 'rs',
    role: 'the beacon ingress transport — the installed-tier outline leg (R-5b names "the transport")',
  },
  {
    path: 'apps/tauri/src-tauri/src/applications/installed_apps/bootstrap.js',
    kind: 'file',
    lang: 'js',
    role: 'the child-side reporter the host evals into an installed document',
  },
  {
    path: 'apps/tauri/src-tauri/src/applications/installed_apps/outline_projector.js',
    kind: 'file',
    lang: 'js',
    role: 'the installed-tier carrier of the SHARED projector (one implementation, two carriers)',
  },
];

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.rs']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'target', 'gen']);

const HELP = `scoped-source-sweep.mjs -- the #3244 committed source sweep (AC-5 part (ii) + AC-2b).

Usage:
  bun .opencode/tests/app-intelligibility/scripts/scoped-source-sweep.mjs [options] [subject ...]

Options:
  --subjects <a,b,...>  subjects to sweep (default: mission-monitor,qa3244-untaught)
  --repo-root <dir>     repo root to resolve the scope from (default: this file's repo root)
  --strict              count EVERY mention, comment/test included. DIAGNOSTIC ONLY: the shipped
                        tree legitimately has both (injection.ts documents the MM confound in prose;
                        the Rust/TS unit tests use the fixture ids as data), so --strict is EXPECTED
                        to red on a correct tree. The graded predicate is the default.
  --json                emit the report as JSON instead of text
  --self-check          prove the matcher is non-vacuous against a temp fixture tree, then clean up
  --help                this text

Scope (the description+pair path ONLY -- never widen it to make the run green):
${SCOPE.map((entry) => '  ' + entry.path).join('\n')}

Hit classes: product (FAILS) | comment (printed) | test (printed).
Exit codes: 0 = clean, 1 = a hit that counts as a failure, 2 = usage/IO error.

LIMIT: this is a LITERAL sweep. A PASS proves no in-scope module spells the subject id in code;
it cannot decide an id assembled at runtime ('mission' + '-monitor'). The row's runtime half
(taught:false / perAppEntries:0 on the turn's own injection span) is the other leg, and the row
is satisfied only with both.

The claim is scoped to the description+pair path: mission-monitor legitimately carries a per-app
GROUNDING registrar at MissionMonitorPanel.tsx:881 (selection metadata, NOT enablement), so an
unscoped repo-wide grep would red on a legitimate file and prove nothing.`;

/* ==========================================================================
 * Option parsing
 * ========================================================================== */

function parseArgs(argv) {
  const options = {
    subjects: [],
    repoRoot: DEFAULT_REPO_ROOT,
    json: false,
    strict: false,
    selfCheck: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--strict') {
      options.strict = true;
    } else if (arg === '--self-check') {
      options.selfCheck = true;
    } else if (arg === '--subjects') {
      const value = argv[++index];
      if (!value) throw new UsageError('--subjects needs a comma-separated list');
      options.subjects.push(...value.split(',').map((item) => item.trim()).filter(Boolean));
    } else if (arg === '--repo-root') {
      const value = argv[++index];
      if (!value) throw new UsageError('--repo-root needs a directory');
      options.repoRoot = path.resolve(process.cwd(), value);
    } else if (arg.startsWith('--')) {
      throw new UsageError('unknown argument: ' + arg);
    } else {
      options.subjects.push(arg);
    }
  }
  if (options.subjects.length === 0) options.subjects = DEFAULT_SUBJECTS.slice();
  return options;
}

class UsageError extends Error {}

/* ==========================================================================
 * Scope resolution
 * ========================================================================== */

function collectFiles(absPath, out) {
  const stat = statSync(absPath);
  if (stat.isFile()) {
    if (CODE_EXTENSIONS.has(path.extname(absPath).toLowerCase())) out.push(absPath);
    return out;
  }
  for (const entry of readdirSync(absPath, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectFiles(path.join(absPath, entry.name), out);
    } else if (entry.isFile()) {
      if (CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        out.push(path.join(absPath, entry.name));
      }
    }
  }
  return out;
}

/**
 * Resolve the declared scope into concrete files. A path that does not exist is a
 * SCOPE error (exit 2) -- an absent input must never read as "zero hits".
 */
function resolveScope(repoRoot) {
  const resolved = [];
  for (const entry of SCOPE) {
    const absPath = path.join(repoRoot, entry.path);
    let stat;
    try {
      stat = statSync(absPath);
    } catch (error) {
      throw new UsageError(
        'scope path is missing: ' + absPath + ' (' + error.code + '). A missing scope path is a ' +
          'scope/IO error, never a clean sweep.'
      );
    }
    const isFile = stat.isFile();
    if (entry.kind === 'dir' && isFile) {
      throw new UsageError('scope path should be a directory but is a file: ' + absPath);
    }
    if (entry.kind === 'file' && !isFile) {
      throw new UsageError('scope path should be a file but is a directory: ' + absPath);
    }
    resolved.push({
      ...entry,
      absPath,
      files: collectFiles(absPath, []).sort(),
    });
  }
  return resolved;
}

/* ==========================================================================
 * The scanner: comment spans, string spans, Rust test ranges
 * ========================================================================== */

/**
 * Scan `text` for comment spans and literal spans.
 *
 * `comments` are the spans a `class: 'comment'` hit may live in; `literals` are
 * strings/chars/raw-strings, which mask a `//` or a `{` so neither can be
 * mistaken for a comment or a brace. Both are returned so `rustTestRanges` can
 * brace-match through test strings (Rust tests are full of JSON literals).
 *
 * Language-specific on purpose — a naive scanner that treats every `'` as a
 * string start corrupts on a Rust lifetime (`&'static str`) and would silently
 * swallow or mis-classify a whole region. Handled per language:
 *
 *   js/ts -- `"` / `'` / `` ` `` with backslash escapes; `//` and `/* *\/`.
 *   rs    -- `"` with escapes, `b"…"`, raw strings `r"…"` / `r#"…"#` / `r##…##`,
 *            char literals `'x'` / `'\n'`, and `//` / NESTED `/* /* *\/ *\/`.
 *            A `'` that is not a char literal is a LIFETIME and is ordinary code.
 */
function scanSpans(text, lang) {
  const comments = [];
  const literals = [];
  const length = text.length;
  let index = 0;

  const lineComment = () => {
    const start = index;
    while (index < length && text[index] !== '\n') index += 1;
    comments.push({ start, end: index, kind: 'line' });
  };
  const blockComment = () => {
    const start = index;
    index += 2;
    if (lang === 'rs') {
      let depth = 1;
      while (index < length && depth > 0) {
        if (text[index] === '/' && text[index + 1] === '*') {
          depth += 1;
          index += 2;
        } else if (text[index] === '*' && text[index + 1] === '/') {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
    } else {
      while (index < length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index = Math.min(length, index + 2);
    }
    comments.push({ start, end: Math.min(index, length), kind: 'block' });
  };
  const quoted = (quote, allowNewline) => {
    const start = index;
    index += 1;
    while (index < length) {
      if (text[index] === '\\') {
        index += 2;
        continue;
      }
      if (text[index] === quote) {
        index += 1;
        break;
      }
      // A JS `'…'` / `"…"` cannot contain a raw newline. Stopping at the newline
      // means a stray apostrophe (JSX text, a contraction in a template) can never
      // swallow the rest of the file into a fake literal and mask a real hit.
      if (!allowNewline && text[index] === '\n') break;
      index += 1;
    }
    literals.push([start, Math.min(index, length)]);
  };
  const rawRustString = () => {
    const start = index;
    let cursor = index + 1;
    let hashes = 0;
    while (text[cursor] === '#') {
      hashes += 1;
      cursor += 1;
    }
    if (text[cursor] !== '"') return false;
    const closer = '"' + '#'.repeat(hashes);
    const end = text.indexOf(closer, cursor + 1);
    index = end < 0 ? length : end + closer.length;
    literals.push([start, index]);
    return true;
  };

  while (index < length) {
    const char = text[index];

    if (char === '/' && text[index + 1] === '/') {
      lineComment();
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      blockComment();
      continue;
    }

    if (lang === 'rs') {
      // `r"…"` / `r#"…"#` (but not an identifier that merely starts with `r`).
      if (char === 'r' && (text[index + 1] === '"' || text[index + 1] === '#')) {
        const previous = index === 0 ? '' : text[index - 1];
        if (!/[A-Za-z0-9_]/.test(previous) && rawRustString()) continue;
      }
      // `b"…"` / `b'x'`.
      if (char === 'b' && (text[index + 1] === '"' || text[index + 1] === "'")) {
        index += 1;
        if (text[index] === '"') quoted('"', true);
        else charLiteral();
        continue;
      }
      if (char === '"') {
        quoted('"', true);
        continue;
      }
      if (char === "'") {
        charLiteral();
        continue;
      }
      index += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      // A template literal may span lines; `'`/`"` may not.
      quoted(char, char === '`');
      continue;
    }
    index += 1;
  }

  /**
   * A Rust `'…'`. A char literal is `'\x'` / `'\u{..}'` or `'x'`; anything else (a
   * lifetime such as `&'static str` or `'_`) is ordinary code and consumes nothing.
   * A mis-parse here can only over- or under-mask a LITERAL — it never classifies a
   * hit as `comment` or `test`, so a mistake cannot excuse a product hit.
   */
  function charLiteral() {
    if (text[index] !== "'") return;
    if (text[index + 1] === '\\') {
      const start = index;
      let cursor = index + 3; // `\` + the escaped character
      while (cursor < length && text[cursor] !== "'") {
        if (text[cursor] === '\n') break; // an unterminated candidate: leave as code
        cursor += 1;
      }
      if (cursor >= length || text[cursor] !== "'") {
        index += 1;
        return;
      }
      index = cursor + 1;
      literals.push([start, Math.min(index, length)]);
      return;
    }
    if (text[index + 2] === "'" && text[index + 1] !== "'") {
      const start = index;
      index += 3;
      literals.push([start, Math.min(index, length)]);
      return;
    }
    // A lifetime (or an unterminated quote): leave it as code.
    index += 1;
  }

  return { comments, literals };
}

function inRanges(offset, ranges) {
  for (const [start, end] of ranges) {
    if (offset >= start && offset < end) return true;
  }
  return false;
}

/** Is `offset` inside a comment? Returns the comment's `kind` (`line`/`block`) or null. */
function commentKindAt(offset, comments) {
  for (const comment of comments) {
    if (offset >= comment.start && offset < comment.end) return comment.kind;
  }
  return null;
}

/**
 * The `#[cfg(test)] mod ... { ... }` ranges of a Rust file.
 *
 * A `#[cfg(test)]` attribute also decorates `fn`, `use` and `const` items, so the
 * marker alone is NOT evidence of a test module. The attribute must be followed
 * (whitespace / other `#[...]` attributes aside) by `mod`; otherwise the marker is
 * skipped and NO range is created — fail-closed, so an unrecognised shape leaves the
 * hit classed `product` rather than excusing it.
 *
 * Brace matching SKIPS comments and literals (via `scanSpans`), so a brace inside a
 * test string cannot unbalance the range. If the closing brace cannot be found, no
 * range is created (again fail-closed).
 */
function rustTestRanges(text, spans) {
  const ranges = [];
  const marker = /#\[cfg\(test\)\]/g;
  let match;
  while ((match = marker.exec(text)) !== null) {
    let cursor = match.index + match[0].length;
    // Skip whitespace and any further attribute groups before the item keyword.
    for (;;) {
      while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
      if (text[cursor] === '#' && text[cursor + 1] === '[') {
        let depth = 0;
        while (cursor < text.length) {
          if (text[cursor] === '[') depth += 1;
          else if (text[cursor] === ']') {
            depth -= 1;
            if (depth === 0) {
              cursor += 1;
              break;
            }
          }
          cursor += 1;
        }
        continue;
      }
      break;
    }
    // Requirement: the decorated item is a module (word-boundary, so `module`
    // or `model` never matches).
    if (text.slice(cursor, cursor + 3) !== 'mod') continue;
    if (/[A-Za-z0-9_]/.test(text[cursor + 3] || '')) continue;
    const brace = text.indexOf('{', cursor);
    if (brace < 0) continue;
    const end = matchBrace(text, brace, spans);
    if (end < 0) continue;
    ranges.push([match.index, end + 1]);
    marker.lastIndex = end;
  }
  return ranges;
}

function matchBrace(text, openIndex, spans) {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    if (commentKindAt(index, spans.comments) !== null) continue;
    if (inRanges(index, spans.literals)) continue;
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function lineStartOffsets(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function locate(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, lineStart: starts[low] };
}

function isTestPath(relPath) {
  const normalized = relPath.replace(/\\/g, '/');
  if (normalized.includes('/__tests__/') || normalized.includes('/__mocks__/')) return true;
  return /\.(test|spec)\.[a-z]+$/i.test(normalized);
}

/**
 * Find every occurrence of `subject` in `text` and classify it.
 *
 * Matching is CASE-INSENSITIVE on purpose: detection is deliberately MORE
 * sensitive than the product's exact string compare, because a missed hit is the
 * expensive error. The classification then says whether the hit could possibly be
 * an enablement branch.
 *
 * The search runs over the ORIGINAL text via a `gi` regex, not over a lowercased
 * copy: `String.prototype.toLowerCase()` does not preserve length for every code
 * point (`'İ'` lowercases to two chars), so offsets taken from a lowercased copy can
 * drift and report a neighbouring line. `match.index` on the original string cannot.
 */
function scanSubject(text, subject, lang, relPath) {
  const spans = scanSpans(text, lang);
  const testRanges = lang === 'rs' ? rustTestRanges(text, spans) : [];
  const pathIsTest = isTestPath(relPath);
  const starts = lineStartOffsets(text);
  const pattern = new RegExp(subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const hits = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const offset = match.index;
    if (match[0].length === 0) {
      pattern.lastIndex += 1;
      continue;
    }
    const { line, lineStart } = locate(starts, offset);
    const lineEndRaw = text.indexOf('\n', lineStart);
    const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw;
    let hitClass = 'product';
    if (pathIsTest || inRanges(offset, testRanges)) hitClass = 'test';
    else {
      const kind = commentKindAt(offset, spans.comments);
      if (kind !== null) hitClass = 'comment';
    }
    hits.push({
      file: relPath.replace(/\\/g, '/'),
      line,
      column: offset - lineStart + 1,
      text: text.slice(lineStart, lineEnd).trim(),
      class: hitClass,
    });
  }
  return hits;
}

/* ==========================================================================
 * The sweep
 * ========================================================================== */

function sweepRoots(subjects, roots, repoRoot) {
  const results = [];
  for (const subject of subjects) {
    const modules = [];
    for (const root of roots) {
      const hits = [];
      let files = 0;
      for (const absFile of root.files) {
        let text;
        try {
          text = readFileSync(absFile, 'utf8');
        } catch (error) {
          throw new UsageError('could not read ' + absFile + ': ' + error.message);
        }
        files += 1;
        const relPath = path.relative(repoRoot, absFile);
        hits.push(...scanSubject(text, subject, root.lang, relPath));
      }
      const product = hits.filter((hit) => hit.class === 'product');
      modules.push({
        path: root.path,
        kind: root.kind,
        role: root.role,
        files,
        hits,
        counts: {
          product: product.length,
          comment: hits.filter((hit) => hit.class === 'comment').length,
          test: hits.filter((hit) => hit.class === 'test').length,
        },
      });
    }
    results.push({
      subject,
      modules,
      productHits: modules.reduce((total, module) => total + module.counts.product, 0),
      allHits: modules.reduce((total, module) => total + module.hits.length, 0),
    });
  }
  return results;
}

/* ==========================================================================
 * Reporting
 * ========================================================================== */

function report(results, repoRoot, strict) {
  const subjects = results.length;
  const modules = results.length === 0 ? 0 : results[0].modules.length;
  const totalProduct = results.reduce((total, result) => total + result.productHits, 0);
  const totalAll = results.reduce((total, result) => total + result.allHits, 0);
  const counted = strict ? totalAll : totalProduct;
  const totalFiles = results.length === 0 ? 0 : results[0].modules.reduce((n, m) => n + m.files, 0);
  const verdict = counted === 0 ? 'PASS' : 'FAIL';

  // Per-file rollup so a reader can see WHICH file carries a non-graded mention
  // without scanning every line of a long report.
  const nonGraded = [];
  for (const result of results) {
    for (const module of result.modules) {
      for (const hit of module.hits) {
        if (hit.class !== 'product') {
          nonGraded.push(hit.class + ' ' + hit.file + ':' + hit.line);
        }
      }
    }
  }

  const lines = [];
  lines.push('Scoped source sweep — Spec #3244 (AC-5 part (ii) / AC-2b)');
  lines.push('repo root: ' + repoRoot + '   (resolved from ' + HERE + ')');
  lines.push(
    'scope: ' + modules + ' module root(s) -> ' + totalFiles + ' code file(s); ' +
      'subjects=' + subjects + ' (' + results.map((r) => r.subject).join(', ') + ')'
  );
  lines.push(
    'predicate: ' + (strict
      ? 'STRICT DIAGNOSTIC — ANY mention in the description+pair path counts (comment/test included)'
      : 'the description+pair path carries NO per-app special case (class `product`)')
  );
  lines.push(
    'classes: product = FAILS | comment = printed only | test = printed only' +
      (strict ? '   [--strict: all three count]' : '')
  );
  lines.push('');

  for (const result of results) {
    lines.push('SUBJECT ' + result.subject + '  productHits=' + result.productHits + '  allHits=' + result.allHits);
    for (const module of result.modules) {
      const counts = module.counts;
      lines.push(
        '  module ' + module.path +
          '  [' + module.kind + ', ' + module.files + ' file(s)]  hits=' + module.hits.length +
          ' (product ' + counts.product + ', comment ' + counts.comment + ', test ' + counts.test + ')'
      );
      lines.push('    role: ' + module.role);
      for (const hit of module.hits) {
        lines.push('    ' + hit.class.padEnd(7) + ' ' + hit.file + ':' + hit.line + ': ' + hit.text);
      }
    }
    lines.push('');
  }

  lines.push(
    'SWEEP RESULT: ' + verdict + ' subjects=' + subjects + ' modules=' + modules + ' hits=' + counted
  );
  if (!strict && nonGraded.length > 0) {
    lines.push(
      '(counted hits = product only; ' + nonGraded.length +
        ' comment/test mention(s) in scope are NOT graded — see --strict):'
    );
    for (const entry of nonGraded) lines.push('  not-graded ' + entry);
  }
  return { text: lines.join('\n'), verdict, counted, totalProduct, totalAll, subjects, modules, totalFiles };
}

/* ==========================================================================
 * Self-check — proves the matcher is NON-VACUOUS
 * ==========================================================================
 *
 * The controls are the point: without them "clean" and "the matcher is broken"
 * are the same reading. Every control below is built on the SAME `scanSubject` /
 * `sweepRoots` code the real run uses.
 *
 *   C1 product-code special case (TS)                      -> product 1
 *   C2 comment-only mention (TS)                           -> comment 1, product 0
 *   C3 test-file mention (`__tests__/*.test.ts`)           -> test 1,    product 0
 *   C4 an id that is planted NOWHERE                       -> total 0
 *   C5 Rust mention INSIDE `#[cfg(test)] mod tests`        -> test 1,    product 0
 *   C6 Rust mention AFTER the test module (product code)   -> product 1 (the range ENDS)
 *   C7 a second subject absent from the same planted tree  -> product 0
 *   C8 the verdict FAILS on the planted product hit        -> FAIL in both modes
 *   C9 --strict counts strictly more than the default      -> strict > default
 *   C10 a `#[cfg(test)] fn` (NOT a mod) must not excuse     -> product 1
 */

const SELF_SUBJECT_A = 'zzqa3244-sweep-subject-a';
/* Deliberately NOT a superstring/substring of SELF_SUBJECT_A: the two controls must
 * stay independent, so a hit on one can never be explained by the other. */
const SELF_SUBJECT_ABSENT = 'zzqa3244-nowhere-control';

function runSelfCheck() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fredo-3244-sweep-'));
  const controls = [];
  const fail = (id, detail) => {
    controls.push({ id, ok: false, detail });
  };
  const pass = (id, detail) => {
    controls.push({ id, ok: true, detail });
  };

  try {
    // C1 -- a real product-code special case, the shape R-5b forbids.
    mkdirSync(path.join(root, 'product'), { recursive: true });
    writeFileSync(
      path.join(root, 'product', 'c1-branch.ts'),
      [
        'export function resolve(appId) {',
        "  if (appId === '" + SELF_SUBJECT_A + "') return 'special';",
        '  return null;',
        '}',
        '',
      ].join('\n'),
      'utf8'
    );

    // C2 -- the id mentioned ONLY in a comment (the injection.ts shape).
    writeFileSync(
      path.join(root, 'product', 'c2-comment.ts'),
      [
        '/**',
        ' * The confound: `' + SELF_SUBJECT_A + '` carries a per-app registrar.',
        ' */',
        'export const notAThing = 1;',
        '',
      ].join('\n'),
      'utf8'
    );

    // C3 -- the id in a test fixture file (the shipped __tests__ shape).
    mkdirSync(path.join(root, 'product', '__tests__'), { recursive: true });
    writeFileSync(
      path.join(root, 'product', '__tests__', 'c3.test.ts'),
      ["it('resolves', () => { expect(facts('" + SELF_SUBJECT_A + "').taught).toBe(false); });", ''].join('\n'),
      'utf8'
    );

    // C4 -- an id planted nowhere at all.
    writeFileSync(path.join(root, 'product', 'c4-plain.ts'), 'export const unrelated = 2;\n', 'utf8');

    // C5 / C6 -- the Rust test-region boundary, both sides.
    writeFileSync(
      path.join(root, 'product', 'c5-rust.rs'),
      [
        'pub fn resolve(app_id: &str) -> bool {',
        '    app_id == "not-a-subject"',
        '}',
        '',
        '#[cfg(test)]',
        'mod tests {',
        '    #[test]',
        '    fn names_the_subject() {',
        "        assert_eq!(resolve(\"" + SELF_SUBJECT_A + "\"), false);",
        '    }',
        '}',
        '',
        'pub fn after_the_tests(app_id: &str) -> bool {',
        "    app_id == \"" + SELF_SUBJECT_A + '"',
        '}',
        '',
      ].join('\n'),
      'utf8'
    );

    // C10 fixture: a `#[cfg(test)]` attribute on a FUNCTION, then product code that
    // names the subject. A naively-braced scan would swallow the rest of the file.
    writeFileSync(
      path.join(root, 'product', 'c10-rust.rs'),
      [
        '#[cfg(test)]',
        'fn helper_for_tests() -> usize { 0 }',
        '',
        'pub fn product_after_a_test_fn(app_id: &str) -> bool {',
        "    app_id == \"" + SELF_SUBJECT_A + '"',
        '}',
        '',
      ].join('\n'),
      'utf8'
    );

    const roots = [
      {
        path: 'product',
        kind: 'dir',
        lang: 'ts',
        role: 'self-check TS fixtures',
        absPath: path.join(root, 'product'),
        files: [
          path.join(root, 'product', 'c1-branch.ts'),
          path.join(root, 'product', 'c2-comment.ts'),
          path.join(root, 'product', '__tests__', 'c3.test.ts'),
          path.join(root, 'product', 'c4-plain.ts'),
        ].sort(),
      },
      {
        path: 'product/c5-rust.rs',
        kind: 'file',
        lang: 'rs',
        role: 'self-check Rust fixture',
        absPath: path.join(root, 'product', 'c5-rust.rs'),
        files: [path.join(root, 'product', 'c5-rust.rs')],
      },
      {
        path: 'product/c10-rust.rs',
        kind: 'file',
        lang: 'rs',
        role: 'self-check Rust attribute-on-fn fixture',
        absPath: path.join(root, 'product', 'c10-rust.rs'),
        files: [path.join(root, 'product', 'c10-rust.rs')],
      },
    ];

    const results = sweepRoots([SELF_SUBJECT_A, SELF_SUBJECT_ABSENT], roots, root);
    const byFile = (result, name) => {
      const hits = [];
      for (const module of result.modules) {
        for (const hit of module.hits) {
          if (hit.file.replace(/\\/g, '/').endsWith(name)) hits.push(hit);
        }
      }
      return hits;
    };
    const subjectA = results.find((result) => result.subject === SELF_SUBJECT_A);
    const subjectAbsent = results.find((result) => result.subject === SELF_SUBJECT_ABSENT);

    const c1 = byFile(subjectA, 'c1-branch.ts');
    if (c1.length === 1 && c1[0].class === 'product' && c1[0].line === 2) {
      pass('C1-planted-product-hit-is-reported', 'c1-branch.ts:2 reported as `product`');
    } else {
      fail('C1-planted-product-hit-is-reported', JSON.stringify(c1));
    }

    const c2 = byFile(subjectA, 'c2-comment.ts');
    if (c2.length === 1 && c2[0].class === 'comment') {
      pass('C2-comment-mention-is-not-product', 'c2-comment.ts reported as `comment` only');
    } else {
      fail('C2-comment-mention-is-not-product', JSON.stringify(c2));
    }

    const c3 = byFile(subjectA, 'c3.test.ts');
    if (c3.length === 1 && c3[0].class === 'test') {
      pass('C3-test-file-mention-is-not-product', 'c3.test.ts reported as `test` only');
    } else {
      fail('C3-test-file-mention-is-not-product', JSON.stringify(c3));
    }

    const c4 = byFile(subjectA, 'c4-plain.ts');
    if (c4.length === 0) {
      pass('C4-unrelated-file-has-no-hit', 'c4-plain.ts: 0 hits');
    } else {
      fail('C4-unrelated-file-has-no-hit', JSON.stringify(c4));
    }

    const rustHits = byFile(subjectA, 'c5-rust.rs');
    const rustTest = rustHits.filter((hit) => hit.class === 'test');
    const rustProduct = rustHits.filter((hit) => hit.class === 'product');
    if (rustTest.length === 1 && rustTest[0].line === 9) {
      pass('C5-rust-inside-cfg-test-is-test-class', 'c5-rust.rs:9 reported as `test`');
    } else {
      fail('C5-rust-inside-cfg-test-is-test-class', JSON.stringify(rustHits));
    }
    if (rustProduct.length === 1 && rustProduct[0].line === 14) {
      pass(
        'C6-rust-after-the-test-module-is-product',
        'c5-rust.rs:14 reported as `product` — the cfg(test) range ENDS at its closing brace'
      );
    } else {
      fail('C6-rust-after-the-test-module-is-product', JSON.stringify(rustHits));
    }

    if (subjectAbsent && subjectAbsent.allHits === 0 && subjectAbsent.productHits === 0) {
      pass('C7-absent-subject-is-not-reported', SELF_SUBJECT_ABSENT + ': 0 hits, productHits 0');
    } else {
      fail('C7-absent-subject-is-not-reported', JSON.stringify(subjectAbsent));
    }

    // C10 -- a `#[cfg(test)]` on a FUNCTION must not open a test region.
    const c10 = byFile(subjectA, 'c10-rust.rs');
    if (c10.length === 1 && c10[0].class === 'product' && c10[0].line === 5) {
      pass(
        'C10-cfg-test-on-a-fn-does-not-open-a-test-region',
        'c10-rust.rs:5 reported as `product` — the attribute decorates a fn, not a mod'
      );
    } else {
      fail('C10-cfg-test-on-a-fn-does-not-open-a-test-region', JSON.stringify(c10));
    }

    // The failability control the row itself needs: the verdict must be FAIL when a
    // product hit exists. A matcher that can only ever say PASS is not an instrument.
    // Expected product occurrences in the planted tree:
    //   c1-branch.ts:2  (a real branch special case)
    //   c5-rust.rs:14   (AFTER the cfg(test) module — product code)
    //   c10-rust.rs:5   (after a `#[cfg(test)]` on a fn — still product code)
    const expectedProduct = 3;
    const verdictWithHit = report(results, root, false).verdict;
    const strictVerdict = report(results, root, true).verdict;
    if (verdictWithHit === 'FAIL' && strictVerdict === 'FAIL' && subjectA.productHits === expectedProduct) {
      pass(
        'C8-verdict-fails-on-the-planted-hit',
        'report() -> FAIL (both modes) with productHits=' + subjectA.productHits +
          ' (c1-branch.ts:2 + c5-rust.rs:14 + c10-rust.rs:5)'
      );
    } else {
      fail(
        'C8-verdict-fails-on-the-planted-hit',
        'default=' + verdictWithHit + ' strict=' + strictVerdict + ' productHits=' +
          (subjectA ? subjectA.productHits : 'n/a') + ' expected ' + expectedProduct
      );
    }

    // C9 -- the strict mode must be STRICTER, not equal: the comment and test
    // mentions that the default run excuses must fail a strict run. Without this
    // control, "--strict" could be an alias that silently does nothing.
    const defaultCounted = report(results, root, false).counted;
    const strictCounted = report(results, root, true).counted;
    if (strictCounted > defaultCounted) {
      pass(
        'C9-strict-counts-more-than-default',
        'default counted=' + defaultCounted + ' < strict counted=' + strictCounted
      );
    } else {
      fail('C9-strict-counts-more-than-default', 'default=' + defaultCounted + ' strict=' + strictCounted);
    }

    const failed = controls.filter((control) => !control.ok);
    for (const control of controls) {
      console.log((control.ok ? 'PASS ' : 'FAIL ') + control.id + '  ' + control.detail);
    }
    console.log(
      'SELF-CHECK RESULT: ' + (failed.length === 0 ? 'PASS' : 'FAIL') +
        ' controls=' + controls.length + ' failed=' + failed.length +
        ' fixture=' + root
    );
    return failed.length === 0 ? 0 : 1;
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      console.error('cleanup of ' + root + ' failed: ' + error.message);
    }
  }
}

/* ==========================================================================
 * Main
 * ========================================================================== */

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error('USAGE ERROR: ' + error.message);
    console.error('Try --help.');
    return 2;
  }
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  if (options.selfCheck) {
    return runSelfCheck();
  }

  let roots;
  try {
    roots = resolveScope(options.repoRoot);
  } catch (error) {
    console.error('IO ERROR: ' + error.message);
    return 2;
  }

  let results;
  try {
    results = sweepRoots(options.subjects, roots, options.repoRoot);
  } catch (error) {
    console.error('IO ERROR: ' + error.message);
    return 2;
  }

  if (options.json) {
    const summary = report(results, options.repoRoot, options.strict);
    console.log(
      JSON.stringify(
        {
          repoRoot: options.repoRoot,
          strict: options.strict,
          verdict: summary.verdict,
          subjects: results.map((result) => ({
            subject: result.subject,
            productHits: result.productHits,
            allHits: result.allHits,
            modules: result.modules.map((module) => ({
              path: module.path,
              role: module.role,
              files: module.files,
              counts: module.counts,
              hits: module.hits,
            })),
          })),
        },
        null,
        2
      )
    );
  } else {
    console.log(report(results, options.repoRoot, options.strict).text);
  }
  return summaryVerdict(results, options.strict);
}

function summaryVerdict(results, strict) {
  const counted = strict
    ? results.reduce((total, result) => total + result.allHits, 0)
    : results.reduce((total, result) => total + result.productHits, 0);
  return counted > 0 ? 1 : 0;
}

process.exitCode = main();
