/**
 * Spec #3117 (P3) — ST-5 §4.3 worked traces (AC2 / REQ-03.1–03.4).
 *
 * Three rows, all seven published columns: tier, intents, args, journal effects, journal
 * `placePath`, post-dispatch cursor and `exitedBy`. Every dispatch is awaited (Reading #12).
 *
 * The trace surface is built LOCALLY from the same §4.2 ids, key map and place flags as
 * `fixtures.ts`'s `validWireframeSurface()`. Reason: the fixture's default verb `run`
 * returns a patch-less mutation (`makeEffect({ label })` ⇒ `patch: null`), which dispatch
 * correctly classifies as `noop did-nothing` and does NOT journal — so it cannot produce the
 * published `navigation` / `mutation` effects. `fixtures.ts` is NOT edited (it is ST-1's file
 * and other suites pin its content); only the two trace verbs are declared here.
 *
 * The cursor is host-owned (dispatch deliberately performs no cursor mutation, §2.2). This
 * harness applies the documented host contract: a navigation verb pushes its target child
 * place, and a completed verb in a `transient` place pops exactly one level (REQ-02.12).
 */

import { describe, expect, it } from 'vitest';

import { dispatch, type EngineDeps } from '../dispatch';
import { createJournalStore } from '../journal';
import { resolveStroke, type KeyResolution } from '../keyResolver';
import { createRegistry, type SurfaceRegistry } from '../registry';
import {
  type ContextSnapshot,
  type Intent,
  type JournalEntry,
  type JsonPatch,
  type Surface,
} from '../types';
import {
  TRACES,
  type TraceCase,
  makeEffect,
  makePlace,
  makeSelection,
  makeSnapshot,
  makeSurface,
  makeVerb,
  validWireframeSurface,
} from './fixtures';

const CANVAS = 'wireframe.canvas';
const CREATE = 'wireframe.create';
const TS = '2026-01-01T00:00:00.000Z';
const NOW_MS = 1000;

/** §4.2 — the four published direct aliases. */
const PUBLISHED_ALIASES = {
  r: 'place.rect',
  e: 'place.ellipse',
  u: 'journal.undo',
  y: 'journal.redo',
} as const;

function boundTargets(reg: SurfaceRegistry, placeId: string, stroke: string): string[] {
  const bindings = reg.bindingsByPlace.get(placeId)?.get(stroke) ?? [];
  return bindings.map((binding) => (binding.kind === 'verb' ? binding.verbId : binding.placeId));
}

