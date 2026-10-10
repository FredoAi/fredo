/**
 * Spec #3009 CU-1 (ST-1) — the `data-hotkey` element registry (plan API
 * Contracts block).
 *
 * Discovers every mounted element carrying a valid `data-hotkey` across the
 * whole document via ONE `MutationObserver` on `document.body` plus one initial
 * full scan, and exposes the resulting document-ordered, grammar-valid listing
 * to the ST-2 bar model and the ST-3 engine seam.
 *
 * WHY OBSERVER (binding, plan ST-1): render-time registration would force every
 * feature author to import a registration hook (coupling, easy to omit) and
 * would miss portals / dynamically-rendered content. The observer catches both
 * `childList` and `attributes` mutation so JS-injected and attribute-mutated
 * elements are caught (G-316), and the flush is coalesced to ONE microtask per
 * batch so a burst of mutations costs one re-derivation.
 *
 * PURITY: this module owns DATA only — no React, no store, no keydown listener.
 * The one side effect is the observer install + the two body hooks it owns
 * (`data-fredo-hotkey-count`, `data-fredo-hotkey-duplicate`; G-266).
 *
 * DUPLICATE ENFORCEMENT (G-275/G-300): on every flush the listing is scanned for
 * two entries sharing the same grammar key. In `import.meta.env.DEV` this
 * THROWS `DuplicateHotkeyError`; the body hook and a `console.error` are ALWAYS
 * published first, in every environment.
 *
 * REVISION (AGENTS.md #523): `getElementHotkeyRevision()` advances ONLY on a real
 * diff of the listing, and `listElementHotkeys()` keeps its array identity until
 * such a diff — so a `useSyncExternalStore` consumer never sees a fresh snapshot
 * on an unrelated mutation.
 */

import { DATA_HOTKEY_PATTERN, parseDataHotkey, type HotkeyGrammar } from './hotkeyGrammar';

/** The declared attribute this module discovers. */
export const DATA_HOTKEY_ATTR = 'data-hotkey';
/** The optional title-override attribute (`data-hotkey-label`). */
export const DATA_HOTKEY_LABEL_ATTR = 'data-hotkey-label';
/** The bubbling fallback event `activateHotkeyElement` dispatches. */
export const HOTKEY_ACTIVATE_EVENT = 'hotkey-activate';
/** Body hook — the mounted valid element count (absent before install). */
export const BODY_HOTKEY_COUNT_ATTR = 'data-fredo-hotkey-count';
/** Body hook — `"true"` while a duplicate key is present. */
export const BODY_HOTKEY_DUPLICATE_ATTR = 'data-fredo-hotkey-duplicate';
/**
 * Body hook — `"true"` while element hotkeys are suppressed (focus in a
 * text-entry control or a terminal session). Owned by ST-1's status surface
 * (G-266); driven by the bar model's `disabled` state.
 */
export const BODY_HOTKEYS_DISABLED_ATTR = 'data-fredo-hotkeys-disabled';

/** The key the dev-only `?hotkeyDupProbe=1` probe duplicates with itself. */
const DUP_PROBE_KEY = '0';
const DUP_PROBE_ID_PREFIX = 'fredo-hotkey-dup-probe-';

// ── Public types (plan API Contracts block) ──────────────────────────────────

/** One mounted, grammar-valid `data-hotkey` element. */
export interface HotkeyElementEntry {
  readonly element: HTMLElement;
  /** `'fredo.element.<key>#<n>'` — unique per element, stable across reorders. */
  readonly actionId: string;
  readonly grammar: HotkeyGrammar;
  /** `data-hotkey-label` || accessible name || `key.toUpperCase()`. */
  readonly title: string;
  readonly source: 'element';
}

/** The result of a duplicate-key scan. */
export interface DuplicateHotkeyResult {
  readonly duplicate: boolean;
  /** The shared key, or `null` when there is no duplicate. */
  readonly key: string | null;
  /** Every entry declaring the duplicated key (empty when no duplicate). */
  readonly entries: readonly HotkeyElementEntry[];
}

/** Thrown in DEV when two mounted elements declare the same key (AC3 / R-3.4). */
export class DuplicateHotkeyError extends Error {
  readonly key: string;
  readonly entries: readonly HotkeyElementEntry[];

