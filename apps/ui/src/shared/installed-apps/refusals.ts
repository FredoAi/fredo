/**
 * `INSTALL_REFUSAL_COPY` — the 22 refusal sentences, authored by the UI/UX
 * Expert (Spec #3147, UI/UX §1) — and the family → severity table (UI/UX §2).
 *
 * # Why a map, not per-code prose at the call site
 *
 * The map sentence is the **category verdict**: it must stand alone, it must be
 * distinct per code, and it never interpolates a runtime value — which is what
 * lets a unit test pin all 22 strings. The backend's `detail` is the
 * *specifics* (which field, which path, which version) and renders beside the
 * sentence; `InstalledAppError.field`, when present, renders as a mono chip in
 * that line.
 *
 * # The `io_error` note (Risk #9)
 *
 * The plan froze the 22-code enum and forbids a 23rd. The shipped UI/UX
 * sentence for `io_error` names the *write* path, but the same code is also
 * returned by the *read* (listing) path. The one permitted resolution is a
 * read/write-neutral re-wording inside the frozen key set — no new code — and
 * that is what the sentence below does. The original authored sentence was
 * "Fredo couldn't finish writing that package to disk."
 *
 * # Severity, never colour alone
 *
 * `INSTALL_REFUSAL_FAMILY` maps every code to its family; `REFUSAL_FAMILY_STYLE`
 * gives each family one treatment. Severity is carried by the glyph SHAPE plus
 * the heading plus the sentence — the tint and border are reinforcement only,
 * so no legibility-critical meaning sits on a coloured boundary and this design
 * declares no new contrast floor (UI/UX §7).
 */

import type { InstalledAppRefusalCode } from './types';

/**
 * The eight refusal families, grouped by **what the user can do next** (UI/UX §2).
 *
 * F1–F6 are install-time (rendered in the settings pane); F7–F8 are load-time
 * (rendered by the launcher's open-refusal surface, because those refusals
 * create no window for a child document to live in).
 */
export type RefusalFamily =
  | 'not-a-package' // F1
  | 'package-rejected' // F2
  | 'incompatible' // F3
  | 'archive-refused' // F4
  | 'already-installed' // F5
  | 'install-incomplete' // F6
  | 'damaged-after-install' // F7
  | 'nothing-to-open'; // F8

/** `warning` families stop a file; `error` families mean nothing was installed. */
export type RefusalSeverity = 'warning' | 'error';

/** Every code's family — the ONE family mapping (no third copy table). */
export const INSTALL_REFUSAL_FAMILY: Record<InstalledAppRefusalCode, RefusalFamily> = {
  // ── F1 — this file is not a package ─────────────────────────────────────────
  not_a_zip: 'not-a-package',
  no_manifest: 'not-a-package',

  // ── F2 — the package's description of itself is rejected ─────────────────────
  manifest_malformed: 'package-rejected',
  manifest_unknown_field: 'package-rejected',
  manifest_invalid_field: 'package-rejected',
  unsupported_manifest_version: 'package-rejected',
  id_invalid: 'package-rejected',
  id_reserved: 'package-rejected',
  version_invalid: 'package-rejected',
  engines_range_invalid: 'package-rejected',
  entry_missing: 'package-rejected',
  entry_invalid: 'package-rejected',

  // ── F3 — compatible in shape, not with THIS Fredo ────────────────────────────
  host_incompatible: 'incompatible',

  // ── F4 — the archive itself is refused for safety or size ────────────────────
  unsafe_path: 'archive-refused',
  reserved_path: 'archive-refused',
  archive_too_large: 'archive-refused',

  // ── F5 — nothing to do ──────────────────────────────────────────────────────
  already_installed: 'already-installed',

  // ── F6 — the install did not complete ───────────────────────────────────────
  io_error: 'install-incomplete',

  // ── F7 — damaged after install (load-time; rendered by the launcher) ─────────
  integrity_mismatch: 'damaged-after-install',
  integrity_record_corrupt: 'damaged-after-install',

  // ── F8 — nothing there to open (load-time; rendered by the launcher) ─────────
  id_not_installed: 'nothing-to-open',
  id_is_installed_app: 'nothing-to-open',
};

/**
 * The 22 refusal sentences (UI/UX §1, verbatim; `io_error` neutralised per
 * Risk #9). Tone: plain second person, contractions allowed, no error codes or
 * field names in the sentence, and the FILE is the subject — never the person.
 */
