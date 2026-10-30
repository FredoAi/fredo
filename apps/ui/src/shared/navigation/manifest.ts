/**
 * Spec #3117 (P3) — §8.1 companion manifest projection.
 *
 * The per-surface manifest is a projection of the declaration alone: every verb with
 * `publish === true`, in declaration order, plus the reserved `listActions` action id.
 * Identical declarations therefore produce a byte-identical projection (REQ-10.3).
 *
 * This is `shared/navigation`'s OWN type (Reading #8) — it imports nothing from
 * `shared/companion`; unifying the two is ADP-15 / P6 scope.
 *
 * PURE: no clock, no DOM, no I/O, no mutation; imports only the leaf vocabulary.
 */

import {
  LIST_ACTIONS_ID,
  type Surface,
  type VerbArg,
} from './types';

/** One declared argument of a published command. */
export interface CompanionArg {
  name: string;
  required: boolean;
  description?: string;
}

/** One published command of a surface. */
export interface CompanionCommand {
  id: string;
  label: string;
  description: string;
  args: readonly CompanionArg[];
}

/** §8.1 — one application surface's companion manifest. */
export interface CompanionManifest {
  appId: string;
  appName: string;
  skillName: string;
  description: string;
  commands: readonly CompanionCommand[];
  /** Every command id in order, then the reserved `listActions` id. */
  actionIds: readonly string[];
}

/** Project one declared argument onto the manifest wire shape. */
function toCompanionArg(arg: VerbArg): CompanionArg {
  return { name: arg.name, required: arg.required === true };
}

/**
 * §8.1 — build the companion manifest for one surface.
 *
 * Stable and byte-identical for identical input: command order is declaration order and
 * the only appended id is the single reserved `listActions` (never a second one).
 */
export function buildCompanionManifest(surface: Surface): CompanionManifest {
  const commands: CompanionCommand[] = [];
  for (const verb of surface.verbs) {
    if (verb.publish !== true) continue;
    commands.push({
      id: verb.id,
      label: verb.title,
      description: verb.description,
      args: verb.args.map(toCompanionArg),
    });
  }

  const appId = surface.tree.appId;
  const companion = surface.companion;
  return {
    appId,
    appName: companion?.appName ?? appId,
    skillName: appId,
    description: companion?.description ?? '',
    commands,
    actionIds: [...commands.map((command) => command.id), LIST_ACTIONS_ID],
  };
}
