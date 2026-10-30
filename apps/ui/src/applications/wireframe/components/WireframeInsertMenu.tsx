/**
 * Wireframe insert menus (Spec #3070, ST-3, UI/UX 2.1/2.2).
 *
 * Spec #3119 ST-4 retired the 33-control toolbar; ST-6 re-homes this module as
 * the ONE pointer affordance (`wireframe-insert`) inside the canvas region. The
 * exported button primitive is retained for that rewrite.
 *
 * Presentation rules (binding):
 * - a real `<button>` (Chakra `Button`) — a normal Tab stop;
 * - controls carry NO `data-hotkey`/`data-hotkey-label` (Spec #3098 ST-5); the
 *   legacy carrier and command surface are gone (Spec #3119 ST-4), so keyboard
 *   discovery belongs to the navigation rail/map;
 * - a POINTER activation (`event.detail > 0`) blurs the control after running
 *   its action so the next bare key is in the `default` context (G-327,
 *   UI/UX 3.14); a keyboard activation (`detail === 0`) keeps focus for Tab
 *   users.
 *
 * Tokens only: semantic tokens and the shared `tint()` helper — never a
 * hex/rgba literal, never an alpha-append onto a `var()`.
 */

import React from 'react';
import {
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

import { tint } from '../../../shared/utils/colorTint';
import { wireframeActionTestId } from '../actions/wireframeActions';

export interface WireframeActionButtonProps {
  /** C4 action id this control performs. */
  readonly actionId: string;
  /** Visible label (the `full` density only). */
  readonly label: string;
  /** Human description used for the tooltip and the compact accessible name. */
  readonly description: string;
  readonly icon: IconType;
  /** `full` = icon + label (Insert); `compact` = icon only. */
  readonly density: 'full' | 'compact';
  readonly disabled?: boolean;
  /** Toggle state (`aria-pressed`); `undefined` for a plain button. */
  readonly pressed?: boolean;
  readonly onActivate: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

/**
 * One action control. The testid and accessible name derive from the table row,
 * so a new entry needs no markup change beyond its icon/label. The control is a
 * plain `data-hotkey`-free button — its keyboard path is the command surface.
 */
export function WireframeActionButton({
  actionId,
  label,
  description,
  icon,
  density,
  disabled = false,
  pressed,
  onActivate,
}: WireframeActionButtonProps): React.ReactElement {
  const testId = wireframeActionTestId(actionId);
  const accessibleName = density === 'full' ? label : description;

  const button = (
    <Button
      data-testid={testId}
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
            {description}
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