describe('§4.2 published key map (REQ-03.1)', () => {
  it('fixture declares the published key map', () => {
    const surface = validWireframeSurface();
    const reg = createRegistry(surface);

    expect(surface.tree.appId).toBe('wireframe');
    expect(surface.tree.root).toBe(CANVAS);

    // canvas — navigation + application capabilities
    const canvasKeys: Readonly<Record<string, string>> = {
      c: 'place.create',
      i: 'place.edit',
      a: 'place.arrange',
      s: 'place.style',
      v: 'place.view',
      f: 'place.file',
      m: 'app.map',
      k: 'app.ask',
      p: 'app.palette',
      'w n': 'window.focusNext',
      'w p': 'window.focusPrevious',
    };
    for (const [stroke, verbId] of Object.entries(canvasKeys)) {
      expect(boundTargets(reg, CANVAS, stroke), `${CANVAS} ${stroke}`).toStrictEqual([verbId]);
    }
    // create (transient)
    expect(boundTargets(reg, CREATE, 'r')).toStrictEqual(['place.rect']);
    expect(boundTargets(reg, CREATE, 'e')).toStrictEqual(['place.ellipse']);
    expect(boundTargets(reg, CREATE, 't')).toStrictEqual(['place.text']);
    expect(boundTargets(reg, CREATE, 'b')).toStrictEqual(['place.button']);
    // edit (sticky)
    expect(boundTargets(reg, 'wireframe.edit', 'a')).toStrictEqual(['place.selectAll']);
    expect(boundTargets(reg, 'wireframe.edit', 'd')).toStrictEqual(['place.duplicate']);
    expect(boundTargets(reg, 'wireframe.edit', 'x')).toStrictEqual(['place.delete']);
    expect(boundTargets(reg, 'wireframe.edit', 'l')).toStrictEqual(['place.toggleLock']);
    // arrange (sticky)
    expect(boundTargets(reg, 'wireframe.arrange', 'l')).toStrictEqual(['place.alignLeft']);
    expect(boundTargets(reg, 'wireframe.arrange', 'c')).toStrictEqual(['place.alignCenter']);
    expect(boundTargets(reg, 'wireframe.arrange', 'z')).toStrictEqual(['place.alignRight']);
    expect(boundTargets(reg, 'wireframe.arrange', 'd')).toStrictEqual(['place.distribute']);
    expect(boundTargets(reg, 'wireframe.arrange', 'g')).toStrictEqual(['place.group']);
    expect(boundTargets(reg, 'wireframe.arrange', 'n')).toStrictEqual(['place.ungroup']);
    expect(boundTargets(reg, 'wireframe.arrange', 'f')).toStrictEqual(['place.bringForward']);
    expect(boundTargets(reg, 'wireframe.arrange', 'b')).toStrictEqual(['place.sendBackward']);
    // style (sticky)
    expect(boundTargets(reg, 'wireframe.style', 'f')).toStrictEqual(['place.setFill']);
    expect(boundTargets(reg, 'wireframe.style', 'c')).toStrictEqual(['place.copyStyle']);
    expect(boundTargets(reg, 'wireframe.style', 'x')).toStrictEqual(['place.resetStyle']);
    // view (sticky)
    expect(boundTargets(reg, 'wireframe.view', 'i')).toStrictEqual(['place.zoomIn']);
    expect(boundTargets(reg, 'wireframe.view', 'o')).toStrictEqual(['place.zoomOut']);
    expect(boundTargets(reg, 'wireframe.view', 'n')).toStrictEqual(['place.fitPage']);
    expect(boundTargets(reg, 'wireframe.view', 'h')).toStrictEqual(['place.togglePan']);
    // file (sticky)
    expect(boundTargets(reg, 'wireframe.file', 's')).toStrictEqual(['place.save']);
    expect(boundTargets(reg, 'wireframe.file', 'a')).toStrictEqual(['place.saveAs']);
    expect(boundTargets(reg, 'wireframe.file', 'o')).toStrictEqual(['place.open']);
    expect(boundTargets(reg, 'wireframe.file', 'x')).toStrictEqual(['place.exportPng']);
    expect(boundTargets(reg, 'wireframe.file', 'n')).toStrictEqual(['wireframe.document.new']);

    // The four direct aliases, exactly.
    expect(surface.tree.directAliases).toStrictEqual(PUBLISHED_ALIASES);

    // `w` is deliberately unbound (only the `w n` / `w p` sequences exist).
    expect(reg.bindingsByPlace.get(CANVAS)?.has('w')).toBe(false);
    expect(surface.tree.directAliases).not.toHaveProperty('w');

    // Place flags: canvas root; create transient; edit/arrange/style/view/file sticky.
    const byId = new Map(surface.tree.places.map((place) => [place.id, place]));
    expect(byId.get(CANVAS)?.parent).toBeNull();
    expect(byId.get(CREATE)?.parent).toBe(CANVAS);
    expect(byId.get(CREATE)?.transient).toBe(true);
    expect(byId.get(CREATE)?.sticky).toBe(false);
    for (const id of [
      'wireframe.edit',
      'wireframe.arrange',
      'wireframe.style',
      'wireframe.view',
      'wireframe.file',
    ]) {
      expect(byId.get(id)?.parent).toBe(CANVAS);
      expect(byId.get(id)?.transient).toBe(false);
      expect(byId.get(id)?.sticky).toBe(true);
    }
  });
});

/* ───────────────────────────── trace harness ───────────────────────────── */

/** The navigation verb of the `c` trace and the place it enters. */
const NAVIGATION_TARGET_PLACES: Readonly<Record<string, string>> = {
  'place.create': CREATE,
};

/**
 * The §4.2 surface subset the three traces need: canvas → create, `c` entering create,
 * `r` drawing a rectangle, and the `r` direct alias for the tier-2 `r` trace.
 */
