/**
 * Spec #2946 ST-14 — the app-wide hotkey cheat-sheet overlay (plan UI/UX §1;
 * AC3 / PO#10 item 2; fixes F-31 — the previously dead `fredo.help.cheatsheet`
 * action).
 *
 * The shipped `?` (global) and `@leader ?` (Vim preset) actions must open a
 * real, searchable mapping list app-wide — NOT depend on the Settings window
 * being open. This overlay is mounted ONCE by `HotkeysProvider` beside the
 * which-key overlay, and it reuses the ST-3 `Keycap` + the ST-2 registry listing
 * (no second listing implementation).
 *
 * Model:
 *   - module-scoped open state (`openCheatSheet`/`closeCheatSheet` /
 *     `useCheatSheetOpen`) so non-React callers (the engine handler) can open it
 *     without a hook and without a second `document` keydown listener — the
 *     engine consumes the `?` chord itself;
 *   - `registerHotkeyHandler('fredo.help.cheatsheet', openCheatSheet)` on mount
 *     (cleared with `null` on unmount);
 *   - rows come from `listHotkeyActions()` with the effective binding
 *     (`keymap.bindings[id]` else `action.defaultSequence`), grouped
 *     Fredo-then-feature; each row = title + `Keycap`(s) + tier tag;
 *   - the search input matches title / action id / feature / key text; a
 *     no-match query shows `hotkeys-cheatsheet-empty` (`role="status"`);
 *   - the search is focused on open, Escape closes and returns focus to the
 *     invoker, and `Hotkey cheat sheet. N bindings.` is announced through the
 *     ONE shared `announce` channel.
 *
 * Accessibility: the root is `role="dialog" aria-modal="true"`; Escape is owned
 * by a React `onKeyDown` on the root (the engine leaves Escape to a modal — it
 * does NOT add a second document listener). The visual rows carry no live region;
 * the ST-3 announcer speaks.
 *
 * Colour is theme-token / CSS-var / `tint()` only — zero hex/rgba, zero
 * `var(--x)NN` alpha-append.
 */

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Button, chakra, HStack, Input, Text, VStack } from '@chakra-ui/react';
import { LuX } from 'react-icons/lu';

import { Keycap } from '../components/hotkeys/Keycap';
import { announce } from './announcer';
import { describeSequence } from './describe';
import { listHotkeyActions, registerHotkeyHandler } from './registry';
import { getKeymap, useHotkeyRevision } from './store';
import type { HotkeyActionId, HotkeyTier, Platform, RegisteredHotkeyAction } from './types';

// ── Action id + contract testids (plan contract block 7 / UI/UX §1) ──────────

/** The one action this overlay handles (declared by the engine). */
export const CHEATSHEET_ACTION_ID: HotkeyActionId = 'fredo.help.cheatsheet';

export const CHEATSHEET_OVERLAY_TESTID = 'hotkeys-cheatsheet-overlay';
export const CHEATSHEET_SEARCH_TESTID = 'hotkeys-cheatsheet-search';
export const CHEATSHEET_LIST_TESTID = 'hotkeys-cheatsheet-list';
export const CHEATSHEET_ROW_TESTID = 'hotkeys-cheatsheet-row';
export const CHEATSHEET_GROUP_TESTID = 'hotkeys-cheatsheet-group';
export const CHEATSHEET_EMPTY_TESTID = 'hotkeys-cheatsheet-empty';
export const CHEATSHEET_CLOSE_TESTID = 'hotkeys-cheatsheet-close';

/** Above the which-key overlay (1400) — the cheat sheet is a deliberate modal. */
export const CHEATSHEET_Z_INDEX = 1500;

/** The fixed accessible name of the surface. */
export const CHEATSHEET_ARIA_LABEL = 'Hotkey cheat sheet';

// ── Row model ────────────────────────────────────────────────────────────────

/** One listed action + its effective serialized bindings. */
export interface CheatSheetEntry {
  readonly action: RegisteredHotkeyAction;
  readonly bindings: readonly string[];
}

/** A Fredo-first group (the Fredo tier, then one per contributing feature). */
export interface CheatSheetGroup {
  readonly key: string;
  readonly label: string;
  readonly tier: HotkeyTier;
  readonly featureId: string | null;
  readonly entries: readonly CheatSheetEntry[];
}

/** The effective bindings for a listing row: an explicit keymap entry wins. */
export function effectiveCheatSheetBindings(
  action: RegisteredHotkeyAction,
  bindings: Readonly<Record<string, readonly string[]>>,
): readonly string[] {
  const explicit = bindings[action.actionId];
  if (explicit !== undefined) return explicit;
  return action.defaultSequence ? [action.defaultSequence] : [];
}

