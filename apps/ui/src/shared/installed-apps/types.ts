/**
 * Wire mirrors for the installed-application commands (Spec #3147, ST-6).
 *
 * Every shape here is the TypeScript side of a Rust struct in
 * `apps/tauri/src-tauri/src/applications/installed_apps/` — the Rust is
 * authoritative and these interfaces are a faithful copy of its `camelCase`
 * serialisation:
 *
 * | TS type | Rust source |
 * |---|---|
 * | `InstalledAppRefusalCode` | `mod.rs` — `InstalledAppRefusalCode`, serde `snake_case`, FROZEN at 22 |
 * | `InstalledAppError` | `mod.rs` — `InstalledAppError` (`code`, `detail`, optional `field`) |
 * | `InstalledAppEntry` | `store.rs` — `InstalledAppEntry` (the list projection) |
 * | `InstalledAppCapabilityStatus` | `store.rs` — `InstalledAppCapabilityStatus` (the `capabilities` member) |
 * | `CapabilityRefusal` | `authority.rs` — the six-code dispatch refusal (the spine's type) |
 * | `FredoThemeToken(s)` | `theme_state.rs` — `ThemeToken` / `ThemePayload` |
 *
 * # The optional-field rule (G-413)
 *
 * Optional values crossing Rust → webview are `Option<T>` with
 * `#[serde(skip_serializing_if = "Option::is_none")]` on the Rust side, so an
 * unset optional arrives as an **ABSENT KEY, never an explicit `null`**. That is
 * why `field` and `description` are optional properties here rather than
 * `| null`: every renderer tests for the KEY (`entry.description !== undefined`),
 * so no `undefined`/`null` can leak into the DOM.
 */

/**
 * The frozen refusal vocabulary (22 codes), in the backend's documented order.
 *
 * The array is the ONE runtime source and the union is derived from it, so the
 * client can narrow a rejection payload against it (`isInstalledAppRefusalCode`)
 * without a second hand-kept list. These strings are the wire form of the Rust
 * enum's `as_str()` and are part of the shipped contract — the copy map in
 * `refusals.ts` keys on exactly these. Never extend the array; a read path that
 * wants a new code reuses an existing one (see the `io_error` note in
 * `refusals.ts`).
 */
export const INSTALLED_APP_REFUSAL_CODES = [
  'not_a_zip',
  'no_manifest',
  'manifest_malformed',
  'manifest_unknown_field',
  'manifest_invalid_field',
  'unsupported_manifest_version',
  'id_invalid',
  'id_reserved',
  'version_invalid',
  'engines_range_invalid',
  'host_incompatible',
  'entry_missing',
  'entry_invalid',
  'unsafe_path',
  'reserved_path',
  'archive_too_large',
  'already_installed',
  'io_error',
  'integrity_mismatch',
  'integrity_record_corrupt',
  'id_not_installed',
  'id_is_installed_app',
] as const;

/** The frozen refusal code union (derived from the runtime list above). */
export type InstalledAppRefusalCode = (typeof INSTALLED_APP_REFUSAL_CODES)[number];

/** Runtime guard: is this value one of the 22 frozen codes? */
export function isInstalledAppRefusalCode(value: unknown): value is InstalledAppRefusalCode {
  return (
    typeof value === 'string' &&
    (INSTALLED_APP_REFUSAL_CODES as readonly string[]).includes(value)
  );
}

/**
 * The `Err` side of every installed-app command.
 *
 * A rejected command call carries this object (Tauri serialises the Rust
 * `Err(InstalledAppError)` into the rejection payload).
 */
export interface InstalledAppError {
  code: InstalledAppRefusalCode;
  /** Human-readable detail. Rendered, never parsed. */
  detail: string;
  /** Present iff the refusal concerns one manifest field; an ABSENT KEY otherwise. */
  field?: string;
}

/**
 * The list projection — what the settings pane and the launcher render.
 *
 * `enginesFredo` is the declared range **verbatim**, never resolved to a
 * boolean: the host already refused an incompatible package at install time, so
 * the UI only reports what the package declared.
 */
export interface InstalledAppEntry {
  id: string;
  displayName: string;
  version: string;
  enginesFredo: string;
  /** RFC 3339 timestamp of the completed install. */
  installedAt: string;
  /** Derived by the backend: `installed-<id>`. */
  windowLabel: string;
  /** ABSENT KEY when the manifest omitted a description — never `null`. */
  description?: string;
  /**
   * The declared/granted backend reach (Spec #3146). ALWAYS present — the
   * backend always emits the three arrays (empty when the package declared
   * nothing), so read it directly: no `?.`, no `?? []`.
   */
  capabilities: InstalledAppCapabilityStatus;
}

/**
 * The closed capability vocabulary (`capabilities.version: 1`, Spec #3146),
 * in the backend's documented order (`mod.rs` — `CAPABILITY_IDS`).
 *
 * The array is the ONE runtime source; the union is derived from it. The STRING
 * VALUES are the wire form of a package manifest's `capabilities` declaration
 * and of the runtime's action→capability table, so they are part of the shipped
 * contract — never rename one, and never add an id without adding it here (the
 * backend refuses an undeclared id at install).
 */
