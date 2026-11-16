/**
 * Wireframe insert menu (Spec #3070, ST-3, UI/UX 2.1/2.2; re-homed as the ONE
 * pointer affordance by Spec #3119, ST-6 — UI/UX §9).
 *
 * A single pill pinned inside the canvas region (`wireframe-insert`) opens one
 * Chakra `Menu` grouped as Elements / Section presets / Shape kinds / Icons.
 * Every item carries `data-testid="wireframe-insert-item"`, `data-nav-verb-id`
 * and (for an argumented verb) `data-nav-args`, and dispatches the DECLARED verb
 * through `host.runVerb(verbId, 'pointer', args)`. It never changes the place
 * and never mutates the store — it is a shortcut to the same verbs the rail,
 * the map and the Create place expose.
 *
 * Pointer activation releases focus to the trigger's caller (G-327) once the
 * menu has closed, so the next bare key reaches the ONE key adapter; keyboard
 * activation keeps focus on the trigger so the menu remains operable.
 *
 * Tokens only: semantic tokens and the shared `tint()` helper — never a
 * hex/rgba literal, never an alpha-append onto a `var()`.
 */

import React, { useRef } from 'react';
import { Box, Button, Icon, Menu, Portal, Text } from '@chakra-ui/react';
import { LuPlus } from 'react-icons/lu';

import {
  WIREFRAME_ELEMENT_LABELS,
  type WireframeElementType,
  type WireframeSectionPreset,
  type WireframeShapeKind,
} from '../model/elements';
import { WIREFRAME_ICONS } from '../model/icons';
import { tint } from '../../../shared/utils/colorTint';
import { useWireframeNavigation } from './WireframeNavigationProvider';

interface InsertItem {
  /** Unique menu value (never shown). */
  readonly key: string;
  readonly label: string;
  readonly verbId: string;
  readonly args?: Readonly<Record<string, string>>;
}

/** The seven no-argument element verbs (Section/Shape carry an explicit choice). */
const ELEMENT_TYPES: readonly WireframeElementType[] = [
  'text',
  'button',
  'input',
  'image',
  'icon',
  'card',
  'line',
];

const ELEMENT_ITEMS: readonly InsertItem[] = ELEMENT_TYPES.map((type) => ({
  key: `element:${type}`,
  label: WIREFRAME_ELEMENT_LABELS[type],
  verbId: `wireframe.add.${type}`,
}));

const SECTION_PRESET_LABELS: Readonly<Record<WireframeSectionPreset, string>> = {
  header: 'Header',
  navbar: 'Nav bar',
  sidebar: 'Sidebar',
  footer: 'Footer',
};

const SECTION_ITEMS: readonly InsertItem[] = (
  Object.keys(SECTION_PRESET_LABELS) as WireframeSectionPreset[]
).map((preset) => ({
  key: `section:${preset}`,
  label: SECTION_PRESET_LABELS[preset],
  verbId: 'wireframe.add.section',
  args: { preset },
}));

const SHAPE_KIND_LABELS: Readonly<Record<WireframeShapeKind, string>> = {
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  triangle: 'Triangle',
};

const SHAPE_ITEMS: readonly InsertItem[] = (
  Object.keys(SHAPE_KIND_LABELS) as WireframeShapeKind[]
).map((shape) => ({
  key: `shape:${shape}`,
  label: SHAPE_KIND_LABELS[shape],
  verbId: 'wireframe.add.shape',
  args: { shape },
}));

const ICON_ITEMS: readonly InsertItem[] = WIREFRAME_ICONS.map((icon) => ({
  key: `icon:${icon.id}`,
  label: icon.label,
  verbId: 'wireframe.add.icon',
  args: { iconId: icon.id },
}));

/** `preset=footer` / `shape=triangle` / `iconId=user` (single argument per row). */
function formatArgs(args: Readonly<Record<string, string>>): string {
  return Object.entries(args)
    .map(([name, value]) => `${name}=${value}`)
    .join(',');
}

