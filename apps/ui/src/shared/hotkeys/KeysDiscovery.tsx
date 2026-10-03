/**
 * Spec #2960 ST-3 — the always-present zero-knowledge discovery control + its
 * NON-MODAL key panel (EARS R-4.1, R-4.2, R-4.3).
 *
 * A user who knows no chord must be able to see the current context's keys and
 * how to enter keyboard mode just by looking. The control is a REAL `<button>`
 * (icon + the visible label `Keys`) rendered unconditionally for the whole
 * session — it is the mouse/touch on-ramp the `?` cheat-sheet chord cannot be for
 * a zero-knowledge user.
 *
 * The panel is the UI/UX `KeysDiscovery` form, NOT a modal and NOT a mode toggle:
 *   - it lists the ACTIVE context's keys from the engine's ONE listing
 *     (`resolveActiveBindings()`), context-scoped rows first (the
 *     `keyboardBarModel` ordering rule), each rendered with the shared `Keycap`;
 *   - a pinned mode-chord row (`Keycap(KEYBOARD_MODE_CHORD)` + `turn on keyboard
 *     mode`) sits OUTSIDE the scroll region and invokes the shipped
 *     `toggleKeyboardMode()` — no new chord, no new mode mechanism;
 *   - an empty context renders the defined `hotkeys-keys-discovery-empty` copy
 *     (`No keys in this context`) — never a blank panel.
 *
 * Non-goals (binding): NO `role="dialog"`/`aria-modal`, NO focus trap, NO
 * `document` `keydown` listener, NO `preventDefault` on printable keys, no new
 * chord/mode. Escape is owned by a React `onKeyDown` on the panel root (the same
 * pattern as `CheatSheetOverlay.tsx`); an outside `pointerdown` closes it.
 *
 * G-273/G-274: the panel is the ONE width clamp (`min(360px, 92vw)`); its ONE
 * ellipsis/shrink target is the action TITLE; the `Keycap` group, the tier tag,
 * the pinned mode-chord `Keycap`, and the close button are EXEMPT
 * (`flexShrink: 0`, `whiteSpace: nowrap`). The key list scrolls; the mode-chord
 * row is pinned outside the scroll region.
 *
 * Placement (G-253): fixed top-left, `left: 12px`, `top: measureTopOffsetPx()`
 * (the derived top-cluster inset), `z-index: KEYS_DISCOVERY_Z_INDEX` (1310) —
 * the same cluster layer as the regime chip (ST-2) and the first-run card (ST-4).
 *
 * Colour is theme-token / CSS-var / the shared `tint()` helper only — zero
 * hex/rgba/hsl, zero `var(--x)NN` alpha-append.
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, chakra, HStack, Icon, Text, VStack } from '@chakra-ui/react';
import { LuKeyboard, LuX } from 'react-icons/lu';

import { tint } from '../utils/colorTint';
import { Keycap } from '../components/hotkeys/Keycap';
import { useActiveHotkeyContext } from './contextStack';
import { resolveActiveBindings } from './engine';
import { KEYBOARD_MODE_CHORD, toggleKeyboardMode } from './keyboardMode';
import { useHotkeyRevision } from './store';
import { measureTopOffsetPx, TOP_STACK_ANCHOR_X_PX } from './topStack';
import { ROOT_CONTEXT_ID, type HotkeyTier, type Platform, type ResolvedBinding } from './types';

// ── Binding names (plan BINDING NAMES BLOCK, verbatim) ───────────────────────

export const KEYS_DISCOVERY_TESTID = 'hotkeys-keys-discovery';
export const KEYS_DISCOVERY_PANEL_TESTID = 'hotkeys-keys-discovery-panel';
export const KEYS_DISCOVERY_LIST_TESTID = 'hotkeys-keys-discovery-list';
export const KEYS_DISCOVERY_ROW_TESTID = 'hotkeys-keys-discovery-row';
export const KEYS_DISCOVERY_CHORD_TESTID = 'hotkeys-keys-discovery-mode-chord';
export const KEYS_DISCOVERY_EMPTY_TESTID = 'hotkeys-keys-discovery-empty';
export const KEYS_DISCOVERY_CLOSE_TESTID = 'hotkeys-keys-discovery-close';

// ── Render contract (G-273/G-274) ────────────────────────────────────────────

/** The ONE width clamp of the panel (G-274). */
export const KEYS_DISCOVERY_PANEL_WIDTH = 'min(360px, 92vw)';
/** The key list's bounded scroll region (`overflowY: auto`). */
export const KEYS_DISCOVERY_LIST_MAX_HEIGHT = 'min(40vh, 320px)';
/** The pinned mode-chord row copy (plan UI/UX §C). */
export const KEYS_DISCOVERY_CHORD_COPY = 'turn on keyboard mode';
/** The control's visible label (R-4.1). */
export const KEYS_DISCOVERY_CONTROL_LABEL = 'Keys';
/** The defined empty-context copy (R-4.2, never a blank panel). */
export const KEYS_DISCOVERY_EMPTY_COPY = 'No keys in this context';
/** Same top-left cluster layer as the regime signal; below which-key/cheat-sheet. */
export const KEYS_DISCOVERY_Z_INDEX = 1310;

