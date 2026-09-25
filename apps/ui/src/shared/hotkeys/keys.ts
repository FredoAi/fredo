/**
 * Spec #2946 ST-1 — the ONE key serialization + normalization + matching truth
 * (plan contract block 2, typed-character model per PO#6).
 *
 * PURE by design: no DOM/Tauri/React/clock IMPORTS. The only ambient DOM
 * references are the `KeyboardEvent` argument and the browser's `navigator`
 * (for the platform-neutral primary modifier); both can be injected via the
 * optional `platform` argument so every decision is deterministic in tests.
 *
 * Canonical serialization (contract block 2):
 *   modifier tokens in the order `primary`, `ctrl`, `alt`, `shift`, `meta`,
 *   `'+'`-joined, then the key token; strokes are space-joined. The leader's
 *   own stroke serializes as `@leader`.
 *
 * Matching is PLATFORM-AWARE (the ONE matching truth): on a platform whose
 * primary modifier IS Ctrl, a stored explicit `ctrl` and a normalized
 * `primary` denote the SAME physical chord, so `ctrl+shift+f10` matches a
 * Ctrl+Shift+F10 keydown on Windows/Linux. On darwin, `ctrl` (Control) and
 * `primary` (Command/Meta) are distinct keys and never collapse.
 */

import type { KeySequence, KeyStroke, Platform } from './types';

/** The serialized token for the configured leader's own stroke. */
export const LEADER_TOKEN = '@leader';

/** The canonical modifier-token order. */
const MODIFIER_TOKENS = ['primary', 'ctrl', 'alt', 'shift', 'meta'] as const;
type ModifierToken = (typeof MODIFIER_TOKENS)[number];

/** Named (non-printable) key tokens accepted in storage. */
const NAMED_KEY_TOKENS: ReadonlySet<string> = new Set<string>([
  'space',
  'escape',
  'enter',
  'tab',
  'backspace',
  'delete',
  'insert',
  'home',
  'end',
  'pageup',
  'pagedown',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
  ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
]);

/** Legacy/alias spellings accepted on input and canonicalized. */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  ' ': 'space',
  spacebar: 'space',
  esc: 'escape',
  return: 'enter',
  del: 'delete',
  ins: 'insert',
  pgup: 'pageup',
  pgdn: 'pagedown',
};

/** Display labels for named keys (layout-resolved human labels). */
const NAMED_DISPLAY: Readonly<Record<string, string>> = {
  space: 'Space',
  escape: 'Esc',
  enter: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Del',
  insert: 'Ins',
  home: 'Home',
  end: 'End',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  ...Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`f${i + 1}`, `F${i + 1}`])),
};

/** Spoken names for named keys (accessible output). */
const NAMED_SPEECH: Readonly<Record<string, string>> = {
  space: 'Space',
  escape: 'Escape',
  enter: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'Page Up',
  pagedown: 'Page Down',
  arrowup: 'Arrow Up',
  arrowdown: 'Arrow Down',
  arrowleft: 'Arrow Left',
  arrowright: 'Arrow Right',
  ...Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`f${i + 1}`, `F ${i + 1}`])),
};

/** Spoken names for common printable characters (accessible output). */
const PUNCTUATION_SPEECH: Readonly<Record<string, string>> = {
  '`': 'Grave',
  '~': 'Tilde',
  '!': 'Exclamation mark',
  '@': 'At',
  '#': 'Hash',
  $: 'Dollar',
  '%': 'Percent',
  '^': 'Caret',
  '&': 'Ampersand',
  '*': 'Asterisk',
  '(': 'Left parenthesis',
  ')': 'Right parenthesis',
  '-': 'Minus',
  _: 'Underscore',
  '=': 'Equals',
  '+': 'Plus',
  '[': 'Left bracket',
  ']': 'Right bracket',
  '{': 'Left brace',
  '}': 'Right brace',
  '\\': 'Backslash',
  '|': 'Pipe',
  ';': 'Semicolon',
  ':': 'Colon',
  "'": 'Apostrophe',
  '"': 'Quote',
  ',': 'Comma',
  '.': 'Period',
  '<': 'Less than',
  '>': 'Greater than',
  '/': 'Slash',
  '?': 'Question mark',
};

/** A code point count of 1 (handles surrogate pairs). */
export function isSingleCharacter(key: string): boolean {
  return typeof key === 'string' && [...key].length === 1;
}

/**
 * Detect the active platform. `navigator` is the only ambient browser read;
 * a non-browser/test environment defaults to win32 (Ctrl primary), matching the
 * shipped Windows-first target.
 */
export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'win32';
  const haystack = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
  if (/mac|darwin|iphone|ipad|ipod/i.test(haystack)) return 'darwin';
  if (/linux/i.test(haystack)) return 'linux';
  return 'win32';
}

