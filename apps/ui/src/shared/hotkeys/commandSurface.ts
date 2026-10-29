/**
 * Spec #3097 (slice A) — the application command surface contract.
 *
 * An application MAY opt in by declaring `readonly commandSurface?: ApplicationCommandSurface`
 * on its `FredoApplicationClass`. A surface declares:
 *   - `modes`   — keyboard input states (id, label, parent, keymap, transient/sticky, cursor,
 *                 opaque pointer-operator id),
 *   - `commands`— capabilities (id, title, optional prompt spec, one `run` handler), and
 *   - `companion` — OPTIONAL model-facing capability sentence (Spec #3099). Present ⇒ the
 *                 application publishes a companion skill; absent ⇒ nothing is published.
 *
 * Spec #3099 adds the companion declaration contract: a command MAY declare a model-facing
 * `description` (the list reply's ONLY source; absent/blank ⇒ never published) and a declared
 * `args` contract (`ApplicationCommandArg[]`). {@link validateCommandArgs} is the ONE
 * declared-argument rule, shared by the host pre-flight and the executor.
 *
 * Exactly ONE mode is the root (`parent === null`). Every other mode chains to the root through
 * `parent`; `transient` defaults TRUE (Escape pops) and `sticky` defaults FALSE (a successful
 * command auto-returns). Mode keymap strokes are contract data, NOT `data-hotkey` grammar:
 * a single unmodified `[a-z0-9]` stroke only, and they never enter the pending-sequence machine.
 *
 * PURE by design: types + total spec helpers only — no DOM, React, store, registry, Tauri or
 * clock imports and no side effects. Everything later in this slice (`commandSurfaceStore`,
 * the resolver, the bar model, the fixture) imports these names rather than re-declaring them
 * (G-255). `validateCommandSurface` is the ONE validation surface for surface authors.
 */

/** Flat string map. The inline prompt commits `{ value: string }`. */
export type ApplicationCommandArgs = Readonly<Record<string, string>>;

/** The optional inline value prompt of a command. */
export interface ApplicationCommandPrompt {
  /** Visible label + accessible name of the input. */
  readonly label: string;
  readonly placeholder?: string;
  /** Seeds the draft; default `''`. */
  readonly initialValue?: string;
  /**
   * Optional synchronous value guard (Spec #3098 ST-1).
   *
   * Absent ⇒ today's merge behaviour: every draft commits. Returning `false`
   * keeps the SAME prompt open with its draft — no `run`, no mode change, no
   * document mutation, no focus restore. The guard receives the RAW draft
   * (trimming is the command's own concern).
   */
  readonly validate?: (value: string) => boolean;
}

/**
 * One declared companion argument (Spec #3099).
 *
 * Declaring `args` on a command OPTS IT INTO the argument contract enforced by
 * {@link validateCommandArgs}; a command that declares no `args` keeps the
 * Spec #3097 pass-through behaviour (any string map reaches `run`).
 */
export interface ApplicationCommandArg {
  /** Exact key the model must supply inside `arguments`. */
  readonly name: string;
  /** Default FALSE — an absent optional argument is accepted. */
  readonly required?: boolean;
  /** Optional human note, forwarded into the manifest only (never gated). */
  readonly description?: string;
  /**
   * Optional TS-only value guard. Receives the RAW supplied string (trimming is
   * the command's own concern); returning `false` rejects the invocation
   * (`failed-guard`). Never serialized, so it only runs where the surface is
   * registered (the app-side executor re-run).
   */
  readonly validate?: (value: string) => boolean;
}

/** The opt-in companion declaration of a whole surface (Spec #3099). */
export interface ApplicationCommandCompanion {
  /** Model-facing capability sentence — the DIRECTIVE that names the request class. */
  readonly description: string;
  /** Optional listing wording override; default `\`${appName} actions\``. */
  readonly listLabel?: string;
}

/** One application capability. */
export interface ApplicationCommandSpec {
  /** App-local id, unique within the surface. */
  readonly id: string;
  /** Bar row title. */
  readonly title: string;
  /**
   * Model-facing capability sentence (the list reply + the published manifest).
   * Absent/blank ⇒ the command is NOT published to the companion (Spec #3099,
   * fail-closed — `title` is never promoted to a capability sentence).
   */
  readonly description?: string;
  /** Present ⇒ a human invocation without args opens the inline prompt. */
  readonly prompt?: ApplicationCommandPrompt;
  /**
   * Declared companion arguments (Spec #3099); absent ⇒ no argument contract
   * (the Spec #3097 pass-through). Declaring `args` — even `[]` — opts in.
   */
  readonly args?: readonly ApplicationCommandArg[];
  /** `false` / rejection ⇒ nothing performed (fail-closed honesty). */
  readonly run: (args?: ApplicationCommandArgs) => void | boolean | Promise<void | boolean>;
}