/**
 * Whether a resolved binding is SCOPED to the active interaction context rather
 * than an always-on ROOT binding. Mirrors the shipped bar ordering rule
 * (`keyboardBarModel.ts` `isContextScoped`): feature-tier bindings are always
 * scoped; a Fredo-tier binding scoped to a non-ROOT context or descending into
 * one is scoped. Scoped rows render FIRST so the keys specific to where the user
 * is are never pushed below the fold.
 */
function isContextScoped(binding: ResolvedBinding): boolean {
  if (binding.tier === 'feature') return true;
  const { contextId, opensContextId } = binding.action;
  return (
    (contextId !== undefined && contextId !== ROOT_CONTEXT_ID) ||
    (opensContextId !== undefined && opensContextId !== ROOT_CONTEXT_ID)
  );
}

/** Scoped bindings first, preserving the resolver's relative order. */
export function orderDiscoveryBindings(
  bindings: readonly ResolvedBinding[],
): readonly ResolvedBinding[] {
  const scoped: ResolvedBinding[] = [];
  const alwaysOn: ResolvedBinding[] = [];
  for (const binding of bindings) {
    if (isContextScoped(binding)) scoped.push(binding);
    else alwaysOn.push(binding);
  }
  return [...scoped, ...alwaysOn];
}

function tierTag(tier: HotkeyTier): string {
  return tier === 'fredo' ? 'Global' : 'Feature';
}

export interface KeysDiscoveryProps {
  /** Layout override so keycap display is deterministic in tests. */
  readonly platform?: Platform;
}

/**
 * The always-present discovery control + its non-modal panel. Rendered
 * unconditionally; the panel only exists while open.
 */
