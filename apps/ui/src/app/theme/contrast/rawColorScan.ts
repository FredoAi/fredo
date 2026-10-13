/**
 * Spec #3033 ST-4 — raw-colour scanner (AC3 / R-3). POLICY-FREE.
 *
 * Detects hardcoded colour literals in the scanned sources *after stripping
 * comments*, and returns a `RawColorHit` for EVERY match — allowlist-blind and
 * baseline-blind. This is the producer stage (the `buildContrastMatrix`
 * analogue): the excuse layers (literal-pinned `RAW_COLOR_ALLOWLIST` filter +
 * the `RAW_COLOR_BASELINE` diff) live in `rawColorEvaluate.evaluateRawColors`,
 * so there is exactly ONE source of "what is a raw-colour violation".
 *
 * Patterns (reused from `shared/hotkeys/__tests__/themeHygiene.test.ts`):
 *   - hex                 `#[0-9a-fA-F]{3,8}\b`
 *   - functional colour   `\b(?:rgba?|hsla?)\(`  (the FULL call is the literal)
 *   - var alpha-append    `var\(--[a-z0-9-]+\)[0-9]`  (invalid CSS — #2770)
 *
 * The `function` literal captures the whole balanced call (e.g.
 * `rgba(255,255,255,0.25)`) rather than the bare prefix, so the allowlist can
 * pin one canvas colour without legalising a different DOM colour in the same
 * file — the anti-widening requirement of the plan.
 *
 * Read-only, deterministic, pure-of-side-effects; no browser, no new dependency.
 */

export interface RawColorHit {
  /** POSIX-relative path (as supplied, normalised to forward slashes). */
  file: string;
  /** `normalizeRawLiteral`-normalised token. */
  literal: string;
  kind: 'hex' | 'function' | 'var-alpha-append';
}

/** Whitespace-collapsed, lowercased literal identity — the allowlist key. */
export function normalizeRawLiteral(literal: string): string {
  return literal.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Strip block comments and line comments (including trailing ones) so prose —
 * issue refs like `#2946`, doc-comment colour mentions — can neither mask nor
 * satisfy a colour scan. `//` preceded by `:` is preserved so a URL inside a
 * string is not mistaken for a comment.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const VAR_ALPHA_APPEND = /var\(--[a-z0-9-]+\)[0-9]/g;
const FUNCTION_COLOR = /\b(?:rgba?|hsla?)\s*\(/g;

interface RawMatch {
  literal: string;
  kind: RawColorHit['kind'];
}

/** Every raw-colour hit in already-comment-stripped code. */
function matchRawLiterals(code: string): RawMatch[] {
  const matches: RawMatch[] = [];

  for (const m of code.matchAll(HEX)) {
    matches.push({ literal: normalizeRawLiteral(m[0]), kind: 'hex' });
  }

  for (const m of code.matchAll(VAR_ALPHA_APPEND)) {
    matches.push({ literal: normalizeRawLiteral(m[0]), kind: 'var-alpha-append' });
  }

  // Capture the WHOLE call (balanced parens) so the literal is precise.
  FUNCTION_COLOR.lastIndex = 0;
  let call: RegExpExecArray | null;
  while ((call = FUNCTION_COLOR.exec(code)) !== null) {
    const start = call.index;
    let i = FUNCTION_COLOR.lastIndex;
    let depth = 1;
    while (i < code.length && depth > 0) {
      const ch = code[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      i += 1;
    }
    matches.push({ literal: normalizeRawLiteral(code.slice(start, i)), kind: 'function' });
  }

  return matches;
}

/**
 * Scan provided sources and return EVERY raw-colour hit (policy-free — the
 * allowlist and baseline are applied by `evaluateRawColors`, never here). A hit
 * carries its exact `{file, literal, kind}` so the evaluator can pin it.
 */
export function scanRawColors(
  input: ReadonlyArray<{ path: string; source: string }>,
): RawColorHit[] {
  const hits: RawColorHit[] = [];
  for (const { path, source } of input) {
    const file = path.replace(/\\/g, '/');
    for (const { literal, kind } of matchRawLiterals(stripComments(source))) {
      hits.push({ file, literal, kind });
    }
  }
  return hits;
}

/** Test/spec and declaration files are not "feature components" (AC3). */
const NON_SOURCE = /(?:^|\/)(?:__tests__|__mocks__)(?:\/|$)|\.(?:test|spec)\.(?:ts|tsx)$/;

export function defaultScanTargets(): Array<{ path: string; source: string }> {
  // Vite root (apps/ui) — keys are root-relative (`/src/...`); emit repo-root
  // POSIX paths (`apps/ui/src/...`) so allowlist entries are stable.
  const modules = import.meta.glob('/src/applications/**/*.{ts,tsx}', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;
  const system = import.meta.glob('/src/app/theme/system.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;

  const targets: Array<{ path: string; source: string }> = [];
  for (const [key, source] of Object.entries({ ...system, ...modules })) {
    if (NON_SOURCE.test(key) || key.endsWith('.d.ts')) continue;
    targets.push({ path: `apps/ui${key}`, source });
  }
  targets.sort((a, b) => a.path.localeCompare(b.path));
  return targets;
}
