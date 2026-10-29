/**
 * Wireframe application command surface (Spec #3098, ST-3).
 *
 * Wireframe is the first application to OPT IN to the Spec #3097 command
 * surface. The surface is declarative data — modes (input states) and commands
 * (capabilities) — and it adds NO second command table: every `toolbar: true`
 * `WIREFRAME_ACTIONS` row becomes ONE command with the SAME id whose `run` is
 * `runWireframeAction(row.id)`. A toolbar click, a declared mode key and the
 * ONE executor (`executeCommand`) therefore converge on the same handler
 * (AC3), which is exactly why the retired toolbar `data-hotkey` workaround can
 * disappear.
 *
 * MODES (root → child through `parent`):
 *   - `wireframe.select`      — root. Every single-step table hotkey plus the
 *                               four new keys `r e v c`.
 *   - `wireframe.draw.rect`   — transient draw mode, `operator`
 *                               `wireframe.create-shape`, `crosshair` cursor.
 *   - `wireframe.draw.ellipse`— same with the ellipse kind.
 *   - `wireframe.pan`         — STICKY pan mode, `grab` cursor.
 *
 * KEYMAP DERIVATION (no hand-copied table): the root keymap is derived at module
 * load from `WIREFRAME_ACTIONS` — every SINGLE-step `hotkey` maps to its own
 * command id — then the four new keys are added. The 12 two-step `g+*` bindings
 * are NOT expressible in a mode keymap (the grammar is one stroke); they are
 * carried by the hidden `WireframeHotkeyCarrier` instead.
 *
 * APP HELPERS (exported for ST-4's canvas operator and the companion path):
 *   - `beginWireframeShapeCreate(shape)` — reset to Select, then push the draw
 *     mode (so a drag always returns to Select, never a stale Pan).
 *   - `createWireframeShapeAt({ shape, rect })` — ST-2's pure
 *     `createShapeElementAtRect` with the live document page, then ONE
 *     `element.add` dispatch (the store auto-selects the new element).
 *   - `applyWireframeFill(fill)` — the PRIMARY (last-selected) shape only.
 *
 * Nothing here touches telemetry, IPC or persistence: every mutation goes
 * through the module-scoped wireframe store, and the keydown path stays
 * synchronous.
 */

import type {
  ApplicationCommandArgs,
  ApplicationCommandMode,
  ApplicationCommandSpec,
  ApplicationCommandSurface,
} from '../../shared/hotkeys/commandSurface';
import {
  pushMode,
  resetApplicationMode,
} from '../../shared/hotkeys/commandSurfaceStore';
import {
  WIREFRAME_ACTIONS,
  runWireframeAction,
} from './actions/wireframeActions';
import {
  WIREFRAME_DRAFT_APP_ID,
  runWireframeDraft,
} from './actions/wireframeDraft';
import { WIREFRAME_APP_ID } from './model/document';
import {
  createShapeElementAtRect,
  isWireframeColorToken,
  type WireframeColorToken,
  type WireframeCreateElementRequest,
  type WireframeShapeDrawKind,
} from './model/elements';
import {
  dispatch,
  getSnapshot,
  primarySelectedId,
} from './store/wireframeDocumentStore';

// ── Mode ids (binding names block) ───────────────────────────────────────────

export const WIREFRAME_SELECT_MODE_ID = 'wireframe.select';
export const WIREFRAME_DRAW_RECT_MODE_ID = 'wireframe.draw.rect';
export const WIREFRAME_DRAW_ELLIPSE_MODE_ID = 'wireframe.draw.ellipse';
export const WIREFRAME_PAN_MODE_ID = 'wireframe.pan';

// ── Command ids (binding names block) ────────────────────────────────────────

export const WIREFRAME_CREATE_ELEMENT_COMMAND_ID = 'wireframe.element.create';
export const WIREFRAME_EDIT_FILL_COMMAND_ID = 'wireframe.element.editFill';
export const WIREFRAME_SELECT_MODE_COMMAND_ID = 'wireframe.mode.select';
export const WIREFRAME_DRAW_RECT_COMMAND_ID = 'wireframe.mode.draw.rect';
export const WIREFRAME_DRAW_ELLIPSE_COMMAND_ID = 'wireframe.mode.draw.ellipse';

/** The existing pan command id — key / toolbar / executor stay identical. */
export const WIREFRAME_TOGGLE_PAN_COMMAND_ID = 'wireframe.view.togglePan';

