/**
 * Wireframe element model (Spec #3070, ST-1, C2).
 *
 * Nine element types cover the twelve AC1 categories. Document order is paint
 * order. Every element carries a stable `crypto.randomUUID()` id plus the six
 * common geometry/state fields; each type adds its own properties.
 *
 * Placement rules (UI/UX section 3.1): new non-section elements are centred on
 * the page and cascade downwards by 24 logical px until they no longer overlap
 * a visible element (max 12 steps, clamped inside the page). Sections are
 * page-anchored.
 */

import type { WireframePage } from './document';
import { centredRect, clampRectToPage, rectsIntersect, type WireframeRect } from './geometry';

export type WireframeElementType =
  | 'text'
  | 'button'
  | 'input'
  | 'image'
  | 'icon'
  | 'card'
  | 'section'
  | 'shape'
  | 'line';

export type WireframeTextStyle = 'body' | 'heading';
export type WireframeTextSize = 's' | 'm' | 'l' | 'xl';
export type WireframeAlign = 'left' | 'center' | 'right';
export type WireframeButtonAppearance = 'primary' | 'secondary' | 'ghost';
export type WireframeSectionPreset = 'header' | 'navbar' | 'sidebar' | 'footer';
export type WireframeShapeKind = 'rect' | 'ellipse' | 'triangle';
export type WireframeBorderWidth = 'none' | 'thin' | 'thick';
export type WireframeRadius = 'none' | 's' | 'm' | 'l';
export type WireframeColorToken =
  | 'surface'
  | 'muted'
  | 'border'
  | 'text'
  | 'textMuted'
  | 'accent'
  | 'success'
  | 'warning'
  | 'error'
  | 'info';

export type WireframeIconId =
  | 'user'
  | 'chart'
  | 'settings'
  | 'search'
  | 'home'
  | 'bell'
  | 'calendar'
  | 'folder'
  | 'mail'
  | 'star'
  | 'check'
  | 'arrowRight';

interface WireframeElementBase {
  id: string;
  type: WireframeElementType;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  locked: boolean;
}

export type WireframeElement =
  | (WireframeElementBase & {
      type: 'text';
      text: string;
      textStyle: WireframeTextStyle;
      size: WireframeTextSize;
      align: WireframeAlign;
    })
  | (WireframeElementBase & {
      type: 'button';
      label: string;
      appearance: WireframeButtonAppearance;
    })
  | (WireframeElementBase & { type: 'input'; placeholder: string })
  | (WireframeElementBase & { type: 'image' })
  | (WireframeElementBase & { type: 'icon'; iconId: WireframeIconId })
  | (WireframeElementBase & { type: 'card'; label: string })
  | (WireframeElementBase & { type: 'section'; preset: WireframeSectionPreset })
  | (WireframeElementBase & {
      type: 'shape';
      shape: WireframeShapeKind;
      fill: WireframeColorToken;
      border: WireframeBorderWidth;
      radius: WireframeRadius;
    })
  | (WireframeElementBase & { type: 'line' });

/**
 * Property-change patch accepted by the store. Geometry, state and every
 * type-specific property is patchable; `id` and `type` are immutable.
 */
export type WireframeElementPatch = Partial<{
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  locked: boolean;
  text: string;
  textStyle: WireframeTextStyle;
  size: WireframeTextSize;
  align: WireframeAlign;
  label: string;
  appearance: WireframeButtonAppearance;
  placeholder: string;
  iconId: WireframeIconId;
  preset: WireframeSectionPreset;
  shape: WireframeShapeKind;
  fill: WireframeColorToken;
  border: WireframeBorderWidth;
  radius: WireframeRadius;
}>;

export const WIREFRAME_ELEMENT_TYPES: readonly WireframeElementType[] = [
  'text',
  'button',
  'input',
  'image',
  'icon',
  'card',
  'section',
  'shape',
  'line',
] as const;

/** Human labels used by the toolbar / property panel. */
export const WIREFRAME_ELEMENT_LABELS: Readonly<Record<WireframeElementType, string>> = {
  text: 'Text',
  button: 'Button',
  input: 'Input',
  image: 'Image',
  icon: 'Icon',
  card: 'Card',
  section: 'Section',
  shape: 'Shape',
  line: 'Line',
};

/** Default box size per type (`section` uses the preset-specific table below). */
export const DEFAULT_ELEMENT_SIZE: Readonly<
  Record<Exclude<WireframeElementType, 'section'>, { width: number; height: number }>
> = {
  text: { width: 320, height: 48 },
  button: { width: 160, height: 44 },
  input: { width: 260, height: 44 },
  image: { width: 240, height: 160 },
  icon: { width: 48, height: 48 },
  card: { width: 360, height: 240 },
  shape: { width: 160, height: 120 },
  line: { width: 320, height: 24 },
};

