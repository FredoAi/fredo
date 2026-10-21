/**
 * Wireframe property panel (Spec #3070, ST-4, AC3 / UI/UX section 2.5).
 *
 * Store-connected, prop-less, contextual panel:
 *   - selection header (kind icon + human name + Locked/Hidden tags, or `Page`);
 *   - only the sections that apply to the selected element type;
 *   - the shared width/height/visible/lock block for every element;
 *   - the page controls when nothing is selected (`wireframe-page-controls`).
 *
 * Every control writes through the store on its own interaction tick — no
 * submit button and no cross-interaction debounce, so the canvas repaints
 * immediately. Every numeric property has a stepper AND a slider (R-3.6); the
 * corner radius ships preset chips plus a 4-stop slider that both write the
 * same `none|s|m|l` enum (SI adjudication 5 — no schema change).
 *
 * No panel control carries `data-hotkey` (the panel is a property surface).
 */

import React, { useSyncExternalStore } from 'react';
import {
  Box,
  Button,
  HStack,
  Icon,
  Input,
  Switch,
  Text,
  Textarea,
  VStack,
  VisuallyHidden,
} from '@chakra-ui/react';
import type { IconType } from 'react-icons';
import {
  LuAlignCenter,
  LuAlignLeft,
  LuAlignRight,
  LuFile,
  LuImage,
  LuLayoutPanelTop,
  LuMinus,
  LuRectangleHorizontal,
  LuShapes,
  LuSquare,
  LuStar,
  LuTextCursorInput,
  LuType,
} from 'react-icons/lu';

import { ELEMENT_MIN_SIZE } from '../model/geometry';
import {
  WIREFRAME_ELEMENT_LABELS,
  type WireframeAlign,
  type WireframeBorderWidth,
  type WireframeButtonAppearance,
  type WireframeElement,
  type WireframeElementPatch,
  type WireframeElementType,
  type WireframeRadius,
  type WireframeSectionPreset,
  type WireframeShapeKind,
  type WireframeTextSize,
  type WireframeTextStyle,
} from '../model/elements';
import { dispatch, getSnapshot, subscribe } from '../store/wireframeDocumentStore';
import { tint } from '../../../shared/utils/colorTint';
import { CornerRadiusField } from './fields/CornerRadiusField';
import { IconPicker } from './fields/IconPicker';
import { NumberSliderField } from './fields/NumberSliderField';
import { PageControls } from './fields/PageControls';
import { SegmentedField } from './fields/SegmentedField';
import { SwatchRow } from './fields/SwatchRow';

const ELEMENT_ICONS: Readonly<Record<WireframeElementType, IconType>> = {
  text: LuType,
  button: LuRectangleHorizontal,
  input: LuTextCursorInput,
  image: LuImage,
  icon: LuStar,
  card: LuSquare,
  section: LuLayoutPanelTop,
  shape: LuShapes,
  line: LuMinus,
};

const SECTION_PRESET_LABELS: Readonly<Record<WireframeSectionPreset, string>> = {
  header: 'Header',
  navbar: 'Nav bar',
  sidebar: 'Sidebar',
  footer: 'Footer',
};

const SHAPE_KIND_LABELS: Readonly<Record<WireframeShapeKind, string>> = {
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  triangle: 'Triangle',
};

const BORDER_LABELS: Readonly<Record<WireframeBorderWidth, string>> = {
  none: 'None',
  thin: 'Thin',
  thick: 'Thick',
};

const BORDER_PREVIEW_PX: Readonly<Record<WireframeBorderWidth, string>> = {
  none: '0px',
  thin: '1px',
  thick: '3px',
};

const TEXT_STYLE_LABELS: Readonly<Record<WireframeTextStyle, string>> = {
  body: 'Body',
  heading: 'Heading',
};

const TEXT_SIZE_LABELS: Readonly<Record<WireframeTextSize, string>> = {
  s: 'S',
  m: 'M',
  l: 'L',
  xl: 'XL',
};

/** Preview font size for the "A" in each size segment. */
const TEXT_SIZE_PREVIEW_FONT: Readonly<Record<WireframeTextSize, string>> = {
  s: 'xs',
  m: 'sm',
  l: 'md',
  xl: 'lg',
};

