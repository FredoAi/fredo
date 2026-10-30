/**
 * Spec #3117 (P3) / Spec #3119 (P5) — ST-5 §4.3 worked traces (AC2 / REQ-03.1–03.4).
 *
 * Three rows, all seven published columns: tier, intents, args, journal effects, journal
 * `placePath`, post-dispatch cursor and `exitedBy`. Every dispatch is awaited (Reading #12).
 *
 * P5 re-baselines the published matrix to the Spec #3119 tree: the intents now read
 * `wireframe.*` ids and the root entry keys are `{kind:'place'}` bindings. `TRACES` lives in
 * `fixtures.ts` and the trace surface is derived from `publishedWireframeSurface()` so the
 * published docs §4.2 and this suite cannot disagree (R-d).
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
import { isBindableStroke, normalizeStroke } from '../resolver';
import { validateSurface } from '../validation';
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
  makeSelection,
  makeSnapshot,
  publishedWireframeSurface,
} from './fixtures';

const CANVAS = 'wireframe.canvas';
const CREATE = 'wireframe.create';
const TS = '2026-01-01T00:00:00.000Z';
const NOW_MS = 1000;

/** §4.2 — the three published direct aliases. */
const PUBLISHED_ALIASES = {
  r: 'wireframe.create.rect',
  u: 'journal.undo',
  y: 'journal.redo',
} as const;

function boundTargets(reg: SurfaceRegistry, placeId: string, stroke: string): string[] {
  const bindings = reg.bindingsByPlace.get(placeId)?.get(stroke) ?? [];
  return bindings.map((binding) => (binding.kind === 'verb' ? binding.verbId : binding.placeId));
}

