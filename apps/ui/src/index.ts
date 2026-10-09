// ── Providers & hooks ────────────────────────────────────────────────────────
export { AppProvider, useExtension } from './app/providers/AppProvider';
export type { Step } from './app/providers/AppProvider';

export { ThemeProvider, useTheme, ThemeContext } from './app/providers/ThemeProvider';
export type { ThemeContextType } from './app/providers/ThemeProvider';

// ── Settings service ──────────────────────────────────────────────────────────
export { settingsService, serializeValue } from './applications/settings';

export { StreamProvider, useStream } from './shared/contexts/StreamContext';

export { CompanionProvider, useCompanion } from './shared/contexts/CompanionContext';
export type { CompanionState, CompanionPosition } from './shared/contexts/CompanionContext';
export { FredoCompanion } from './shared/components/companion';

// ── Adapters ─────────────────────────────────────────────────────────────────
export type { HostAdapter, LlmMessage } from './app/adapters/HostAdapter';
export { DevAdapter } from './app/adapters/DevAdapter';
export { TauriAdapter } from './app/adapters/TauriAdapter';
export { adapterBridge } from './shared/utils/adapterBridge';

// ── Theme types ───────────────────────────────────────────────────────────────
export type { ThemeMode, Theme } from './app/types/theme';
export { themes } from './app/types/theme';

// ── Shared UI components ──────────────────────────────────────────────────────
export { Provider } from './shared/components/ui/provider';
export { Toaster } from './shared/components/ui/toaster';

// ── Hotkeys: shared Keycap primitive + single announcement channel ───────────
export { Keycap } from './shared/components/hotkeys/Keycap';
export type { KeycapProps } from './shared/components/hotkeys/Keycap';
// Exported for the SERVED Tauri entry (`apps/tauri/src/main.tsx`), which mounts
// the engine for BOTH webviews; the library entry imports it directly.
export { HotkeysProvider } from './shared/hotkeys/HotkeysProvider';
export { describeBinding, describeSequence } from './shared/hotkeys/describe';
export type { BindingDescription, DescribableBinding } from './shared/hotkeys/describe';
export {
  HotkeyAnnouncer,
  HOTKEY_ANNOUNCER_LABEL,
  announce,
  getAnnouncement,
  resetHotkeyAnnouncer,
  subscribeAnnouncer,
  useHotkeyAnnouncer,
} from './shared/hotkeys/announcer';

// ── Hotkeys: the data-hotkey element model (Spec #3009 ST-1) ──────────────────
export {
  DATA_HOTKEY_PATTERN,
  parseDataHotkey,
} from './shared/hotkeys/hotkeyGrammar';
export type { HotkeyGrammar } from './shared/hotkeys/hotkeyGrammar';
export {
  DATA_HOTKEY_ATTR,
  DATA_HOTKEY_LABEL_ATTR,
  HOTKEY_ACTIVATE_EVENT,
  BODY_HOTKEY_COUNT_ATTR,
  BODY_HOTKEY_DUPLICATE_ATTR,
  BODY_HOTKEYS_DISABLED_ATTR,
  DuplicateHotkeyError,
  activateHotkeyElement,
  detectDuplicateHotkeys,
  getElementHotkeyRevision,
  installHotkeyElementDiscovery,
  listElementHotkeys,
  subscribeElementHotkeys,
} from './shared/hotkeys/hotkeyElements';
export type { HotkeyElementEntry, DuplicateHotkeyResult } from './shared/hotkeys/hotkeyElements';

// ── Hotkeys: the always-on bar (Spec #3009 ST-2) ─────────────────────────────
export { HotkeyBar } from './shared/hotkeys/HotkeyBar';
export { buildHotkeyBarModel } from './shared/hotkeys/hotkeyBarModel';
export type {
  HotkeyBarAvailability,
  HotkeyBarModel,
  HotkeyBarRow,
} from './shared/hotkeys/hotkeyBarModel';

// ── Hotkeys: terminal passthrough (focus-derived) ────────────────────────────
export {
  TERMINAL_ROOT_SELECTOR,
  TERMINAL_PASSTHROUGH_TESTID,
  BODY_PASSTHROUGH_ATTR,
  PASSTHROUGH_ANNOUNCEMENT_PREFIX,
  isTerminalFocused,
  isPassthroughActive,
  syncTerminalPassthrough,
  installTerminalPassthrough,
  uninstallTerminalPassthrough,
  isTerminalPassthroughInstalled,
  resetTerminalModeForTests,
  useTerminalPassthrough,
} from './shared/hotkeys/terminalMode';
export type { TerminalPassthroughState } from './shared/hotkeys/terminalMode';