const APPEARANCE_LABELS: Readonly<Record<WireframeButtonAppearance, string>> = {
  primary: 'Primary',
  secondary: 'Secondary',
  ghost: 'Ghost',
};

const ALIGN_OPTIONS: readonly {
  value: WireframeAlign;
  label: string;
  icon: IconType;
}[] = [
  { value: 'left', label: 'Align left', icon: LuAlignLeft },
  { value: 'center', label: 'Align centre', icon: LuAlignCenter },
  { value: 'right', label: 'Align right', icon: LuAlignRight },
];

function elementTitle(element: WireframeElement): string {
  switch (element.type) {
    case 'text':
      return element.textStyle === 'heading' ? 'Heading' : 'Text';
    case 'section':
      return SECTION_PRESET_LABELS[element.preset];
    case 'shape':
      return SHAPE_KIND_LABELS[element.shape];
    default:
      return WIREFRAME_ELEMENT_LABELS[element.type];
  }
}

function SelectionTag({
  children,
  testId,
}: {
  children: React.ReactNode;
  testId: string;
}): React.ReactElement {
  return (
    <Box
      as="span"
      data-testid={testId}
      px={2}
      py={0.5}
      borderRadius="sm"
      bg="bg.muted"
      color="fg.muted"
      fontSize="xs"
      whiteSpace="nowrap"
    >
      {children}
    </Box>
  );
}

function SelectionHeader({ element }: { element: WireframeElement | null }): React.ReactElement {
  const title = element ? elementTitle(element) : 'Page';
  const ElementIcon = element ? ELEMENT_ICONS[element.type] : LuFile;

  return (
    <VStack align="stretch" gap={1} minWidth={0} data-testid="wireframe-panel-header">
      <HStack gap={2} align="center" minWidth={0} wrap="wrap">
        <Icon as={ElementIcon} boxSize={4} color="fg.muted" aria-hidden="true" />
        <Text
          fontSize="sm"
          fontWeight="600"
          color="fg.default"
          data-testid="wireframe-panel-title"
        >
          {title}
        </Text>
        {element?.locked ? (
          <SelectionTag testId="wireframe-tag-locked">Locked</SelectionTag>
        ) : null}
        {element && !element.visible ? (
          <SelectionTag testId="wireframe-tag-hidden">Hidden</SelectionTag>
        ) : null}
      </HStack>
      {element === null ? (
        <Text fontSize="xs" color="fg.muted" data-testid="wireframe-panel-caption">
          No selection — editing page settings
        </Text>
      ) : null}
    </VStack>
  );
}

function LabeledControl({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <VStack align="stretch" gap={1} minWidth={0}>
      <Text fontSize="xs" color="fg.muted">
        {label}
      </Text>
      {children}
    </VStack>
  );
}

function TextFields({
  element,
  update,
}: {
  element: Extract<WireframeElement, { type: 'text' }>;
  update: (patch: WireframeElementPatch) => void;
}): React.ReactElement {
  return (
    <>
      <LabeledControl label="Content">
        <Textarea
          data-testid="wireframe-text-content"
          aria-label="Content"
          rows={2}
          size="sm"
          value={element.text}
          onChange={(event) => update({ text: event.target.value })}
          bg="bg.surface"
          borderColor="border.default"
        />
      </LabeledControl>

      <SegmentedField
        label="Text style"
        value={element.textStyle}
        testIdPrefix="wireframe-text-style"
        options={(['body', 'heading'] as const).map((style) => ({
          value: style,
          label: TEXT_STYLE_LABELS[style],
        }))}
        onChange={(textStyle) => update({ textStyle })}
      />

      <SegmentedField
        label="Size"
        value={element.size}
        testIdPrefix="wireframe-text-size"
        options={(['s', 'm', 'l', 'xl'] as const).map((size) => ({
          value: size,
          label: (
            <Text as="span" fontSize={TEXT_SIZE_PREVIEW_FONT[size]} lineHeight="1">
              A<VisuallyHidden>{TEXT_SIZE_LABELS[size]}</VisuallyHidden>
            </Text>
          ),
          ariaLabel: `Text size ${TEXT_SIZE_LABELS[size]}`,
        }))}
        onChange={(size) => update({ size })}
      />

      <LabeledControl label="Alignment">
        <HStack gap={1} data-testid="wireframe-align-group">
          {ALIGN_OPTIONS.map((option) => {
            const pressed = element.align === option.value;
            return (
              <Button
                key={option.value}
                type="button"
                size="sm"
                variant="ghost"
                data-testid={`wireframe-align-${option.value}`}
                aria-label={option.label}
                aria-pressed={pressed}
                onClick={() => update({ align: option.value })}
                color={pressed ? 'accent.default' : 'fg.muted'}
                bg={pressed ? tint('var(--accent-primary)', 18) : undefined}
                px={2}
              >
                <Icon as={option.icon} boxSize={4} aria-hidden="true" />
              </Button>
            );
          })}
        </HStack>
      </LabeledControl>
    </>
  );
}

