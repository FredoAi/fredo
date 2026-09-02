// ── Providers & hooks ────────────────────────────────────────────────────────
export { AppProvider, useExtension } from './app/providers/AppProvider';
export type { Step } from './app/providers/AppProvider';
export { WindowStyleProvider, useWindowStyle, WINDOW_STYLES } from './shared/contexts/WindowStyleContext';
export { AnimationProvider, useAnimation } from './shared/contexts/AnimationContext';
export type { WindowStyleId } from './shared/contexts/WindowStyleContext';

export { ThemeProvider, useTheme, ThemeContext } from './app/providers/ThemeProvider';
export type { ThemeContextType } from './app/providers/ThemeProvider';

// ── Settings service ──────────────────────────────────────────────────────────
export { settingsService, serializeValue } from './features/settings';

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

// ── App shell components ──────────────────────────────────────────────────────
export { Router } from './app/routes/Router';

// ── Feature components ────────────────────────────────────────────────────────
export { ThemeSelector } from './features/home/components/settings/ThemeSelector';
export { AnimationSelector } from './features/home/components/settings/AnimationSelector';
export { SettingsPanel } from './features/home/components/settings/SettingsPanel';
export { WindowStyleSelector } from './features/home/components/settings/WindowStyleSelector';

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
export { FredoFeatureClass } from './shared/classes/FredoFeatureClass';
export type { GridItemConfig } from './shared/classes/types';
