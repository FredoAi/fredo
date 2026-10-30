/**
 * Companion manifest — the PURE single source of truth for model-facing
 * application skills (Spec #3099, ST-2; unified with the navigation declaration in
 * Spec #3120, ST-2).
 *
 * Two declaration sources feed ONE published manifest:
 *
 *   1. a registered navigation `Surface` (Spec #3117/#3120 — `wireframeSurface`),
 *      projected through `shared/navigation/manifest.ts` (which appends the
 *      engine-owned `journal.undo` command before `listActions`); and
 *   2. the legacy `feature.commandSurface` projection (the P7 migration path).
 *
 * Navigation WINS for an `appId` (a registered navigation surface that declares a
 * `companion` block suppresses the legacy projection for that app), so an
 * application never publishes two competing capability sets. Legacy applications
 * keep publishing exactly as before.
 *
 * PURE by design (G-255): no DOM, no IPC, no clock, no registry import. The caller
 * passes the feature list and the registered surfaces; the builder only projects
 * them. That keeps the builder trivially testable and makes the golden fixture a
 * real projection of the shipped Wireframe surface rather than a hand-copied table.
 */

import type { FredoApplicationClass } from '../classes';
import { buildCompanionManifest as buildNavigationManifest } from '../navigation/manifest';
import type { Risk, Surface as NavigationSurface } from '../navigation/types';

/** One declared argument of a published command (wire shape, camelCase). */
export interface CompanionCommandArgManifest {
  readonly name: string;
  readonly required: boolean;
  readonly description?: string;
}

/** One published command of a surface. */
export interface CompanionCommandManifest {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /**
   * The declared risk class (Spec #3120 ST-2, additive). ABSENT for a legacy
   * `commandSurface` command — the wire omits the key rather than sending `null`.
   */
  readonly risk?: Risk;
  readonly args: readonly CompanionCommandArgManifest[];
  /**
   * The declared spoken aliases (Spec #3120 ST-2, additive). ABSENT for a legacy
   * `commandSurface` command; a navigation command always carries the field (an
   * empty array when the verb declares none).
   */
  readonly aliases?: readonly string[];
}

/** One published application surface. */
export interface CompanionSurfaceManifest {
  readonly appId: string;
  readonly appName: string;
  readonly skillName: string;
  readonly description: string;
  readonly listLabel?: string;
  readonly commands: readonly CompanionCommandManifest[];
}

/** The whole published set. */
export interface CompanionManifest {
  readonly surfaces: readonly CompanionSurfaceManifest[];
}

/**
 * The reserved synthetic action id appended to EVERY generated enum (never a
 * command, never an application id).
 */
export const COMPANION_LIST_ACTIONS_ID = 'listActions';

/** `VerbArg` and the navigation manifest's `CompanionArg` are structurally the same. */
function projectArg(arg: CompanionCommandArgManifest): CompanionCommandArgManifest {
  return {
    name: arg.name,
    required: arg.required === true,
    ...(arg.description === undefined ? {} : { description: arg.description }),
  };
}

/**
 * Project a registered navigation surface through the navigation manifest
 * (§8.1 projection: published verbs in declaration order, then `journal.undo`).
 *
 * Every projected command carries all six fields — `id`, `label`, `description`,
 * `risk`, `args`, `aliases` — so the consumer never re-derives a risk class or
 * invents an alias (G-418 reads the projected value, never the source verb).
 */
function navigationSurfaceToManifest(surface: NavigationSurface): CompanionSurfaceManifest {
  const projected = buildNavigationManifest(surface);
  return {
    appId: projected.appId,
    appName: projected.appName,
    skillName: projected.skillName,
    description: projected.description,
    commands: projected.commands.map((command) => ({
      id: command.id,
      label: command.label,
      description: command.description,
      risk: command.risk,
      args: command.args.map(projectArg),
      aliases: command.aliases,
    })),
  };
}

/**
 * Project a legacy `feature.commandSurface` (P7 migration path).
 *
 * The legacy surface declares no risk class and no aliases, so both keys are
 * ABSENT on the projection (the wire rule is "absent, never `null`").
 */