function ButtonFields({
  element,
  update,
}: {
  element: Extract<WireframeElement, { type: 'button' }>;
  update: (patch: WireframeElementPatch) => void;
}): React.ReactElement {
  return (
    <>
      <LabeledControl label="Label">
        <Input
          data-testid="wireframe-button-label"
          aria-label="Label"
          size="sm"
          value={element.label}
          onChange={(event) => update({ label: event.target.value })}
          bg="bg.surface"
          borderColor="border.default"
        />
      </LabeledControl>

      <SegmentedField
        label="Appearance"
        value={element.appearance}
        testIdPrefix="wireframe-appearance"
        options={(['primary', 'secondary', 'ghost'] as const).map((appearance) => ({
          value: appearance,
          label: APPEARANCE_LABELS[appearance],
        }))}
        onChange={(appearance) => update({ appearance })}
      />
    </>
  );
}

function SectionFields({
  element,
  update,
}: {
  element: Extract<WireframeElement, { type: 'section' }>;
  update: (patch: WireframeElementPatch) => void;
}): React.ReactElement {
  return (
    <SegmentedField
      label="Preset"
      value={element.preset}
      testIdPrefix="wireframe-section-preset"
      options={(['header', 'navbar', 'sidebar', 'footer'] as const).map((preset) => ({
        value: preset,
        label: SECTION_PRESET_LABELS[preset],
      }))}
      onChange={(preset) => update({ preset })}
    />
  );
}

function ShapeFields({
  element,
  update,
}: {
  element: Extract<WireframeElement, { type: 'shape' }>;
  update: (patch: WireframeElementPatch) => void;
}): React.ReactElement {
  return (
    <>
      <SegmentedField
        label="Kind"
        value={element.shape}
        testIdPrefix="wireframe-shape-kind"
        options={(['rect', 'ellipse', 'triangle'] as const).map((shape) => ({
          value: shape,
          label: SHAPE_KIND_LABELS[shape],
        }))}
        onChange={(shape) => update({ shape })}
      />

      <SwatchRow
        label="Fill"
        value={element.fill}
        onChange={(fill) => update({ fill })}
      />

      <SegmentedField
        label="Border"
        value={element.border}
        testIdPrefix="wireframe-border"
        options={(['none', 'thin', 'thick'] as const).map((border) => ({
          value: border,
          label: (
            <HStack gap={1}>
              <Box
                as="span"
                display="inline-block"
                width="20px"
                borderTopWidth={BORDER_PREVIEW_PX[border]}
                borderColor="currentColor"
              />
              <VisuallyHidden>{BORDER_LABELS[border]}</VisuallyHidden>
            </HStack>
          ),
          ariaLabel: `Border ${BORDER_LABELS[border]}`,
        }))}
        onChange={(border) => update({ border })}
      />

      {element.shape === 'rect' ? (
        <CornerRadiusField
          value={element.radius}
          onChange={(radius: WireframeRadius) => update({ radius })}
        />
      ) : null}
    </>
  );
}

