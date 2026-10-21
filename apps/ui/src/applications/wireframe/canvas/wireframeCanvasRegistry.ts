/**
 * Wireframe canvas stage registry + page-capture seam (Spec #3070, ST-2).
 *
 * ST-6 consumes `captureWireframePagePng()` to export the PAGE (not the
 * viewport) at 2x the logical page size. The registry stays duck-typed so this
 * module never imports `konva` (the export action must not pull the canvas
 * chunk into the entry bundle — F-56).
 *
 * Selection chrome and the Transformer are marked with the
 * `wireframe-capture-hidden` name; they are hidden for the capture and restored
 * afterwards (including when the capture throws).
 */

import { getSnapshot } from '../store/wireframeDocumentStore';

/** Exported PNG is 2x the logical page size (R-4.9). */
export const PAGE_EXPORT_PIXEL_RATIO = 2;

/**
 * Node name of the clipped artboard group. The export captures THIS node (not
 * the stage), so the bitmap is the page at 100 % regardless of the live
 * pan/zoom (F-33).
 */
export const WIREFRAME_PAGE_NAME = 'wireframe-page';

const WIREFRAME_PAGE_SELECTOR = `.${WIREFRAME_PAGE_NAME}`;

/** Node name applied to every editor-only node that must not appear in an export. */
export const CAPTURE_HIDDEN_NAME = 'wireframe-capture-hidden';

const CAPTURE_HIDDEN_SELECTOR = `.${CAPTURE_HIDDEN_NAME}`;

/** Minimal Konva node surface the capture needs (duck-typed). */
export interface WireframeCaptureNode {
  visible(): boolean;
  visible(value: boolean): unknown;
}

/** The Konva `toDataURL` config subset used by the capture. */
export interface WireframeCaptureConfig {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  pixelRatio?: number;
  mimeType?: string;
}

/** The page group the export captures (duck-typed Konva `Group`). */
export interface WireframeCapturePage {
  toDataURL(config?: WireframeCaptureConfig): string;
}

/** Minimal Konva stage surface the registry needs (duck-typed). */
export interface WireframeCaptureStage {
  toDataURL(config?: WireframeCaptureConfig): string;
  find?(selector: string): WireframeCaptureNode[];
  /** Konva `Stage.findOne(selector)` — resolves the page group. */
  findOne?(selector: string): WireframeCapturePage | undefined;
  batchDraw?(): void;
  /** Konva `Stage.getChildren()` — a live stage always holds at least its Layer. */
  getChildren?(): unknown[];
}

let captureStage: WireframeCaptureStage | null = null;

/** Register the mounted Konva stage (pass `null` on unmount). */
export function registerWireframeStage(stage: WireframeCaptureStage | null): void {
  captureStage = stage;
}

/** The currently registered stage (tests / diagnostics). */
export function getWireframeStage(): WireframeCaptureStage | null {
  return captureStage;
}

interface HiddenNode {
  node: WireframeCaptureNode;
  visible: boolean;
}

function hideCaptureChrome(stage: WireframeCaptureStage): HiddenNode[] {
  if (typeof stage.find !== 'function') return [];
  const hidden: HiddenNode[] = [];
  for (const node of stage.find(CAPTURE_HIDDEN_SELECTOR)) {
    hidden.push({ node, visible: node.visible() });
    node.visible(false);
  }
  return hidden;
}

function restoreCaptureChrome(stage: WireframeCaptureStage, hidden: HiddenNode[]): void {
  for (const entry of hidden) entry.node.visible(entry.visible);
  if (typeof stage.batchDraw === 'function') stage.batchDraw();
}

/** Strip the `data:image/png;base64,` prefix Konva's `toDataURL` returns. */
export function stripPngDataUrl(dataUrl: string): string | null {
  const marker = ';base64,';
  const index = dataUrl.indexOf(marker);
  if (index < 0) return null;
  return dataUrl.slice(index + marker.length);
}

/**
 * Capture the page as a base64 PNG (no `data:` prefix) at 2x the logical page
 * size. Returns `null` when no stage (or no page group) is mounted.
 *
 * The capture is the PAGE NODE, requested in the page group's OWN coordinate
 * space: `x: 0, y: 0, width/height = page` with the fixed
 * `PAGE_EXPORT_PIXEL_RATIO`. No live-view value (pan offset or zoom) enters the
 * config, so the bitmap is the 100 % rendering by construction — the canvas
 * paints `captureView` (the identity frame) around the capture (F-33).
 *
 * A stage with no children is destroyed (or never mounted): Konva's
 * `_toKonvaCanvas` then returns an untouched canvas, so the export would be a
 * blank transparent bitmap (round 2, F-33). Refuse it — `exportPng()` surfaces
 * the declared not-ready banner instead of writing an empty PNG.
 */
export function captureWireframePagePng(): string | null {
  const stage = captureStage;
  if (!stage) return null;

  if (typeof stage.getChildren === 'function' && stage.getChildren().length === 0) {
    return null;
  }

  if (typeof stage.findOne !== 'function') return null;
  const pageNode = stage.findOne(WIREFRAME_PAGE_SELECTOR);
  if (!pageNode) return null;

  const { document: wireframe } = getSnapshot();
  const width = wireframe.page.width;
  const height = wireframe.page.height;
  if (!(width > 0) || !(height > 0)) return null;

  const hidden = hideCaptureChrome(stage);
  try {
    const dataUrl = pageNode.toDataURL({
      x: 0,
      y: 0,
      width,
      height,
      pixelRatio: PAGE_EXPORT_PIXEL_RATIO,
      mimeType: 'image/png',
    });
    return stripPngDataUrl(dataUrl);
  } finally {
    restoreCaptureChrome(stage, hidden);
  }
}
