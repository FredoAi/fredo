/**
 * Spec #3121 (P7), ST-6 — the AC2 / R-21 mapping-completeness table (QA F-21).
 *
 * The binding inventory of the FIVE migrated surfaces is exactly ELEVEN bindings:
 *
 *   - the 5 in-scope element keys that migrate onto declared place bindings
 *     (Mission Monitor `s`; Dev Mode `x`, `v`, `i`, `b`);
 *   - the 3 kept platform globals (`primary+space`, `primary+tab`, `primary+shift+tab`)
 *     which stay globals and delegate into the declared window-system verbs (D-3(a));
 *   - terminal `F2`, SQL Studio `Ctrl/Cmd+Enter` and the Mission Monitor detail `Escape`
 *     — element-local chords that stay on their shipped controls and map to declared verbs
 *     (D-3(b)/(c), behaviour preservation).
 *
 * The table is the single source of truth for the row set. The test proves BOTH directions:
 * every row resolves to a verb DECLARED by its surface (no omission), and every declared
 * `keys` entry in the five trees maps back to a row (no invented key). `app.map` is declared
 * keyless by B.3 and is excluded; the frozen deprecated apps are excluded by scope (their
 * 7 sites / 9 keys stay for #3122 and are not table rows).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Surface } from '@/shared/navigation';
import { NAVIGATION_GLOBAL_CHORDS } from '@/shared/navigation/ui';

import {
  TERMINAL_SURFACE_APP_ID,
  terminalSurface,
} from '../terminal/terminalSurface';
import {
  MISSION_MONITOR_SURFACE_APP_ID,
  missionMonitorSurface,
} from '../mission-monitor/missionMonitorSurface';
import {
  DATABASE_CLIENT_SURFACE_APP_ID,
  databaseClientSurface,
} from '../database-client/databaseClientSurface';
import { DEV_MODE_SURFACE_APP_ID, devModeSurface } from '../dev-mode/devModeSurface';
import { WINDOW_SYSTEM_APP_ID, windowSystemSurface } from '@/shared/window-system/windowSystemSurface';

/* ───────────────────────────── the 11-row mapping table (B.6 / R-21) ───────────────────────────── */

type BindingKind = 'element-key' | 'kept-global' | 'element-local';

interface MappingRow {
  readonly id: number;
  readonly kind: BindingKind;
  readonly appId: string;
  /** The binding as a user meets it today (B.6 legacy column). */
  readonly binding: string;
  /** The declared verb id the binding maps to (B.6 declared column). */
  readonly verbId: string;
  /** For a place-key row: the single grammar stroke. */
  readonly key?: string;
  /** For a place-key row: every place that declares the key. */
  readonly places?: readonly string[];
}

const TABLE: readonly MappingRow[] = [
  /* ── the five in-scope element keys ── */
  {
    id: 1,
    kind: 'element-key',
    appId: MISSION_MONITOR_SURFACE_APP_ID,
    binding: 's',
    verbId: 'mission-monitor.session.search',
    key: 's',
    places: ['mission-monitor.sessions'],
  },
  {
    id: 2,
    kind: 'element-key',
    appId: DEV_MODE_SURFACE_APP_ID,
    binding: 'x',
    verbId: 'dev-mode.events.clear',
    key: 'x',
    // `x` is bound in BOTH Dev Mode places: the Clear control renders in both views today.
    places: ['dev-mode.events', 'dev-mode.applicationData'],
  },
  {
    id: 3,
    kind: 'element-key',
    appId: DEV_MODE_SURFACE_APP_ID,
    binding: 'v',
    verbId: 'dev-mode.view.applicationData',
    key: 'v',
    // The Application Data button renders in both views, so `v` resolves in both.
    places: ['dev-mode.events', 'dev-mode.applicationData'],
  },
  {
    id: 4,
    kind: 'element-key',
    appId: DEV_MODE_SURFACE_APP_ID,
    binding: 'i',
    verbId: 'dev-mode.search.focus',
    key: 'i',
    places: ['dev-mode.events'],
  },
  {
    id: 5,
    kind: 'element-key',
    appId: DEV_MODE_SURFACE_APP_ID,
    binding: 'b',
    verbId: 'dev-mode.states.all',
    key: 'b',
    places: ['dev-mode.events'],
  },

  /* ── the three kept platform globals (delegate into the declared verbs) ── */
  {
    id: 6,
    kind: 'kept-global',
    appId: WINDOW_SYSTEM_APP_ID,
    binding: 'primary+space',
    verbId: 'window.launcher.toggle',
  },
  {
    id: 7,
    kind: 'kept-global',
    appId: WINDOW_SYSTEM_APP_ID,
    binding: 'primary+tab',
    verbId: 'window.focus.next',
  },
  {
    id: 8,
    kind: 'kept-global',
    appId: WINDOW_SYSTEM_APP_ID,
    binding: 'primary+shift+tab',
    verbId: 'window.focus.previous',
  },

  /* ── the three element-local chords that stay on their shipped controls ── */
  {
    id: 9,
    kind: 'element-local',
    appId: TERMINAL_SURFACE_APP_ID,
    binding: 'F2 on a focused renamable session row',
    verbId: 'terminal.session.rename',
  },
  {
    id: 10,
    kind: 'element-local',
    appId: DATABASE_CLIENT_SURFACE_APP_ID,
    binding: 'Ctrl/Cmd+Enter in the SQL editor',
    verbId: 'sql-studio.query.run',
  },
  {
    id: 11,
    kind: 'element-local',
    appId: MISSION_MONITOR_SURFACE_APP_ID,
    binding: 'Escape while a detail panel is open',
    verbId: 'mission-monitor.detail.close',
  },
];

