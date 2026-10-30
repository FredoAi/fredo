/**
 * Spec #3117 (P3) — ST-2 §5 dispatch-funnel proofs.
 *
 * Covers REQ-04.1–04.10. Every `it()` title the #3117 QA Plan cites for `dispatch.test.ts` is
 * verbatim, and every dispatch is awaited (Reading #12).
 */

import { describe, expect, it } from 'vitest';

import { createDispatcher, dispatch, type EngineDeps } from '../dispatch';
import { createJournalStore, type JournalStore } from '../journal';
import {
  type ConfirmationRequest,
  type ContextSnapshot,
  type Intent,
  type JsonPatch,
  type Surface,
  type VerbDescriptor,
  type VerbEffect,
} from '../types';
import {
  makeEffect,
  makePlace,
  makeObjectRef,
  makeSnapshot,
  makeSurface,
  makeVerb,
} from './fixtures';

interface Harness {
  readonly deps: EngineDeps;
  readonly journal: JournalStore;
  readonly patches: JsonPatch[];
  readonly confirms: ConfirmationRequest[];
}

/** One dependency set with a recording `applyPatch` and an accepting `confirm`. */
function makeHarness(
  surface: Surface,
  overrides: Partial<EngineDeps> = {},
  context: Partial<ContextSnapshot> = {},
): Harness {
  const journal = overrides.journal ?? createJournalStore();
  const patches: JsonPatch[] = [];
  const confirms: ConfirmationRequest[] = [];
  const deps: EngineDeps = {
    surface,
    getContext: () => makeSnapshot({ placePath: [surface.tree.root], ...context }),
    journal,
    now: () => '2026-01-01T00:00:00.000Z',
    applyPatch: (patch) => {
      patches.push(patch);
    },
    confirm: (request) => {
      confirms.push(request);
      return true;
    },
    ...overrides,
  };
  return { deps, journal, patches, confirms };
}

function surfaceOf(verbs: readonly VerbDescriptor[]): Surface {
  return makeSurface({ root: 'p.root', places: [makePlace({ id: 'p.root' })], verbs });
}

function mutationEffect(label = 'Change'): VerbEffect {
  return makeEffect({
    label,
    patch: { before: { n: 0 }, after: { n: 1 } },
    inverse: { n: 0 },
    target: [makeObjectRef('element-1')],
  });
}

function intent(verbId: string, overrides: Partial<Intent> = {}): Intent {
  return { verbId, args: {}, channel: 'keyboard', actor: 'human', ...overrides };
}

function undoIntent(count: number): Intent {
  return intent('journal.undo', { args: { count: String(count) }, channel: 'system' });
}

describe('§5.1 one entry point', () => {
  it('all six channels reach the verb through dispatch', async () => {
    let runs = 0;
    const verb = makeVerb({
      id: 'app.ping',
      title: 'Ping',
      run: () => {
        runs += 1;
        return mutationEffect();
      },
    });
    const surface = surfaceOf([verb]);
    const harness = makeHarness(surface);

    const channels = ['keyboard', 'pointer', 'launcher', 'voice', 'agent', 'system'] as const;
    for (const channel of channels) {
      const actor = channel === 'voice' || channel === 'agent' ? 'companion' : 'human';
      const result = await dispatch(harness.deps, intent('app.ping', { channel, actor }));
      expect(result.status).toBe('performed');
      if (result.status !== 'performed') throw new Error(result.status);
      expect(result.entry.channel).toBe(channel);
      expect(result.entry.actor).toBe(actor);
    }
    expect(runs).toBe(6);
    expect(harness.journal.entries()).toHaveLength(6);

    // The bound dispatcher is the same funnel.
    const bound = createDispatcher(harness.deps);
    const boundResult = await bound(intent('app.ping'));
    expect(boundResult.status).toBe('performed');
    expect(runs).toBe(7);
  });
});

describe('§9.2 actor identity', () => {
  it('companion channel with non-companion actor rejects actor-spoof first', async () => {
    let runs = 0;
    const verb = makeVerb({
      id: 'app.strict',
      args: [{ name: 'required', type: 'string', required: true }],
      run: () => {
        runs += 1;
        return mutationEffect();
      },
    });
    const surface = surfaceOf([verb]);

    for (const channel of ['voice', 'agent'] as const) {
      for (const actor of ['human', 'system'] as const) {
        const harness = makeHarness(surface);
        // Invalid args AND a spoofed actor: the spoof is reported first.
        const result = await dispatch(
          harness.deps,
          intent('app.strict', { channel, actor, args: { undeclared: 'x' } }),
        );
        expect(result).toStrictEqual({ status: 'rejected', code: 'actor-spoof' });
        expect(runs).toBe(0);
        expect(harness.journal.entries()).toHaveLength(0);
        expect(harness.patches).toHaveLength(0);
      }
    }

    // An unknown verb on the companion path is still a spoof first.
    const harness = makeHarness(surface);
    const unknown = await dispatch(
      harness.deps,
      intent('does.not.exist', { channel: 'agent', actor: 'human' }),
    );
    expect(unknown).toStrictEqual({ status: 'rejected', code: 'actor-spoof' });

    // The keyboard channel may carry a companion actor — no spoof.
    const allowed = await dispatch(
      harness.deps,
      intent('app.strict', { channel: 'keyboard', actor: 'companion', args: { required: 'ok' } }),
    );
    expect(allowed.status).toBe('performed');
  });
});