// ── App-side operator / cursor vocabulary (opaque to the engine) ─────────────

/** `mode.operator` id consumed by ST-4's canvas pointer operator. */
export const WIREFRAME_CREATE_OPERATOR = 'wireframe.create-shape';
/** Draw-mode canvas cursor. */
export const WIREFRAME_DRAW_CURSOR = 'crosshair';
/** Pan-mode canvas cursor. */
export const WIREFRAME_PAN_CURSOR = 'grab';

// ── App helpers ──────────────────────────────────────────────────────────────

/** Reset to Select, then enter the draw mode for `shape`. */
export function beginWireframeShapeCreate(shape: WireframeShapeDrawKind): void {
  resetApplicationMode(WIREFRAME_APP_ID);
  pushMode(
    WIREFRAME_APP_ID,
    shape === 'rect' ? WIREFRAME_DRAW_RECT_MODE_ID : WIREFRAME_DRAW_ELLIPSE_MODE_ID,
  );
}

/**
 * Create + auto-select one shape from a dragged page-space rect. `null` when the
 * normalized rect is below `ELEMENT_MIN_SIZE` (nothing dispatched, nothing
 * selected).
 */
export function createWireframeShapeAt(
  request: WireframeCreateElementRequest,
): string | null {
  const { document } = getSnapshot();
  const element = createShapeElementAtRect({
    shape: request.shape,
    rect: request.rect,
    page: document.page,
  });
  if (element === null) return null;
  dispatch('element.add', { element });
  return element.id;
}

/**
 * Apply a fill token to the PRIMARY (last-selected) element. `false` when
 * nothing is selected or the primary is not a shape — nothing is mutated.
 */
export function applyWireframeFill(fill: WireframeColorToken): boolean {
  const state = getSnapshot();
  const id = primarySelectedId(state);
  if (id === null) return false;
  const primary = state.document.elements.find((element) => element.id === id);
  if (primary === undefined || primary.type !== 'shape') return false;
  return dispatch('elements.update', { patches: { [id]: { fill } } });
}

// ── Command behaviors ────────────────────────────────────────────────────────

/** `wireframe.togglePan` — keep the mode stack in sync with the pan flag. */
function runTogglePan(): boolean {
  const enabling = !getSnapshot().panMode;
  runWireframeAction(WIREFRAME_TOGGLE_PAN_COMMAND_ID);
  if (enabling) {
    pushMode(WIREFRAME_APP_ID, WIREFRAME_PAN_MODE_ID);
  } else {
    resetApplicationMode(WIREFRAME_APP_ID);
  }
  return true;
}

function isDrawKind(value: string | undefined): value is WireframeShapeDrawKind {
  return value === 'rect' || value === 'ellipse';
}

/**
 * `wireframe.element.create` — `{ shape }` (or absent bounds) ARMS the draw
 * mode; `{ shape, x, y, width, height }` creates at the explicit bounds. A
 * below-minimum rect is a no-op (mode unchanged).
 */
function runCreateElement(args?: ApplicationCommandArgs): boolean {
  const shape = args?.shape;
  if (!isDrawKind(shape)) return false;
  const x = args?.x;
  const y = args?.y;
  const width = args?.width;
  const height = args?.height;
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    beginWireframeShapeCreate(shape);
    return true;
  }
  const rect = {
    x: Number(x),
    y: Number(y),
    width: Number(width),
    height: Number(height),
  };
  // A non-finite bound is an invalid request, never a NaN element.
  if (
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height)
  ) {
    return false;
  }
  const created = createWireframeShapeAt({ shape, rect });
  if (created === null) return false;
  resetApplicationMode(WIREFRAME_APP_ID);
  return true;
}

/**
 * `wireframe.element.editFill` — the prompt commit arrives as `{ value }`, the
 * companion/executor path as `{ fill }`. Invalid → no mutation, no mode change.
 * Valid → apply to the primary shape, then return to Select even when there is
 * nothing to fill (the prompt still closes).
 */
function runEditFill(args?: ApplicationCommandArgs): boolean {
  const raw = args?.fill ?? args?.value;
  if (raw === undefined) return false;
  const candidate = raw.trim();
  if (!isWireframeColorToken(candidate)) return false;
  const applied = applyWireframeFill(candidate);
  resetApplicationMode(WIREFRAME_APP_ID);
  return applied;
}