function legacySurfaceToManifest(
  feature: FredoApplicationClass,
  surface: NonNullable<FredoApplicationClass['commandSurface']>,
): CompanionSurfaceManifest {
  const commands: CompanionCommandManifest[] = [];
  for (const command of surface.commands) {
    const description = command.description;
    // R-1c: absent/blank description => NOT published (never invented from
    // the `title`).
    if (description === undefined || description.trim() === '') continue;
    commands.push({
      id: command.id,
      label: command.title,
      description,
      args: (command.args ?? []).map((arg) => ({
        name: arg.name,
        required: arg.required === true,
        ...(arg.description === undefined ? {} : { description: arg.description }),
      })),
    });
  }

  const companion = surface.companion;
  return {
    appId: feature.id,
    appName: feature.name,
    skillName: feature.id,
    description: companion?.description ?? '',
    ...(companion?.listLabel === undefined ? {} : { listLabel: companion.listLabel }),
    commands,
  };
}

/**
 * Project the registered applications + registered navigation surfaces into the
 * companion manifest.
 *
 * Rules:
 *   - a registered navigation surface WINS for its `appId` (Spec #3120 ST-2) —
 *     the legacy projection for that app is suppressed. A navigation surface
 *     without a `companion` block publishes nothing (the host rejects a blank
 *     description), and still suppresses the legacy projection ("navigation wins");
 *   - otherwise only applications whose `commandSurface.companion` is declared
 *     are published (`appId = feature.id`, `appName = feature.name`,
 *     `skillName = appId` — one identity, no alias);
 *   - legacy `commands` keep DECLARATION order and exclude an absent/blank
 *     description (fail-closed: `title` is never promoted to a capability
 *     sentence);
 *   - applications are de-duplicated by `appId`, FIRST-WINS — the registry can
 *     contain the same feature more than once (`registerApplication` is a plain
 *     push, #2826);
 *   - a registered navigation surface with no matching feature is still published
 *     (in registration order, after the feature-derived surfaces), so opening an
 *     app cannot hide its capability set;
 *   - a surface whose commands ALL lack a `description` is still returned with an
 *     EMPTY `commands` array. The Rust side skips zero-command surfaces when
 *     rendering the offer; dropping the surface here would hide a surface author
 *     error from the manifest instead of surfacing it.
 */
export function buildCompanionManifest(
  features: readonly FredoApplicationClass[],
  navigationSurfaces: readonly NavigationSurface[] = [],
): CompanionManifest {
  const navigationByAppId = new Map<string, NavigationSurface>();
  for (const surface of navigationSurfaces) {
    const appId = surface.tree.appId;
    // First-wins de-duplication by appId (a duplicate registration never replaces
    // the first surface).
    if (!navigationByAppId.has(appId)) navigationByAppId.set(appId, surface);
  }

  const seenAppIds = new Set<string>();
  const surfaces: CompanionSurfaceManifest[] = [];

  for (const feature of features) {
    // First-wins de-duplication by appId: a later registration of the same
    // application never replaces (or duplicates) the first surface.
    if (seenAppIds.has(feature.id)) continue;
    seenAppIds.add(feature.id);

    const navigation = navigationByAppId.get(feature.id);
    if (navigation !== undefined) {
      if (navigation.companion !== null) {
        surfaces.push(navigationSurfaceToManifest(navigation));
      }
      continue;
    }

    const surface = feature.commandSurface;
    if (surface === undefined || surface.companion === undefined) continue;
    surfaces.push(legacySurfaceToManifest(feature, surface));
  }

  // Navigation surfaces registered for an `appId` with no (publishing) feature.
  for (const [appId, navigation] of navigationByAppId) {
    if (seenAppIds.has(appId)) continue;
    seenAppIds.add(appId);
    if (navigation.companion === null) continue;
    surfaces.push(navigationSurfaceToManifest(navigation));
  }

  return { surfaces };
}

/**
 * The generated `action` enum of one surface: every published command id in
 * manifest order, then the reserved {@link COMPANION_LIST_ACTIONS_ID}.
 */
export function companionActionIds(surface: CompanionSurfaceManifest): readonly string[] {
  return [...surface.commands.map((command) => command.id), COMPANION_LIST_ACTIONS_ID];
}
