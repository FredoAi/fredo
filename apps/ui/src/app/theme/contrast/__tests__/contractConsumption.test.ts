/**
 * Spec #3034 ST-3 — the contrast gate CONSUMES the theme contract.
 *
 * Proves the gate is contract-sourced (not a divergent copy):
 *  - the surface/state vocabulary is the contract's, re-exported (never re-declared);
 *  - every gate row is a member of the contract's completeness enumeration;
 *  - every gate pair is backed by contract cells + token names (gate ⊆ contract);
 *  - the raw-colour allowlist IS the contract's copy (identity, no second list);
 *  - mutating ONE contract token derivation changes the matrix (Q-10 / AC5 hinge).
 *
 * Pure — no DOM, no network, no filesystem.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ART_PALETTE_ALLOWLIST,
  CONTROL_STATE_IDS,
  SEMANTIC_TOKENS,
  SURFACE_IDS,
  TOKEN_NAMES,
} from '../../contract';
import {
  CONTRACT_CELLS,
  GATE_STATES,
  GATE_SURFACES,
  buildContrastMatrix,
  gatePairsWithinContract,
} from '../matrix';
import { RAW_COLOR_ALLOWLIST } from '../rawColorAllowlist';

afterEach(() => {
  vi.doUnmock('../../contract');
  vi.resetModules();
});

describe('#3034 ST-3 — the contrast gate consumes the contract', () => {
  it('re-exports the contract surface/state vocabulary instead of re-declaring it', () => {
    expect(GATE_SURFACES).toBe(SURFACE_IDS);
    expect(GATE_STATES).toBe(CONTROL_STATE_IDS);
  });

  it('every gate row is a member of the contract completeness enumeration (gate ⊆ contract)', () => {
    const matrix = buildContrastMatrix();
    expect(matrix.length).toBeGreaterThan(0);
    for (const row of matrix) {
      expect(CONTRACT_CELLS.has(`${row.surface}|${row.state}`), row.key).toBe(true);
    }
  });

  it('every gate pair is backed by a contract cell + contract token names', () => {
    expect(gatePairsWithinContract()).toBe(true);
  });

  it('exposes the contract tokens the gate resolves by name', () => {
    for (const name of [
      'accent.default',
      'accent.strong',
      'fg.default',
      'fg.muted',
      'fg.subtle',
      'fg.onAccent',
      'border.default',
      'bg.canvas',
      'bg.surface',
      'bg.subtle',
      'accent.focusRing',
      'accent.border',
      'accent.solid',
      // #3086 — the Wireframe control-class tokens.
      'accent.tint',
      'bg.muted',
      'status.error',
      'status.errorTint',
      'status.errorStrong',
    ]) {
      expect(TOKEN_NAMES.has(name), name).toBe(true);
    }
  });

  it('covers the Wireframe control-class surfaces in the gate ⊆ contract projection', () => {
    const matrix = buildContrastMatrix();
    for (const surface of [
      'segmented',
      'slider',
      'number-input',
      'control-ghost',
      'status-solid',
      'banner',
    ] as const) {
      expect(
        matrix.some((row) => row.surface === surface),
        `gate projection missing ${surface}`,
      ).toBe(true);
      expect(GATE_SURFACES, `vocabulary missing ${surface}`).toContain(surface);
    }
  });

  it('the raw-colour allowlist IS the contract copy (identity + deep-equal)', () => {
    expect(RAW_COLOR_ALLOWLIST).toBe(ART_PALETTE_ALLOWLIST);
    expect(RAW_COLOR_ALLOWLIST).toEqual(ART_PALETTE_ALLOWLIST);
  });

  it('is contract-sourced: mutating ONE contract token derivation moves the matrix', async () => {
    const baseline = buildContrastMatrix();

    vi.resetModules();
    vi.doMock('../../contract', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../contract')>();
      const mutated = actual.SEMANTIC_TOKENS.map((token) =>
        token.name === 'accent.strong' && token.derivation
          ? { ...token, derivation: { ...token.derivation, weights: [0.5, 0.5] } }
          : token,
      );
      return { ...actual, SEMANTIC_TOKENS: mutated };
    });

    const { buildContrastMatrix: buildMutated } = await import('../matrix');
    const mutated = buildMutated();

    expect(mutated).toHaveLength(baseline.length);
    const changed = mutated.filter((row, index) => row.ratio !== baseline[index].ratio);
    expect(changed.length, 'a contract token mutation must move the matrix').toBeGreaterThan(0);

    vi.doUnmock('../../contract');
    vi.resetModules();
  });

  it('keeps the contract token registry internally consistent', () => {
    expect(TOKEN_NAMES.size).toBe(SEMANTIC_TOKENS.length);
  });
});
