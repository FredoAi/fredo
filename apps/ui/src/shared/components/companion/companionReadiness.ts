/**
 * Companion setup readiness — wire types for the backend
 * `check_companion_readiness` / `install_llama_cpp` commands (Spec #2855).
 *
 * The backend owns the prerequisite SET; these ids are the stable join key
 * between the backend reports and the ordered `COMPANION_SETUP_STEPS` registry.
 * #2857 appends `'serverLaunch'` here and to the registry.
 */

export type PrerequisiteId = 'llamaServer' | 'modelFiles';

/** Determined states returned by the backend. */
export type PrerequisiteState = 'missing' | 'installed' | 'error';

/**
 * UI state vocabulary: `checking` exists only while a probe is in flight.
 * The gate is never satisfied by `checking`/`missing`/`error`.
 */
export type PrerequisiteUiState = 'checking' | PrerequisiteState;

export interface PrerequisiteReport {
  id: PrerequisiteId;
  state: PrerequisiteState;
  detail: string;
  resolvedPath: string | null;
}

export interface CompanionReadiness {
  /** true iff EVERY prerequisite is `installed`. */
  ready: boolean;
  prerequisites: PrerequisiteReport[];
}

export type LlamaCppInstallCode =
  | 'wingetUnavailable'
  | 'installFailed'
  | 'spawnFailed';

export interface LlamaCppInstallResult {
  success: boolean;
  output: string;
  error: string | null;
  code: LlamaCppInstallCode | null;
}