describe('§4.2 published key map (REQ-03.1)', () => {
  it('fixture declares the published key map', () => {
    const surface = publishedWireframeSurface();
    const reg = createRegistry(surface);

    expect(surface.tree.appId).toBe('wireframe');
    expect(surface.tree.root).toBe(CANVAS);

    // R-1 feasibility: the published tree is V-valid under the P5 ROOT-only V-08 rule
    // (Arrange binds `u → ungroup` while the application aliases `u → journal.undo`).
    expect(validateSurface(surface)).toStrictEqual({ valid: true, diagnostics: [] });

    // canvas — place entries (kind:'place'), the two globals, the arrow selection keys.
    expect(boundTargets(reg, CANVAS, 'c')).toStrictEqual([CREATE]);
    expect(boundTargets(reg, CANVAS, 'e')).toStrictEqual(['wireframe.edit']);
    expect(boundTargets(reg, CANVAS, 'a')).toStrictEqual(['wireframe.arrange']);
    expect(boundTargets(reg, CANVAS, 's')).toStrictEqual(['wireframe.style']);
    expect(boundTargets(reg, CANVAS, 'v')).toStrictEqual(['wireframe.view']);
    expect(boundTargets(reg, CANVAS, 'f')).toStrictEqual(['wireframe.file']);
    expect(boundTargets(reg, CANVAS, 'm')).toStrictEqual(['app.map']);
    expect(boundTargets(reg, CANVAS, 'k')).toStrictEqual(['app.ask']);
    expect(boundTargets(reg, CANVAS, 'ArrowLeft')).toStrictEqual(['wireframe.selection.previous']);
    expect(boundTargets(reg, CANVAS, 'ArrowUp')).toStrictEqual(['wireframe.selection.previous']);
    expect(boundTargets(reg, CANVAS, 'ArrowRight')).toStrictEqual(['wireframe.selection.next']);
    expect(boundTargets(reg, CANVAS, 'ArrowDown')).toStrictEqual(['wireframe.selection.next']);

    // create (transient)
    expect(boundTargets(reg, CREATE, 'r')).toStrictEqual(['wireframe.create.rect']);
    expect(boundTargets(reg, CREATE, 'e')).toStrictEqual(['wireframe.create.ellipse']);
    expect(boundTargets(reg, CREATE, 't')).toStrictEqual(['wireframe.add.text']);
    expect(boundTargets(reg, CREATE, 'b')).toStrictEqual(['wireframe.add.button']);
    expect(boundTargets(reg, CREATE, 'i')).toStrictEqual(['wireframe.add.input']);
    expect(boundTargets(reg, CREATE, 'm')).toStrictEqual(['wireframe.add.image']);
    expect(boundTargets(reg, CREATE, 'k')).toStrictEqual(['wireframe.add.card']);
    expect(boundTargets(reg, CREATE, 's')).toStrictEqual(['wireframe.add.section']);
    expect(boundTargets(reg, CREATE, 'l')).toStrictEqual(['wireframe.add.line']);

    // edit (sticky)
    expect(boundTargets(reg, 'wireframe.edit', 'd')).toStrictEqual([
      'wireframe.element.duplicate',
    ]);
    expect(boundTargets(reg, 'wireframe.edit', 'x')).toStrictEqual(['wireframe.element.delete']);
    expect(boundTargets(reg, 'wireframe.edit', 'l')).toStrictEqual([
      'wireframe.element.toggleLock',
    ]);
    expect(boundTargets(reg, 'wireframe.edit', 'h')).toStrictEqual([
      'wireframe.element.toggleVisible',
    ]);
    expect(boundTargets(reg, 'wireframe.edit', 'r')).toStrictEqual(['wireframe.element.rename']);

    // arrange (sticky)
    expect(boundTargets(reg, 'wireframe.arrange', 'g')).toStrictEqual(['wireframe.arrange.group']);
    expect(boundTargets(reg, 'wireframe.arrange', 'u')).toStrictEqual([
      'wireframe.arrange.ungroup',
    ]);
    expect(boundTargets(reg, 'wireframe.arrange', 'ArrowLeft')).toStrictEqual([
      'wireframe.arrange.alignLeft',
    ]);
    expect(boundTargets(reg, 'wireframe.arrange', 'ArrowRight')).toStrictEqual([
      'wireframe.arrange.alignRight',
    ]);
    expect(boundTargets(reg, 'wireframe.arrange', 'd')).toStrictEqual([
      'wireframe.arrange.distribute',
    ]);
    expect(boundTargets(reg, 'wireframe.arrange', 'f')).toStrictEqual([
      'wireframe.arrange.bringForward',
    ]);
    expect(boundTargets(reg, 'wireframe.arrange', 'b')).toStrictEqual([
      'wireframe.arrange.sendBackward',
    ]);
    expect(boundTargets(reg, 'wireframe.arrange', 's')).toStrictEqual([
      'wireframe.arrange.toggleSnap',
    ]);

    // style (sticky)
    expect(boundTargets(reg, 'wireframe.style', 'f')).toStrictEqual(['wireframe.style.fill']);
    expect(boundTargets(reg, 'wireframe.style', 'o')).toStrictEqual(['wireframe.style.border']);
    expect(boundTargets(reg, 'wireframe.style', 'p')).toStrictEqual([
      'wireframe.style.appearance',
    ]);
    expect(boundTargets(reg, 'wireframe.style', 'z')).toStrictEqual(['wireframe.style.radius']);
    expect(boundTargets(reg, 'wireframe.style', 't')).toStrictEqual([
      'wireframe.style.textStyle',
    ]);

    // view (sticky)
    expect(boundTargets(reg, 'wireframe.view', '+')).toStrictEqual(['wireframe.zoom.in']);
    expect(boundTargets(reg, 'wireframe.view', '-')).toStrictEqual(['wireframe.zoom.out']);
    expect(boundTargets(reg, 'wireframe.view', 'f')).toStrictEqual(['wireframe.view.fitPage']);
    expect(boundTargets(reg, 'wireframe.view', '0')).toStrictEqual(['wireframe.view.resetView']);
    expect(boundTargets(reg, 'wireframe.view', 'p')).toStrictEqual(['wireframe.view.togglePan']);

    // file (sticky)
    expect(boundTargets(reg, 'wireframe.file', 'n')).toStrictEqual(['wireframe.document.new']);
    expect(boundTargets(reg, 'wireframe.file', 'o')).toStrictEqual(['place.open']);
    expect(boundTargets(reg, 'wireframe.file', 'w')).toStrictEqual(['place.saveAs']);
    expect(boundTargets(reg, 'wireframe.file', 'x')).toStrictEqual(['place.exportPng']);

    // The three direct aliases, exactly.
    expect(surface.tree.directAliases).toStrictEqual(PUBLISHED_ALIASES);

    // §4.4 — the P5 grammar extension: arrows and + / - are bindable reserved strokes.
    for (const stroke of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-']) {
      expect(isBindableStroke(stroke), stroke).toBe(true);
    }
    expect(normalizeStroke('arrowleft')).toBe('ArrowLeft');
    expect(normalizeStroke('ArrowRight')).toBe('ArrowRight');

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
  'wireframe.create': CREATE,
};

/**
 * The published surface with ONE override: `wireframe.create.rect` performs a REAL mutation
 * (one patch pair, one inverse) so the `c r` / `r` traces can publish the `mutation` effect.
 * The declaration (keys, aliases, places) is exactly `publishedWireframeSurface()`.
 */
function traceSurface(): Surface {
  const base = publishedWireframeSurface();
  return {
    ...base,
    verbs: base.verbs.map((verb) =>
      verb.id === 'wireframe.create.rect'
        ? {
            ...verb,
            run: () =>
              makeEffect({
                label: 'Rectangle',
                patch: { before: { shapes: 0 }, after: { shapes: 1 } },
                inverse: { shapes: 0 },
                target: [],
              }),
          }
        : verb,
    ),
  };
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

    // Both journal the SAME `wireframe.create.rect` mutation effect.
    const crRect = cr.entries.find((entry) => entry.verbId === 'wireframe.create.rect');
    const rRect = r.entries.find((entry) => entry.verbId === 'wireframe.create.rect');
    if (crRect === undefined || rRect === undefined) {
      throw new Error('both traces must journal a wireframe.create.rect entry');
    }
    expect(crRect.effect).toBe('mutation');
    expect(rRect.effect).toBe('mutation');

    // The journal row differs ONLY in its dispatch-time path. `seq` is the entry's ordinal
    // and `exitedBy` is the separately published transient-exit column (REQ-03.4).
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
    expect(run.entries[0]?.verbId).toBe('wireframe.create');
    expect(run.entries[0]?.effect).toBe('navigation');
    expect(run.entries[0]?.placePath).toStrictEqual([CANVAS]);

    expect(run.entries[1]?.verbId).toBe('wireframe.create.rect');
    expect(run.entries[1]?.effect).toBe('mutation');
    expect(run.entries[1]?.exitedBy).toBe('verb');
    expect(run.entries[1]?.placePath).toStrictEqual([CANVAS, CREATE]);

    // Exactly ONE navigation entry, and it is the create navigation — the transient pop
    // is recorded on the mutation entry, never as a second `navigation` entry.
    const navigations = run.entries.filter((entry) => entry.effect === 'navigation');
    expect(navigations).toHaveLength(1);
    expect(navigations.map((entry) => entry.verbId)).toStrictEqual(['wireframe.create']);
  });
});