/** One keyboard input state of an application. */
export interface ApplicationCommandMode {
  /** App-local mode id, unique within the surface. */
  readonly id: string;
  /** Bar badge + announcement label. */
  readonly label: string;
  /** `null` = ROOT (exactly one root per surface). */
  readonly parent: string | null;
  /** Serialized single stroke → command id. */
  readonly keymap: Readonly<Record<string, string>>;
  /**
   * Optional PRESENTATION order for the bar's keymap rows (Spec #3098 ST-1/A2).
   *
   * Keys absent from `keymap` are skipped; absent ⇒ today's `Object.entries`
   * (declaration) order. Binding semantics are unchanged — the keymap stays the
   * one binding source.
   */
  readonly keymapOrder?: readonly string[];
  /** Default TRUE — Escape pops this mode. */
  readonly transient?: boolean;
  /** Default FALSE — false ⇒ auto-return after a successful command. */
  readonly sticky?: boolean;
  /** Opaque CSS cursor keyword; the application applies it. */
  readonly cursor?: string;
  /** OPAQUE pointer-operator id; the engine NEVER interprets it. */
  readonly operator?: string;
}

/** The optional application command surface. */
export interface ApplicationCommandSurface {
  readonly modes: readonly ApplicationCommandMode[];
  readonly commands: readonly ApplicationCommandSpec[];
  /** Present ⇒ this application publishes a companion skill (Spec #3099, opt-in). */
  readonly companion?: ApplicationCommandCompanion;
}

/**
 * The mode keymap stroke grammar: ONE unmodified lowercase letter or digit.
 * Uppercase, modifiers (`ctrl+c`) and multi-character strokes (`ab`) are rejected.
 */
export const COMMAND_MODE_KEY_PATTERN = /^[a-z0-9]$/;

/** The deterministic outcome of validating a surface. */
export interface CommandSurfaceValidationResult {
  readonly valid: boolean;
  /** Human-readable diagnostics in a stable declaration/field order. */
  readonly errors: readonly string[];
}

/** Why a declared-argument check refused an invocation (Spec #3099). */
export type CommandArgsValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | 'not-an-object'
        | 'undeclared-key'
        | 'missing-required'
        | 'not-a-string'
        | 'blank'
        | 'failed-guard';
      readonly detail: string;
    };

/** First-wins lookup (duplicate ids are reported separately and never win over the first). */
function modesById(modes: readonly ApplicationCommandMode[]): Map<string, ApplicationCommandMode> {
  const byId = new Map<string, ApplicationCommandMode>();
  for (const mode of modes) {
    if (!byId.has(mode.id)) byId.set(mode.id, mode);
  }
  return byId;
}

/** True when walking `parent` from `mode` reaches a `parent === null` mode (no cycle, no gap). */
function parentChainTerminatesAtRoot(
  mode: ApplicationCommandMode,
  byId: ReadonlyMap<string, ApplicationCommandMode>,
): boolean {
  const visited = new Set<ApplicationCommandMode>();
  let current: ApplicationCommandMode | undefined = mode;
  while (current !== undefined) {
    if (visited.has(current)) return false; // cycle
    visited.add(current);
    if (current.parent === null) return true;
    current = byId.get(current.parent);
  }
  return false; // dangling parent
}

/**
 * Validate a declared surface. TOTAL and PURE: never throws, never mutates the surface.
 *
 * Checks, in this deterministic order:
 *   1. exactly one root mode (`parent === null`),
 *   2. mode ids unique (declaration order),
 *   3. every non-null parent resolves to a declared mode,
 *   4. every parent chain terminates at the root (no cycles / dangling chains),
 *   5. every keymap stroke matches {@link COMMAND_MODE_KEY_PATTERN} and targets a declared command,
 *   6. command ids unique (declaration order),
 *   7. declared argument names unique within one command (Spec #3099).
 */
