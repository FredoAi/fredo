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
  type Risk,
  type Surface,
  type VerbArg,
} from './types';

/** One declared argument of a published command. */
export interface CompanionArg {
  name: string;
  required: boolean;
  description?: string;
}

/**
 * One published command of a surface.
 *
 * AC9 / Reading #13 — the projection carries all six fields, so a consumer never
 * re-derives a title, guesses a risk class or invents an alias (ADR-6). Key order is
 * part of the committed golden shape: `id, label, description, risk, args, aliases`.
 */
export interface CompanionCommand {
  id: string;
  label: string;
  description: string;
  risk: Risk;
  args: readonly CompanionArg[];
  aliases: readonly string[];
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

/**
 * Spec #3120 (P6), ST-2 — the engine-owned `journal.undo` command.
 *
 * `journal.undo` has no declared `VerbDescriptor` (`ENGINE_VERB_IDS`), so it can never be
 * projected from `surface.verbs`. It is appended to EVERY navigation manifest after the
 * published verbs and before the reserved `listActions` id, giving a spoken undo a
 * manifest action that reaches the same dispatch funnel as every other command.
 */
export const ENGINE_COMPANION_UNDO_COMMAND: CompanionCommand = {
  id: 'journal.undo',
  label: 'Undo',
  description:
    'Undo the newest change; optionally filter by actor (human, companion or system) and count (1..100).',
  risk: 'mutating',
  args: [
    { name: 'actor', required: false },
    { name: 'count', required: false },
  ],
  aliases: ['undo', 'revert'],
};

/**
 * `VerbArg` does not declare `description`, but a declaration MAY author one; read it
 * structurally so an authored description round-trips while an unauthored one omits the
 * key entirely (no existing golden `args` row changes).
 */
interface AuthoredArg {
  readonly name: string;
  readonly required: boolean;
  readonly description?: string;
}

/** Project one declared argument onto the manifest wire shape. */
function toCompanionArg(arg: VerbArg): CompanionArg {
  const source: AuthoredArg = arg;
  return {
    name: source.name,
    required: source.required === true,
    ...(source.description === undefined ? {} : { description: source.description }),
  };
}

/**
 * §8.1 — build the companion manifest for one surface.
 *
 * Stable and byte-identical for identical input: command order is declaration order, then
 * the engine-owned `journal.undo` (Spec #3120 ST-2 — never duplicated), and the only
 * appended id is the single reserved `listActions` (never a second one).
 */
export function buildCompanionManifest(surface: Surface): CompanionManifest {
  const commands: CompanionCommand[] = [];
  for (const verb of surface.verbs) {
    if (verb.publish !== true) continue;
    commands.push({
      id: verb.id,
      label: verb.title,
      description: verb.description,
      risk: verb.risk,
      args: verb.args.map(toCompanionArg),
      aliases: verb.aliases,
    });
  }

  // The engine owns `journal.undo`; it is not a declared verb. Append it after the
  // published verbs, guarding against a hand-published duplicate.
  if (!commands.some((command) => command.id === ENGINE_COMPANION_UNDO_COMMAND.id)) {
    commands.push(ENGINE_COMPANION_UNDO_COMMAND);
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
