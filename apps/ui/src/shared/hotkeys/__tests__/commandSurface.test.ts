/**
 * Spec #3097 (slice A / ST-1) — the application command surface contract.
 *
 * Pins the ONE canonical shape every later sub-task imports: the surface/mode/command types'
 * optionality, the single-stroke mode keymap grammar, and the total, deterministic
 * `validateCommandSurface` / root-and-mode lookup helpers. Pure unit tests only — no DOM,
 * React or store involved.
 */

import { describe, expect, it } from 'vitest';

import {
  COMMAND_MODE_KEY_PATTERN,
  getApplicationCommandMode,
  getRootCommandMode,
  validateCommandSurface,
  type ApplicationCommandMode,
  type ApplicationCommandSpec,
  type ApplicationCommandSurface,
} from '../commandSurface';

function command(id: string, extras: Partial<ApplicationCommandSpec> = {}): ApplicationCommandSpec {
  return {
    id,
    title: id,
    run: () => undefined,
    ...extras,
  };
}

function mode(
  id: string,
  parent: string | null,
  keymap: Readonly<Record<string, string>> = {},
  extras: Partial<ApplicationCommandMode> = {},
): ApplicationCommandMode {
  return {
    id,
    label: id.toUpperCase(),
    parent,
    keymap,
    ...extras,
  };
}

/** The canonical valid surface: one root (`browse`), one child (`tool`), two commands. */
function validSurface(): ApplicationCommandSurface {
  return {
    modes: [mode('browse', null, { t: 'open-tool' }), mode('tool', 'browse', { c: 'capture' })],
    commands: [command('open-tool'), command('capture')],
  };
}

function errorsOf(surface: ApplicationCommandSurface): readonly string[] {
  return validateCommandSurface(surface).errors;
}

describe('validateCommandSurface — valid surfaces', () => {
  it('accepts a surface with one root, a child mode, and resolvable keymaps', () => {
    const result = validateCommandSurface(validSurface());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('keeps transient/sticky optional — omitted validates, explicit values still validate', () => {
    const surface: ApplicationCommandSurface = {
      modes: [
        mode('browse', null, { t: 'open-tool' }), // transient/sticky omitted
        mode('tool', 'browse', { c: 'capture' }, { transient: false, sticky: true }),
      ],
      commands: [command('open-tool'), command('capture')],
    };
    expect(validateCommandSurface(surface)).toEqual({ valid: true, errors: [] });
  });

  it('does not mutate the surface it validates', () => {
    const surface = validSurface();
    const snapshot: ApplicationCommandSurface = {
      modes: surface.modes.map((entry) => ({ ...entry, keymap: { ...entry.keymap } })),
      commands: surface.commands.map((entry) => ({ ...entry })),
    };
    validateCommandSurface(surface);
    expect(surface).toEqual(snapshot);
  });
});

describe('validateCommandSurface — root rules', () => {
  it('rejects a surface with zero roots', () => {
    const surface: ApplicationCommandSurface = {
      modes: [mode('browse', 'tool'), mode('tool', 'browse')],
      commands: [],
    };
    const result = validateCommandSurface(surface);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('exactly one root mode'))).toBe(true);
    expect(errorsOf(surface).some((error) => error.includes('found 0'))).toBe(true);
  });

  it('rejects a surface with two roots', () => {
    const surface: ApplicationCommandSurface = {
      modes: [mode('browse', null), mode('other', null)],
      commands: [],
    };
    const result = validateCommandSurface(surface);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('exactly one root mode'))).toBe(true);
    expect(errorsOf(surface).some((error) => error.includes('found 2'))).toBe(true);
  });
});

describe('validateCommandSurface — parent chains', () => {
  it('rejects a dangling parent', () => {
    const surface: ApplicationCommandSurface = {
      modes: [mode('browse', null), mode('tool', 'missing')],
      commands: [],
    };
    const errors = errorsOf(surface);
    expect(validateCommandSurface(surface).valid).toBe(false);
    expect(errors.some((error) => error.includes('parent "missing"'))).toBe(true);
    expect(errors.some((error) => error.includes('does not terminate at the root'))).toBe(true);
  });

  it('rejects a cycle (a -> b -> a) for every mode in the cycle', () => {
    const surface: ApplicationCommandSurface = {
      modes: [mode('a', 'b'), mode('b', 'a')],
      commands: [],
    };
    const errors = errorsOf(surface);
    expect(validateCommandSurface(surface).valid).toBe(false);
    expect(errors.filter((error) => error.includes('does not terminate at the root'))).toHaveLength(2);
  });
});