/**
 * Collect the live listing grouped Fredo-then-feature. Invalid declarations are
 * skipped (they are never dispatchable); actions with no effective binding are
 * still listed (matching the Settings pane) and render as "Unbound".
 */
export function collectCheatSheetGroups(): readonly CheatSheetGroup[] {
  const keymap = getKeymap();
  const fredoEntries: CheatSheetEntry[] = [];
  const featureEntries = new Map<string, CheatSheetEntry[]>();

  for (const action of listHotkeyActions()) {
    if (action.invalid) continue;
    const entry: CheatSheetEntry = {
      action,
      bindings: [...effectiveCheatSheetBindings(action, keymap.bindings)],
    };
    if (action.tier === 'fredo' || !action.featureId) {
      fredoEntries.push(entry);
      continue;
    }
    const existing = featureEntries.get(action.featureId) ?? [];
    existing.push(entry);
    featureEntries.set(action.featureId, existing);
  }

  const groups: CheatSheetGroup[] = [];
  if (fredoEntries.length > 0) {
    groups.push({
      key: 'fredo',
      label: 'Fredo (global)',
      tier: 'fredo',
      featureId: null,
      entries: fredoEntries,
    });
  }
  for (const [featureId, entries] of featureEntries) {
    groups.push({
      key: featureId,
      label: featureId,
      tier: 'feature',
      featureId,
      entries,
    });
  }
  return groups;
}

function tierTag(tier: HotkeyTier): string {
  return tier === 'fredo' ? 'Global' : 'Feature';
}

function tierAttr(group: CheatSheetGroup): string {
  return group.tier === 'fredo' ? 'global' : `feature:${group.featureId ?? 'unknown'}`;
}

/** The lower-cased search haystack for one row (title / id / feature / key text). */
export function cheatSheetEntryHaystack(entry: CheatSheetEntry, featureId: string | null): string {
  const displays = entry.bindings.map((binding) => describeSequence(binding).display);
  return [
    entry.action.title,
    entry.action.actionId,
    featureId ?? 'fredo',
    ...entry.bindings,
    ...displays,
  ]
    .join(' ')
    .toLowerCase();
}

// ── Module-scoped open state (non-React callers can open it) ─────────────────

let cheatSheetOpen = false;
/** The element focused when the sheet opened — focus returns here on close. */
let invoker: HTMLElement | null = null;
const listeners = new Set<() => void>();

function notifyCheatSheet(): void {
  for (const listener of [...listeners]) listener();
}

