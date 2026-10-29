/**
 * Hidden `g+*` hotkey carrier (Spec #3098, ST-3).
 *
 * The command-surface mode keymap grammar is ONE unmodified `[a-z0-9]` stroke,
 * so a two-step `g+*` sequence cannot be expressed in a mode keymap. The 12
 * two-step `WIREFRAME_ACTIONS` bindings therefore live here as `data-hotkey`
 * elements, DERIVED from the table (no hand-copied list) and dispatched
 * through the SAME commands the toolbar and mode keys use:
 * `hotkey-activate` → `executeCommand(WIREFRAME_APP_ID, <command id>)`.
 *
 * The carrier is genuinely hidden and out of the accessibility tree
 * (`hidden` + `display:none` + `aria-hidden`), non-focusable (a `<span>` with
 * no `tabindex`), and scoped: Spec #3098 ST-1 resolves/list only the bindings
 * owned by the currently focused surface-owning application, so the carrier is
 * dead while another application (or no application) is focused.
 *
 * No listener of its own: it only attaches the CU-1 `hotkey-activate` fallback
 * listener to each element (the engine's ONE `document` keydown listener stays
 * the only dispatch listener).
 */

import React from 'react';

import { executeCommand } from '../../../shared/hotkeys/commandSurfaceStore';
import { HOTKEY_ACTIVATE_EVENT } from '../../../shared/hotkeys/hotkeyElements';
import { WIREFRAME_ACTIONS } from '../actions/wireframeActions';
import { WIREFRAME_APP_ID } from '../model/document';

/** One carrier binding: the table's two-step hotkey + its command id. */
export interface WireframeCarrierBinding {
  readonly commandId: string;
  readonly hotkey: string;
  readonly label: string;
}

/**
 * The 12 two-step (`g+*`) table bindings, in table order. Derived from the ONE
 * table — a new two-step row appears on the carrier automatically.
 */
export const WIREFRAME_CARRIER_BINDINGS: readonly WireframeCarrierBinding[] =
  WIREFRAME_ACTIONS.filter(
    (action) =>
      action.toolbar &&
      typeof action.hotkey === 'string' &&
      action.hotkey.includes('+'),
  ).map((action) => ({
    commandId: action.id,
    hotkey: action.hotkey as string,
    label: action.title ?? action.description,
  }));

interface CarrierHotkeyProps {
  readonly binding: WireframeCarrierBinding;
}

/** One hidden binding element; the CU-1 engine dispatches `hotkey-activate`. */
function CarrierHotkey({ binding }: CarrierHotkeyProps): React.ReactElement {
  const ref = React.useRef<HTMLSpanElement | null>(null);

  React.useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const handler = (): void => {
      executeCommand(WIREFRAME_APP_ID, binding.commandId);
    };
    element.addEventListener(HOTKEY_ACTIVATE_EVENT, handler);
    return () => element.removeEventListener(HOTKEY_ACTIVATE_EVENT, handler);
  }, [binding.commandId]);

  return (
    <span
      ref={ref}
      data-hotkey={binding.hotkey}
      data-hotkey-label={binding.label}
      hidden
      aria-hidden="true"
    />
  );
}

/** The hidden carrier root mounted inside the Wireframe app root. */
export function WireframeHotkeyCarrier(): React.ReactElement {
  return (
    <div
      data-testid="wireframe-hotkey-carrier"
      hidden
      aria-hidden="true"
      style={{ display: 'none' }}
    >
      {WIREFRAME_CARRIER_BINDINGS.map((binding) => (
        <CarrierHotkey key={binding.commandId} binding={binding} />
      ))}
    </div>
  );
}