  constructor(result: DuplicateHotkeyResult) {
    const key = result.key ?? '';
    super(
      `Duplicate data-hotkey "${key}" declared by ${result.entries.length} mounted elements.`,
    );
    this.name = 'DuplicateHotkeyError';
    this.key = key;
    this.entries = result.entries;
  }
}

// ── Module state (stable identities; only a real diff replaces `entries`) ─────

let entries: readonly HotkeyElementEntry[] = Object.freeze([]);
let revision = 0;
let observer: MutationObserver | null = null;
let installCount = 0;
let flushScheduled = false;
let lastInvalidSignature = '';
const listeners = new Set<() => void>();
let elementIndexes = new WeakMap<HTMLElement, number>();
let nextElementIndex = 0;

// ── Reads + subscription ─────────────────────────────────────────────────────

/** The current document-ordered listing. Identity is stable between real diffs. */
export function listElementHotkeys(): readonly HotkeyElementEntry[] {
  return entries;
}

/** Monotonic revision; advances only when the listing actually changes. */
export function getElementHotkeyRevision(): number {
  return revision;
}

/** Subscribe to listing changes; returns the unsubscribe handle. */
export function subscribeElementHotkeys(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ── Duplicate detection ──────────────────────────────────────────────────────

/**
 * Scan `candidate` (defaults to the current listing) for two entries sharing
 * the same grammar key. PURE — no hooks, no throw; the flush enforces the
 * duplicate via `publishDuplicateHook` + the DEV throw.
 */
export function detectDuplicateHotkeys(
  candidate?: readonly HotkeyElementEntry[],
): DuplicateHotkeyResult {
  const list = candidate ?? entries;
  const groups = new Map<string, HotkeyElementEntry[]>();
  for (const entry of list) {
    const bucket = groups.get(entry.grammar.key);
    if (bucket) bucket.push(entry);
    else groups.set(entry.grammar.key, [entry]);
  }
  for (const [key, group] of groups) {
    if (group.length > 1) return { duplicate: true, key, entries: group };
  }
  return { duplicate: false, key: null, entries: [] };
}

// ── Activation ───────────────────────────────────────────────────────────────

/**
 * Activate a declared element (plan A4, binding): `click()` when the element is
 * clickable (`BUTTON` / `A[href]` / `role=button`), else `focus()` when it is
 * focusable, else a bubbling `CustomEvent('hotkey-activate')` for custom
 * controls. Never throws on a detached element.
 */
export function activateHotkeyElement(element: HTMLElement): void {
  if (!element) return;
  if (isClickable(element)) {
    element.click();
    return;
  }
  if (isFocusable(element)) {
    element.focus();
    return;
  }
  element.dispatchEvent(
    new CustomEvent(HOTKEY_ACTIVATE_EVENT, { bubbles: true, cancelable: true }),
  );
}

function isClickable(element: HTMLElement): boolean {
  const tag = element.tagName;
  if (tag === 'BUTTON') return true;
  if (tag === 'A' && element.hasAttribute('href')) return true;
  return element.getAttribute('role') === 'button';
}

function isFocusable(element: HTMLElement): boolean {
  return typeof element.focus === 'function' && element.tabIndex >= 0;
}

// ── Body hooks (ST-1-owned, G-266) ───────────────────────────────────────────

/**
 * Publish the suppressed state onto `document.body[data-fredo-hotkeys-disabled]`.
 * The hook's writer is ST-1's status surface (G-266); the disabled state itself
 * is derived by the ST-2 bar model from the focus snapshot and handed here.
 */
export function setElementHotkeysDisabled(disabled: boolean): void {
  if (typeof document === 'undefined' || !document.body) return;
  if (disabled) {
    if (document.body.getAttribute(BODY_HOTKEYS_DISABLED_ATTR) !== 'true') {
      document.body.setAttribute(BODY_HOTKEYS_DISABLED_ATTR, 'true');
    }
  } else if (document.body.hasAttribute(BODY_HOTKEYS_DISABLED_ATTR)) {
    document.body.removeAttribute(BODY_HOTKEYS_DISABLED_ATTR);
  }
}

// ── Discovery install ────────────────────────────────────────────────────────

/**
 * Install the ONE document-wide MutationObserver + initial full scan. Idempotent
 * by reference count: the first call creates the observer and every caller
 * receives an unsubscribe; the observer disconnects when the last one runs.
 * Returns a no-op unsubscribe when there is no DOM (SSR / node).
 */
export function installHotkeyElementDiscovery(): () => void {
  if (typeof document === 'undefined' || !document.body) return () => {};

  if (observer === null) {
    observer = new MutationObserver(() => scheduleFlush());
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [DATA_HOTKEY_ATTR],
    });
    // Initial full scan — publishes the pre-existing mounted set.
    runFlush();
    // The dev-only duplicate probe is appended AFTER the initial scan so its
    // duplicate is reported by the scheduled flush, not thrown out of install.
    mountDuplicateProbeIfRequested();
  }

  installCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    installCount = Math.max(0, installCount - 1);
    if (installCount === 0 && observer !== null) {
      observer.disconnect();
      observer = null;
    }
  };
}