function ElementFields({
  element,
  pageWidth,
  pageHeight,
  update,
}: {
  element: WireframeElement;
  pageWidth: number;
  pageHeight: number;
  update: (patch: WireframeElementPatch) => void;
}): React.ReactElement {
  return (
    <VStack align="stretch" gap={5} minWidth={0} width="full">
      {element.type === 'text' ? <TextFields element={element} update={update} /> : null}

      {element.type === 'button' ? <ButtonFields element={element} update={update} /> : null}

      {element.type === 'input' ? (
        <LabeledControl label="Placeholder">
          <Input
            data-testid="wireframe-input-placeholder"
            aria-label="Placeholder"
            size="sm"
            value={element.placeholder}
            onChange={(event) => update({ placeholder: event.target.value })}
            bg="bg.surface"
            borderColor="border.default"
          />
        </LabeledControl>
      ) : null}

      {element.type === 'card' ? (
        <LabeledControl label="Label">
          <Input
            data-testid="wireframe-card-label"
            aria-label="Label"
            size="sm"
            value={element.label}
            onChange={(event) => update({ label: event.target.value })}
            bg="bg.surface"
            borderColor="border.default"
          />
        </LabeledControl>
      ) : null}

      {element.type === 'section' ? (
        <SectionFields element={element} update={update} />
      ) : null}

      {element.type === 'shape' ? <ShapeFields element={element} update={update} /> : null}

      {element.type === 'icon' ? (
        <IconPicker value={element.iconId} onChange={(iconId) => update({ iconId })} />
      ) : null}

      <NumberSliderField
        label="Width"
        value={element.width}
        min={ELEMENT_MIN_SIZE}
        max={pageWidth}
        testId="wireframe-element-width"
        sliderName="Width slider"
        onChange={(width) => update({ width })}
      />

      <NumberSliderField
        label="Height"
        value={element.height}
        min={ELEMENT_MIN_SIZE}
        max={pageHeight}
        testId="wireframe-element-height"
        sliderName="Height slider"
        onChange={(height) => update({ height })}
      />

      <HStack justify="space-between" align="center" gap={2}>
        <Text fontSize="xs" color="fg.muted">
          Visible
        </Text>
        <Switch.Root
          data-testid="wireframe-visible-switch"
          checked={element.visible}
          onCheckedChange={(details) => update({ visible: details.checked })}
        >
          <Switch.HiddenInput aria-label="Visible" />
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
        </Switch.Root>
      </HStack>

      <VStack align="stretch" gap={1} minWidth={0}>
        <HStack justify="space-between" align="center" gap={2}>
          <Text fontSize="xs" color="fg.muted">
            Lock position and size
          </Text>
          <Switch.Root
            data-testid="wireframe-lock-switch"
            checked={element.locked}
            onCheckedChange={(details) => update({ locked: details.checked })}
          >
            <Switch.HiddenInput aria-label="Lock position and size" />
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
          </Switch.Root>
        </HStack>
        {element.locked ? (
          <Text fontSize="xs" color="fg.muted" data-testid="wireframe-lock-caption">
            Locked — drag and resize are disabled
          </Text>
        ) : null}
      </VStack>
    </VStack>
  );
}

export function WireframePropertyPanel(): React.ReactElement {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { document, selectedId } = state;

  const element =
    selectedId === null
      ? null
      : document.elements.find((candidate) => candidate.id === selectedId) ?? null;

  const update = (patch: WireframeElementPatch): void => {
    if (!element) return;
    dispatch('element.update', { id: element.id, patch });
  };

  return (
    <VStack
      data-testid="wireframe-property-panel"
      align="stretch"
      gap={5}
      p={4}
      w="full"
      minW={0}
      minH={0}
      maxW={{ base: 'full', lg: '72' }}
      maxH={{ base: '45%', lg: 'full' }}
      h={{ base: 'auto', lg: 'full' }}
      flexShrink={0}
      overflowY="auto"
      bg="bg.surface"
      borderColor="border.subtle"
      borderTopWidth={{ base: '1px', lg: '0' }}
      borderLeftWidth={{ base: '0', lg: '1px' }}
    >
      <SelectionHeader element={element} />

      {element === null ? (
        <PageControls />
      ) : (
        <ElementFields
          element={element}
          pageWidth={document.page.width}
          pageHeight={document.page.height}
          update={update}
        />
      )}
    </VStack>
  );
}