const SURFACES: Readonly<Record<string, Surface>> = {
  [TERMINAL_SURFACE_APP_ID]: terminalSurface,
  [WINDOW_SYSTEM_APP_ID]: windowSystemSurface,
  [MISSION_MONITOR_SURFACE_APP_ID]: missionMonitorSurface,
  [DATABASE_CLIENT_SURFACE_APP_ID]: databaseClientSurface,
  [DEV_MODE_SURFACE_APP_ID]: devModeSurface,
};

/** Spec #3122 ST-4 — the retained five surfaces are the only in-scope app ids. */
const SURFACE_APP_IDS = new Set(Object.keys(SURFACES));

interface DeclaredKey {
  readonly appId: string;
  readonly placeId: string;
  readonly key: string;
  readonly verbId: string;
}

/** Every place-key binding declared across the five surfaces (B.3). */
function declaredKeys(): DeclaredKey[] {
  const out: DeclaredKey[] = [];
  for (const [appId, surface] of Object.entries(SURFACES)) {
    for (const place of surface.tree.places) {
      for (const [key, binding] of Object.entries(place.keys)) {
        if (binding.kind !== 'verb') continue;
        out.push({ appId, placeId: place.id, key, verbId: binding.verbId });
      }
    }
  }
  return out;
}

function verbsOf(appId: string): readonly string[] {
  const surface = SURFACES[appId];
  if (surface === undefined) throw new Error(`no declaration for ${appId}`);
  return surface.verbs.map((verb) => verb.id);
}

function verbTitle(appId: string, verbId: string): string | undefined {
  return SURFACES[appId]?.verbs.find((verb) => verb.id === verbId)?.title;
}

/* ───────────────────────────── the table ───────────────────────────── */