export const INSTALL_REFUSAL_COPY: Record<InstalledAppRefusalCode, string> = {
  // ── F1 — this file is not a package ──────────────────────────────────────────
  not_a_zip: "That file isn't a Fredo application package — packages are .zip files.",
  no_manifest:
    "That package doesn't include a fredo-app.json at its root, so Fredo can't tell what it is.",

  // ── F2 — the package's description of itself is rejected ─────────────────────
  manifest_malformed:
    "That package's fredo-app.json isn't valid JSON, so Fredo can't read what it declares.",
  manifest_unknown_field:
    "That package's fredo-app.json declares a field this version of Fredo doesn't recognise.",
  manifest_invalid_field:
    "A field in that package's fredo-app.json doesn't follow the format Fredo requires.",
  unsupported_manifest_version:
    "That package uses a manifest version this Fredo doesn't support.",
  id_invalid: "That package's id isn't a valid application id.",
  id_reserved: "That package's id is reserved for an application Fredo ships with.",
  version_invalid: "That package's version isn't a valid version number.",
  engines_range_invalid:
    "That package's required-Fredo range can't be read, so Fredo can't tell whether they're compatible.",
  entry_missing: 'That package is missing a file its manifest points to.',
  entry_invalid: "That package's entry point isn't a usable document-and-script pair.",

  // ── F3 — compatible in shape, not with THIS Fredo ────────────────────────────
  host_incompatible:
    "That package is built for a different version of Fredo than the one you're running.",

  // ── F4 — the archive itself is refused for safety or size ────────────────────
  unsafe_path:
    'That package contains a file path that would land outside its own folder, so Fredo refused it.',
  reserved_path: 'That package writes to a path reserved for Fredo, so Fredo refused it.',
  archive_too_large: 'That package is larger than Fredo will install.',

  // ── F5 — nothing to do ──────────────────────────────────────────────────────
  already_installed: 'An application with that id is already installed.',

  // ── F6 — the install did not complete ───────────────────────────────────────
  // Read/write-neutral (Risk #9): this code is also returned by the listing path.
  io_error: "Fredo couldn't finish that install.",

  // ── F7 — damaged after install (load-time; rendered by the launcher) ─────────
  integrity_mismatch:
    "That application's files changed after it was installed, so Fredo won't run it.",
  integrity_record_corrupt:
    "That application's install record is unreadable, so Fredo can't check its files.",

  // ── F8 — nothing there to open (load-time; rendered by the launcher) ─────────
  id_not_installed: "That application isn't installed any more.",
  id_is_installed_app:
    "That id belongs to an application Fredo ships with, so it doesn't open as an installed app.",
};

/** The copy sentence for a code (total — every code is mapped). */
export function refusalCopy(code: InstalledAppRefusalCode): string {
  return INSTALL_REFUSAL_COPY[code];
}

/** The severity a family carries — `error` families mean nothing was installed. */
export function refusalSeverity(code: InstalledAppRefusalCode): RefusalSeverity {
  switch (INSTALL_REFUSAL_FAMILY[code]) {
    case 'not-a-package': // F1
    case 'incompatible': // F3
    case 'already-installed': // F5
      return 'warning';
    case 'package-rejected': // F2
    case 'archive-refused': // F4
    case 'install-incomplete': // F6
    case 'damaged-after-install': // F7
    case 'nothing-to-open': // F8
      return 'error';
  }
}

/**
 * The one treatment per family (UI/UX §2). A glyph SHAPE per family, a tint and
 * a border; colours are tokens/`tint()` only and the shape is the non-colour
 * carrier.
 *
 * `tintVar` is the CSS variable the 10% fill composes over — passed through
 * `tint()` at the call site so no alpha is ever appended to a `var()`.
 */
export interface RefusalFamilyStyle {
  readonly severity: RefusalSeverity;
  /** `--status-warning` for warning families, `--status-error` for error ones. */
  readonly tintVar: 'var(--status-warning)' | 'var(--status-error)';
  /** The Chakra border token: `status.errorStrong` for errors, `border.default` for warnings. */
  readonly borderColor: 'status.errorStrong' | 'border.default';
  /** The glyph shape — the non-colour carrier of the family. */
  readonly glyph: 'file-warning' | 'file-x' | 'package-x' | 'shield-alert' | 'package-check' | 'circle-alert';
}

export const REFUSAL_FAMILY_STYLE: Record<RefusalFamily, RefusalFamilyStyle> = {
  'not-a-package': {
    severity: 'warning',
    tintVar: 'var(--status-warning)',
    borderColor: 'border.default',
    glyph: 'file-warning',
  },
  'package-rejected': {
    severity: 'error',
    tintVar: 'var(--status-error)',
    borderColor: 'status.errorStrong',
    glyph: 'file-x',
  },
  incompatible: {
    severity: 'warning',
    tintVar: 'var(--status-warning)',
    borderColor: 'border.default',
    glyph: 'package-x',
  },
  'archive-refused': {
    severity: 'error',
    tintVar: 'var(--status-error)',
    borderColor: 'status.errorStrong',
    glyph: 'shield-alert',
  },
  'already-installed': {
    severity: 'warning',
    tintVar: 'var(--status-warning)',
    borderColor: 'border.default',
    glyph: 'package-check',
  },
  'install-incomplete': {
    severity: 'error',
    tintVar: 'var(--status-error)',
    borderColor: 'status.errorStrong',
    glyph: 'circle-alert',
  },
  'damaged-after-install': {
    severity: 'error',
    tintVar: 'var(--status-error)',
    borderColor: 'status.errorStrong',
    glyph: 'file-x',
  },
  'nothing-to-open': {
    severity: 'error',
    tintVar: 'var(--status-error)',
    borderColor: 'status.errorStrong',
    glyph: 'file-x',
  },
};

/** The style for a code — family lookup, never a per-code branch. */
export function refusalStyle(code: InstalledAppRefusalCode): RefusalFamilyStyle {
  return REFUSAL_FAMILY_STYLE[INSTALL_REFUSAL_FAMILY[code]];
}