// ── Mode keymaps ─────────────────────────────────────────────────────────────

/** Every SINGLE-step table hotkey → its own command id. */
function deriveRootKeymap(): Record<string, string> {
  const keymap: Record<string, string> = {};
  for (const action of WIREFRAME_ACTIONS) {
    const hotkey = action.hotkey;
    if (hotkey === undefined || hotkey.includes('+')) continue;
    keymap[hotkey] = action.id;
  }
  keymap.r = WIREFRAME_DRAW_RECT_COMMAND_ID;
  keymap.e = WIREFRAME_DRAW_ELLIPSE_COMMAND_ID;
  keymap.v = WIREFRAME_SELECT_MODE_COMMAND_ID;
  keymap.c = WIREFRAME_EDIT_FILL_COMMAND_ID;
  return keymap;
}

/** Select legend order (A2): the four new keys lead, then the inherited table. */
const SELECT_KEYMAP_ORDER: readonly string[] = [
  'r',
  'e',
  'c',
  'v',
  'h',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'p',
  'k',
  'l',
  'u',
  'y',
  'n',
  '0',
  'w',
  'o',
  't',
];

const DRAW_KEYMAP: Readonly<Record<string, string>> = {
  r: WIREFRAME_DRAW_RECT_COMMAND_ID,
  e: WIREFRAME_DRAW_ELLIPSE_COMMAND_ID,
  c: WIREFRAME_EDIT_FILL_COMMAND_ID,
  v: WIREFRAME_SELECT_MODE_COMMAND_ID,
};
const DRAW_KEYMAP_ORDER: readonly string[] = ['r', 'e', 'c', 'v'];

const PAN_KEYMAP: Readonly<Record<string, string>> = {
  h: WIREFRAME_TOGGLE_PAN_COMMAND_ID,
  v: WIREFRAME_SELECT_MODE_COMMAND_ID,
};
const PAN_KEYMAP_ORDER: readonly string[] = ['h', 'v'];

// ── Modes ────────────────────────────────────────────────────────────────────

const SELECT_MODE: ApplicationCommandMode = {
  id: WIREFRAME_SELECT_MODE_ID,
  label: 'Select',
  parent: null,
  keymap: deriveRootKeymap(),
  keymapOrder: SELECT_KEYMAP_ORDER,
};

const DRAW_RECT_MODE: ApplicationCommandMode = {
  id: WIREFRAME_DRAW_RECT_MODE_ID,
  label: 'Rectangle',
  parent: WIREFRAME_SELECT_MODE_ID,
  keymap: DRAW_KEYMAP,
  keymapOrder: DRAW_KEYMAP_ORDER,
  transient: true,
  operator: WIREFRAME_CREATE_OPERATOR,
  cursor: WIREFRAME_DRAW_CURSOR,
};

const DRAW_ELLIPSE_MODE: ApplicationCommandMode = {
  id: WIREFRAME_DRAW_ELLIPSE_MODE_ID,
  label: 'Ellipse',
  parent: WIREFRAME_SELECT_MODE_ID,
  keymap: DRAW_KEYMAP,
  keymapOrder: DRAW_KEYMAP_ORDER,
  transient: true,
  operator: WIREFRAME_CREATE_OPERATOR,
  cursor: WIREFRAME_DRAW_CURSOR,
};

const PAN_MODE: ApplicationCommandMode = {
  id: WIREFRAME_PAN_MODE_ID,
  label: 'Pan',
  parent: WIREFRAME_SELECT_MODE_ID,
  keymap: PAN_KEYMAP,
  keymapOrder: PAN_KEYMAP_ORDER,
  sticky: true,
  cursor: WIREFRAME_PAN_CURSOR,
};

// ── Commands ─────────────────────────────────────────────────────────────────

/**
 * The model-facing DIRECTIVE for the published `wireframe` skill (Spec #3099,
 * ST-3). It names the REQUEST CLASS the model has to recognise — create, draft,
 * sketch, mock up or visualize an app/screen/page/dashboard — and the ONE
 * action that satisfies it (the deterministic `draftApp`), then bounds the
 * skill to Wireframe requests (the F-47 lesson: ids alone are answered in
 * prose). The generated offer appends the published action ids (ST-4).
 */