export function validateCommandSurface(surface: ApplicationCommandSurface): CommandSurfaceValidationResult {
  const errors: string[] = [];
  const modes = surface.modes;
  const byId = modesById(modes);
  const commandIds = new Set<string>(surface.commands.map((command) => command.id));

  // 1. Exactly one root.
  const rootCount = modes.filter((mode) => mode.parent === null).length;
  if (rootCount !== 1) {
    errors.push(`surface must declare exactly one root mode (parent === null); found ${rootCount}`);
  }

  // 2. Mode ids unique.
  const seenModeIds = new Set<string>();
  for (const mode of modes) {
    if (seenModeIds.has(mode.id)) {
      errors.push(`duplicate mode id "${mode.id}"`);
    } else {
      seenModeIds.add(mode.id);
    }
  }

  // 3. Parent resolvability.
  for (const mode of modes) {
    if (mode.parent !== null && !byId.has(mode.parent)) {
      errors.push(`mode "${mode.id}" declares parent "${mode.parent}", which is not a declared mode`);
    }
  }

  // 4. Parent chain terminates at the root.
  for (const mode of modes) {
    if (!parentChainTerminatesAtRoot(mode, byId)) {
      errors.push(`mode "${mode.id}" parent chain does not terminate at the root mode`);
    }
  }

  // 5. Keymap strokes + targets (key insertion order within each mode).
  for (const mode of modes) {
    for (const stroke of Object.keys(mode.keymap)) {
      if (!COMMAND_MODE_KEY_PATTERN.test(stroke)) {
        errors.push(
          `mode "${mode.id}" keymap stroke "${stroke}" is invalid (a single unmodified [a-z0-9] stroke is required)`,
        );
      }
      const commandId = mode.keymap[stroke];
      if (!commandIds.has(commandId)) {
        errors.push(`mode "${mode.id}" keymap stroke "${stroke}" targets unknown command "${commandId}"`);
      }
    }
  }

  // 6. Command ids unique.
  const seenCommandIds = new Set<string>();
  for (const command of surface.commands) {
    if (seenCommandIds.has(command.id)) {
      errors.push(`duplicate command id "${command.id}"`);
    } else {
      seenCommandIds.add(command.id);
    }
  }

  // 7. Declared argument names unique within one command (Spec #3099, appended).
  for (const command of surface.commands) {
    const seenArgNames = new Set<string>();
    for (const arg of command.args ?? []) {
      if (seenArgNames.has(arg.name)) {
        errors.push(`duplicate arg name "${arg.name}" in command "${command.id}"`);
      } else {
        seenArgNames.add(arg.name);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * The ONE declared-argument rule (Spec #3099), shared by the host pre-flight
 * (layer 1, before any window open or relay) and the app-side executor
 * (layer 2, inside `executeCommand` before `run`).
 *
 * TOTAL and PURE: never throws, never mutates. Checks, in this order:
 *   1. `arguments` must be a plain object (not `null`, not an array),
 *   2. every supplied key must be a declared `args` name,
 *   3. every declared `required` argument must be present,
 *   4. every supplied value must be a string,
 *   5. a blank (empty/whitespace-only) value is rejected,
 *   6. a declared `validate` guard returning `false` is rejected.
 *
 * `args === undefined` is treated as `{}` (a command with a required declared
 * argument then fails `missing-required`).
 *
 * COMPATIBILITY (Spec #3097 invariant): a command that declares NO `args`
 * declares no argument contract at all and keeps the legacy pass-through —
 * any supplied string map reaches `run` unchanged. Declaring `args` (even an
 * empty array) opts the command in; the Spec #3099 published surfaces declare
 * their contracts, so every companion-facing command is validated.
 */
export function validateCommandArgs(
  command: ApplicationCommandSpec,
  args: unknown,
): CommandArgsValidation {
  const declared = command.args;
  if (declared === undefined) return { ok: true };

  const supplied = args === undefined ? {} : args;
  if (typeof supplied !== 'object' || supplied === null || Array.isArray(supplied)) {
    return { ok: false, reason: 'not-an-object', detail: 'arguments must be a plain object' };
  }

  const byName = new Map<string, ApplicationCommandArg>();
  for (const arg of declared) byName.set(arg.name, arg);

  const record = supplied as Readonly<Record<string, unknown>>;
  const entries = Object.entries(record);

  for (const [key] of entries) {
    if (!byName.has(key)) {
      return { ok: false, reason: 'undeclared-key', detail: `undeclared argument "${key}"` };
    }
  }

  for (const arg of declared) {
    if (arg.required === true && !Object.prototype.hasOwnProperty.call(record, arg.name)) {
      return {
        ok: false,
        reason: 'missing-required',
        detail: `missing required argument "${arg.name}"`,
      };
    }
  }

  const stringEntries: Array<readonly [string, string]> = [];
  for (const [key, value] of entries) {
    if (typeof value !== 'string') {
      return { ok: false, reason: 'not-a-string', detail: `argument "${key}" must be a string` };
    }
    stringEntries.push([key, value]);
  }

  for (const [key, value] of stringEntries) {
    if (value.trim() === '') {
      return { ok: false, reason: 'blank', detail: `argument "${key}" must not be blank` };
    }
    const guard = byName.get(key)?.validate;
    if (guard !== undefined && !guard(value)) {
      return { ok: false, reason: 'failed-guard', detail: `argument "${key}" failed its guard` };
    }
  }

  return { ok: true };
}

/**
 * The single root mode (`parent === null`), or `null` when the surface does not declare exactly
 * one root. Invalid surfaces are reported by {@link validateCommandSurface}.
 */
export function getRootCommandMode(surface: ApplicationCommandSurface): ApplicationCommandMode | null {
  let root: ApplicationCommandMode | null = null;
  for (const mode of surface.modes) {
    if (mode.parent !== null) continue;
    if (root !== null) return null; // more than one root ⇒ no single root
    root = mode;
  }
  return root;
}

/** The mode with `modeId`, or `null` when the surface does not declare it (first declaration wins). */
export function getApplicationCommandMode(
  surface: ApplicationCommandSurface,
  modeId: string,
): ApplicationCommandMode | null {
  return surface.modes.find((mode) => mode.id === modeId) ?? null;
}
