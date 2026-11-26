/**
 * `@fredo/authoring` — the published authoring surface (Spec #3145, ST-2).
 *
 * These are the types an installed application is written against, mirrored from
 * the shipped product:
 *   - `FredoAction`       — the 8 dispatchable actions, in the shipped order
 *                           (`applications/installed_apps/dispatch.rs`, `DISPATCH_TABLE`);
 *   - `FredoRefusalCode`  — the 6 authority refusal codes, in the shipped order
 *                           (`applications/installed_apps/authority.rs`,
 *                           `CapabilityRefusalCode::ALL`);
 *   - `FredoInstalledGlobal` — `window.__FREDO_INSTALLED__`, the ONE call route;
 *   - `InstalledAppContext`  — what `mount(ctx)` receives.
 *
 * The manifest schema is GENERATED from the parser and lives beside this file at
 * `schema/fredo-app.schema.json`; `bin/fredo-app.mjs check` validates against it.
 *
 * COMPANIONS ARE VENDORED, NOT RESOLVED. A package's files are served from the
 * install record's whitelist, so a companion library must be copied INTO the
 * package (e.g. `vendor/fredo-theme/`) and imported relatively:
 *
 *     import { cssVar } from './vendor/fredo-theme/index.mjs';
 *
 * A bare specifier (`@fredo/theme`) never resolves in an installed application's
 * document — there is no bundler and no import map — and a file outside the
 * package has no route. Such a specifier is refused by the kit's scan and the
 * package fails to load.
 */

/**
 * The colour state an application is handed at mount time.
 *
 * SNAPSHOT, NOT A LIVE HANDLE: a theme change replaces
 * `window.__FREDO_INSTALLED__.theme` with a new object and never mutates the one
 * `mount` received. The AUTHORITATIVE live colour state is the set of CSS custom
 * properties the host keeps updated on your document's `documentElement` — paint
 * from `var(--…)` (or the published `@fredo/theme` names), never from this
 * object at paint time.
 */
export interface FredoThemeTokens {
  /** The resolved token stream as it stood when this window mounted. */
  readonly tokens: readonly { readonly name: string; readonly value: string }[];
  /** The scheme the host derived for native widget/scrollbar rendering. */
  readonly colorScheme: 'light' | 'dark';
}

/** One `capabilities.highRisk` id — the consent-gated capabilities. */
export type FredoHighRiskCapabilityId =
  | 'high-risk.database-query'
  | 'high-risk.database-reset'
  | 'high-risk.process-spawn';

/**
 * The 8 dispatchable actions, in the shipped order (`DISPATCH_TABLE`).
 *
 * `action` is an ACTION, never a command name: `invoke()` forwards
 * `{ request: { action, args } }` to exactly one host command
 * (`installed_app_invoke`), and the host decides from the action + your declared
 * capabilities. An action outside this list is `action_not_grantable`.
 */
export type FredoAction =
  | 'application_data_read'
  | 'application_data_write'
  | 'application_data_delete'
  | 'application_data_declare'
  | 'db_query_execute'
  | 'db_result_page'
  | 'pg_database_reset'
  | 'spawn_terminal_session';

/**
 * The 6 authority refusal codes an action can reject with, in the shipped order
 * (`CapabilityRefusalCode::ALL`).
 */
export type FredoRefusalCode =
  | 'action_not_declared'
  | 'action_not_grantable'
  | 'consent_required'
  | 'scope_denied'
  | 'caller_unknown'
  | 'app_not_installed';

/**
 * A refusal, as the host returns it.
 *
 * `capability` is ABSENT when the refusal does not concern one — never an
 * explicit `null` (the host serializes it with `skip_serializing_if`), so test
 * for the key's presence, not for `=== null`.
 */
export interface FredoRefusal {
  readonly code: FredoRefusalCode;
  readonly appId: string;
  readonly action: string;
  readonly capability?: FredoHighRiskCapabilityId | 'data.tables' | string;
  readonly detail: string;
}

/** What `mount(ctx)` receives. */
export interface InstalledAppContext {
  /** Your manifest `id`. */
  readonly appId: string;
  /** Your manifest `version`. */
  readonly version: string;
  /** The colour state at mount time — a SNAPSHOT (see `FredoThemeTokens`). */
  readonly theme: FredoThemeTokens;
  /** The element your application draws into. */
  readonly root: HTMLElement;
}

/** The module contract: your entry module exports `mount`, which the host calls once. */
export type InstalledAppMount = (ctx: InstalledAppContext) => void | Promise<void>;

/** `window.__FREDO_INSTALLED__` — the host facade an installed document sees. */
export interface FredoInstalledGlobal {
  readonly appId: string;
  readonly version: string;
  /** The live theme object. Prefer the CSS variables: `ctx.theme` is a snapshot. */
  readonly theme: FredoThemeTokens;
  /**
   * The ONE call route. Resolves with the action's result, or rejects with a
   * `FredoRefusal` (`{ code, appId, action, capability?, detail }`).
   */
  invoke<T = unknown>(action: FredoAction, args?: Record<string, unknown>): Promise<T>;
}

declare global {
  interface Window {
    /** Present in an installed application's document; absent everywhere else. */
    readonly __FREDO_INSTALLED__?: FredoInstalledGlobal;
  }
}
