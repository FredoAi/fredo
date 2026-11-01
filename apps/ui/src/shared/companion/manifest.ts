/**
 * Companion manifest — the PURE single source of truth for model-facing
 * application skills (Spec #3099, ST-2; unified with the navigation declaration in
 * Spec #3120, ST-2; legacy projection removed in Spec #3122 P8 ST-2).
 *
 * ONE declaration source feeds the published manifest: a registered navigation `Surface`
 * (Spec #3117/#3120 — e.g. `wireframeSurface`), projected through
 * `shared/navigation/manifest.ts` (which appends the engine-owned `journal.undo` command
 * before `listActions`). A surface without a `companion` block publishes nothing. There is
 * no second (legacy `feature.commandSurface`) projection.
 *
 * PURE by design (G-255): no DOM, no IPC, no clock, no registry import. The caller passes the
 * registered surfaces; the builder only projects them. That keeps the builder trivially
 * testable and makes the golden fixture a real projection of the shipped Wireframe surface
 * rather than a hand-copied table.
 */

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
 * Project the registered navigation surfaces into the companion manifest.
 *
 * Rules:
 *   - ONLY a registered navigation surface can publish (there is no legacy
 *     `feature.commandSurface` projection any more);
 *   - a surface without a `companion` block publishes nothing (the host rejects a
 *     blank description);
 *   - surfaces are de-duplicated by `appId`, FIRST-WINS — a duplicate registration
 *     never replaces (or duplicates) the first surface;
 *   - a surface whose commands ALL lack a `description` is still returned with an
 *     EMPTY `commands` array. The Rust side skips zero-command surfaces when
 *     rendering the offer; dropping the surface here would hide a surface author
 *     error from the manifest instead of surfacing it.
 */
export function buildCompanionManifest(
  navigationSurfaces: readonly NavigationSurface[] = [],
): CompanionManifest {
  const seenAppIds = new Set<string>();
  const surfaces: CompanionSurfaceManifest[] = [];

  for (const navigation of navigationSurfaces) {
    const appId = navigation.tree.appId;
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