export const DEFAULT_ICON_ID: WireframeIconId = 'star';
export const DEFAULT_SECTION_PRESET: WireframeSectionPreset = 'header';
export const DEFAULT_SHAPE_KIND: WireframeShapeKind = 'rect';

/** Collision cascade step (UI/UX section 3.1). */
export const CASCADE_STEP_PX = 24;
/** Collision cascade maximum steps. */
export const CASCADE_MAX_STEPS = 12;
/** Duplicate offset (UI/UX section 3.5). */
export const DUPLICATE_OFFSET_PX = 16;

/** Generate an element id. Uses `crypto.randomUUID()` when available. */
export function createElementId(): string {
  const cryptoApi = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  return `wireframe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Page-anchored geometry per section preset. */
export function sectionRect(
  preset: WireframeSectionPreset,
  page: WireframePage,
): WireframeRect {
  switch (preset) {
    case 'navbar':
      return { x: 0, y: 0, width: page.width, height: Math.min(64, page.height) };
    case 'sidebar':
      return { x: 0, y: 0, width: Math.min(240, page.width), height: page.height };
    case 'footer':
      return {
        x: 0,
        y: Math.max(0, page.height - 96),
        width: page.width,
        height: Math.min(96, page.height),
      };
    case 'header':
    default:
      return { x: 0, y: 0, width: page.width, height: Math.min(96, page.height) };
  }
}

export interface CreateElementOptions {
  page: WireframePage;
  /** Existing elements (used by the collision cascade). */
  elements?: readonly WireframeElement[];
  /** Override the generated id (tests / deterministic fixtures). */
  id?: string;
  /** Section preset override. */
  preset?: WireframeSectionPreset;
  /** Shape kind override. */
  shape?: WireframeShapeKind;
  /** Text content override. */
  text?: string;
}

/** Find a non-overlapping origin by cascading downwards from the centre. */
function cascadeFromCentre(
  page: WireframePage,
  rect: WireframeRect,
  elements: readonly WireframeElement[],
): WireframeRect {
  const visible = elements.filter((element) => element.visible);
  let next = clampRectToPage({ ...rect }, page);
  for (let step = 0; step < CASCADE_MAX_STEPS; step += 1) {
    const collides = visible.some((element) => rectsIntersect(next, element));
    if (!collides) return next;
    const shifted = clampRectToPage({ ...next, y: next.y + CASCADE_STEP_PX }, page);
    // At the page bottom the clamp stops moving — stop rather than spin.
    if (shifted.y === next.y) return shifted;
    next = shifted;
  }
  return next;
}

/**
 * Build one element of `type` with the declared defaults and a page-relative
 * position. Sections are page-anchored; everything else is centred and
 * cascaded clear of existing visible elements.
 */
export function createDefaultElement(
  type: WireframeElementType,
  options: CreateElementOptions,
): WireframeElement {
  const { page, elements = [] } = options;
  const id = options.id ?? createElementId();

  if (type === 'section') {
    const preset = options.preset ?? DEFAULT_SECTION_PRESET;
    return {
      id,
      type: 'section',
      preset,
      ...sectionRect(preset, page),
      visible: true,
      locked: false,
    };
  }

  const size = DEFAULT_ELEMENT_SIZE[type];
  const rect = cascadeFromCentre(page, centredRect(page, size.width, size.height), elements);
  const base = {
    id,
    x: rect.x,
    y: rect.y,
    width: size.width,
    height: size.height,
    visible: true,
    locked: false,
  };

  switch (type) {
    case 'text':
      return {
        ...base,
        type: 'text',
        text: options.text ?? 'Text',
        textStyle: 'body',
        size: 'm',
        align: 'left',
      };
    case 'button':
      return { ...base, type: 'button', label: 'Button', appearance: 'primary' };
    case 'input':
      return { ...base, type: 'input', placeholder: 'Input field' };
    case 'image':
      return { ...base, type: 'image' };
    case 'icon':
      return { ...base, type: 'icon', iconId: DEFAULT_ICON_ID };
    case 'card':
      return { ...base, type: 'card', label: 'Card' };
    case 'shape':
      return {
        ...base,
        type: 'shape',
        shape: options.shape ?? DEFAULT_SHAPE_KIND,
        fill: 'muted',
        border: 'thin',
        radius: 'm',
      };
    case 'line':
    default:
      return { ...base, type: 'line' };
  }
}

/**
 * Duplicate an element: new identity, offset by the declared delta, clamped to
 * the page, every other property (including `locked`/`visible`) preserved.
 */
export function duplicateWireframeElement(
  element: WireframeElement,
  page: WireframePage,
): WireframeElement {
  return clampRectToPage(
    {
      ...element,
      id: createElementId(),
      x: element.x + DUPLICATE_OFFSET_PX,
      y: element.y + DUPLICATE_OFFSET_PX,
    },
    page,
  );
}
