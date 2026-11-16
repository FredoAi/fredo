/**
 * app-window — the generic standalone app-window route (Spec #2955 ST-5).
 *
 * NOTE: this module does NOT call `registerApplication()` — it is a route root, not
 * a feature, so it must never appear in the app registry/launcher.
 */
export {
  StandaloneAppWindow,
  STANDALONE_APP_WINDOW_ROOT_TESTID,
  STANDALONE_APP_WINDOW_UNKNOWN_TESTID,
  readStandaloneAppId,
  resolveStandaloneFeature,
  type StandaloneAppWindowProps,
} from './StandaloneAppWindow';
