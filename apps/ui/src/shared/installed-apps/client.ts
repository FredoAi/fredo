/**
 * The five installed-application command wrappers (Spec #3147, ST-6).
 *
 * | Wrapper | Rust command | Args | Success |
 * |---|---|---|---|
 * | `installPackage` | `installed_app_install` | `archivePath?` (absent ⇒ native picker) | `InstalledAppEntry` |
 * | `listInstalledApps` | `installed_apps_list` | — | `InstalledAppEntry[]` |
 * | `openInstalledApp` | `installed_app_open` | `appId` | `()` |
 * | `closeInstalledApp` | `installed_app_close` | `appId` | `bool` |
 * | `pushTheme` | `installed_apps_push_theme` | `payload` | `()` |
 * | `grantCapabilityConsent` | `installed_app_consent_grant` | `appId`, `capability` | `InstalledAppCapabilityStatus` |
 * | `revokeCapabilityConsent` | `installed_app_consent_revoke` | `appId`, `capability` | `InstalledAppCapabilityStatus` |
 *
 * # Transport
 *
 * Every call goes through `adapterBridge.invoke()` — the shipped non-React seam
 * (`shared/utils/adapterBridge.ts`). There is deliberately **no static
 * `@tauri-apps/api` import**: the bridge owns the dynamic import and the
 * browser-dev fallback, and a static import would break `pnpm dev:ui`.
 *
 * # Failure is typed, and a malformed rejection cannot crash a pane
 *
 * The Rust commands return `Result<T, InstalledAppError>`, so a rejection
 * carries the error object. `InstalledAppsCommandError` re-throws it as a typed
 * error whose `code` is one of the 22 frozen codes, and `installedAppErrorFrom`
 * narrows ANY caught value (a typed error, a raw wire object, a string, an
 * `undefined` from a missing adapter) into an `InstalledAppError` with a
 * fallback `io_error`. Callers therefore always have a `code` to look a sentence
 * up by — never a crash and never a blank surface.
 */

import { adapterBridge } from '../utils/adapterBridge';
import {
  isInstalledAppRefusalCode,
  type FredoThemeTokens,
  type InstalledAppCapabilityStatus,
  type InstalledAppEntry,
  type InstalledAppError,
  type InstalledAppRefusalCode,
} from './types';

/** The `code` a malformed/unknown failure is reported under (the frozen set has no "unknown"). */
const FALLBACK_CODE: InstalledAppRefusalCode = 'io_error';

/** Detail used when a rejection carries nothing usable. */
const FALLBACK_DETAIL = 'the request to Fredo failed for an unknown reason';

/**
 * A command failure with a typed refusal code.
 *
 * Extends `Error` so a stack trace exists, but carries the wire fields
 * (`code`/`detail`/`field`) so a caller can render the sentence and the
 * specifics without re-parsing the message.
 */
export class InstalledAppsCommandError extends Error {
  readonly code: InstalledAppRefusalCode;
  readonly detail: string;
  /** Present iff the refusal concerns one manifest field; ABSENT otherwise. */
  readonly field?: string;

  constructor(refusal: InstalledAppError) {
    super(`[${refusal.code}] ${refusal.detail}`);
    this.name = 'InstalledAppsCommandError';
    this.code = refusal.code;
    this.detail = refusal.detail;
    if (refusal.field !== undefined) this.field = refusal.field;
  }
}

/**
 * Narrow any caught value into an `InstalledAppError`.
 *
 * Accepts (a) a typed `InstalledAppsCommandError`, (b) a raw wire rejection
 * object, (c) anything else (a string, `null`, an `undefined` returned by an
 * unregistered adapter). Never throws — an unusable value becomes
 * `{ code: 'io_error', detail: <fallback> }`, which every surface can render.
 */
export function installedAppErrorFrom(rejection: unknown): InstalledAppError {
  if (rejection instanceof InstalledAppsCommandError) {
    const narrow: InstalledAppError = {
      code: rejection.code,
      detail: rejection.detail,
    };
    if (rejection.field !== undefined) narrow.field = rejection.field;
    return narrow;
  }

  if (rejection !== null && typeof rejection === 'object') {
    const record = rejection as Record<string, unknown>;
    if (isInstalledAppRefusalCode(record.code)) {
      const detail =
        typeof record.detail === 'string' && record.detail.length > 0
          ? record.detail
          : FALLBACK_DETAIL;
      const narrow: InstalledAppError = { code: record.code, detail };
      // Absent-key discipline: only set `field` when it is a non-empty string,
      // so `null`/`undefined` never becomes a rendered value.
      if (typeof record.field === 'string' && record.field.length > 0) {
        narrow.field = record.field;
      }
      return narrow;
    }
  }

  return {
    code: FALLBACK_CODE,
    detail: typeof rejection === 'string' && rejection.length > 0 ? rejection : FALLBACK_DETAIL,
  };
}

