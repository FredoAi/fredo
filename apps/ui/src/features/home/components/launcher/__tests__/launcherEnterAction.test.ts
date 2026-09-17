/**
 * Spec #2882 ST-1 — pins the ONE pure Enter decision.
 *
 * Deterministic, no React: the module is pure, so every rule of R-5.1/R-5.3/
 * R-5.4 (the whole-query matcher + the top-ranked match), the binding
 * precedence table (R-5/R-6 + PO clarifications #1/#2) and the hint-copy
 * derivation (R-4.5/R-6.3) is asserted directly.
 *
 * The names used are the SHIPPED ones (`SettingsFeature` → `Settings`,
 * `MissionMonitorFeature` → `Mission Monitor`) so the AC5 examples are pinned
 * against reality, not a fixture that happens to match.
 */
import { describe, it, expect } from 'vitest';

import type { FredoFeatureClass } from '../../../../shared/classes/FredoFeatureClass';
import {
  ENTER_HINT_COPY,
  appNameMatches,
  enterHintLabel,
  findTopRankedMatch,
  resolveEnterAction,
  type LauncherEnterAction,
} from '../launcherEnterAction';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Test double: the pure module only ever reads `name` (and returns the entry by
 * identity), so a minimal shape is sufficient and keeps this suite free of any
 * component/registry import.
 */
const entry = (id: string, name: string): FredoFeatureClass =>
  ({ id, name }) as unknown as FredoFeatureClass;

const SETTINGS = entry('settings-app', 'Settings');
const MISSION_MONITOR = entry('mission-monitor', 'Mission Monitor');
const STATUS = entry('status', 'Status');

/** The rendered results-list order used by most cases (arbitrary but fixed). */
const ENTRIES: readonly FredoFeatureClass[] = [SETTINGS, MISSION_MONITOR, STATUS];

// ── appNameMatches — the whole-query matcher (R-5.1/R-5.4) ───────────────────