function traceSurface(): Surface {
  return makeSurface({
    appId: 'wireframe',
    root: CANVAS,
    places: [
      makePlace({
        id: CANVAS,
        label: 'Canvas',
        parent: null,
        keys: { c: { kind: 'verb', verbId: 'place.create' } },
      }),
      makePlace({
        id: CREATE,
        label: 'Create',
        parent: CANVAS,
        transient: true,
        sticky: false,
        keys: { r: { kind: 'verb', verbId: 'place.rect' } },
      }),
    ],
    verbs: [
      makeVerb({
        id: 'place.create',
        title: 'Create',
        risk: 'safe',
        appliesTo: { objects: ['page'], places: [CANVAS] },
        // §5.2 navigation effect: no patch, no inverse, journaled as `navigation`.
        run: () =>
          makeEffect({ effect: 'navigation', label: 'Create', patch: null, inverse: null, target: [] }),
      }),
      makeVerb({
        id: 'place.rect',
        title: 'Rectangle',
        risk: 'safe',
        appliesTo: { objects: ['element'], places: [CREATE] },
        // A real mutation: one patch pair, one inverse — exactly one journal entry.
        run: () =>
          makeEffect({
            label: 'Rectangle',
            patch: { before: { shapes: 0 }, after: { shapes: 1 } },
            inverse: { shapes: 0 },
            target: [],
          }),
      }),
    ],
    directAliases: { r: 'place.rect' },
  });
}

interface TraceRun {
  readonly resolutions: readonly KeyResolution[];
  readonly intents: readonly Intent[];
  readonly entries: readonly JournalEntry[];
  readonly cursor: readonly string[];
}

/** Drive one trace from `wireframe.canvas` with an empty selection. */
async function driveTrace(trace: TraceCase): Promise<TraceRun> {
  const surface = traceSurface();
  const journal = createJournalStore();
  const patches: JsonPatch[] = [];
  let cursor: readonly string[] = [CANVAS];

  const deps: EngineDeps = {
    surface,
    getContext: (): ContextSnapshot =>
      makeSnapshot({
        appId: 'wireframe',
        placePath: cursor,
        selection: makeSelection(),
        dirty: false,
      }),
    journal,
    now: () => TS,
    applyPatch: (patch) => {
      patches.push(patch);
    },
    confirm: () => true,
  };

  const resolutions: KeyResolution[] = [];
  const intents: Intent[] = [];

  for (const stroke of trace.strokes) {
    const resolution = resolveStroke({
      surface,
      placePath: cursor,
      pending: null,
      stroke,
      nowMs: NOW_MS,
      keyboardOwner: 'engine',
    });
    resolutions.push(resolution);
    if (resolution.status !== 'dispatch') {
      throw new Error(`stroke "${stroke}" did not dispatch (got ${resolution.status})`);
    }
    intents.push(resolution.intent);

    const result = await dispatch(deps, resolution.intent);
    if (result.status !== 'performed') {
      throw new Error(`stroke "${stroke}" was not performed (got ${result.status})`);
    }
    const entry = result.entry;
    if (entry.effect === 'navigation') {
      const target = NAVIGATION_TARGET_PLACES[entry.verbId];
      if (target !== undefined) cursor = [...cursor, target];
    } else {
      const currentId = cursor[cursor.length - 1];
      const place = surface.tree.places.find((candidate) => candidate.id === currentId);
      if (place?.transient === true && cursor.length > 1) {
        cursor = cursor.slice(0, -1);
      }
    }
  }

  return { resolutions, intents, entries: journal.entries(), cursor };
}