describe('§5.2 validation order', () => {
  it('validation order is existence then availability then args then risk', async () => {
    let confirms = 0;
    const unavailable = makeVerb({
      id: 'app.unavailable',
      available: () => false,
      args: [{ name: 'required', type: 'string', required: true }],
      run: () => mutationEffect(),
    });
    const destructive = makeVerb({
      id: 'place.danger',
      risk: 'destructive',
      consequence: 'this is not kept.',
      args: [{ name: 'required', type: 'string', required: true }],
      run: () => mutationEffect(),
    });
    const surface = surfaceOf([unavailable, destructive]);
    const harness = makeHarness(surface, {
      confirm: () => {
        confirms += 1;
        return true;
      },
    });

    // 1. Existence: an undeclared id never reaches availability.
    expect(await dispatch(harness.deps, intent('unknown.verb'))).toStrictEqual({
      status: 'rejected',
      code: 'unknown-verb',
    });

    // 2. Availability before arguments: bad args still report `unavailable`.
    expect(
      await dispatch(harness.deps, intent('app.unavailable', { args: {} })),
    ).toStrictEqual({ status: 'rejected', code: 'unavailable' });

    // 3. Arguments before risk: a destructive verb with bad args never asks for confirmation.
    expect(
      await dispatch(harness.deps, intent('place.danger', { args: {} })),
    ).toStrictEqual({ status: 'rejected', code: 'invalid-args' });
    expect(confirms).toBe(0);

    // 4. Risk last: with valid args the destructive verb asks for confirmation.
    const accepted = await dispatch(
      harness.deps,
      intent('place.danger', { args: { required: 'ok' } }),
    );
    expect(accepted.status).toBe('performed');
    expect(confirms).toBe(1);
  });
});

describe('§5.2 existence / availability / arguments', () => {
  it('unknown verb rejects unknown-verb', async () => {
    const harness = makeHarness(surfaceOf([]));
    expect(await dispatch(harness.deps, intent('app.missing'))).toStrictEqual({
      status: 'rejected',
      code: 'unknown-verb',
    });
    expect(harness.journal.entries()).toHaveLength(0);
    expect(harness.patches).toHaveLength(0);
  });

  it('unavailable verb rejects unavailable', async () => {
    let runs = 0;
    const surface = surfaceOf([
      makeVerb({
        id: 'app.off',
        available: () => false,
        run: () => {
          runs += 1;
          return mutationEffect();
        },
      }),
    ]);
    const harness = makeHarness(surface);
    expect(await dispatch(harness.deps, intent('app.off'))).toStrictEqual({
      status: 'rejected',
      code: 'unavailable',
    });
    expect(runs).toBe(0);
    expect(harness.journal.entries()).toHaveLength(0);
    expect(harness.patches).toHaveLength(0);
  });

  it('invalid args rejects invalid-args', async () => {
    const verb = makeVerb({
      id: 'app.args',
      args: [
        { name: 'required', type: 'string', required: true },
        { name: 'optional', type: 'string', required: false },
        {
          name: 'guarded',
          type: 'string',
          required: false,
          validate: (value) => value === 'allowed',
        },
      ],
      run: () => mutationEffect(),
    });
    const surface = surfaceOf([verb]);

    const cases: ReadonlyArray<Readonly<Record<string, string>>> = [
      { undeclared: 'x' }, // undeclared key
      {}, // missing required
      { required: 'ok', optional: 42 as unknown as string }, // non-string
      { required: '   ' }, // blank / whitespace-only
      { required: 'ok', guarded: 'nope' }, // failed validate guard
    ];

    for (const args of cases) {
      const harness = makeHarness(surface);
      const result = await dispatch(harness.deps, intent('app.args', { args }));
      expect(result).toStrictEqual({ status: 'rejected', code: 'invalid-args' });
      expect(harness.journal.entries()).toHaveLength(0);
      expect(harness.patches).toHaveLength(0);
    }
  });
});

