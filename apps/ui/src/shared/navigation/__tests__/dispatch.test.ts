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
  NOTHING_TO_UNDO,
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

  it('a blank value is rejected unless the argument declares allowEmpty (Spec #3120 ST-1)', async () => {
    // A non-free-text arg keeps the strict blank rule.
    const strict = makeVerb({
      id: 'app.strictLabel',
      args: [{ name: 'label', type: 'string', required: false }],
      run: () => mutationEffect('Set label'),
    });
    // A declared free-text arg may legitimately be '' (or whitespace-only).
    const freeText = makeVerb({
      id: 'app.freeTextLabel',
      args: [{ name: 'label', type: 'string', required: false, allowEmpty: true }],
      run: () => mutationEffect('Set label'),
    });
    const surface = surfaceOf([strict, freeText]);

    for (const blank of ['', '   ']) {
      const strictHarness = makeHarness(surface);
      expect(
        await dispatch(strictHarness.deps, intent('app.strictLabel', { args: { label: blank } })),
      ).toStrictEqual({ status: 'rejected', code: 'invalid-args' });
      expect(strictHarness.journal.entries()).toHaveLength(0);
      expect(strictHarness.patches).toHaveLength(0);
    }

    for (const blank of ['', '   ']) {
      const freeHarness = makeHarness(surface);
      const result = await dispatch(
        freeHarness.deps,
        intent('app.freeTextLabel', { args: { label: blank } }),
      );
      expect(result.status).toBe('performed');
      if (result.status !== 'performed') throw new Error(result.status);
      expect(result.entry.verbId).toBe('app.freeTextLabel');
      expect(freeHarness.journal.entries()).toHaveLength(1);
      expect(freeHarness.patches).toHaveLength(1);
    }

    // The opt-out is per argument: a non-blank value is still validated as usual.
    const valueHarness = makeHarness(surface);
    expect(
      (await dispatch(valueHarness.deps, intent('app.freeTextLabel', { args: { label: 'Reports' } })))
        .status,
    ).toBe('performed');
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

describe('§6.4 undo by description — the verbId filter (Spec #3120 ST-8)', () => {
  const LABEL_VERB = 'wireframe.element.setLabel';
  const LOCK_VERB = 'wireframe.element.toggleLock';

  function undoByDescriptionSurface(): Surface {
    return surfaceOf([
      makeVerb({
        id: LABEL_VERB,
        title: 'Set label',
        risk: 'mutating',
        args: [{ name: 'value', type: 'string', required: false, allowEmpty: true }],
        run: () =>
          makeEffect({
            label: 'Set label',
            patch: { before: { label: 'old' }, after: { label: 'Reports' } },
            inverse: { label: 'old' },
            target: [makeObjectRef('card-1')],
          }),
      }),
      makeVerb({
        id: LOCK_VERB,
        title: 'Toggle lock',
        risk: 'mutating',
        run: () =>
          makeEffect({
            label: 'Toggle lock',
            patch: { before: { locked: false }, after: { locked: true } },
            inverse: { locked: false },
            target: [makeObjectRef('card-1')],
          }),
      }),
    ]);
  }

  /**
   * A label verb whose `run` derives `before` from the value it last wrote, so two
   * successive edits carry DISTINGUISHABLE inverses (`''` and `'Alpha'`) and the
   * newest-first order can be proven from the applied patches alone.
   */
  function labelOnlySurface(): Surface {
    let current = '';
    return surfaceOf([
      makeVerb({
        id: LABEL_VERB,
        title: 'Set label',
        risk: 'mutating',
        args: [{ name: 'value', type: 'string', required: false, allowEmpty: true }],
        run: (intent) => {
          const value = intent.args.value ?? '';
          const before = { label: current };
          current = value;
          return makeEffect({
            label: 'Set label',
            patch: { before, after: { label: value } },
            inverse: before,
            target: [makeObjectRef('card-1')],
          });
        },
      }),
    ]);
  }

  it('reverts exactly the matching verb entries and no other', async () => {
    const harness = makeHarness(undoByDescriptionSurface(), {
      now: () => '2026-01-01T00:00:00.000Z',
    });

    // Two different edits: the label change (companion) then a lock change (human).
    await dispatch(
      harness.deps,
      intent(LABEL_VERB, { channel: 'agent', actor: 'companion', args: { value: 'Reports' } }),
    );
    await dispatch(harness.deps, intent(LOCK_VERB, { channel: 'keyboard', actor: 'human' }));

    const result = await dispatch(
      harness.deps,
      intent('journal.undo', {
        channel: 'system',
        args: { verbId: LABEL_VERB, count: '1' },
      }),
    );

    // The verbId is an accepted manifest argument: the funnel never rejects it.
    expect(result.status).toBe('performed');
    if (result.status !== 'performed') throw new Error(result.status);
    expect(result.entry.verbId).toBe(LABEL_VERB);
    expect(result.entry.label).toBe('Undo Set label');

    // Only the label inverse was applied; the lock inverse was left untouched.
    expect(harness.patches).toStrictEqual([
      { label: 'Reports' },
      { locked: true },
      { label: 'old' },
    ]);

    // Append-only: both originals remain; one reversal entry was added.
    const entries = harness.journal.entries();
    expect(entries).toHaveLength(3);
    expect(entries[0].verbId).toBe(LABEL_VERB);
    expect(entries[1].verbId).toBe(LOCK_VERB);
    expect(entries[2].verbId).toBe(LABEL_VERB);
    expect(entries[2].label).toBe('Undo Set label');

    // Newest-first: with two matches, ONE undo reverts the newer label edit and
    // leaves the older label entry intact.
    const multi = makeHarness(labelOnlySurface(), {
      now: () => '2026-01-01T00:00:00.000Z',
    });
    await dispatch(multi.deps, intent(LABEL_VERB, { args: { value: 'Alpha' } }));
    await dispatch(multi.deps, intent(LABEL_VERB, { args: { value: 'Beta' } }));
    // The two edits carry distinguishable inverses: '' (Alpha) and 'Alpha' (Beta).
    expect(multi.patches).toStrictEqual([{ label: 'Alpha' }, { label: 'Beta' }]);

    const undo = await dispatch(
      multi.deps,
      intent('journal.undo', { channel: 'system', args: { verbId: LABEL_VERB, count: '1' } }),
    );
    expect(undo.status).toBe('performed');
    // Newest-first (`seq DESC`): with two matches only the newer edit is reverted —
    // the applied inverse is the newer edit's `'Alpha'`, never the older one's `''`.
    expect(multi.patches.slice(-1)).toStrictEqual([{ label: 'Alpha' }]);
    // Append-only: both originals remain and exactly one reversal was appended.
    expect(multi.journal.entries()).toHaveLength(3);
    expect(multi.journal.entries()[0].verbId).toBe(LABEL_VERB);
    expect(multi.journal.entries()[1].verbId).toBe(LABEL_VERB);
    expect(multi.journal.entries()[2].label).toBe('Undo Set label');
  });

  it('an unknown verbId filter is a no-matches noop', async () => {
    const harness = makeHarness(undoByDescriptionSurface(), {
      now: () => '2026-01-01T00:00:00.000Z',
    });
    await dispatch(harness.deps, intent(LABEL_VERB, { args: { value: 'Reports' } }));

    const patchesBefore = harness.patches.length;
    const result = await dispatch(
      harness.deps,
      intent('journal.undo', {
        channel: 'system',
        args: { verbId: 'wireframe.nope', count: '1' },
      }),
    );

    expect(result).toStrictEqual({ status: 'noop', code: 'no-matches', message: NOTHING_TO_UNDO });
    expect(harness.patches).toHaveLength(patchesBefore);
    expect(harness.journal.entries()).toHaveLength(1);
  });
});
