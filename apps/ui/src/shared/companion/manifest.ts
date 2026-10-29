/**
 * Companion manifest — the PURE single source of truth for model-facing
 * application skills (Spec #3099, ST-2).
 *
 * The TypeScript application registry is authoritative: every application that
 * opts in with `commandSurface.companion` publishes ONE surface, and every
 * published command carries its model-facing sentence here. The Rust side never
 * hand-maintains an offer — it renders whatever the published manifest contains
 * (ST-4), so adding a command is a TS-only change.
 *
 * PURE by design (G-255): no DOM, no IPC, no clock, no registry import. The
 * caller passes the feature list; the builder only projects it. That keeps the
 * builder trivially testable and makes the golden fixture a real projection of
 * the shipped Wireframe surface rather than a hand-copied table.
 */

import type { FredoApplicationClass } from '../classes';

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
  readonly args: readonly CompanionCommandArgManifest[];
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

/**
 * Project the registered applications into the companion manifest.
 *
 * Rules (Spec #3099 R-1a/R-1c):
 *   - only applications whose `commandSurface.companion` is declared are
 *     published (`appId = feature.id`, `appName = feature.name`,
 *     `skillName = appId` — one identity, no alias);
 *   - `commands` keep DECLARATION order;
 *   - a command with an absent/blank `description` is EXCLUDED (fail-closed:
 *     `title` is never promoted to a capability sentence);
 *   - applications are de-duplicated by `appId`, FIRST-WINS — the registry can
 *     contain the same feature more than once (`registerApplication` is a plain
 *     push, #2826), and a duplicate inside one publish is rejected host-side;
 *   - a surface whose commands ALL lack a `description` is still returned with
 *     an EMPTY `commands` array. The Rust side skips zero-command surfaces when
 *     rendering the offer; dropping the surface here would hide a surface author
 *     error from the manifest instead of surfacing it.
 */
export function buildCompanionManifest(
  features: readonly FredoApplicationClass[],
): CompanionManifest {
  const seenAppIds = new Set<string>();
  const surfaces: CompanionSurfaceManifest[] = [];

  for (const feature of features) {
    // First-wins de-duplication by appId: a later registration of the same
    // application never replaces (or duplicates) the first surface.
    if (seenAppIds.has(feature.id)) continue;
    seenAppIds.add(feature.id);

    const surface = feature.commandSurface;
    if (surface === undefined || surface.companion === undefined) continue;

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

    surfaces.push({
      appId: feature.id,
      appName: feature.name,
      skillName: feature.id,
      description: surface.companion.description,
      ...(surface.companion.listLabel === undefined
        ? {}
        : { listLabel: surface.companion.listLabel }),
      commands,
    });
  }

  return { surfaces };
}

/**
 * The generated `action` enum of one surface: every published command id in
 *manifest order, then the reserved {@link COMPANION_LIST_ACTIONS_ID}.
 */
export function companionActionIds(surface: CompanionSurfaceManifest): readonly string[] {
  return [...surface.commands.map((command) => command.id), COMPANION_LIST_ACTIONS_ID];
}