describe('appNameMatches — whole-query prefix OR whole-word run (R-5.1/R-5.4)', () => {
  it('matches a whole-query prefix of the name', () => {
    expect(appNameMatches('set', 'Settings')).toBe(true);
    expect(appNameMatches('Sett', 'Settings')).toBe(true);
    expect(appNameMatches('Settings', 'Settings')).toBe(true);
    expect(appNameMatches('mission', 'Mission Monitor')).toBe(true);
    expect(appNameMatches('mission monitor', 'Mission Monitor')).toBe(true);
    expect(appNameMatches('Mission Mon', 'Mission Monitor')).toBe(true);
  });

  it('matches case-insensitively (AC5: `Miss` AND `miss`)', () => {
    expect(appNameMatches('Miss', 'Mission Monitor')).toBe(true);
    expect(appNameMatches('miss', 'Mission Monitor')).toBe(true);
    expect(appNameMatches('MISS', 'Mission Monitor')).toBe(true);
    expect(appNameMatches('SeT', 'Settings')).toBe(true);
  });

  it('matches a whole word occurring inside the name (AC5: `monitor`)', () => {
    expect(appNameMatches('monitor', 'Mission Monitor')).toBe(true);
    expect(appNameMatches('Monitor', 'Mission Monitor')).toBe(true);
    expect(appNameMatches('Viewer', 'Query Viewer')).toBe(true);
  });

  it('matches a contiguous run of whole words inside the name', () => {
    // `Monitor` alone and the full run both hold; the run is boundary-checked
    // as one needle, not word-by-word.
    expect(appNameMatches('monitor', 'Mission Monitor')).toBe(true);
    expect(appNameMatches('query viewer', 'Query Viewer')).toBe(true);
  });

  it('REJECTS a sentence that merely contains a matching fragment (R-6.2)', () => {
    // `Missing all the time` contains `Miss`, which IS a prefix of `Mission
    // Monitor` — the query must still match nothing (AC6).
    expect(appNameMatches('Missing all the time', 'Mission Monitor')).toBe(false);
    expect(appNameMatches('Miss all the time', 'Mission Monitor')).toBe(false);
    expect(appNameMatches('issing', 'Mission Monitor')).toBe(false);
    expect(appNameMatches('missing', 'Mission Monitor')).toBe(false);
  });

  it('REJECTS a partial word (a fragment is never a whole-word run)', () => {
    expect(appNameMatches('ission', 'Mission Monitor')).toBe(false);
    expect(appNameMatches('ission monitor', 'Mission Monitor')).toBe(false);
    expect(appNameMatches('ttings', 'Settings')).toBe(false);
    expect(appNameMatches('on', 'Mission Monitor')).toBe(false);
    expect(appNameMatches('Mon', 'Mission Monitor')).toBe(false);
  });

  it('REJECTS aliases, abbreviations and nicknames (R-5.4: `MM` matches nothing)', () => {
    expect(appNameMatches('MM', 'Mission Monitor')).toBe(false);
    expect(appNameMatches('mm', 'Mission Monitor')).toBe(false);
    expect(appNameMatches('MisMon', 'Mission Monitor')).toBe(false);
    expect(appNameMatches('set', 'Mission Monitor')).toBe(false);
    expect(appNameMatches('monitor', 'Settings')).toBe(false);
  });

  it('trims the query but never collapses internal whitespace', () => {
    expect(appNameMatches('  set  ', 'Settings')).toBe(true);
    expect(appNameMatches('\tmission monitor\n', 'Mission Monitor')).toBe(true);
    // Internal double space: neither the matcher nor the substring filter match
    // (the two must agree — contract 2).
    expect(appNameMatches('mission  monitor', 'Mission Monitor')).toBe(false);
    expect('mission monitor'.includes('mission  monitor')).toBe(false);
  });

  it('matches nothing for an empty or whitespace-only query', () => {
    expect(appNameMatches('', 'Settings')).toBe(false);
    expect(appNameMatches('   ', 'Settings')).toBe(false);
    expect(appNameMatches('\t\n', 'Settings')).toBe(false);
  });

  it('INVARIANT: every rule-matching app also passes the grid substring filter', () => {
    // `prefix ⇒ includes` and `whole-word run ⇒ includes` (contract 2) — the
    // grid therefore always shows the app the hint names.
    const names = ['Settings', 'Mission Monitor', 'Status', 'Query Viewer', 'Run CLI'];
    const queries = [
      'set',
      'Miss',
      'miss',
      'MISS',
      'monitor',
      'mission monitor',
      'Mission Mon',
      'Mon',
      'MM',
      'Missing all the time',
      'Missing',
      'ission',
      '  set  ',
      's',
      'm',
      'viewer',
    ];
    for (const name of names) {
      for (const query of queries) {
        if (appNameMatches(query, name)) {
          expect(name.toLowerCase().includes(query.trim().toLowerCase())).toBe(true);
        }
      }
    }
  });
});

// ── findTopRankedMatch — results-list order (R-5.3, clarification #1) ────────

describe('findTopRankedMatch — earliest matching entry of the rendered list (R-5.3)', () => {
  it('returns the FIRST matching entry in the given order', () => {
    const twoMatches: readonly FredoFeatureClass[] = [
      entry('settings-app', 'Settings'),
      entry('status', 'Status'),
    ];
    expect(findTopRankedMatch('s', twoMatches)).toBe(twoMatches[0]);

    const reversed: readonly FredoFeatureClass[] = [
      entry('status', 'Status'),
      entry('settings-app', 'Settings'),
    ];
    expect(findTopRankedMatch('s', reversed)).toBe(reversed[0]);
  });

  it('returns the matching entry by identity (so the shell launches the right app)', () => {
    expect(findTopRankedMatch('set', ENTRIES)).toBe(SETTINGS);
    expect(findTopRankedMatch('Miss', ENTRIES)).toBe(MISSION_MONITOR);
    expect(findTopRankedMatch('monitor', ENTRIES)).toBe(MISSION_MONITOR);
  });

  it('returns null when nothing matches (fragment, alias, empty query)', () => {
    expect(findTopRankedMatch('Missing all the time', ENTRIES)).toBeNull();
    expect(findTopRankedMatch('MM', ENTRIES)).toBeNull();
    expect(findTopRankedMatch('mission monitor x', ENTRIES)).toBeNull();
    expect(findTopRankedMatch('', ENTRIES)).toBeNull();
    expect(findTopRankedMatch('   ', ENTRIES)).toBeNull();
  });

  it('returns null for an empty entry list', () => {
    expect(findTopRankedMatch('set', [])).toBeNull();
  });
});

// ── resolveEnterAction — the binding precedence table ────────────────────────

