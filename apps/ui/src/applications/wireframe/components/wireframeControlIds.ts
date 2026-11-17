/**
 * Wireframe pointer-control test ids (Spec #3151, ST-5 — Contracts §11).
 *
 * ONE import site for the eight testid constants the re-homed pointer strip
 * publishes. No component carries a literal testid, so a rename is a single
 * edit and a test can never drift from the rendered hook.
 *
 * The accessible NAMES are the surviving `WIREFRAME_ACTIONS` titles verbatim
 * (`actions/wireframeActions.ts`) — the testid names only the hook.
 */

export const WIREFRAME_UNDO_TESTID = 'wireframe-undo';
export const WIREFRAME_REDO_TESTID = 'wireframe-redo';
export const WIREFRAME_ARRANGE_TESTID = 'wireframe-arrange';
export const WIREFRAME_ARRANGE_ITEM_TESTID = 'wireframe-arrange-item';
export const WIREFRAME_FILE_MENU_TESTID = 'wireframe-file-menu';
export const WIREFRAME_FILE_ITEM_TESTID = 'wireframe-file-item';
export const WIREFRAME_VIEW_TESTID = 'wireframe-view-controls';
export const WIREFRAME_VIEW_ITEM_TESTID = 'wireframe-view-item';