/** Subscribe to open/close changes (`useSyncExternalStore` source). */
export function subscribeCheatSheet(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current open flag — a stable boolean snapshot. */
export function getCheatSheetOpen(): boolean {
  return cheatSheetOpen;
}

/** Open the cheat sheet, remembering the invoker for focus return. */
export function openCheatSheet(): void {
  if (cheatSheetOpen) return;
  const active = typeof document === 'undefined' ? null : document.activeElement;
  invoker = active instanceof HTMLElement ? active : null;
  cheatSheetOpen = true;
  notifyCheatSheet();
}

/** Close the cheat sheet and restore focus to the invoker. */
export function closeCheatSheet(): void {
  if (!cheatSheetOpen) return;
  cheatSheetOpen = false;
  notifyCheatSheet();
  const target = invoker;
  invoker = null;
  if (target && target.isConnected && typeof target.focus === 'function') target.focus();
}

/** Test-only: drop the module-scoped state. Never call from app code. */
export function resetCheatSheetForTests(): void {
  cheatSheetOpen = false;
  invoker = null;
  listeners.clear();
}

/** React binding for the open flag. */
export function useCheatSheetOpen(): boolean {
  return useSyncExternalStore(subscribeCheatSheet, getCheatSheetOpen, getCheatSheetOpen);
}

// ── Component ────────────────────────────────────────────────────────────────

export interface CheatSheetOverlayProps {
  /** Layout override so keycap display is deterministic in tests. */
  readonly platform?: Platform;
}

/**
 * Renders the app-wide cheat sheet. Mounted ONCE by `HotkeysProvider`; it
 * renders nothing until opened.
 */
export function CheatSheetOverlay({ platform }: CheatSheetOverlayProps) {
  const open = useCheatSheetOpen();
  const revision = useHotkeyRevision();
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Rebuild when the keymap mutates (`revision`) OR the sheet opens — the engine
  // registers its shipped default actions without touching the store revision,
  // so the open transition must also refresh the listing.
  const groups = useMemo(() => collectCheatSheetGroups(), [revision, open]);

  // Register the ONE handler for the shipped `?` action; clear it on unmount so
  // a torn-down provider can never leave a stale handler behind.
  useEffect(() => {
    registerHotkeyHandler(CHEATSHEET_ACTION_ID, openCheatSheet);
    return () => registerHotkeyHandler(CHEATSHEET_ACTION_ID, null);
  }, []);

  // Focus the search on open and announce the sheet once per open. `groups` is
  // intentionally excluded: a live keymap edit while open must not re-announce.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    searchRef.current?.focus();
    const count = groups.reduce((total, group) => total + group.entries.length, 0);
    announce(`Hotkey cheat sheet. ${count} bindings.`);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const normalizedQuery = query.trim().toLowerCase();
  const visibleGroups = useMemo(() => {
    if (normalizedQuery.length === 0) return groups;
    return groups
      .map((group) => ({
        ...group,
        entries: group.entries.filter((entry) =>
          cheatSheetEntryHaystack(entry, group.featureId).includes(normalizedQuery),
        ),
      }))
      .filter((group) => group.entries.length > 0);
  }, [groups, normalizedQuery]);

  if (!open) return null;

  const visibleCount = visibleGroups.reduce((total, group) => total + group.entries.length, 0);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeCheatSheet();
  };

  return (
    <Box
      data-testid={CHEATSHEET_OVERLAY_TESTID}
      role="dialog"
      aria-modal="true"
      aria-label={CHEATSHEET_ARIA_LABEL}
      onKeyDown={handleKeyDown}
      position="fixed"
      inset="0"
      zIndex={CHEATSHEET_Z_INDEX}
      bg="overlay.scrim"
      display="flex"
      alignItems="flex-start"
      justifyContent="center"
      paddingX="4"
      paddingTop="10vh"
    >
      <Box
        bg="bg.surface"
        borderWidth="1px"
        borderColor="border.default"
        borderRadius="md"
        boxShadow="var(--shadow-dialog)"
        width="min(680px, 94vw)"
        maxHeight="76vh"
        display="flex"
        flexDirection="column"
        overflow="hidden"
      >
        <HStack justify="space-between" align="center" gap={3} paddingX="4" paddingY="3">
          <Text fontSize="md" fontWeight="600" color="fg.default">
            {CHEATSHEET_ARIA_LABEL}
          </Text>
          <Button
            data-testid={CHEATSHEET_CLOSE_TESTID}
            size="xs"
            variant="ghost"
            aria-label="Close hotkey cheat sheet"
            onClick={closeCheatSheet}
          >
            <LuX />
          </Button>
        </HStack>

        <Box paddingX="4" paddingBottom="3">
          <Input
            ref={searchRef}
            data-testid={CHEATSHEET_SEARCH_TESTID}
            aria-label="Search hotkeys"
            placeholder="Search actions, keys, or features"
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </Box>

        <Box data-testid={CHEATSHEET_LIST_TESTID} overflowY="auto" paddingX="4" paddingBottom="4">
          {visibleCount === 0 ? (
            <Text data-testid={CHEATSHEET_EMPTY_TESTID} role="status" fontSize="sm" color="fg.muted">
              {`No hotkeys match "${query.trim()}".`}
            </Text>
          ) : (
            <VStack align="stretch" gap={4}>
              {visibleGroups.map((group) => (
                <VStack key={group.key} align="stretch" gap={1}>
                  <Text
                    data-testid={CHEATSHEET_GROUP_TESTID}
                    data-hotkey-group={group.key}
                    fontSize="xs"
                    fontWeight="700"
                    color="fg.muted"
                    letterSpacing="wider"
                    textTransform="uppercase"
                  >
                    {group.label}
                  </Text>
                  {group.entries.map((entry) => (
                    <HStack
                      key={entry.action.actionId}
                      data-testid={CHEATSHEET_ROW_TESTID}
                      data-hotkey-action={entry.action.actionId}
                      data-hotkey-tier={tierAttr(group)}
                      data-hotkey-group={group.key}
                      gap={2}
                      wrap="wrap"
                      paddingY="1"
                    >
                      <Text fontSize="sm" color="fg.default">
                        {entry.action.title}
                      </Text>
                      {entry.bindings.length > 0 ? (
                        entry.bindings.map((binding) => (
                          <Keycap key={binding} sequence={binding} platform={platform} />
                        ))
                      ) : (
                        <Text fontSize="xs" color="fg.muted">
                          Unbound
                        </Text>
                      )}
                      <chakra.span
                        fontSize="xs"
                        color="fg.muted"
                        bg="bg.subtle"
                        borderRadius="sm"
                        paddingX="1.5"
                        paddingY="0.5"
                        whiteSpace="nowrap"
                      >
                        {tierTag(group.tier)}
                      </chakra.span>
                    </HStack>
                  ))}
                </VStack>
              ))}
            </VStack>
          )}
        </Box>
      </Box>
    </Box>
  );
}
