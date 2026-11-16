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