/** Assert all seven published columns for one trace row. */
async function expectTraceRow(trace: TraceCase): Promise<TraceRun> {
  const run = await driveTrace(trace);

  // 1. tier — only dispatch outcomes carry a tier.
  expect(
    run.resolutions.map((resolution) =>
      resolution.status === 'dispatch' ? resolution.tier : null,
    ),
  ).toStrictEqual(trace.tiers);

  // 2. resolved intent ids
  expect(run.intents.map((intent) => intent.verbId)).toStrictEqual(trace.intents);

  // 3. args
  expect(run.intents.map((intent) => intent.args)).toStrictEqual(trace.args);

  // 4. journal effects
  expect(run.entries.map((entry) => entry.effect)).toStrictEqual(trace.effects);

  // 5. journal `placePath` — the dispatch-time path of the LAST entry (REQ-03.2/03.3).
  expect(run.entries[run.entries.length - 1]?.placePath).toStrictEqual(trace.placePath);

  // 6. post-dispatch cursor
  expect(run.cursor).toStrictEqual(trace.cursorPath);

  // 7. exitedBy per journal entry
  expect(run.entries.map((entry) => entry.exitedBy)).toStrictEqual(trace.exitedBy);

  return run;
}

describe('§4.3 worked traces (REQ-03.2–03.4)', () => {
  it('c trace matches every published column', async () => {
    await expectTraceRow(TRACES[0]);
  });

  it('c r trace matches every published column', async () => {
    await expectTraceRow(TRACES[1]);
  });

  it('r trace matches every published column', async () => {
    await expectTraceRow(TRACES[2]);
  });

  it('c r and r differ only in journal placePath', async () => {
    const cr = await driveTrace(TRACES[1]);
    const r = await driveTrace(TRACES[2]);

    // Both end at the SAME cursor.
    expect(cr.cursor).toStrictEqual(r.cursor);
    expect(cr.cursor).toStrictEqual([CANVAS]);

    // Both journal the SAME `place.rect` mutation effect.
    const crRect = cr.entries.find((entry) => entry.verbId === 'place.rect');
    const rRect = r.entries.find((entry) => entry.verbId === 'place.rect');
    if (crRect === undefined || rRect === undefined) {
      throw new Error('both traces must journal a place.rect entry');
    }
    expect(crRect.effect).toBe('mutation');
    expect(rRect.effect).toBe('mutation');

    // The journal row differs ONLY in its dispatch-time path. `seq` is the entry's ordinal
    // (the `c r` run journals a navigation entry first) and `exitedBy` is the separately
    // published transient-exit column (REQ-03.4, asserted below).
    const comparable = (entry: JournalEntry): Omit<JournalEntry, 'seq' | 'placePath' | 'exitedBy'> => {
      const { seq: _seq, placePath: _placePath, exitedBy: _exitedBy, ...rest } = entry;
      return rest;
    };
    expect(comparable(crRect)).toStrictEqual(comparable(rRect));

    expect(crRect.placePath).toStrictEqual([CANVAS, CREATE]);
    expect(rRect.placePath).toStrictEqual([CANVAS]);
    // The two paths are the published difference (`['canvas','create']` vs `['canvas']`).
    expect(rRect.placePath).toStrictEqual(crRect.placePath.slice(0, 1));

    // `exitedBy` is the OTHER published column: completing in the transient create place
    // records `'verb'`, while the same verb at the canvas records `'none'` (REQ-03.4).
    expect(crRect.exitedBy).toBe('verb');
    expect(rRect.exitedBy).toBe('none');
  });

  it('c r journals navigation then mutation and never a second navigation', async () => {
    const run = await driveTrace(TRACES[1]);

    expect(run.entries).toHaveLength(2);
    expect(run.entries[0]?.verbId).toBe('place.create');
    expect(run.entries[0]?.effect).toBe('navigation');
    expect(run.entries[0]?.placePath).toStrictEqual([CANVAS]);

    expect(run.entries[1]?.verbId).toBe('place.rect');
    expect(run.entries[1]?.effect).toBe('mutation');
    expect(run.entries[1]?.exitedBy).toBe('verb');
    expect(run.entries[1]?.placePath).toStrictEqual([CANVAS, CREATE]);

    // Exactly ONE navigation entry, and it is the create navigation — the transient pop
    // is recorded on the mutation entry, never as a second `navigation` entry.
    const navigations = run.entries.filter((entry) => entry.effect === 'navigation');
    expect(navigations).toHaveLength(1);
    expect(navigations.map((entry) => entry.verbId)).toStrictEqual(['place.create']);
  });
});