describe('validateCommandSurface — ids', () => {
  it('rejects a duplicate mode id', () => {
    const base = validSurface();
    const surface: ApplicationCommandSurface = {
      modes: [...base.modes, mode('tool', 'browse')],
      commands: base.commands,
    };
    const result = validateCommandSurface(surface);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('duplicate mode id "tool"');
  });

  it('rejects a duplicate command id', () => {
    const base = validSurface();
    const surface: ApplicationCommandSurface = {
      modes: base.modes,
      commands: [...base.commands, command('capture')],
    };
    const result = validateCommandSurface(surface);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('duplicate command id "capture"');
  });
});

describe('COMMAND_MODE_KEY_PATTERN — the mode keymap grammar', () => {
  it('is exactly one lowercase letter or digit', () => {
    expect(COMMAND_MODE_KEY_PATTERN.source).toBe('^[a-z0-9]$');

    for (const stroke of ['a', 'z', '0', '9', 'c']) {
      expect(COMMAND_MODE_KEY_PATTERN.test(stroke)).toBe(true);
    }
    for (const stroke of ['A', 'Z', 'C', 'ctrl+c', 'ab', '', '1+2', ' ', '-']) {
      expect(COMMAND_MODE_KEY_PATTERN.test(stroke)).toBe(false);
    }
  });

  it.each(['C', 'ctrl+c', 'ab', ''])('rejects the %j mode keymap stroke', (stroke) => {
    const surface: ApplicationCommandSurface = {
      modes: [mode('browse', null, { [stroke]: 'capture' })],
      commands: [command('capture')],
    };
    const errors = errorsOf(surface);
    expect(validateCommandSurface(surface).valid).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('keymap stroke');
    expect(errors[0]).toContain('is invalid');
  });
});

describe('validateCommandSurface — keymap targets', () => {
  it('rejects a keymap value that resolves to no declared command', () => {
    const surface: ApplicationCommandSurface = {
      modes: [mode('browse', null, { c: 'nope' })],
      commands: [command('capture')],
    };
    const result = validateCommandSurface(surface);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('unknown command "nope"');
  });
});

describe('validateCommandSurface — determinism', () => {
  it('orders errors deterministically (root -> duplicate ids -> parents -> chains -> keymaps -> commands)', () => {
    const surface: ApplicationCommandSurface = {
      modes: [
        mode('browse', null, { C: 'missing' }), // invalid stroke + unknown target
        mode('browse', 'browse'), // duplicate id
        mode('tool', 'absent'), // dangling parent (+ chain failure)
      ],
      commands: [command('capture'), command('capture')], // duplicate command id
    };

    const result = validateCommandSurface(surface);

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(6);
    expect(result.errors[0]).toContain('duplicate mode id');
    expect(result.errors[1]).toContain('parent "absent"');
    expect(result.errors[2]).toContain('does not terminate at the root');
    expect(result.errors[3]).toContain('is invalid');
    expect(result.errors[4]).toContain('unknown command');
    expect(result.errors[5]).toContain('duplicate command id');

    // Stable across repeated calls (no timestamps / set iteration order).
    expect(validateCommandSurface(surface)).toEqual(result);
  });

  it('valid is exactly errors.length === 0', () => {
    expect(validateCommandSurface(validSurface())).toMatchObject({ valid: true, errors: [] });
    const invalid = validateCommandSurface({ modes: [], commands: [] });
    expect(invalid.valid).toBe(invalid.errors.length === 0);
    expect(invalid.valid).toBe(false);
  });
});

describe('getRootCommandMode / getApplicationCommandMode', () => {
  it('returns the single root mode', () => {
    const root = getRootCommandMode(validSurface());
    expect(root?.id).toBe('browse');
    expect(root?.parent).toBeNull();
  });

  it('returns null when the surface declares no root', () => {
    expect(getRootCommandMode({ modes: [], commands: [] })).toBeNull();
  });

  it('returns null when the surface declares more than one root (no single root)', () => {
    const surface: ApplicationCommandSurface = {
      modes: [mode('browse', null), mode('other', null)],
      commands: [],
    };
    expect(getRootCommandMode(surface)).toBeNull();
  });

  it('finds a declared mode by id and returns null for an unknown id', () => {
    const surface = validSurface();
    expect(getApplicationCommandMode(surface, 'tool')?.label).toBe('TOOL');
    expect(getApplicationCommandMode(surface, 'nope')).toBeNull();
  });
});
