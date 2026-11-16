/**
 * Wireframe property panel (Spec #3070, ST-4, AC3 / UI/UX section 2.5;
 * extended by Spec #3071, ST-6 — UI/UX 2.2; becomes the DETAILS VIEW of the
 * selection in Spec #3119, ST-6 — UI/UX §4).
 *
 * Store-connected, prop-less, contextual panel:
 *   - a four-mode selection header (Page / single element / multi-selection /
 *     Group — see `SelectionHeaderModel`);
 *   - only the sections that apply to the selected element type;
 *   - the shared width/height/visible/lock block for every element;
 *   - the page controls when nothing is selected (`wireframe-page-controls`).
 * A multi-selection or group selection renders the header ONLY — no field
 * sections (progressive disclosure: values are ambiguous across a mixed set).
 *
 * EXECUTION SEAM (Spec #3119, R-6): the panel never mutates the store. Every
 * control dispatches the DECLARED verb through the navigation host:
 *   fill/border/radius/textStyle/appearance → `wireframe.style.*` (explicit value)
 *   width/height/label/content/placeholder/icon/preset/kind/align/size
 *                                            → `wireframe.element.setField {id,field,value}`
 *   visible / lock                           → `wireframe.element.toggleVisible/toggleLock`
 *   page preset / dimensions                 → `wireframe.page.update {field,value}`
 * The verbs keep `coalesceKey: null`, so one interaction tick = one journal
 * entry = one undo (the retired store's granularity, R-8).
 *
 * The Edit place's `wireframe.element.rename` is a navigation effect: it
 * publishes a one-shot rename request; this panel consumes it and focuses +
 * selects the element's name field (never a fabricated name). Escape inside a
 * panel text field returns focus to the CANVAS ROOT (no dispatch, never `body`)
 * so the key path resumes.
 *
 * Every numeric property has a stepper AND a slider (R-3.6); the corner radius
 * ships preset chips plus a 4-stop slider that both write the same
 * `none|s|m|l` enum. No panel control carries a legacy key attribute.
 */