describe('resolveEnterAction — precedence (R-5/R-6, clarifications #1/#2)', () => {
  const base = {
    query: 'set',
    entries: ENTRIES,
    textOrigin: 'typed' as const,
    companionActive: true,
    companionBusy: false,
  };

  it('1. empty query → none/empty (trimmed; independent of every other input)', () => {
    expect(resolveEnterAction({ ...base, query: '' })).toEqual({ kind: 'none', reason: 'empty' });
    expect(resolveEnterAction({ ...base, query: '   ' })).toEqual({ kind: 'none', reason: 'empty' });
    expect(
      resolveEnterAction({ ...base, query: '', textOrigin: 'dictated', companionActive: false }),
    ).toEqual({ kind: 'none', reason: 'empty' });
  });

  it('2. dictated BEATS launch — a dictated `Settings` is a send, never a launch', () => {
    const action = resolveEnterAction({ ...base, query: 'Settings', textOrigin: 'dictated' });
    expect(action).toEqual({ kind: 'send', textOrigin: 'dictated' });
    // The exact-full-name case is the dangerous one (it used to launch).
    expect(resolveEnterAction({ ...base, query: 'set', textOrigin: 'dictated' }).kind).toBe('send');
  });

  it('2. dictated with no active companion → none (R-4.4: text stays, nothing launches)', () => {
    expect(
      resolveEnterAction({
        ...base,
        query: 'Settings',
        textOrigin: 'dictated',
        companionActive: false,
      }),
    ).toEqual({ kind: 'none', reason: 'no-match-no-companion' });
  });

  it('2. dictated while busy → none/busy (never a second generation)', () => {
    expect(
      resolveEnterAction({
        ...base,
        query: 'Settings',
        textOrigin: 'dictated',
        companionBusy: true,
      }),
    ).toEqual({ kind: 'none', reason: 'busy' });
  });

  it('3. typed + app match → launch, INDEPENDENT of the companion state (AC5)', () => {
    for (const companionActive of [true, false]) {
      for (const companionBusy of [true, false]) {
        expect(
          resolveEnterAction({
            ...base,
            query: 'set',
            companionActive,
            companionBusy,
          }),
        ).toEqual({ kind: 'launch', feature: SETTINGS });
      }
    }
  });

  it('3. typed match while companionBusy ⇒ launch (the old busy no-op is retired)', () => {
    expect(
      resolveEnterAction({ ...base, query: 'monitor', companionBusy: true, companionActive: true }),
    ).toEqual({ kind: 'launch', feature: MISSION_MONITOR });
  });

  it('3. typed match launches the TOP-RANKED entry (clarification #1)', () => {
    const twoMatches: readonly FredoFeatureClass[] = [
      entry('settings-app', 'Settings'),
      entry('status', 'Status'),
    ];
    expect(resolveEnterAction({ ...base, query: 's', entries: twoMatches })).toEqual({
      kind: 'launch',
      feature: twoMatches[0],
    });
  });

  it('4. typed, no match, active && !busy → send (origin typed)', () => {
    expect(resolveEnterAction({ ...base, query: 'Missing all the time' })).toEqual({
      kind: 'send',
      textOrigin: 'typed',
    });
    expect(resolveEnterAction({ ...base, query: 'MM' })).toEqual({
      kind: 'send',
      textOrigin: 'typed',
    });
  });

  it('4b. R-6.2 — `Missing all the time` sends, never launches', () => {
    const action = resolveEnterAction({ ...base, query: 'Missing all the time' });
    expect(action.kind).toBe('send');
  });

  it('5. typed, no match, no active companion → none/no-match-no-companion (R-6.1)', () => {
    expect(
      resolveEnterAction({ ...base, query: 'Missing all the time', companionActive: false }),
    ).toEqual({ kind: 'none', reason: 'no-match-no-companion' });
    // The substring-filtered tile (`ission` ⇢ Mission Monitor) must never open.
    expect(resolveEnterAction({ ...base, query: 'ission', companionActive: false })).toEqual({
      kind: 'none',
      reason: 'no-match-no-companion',
    });
  });

  it('5. typed, no match, busy → none/busy', () => {
    expect(
      resolveEnterAction({ ...base, query: 'Missing all the time', companionBusy: true }),
    ).toEqual({ kind: 'none', reason: 'busy' });
    expect(
      resolveEnterAction({
        ...base,
        query: 'Missing all the time',
        companionBusy: true,
        companionActive: false,
      }),
    ).toEqual({ kind: 'none', reason: 'busy' });
  });

  it('settles the bar states against the wrong old rule (exact full-name only)', () => {
    // `mission` used to miss (no exact name) and launch the filtered tile / send.
    expect(resolveEnterAction({ ...base, query: 'mission' }).kind).toBe('launch');
    // `Miss` used to miss as well.
    expect(resolveEnterAction({ ...base, query: 'Miss' }).kind).toBe('launch');
  });
});

