/**
 * Spec #3244 ST-4 — the screen-outline projector (the ONE pure DOM → outline map).
 *
 * # What this module owns
 *
 * The injected pair has two legs. The SCREENSHOT leg is ST-3's host capture
 * (`shared/app-intelligibility/captureTarget.ts`). This module owns the OTHER
 * leg: a **bounded, text-only projection of the target's rendered DOM** — never
 * raw `outerHTML`, which is unbounded and whose style/script noise would blow the
 * turn's budget.
 *
 * A flat list of nodes, each carrying an accessible NAME, a ROLE and a normalized
 * box, is what makes a screen actionable for a small model. The projection is
 * origin-agnostic: it takes a DOM `root` and is therefore usable by the main
 * webview directly AND (through a host `eval` of the same algorithm) by a
 * separate installed-app webview.
 *
 * # Bounds (declare or degrade — never a silent over-cap)
 *
 *   - `SCREEN_OUTLINE_MAX_NODES` (120) — the node cap `simplifyDom` enforces; a
 *     dropped node sets `truncated`.
 *   - `SCREEN_OUTLINE_MAX_BYTES` (8192) — the UTF-8 byte cap on the outline's own
 *     turn input. `fitOutlineToBytes` trims nodes (and sets `truncated`) until the
 *     serialized outline fits; it never emits an over-cap payload.
 *
 * Both are planning values; ST-6's live run records the real ceiling.
 *
 * # The name rule
 *
 * A node is emitted ONLY when its accessible name is non-empty (`aria-label` →
 * `alt` → `title` → `placeholder` → visible text). An element with no name
 * carries no signal for the model, so it is not represented — which is why every
 * emitted node's `name` is a non-empty string. A hidden element (the `hidden`
 * attribute or `aria-hidden="true"`) and its whole subtree are skipped.
 *
 * Pure by construction: no React, no IPC, no registry reads, no side effects.
 */

/** One projected interactive/named element. */
export interface ScreenOutlineNode {
  /** ARIA role, or a tag-derived role (`button`, `link`, `heading`, `generic`, …). */
  readonly role: string;
  /** The accessible name — ALWAYS a non-empty string. */
  readonly name: string;
  /** Lowercase tag name. */
  readonly tag: string;
  /** `data-testid`, ABSENT KEY when the element has none (G-413). */
  readonly testid?: string;
  /** `[x, y, width, height]` in viewport-relative CSS px (rounded). */
  readonly bbox: readonly [number, number, number, number];
}

/** A bounded, text-only projection of a target's rendered DOM. */
export interface ScreenOutline {
  readonly nodes: readonly ScreenOutlineNode[];
  /** True when the node cap (or the byte cap) dropped nodes. */
  readonly truncated: boolean;
}

/**
 * The per-turn injected pair: a FRESH screenshot (ST-3's capture leg) plus this
 * module's outline (the DOM leg). Composed by the caller; this module owns the
 * `outline` half and the type.
 */
export interface ScreenPair {
  /** A base64-encoded PNG of the target's current screen. */
  readonly screenshotPngBase64: string;
  readonly outline: ScreenOutline;
}

/** The node cap `simplifyDom` enforces (planning value; ST-6 records the ceiling). */
export const SCREEN_OUTLINE_MAX_NODES = 120;

/** The UTF-8 byte cap on the outline's own turn input (planning value). */
export const SCREEN_OUTLINE_MAX_BYTES = 8192;

/** Longest accessible name kept verbatim (a runaway text node is clipped). */
export const SCREEN_OUTLINE_MAX_NAME_CHARS = 120;

/** Tags whose subtrees are never projected. */
const SKIPPED_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'HEAD',
  'META',
  'LINK',
  'TITLE',
  'BR',
  'WBR',
]);

/** Tag-derived roles for elements that declare no explicit `role`. */
const TAG_ROLES: Readonly<Record<string, string>> = Object.freeze({
  A: 'link',
  BUTTON: 'button',
  SELECT: 'combobox',
  TEXTAREA: 'textbox',
  IMG: 'img',
  H1: 'heading',
  H2: 'heading',
  H3: 'heading',
  H4: 'heading',
  H5: 'heading',
  H6: 'heading',
  UL: 'list',
  OL: 'list',
  LI: 'listitem',
  TABLE: 'table',
  TR: 'row',
  TD: 'cell',
  TH: 'columnheader',
  NAV: 'navigation',
  MAIN: 'main',
  HEADER: 'banner',
  FOOTER: 'contentinfo',
  FORM: 'form',
  LABEL: 'label',
  P: 'paragraph',
  SECTION: 'region',
  DIALOG: 'dialog',
  SUMMARY: 'button',
});

/**
 * The UTF-8 byte length of a string — the unit `SCREEN_OUTLINE_MAX_BYTES` is
 * expressed in. A surrogate pair counts as ONE four-byte code point, never two
 * three-byte units. (Same rule the grounding cap uses; exported so the dispatch
 * seam shares ONE implementation.)
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index) ?? 0;
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return bytes;
}

/**
 * A stable, content-derived digest (16 lowercase hex chars) for change detection:
 * the injection span records the screenshot digest and the outline digest so two
 * turns can be shown to differ even when their byte counts coincide (AC-3).
 *
 * This is a NON-cryptographic 53-bit hash (cyrb53) — a deterministic content
 * fingerprint, not a security primitive, and deliberately synchronous so the
 * projector stays pure and test-friendly.
 */
