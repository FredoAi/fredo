/**
 * Wireframe toolbar controls + insert menus (Spec #3070, ST-3, UI/UX 2.1/2.2).
 *
 * Every control here is driven by the ONE command table in
 * `actions/wireframeActions.ts`: the button's `data-hotkey`, its testid and the
 * action it runs all come from the same row, so a shortcut can never diverge
 * from its visible control.
 *
 * Presentation rules (binding):
 * - a real `<button>` (Chakra `Button`) — the shipped hotkey activator clicks
 *   buttons, and the element is a normal Tab stop (the toolbar is a `group`,
 *   never an ARIA `toolbar` with roving tabindex);
 * - `data-hotkey` exists ONLY while `useWireframeHostFocused()` is true. An
 *   OPEN but unfocused window stays mounted, so leaving the attribute mounted
 *   would list this app's shortcuts in the always-on bar and dispatch them
 *   into the wrong window (R-5.4). The keychip slot stays in the layout and
 *   flips to `visibility: hidden`, so focus changes never shift the row;
 * - a POINTER activation (`event.detail > 0`) blurs the control after running
 *   its action so the next bare key is in the `default` context (G-327,
 *   UI/UX 3.14); a keyboard activation (`detail === 0`) keeps focus for Tab
 *   users, and an engine-driven activation never moves focus at all.
 *
 * Tokens only: semantic tokens and the shared `tint()` helper — never a
 * hex/rgba literal, never an alpha-append onto a `var()`.
 */

import React from 'react';
import {
  Box,
  Button,
  HStack,
  Icon,
  Menu,
  Portal,
  Text,
  Tooltip,
} from '@chakra-ui/react';
import type { IconType } from 'react-icons';
import {
  LuChevronDown,
  LuLayoutPanelTop,
  LuShapes,
} from 'react-icons/lu';

import { Keycap } from '../../../shared/components/hotkeys/Keycap';
import { parseDataHotkey } from '../../../shared/hotkeys/hotkeyGrammar';
import { tint } from '../../../shared/utils/colorTint';
import {
  findWireframeAction,
  wireframeActionTestId,
} from '../actions/wireframeActions';

export interface WireframeActionButtonProps {
  /** C4 action id this control performs. */
  readonly actionId: string;
  /** Visible label (the `full` density only). */
  readonly label: string;
  /** Human description used for the tooltip and the compact accessible name. */
  readonly description: string;
  readonly icon: IconType;
  /** `full` = icon + label + keychip (Insert); `compact` = icon + keychip. */
  readonly density: 'full' | 'compact';
  /** True while the Wireframe host owns focus (controls `data-hotkey`). */
  readonly focused: boolean;
  readonly disabled?: boolean;
  /** Toggle state (`aria-pressed`); `undefined` for a plain button. */
  readonly pressed?: boolean;
  readonly onActivate: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

/**
 * One action control. The binding, testid and accessible name all derive from
 * the table row, so a new entry needs no markup change beyond its icon/label.
 */
export function WireframeActionButton({
  actionId,
  label,
  description,
  icon,
  density,
  focused,
  disabled = false,
  pressed,
  onActivate,
}: WireframeActionButtonProps): React.ReactElement {
  const action = findWireframeAction(actionId);
  const hotkey = action?.hotkey;
  const testId = wireframeActionTestId(actionId);
  const accessibleName = hotkey
    ? `${density === 'full' ? label : description} (${hotkey})`
    : density === 'full'
      ? label
      : description;

  const button = (
    <Button
      data-testid={testId}
      // Attribute REMOVAL is what the shipped MutationObserver watches, so the
      // unfocused state must omit the attribute entirely (never `''`).
      data-hotkey={focused && hotkey ? hotkey : undefined}
      // The always-on bar prefers this over the accessible name, so a row reads
      // "Duplicate" beside the P chip instead of "Duplicate (p)" (R-5.2).
      data-hotkey-label={hotkey ? (density === 'full' ? label : description) : undefined}
      size="sm"
      variant="ghost"
      px={2}
      gap={1.5}
      flexShrink={0}
      aria-label={accessibleName}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onActivate}
      bg={pressed ? tint('var(--accent-primary)', 18) : undefined}
      // #3086 ST-4 (G-235 substitution) — the label stays `fg.default` in EVERY
      // state (default / hover / pressed). The accent signal is the FILL
      // (`control-ghost|hover|label` = 10 % tint, `control-ghost|active|label` =
      // 18 % tint); `accent.default` on its own faint tint was the sub-floor
      // pair. The gate validates `fg.default` on the composed accent fill.
      color="fg.default"
      _hover={{ bg: tint('var(--accent-primary)', 10) }}
    >
      <Icon as={icon} boxSize={3.5} aria-hidden="true" />
      {density === 'full' ? (
        <Text as="span" fontSize="xs" whiteSpace="nowrap">
          {label}
        </Text>
      ) : null}
      {hotkey ? (
        <Box
          as="span"
          data-testid="wireframe-hotkey-chip"
          aria-hidden="true"
          display="inline-flex"
          // The slot is always reserved; only its visibility flips, so the row
          // never reflows when focus leaves the Wireframe window (UI/UX 3.13).
          visibility={focused ? 'visible' : 'hidden'}
        >
          {/*
           * Two-step display conversion (Spec #3071, ST-4): `Keycap` parses its
           * input with the SPACE-joined `parseSequence`, so a raw `'g+g'` is one
           * unrepresentable token and renders nothing. `parseDataHotkey` converts
           * the grammar form to its serialized form (`'g g'` -> chips "G" "G");
           * `data-hotkey` above keeps the `'g+g'` grammar value.
           */}
          <Keycap sequence={parseDataHotkey(hotkey)?.serialized ?? hotkey} />
        </Box>
      ) : null}
    </Button>
  );