export const CAPABILITY_IDS = [
  'data.tables',
  'high-risk.database-query',
  'high-risk.database-reset',
  'high-risk.process-spawn',
] as const;

/** A declared capability id. */
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

/**
 * The capability ids that require a per-application consent grant, derived by
 * FILTERING the union on the `high-risk.` prefix.
 *
 * The filter is load-bearing: a new `high-risk.*` id joined to `CapabilityId`
 * becomes a member of this union automatically, which makes
 * `CAPABILITY_CONSENT_COPY` (typed `Record<HighRiskCapabilityId, …>` in
 * `capabilityRefusals.ts`) a COMPILE ERROR until it has copy. A new dangerous
 * capability therefore cannot ship with no consequence sentence to show the
 * user.
 */
export type HighRiskCapabilityId = Extract<CapabilityId, `high-risk.${string}`>;

/** Runtime guard: is this value one of the four capability ids? */
export function isCapabilityId(value: unknown): value is CapabilityId {
  return (
    typeof value === 'string' && (CAPABILITY_IDS as readonly string[]).includes(value)
  );
}

/**
 * What an installed application may reach, as the host currently understands it.
 *
 * Mirrors `store.rs` — `InstalledAppCapabilityStatus`. Every array is ALWAYS
 * present (empty is a fact, not an absence) and sorted by the backend.
 */
export interface InstalledAppCapabilityStatus {
  /** The installed application this status is about (the derived id). */
  appId: string;
  /** Every declared capability id, sorted. */
  declared: CapabilityId[];
  /** The declared ids that need a per-application consent grant, sorted. */
  highRisk: CapabilityId[];
  /** The granted subset of `highRisk` for THIS application, sorted. */
  consented: CapabilityId[];
}

/**
 * Compile-time pin of the projection's member name (Spec #3146).
 *
 * The wire name is `capabilities`; the phrase `installedAppCapabilities` from an
 * early planning discussion is STALE and must not exist as a type member. If
 * `capabilities` ever disappears, OR a member with the stale spelling ever
 * appears, this declaration stops compiling — and `pnpm --filter @fredo/ui build`
 * runs `tsc`, so the two spellings can never both live.
 */
type CapabilityProjectionKey = Extract<keyof InstalledAppEntry, 'capabilities'>;
type StaleCapabilityProjectionKey = Extract<
  keyof InstalledAppEntry,
  'installedAppCapabilities'
>;
export const CAPABILITY_PROJECTION_KEY_PIN: [
  CapabilityProjectionKey,
  StaleCapabilityProjectionKey,
] extends ['capabilities', never]
  ? 'capabilities'
  : never = 'capabilities';

/**
 * The six-code AUTHORITY refusal vocabulary (Spec #3146) — a vocabulary
 * separate from the installer's frozen 22. The installed application receives
 * one of these when it calls `window.__FREDO_INSTALLED__.invoke(action, args)`.
 *
 * The backend type is the spine's `CapabilityRefusalCode` (`authority.rs`); these
 * strings are its `snake_case` wire form. The set is closed: a code outside it is
 * never invented here, and the 22 installer codes never absorb one of these.
 */
export const CAPABILITY_REFUSAL_CODES = [
  'action_not_declared',
  'action_not_grantable',
  'consent_required',
  'scope_denied',
  'caller_unknown',
  'app_not_installed',
] as const;

/** A refusal code from the six-code authority vocabulary. */
export type CapabilityRefusalCode = (typeof CAPABILITY_REFUSAL_CODES)[number];

/**
 * Runtime guard: is this value one of the six authority refusal codes?
 *
 * An older app bundle can receive a code a newer host added (or the reverse), so
 * a caller must be able to test the value instead of assuming it.
 */
export function isCapabilityRefusalCode(value: unknown): value is CapabilityRefusalCode {
  return (
    typeof value === 'string' &&
    (CAPABILITY_REFUSAL_CODES as readonly string[]).includes(value)
  );
}

/**
 * The rejection an installed application's `invoke` produces.
 *
 * `appId` is the CALLER'S OWN derived id (never one the caller supplied), and
 * `capability` is an ABSENT KEY when the refusal does not concern one capability
 * (G-413) — never `null`.
 */
export interface CapabilityRefusal {
  code: CapabilityRefusalCode;
  /** The caller's own derived id — echoing it discloses nothing. */
  appId: string;
  /** The action the caller asked for. */
  action: string;
  /** Host-authored specifics. Rendered, never parsed. */
  detail: string;
  /** Present iff the refusal names the capability the action belongs to. */
  capability?: CapabilityId;
}

/** One theme custom property: the CSS name (`--body-bg`) and its resolved value. */
export interface FredoThemeToken {
  name: string;
  value: string;
}

/** The theme transport payload. No optional fields, so no absent-key case. */
export interface FredoThemeTokens {
  tokens: readonly FredoThemeToken[];
  /** Derived host-side from the resolved `--body-bg` luminance. */
  colorScheme: 'light' | 'dark';
}