/** win32/linux → `'ctrl'`; darwin → `'meta'`. Injectable for determinism. */
export function resolvePrimaryModifier(platform?: Platform): 'ctrl' | 'meta' {
  return (platform ?? detectPlatform()) === 'darwin' ? 'meta' : 'ctrl';
}

/** Canonicalize a key token; returns `null` for an unknown token. */
export function normalizeKeyToken(raw: string): string | null {
  if (raw === LEADER_TOKEN) return LEADER_TOKEN;
  const lower = raw.toLowerCase();
  const alias = KEY_ALIASES[lower];
  if (alias) return alias;
  if (NAMED_KEY_TOKENS.has(lower)) return lower;
  if (isSingleCharacter(raw)) return raw; // typed character, case-sensitive
  return null;
}

function parseModifierToken(raw: string): ModifierToken | null {
  const lower = raw.toLowerCase();
  return (MODIFIER_TOKENS as readonly string[]).includes(lower)
    ? (lower as ModifierToken)
    : null;
}

/** Parse ONE serialized stroke token. Returns `null` when unrepresentable. */
export function parseStrokeToken(token: string): KeyStroke | null {
  if (typeof token !== 'string' || token.length === 0) return null;
  const parts = token.split('+');
  const mods: Record<ModifierToken, boolean> = {
    primary: false,
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  };
  let i = 0;
  // Consume leading modifier tokens; the key is everything after them (so the
  // `'+'` key itself and `primary++` round-trip).
  while (i < parts.length - 1) {
    const mod = parseModifierToken(parts[i]);
    if (!mod) break;
    mods[mod] = true;
    i += 1;
  }
  const key = normalizeKeyToken(parts.slice(i).join('+'));
  if (key === null) return null;
  return {
    key,
    primary: mods.primary,
    ctrl: mods.ctrl,
    alt: mods.alt,
    shift: mods.shift,
    meta: mods.meta,
  };
}

/**
 * Parse a serialized sequence. TOTAL: never throws; an unrepresentable input
 * yields `[]` (the invalid sentinel, checked by the conflict classifier).
 */
export function parseSequence(s: string): KeySequence {
  if (typeof s !== 'string') return [];
  const tokens = s.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const out: KeyStroke[] = [];
  for (const token of tokens) {
    const stroke = parseStrokeToken(token);
    if (!stroke) return [];
    out.push(stroke);
  }
  return out;
}

/** Serialize one stroke in canonical modifier order. */
export function serializeStroke(stroke: KeyStroke): string {
  const parts: string[] = [];
  if (stroke.primary) parts.push('primary');
  if (stroke.ctrl) parts.push('ctrl');
  if (stroke.alt) parts.push('alt');
  if (stroke.shift) parts.push('shift');
  if (stroke.meta) parts.push('meta');
  parts.push(stroke.key);
  return parts.join('+');
}

/** Serialize a sequence; `@leader` steps stay `@leader`. */
export function serializeSequence(seq: KeySequence): string {
  return seq.map(serializeStroke).join(' ');
}

/** The layout-resolved display label for a single stroke, e.g. `Ctrl + G`. */
export function displayStroke(stroke: KeyStroke, platform?: Platform): string {
  const primaryMod = resolvePrimaryModifier(platform);
  const parts: string[] = [];
  if (stroke.primary) parts.push(primaryMod === 'meta' ? 'Cmd' : 'Ctrl');
  if (stroke.ctrl) parts.push('Ctrl');
  if (stroke.alt) parts.push(primaryMod === 'meta' ? 'Option' : 'Alt');
  if (stroke.shift) parts.push('Shift');
  if (stroke.meta) parts.push(primaryMod === 'meta' ? 'Cmd' : 'Meta');
  parts.push(displayKeyToken(stroke.key));
  return parts.join(' + ');
}

function displayKeyToken(key: string): string {
  if (key === LEADER_TOKEN) return 'Leader';
  const named = NAMED_DISPLAY[key];
  if (named) return named;
  if (isSingleCharacter(key) && /[a-z]/i.test(key)) return key.toUpperCase();
  return key;
}

/** A layout-resolved label for a whole sequence, e.g. `g then g`. */
export function displaySequence(seq: KeySequence, platform?: Platform): string {
  return seq.map((stroke) => displayStroke(stroke, platform)).join(' then ');
}

/** The spoken form of a stroke, e.g. `Control plus G`. */
export function accessibleStroke(stroke: KeyStroke, platform?: Platform): string {
  const primaryMod = resolvePrimaryModifier(platform);
  const parts: string[] = [];
  if (stroke.primary) parts.push(primaryMod === 'meta' ? 'Command' : 'Control');
  if (stroke.ctrl) parts.push('Control');
  if (stroke.alt) parts.push(primaryMod === 'meta' ? 'Option' : 'Alt');
  if (stroke.shift) parts.push('Shift');
  if (stroke.meta) parts.push(primaryMod === 'meta' ? 'Command' : 'Meta');
  parts.push(accessibleKeyToken(stroke.key));
  return parts.join(' plus ');
}

