/**
 * Spec #3117 (P3) — ST-2 §9 risk-policy proofs.
 *
 * Covers REQ-09.1–09.4 (contract §9; no separate backlog AC id). Every `it()` title the #3117 QA
 * Plan cites for `riskPolicy.test.ts` is verbatim, and every dispatch is awaited.
 */

import { describe, expect, it } from 'vitest';

import { dispatch, type EngineDeps } from '../dispatch';
import { createJournalStore, type JournalStore } from '../journal';
import {
  NOT_UNDOABLE_REASON,
  type ConfirmationRequest,
  type Intent,
  type JsonPatch,
  type Risk,
  type Surface,
  type VerbDescriptor,
  type VerbEffect,
} from '../types';
import {
  makeEffect,
  makePlace,
  makeSelection,
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

interface HarnessOptions {
  readonly confirmResult?: boolean;
  readonly selectionIds?: readonly string[];
  readonly run?: () => VerbEffect;
}

function makeHarness(surface: Surface, options: HarnessOptions = {}): Harness {
  const journal = createJournalStore();
  const patches: JsonPatch[] = [];
  const confirms: ConfirmationRequest[] = [];
  const deps: EngineDeps = {
    surface,
    getContext: () =>
      makeSnapshot({
        placePath: [surface.tree.root],
        selection: makeSelection({
          count: options.selectionIds?.length ?? 0,
          ids: options.selectionIds ?? [],
        }),
      }),
    journal,
    now: () => '2026-01-01T00:00:00.000Z',
    applyPatch: (patch) => {
      patches.push(patch);
    },
    confirm: (request) => {
      confirms.push(request);
      return options.confirmResult ?? true;
    },
  };
  return { deps, journal, patches, confirms };
}

function surfaceOf(verbs: readonly VerbDescriptor[]): Surface {
  return makeSurface({ root: 'p.root', places: [makePlace({ id: 'p.root' })], verbs });
}

function mutationEffect(label = 'Change', inverse: JsonPatch | null = { n: 0 }): VerbEffect {
  return makeEffect({
    label,
    patch: { before: { n: 0 }, after: { n: 1 } },
    inverse,
  });
}

function intent(verbId: string, overrides: Partial<Intent> = {}): Intent {
  return { verbId, args: {}, channel: 'keyboard', actor: 'human', ...overrides };
}

function riskVerb(id: string, risk: Risk, overrides: Partial<VerbDescriptor> = {}): VerbDescriptor {
  return makeVerb({ id, title: id, risk, run: () => mutationEffect(), ...overrides });
}

describe('§9.1 safe and mutating', () => {
  it('safe and mutating apply without confirmation and journal once', async () => {
    for (const risk of ['safe', 'mutating'] as const) {
      const harness = makeHarness(surfaceOf([riskVerb(`app.${risk}`, risk)]));
      const result = await dispatch(harness.deps, intent(`app.${risk}`));
      expect(result.status).toBe('performed');
      expect(harness.confirms).toHaveLength(0);
      expect(harness.patches).toHaveLength(1);
      expect(harness.journal.entries()).toHaveLength(1);
    }

    // A mutating verb with `inverse: null` still journals once; its consequence is authored.
    const noInverse = riskVerb('app.irreversible', 'mutating', {
      run: () => mutationEffect('Irreversible', null),
      consequence: 'the previous state is not kept.',
    });
    const harness = makeHarness(surfaceOf([noInverse]));
    const result = await dispatch(harness.deps, intent('app.irreversible'));
    expect(result.status).toBe('performed');
    if (result.status !== 'performed') throw new Error(result.status);
    expect(harness.confirms).toHaveLength(0);
    expect(harness.journal.entries()).toHaveLength(1);
    expect(result.entry.undoable).toBe(false);
    expect(result.entry.consequence).toBe('the previous state is not kept.');
  });
});

describe('§9.2 destructive confirmation', () => {
  it('destructive verb does not run until confirmation is accepted', async () => {
    let runs = 0;
    const verb = riskVerb('place.danger', 'destructive', {
      consequence: 'deleted elements are not kept.',
      run: () => {
        runs += 1;
        return mutationEffect();
      },
    });
    const surface = surfaceOf([verb]);

    const dismissed = makeHarness(surface, { confirmResult: false });
    const rejected = await dispatch(dismissed.deps, intent('place.danger'));
    expect(rejected).toStrictEqual({ status: 'rejected', code: 'canceled-confirmation' });
    expect(runs).toBe(0);
    expect(dismissed.patches).toHaveLength(0);
    expect(dismissed.journal.entries()).toHaveLength(0);

    const accepted = makeHarness(surface, { confirmResult: true });
    const performed = await dispatch(accepted.deps, intent('place.danger'));
    expect(performed.status).toBe('performed');
    expect(runs).toBe(1);
    expect(accepted.confirms).toHaveLength(1);
    expect(accepted.patches).toHaveLength(1);
    expect(accepted.journal.entries()).toHaveLength(1);
  });

  it('destructive confirmation carries verb target consequence and undo availability', async () => {
    const selectionIds = ['a', 'b', 'c', 'd', 'e', 'f'];
    const undoable = riskVerb('place.delete', 'destructive', {
      title: 'Delete',
      consequence: 'deleted elements are not kept in Fredo’s history.',
      undo: () => makeEffect({ label: 'Restore' }),
    });
    const harness = makeHarness(surfaceOf([undoable]), { selectionIds });
    await dispatch(harness.deps, intent('place.delete'));

    expect(harness.confirms).toHaveLength(1);
    const request = harness.confirms[0];
    expect(request.verbId).toBe('place.delete');
    expect(request.title).toBe('Delete');
    expect(request.targetLabels).toStrictEqual(['a', 'b', 'c', 'd', 'e']);
    expect(request.targetOverflow).toBe(1);
    expect(request.consequence).toBe('deleted elements are not kept in Fredo’s history.');
    expect(request.undoAvailability).toStrictEqual({ undoable: true });
    expect(request.externalParty).toBeNull();

    // A destructive verb without `undo` reports the authored not-undoable reason.
    const notUndoable = riskVerb('place.purge', 'destructive', {
      title: 'Purge',
      consequence: 'purged content is gone.',
      run: () => mutationEffect('Purge', null),
    });
    const withoutUndo = makeHarness(surfaceOf([notUndoable]));
    await dispatch(withoutUndo.deps, intent('place.purge'));
    expect(withoutUndo.confirms[0].undoAvailability).toStrictEqual({
      undoable: false,
      reason: NOT_UNDOABLE_REASON,
    });
  });
});

describe('§9.3 external confirmation', () => {
  it('external confirmation carries the party and is always not-undoable', async () => {
    const cases: ReadonlyArray<{ arg: string; value: string }> = [
      { arg: 'path', value: '/tmp/export.png' },
      { arg: 'endpoint', value: 'https://api.example.test/upload' },
      { arg: 'shell', value: 'rm -rf ./out' },
    ];

    for (const { arg, value } of cases) {
      const verb = riskVerb('place.export', 'external', {
        title: 'Export',
        consequence: 'the artifact is outside Fredo’s history.',
        // Even a declared undo cannot make an external verb undoable.
        undo: () => makeEffect({ label: 'Restore' }),
        args: [{ name: arg, type: 'string', required: true }],
        run: () => mutationEffect('Export', { n: 0 }),
      });
      const harness = makeHarness(surfaceOf([verb]));
      const result = await dispatch(harness.deps, intent('place.export', { args: { [arg]: value } }));

      expect(result.status).toBe('performed');
      if (result.status !== 'performed') throw new Error(result.status);
      const request = harness.confirms[0];
      expect(request.externalParty).toBe(value);
      expect(request.undoAvailability).toStrictEqual({
        undoable: false,
        reason: NOT_UNDOABLE_REASON,
      });
      expect(result.entry.external).toBe(true);
      expect(result.entry.undoable).toBe(false);
      expect(result.entry.inverse).toBeNull();
    }
  });
});

describe('§9.4 dismissal', () => {
  it('dismissed confirmation rejects canceled-confirmation and journals nothing', async () => {
    for (const risk of ['destructive', 'external'] as const) {
      let runs = 0;
      const verb = riskVerb(`place.${risk}`, risk, {
        consequence: 'the action is not reversible.',
        run: () => {
          runs += 1;
          return mutationEffect('Danger', null);
        },
      });
      const harness = makeHarness(surfaceOf([verb]), { confirmResult: false });
      const result = await dispatch(harness.deps, intent(`place.${risk}`));
      expect(result).toStrictEqual({ status: 'rejected', code: 'canceled-confirmation' });
      expect(runs).toBe(0);
      expect(harness.patches).toHaveLength(0);
      expect(harness.journal.entries()).toHaveLength(0);
    }

    // Accepted confirmation but a throwing `run` is a clean typed failure.
    const throwing = riskVerb('place.throwing', 'destructive', {
      consequence: 'the action is not reversible.',
      run: () => {
        throw new Error('boom');
      },
    });
    const harness = makeHarness(surfaceOf([throwing]), { confirmResult: true });
    expect(await dispatch(harness.deps, intent('place.throwing'))).toStrictEqual({
      status: 'failed',
      code: 'failed-run',
    });
    expect(harness.patches).toHaveLength(0);
    expect(harness.journal.entries()).toHaveLength(0);
  });
});