  if (density === 'full') return button;

  return (
    <Tooltip.Root
      openDelay={400}
      closeDelay={0}
      positioning={{ placement: 'bottom' }}
    >
      <Tooltip.Trigger asChild>{button}</Tooltip.Trigger>
      <Portal>
        <Tooltip.Positioner>
          <Tooltip.Content
            bg="bg.surface"
            color="fg.default"
            borderWidth="1px"
            borderColor="border.subtle"
            borderRadius="sm"
            fontSize="xs"
            px={2}
            py={1}
          >
            {hotkey ? `${description} (${hotkey})` : description}
          </Tooltip.Content>
        </Tooltip.Positioner>
      </Portal>
    </Tooltip.Root>
  );
}

type InsertMenuKind = 'section' | 'shape';

interface InsertMenuOption {
  readonly value: string;
  readonly label: string;
}

interface InsertMenuSpec {
  readonly actionId: string;
  readonly label: string;
  readonly icon: IconType;
  readonly chevronLabel: string;
  readonly menuLabel: string;
  readonly options: readonly InsertMenuOption[];
}

const INSERT_MENUS: Readonly<Record<InsertMenuKind, InsertMenuSpec>> = {
  section: {
    actionId: 'wireframe.add.section',
    label: 'Section',
    icon: LuLayoutPanelTop,
    chevronLabel: 'Section presets',
    menuLabel: 'Section presets',
    options: [
      { value: 'header', label: 'Header' },
      { value: 'navbar', label: 'Nav bar' },
      { value: 'sidebar', label: 'Sidebar' },
      { value: 'footer', label: 'Footer' },
    ],
  },
  shape: {
    actionId: 'wireframe.add.shape',
    label: 'Shape',
    icon: LuShapes,
    chevronLabel: 'Shape kinds',
    menuLabel: 'Shape kinds',
    options: [
      { value: 'rect', label: 'Rectangle' },
      { value: 'ellipse', label: 'Ellipse' },
      { value: 'triangle', label: 'Triangle' },
    ],
  },
};

export interface WireframeInsertMenuProps {
  readonly kind: InsertMenuKind;
  /** True while the Wireframe host owns focus. */
  readonly focused: boolean;
  /**
   * Activate the main button (adds the default preset/kind). Receives the DOM
   * event so the toolbar can apply the pointer-activation blur rule.
   */
  readonly onAddDefault: (event: React.MouseEvent<HTMLButtonElement>) => void;
  /** Add one menu option (a named section preset or shape kind). */
  readonly onAddOption: (value: string) => void;
}

/**
 * An Insert-group control: the main action button plus a trailing chevron that
 * opens the preset/kind menu. The chevron carries NO `data-hotkey` — the same
 * first character would collide with its parent action (D2).
 */
export function WireframeInsertMenu({
  kind,
  focused,
  onAddDefault,
  onAddOption,
}: WireframeInsertMenuProps): React.ReactElement {
  const spec = INSERT_MENUS[kind];

  return (
    <HStack gap={0} flexShrink={0}>
      <WireframeActionButton
        actionId={spec.actionId}
        label={spec.label}
        description={spec.label}
        icon={spec.icon}
        density="full"
        focused={focused}
        onActivate={onAddDefault}
      />
      <Menu.Root positioning={{ placement: 'bottom-start' }}>
        <Menu.Trigger asChild>
          <Button
            size="xs"
            variant="ghost"
            px={1}
            flexShrink={0}
            aria-label={spec.chevronLabel}
            aria-haspopup="menu"
            color="fg.muted"
            _hover={{ bg: tint('var(--accent-primary)', 10) }}
          >
            <Icon as={LuChevronDown} boxSize={3} aria-hidden="true" />
          </Button>
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner>
            <Menu.Content
              aria-label={spec.menuLabel}
              minWidth="10rem"
              bg="bg.surface"
              borderColor="border.default"
              borderWidth="1px"
              borderRadius="sm"
              boxShadow="md"
              py={1}
            >
              {spec.options.map((option) => (
                <Menu.Item
                  key={option.value}
                  value={option.value}
                  onSelect={() => onAddOption(option.value)}
                  fontSize="xs"
                  color="fg.default"
                  px={3}
                  py="4px"
                  borderRadius="xs"
                  cursor="pointer"
                  whiteSpace="nowrap"
                  _highlighted={{ bg: 'bg.hover' }}
                >
                  {option.label}
                </Menu.Item>
              ))}
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
    </HStack>
  );
}