export function KeysDiscovery({ platform }: KeysDiscoveryProps) {
  const [open, setOpen] = useState(false);
  const controlRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const revision = useHotkeyRevision();
  const contextSnapshot = useActiveHotkeyContext();

  // Derived top inset (G-253): re-measure the rendered header on mount + resize,
  // matching the regime chip's top-left cluster anchor.
  const [topPx, setTopPx] = useState<number>(() => measureTopOffsetPx());
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;
    const update = (): void => setTopPx(measureTopOffsetPx());
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  // Rebuild on a keymap mutation OR a context change; `open` refreshes the
  // listing on each activation (the engine registers shipped defaults without a
  // store revision bump, exactly like the cheat sheet).
  const rows = useMemo(
    () => orderDiscoveryBindings(resolveActiveBindings()),
    [revision, contextSnapshot, open],
  );

  // Move focus into the panel on open so Escape reaches its React handler and so
  // focus can be returned to the control on close. This is a single focus move —
  // NOT a focus trap (the page stays interactive).
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  // Outside pointer press closes. A `pointerdown` listener is explicitly allowed
  // (the non-goal forbids only a `document` keydown listener).
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (panelRef.current?.contains(target)) return;
      if (controlRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const close = (returnFocus: boolean): void => {
    setOpen(false);
    if (returnFocus) controlRef.current?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  };

  return (
    <Box
      style={{
        position: 'fixed',
        left: `${TOP_STACK_ANCHOR_X_PX}px`,
        top: `${topPx}px`,
        zIndex: KEYS_DISCOVERY_Z_INDEX,
      }}
      display="flex"
      flexDirection="column"
      alignItems="flex-start"
    >
      <Button
        ref={controlRef}
        data-testid={KEYS_DISCOVERY_TESTID}
        aria-expanded={open}
        aria-controls={KEYS_DISCOVERY_PANEL_TESTID}
        onClick={() => (open ? close(false) : setOpen(true))}
        size="sm"
        variant="outline"
        color="fg.default"
        borderColor="border.default"
        bg={open ? tint('var(--accent-primary)', 14) : 'bg.surface'}
        gap="2"
      >
        <Icon as={LuKeyboard} boxSize="4" aria-hidden="true" />
        <chakra.span>{KEYS_DISCOVERY_CONTROL_LABEL}</chakra.span>
      </Button>

      {open ? (
        <Box
          id={KEYS_DISCOVERY_PANEL_TESTID}
          data-testid={KEYS_DISCOVERY_PANEL_TESTID}
          ref={panelRef}
          tabIndex={-1}
          onKeyDown={handleKeyDown}
          position="absolute"
          top="calc(100% + 4px)"
          left="0"
          zIndex={1310}
          style={{ width: KEYS_DISCOVERY_PANEL_WIDTH, outline: 'none' }}
          bg="bg.surface"
          borderWidth="1px"
          borderColor="border.default"
          borderRadius="md"
          boxShadow="var(--shadow-dialog)"
          display="flex"
          flexDirection="column"
          overflow="hidden"
        >
          <HStack
            justify="space-between"
            align="center"
            gap={3}
            paddingX="3"
            paddingY="2"
            borderBottomWidth="1px"
            borderColor="border.subtle"
          >
            <Text
              fontSize="sm"
              fontWeight="600"
              color="fg.default"
              style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
            >
              Keys
            </Text>
            <Button
              data-testid={KEYS_DISCOVERY_CLOSE_TESTID}
              aria-label="Close keys panel"
              size="xs"
              variant="ghost"
              onClick={() => close(true)}
              style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
            >
              <LuX />
            </Button>
          </HStack>

          <Box
            data-testid={KEYS_DISCOVERY_LIST_TESTID}
            paddingX="3"
            paddingY="2"
            style={{ overflowY: 'auto', maxHeight: KEYS_DISCOVERY_LIST_MAX_HEIGHT }}
          >
            {rows.length === 0 ? (
              <Text data-testid={KEYS_DISCOVERY_EMPTY_TESTID} fontSize="sm" color="fg.muted">
                {KEYS_DISCOVERY_EMPTY_COPY}
              </Text>
            ) : (
              <VStack align="stretch" gap={1}>
                {rows.map((binding) => (
                  <HStack
                    key={`${binding.actionId}:${binding.serialized}`}
                    data-testid={KEYS_DISCOVERY_ROW_TESTID}
                    data-hotkey-action={binding.actionId}
                    data-hotkey-tier={binding.tier}
                    minWidth={0}
                    gap={2}
                    paddingY="1"
                  >
                    <Text
                      as="span"
                      data-keys-discovery-title="true"
                      fontSize="sm"
                      color="fg.default"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {binding.action.title}
                    </Text>
                    <Box data-keys-discovery-keycaps="true" style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
                      <Keycap sequence={binding.serialized} platform={platform} />
                    </Box>
                    <chakra.span
                      data-keys-discovery-tier="true"
                      fontSize="xs"
                      color="fg.muted"
                      bg="bg.subtle"
                      borderRadius="sm"
                      paddingX="1.5"
                      paddingY="0.5"
                      style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
                    >
                      {tierTag(binding.tier)}
                    </chakra.span>
                  </HStack>
                ))}
              </VStack>
            )}
          </Box>

          <Button
            data-testid={KEYS_DISCOVERY_CHORD_TESTID}
            onClick={toggleKeyboardMode}
            variant="ghost"
            size="sm"
            width="100%"
            justifyContent="flex-start"
            gap="2"
            borderTopWidth="1px"
            borderColor="border.subtle"
            bg="bg.subtle"
            color="fg.default"
            borderRadius="0"
            style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
          >
            <Box data-keys-discovery-chord-keycap="true" style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
              <Keycap sequence={KEYBOARD_MODE_CHORD} platform={platform} />
            </Box>
            <chakra.span style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
              {KEYS_DISCOVERY_CHORD_COPY}
            </chakra.span>
          </Button>
        </Box>
      ) : null}
    </Box>
  );
}
