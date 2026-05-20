/**
 * FredoFeatureClass - Base class for grid-based features
 * 
 * All features that render in the Home grid should extend this class.
 * Enforces a consistent pattern for event processing, rendering, and configuration.
 * 
 * Features that extend this class:
 * - Diagram (Infrastructure Diagram)
 * - QueryViewer (multiple instances for query results)
 * 
 * Features that DO NOT extend this class:
 * - SideStepper (fixed position sidebar)
 * - StreamStatus (fixed position status indicator)
 * - Dashboard (fallback when grid is empty)
 * - Settings (modal/panel components)
 * 
 * ## Sending Responses to MCP
 * 
 * Features can send user responses back to the AI agent via the generic response system:
 * 
 * ```typescript
 * import { sendFeatureResponse } from '../utils/featureResponseApi';
 * import { useExtension } from '../app/providers/ExtensionProvider';
 * 
 * const MyFeature = () => {
 *   const { connectionId } = useExtension();
 *   
 *   const handleAction = async () => {
 *     await sendFeatureResponse(connectionId, 'my-feature', {
 *       action: 'confirmed',
 *       data: { /* feature-specific payload *\/ }
 *     });
 *   };
 * };
 * ```
 * 
 * The AI agent receives all responses for the session via the `uiResponses` array.
 */

import type { ReactElement } from 'react';
import type { IconType } from 'react-icons';
import type { StreamEvent } from '../contexts/StreamContext';
import type { EventFilter, GridItemConfig } from './types';

export abstract class FredoFeatureClass<TProps = {}> {
  // === REQUIRED IMPLEMENTATIONS ===

  /**
   * Stable kebab-case identifier used as the window key.
   * Must be unique across all singleton features.
   */
  abstract readonly id: string;

  /**
   * Display name shown in the grid (when minimized)
   */
  abstract readonly name: string;
  
  /**
   * Icon shown in the grid (when minimized)
   */
  abstract readonly icon: IconType;
  
  /**
   * Event filters - which events should this feature process
   * Empty array = no event processing
   */
  abstract readonly eventFilters: EventFilter[];
  
  /**
   * Process an event that matches the filters
   * @param event - The stream event to process
   */
  abstract processEvent(event: StreamEvent): void;
  
  /**
   * Render the feature component
   * @param props - Optional props to pass to the component
   */
  abstract render(props?: TProps): ReactElement;
  
  // === DEFAULTS (can override) ===
  
  /**
   * Grid configuration
   * Default: closable and maximizable
   */
  readonly gridConfig: GridItemConfig = {
    closable: true,
    maximizable: true,
  };

  /**
   * Whether this feature should be shown in the app directory / launcher.
   * Showable features are discoverable by the user from the UI.
   * Default: false (hidden from app directory)
   */
  readonly showable: boolean = true;

  /**
   * Whether this feature supports multiple simultaneous instances (factory mode).
   * - false (default, singleton): only one instance exists; incoming events update it.
   * - true (factory): each triggering event spawns a new independent instance.
   */
  readonly isMultiWindow: boolean = false;

  /**
   * Whether this feature has a settings panel.
   * When true, `renderSettings()` must be implemented — it will be rendered
   * inside the feature's settings drawer/panel.
   * Default: false
   */
  readonly hasSettings: boolean = false;

  /**
   * Render the feature's settings panel.
   * Required when `hasSettings` is true.
   *
   * The panel should call `useSettingsSave(fn)` from `features/settings/SettingsSaveContext`
   * to register its save function with the modal's unified Save button.
   * Direct save buttons inside the panel are discouraged — the settings modal
   * owns the single Save button and delegates to whatever fn is registered.
   */
  renderSettings?(): ReactElement;
  
  // === INTERNAL CALLBACKS (managed by Home.tsx) ===
  
  /**
   * Callback to request a re-render when internal state changes
   * Registered by Home.tsx when feature is added to grid
   */
  protected forceRerender?: () => void;
  
  /**
   * Callback to close this feature from the grid
   * Registered by Home.tsx when feature is added to grid
   */
  protected onCloseRequested?: () => void;
  
  /**
   * Register re-render callback (called by Home.tsx)
   */
  public registerRerenderCallback(callback: () => void) {
    this.forceRerender = callback;
  }
  
  /**
   * Register close callback (called by Home.tsx)
   */
  public registerCloseCallback(callback: () => void) {
    this.onCloseRequested = callback;
  }
  
  // === LIFECYCLE HOOKS (optional, implement as needed) ===
  
  /**
   * Called when feature is added to the grid
   * Use for initialization, API calls, etc.
   */
  onMount?(): void | Promise<void>;
  
  /**
   * Called when feature is removed from the grid
   * Use for cleanup, closing connections, etc.
   */
  onUnmount?(): void | Promise<void>;
}