export function contentDigest(value: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const high = 2097151 & h2;
  const low = 4294967295 & h1;
  return (high * 4294967296 + low).toString(16).padStart(14, '0').slice(0, 16);
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Tags whose text IS the control's label. */
const INTERACTIVE_TAGS = new Set([
  'A',
  'BUTTON',
  'INPUT',
  'SELECT',
  'TEXTAREA',
  'SUMMARY',
  'OPTION',
  'LABEL',
]);

/**
 * The element's text-derived name.
 *
 * A container is NOT named by its descendants (otherwise a wrapping `<div>` would
 * absorb every child's text into one giant name and shadow the real controls).
 * So text is used only for an INTERACTIVE element (tag- or `role`-declared, whose
 * text IS its label) or a LEAF element (no element children).
 */
function textName(element: Element): string {
  const interactive =
    element.hasAttribute('role') || INTERACTIVE_TAGS.has(element.tagName.toUpperCase());
  if (!interactive && element.children.length > 0) return '';
  return collapseWhitespace(element.textContent ?? '');
}

function clipName(value: string): string {
  return value.length > SCREEN_OUTLINE_MAX_NAME_CHARS
    ? value.slice(0, SCREEN_OUTLINE_MAX_NAME_CHARS)
    : value;
}

/** The element's non-empty accessible name, or `''` (label → alt → title → placeholder → text). */
function accessibleName(element: Element): string {
  const attribute = (name: string): string => {
    const value = element.getAttribute(name);
    return value === null ? '' : collapseWhitespace(value);
  };
  for (const candidate of [
    attribute('aria-label'),
    attribute('alt'),
    attribute('title'),
    attribute('placeholder'),
  ]) {
    if (candidate !== '') return clipName(candidate);
  }
  const text = textName(element);
  return text === '' ? '' : clipName(text);
}

/** The element's role: its explicit `role`, else a tag/`type`-derived one. */
function elementRole(element: Element): string {
  const explicit = element.getAttribute('role');
  if (explicit !== null && collapseWhitespace(explicit) !== '') {
    return collapseWhitespace(explicit);
  }
  const tag = element.tagName.toUpperCase();
  if (tag === 'INPUT') {
    const type = (element.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'range') return 'slider';
    return 'textbox';
  }
  return TAG_ROLES[tag] ?? 'generic';
}

/** `[x, y, w, h]` in viewport-relative CSS px, rounded (never a float on the wire). */
function elementBox(element: Element): readonly [number, number, number, number] {
  const measure = (element as Partial<HTMLElement>).getBoundingClientRect;
  if (typeof measure !== 'function') return [0, 0, 0, 0];
  const rect = measure.call(element);
  return [
    Math.round(rect.left),
    Math.round(rect.top),
    Math.round(rect.width),
    Math.round(rect.height),
  ];
}

function buildNode(element: Element, name: string): ScreenOutlineNode {
  const role = elementRole(element);
  const tag = element.tagName.toLowerCase();
  const bbox = elementBox(element);
  const rawTestId = element.getAttribute('data-testid');
  const testid = rawTestId === null ? '' : rawTestId.trim();
  return testid === ''
    ? { role, name, tag, bbox }
    : { role, name, tag, testid, bbox };
}

/** Is this element (and its subtree) excluded from the projection? */
function isSkipped(element: Element): boolean {
  if (SKIPPED_TAGS.has(element.tagName.toUpperCase())) return true;
  if ((element as Partial<HTMLElement>).hidden === true) return true;
  return element.getAttribute('aria-hidden') === 'true';
}

/**
 * Project `root`'s rendered DOM into at most `maxNodes` named nodes (pre-order).
 *
 * A node is emitted only when its accessible name is non-empty; a hidden element
 * (or one inside a skipped tag) contributes nothing, and its subtree is not
 * walked. `truncated` is `true` when at least one further named node existed
 * beyond the cap — never silently dropped, always declared.
 */
export function simplifyDom(root: Element, maxNodes: number): ScreenOutline {
  const cap = Number.isFinite(maxNodes) ? Math.max(0, Math.floor(maxNodes)) : 0;
  const nodes: ScreenOutlineNode[] = [];
  let truncated = false;

  const walk = (element: Element): void => {
    if (isSkipped(element)) return;
    const name = accessibleName(element);
    if (name !== '') {
      if (nodes.length < cap) nodes.push(buildNode(element, name));
      else truncated = true;
    }
    for (let index = 0; index < element.children.length; index += 1) {
      const child = element.children.item(index);
      if (child !== null) walk(child);
    }
  };

  walk(root);
  return { nodes, truncated };
}

/** The exact serialized outline the turn carries and the digest is taken over. */
export function serializeOutline(outline: ScreenOutline): string {
  return JSON.stringify({ nodes: outline.nodes, truncated: outline.truncated });
}

/** The UTF-8 byte length of the serialized outline. */
export function outlineBytes(outline: ScreenOutline): number {
  return utf8ByteLength(serializeOutline(outline));
}

/**
 * Trim `outline`'s nodes until its serialized form fits `maxBytes`, setting
 * `truncated` when anything was removed. Never emits an over-cap payload, and
 * never silently drops — the declaration rides on the outline itself.
 */
export function fitOutlineToBytes(outline: ScreenOutline, maxBytes: number): ScreenOutline {
  const budget = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
  let nodes: readonly ScreenOutlineNode[] = outline.nodes;
  let truncated = outline.truncated;
  while (nodes.length > 0 && outlineBytes({ nodes, truncated }) > budget) {
    nodes = nodes.slice(0, nodes.length - 1);
    truncated = true;
  }
  return { nodes, truncated };
}