function accessibleKeyToken(key: string): string {
  if (key === LEADER_TOKEN) return 'Leader';
  const named = NAMED_SPEECH[key];
  if (named) return named;
  const punctuation = PUNCTUATION_SPEECH[key];
  if (punctuation) return punctuation;
  if (isSingleCharacter(key)) return key.toUpperCase();
  return key;
}

/** A spoken form for a whole sequence, e.g. `G then G`. */
export function accessibleSequence(seq: KeySequence, platform?: Platform): string {
  return seq.map((stroke) => accessibleStroke(stroke, platform)).join(' then ');
}

/**
 * Normalize a `KeyboardEvent` to a `KeyStroke`.
 *
 * Binding rules (contract block 2):
 *  (a) `isComposing` or AltGraph → `null` (no match, no preventDefault);
 *  (b) a single-character key → stored verbatim with `shift: false` (Shift is
 *      encoded in the character); a bare Space becomes the named `'space'`;
 *  (c) a named key → lowercased name + the four modifier flags as pressed;
 *  (d) matching is against the ACTIVE OS layout — no `code` comparison.
 *
 * The platform-neutral `primary` absorbs the platform's primary key (so the
 * explicit `ctrl`/`meta` flags never double-count it); `keyStrokeEquals` folds
 * them back for stored explicit-`ctrl` chords on a Ctrl-primary platform.
 */
export function normalizeKeyStroke(e: KeyboardEvent, platform?: Platform): KeyStroke | null {
  if (!e) return null;
  if (e.isComposing === true) return null;
  if (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph')) return null;
  const rawKey = e.key;
  if (typeof rawKey !== 'string' || rawKey.length === 0) return null;

  const primaryMod = resolvePrimaryModifier(platform);
  const ctrlHeld = e.ctrlKey === true;
  const metaHeld = e.metaKey === true;
  const primary = primaryMod === 'ctrl' ? ctrlHeld : metaHeld;
  const ctrl = primaryMod === 'ctrl' ? false : ctrlHeld;
  const meta = primaryMod === 'meta' ? false : metaHeld;

  const named = normalizeNamedEventKey(rawKey);
  if (named !== null) {
    return {
      key: named,
      primary,
      ctrl,
      alt: e.altKey === true,
      shift: e.shiftKey === true,
      meta,
    };
  }

  if (isSingleCharacter(rawKey) && rawKey !== ' ') {
    return {
      key: rawKey,
      primary,
      ctrl,
      alt: e.altKey === true,
      shift: false,
      meta,
    };
  }

  return null;
}

/** Canonicalize a `KeyboardEvent.key` name; `null` for non-key/unknown/dead keys. */
function normalizeNamedEventKey(raw: string): string | null {
  if (raw === ' ' || raw === 'Spacebar') return 'space';
  const lower = raw.toLowerCase();
  const alias = KEY_ALIASES[lower];
  if (alias) return alias;
  if (NAMED_KEY_TOKENS.has(lower)) return lower;
  // `Dead`, pure modifiers (`Control`, `Shift`, …) and `Unidentified` fall here.
  return null;
}

/** The canonical modifier signature used for matching, platform-folded. */
function modifierSignature(stroke: KeyStroke, primaryMod: 'ctrl' | 'meta'): string {
  const primary = stroke.primary || (primaryMod === 'ctrl' ? stroke.ctrl : stroke.meta);
  const explicitCtrl = primaryMod === 'ctrl' ? false : stroke.ctrl;
  const explicitMeta = primaryMod === 'meta' ? false : stroke.meta;
  return `${primary ? 1 : 0}${explicitCtrl ? 1 : 0}${stroke.alt ? 1 : 0}${stroke.shift ? 1 : 0}${
    explicitMeta ? 1 : 0
  }`;
}

/**
 * The ONE semantic stroke comparison. On a Ctrl-primary platform an explicit
 * `ctrl` and the `primary` flag denote the same physical chord; on darwin they
 * are distinct keys. Used by the matcher, the reserved lookup and conflicts.
 */
export function keyStrokeEquals(a: KeyStroke, b: KeyStroke, platform?: Platform): boolean {
  if (!a || !b) return false;
  if (a.key !== b.key) return false;
  const primaryMod = resolvePrimaryModifier(platform);
  return modifierSignature(a, primaryMod) === modifierSignature(b, primaryMod);
}

/** Semantic sequence equality (same length, same steps under `keyStrokeEquals`). */
export function sequenceEquals(a: KeySequence, b: KeySequence, platform?: Platform): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!keyStrokeEquals(a[i], b[i], platform)) return false;
  }
  return true;
}

/** True when the stroke carries at least one true modifier chord. */
export function isModifierChord(stroke: KeyStroke): boolean {
  return stroke.primary || stroke.ctrl || stroke.alt || stroke.meta;
}