export const WIREFRAME_COMPANION_DESCRIPTION =
  'Create or edit a wireframe in the Fredo Wireframe app. Call this whenever the user asks to create, draft, sketch, mock up or visualize an app/screen/page/dashboard — including "let\'s create a new wireframe for <app>" or "I would like a way to visualize <thing>": use action=wireframe.companion.draftApp with app_name set to the app the user named, then the page is drafted for you. Use ONLY for Wireframe requests.';

/** One command per toolbar row — SAME id, SAME handler (no second table). */
const TABLE_COMMANDS: readonly ApplicationCommandSpec[] = WIREFRAME_ACTIONS.filter(
  (action) => action.toolbar,
).map((action) => ({
  id: action.id,
  // The SHORT toolbar label — never the long `description`.
  title: action.title ?? action.id,
  // D1: the SAME model-facing sentence the retired Rust catalog mirrored.
  description: action.description,
  // A table row consumes no arguments (Spec #3099: declare `[]`, never omit).
  args: [],
  run:
    action.id === WIREFRAME_TOGGLE_PAN_COMMAND_ID
      ? runTogglePan
      : () => runWireframeAction(action.id),
}));

const SURFACE_COMMANDS: readonly ApplicationCommandSpec[] = [
  {
    id: WIREFRAME_SELECT_MODE_COMMAND_ID,
    title: 'Select',
    description: 'Switch to Select mode so clicks and drags select and move elements',
    args: [],
    run: () => {
      resetApplicationMode(WIREFRAME_APP_ID);
      return true;
    },
  },
  {
    id: WIREFRAME_DRAW_RECT_COMMAND_ID,
    title: 'Rectangle',
    description: 'Arm the rectangle draw tool so the next drag creates a rectangle',
    args: [],
    run: () => {
      beginWireframeShapeCreate('rect');
      return true;
    },
  },
  {
    id: WIREFRAME_DRAW_ELLIPSE_COMMAND_ID,
    title: 'Ellipse',
    description: 'Arm the ellipse draw tool so the next drag creates an ellipse',
    args: [],
    run: () => {
      beginWireframeShapeCreate('ellipse');
      return true;
    },
  },
  {
    id: WIREFRAME_CREATE_ELEMENT_COMMAND_ID,
    title: 'Create shape',
    description:
      'Create a rectangle or ellipse at explicit page bounds, or arm the matching draw tool when only the shape is given',
    args: [
      {
        name: 'shape',
        required: true,
        description: 'Shape kind: rect or ellipse',
        validate: isDrawKind,
      },
      { name: 'x', description: 'Page-space left edge in px' },
      { name: 'y', description: 'Page-space top edge in px' },
      { name: 'width', description: 'Page-space width in px' },
      { name: 'height', description: 'Page-space height in px' },
    ],
    run: runCreateElement,
  },
  {
    id: WIREFRAME_EDIT_FILL_COMMAND_ID,
    title: 'Fill',
    description: 'Set the fill token of the selected shape',
    prompt: {
      label: 'Fill token',
      placeholder:
        'surface | muted | border | text | textMuted | accent | success | warning | error | info',
      validate: (value) => isWireframeColorToken(value.trim()),
    },
    // The companion path supplies `fill` and therefore SKIPS the inline prompt.
    args: [
      {
        name: 'fill',
        required: true,
        description:
          'Fill token: surface, muted, border, text, textMuted, accent, success, warning, error or info',
        validate: (value) => isWireframeColorToken(value.trim()),
      },
    ],
    run: runEditFill,
  },
  {
    id: WIREFRAME_DRAFT_APP_ID,
    title: 'Draft app',
    description:
      'Draft a deterministic starter wireframe for a named app: a navbar, a heading with the app name, and a report card',
    args: [
      {
        name: 'app_name',
        required: true,
        description:
          'The app name the user named; used for the heading and the report card label',
      },
      {
        name: 'summary',
        description: 'Optional context; the deterministic draft does not use it',
      },
    ],
    run: (args) => runWireframeDraft(args).length > 0,
  },
];

/** The Wireframe command surface — `WireframeFeature.commandSurface`. */
export const wireframeCommandSurface: ApplicationCommandSurface = {
  modes: [SELECT_MODE, DRAW_RECT_MODE, DRAW_ELLIPSE_MODE, PAN_MODE],
  commands: [...TABLE_COMMANDS, ...SURFACE_COMMANDS],
  companion: {
    description: WIREFRAME_COMPANION_DESCRIPTION,
  },
};