// ── enterHintLabel — the truthful hint (R-4.5/R-6.3) ─────────────────────────

describe('enterHintLabel — derived from the SAME verdict Enter acts on (R-6.3)', () => {
  const notBusy = { busy: false, queryEmpty: false };
  const busy = { busy: true, queryEmpty: false };
  const empty = { busy: false, queryEmpty: true };

  it('launch → `↵ open <name>`', () => {
    expect(enterHintLabel({ kind: 'launch', feature: SETTINGS }, notBusy)).toBe('↵ open Settings');
    expect(enterHintLabel({ kind: 'launch', feature: MISSION_MONITOR }, notBusy)).toBe(
      '↵ open Mission Monitor',
    );
  });

  it('typed send → `↵ send to Fredo`; dictated send → `↵ send transcript to Fredo`', () => {
    expect(enterHintLabel({ kind: 'send', textOrigin: 'typed' }, notBusy)).toBe('↵ send to Fredo');
    expect(enterHintLabel({ kind: 'send', textOrigin: 'dictated' }, notBusy)).toBe(
      '↵ send transcript to Fredo',
    );
  });

  it('none/busy → `Fredo is replying…`; none/no companion → `no match`', () => {
    expect(enterHintLabel({ kind: 'none', reason: 'busy' }, notBusy)).toBe('Fredo is replying…');
    expect(enterHintLabel({ kind: 'none', reason: 'busy' }, busy)).toBe('Fredo is replying…');
    expect(enterHintLabel({ kind: 'none', reason: 'no-match-no-companion' }, notBusy)).toBe(
      'no match',
    );
  });

  it('empty query (either signal) → no chip', () => {
    expect(enterHintLabel({ kind: 'none', reason: 'empty' }, notBusy)).toBeUndefined();
    expect(enterHintLabel({ kind: 'none', reason: 'empty' }, empty)).toBeUndefined();
    expect(enterHintLabel({ kind: 'launch', feature: SETTINGS }, empty)).toBeUndefined();
    expect(enterHintLabel({ kind: 'send', textOrigin: 'typed' }, empty)).toBeUndefined();
  });

  it('`busy` must NOT lie about a launch: a typed match still reads `↵ open <name>`', () => {
    // AC5 — a typed app match launches while Fredo is replying, so the chip
    // must name the app (a `Fredo is replying…` chip here would be the lie
    // R-6.3 exists to remove).
    expect(enterHintLabel({ kind: 'launch', feature: SETTINGS }, busy)).toBe('↵ open Settings');
  });

  it('every action × opts combination resolves to the binding copy', () => {
    const actions: LauncherEnterAction[] = [
      { kind: 'launch', feature: SETTINGS },
      { kind: 'send', textOrigin: 'typed' },
      { kind: 'send', textOrigin: 'dictated' },
      { kind: 'none', reason: 'empty' },
      { kind: 'none', reason: 'busy' },
      { kind: 'none', reason: 'no-match-no-companion' },
      // ST-5-fix (QA-10) — the live launcher-origin capture row.
      { kind: 'none', reason: 'listening' },
    ];
    const expected: Record<string, string | undefined> = {
      'launch|false|false': '↵ open Settings',
      'launch|true|false': '↵ open Settings',
      'launch|false|true': undefined,
      'launch|true|true': undefined,
      'send:typed|false|false': ENTER_HINT_COPY.send,
      'send:typed|true|false': ENTER_HINT_COPY.send,
      'send:typed|false|true': undefined,
      'send:typed|true|true': undefined,
      'send:dictated|false|false': ENTER_HINT_COPY.sendTranscript,
      'send:dictated|true|false': ENTER_HINT_COPY.sendTranscript,
      'send:dictated|false|true': undefined,
      'send:dictated|true|true': undefined,
      'none:empty|false|false': undefined,
      'none:empty|true|false': undefined,
      'none:busy|false|false': ENTER_HINT_COPY.busy,
      'none:busy|true|false': ENTER_HINT_COPY.busy,
      // This pair is unreachable from `resolveEnterAction` (busy always yields
      // reason 'busy'), but the function is total: a caller that reports busy
      // gets the busy copy.
      'none:no-match-no-companion|true|false': ENTER_HINT_COPY.busy,
      'none:no-match-no-companion|false|false': ENTER_HINT_COPY.noMatch,
      // ST-5-fix (QA-10) — the live-capture row is the ONE no-op whose instruction
      // survives an EMPTY bar (a hold starts on an empty bar)…
      'none:listening|false|false': ENTER_HINT_COPY.releaseToFinish,
      'none:listening|false|true': ENTER_HINT_COPY.releaseToFinish,
      // …and `busy` (UI/UX §3 row 1) outranks it (row 2).
      'none:listening|true|false': ENTER_HINT_COPY.busy,
      'none:listening|true|true': ENTER_HINT_COPY.busy,
    };

    for (const action of actions) {
      const key =
        action.kind === 'launch'
          ? `launch`
          : action.kind === 'send'
            ? `send:${action.textOrigin}`
            : `none:${action.reason}`;
      for (const busyValue of [false, true]) {
        for (const queryEmpty of [false, true]) {
          expect(
            enterHintLabel(action, { busy: busyValue, queryEmpty }),
            `${key} busy=${busyValue} empty=${queryEmpty}`,
          ).toBe(expected[`${key}|${busyValue}|${queryEmpty}`]);
        }
      }
    }
  });

  it('R-6.3 — the hint and the verdict agree for every bar state', () => {
    const states: Array<{
      name: string;
      input: Parameters<typeof resolveEnterAction>[0];
      hint: string | undefined;
    }> = [
      {
        name: 'empty query',
        input: {
          query: '',
          entries: ENTRIES,
          textOrigin: 'typed',
          companionActive: true,
          companionBusy: false,
        },
        hint: undefined,
      },
      {
        name: 'typed `set` (app match)',
        input: {
          query: 'set',
          entries: ENTRIES,
          textOrigin: 'typed',
          companionActive: true,
          companionBusy: false,
        },
        hint: '↵ open Settings',
      },
      {
        name: 'typed `set` while busy',
        input: {
          query: 'set',
          entries: ENTRIES,
          textOrigin: 'typed',
          companionActive: true,
          companionBusy: true,
        },
        hint: '↵ open Settings',
      },
      {
        name: 'typed `Missing all the time` + companion',
        input: {
          query: 'Missing all the time',
          entries: ENTRIES,
          textOrigin: 'typed',
          companionActive: true,
          companionBusy: false,
        },
        hint: '↵ send to Fredo',
      },
      {
        name: 'typed `MM` without companion → the chip must not promise a send',
        input: {
          query: 'MM',
          entries: ENTRIES,
          textOrigin: 'typed',
          companionActive: false,
          companionBusy: false,
        },
        hint: 'no match',
      },
      {
        name: 'dictated transcript in the bar',
        input: {
          query: 'set',
          entries: ENTRIES,
          textOrigin: 'dictated',
          companionActive: true,
          companionBusy: false,
        },
        hint: '↵ send transcript to Fredo',
      },
      {
        name: 'dictated transcript, edited to an app name',
        input: {
          query: 'Settings',
          entries: ENTRIES,
          textOrigin: 'dictated',
          companionActive: true,
          companionBusy: false,
        },
        hint: '↵ send transcript to Fredo',
      },
      {
        name: 'dictated transcript while busy',
        input: {
          query: 'set',
          entries: ENTRIES,
          textOrigin: 'dictated',
          companionActive: true,
          companionBusy: true,
        },
        hint: 'Fredo is replying…',
      },
      // ── ST-5-fix (QA-10) — the live launcher-origin capture rows ────────────
      {
        name: 'live launcher-origin capture on an EMPTY bar (the normal live state)',
        input: {
          query: '',
          entries: ENTRIES,
          textOrigin: 'typed',
          companionActive: true,
          companionBusy: false,
          captureLive: true,
        },
        hint: 'release Space to finish',
      },
      {
        name: 'live capture naming an app — still a no-op, never a promise to launch',
        input: {
          query: 'set',
          entries: ENTRIES,
          textOrigin: 'typed',
          companionActive: true,
          companionBusy: false,
          captureLive: true,
        },
        hint: 'release Space to finish',
      },
      {
        name: 'live capture while busy — `busy` (row 1) outranks the capture (row 2)',
        input: {
          query: '',
          entries: ENTRIES,
          textOrigin: 'typed',
          companionActive: true,
          companionBusy: true,
          captureLive: true,
        },
        hint: 'Fredo is replying…',
      },
    ];

    for (const state of states) {
      const action = resolveEnterAction(state.input);
      const label = enterHintLabel(action, {
        busy: state.input.companionBusy,
        queryEmpty: state.input.query.trim() === '',
      });
      expect(label, state.name).toBe(state.hint);
    }
  });
});