describe('R-21 — the 11-row binding completeness table', () => {
  it('has exactly ELEVEN rows with ELEVEN distinct verb ids', () => {
    expect(TABLE).toHaveLength(11);
    expect(TABLE.map((row) => row.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(new Set(TABLE.map((row) => row.verbId)).size).toBe(11);
  });

  it('covers the exact binding set B.6 names (5 element keys + 3 globals + F2 + SQL chord + Escape)', () => {
    expect(TABLE.filter((row) => row.kind === 'element-key')).toHaveLength(5);
    expect(TABLE.filter((row) => row.kind === 'kept-global')).toHaveLength(3);
    expect(TABLE.filter((row) => row.kind === 'element-local')).toHaveLength(3);
    expect(TABLE.map((row) => row.binding)).toEqual([
      's',
      'x',
      'v',
      'i',
      'b',
      'primary+space',
      'primary+tab',
      'primary+shift+tab',
      'F2 on a focused renamable session row',
      'Ctrl/Cmd+Enter in the SQL editor',
      'Escape while a detail panel is open',
    ]);
  });

  it('resolves every row to a verb the owning surface actually declares', () => {
    for (const row of TABLE) {
      expect(verbsOf(row.appId), `${row.appId} :: ${row.binding}`).toContain(row.verbId);
    }
  });

  it('maps the three kept globals to the declared window-system verbs', () => {
    const globals = TABLE.filter((row) => row.kind === 'kept-global');
    // The navigation layer owns the three chords now (Spec #3122 ST-2).
    const chordSequences = NAVIGATION_GLOBAL_CHORDS.map(
      (chord) =>
        `${chord.primary ? 'primary+' : ''}${chord.shift ? 'shift+' : ''}${chord.key}`,
    );
    expect(globals.map((row) => row.binding)).toEqual(chordSequences);
    expect(globals.map((row) => row.binding)).toEqual([
      'primary+space',
      'primary+tab',
      'primary+shift+tab',
    ]);
    expect(globals.map((row) => row.verbId)).toEqual(
      NAVIGATION_GLOBAL_CHORDS.map((chord) => chord.verbId),
    );
    expect(globals.map((row) => row.verbId)).toEqual([
      'window.launcher.toggle',
      'window.focus.next',
      'window.focus.previous',
    ]);

    // The ONE global chord dispatcher routes these exact chords into these exact declared
    // verbs (D-3(a) / U-2 — `globalKeys.ts` is the only global dispatch listener).
    const dispatchSource = readFileSync(
      resolve(process.cwd(), 'src/shared/navigation/ui/globalKeys.ts'),
      'utf8',
    );
    for (const verbId of globals.map((row) => row.verbId)) {
      expect(dispatchSource, verbId).toContain(`'${verbId}'`);
    }
  });

  it('keeps the element-local chords as declared verbs without a place key', () => {
    for (const row of TABLE.filter((candidate) => candidate.kind === 'element-local')) {
      expect(row.key).toBeUndefined();
      expect(verbsOf(row.appId)).toContain(row.verbId);
    }
    // The mapping is semantic, not just an id string: the verb titles name the legacy outcome.
    expect(verbTitle(TERMINAL_SURFACE_APP_ID, 'terminal.session.rename')).toBe('Rename session');
    expect(verbTitle(DATABASE_CLIENT_SURFACE_APP_ID, 'sql-studio.query.run')).toBe('Run query');
    expect(
      verbTitle(MISSION_MONITOR_SURFACE_APP_ID, 'mission-monitor.detail.close'),
    ).toBe('Close detail');
  });

  it('maps every declared place-key entry back to a table row (no invented key)', () => {
    const rowsByVerb = new Map(TABLE.map((row) => [row.verbId, row]));
    const declared = declaredKeys();

    for (const entry of declared) {
      const row = rowsByVerb.get(entry.verbId);
      expect(row, `${entry.appId} ${entry.placeId}:${entry.key} → ${entry.verbId}`).toBeDefined();
      expect(row?.kind).toBe('element-key');
      expect(row?.key).toBe(entry.key);
      expect(row?.places, `${entry.appId} ${entry.placeId}:${entry.key}`).toContain(entry.placeId);
    }

    // The other direction: every element-key row is declared exactly where B.3 says.
    for (const row of TABLE.filter((candidate) => candidate.kind === 'element-key')) {
      const matching = declared.filter(
        (entry) => entry.appId === row.appId && entry.key === row.key && entry.verbId === row.verbId,
      );
      expect(matching.map((entry) => entry.placeId).sort(), row.binding).toEqual(
        [...(row.places ?? [])].sort(),
      );
    }
  });

  it('declares no place key at all in terminal, window-system and SQL Studio', () => {
    for (const appId of [
      TERMINAL_SURFACE_APP_ID,
      WINDOW_SYSTEM_APP_ID,
      DATABASE_CLIENT_SURFACE_APP_ID,
    ]) {
      expect(declaredKeys().filter((entry) => entry.appId === appId), appId).toEqual([]);
    }
  });

  it('excludes app.map (declared keyless and unpublished in all five)', () => {
    expect(TABLE.some((row) => row.verbId === 'app.map')).toBe(false);
    expect(declaredKeys().some((entry) => entry.verbId === 'app.map')).toBe(false);
    for (const [appId, surface] of Object.entries(SURFACES)) {
      const map = surface.verbs.find((verb) => verb.id === 'app.map');
      expect(map?.publish, appId).toBe(false);
    }
  });

  it('scopes the table to the five retained surfaces (not omitted)', () => {
    expect(TABLE.every((row) => SURFACE_APP_IDS.has(row.appId))).toBe(true);
    // The five in-scope ids are the ONLY app ids in the table and its declarations.
    expect(new Set(TABLE.map((row) => row.appId))).toStrictEqual(
      new Set([
        TERMINAL_SURFACE_APP_ID,
        WINDOW_SYSTEM_APP_ID,
        MISSION_MONITOR_SURFACE_APP_ID,
        DATABASE_CLIENT_SURFACE_APP_ID,
        DEV_MODE_SURFACE_APP_ID,
      ]),
    );
  });
});