/** Re-throw any failure as a typed command error. */
function asCommandError(rejection: unknown): InstalledAppsCommandError {
  if (rejection instanceof InstalledAppsCommandError) return rejection;
  return new InstalledAppsCommandError(installedAppErrorFrom(rejection));
}

/** The adapter returns `undefined` when no backend is registered (browser dev). */
function requireResult<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new InstalledAppsCommandError({
      code: FALLBACK_CODE,
      detail: `Fredo could not ${what}: the backend did not answer`,
    });
  }
  return value;
}

/**
 * Install a package from a user-chosen `.zip`.
 *
 * `archivePath` omitted means "open the native picker" — the Rust command
 * treats an absent (or blank) path that way.
 */
export async function installPackage(archivePath?: string): Promise<InstalledAppEntry> {
  try {
    const args: Record<string, unknown> =
      archivePath === undefined || archivePath.trim() === '' ? {} : { archivePath };
    const entry = await adapterBridge.invoke<InstalledAppEntry>('installed_app_install', args);
    return requireResult(entry, 'install that package');
  } catch (rejection) {
    throw asCommandError(rejection);
  }
}

/** List every installed application. Rejects with a typed refusal error. */
export async function listInstalledApps(): Promise<InstalledAppEntry[]> {
  try {
    const entries = await adapterBridge.invoke<InstalledAppEntry[]>('installed_apps_list');
    const value = requireResult(entries, 'read the installed applications');
    // A malformed payload is a failed read, not an empty list — an empty list
    // would teach the user "nothing is installed" when the truth is otherwise.
    if (!Array.isArray(value)) {
      throw new InstalledAppsCommandError({
        code: FALLBACK_CODE,
        detail: 'Fredo could not read the installed applications: the listing was not a list',
      });
    }
    return value;
  } catch (rejection) {
    throw asCommandError(rejection);
  }
}

/** Open an installed application in its own window (focuses an already-open one). */
export async function openInstalledApp(appId: string): Promise<void> {
  try {
    await adapterBridge.invoke<void>('installed_app_open', { appId });
  } catch (rejection) {
    throw asCommandError(rejection);
  }
}

/** Close an installed application's window. `true` iff a window was actually closed. */
export async function closeInstalledApp(appId: string): Promise<boolean> {
  try {
    const closed = await adapterBridge.invoke<boolean>('installed_app_close', { appId });
    return closed === true;
  } catch (rejection) {
    throw asCommandError(rejection);
  }
}

/**
 * Push the host's resolved theme token values into the backend mirror.
 *
 * The producer is the host's theme effect (ST-5); this wrapper is the typed
 * seam, not a second source of theme truth. No optional fields, so there is no
 * absent-key case.
 */
export async function pushTheme(payload: FredoThemeTokens): Promise<void> {
  try {
    await adapterBridge.invoke<void>('installed_apps_push_theme', { payload });
  } catch (rejection) {
    throw asCommandError(rejection);
  }
}

/**
 * Grant one declared high-risk capability to one application (Spec #3146).
 *
 * The command's returned status is the AUTHORITY for that row — the settings
 * surface must not paint "Allowed" before this resolves (a grant is a claim about
 * the host's record, so optimistic UI would lie about a security fact), and it
 * must not re-read the projection afterwards (a reconcile read can paint a false
 * `io_error` verdict over a successful grant).
 *
 * A refusal is a typed [`InstalledAppsCommandError`] carrying one of the frozen
 * 22 install codes (`manifest_invalid_field` with `field: "capability"` for a
 * capability the package did not declare, `id_not_installed` for an unknown id).
 */
export async function grantCapabilityConsent(
  appId: string,
  capability: string,
): Promise<InstalledAppCapabilityStatus> {
  try {
    const status = await adapterBridge.invoke<InstalledAppCapabilityStatus>(
      'installed_app_consent_grant',
      { appId, capability },
    );
    return requireResult(status, 'record that permission');
  } catch (rejection) {
    throw asCommandError(rejection);
  }
}

/** Revoke one capability for one application. Returns the authoritative status. */
export async function revokeCapabilityConsent(
  appId: string,
  capability: string,
): Promise<InstalledAppCapabilityStatus> {
  try {
    const status = await adapterBridge.invoke<InstalledAppCapabilityStatus>(
      'installed_app_consent_revoke',
      { appId, capability },
    );
    return requireResult(status, 'revoke that permission');
  } catch (rejection) {
    throw asCommandError(rejection);
  }
}

/** The seven wrappers, also available as one object for injection in tests. */
export const installedAppsClient = {
  installPackage,
  listInstalledApps,
  openInstalledApp,
  closeInstalledApp,
  pushTheme,
  grantCapabilityConsent,
  revokeCapabilityConsent,
};
