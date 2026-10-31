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
  validateCommandArgs,
  validateCommandSurface,
  type ApplicationCommandArg,
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

// ── Spec #3099 — declared argument contract ──────────────────────────────────

describe('validateCommandSurface — declared args (Spec #3099)', () => {
  it('rejects a duplicate declared arg name within one command', () => {
    const surface: ApplicationCommandSurface = {
      modes: [mode('browse', null)],
      commands: [
        command('create', { args: [{ name: 'fill' }, { name: 'fill', required: true }] }),
      ],
    };
    const result = validateCommandSurface(surface);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(['duplicate arg name "fill" in command "create"']);
  });

  it('allows the same arg name on different commands', () => {
    const surface: ApplicationCommandSurface = {
      modes: [mode('browse', null)],
      commands: [
        command('first', { args: [{ name: 'value' }] }),
        command('second', { args: [{ name: 'value' }] }),
      ],
    };
    expect(validateCommandSurface(surface)).toEqual({ valid: true, errors: [] });
  });

  it('does not require a description (absent means not published, not invalid)', () => {
    expect(validateCommandSurface(validSurface())).toEqual({ valid: true, errors: [] });
    expect(command('capture').description).toBeUndefined();
  });
});

function arg(name: string, extras: Partial<ApplicationCommandArg> = {}): ApplicationCommandArg {
  return { name, ...extras };
}

describe('validateCommandArgs — the ONE declared-argument rule', () => {
  it('accepts a satisfied contract (required present, optional omitted)', () => {
    const cmd = command('create', { args: [arg('fill', { required: true }), arg('note')] });
    expect(validateCommandArgs(cmd, { fill: 'accent' })).toEqual({ ok: true });
    expect(validateCommandArgs(cmd, { fill: 'accent', note: 'hi' })).toEqual({ ok: true });
  });

  it('treats `undefined` as `{}` so a required argument fails', () => {
    const cmd = command('create', { args: [arg('fill', { required: true })] });
    expect(validateCommandArgs(cmd, undefined)).toEqual({
      ok: false,
      reason: 'missing-required',
      detail: 'missing required argument "fill"',
    });
  });

  it('rejects a missing required argument', () => {
    const cmd = command('create', { args: [arg('fill', { required: true })] });
    expect(validateCommandArgs(cmd, {})).toMatchObject({
      ok: false,
      reason: 'missing-required',
    });
  });

  it.each([null, [], 'text', 7, true])('rejects a non-object arguments value (%j)', (args) => {
    const cmd = command('create', { args: [arg('fill')] });
    expect(validateCommandArgs(cmd, args)).toMatchObject({ ok: false, reason: 'not-an-object' });
  });

  it('rejects an undeclared key', () => {
    const cmd = command('create', { args: [arg('fill')] });
    expect(validateCommandArgs(cmd, { fill: 'accent', extra: 'x' })).toEqual({
      ok: false,
      reason: 'undeclared-key',
      detail: 'undeclared argument "extra"',
    });
  });

  it('rejects a non-string value', () => {
    const cmd = command('create', { args: [arg('fill')] });
    expect(validateCommandArgs(cmd, { fill: 42 })).toMatchObject({
      ok: false,
      reason: 'not-a-string',
    });
  });

  it.each(['', '   '])('rejects a blank value (%j)', (value) => {
    const cmd = command('create', { args: [arg('fill')] });
    expect(validateCommandArgs(cmd, { fill: value })).toMatchObject({
      ok: false,
      reason: 'blank',
    });
  });

  it.each(['', '   '])(
    'accepts a blank value on an allowEmpty arg and keeps siblings strict (%j)',
    (value) => {
      // A declared free-text argument opts out of the blank rule (Spec #3120 ST-1).
      const freeText = command('freeText', { args: [arg('label', { allowEmpty: true })] });
      expect(validateCommandArgs(freeText, { label: value })).toEqual({ ok: true });
      expect(validateCommandArgs(freeText, { label: 'Reports' })).toEqual({ ok: true });

      // The opt-out is per argument: a sibling plain arg stays strict.
      const mixed = command('mixed', {
        args: [arg('label', { allowEmpty: true }), arg('other')],
      });
      expect(validateCommandArgs(mixed, { label: '', other: '' })).toMatchObject({
        ok: false,
        reason: 'blank',
        detail: 'argument "other" must not be blank',
      });

      // An explicit `false` is NOT an opt-in (the absent-key rule's runtime twin).
      const explicitFalse = command('explicitFalse', { args: [arg('label', { allowEmpty: false })] });
      expect(validateCommandArgs(explicitFalse, { label: value })).toMatchObject({
        ok: false,
        reason: 'blank',
      });
    },
  );

  it('rejects a declared validate guard returning false and receives the RAW value', () => {
    const guard = (value: string) => value.trim() === 'accent';
    const cmd = command('create', { args: [arg('fill', { validate: guard })] });
    expect(validateCommandArgs(cmd, { fill: ' accent ' })).toEqual({ ok: true });
    expect(validateCommandArgs(cmd, { fill: 'chartreuse' })).toEqual({
      ok: false,
      reason: 'failed-guard',
      detail: 'argument "fill" failed its guard',
    });
  });

  it('passes an undeclared contract by default (Spec #3097 legacy pass-through)', () => {
    const cmd = command('legacy');
    expect(cmd.args).toBeUndefined();
    expect(validateCommandArgs(cmd, { anything: 'goes' })).toEqual({ ok: true });
    expect(validateCommandArgs(cmd, undefined)).toEqual({ ok: true });
  });

  it('opts in when an EMPTY args array is declared (no keys accepted)', () => {
    const cmd = command('noargs', { args: [] });
    expect(validateCommandArgs(cmd, {})).toEqual({ ok: true });
    expect(validateCommandArgs(cmd, undefined)).toEqual({ ok: true });
    expect(validateCommandArgs(cmd, { extra: 'x' })).toMatchObject({
      ok: false,
      reason: 'undeclared-key',
    });
  });

  it('does not mutate the supplied arguments', () => {
    const cmd = command('create', { args: [arg('fill', { required: true })] });
    const args = { fill: 'accent' };
    validateCommandArgs(cmd, args);
    expect(args).toEqual({ fill: 'accent' });
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