/**
 * Synchronously re-scan the document and publish the listing. Used internally by
 * the observer's coalesced flush and exposed for deterministic unit testing (and
 * a manual refresh). Throws `DuplicateHotkeyError` in DEV after publishing the
 * hooks, exactly as the observer flush does.
 */
export function flushElementHotkeys(): void {
  runFlush();
}

/** Reset all module state + observers (tests only). */
export function resetHotkeyElementDiscoveryForTests(): void {
  if (observer !== null) {
    observer.disconnect();
    observer = null;
  }
  installCount = 0;
  flushScheduled = false;
  entries = Object.freeze([]);
  revision = 0;
  lastInvalidSignature = '';
  listeners.clear();
  elementIndexes = new WeakMap<HTMLElement, number>();
  nextElementIndex = 0;
  if (typeof document !== 'undefined' && document.body) {
    document.body.removeAttribute(BODY_HOTKEY_COUNT_ATTR);
    document.body.removeAttribute(BODY_HOTKEY_DUPLICATE_ATTR);
    document.body.removeAttribute(BODY_HOTKEYS_DISABLED_ATTR);
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    try {
      runFlush();
    } catch (error) {
      if (error instanceof DuplicateHotkeyError) {
        // A DEV-only hard error: surface it as an uncaught async error (the
        // developer sees it) without tearing down the observer, so recovery
        // after the duplicate is removed is still observed.
        queueMicrotask(() => {
          throw error;
        });
        return;
      }
      throw error;
    }
  });
}

function runFlush(): void {
  if (typeof document === 'undefined' || !document.body) return;
  const scanned = scanHotkeyElements();
  logInvalid(scanned.invalid);

  if (!sameEntries(entries, scanned.entries)) {
    entries = scanned.entries;
    revision += 1;
    for (const listener of [...listeners]) listener();
  }

  publishCountHook(entries.length);

  const result = detectDuplicateHotkeys(entries);
  publishDuplicateHook(result);
  if (result.duplicate) {
    const error = new DuplicateHotkeyError(result);
    console.error(`[hotkeys] ${error.message}`);
    if (isDev()) throw error;
  }
}

interface InvalidHotkey {
  readonly raw: string | null;
}

function scanHotkeyElements(): {
  entries: HotkeyElementEntry[];
  invalid: InvalidHotkey[];
} {
  const nodes = document.querySelectorAll<HTMLElement>(`[${DATA_HOTKEY_ATTR}]`);
  const list: HotkeyElementEntry[] = [];
  const invalid: InvalidHotkey[] = [];
  nodes.forEach((element) => {
    const raw = element.getAttribute(DATA_HOTKEY_ATTR);
    const grammar = parseDataHotkey(raw);
    if (grammar === null) {
      invalid.push({ raw });
      return;
    }
    list.push({
      element,
      actionId: actionIdFor(element, grammar.key),
      grammar,
      title: resolveTitle(element, grammar.key),
      source: 'element',
    });
  });
  list.sort((left, right) => compareDocumentOrder(left.element, right.element));
  return { entries: list, invalid };
}

/** `Node.DOCUMENT_POSITION_*` bit flags, inlined so no DOM global is required. */
const DOCUMENT_POSITION_PRECEDING = 2;
const DOCUMENT_POSITION_FOLLOWING = 4;