// ── ST-5-fix (QA-10) — the live launcher-origin capture is a no-op row ────────

describe('resolveEnterAction / enterHintLabel — the live launcher-origin capture (QA-10, ST-5-fix)', () => {
  const base = {
    query: 'set',
    entries: ENTRIES,
    textOrigin: 'typed' as const,
    companionActive: true,
    companionBusy: false,
  };

  it('pins the EXACT chip copy the tester asserts (char-for-char)', () => {
    expect(ENTER_HINT_COPY.releaseToFinish).toBe('release Space to finish');
  });

  it('captureLive ⇒ none/listening in EVERY bar state (Enter acts as nothing)', () => {
    const states: Array<Partial<Parameters<typeof resolveEnterAction>[0]>> = [
      { query: '' }, // the normal live state (a hold starts on an empty bar)
      { query: 'set' }, // a typed app match would otherwise launch
      { query: 'Settings' },
      { query: 'Missing all the time' }, // a typed non-match would otherwise send
      { query: 'set', textOrigin: 'dictated' }, // dictated content would otherwise send
      { query: 'set', companionActive: false },
      { query: 'set', companionBusy: true },
      { query: 'set', textOrigin: 'dictated', companionBusy: true },
    ];
    for (const state of states) {
      expect(
        resolveEnterAction({ ...base, ...state, captureLive: true }),
        JSON.stringify(state),
      ).toEqual({ kind: 'none', reason: 'listening' });
    }
  });

  it('captureLive outranks the app-open rule (a partially transcribed live text never launches)', () => {
    // Without the capture input this very input launches Settings.
    expect(resolveEnterAction({ ...base, query: 'set' }).kind).toBe('launch');
    expect(resolveEnterAction({ ...base, query: 'set', captureLive: true })).toEqual({
      kind: 'none',
      reason: 'listening',
    });
  });

  it('omitting captureLive (or passing false) preserves every pre-existing verdict', () => {
    const queries = ['', '   ', 'set', 'Missing all the time', 'MM'];
    for (const query of queries) {
      for (const textOrigin of ['typed', 'dictated'] as const) {
        for (const companionActive of [true, false]) {
          for (const companionBusy of [true, false]) {
            const input = { ...base, query, textOrigin, companionActive, companionBusy };
            expect(resolveEnterAction({ ...input, captureLive: false }), query).toEqual(
              resolveEnterAction(input),
            );
          }
        }
      }
    }
  });

  it('the hint reads `release Space to finish` even on an EMPTY bar (the instruction survives row 7)', () => {
    expect(enterHintLabel({ kind: 'none', reason: 'listening' }, { busy: false, queryEmpty: true })).toBe(
      'release Space to finish',
    );
    expect(
      enterHintLabel({ kind: 'none', reason: 'listening' }, { busy: false, queryEmpty: false }),
    ).toBe('release Space to finish');
  });

  it('PRECEDENCE: `busy` (UI/UX §3 row 1) outranks the live capture (row 2)', () => {
    expect(enterHintLabel({ kind: 'none', reason: 'listening' }, { busy: true, queryEmpty: false })).toBe(
      'Fredo is replying…',
    );
    // …including on the empty bar, where row 1 must still win over row 2.
    expect(enterHintLabel({ kind: 'none', reason: 'listening' }, { busy: true, queryEmpty: true })).toBe(
      'Fredo is replying…',
    );
  });

  it('the (hint, action) pair agrees: while listening both name the SAME no-op', () => {
    const verdict = resolveEnterAction({ ...base, query: 'set', captureLive: true });
    const hint = enterHintLabel(verdict, { busy: false, queryEmpty: false });
    expect(verdict).toEqual({ kind: 'none', reason: 'listening' });
    expect(hint).toBe('release Space to finish');
  });
});