function InsertMenuItem({
  item,
  onRun,
}: {
  item: InsertItem;
  onRun: (item: InsertItem) => void;
}): React.ReactElement {
  const args = item.args;
  return (
    <Menu.Item
      value={item.key}
      data-testid="wireframe-insert-item"
      data-nav-verb-id={item.verbId}
      {...(args === undefined ? {} : { 'data-nav-args': formatArgs(args) })}
      onSelect={() => onRun(item)}
      fontSize="xs"
      color="fg.default"
      px={3}
      py="4px"
      borderRadius="xs"
      cursor="pointer"
      whiteSpace="nowrap"
      _highlighted={{ bg: 'bg.hover' }}
    >
      {item.label}
    </Menu.Item>
  );
}

export function WireframeInsertMenu(): React.ReactElement {
  const { host } = useWireframeNavigation();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const pointerOpenedRef = useRef(false);

  const runItem = (item: InsertItem): void => {
    void host.runVerb(item.verbId, 'pointer', item.args ?? {});
  };

  return (
    <Box
      position="absolute"
      insetInlineStart="12px"
      insetBlockStart="12px"
      zIndex={2}
    >
      <Menu.Root
        positioning={{ placement: 'bottom-start' }}
        onExitComplete={() => {
          if (!pointerOpenedRef.current) return;
          pointerOpenedRef.current = false;
          // A pointer activation releases focus so the next bare key resolves
          // through the shell adapter (G-327); a keyboard activation keeps it.
          triggerRef.current?.blur();
        }}
      >
        <Menu.Trigger asChild>
          <Button
            ref={triggerRef}
            data-testid="wireframe-insert"
            aria-label="Insert"
            aria-haspopup="menu"
            size="sm"
            variant="ghost"
            gap={1.5}
            px={2}
            bg="bg.surface"
            borderWidth="1px"
            borderColor="border.default"
            color="fg.default"
            _hover={{ bg: tint('var(--accent-primary)', 10) }}
            onPointerDown={() => {
              pointerOpenedRef.current = true;
            }}
            onKeyDown={() => {
              pointerOpenedRef.current = false;
            }}
          >
            <Icon as={LuPlus} boxSize={3.5} aria-hidden="true" />
            <Text as="span" display={{ base: 'none', lg: 'inline' }} fontSize="xs">
              Insert
            </Text>
          </Button>
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner>
            <Menu.Content
              aria-label="Insert"
              minWidth="10rem"
              maxH="60vh"
              overflowY="auto"
              bg="bg.surface"
              borderColor="border.default"
              borderWidth="1px"
              borderRadius="sm"
              boxShadow="md"
              py={1}
            >
              <Menu.ItemGroup>
                <Menu.ItemGroupLabel fontSize="xs" color="fg.muted">
                  Elements
                </Menu.ItemGroupLabel>
                {ELEMENT_ITEMS.map((item) => (
                  <InsertMenuItem key={item.key} item={item} onRun={runItem} />
                ))}
              </Menu.ItemGroup>
              <Menu.Separator />
              <Menu.ItemGroup>
                <Menu.ItemGroupLabel fontSize="xs" color="fg.muted">
                  Section presets
                </Menu.ItemGroupLabel>
                {SECTION_ITEMS.map((item) => (
                  <InsertMenuItem key={item.key} item={item} onRun={runItem} />
                ))}
              </Menu.ItemGroup>
              <Menu.Separator />
              <Menu.ItemGroup>
                <Menu.ItemGroupLabel fontSize="xs" color="fg.muted">
                  Shape kinds
                </Menu.ItemGroupLabel>
                {SHAPE_ITEMS.map((item) => (
                  <InsertMenuItem key={item.key} item={item} onRun={runItem} />
                ))}
              </Menu.ItemGroup>
              <Menu.Separator />
              <Menu.ItemGroup>
                <Menu.ItemGroupLabel fontSize="xs" color="fg.muted">
                  Icons
                </Menu.ItemGroupLabel>
                {ICON_ITEMS.map((item) => (
                  <InsertMenuItem key={item.key} item={item} onRun={runItem} />
                ))}
              </Menu.ItemGroup>
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
    </Box>
  );
}
