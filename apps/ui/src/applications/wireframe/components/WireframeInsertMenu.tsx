/**
 * Wireframe insert menu (Spec #3070, ST-3, UI/UX 2.1/2.2; re-homed as the ONE
 * pointer affordance by Spec #3119, ST-6; store-direct since Spec #3151, ST-5).
 *
 * A single pill pinned inside the canvas region (`wireframe-insert`) opens one
 * Chakra `Menu` grouped as Elements / Section presets / Shape kinds / Icons.
 * Every item carries `data-testid="wireframe-insert-item"` and calls the SAME
 * retained action handler the command table exposes
 * (`addWireframeElement`), so the menu is a shortcut to the capability, never a
 * second implementation. It never mutates the store directly and never changes a
 * place.
 *
 * The two engine-only DOM hooks the navigation engine used (`data-nav-verb-id` /
 * `data-nav-args`) are GONE — they described a `host.runVerb` call that no longer
 * exists. The `wireframe-insert` / `wireframe-insert-item` testids stay.
 *
 * Arrow-key traversal inside the open popup is Chakra/Ark's own menu behaviour,
 * not an application binding: the trigger and every item are ordinary
 * Tab-reachable controls.
 *
 * Tokens only: semantic tokens and the shared `tint()` helper — never a
 * hex/rgba literal, never an alpha-append onto a `var()`.
 */

import React from 'react';
import { Box, Button, Icon, Menu, Portal, Text } from '@chakra-ui/react';
import { LuPlus } from 'react-icons/lu';

import { addWireframeElement } from '../actions/wireframeActions';
import {
  WIREFRAME_ELEMENT_LABELS,
  type WireframeElementType,
  type WireframeSectionPreset,
  type WireframeShapeKind,
} from '../model/elements';
import { WIREFRAME_ICONS } from '../model/icons';
import { tint } from '../../../shared/utils/colorTint';

interface InsertItem {
  /** Unique menu value (never shown). */
  readonly key: string;
  readonly label: string;
  /** Run the retained action handler for this row. */
  readonly run: () => void;
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
  run: () => {
    addWireframeElement(type);
  },
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
  run: () => {
    addWireframeElement('section', { preset });
  },
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
  run: () => {
    addWireframeElement('shape', { shape });
  },
}));

const ICON_ITEMS: readonly InsertItem[] = WIREFRAME_ICONS.map((icon) => ({
  key: `icon:${icon.id}`,
  label: icon.label,
  run: () => {
    addWireframeElement('icon', { iconId: icon.id });
  },
}));

function InsertMenuItem({
  item,
  onRun,
}: {
  item: InsertItem;
  onRun: (item: InsertItem) => void;
}): React.ReactElement {
  return (
    <Menu.Item
      value={item.key}
      data-testid="wireframe-insert-item"
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
  const runItem = (item: InsertItem): void => {
    item.run();
  };

  return (
    <Box
      position="absolute"
      insetInlineStart="12px"
      insetBlockStart="12px"
      zIndex={2}
    >
      <Menu.Root positioning={{ placement: 'bottom-start' }}>
        <Menu.Trigger asChild>
          <Button
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