// ── Shared FREDO avatar (canonical mascot, Spec #2850) ───────────────────────
export { FredoAvatar } from './shared/components/fredo-avatar';
export type { FredoAvatarProps, FredoAvatarState } from './shared/components/fredo-avatar';
export {
  FREDO_AVATAR_SPACE,
  FREDO_AVATAR_VIEWBOX,
  FREDO_AVATAR_SOURCE_RECTS,
  expandFredoRects,
  AVATAR_SM,
  AVATAR_MD,
  AVATAR_SIZE,
} from './shared/components/fredo-avatar';
export type {
  FredoRect,
  FredoAvatarSourceRect,
  FredoAvatarSize,
} from './shared/components/fredo-avatar';

// ── Shared window system (own kernel, Spec #2807 ST-1) ───────────────────────
export { WindowSystemProvider } from './shared/window-system/WindowSystemProvider';
export { WindowManager } from './shared/window-system/WindowManager';
export { useWindowActions } from './shared/window-system/useWindowActions';
export { useWindows } from './shared/window-system/useWindows';
export {
  registerWindowCloseCallback,
  unregisterWindowCloseCallback,
} from './shared/window-system/windowStore';
export type { WindowSystemProviderProps } from './shared/window-system/WindowSystemProvider';
export type {
  OpenWindowParams,
  WindowEntry,
  WindowActions,
} from './shared/window-system/windowTypes';

// ── App shell components ──────────────────────────────────────────────────────
export { Router } from './app/routes/Router';

// ── Session utilities (used by BrowserShell in browser-extension) ─────────────
export {
  getConversationUrl,
  getStoredSession,
  storeSession,
  removeSession,
  cleanupExpiredSessions,
  isValidConversationUrl,
  extractConversationId,
} from './shared/utils/session';

// ── Other shared utilities ────────────────────────────────────────────────────
export { hasPAT, storePAT, getOrg, storeOrg, getProject, storeProject } from './shared/utils/patStorage';
export { sendFeatureResponse } from './shared/utils/featureResponseApi';
export type { GenericFeatureResponse } from './shared/utils/featureResponseApi';

// ── Constants ─────────────────────────────────────────────────────────────────
export { API_BASE_URL, STEP_STATUSES } from './shared/constants';

// ── Feature classes ───────────────────────────────────────────────────────────
export { FredoApplicationClass } from './shared/classes/FredoApplicationClass';
export type { GridItemConfig } from './shared/classes/types';

// ── Hotkeys: the ONE registry (Spec #3009 ST-3) ──────────────────────────────
export {
  registerFeatureHotkeys,
  registerFredoAction,
  registerHotkeyHandler,
  listHotkeyActions,
  getHotkeyAction,
  runHotkeyAction,
  resetRegistryForTests,
} from './shared/hotkeys/registry';
export {
  getHotkeysDisabled,
  setHotkeysDisabled,
  subscribeHotkeyStatus,
  subscribeHotkeys,
  getHotkeyRevision,
  getKeymap,
  useHotkeyRevision,
  useHotkeysDisabled,
  resetHotkeyStatusForTests,
} from './shared/hotkeys/store';
export type { HotkeyKeymapView } from './shared/hotkeys/store';
export {
  installHotkeyEngine,
  uninstallHotkeyEngine,
  isHotkeyEngineInstalled,
  resolveActiveBindings,
  handleHotkeyKeydown,
  getFocusSnapshot,
  subscribeFocusSnapshot,
  useFocusSnapshot,
  resetHotkeyEngineForTests,
  LAUNCHER_TOGGLE_ACTION_ID,
} from './shared/hotkeys/engine';
export type { FocusSnapshot } from './shared/hotkeys/engine';
export {
  KEPT_GLOBAL_BINDINGS,
  FOCUS_NEXT_ACTION_ID,
  FOCUS_PREVIOUS_ACTION_ID,
} from './shared/hotkeys/defaults';
export type { KeptGlobalBinding } from './shared/hotkeys/defaults';
export { ACTION_PALETTE_PREFIX } from './shared/hotkeys/types';
export type {
  ApplicationHotkeyAction,
  HotkeyActionId,
  HotkeyInvocationContext,
  HotkeyResetReason,
  HotkeyTier,
  KeySequence,
  KeyStroke,
  Platform,
  RegisteredHotkeyAction,
} from './shared/hotkeys/types';