describe('§5.2/§5.3 run + effect', () => {
  it('successful run applies and journals exactly one effect', async () => {
    const syncEffect = mutationEffect('Draw');
    const harness = makeHarness(surfaceOf([makeVerb({ id: 'app.draw', run: () => syncEffect })]));

    const result = await dispatch(harness.deps, intent('app.draw', { channel: 'pointer' }));
    expect(result.status).toBe('performed');
    if (result.status !== 'performed') throw new Error(result.status);
    expect(harness.patches).toStrictEqual([syncEffect.patch?.after]);
    expect(harness.journal.entries()).toHaveLength(1);
    expect(result.entry.actor).toBe('human');
    expect(result.entry.channel).toBe('pointer');
    expect(result.entry.effect).toBe('mutation');
    expect(result.entry.patch).toStrictEqual(syncEffect.patch);
    expect(result.entry.target).toStrictEqual(syncEffect.target);

    // An async `run` is awaited; `dispatch` itself returns a promise.
    const asyncEffect = mutationEffect('Async draw');
    const asyncHarness = makeHarness(
      surfaceOf([makeVerb({ id: 'app.async', run: async () => asyncEffect })]),
    );
    const pending = dispatch(asyncHarness.deps, intent('app.async', { channel: 'launcher' }));
    expect(pending).toBeInstanceOf(Promise);
    const asyncResult = await pending;
    expect(asyncResult.status).toBe('performed');
    expect(asyncHarness.patches).toStrictEqual([asyncEffect.patch?.after]);
    expect(asyncHarness.journal.entries()).toHaveLength(1);
  });

  it('did-nothing returns noop and journals nothing', async () => {
    const noopEffect = makeEffect({ label: 'Nothing', patch: null, inverse: null, target: [] });
    const harness = makeHarness(surfaceOf([makeVerb({ id: 'app.noop', run: () => noopEffect })]));

    const result = await dispatch(harness.deps, intent('app.noop'));
    expect(result).toStrictEqual({ status: 'noop', code: 'did-nothing', message: null });
    expect(harness.patches).toHaveLength(0);
    expect(harness.journal.entries()).toHaveLength(0);
  });

  it('throwing run returns failed failed-run and journals nothing', async () => {
    const throwing = makeVerb({
      id: 'app.throw',
      run: () => {
        throw new Error('boom');
      },
    });
    const rejection = makeVerb({
      id: 'app.reject',
      run: async () => {
        throw new Error('boom');
      },
    });

    const harness = makeHarness(surfaceOf([throwing]));
    const thrown = await dispatch(harness.deps, intent('app.throw'));
    expect(thrown).toStrictEqual({ status: 'failed', code: 'failed-run' });

    const asyncHarness = makeHarness(surfaceOf([rejection]));
    const rejected = await dispatch(asyncHarness.deps, intent('app.reject'));
    expect(rejected).toStrictEqual({ status: 'failed', code: 'failed-run' });

    expect(harness.journal.entries()).toHaveLength(0);
    expect(harness.patches).toHaveLength(0);
    expect(asyncHarness.journal.entries()).toHaveLength(0);
    expect(asyncHarness.patches).toHaveLength(0);
  });
});

describe('§6.4/§4.10 multi-entry undo', () => {
  function undoSurface(): Surface {
    return surfaceOf([
      makeVerb({
        id: 'app.a',
        run: () =>
          makeEffect({ label: 'A', patch: { before: { a: 0 }, after: { a: 1 } }, inverse: { a: 0 } }),
      }),
      makeVerb({
        id: 'app.b',
        run: () =>
          makeEffect({ label: 'B', patch: { before: { b: 0 }, after: { b: 1 } }, inverse: { b: 0 } }),
      }),
    ]);
  }

  it('multi-entry undo stops after applied inverses returns partial', async () => {
    const surface = undoSurface();
    const journal = createJournalStore();
    const calls: JsonPatch[] = [];
    const seeding = makeHarness(surface, {
      journal,
      applyPatch: (patch) => {
        calls.push(patch);
      },
      now: () => '2026-01-01T00:00:00.000Z',
    });
    await dispatch(seeding.deps, intent('app.a'));
    await dispatch(seeding.deps, intent('app.b'));

    // The newest inverse (B) applies; the second (A) fails.
    let undoCall = 0;
    const failing: EngineDeps = {
      ...seeding.deps,
      applyPatch: (patch) => {
        undoCall += 1;
        if (undoCall === 2) throw new Error('apply failed');
        calls.push(patch);
      },
    };
    const result = await dispatch(failing, undoIntent(2));
    expect(result).toStrictEqual({
      status: 'partial',
      code: 'undo-failed',
      applied: 1,
      failedSeq: 1,
    });
    // The B inverse was applied before the failing A inverse.
    expect(calls[calls.length - 1]).toStrictEqual({ b: 0 });
    // The applied inverse is preserved for the requester (a human undo stays human).
    const entries = journal.entries();
    expect(entries).toHaveLength(3);
    expect(entries[2].actor).toBe('human');
    expect(entries[2].channel).toBe('system');
    expect(entries[2].effect).toBe('mutation');

    // Failure on the FIRST inverse reports applied 0.
    const freshJournal = createJournalStore();
    const freshHarness = makeHarness(surface, {
      journal: freshJournal,
      applyPatch: () => {
        /* no-op */
      },
      now: () => '2026-01-01T00:00:00.000Z',
    });
    await dispatch(freshHarness.deps, intent('app.a'));
    await dispatch(freshHarness.deps, intent('app.b'));
    const firstFailure: EngineDeps = {
      ...freshHarness.deps,
      applyPatch: () => {
        throw new Error('apply failed');
      },
    };
    expect(await dispatch(firstFailure, undoIntent(2))).toStrictEqual({
      status: 'partial',
      code: 'undo-failed',
      applied: 0,
      failedSeq: 2,
    });
  });
});