function compareDocumentOrder(left: HTMLElement, right: HTMLElement): number {
  if (left === right) return 0;
  const position = left.compareDocumentPosition(right);
  if (position & DOCUMENT_POSITION_FOLLOWING) return -1;
  if (position & DOCUMENT_POSITION_PRECEDING) return 1;
  return 0;
}

function sameEntries(
  previous: readonly HotkeyElementEntry[],
  next: readonly HotkeyElementEntry[],
): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (let i = 0; i < previous.length; i += 1) {
    const before = previous[i];
    const after = next[i];
    if (before.element !== after.element) return false;
    if (before.actionId !== after.actionId) return false;
    if (before.grammar.serialized !== after.grammar.serialized) return false;
    if (before.title !== after.title) return false;
  }
  return true;
}

function actionIdFor(element: HTMLElement, key: string): string {
  let index = elementIndexes.get(element);
  if (index === undefined) {
    index = nextElementIndex;
    nextElementIndex += 1;
    elementIndexes.set(element, index);
  }
  return `fredo.element.${key}#${index}`;
}

function resolveTitle(element: HTMLElement, key: string): string {
  const label = element.getAttribute(DATA_HOTKEY_LABEL_ATTR);
  if (label !== null && label.trim().length > 0) return label.trim();
  const aria = element.getAttribute('aria-label');
  if (aria !== null && aria.trim().length > 0) return aria.trim();
  const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (text.length > 0) return text;
  const title = element.getAttribute('title');
  if (title !== null && title.trim().length > 0) return title.trim();
  const alt = element.getAttribute('alt');
  if (alt !== null && alt.trim().length > 0) return alt.trim();
  return key.toUpperCase();
}

function logInvalid(invalid: readonly InvalidHotkey[]): void {
  const signature = invalid
    .map((item) => item.raw ?? '')
    .sort()
    .join('\u0000');
  if (signature === lastInvalidSignature) return;
  lastInvalidSignature = signature;
  for (const item of invalid) {
    console.error(
      `[hotkeys] Ignoring invalid data-hotkey="${item.raw ?? ''}" — expected ${String(
        DATA_HOTKEY_PATTERN,
      )}.`,
    );
  }
}

function publishCountHook(count: number): void {
  if (typeof document === 'undefined' || !document.body) return;
  const value = String(count);
  if (document.body.getAttribute(BODY_HOTKEY_COUNT_ATTR) !== value) {
    document.body.setAttribute(BODY_HOTKEY_COUNT_ATTR, value);
  }
}

function publishDuplicateHook(result: DuplicateHotkeyResult): void {
  if (typeof document === 'undefined' || !document.body) return;
  if (result.duplicate) {
    if (document.body.getAttribute(BODY_HOTKEY_DUPLICATE_ATTR) !== 'true') {
      document.body.setAttribute(BODY_HOTKEY_DUPLICATE_ATTR, 'true');
    }
  } else if (document.body.hasAttribute(BODY_HOTKEY_DUPLICATE_ATTR)) {
    document.body.removeAttribute(BODY_HOTKEY_DUPLICATE_ATTR);
  }
}

/**
 * DEV-only duplicate lever (plan ST-1): `?hotkeyDupProbe=1` mounts two hidden
 * spans declaring the SAME key, so the duplicate path is inducible without any
 * app-side change (G-316).
 */
function mountDuplicateProbeIfRequested(): void {
  if (!isDev()) return;
  if (typeof window === 'undefined' || typeof document === 'undefined' || !document.body) return;
  const search = window.location.search ?? '';
  if (!search.includes('hotkeyDupProbe')) return;
  if (document.getElementById(`${DUP_PROBE_ID_PREFIX}0`) !== null) return;
  for (let i = 0; i < 2; i += 1) {
    const probe = document.createElement('span');
    probe.id = `${DUP_PROBE_ID_PREFIX}${i}`;
    probe.setAttribute(DATA_HOTKEY_ATTR, DUP_PROBE_KEY);
    probe.setAttribute(DATA_HOTKEY_LABEL_ATTR, 'Duplicate hotkey probe');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.display = 'none';
    document.body.appendChild(probe);
  }
}

function isDev(): boolean {
  return import.meta.env?.DEV === true;
}
