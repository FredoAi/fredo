/**
 * Spec #3097 (slice A) — the application command surface contract.
 *
 * An application MAY opt in by declaring `readonly commandSurface?: ApplicationCommandSurface`
 * on its `FredoApplicationClass`. A surface declares:
 *   - `modes`   — keyboard input states (id, label, parent, keymap, transient/sticky, cursor,
 *                 opaque pointer-operator id), and
 *   - `commands`— capabilities (id, title, optional prompt spec, one `run` handler).
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
}

/** One application capability. */
export interface ApplicationCommandSpec {
  /** App-local id, unique within the surface. */
  readonly id: string;
  /** Bar row title. */
  readonly title: string;
  /** Present ⇒ a human invocation without args opens the inline prompt. */
  readonly prompt?: ApplicationCommandPrompt;
  readonly run: (args?: ApplicationCommandArgs) => void | Promise<void>;
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
 *   6. command ids unique (declaration order).
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

  return { valid: errors.length === 0, errors };
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