import React, { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
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
  LuGroup,
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
import type { WireframeGroup } from '../model/document';
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
import {
  getSnapshot,
  selectedElements,
  selectionGroup,
  subscribe,
} from '../store/wireframeDocumentStore';
import {
  consumeWireframeRenameRequest,
  subscribeWireframeRenameRequest,
} from '../wireframeSurface';
import { isTextControl } from '../../../shared/navigation/focusContext';
import { tint } from '../../../shared/utils/colorTint';
import { useWireframeNavigation } from './WireframeNavigationProvider';
import { CornerRadiusField } from './fields/CornerRadiusField';
import { IconPicker } from './fields/IconPicker';
import { NumberSliderField } from './fields/NumberSliderField';
import { PageControls } from './fields/PageControls';
import { SegmentedField } from './fields/SegmentedField';
import { SwatchRow } from './fields/SwatchRow';

/** The element name field a rename request targets (UI/UX §8). */
type NameFieldElement = HTMLInputElement | HTMLTextAreaElement;
/** Mutable holder so the name-field ref can be shared through the field tree. */
interface NameFieldRef {
  current: NameFieldElement | null;
}

/**
 * Patch key → the declared style verb that owns it (UI/UX §4). Every other
 * patch key is a plain field write through `wireframe.element.setField`.
 */
const STYLE_VERB_BY_FIELD: Readonly<Record<string, string>> = {
  fill: 'wireframe.style.fill',
  border: 'wireframe.style.border',
  radius: 'wireframe.style.radius',
  textStyle: 'wireframe.style.textStyle',
  appearance: 'wireframe.style.appearance',
};

const SET_FIELD_VERB_ID = 'wireframe.element.setField';
const TOGGLE_VISIBLE_VERB_ID = 'wireframe.element.toggleVisible';
const TOGGLE_LOCK_VERB_ID = 'wireframe.element.toggleLock';

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

/**
 * The four panel header modes (Spec #3071, ST-6 — UI/UX 2.2), driven by the
 * selection count and the selection's group:
 *   - `page`    — nothing selected (Page header + the page controls);
 *   - `element` — exactly one selected element (its kind icon + name + tags);
 *   - `multi`   — 2+ selected elements that are not one group;
 *   - `group`   — 2+ selected elements that all belong to ONE group.
 * The multi/group modes render NO field sections (values are ambiguous across a
 * mixed selection — progressive disclosure).
 */
type SelectionHeaderModel =
  | { kind: 'page' }
  | { kind: 'element'; element: WireframeElement }
  | { kind: 'multi'; count: number }
  | { kind: 'group'; group: WireframeGroup; memberCount: number };

function SelectionHeader({ model }: { model: SelectionHeaderModel }): React.ReactElement {
  if (model.kind === 'page') {
    return (
      <VStack align="stretch" gap={1} minWidth={0} data-testid="wireframe-panel-header">
        <HStack gap={2} align="center" minWidth={0} wrap="wrap">
          <Icon as={LuFile} boxSize={4} color="fg.muted" aria-hidden="true" />
          <Text
            fontSize="sm"
            fontWeight="600"
            color="fg.default"
            data-testid="wireframe-panel-title"
          >
            Page
          </Text>
        </HStack>
        <Text fontSize="xs" color="fg.muted" data-testid="wireframe-panel-caption">
          No selection — editing page settings
        </Text>
      </VStack>
    );
  }

  if (model.kind === 'element') {
    const { element } = model;
    return (
      <VStack align="stretch" gap={1} minWidth={0} data-testid="wireframe-panel-header">
        <HStack gap={2} align="center" minWidth={0} wrap="wrap">
          <Icon as={ELEMENT_ICONS[element.type]} boxSize={4} color="fg.muted" aria-hidden="true" />
          <Text
            fontSize="sm"
            fontWeight="600"
            color="fg.default"
            data-testid="wireframe-panel-title"
          >
            {elementTitle(element)}
          </Text>
          {element.locked ? (
            <SelectionTag testId="wireframe-tag-locked">Locked</SelectionTag>
          ) : null}
          {!element.visible ? (
            <SelectionTag testId="wireframe-tag-hidden">Hidden</SelectionTag>
          ) : null}
        </HStack>
      </VStack>
    );
  }

  if (model.kind === 'multi') {
    return (
      <VStack align="stretch" gap={1} minWidth={0} data-testid="wireframe-panel-header">
        <HStack gap={2} align="center" minWidth={0} wrap="wrap">
          <Icon as={LuShapes} boxSize={4} color="fg.muted" aria-hidden="true" />
          <Text
            fontSize="sm"
            fontWeight="600"
            color="fg.default"
            data-testid="wireframe-panel-title"
          >
            {`${model.count} elements selected`}
          </Text>
        </HStack>
        <Text fontSize="xs" color="fg.muted" data-testid="wireframe-panel-caption">
          Arrange, align or group them from the rail
        </Text>
      </VStack>
    );
  }

  return (
    <VStack align="stretch" gap={1} minWidth={0} data-testid="wireframe-panel-header">
      <HStack gap={2} align="center" minWidth={0} wrap="wrap">
        <Icon as={LuGroup} boxSize={4} color="fg.muted" aria-hidden="true" />
        <Text
          fontSize="sm"
          fontWeight="600"
          color="fg.default"
          data-testid="wireframe-panel-title"
        >
          Group
        </Text>
        <SelectionTag testId="wireframe-tag-group">{`Group · ${model.memberCount}`}</SelectionTag>
        {model.group.locked ? (
          <SelectionTag testId="wireframe-tag-locked">Locked</SelectionTag>
        ) : null}
      </HStack>
      <Text fontSize="xs" color="fg.muted" data-testid="wireframe-panel-caption">
        {model.group.locked
          ? 'Group locked — drag and resize are disabled'
          : 'Drag or resize to move every unlocked member'}
      </Text>
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
  nameFieldRef,
}: {
  element: Extract<WireframeElement, { type: 'text' }>;
  update: (patch: WireframeElementPatch) => void;
  nameFieldRef: NameFieldRef;
}): React.ReactElement {
  return (
    <>
      <LabeledControl label="Content">
        <Textarea
          ref={(node) => {
            nameFieldRef.current = node;
          }}
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
                // #3086 ST-3 (G-235 substitution) — this align control is a
                // `variant="ghost"` pressable (`aria-pressed`), i.e. the
                // `control-ghost` gate surface ("variant='ghost' pressable
                // buttons — toolbar + panel align"). The label stays
                // `fg.default` in EVERY state; the accent signal is the FILL,
                // matching the committed composed rows —
                // `control-ghost|default|label` = `fg.default` on `bg.surface`,
                // `|hover|label` = the 10 % accent tint, `|active|label` = the
                // 18 % accent tint. `accent.default` on its own faint tint was
                // the sub-floor pair (G-366).
                color="fg.default"
                bg={pressed ? tint('var(--accent-primary)', 18) : undefined}
                _hover={{ bg: tint('var(--accent-primary)', pressed ? 18 : 10) }}
                data-contrast-pair="control-ghost|active|label"
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
  nameFieldRef,
}: {
  element: Extract<WireframeElement, { type: 'button' }>;
  update: (patch: WireframeElementPatch) => void;
  nameFieldRef: NameFieldRef;
}): React.ReactElement {
  return (
    <>
      <LabeledControl label="Label">
        <Input
          ref={(node) => {
            nameFieldRef.current = node;
          }}
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
  nameFieldRef,
}: {
  element: WireframeElement;
  pageWidth: number;
  pageHeight: number;
  update: (patch: WireframeElementPatch) => void;
  nameFieldRef: NameFieldRef;
}): React.ReactElement {
  return (
    <VStack align="stretch" gap={5} minWidth={0} width="full">
      {element.type === 'text' ? (
        <TextFields element={element} update={update} nameFieldRef={nameFieldRef} />
      ) : null}

      {element.type === 'button' ? (
        <ButtonFields element={element} update={update} nameFieldRef={nameFieldRef} />
      ) : null}

      {element.type === 'input' ? (
        <LabeledControl label="Placeholder">
          <Input
            ref={(node) => {
              nameFieldRef.current = node;
            }}
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
            ref={(node) => {
              nameFieldRef.current = node;
            }}
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
  const { host } = useWireframeNavigation();
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { document, selectedIds } = state;

  const selected = selectedElements(state);
  const element = selected.length === 1 ? selected[0] : null;
  const group = selectionGroup(document, selectedIds);
  const elementId = element?.id ?? null;
  const nameFieldRef = useRef<NameFieldElement | null>(null);

  const header: SelectionHeaderModel =
    element !== null
      ? { kind: 'element', element }
      : selected.length === 0
        ? { kind: 'page' }
        : group !== null
          ? { kind: 'group', group, memberCount: group.memberIds.length }
          : { kind: 'multi', count: selected.length };

  /**
   * Every edit is ONE declared verb on ONE interaction tick (`coalesceKey: null`),
   * so the journal has exactly one entry (one undo) per field change. Nothing here
   * touches the store directly (Spec #3119, R-6a).
   */
  const update = useCallback(
    (patch: WireframeElementPatch): void => {
      if (!element) return;
      for (const [field, value] of Object.entries(patch as Record<string, unknown>)) {
        if (value === undefined) continue;
        const styleVerb = STYLE_VERB_BY_FIELD[field];
        if (styleVerb !== undefined) {
          void host.runVerb(styleVerb, 'pointer', { [field]: String(value) });
          continue;
        }
        // The switches are bound to the element's own value, so the click IS the
        // toggle the Edit verbs declare (never a direct boolean write).
        if (field === 'visible') {
          void host.runVerb(TOGGLE_VISIBLE_VERB_ID, 'pointer', {});
          continue;
        }
        if (field === 'locked') {
          void host.runVerb(TOGGLE_LOCK_VERB_ID, 'pointer', {});
          continue;
        }
        void host.runVerb(SET_FIELD_VERB_ID, 'pointer', {
          id: element.id,
          field,
          value: String(value),
        });
      }
    },
    [element, host],
  );

  /**
   * Consume the surface's one-shot rename request (Edit `r`): focus + select the
   * element's name field. The request carries the id + field, so a stale request
   * for another element is dropped rather than applied to the wrong field.
   */
  useEffect(() => {
    if (elementId === null) return undefined;
    const handle = (): void => {
      const request = consumeWireframeRenameRequest();
      if (request === null || request.id !== elementId) return;
      const field = nameFieldRef.current;
      if (field === null) return;
      field.focus();
      field.select();
    };
    const unsubscribe = subscribeWireframeRenameRequest(handle);
    // A request published before this panel mounted is still one-shot pending.
    handle();
    return unsubscribe;
  }, [elementId]);

  /**
   * Escape inside a panel text field would otherwise die on the field (the shell
   * adapter passes text controls through). Return focus to the CANVAS ROOT — never
   * `body` — so the next stroke resolves again. No dispatch.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return;
    const target = event.target instanceof Element ? event.target : null;
    if (!isTextControl(target)) return;
    const canvas = event.currentTarget.ownerDocument.querySelector<HTMLElement>(
      '[data-testid="wireframe-canvas"]',
    );
    if (canvas === null) return;
    event.preventDefault();
    canvas.focus();
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
      onKeyDown={onKeyDown}
    >
      <SelectionHeader model={header} />

      {selected.length === 0 ? (
        <PageControls />
      ) : element !== null ? (
        <ElementFields
          element={element}
          pageWidth={document.page.width}
          pageHeight={document.page.height}
          update={update}
          nameFieldRef={nameFieldRef}
        />
      ) : null}
    </VStack>
  );
}
