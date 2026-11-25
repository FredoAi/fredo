import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FREDO_STATUS,
  FREDO_REPLY_STATUSES,
  resolveReplyStatus,
} from '../fredoReplyStatus';
import { FREDO_AVATAR_STATES, isFredoAvatarState } from '../../fredo-avatar/fredoAvatarStates';

/**
 * #2918 ST-4 (R-8, R-2) / #3224 (the widened emittable set) — the closed
 * reply-status vocabulary + lenient resolver.
 *
 * Product-unit pins for the ONE boundary between the model's structured `status`
 * and the frozen 23-member avatar vocabulary:
 *
 *   - the emittable set is the closed **18** (the shipped 7 plus the 11 emotions),
 *     in the order of the ONE shared contract fixture `fredo_status_contract.json`
 *     — the same file the Rust reader (`status.rs` `FREDO_STATUS_VALUES`) pins, so
 *     the contract has exactly two readers and no duplicated copy;
 *   - every member — the 11 emotions included — resolves to ITSELF (no alias may
 *     shadow a member: `funny` is `funny`, never `joking`);
 *   - the converged alias table maps with trim/case-folding;
 *   - everything else (flow/motion-owned names, non-members, non-strings, absent)
 *     heals to the default `happy`;
 *   - the result is ALWAYS a `FREDO_AVATAR_STATES` member — a non-member can never
 *     be returned (R-8 boundary drop).
 *
 * Files are read with `readFileSync(resolve(process.cwd(), ...))` — vitest runs
 * with cwd = `apps/ui`, the established convention in this workspace.
 *
 * Pure + synchronous — no render, no timers.
 */

/** The model-FORBIDDEN states: frozen-union members that the model must never select. */
const MODEL_FORBIDDEN = ['talk', 'teleport-out', 'teleport-in', 'error', 'greeting'] as const;

/** The retired `funny -> joking` alias's surviving siblings (all still non-members). */
const REPLY_STATUS_ALIASES = ['success', 'reasoning', 'busy', 'focused', 'neutral', 'calm'] as const;

const repoPath = (...segments: string[]): string => resolve(process.cwd(), ...segments);

/** cwd-tolerant lookup: `apps/ui` when filtered, the repo root otherwise. */
function firstExisting(candidates: string[], label: string): string {
  const hit = candidates.find((candidate) => existsSync(candidate));
  if (!hit) throw new Error(`${label} not found (cwd=${process.cwd()})`);
  return hit;
}

/**
 * The ONE shared contract fixture — read here (the frontend reader) and by
 * `status.rs`'s `include_str!` test (the Rust reader). One file, two readers.
 */
const CONTRACT_FIXTURE = firstExisting(
  [
    repoPath('../tauri/src-tauri/src/applications/llm_server/fredo_status_contract.json'),
    repoPath('apps/tauri/src-tauri/src/applications/llm_server/fredo_status_contract.json'),
  ],
  'fredo_status_contract.json',
);

/** The Rust reader's own module — its array is pinned to the same fixture. */
const STATUS_RS = firstExisting(
  [
    repoPath('../tauri/src-tauri/src/applications/llm_server/status.rs'),
    repoPath('apps/tauri/src-tauri/src/applications/llm_server/status.rs'),
  ],
  'applications/llm_server/status.rs',
);

interface StatusContract {
  values: string[];
  default: string;
}

const readStatusContract = (): StatusContract =>
  JSON.parse(readFileSync(CONTRACT_FIXTURE, 'utf8')) as StatusContract;

/**
 * Extract the `FREDO_STATUS_VALUES` literal from the Rust reader. The backend's
 * own test pins that array to the same fixture; reading it here makes the parity
 * a THREE-way equality (frontend ⇄ fixture ⇄ Rust) asserted from one place.
 */
function readRustStatusValues(source: string): string[] {
  const anchor = source.indexOf('pub const FREDO_STATUS_VALUES');
  if (anchor < 0) throw new Error('status.rs no longer declares FREDO_STATUS_VALUES');
  const assign = source.indexOf('= [', anchor);
  if (assign < 0) throw new Error('the FREDO_STATUS_VALUES array literal was not found');
  const open = assign + 2;
  const close = source.indexOf('];', open);
  if (close < 0) throw new Error('the FREDO_STATUS_VALUES array literal is unterminated');
  return [...source.slice(open, close).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

const contract = readStatusContract();

describe('#2918 ST-4 — the closed reply-status vocabulary (R-8)', () => {
  it('exports exactly the 18 model-emittable statuses, in the fixture order', () => {
    expect([...FREDO_REPLY_STATUSES]).toEqual([
      'happy',
      'playful',
      'joking',
      'thinking',
      'working',
      'listening',
      'idle',
      'uwu',
      'love',
      'sad',
      'surprised',
      'sleepy',
      'skeptical',
      'confused',
      'silly',
      'squint',
      'angry',
      'funny',
    ]);
    expect(new Set(FREDO_REPLY_STATUSES).size).toBe(FREDO_REPLY_STATUSES.length);
  });

  it('defaults to `happy` and the default is itself emittable', () => {
    expect(DEFAULT_FREDO_STATUS).toBe('happy');
    expect([...FREDO_REPLY_STATUSES]).toContain(DEFAULT_FREDO_STATUS);
  });

  it('every emittable status is a member of the frozen 23 (no new states)', () => {
    for (const status of FREDO_REPLY_STATUSES) {
      expect(isFredoAvatarState(status)).toBe(true);
      expect([...FREDO_AVATAR_STATES]).toContain(status);
    }
  });

  it('never lists a model-forbidden frozen state', () => {
    for (const forbidden of MODEL_FORBIDDEN) {
      expect([...FREDO_REPLY_STATUSES]).not.toContain(forbidden);
    }
  });
});

describe('#3224 — ONE shared contract fixture, two readers (F-AV-34 leg A)', () => {
  it('reads the shared contract fixture the Rust reader pins', () => {
    expect(existsSync(CONTRACT_FIXTURE)).toBe(true);
    expect(contract.values).toHaveLength(18);
    expect(contract.default).toBe('happy');
  });

  it('order-equals the fixture, and the Rust array order-equals it too (three-way)', () => {
    expect([...FREDO_REPLY_STATUSES]).toEqual(contract.values);
    expect(readRustStatusValues(readFileSync(STATUS_RS, 'utf8'))).toEqual(contract.values);
  });

  it('shares the fixture default with the resolver default', () => {
    expect(contract.default).toBe(DEFAULT_FREDO_STATUS);
  });

  it('admits nothing outside the 23-member avatar vocabulary (non-vacuity)', () => {
    for (const value of contract.values) {
      expect(isFredoAvatarState(value)).toBe(true);
      expect([...FREDO_AVATAR_STATES]).toContain(value);
    }
  });
});

describe('#2918 ST-4 — resolveReplyStatus passes the emittable set through (R-2)', () => {
  it('maps every one of the 18 to itself — no alias can shadow a member', () => {
    for (const status of FREDO_REPLY_STATUSES) {
      expect(resolveReplyStatus(status), `${status} must resolve to itself`).toBe(status);
    }
  });

  it('accepts every member case-insensitively and through surrounding whitespace', () => {
    for (const status of FREDO_REPLY_STATUSES) {
      expect(resolveReplyStatus(status.toUpperCase())).toBe(status);
      expect(resolveReplyStatus(`  ${status}  `)).toBe(status);
      expect(resolveReplyStatus(`\t${status.toUpperCase()}\n`)).toBe(status);
    }
  });
});

describe('#2918 ST-4 — the converged alias table (R-8 lenient healing)', () => {
  it('maps success -> happy', () => {
    expect(resolveReplyStatus('success')).toBe('happy');
    expect(resolveReplyStatus('  SUCCESS  ')).toBe('happy');
  });

  it('passes funny through as a first-class emotion (#3224 retired the alias)', () => {
    expect(resolveReplyStatus('funny')).toBe('funny');
    expect(resolveReplyStatus('FUNNY')).toBe('funny');
    expect(resolveReplyStatus('  Funny  ')).toBe('funny');
  });

  it('maps reasoning -> thinking', () => {
    expect(resolveReplyStatus('reasoning')).toBe('thinking');
    expect(resolveReplyStatus(' REASONING ')).toBe('thinking');
  });

  it('maps busy/focused -> working', () => {
    expect(resolveReplyStatus('busy')).toBe('working');
    expect(resolveReplyStatus('BUSY')).toBe('working');
    expect(resolveReplyStatus('focused')).toBe('working');
    expect(resolveReplyStatus('\tFocused\n')).toBe('working');
  });

  it('maps neutral/calm -> idle', () => {
    expect(resolveReplyStatus('neutral')).toBe('idle');
    expect(resolveReplyStatus('Neutral')).toBe('idle');
    expect(resolveReplyStatus('calm')).toBe('idle');
    expect(resolveReplyStatus(' CALM ')).toBe('idle');
  });

  it('keeps every alias key OUTSIDE the member set (a member may never be aliased)', () => {
    for (const alias of REPLY_STATUS_ALIASES) {
      expect([...FREDO_REPLY_STATUSES]).not.toContain(alias);
    }
    // The retired alias key, pinned by name (F-130 bans `funny -> joking`).
    expect([...FREDO_REPLY_STATUSES]).toContain('funny');
    expect(REPLY_STATUS_ALIASES).not.toContain('funny');
  });

  it('every alias resolves to an emittable member of the frozen 23', () => {
    for (const alias of REPLY_STATUS_ALIASES) {
      const resolved = resolveReplyStatus(alias);
      expect([...FREDO_REPLY_STATUSES]).toContain(resolved);
      expect(isFredoAvatarState(resolved)).toBe(true);
    }
  });
});

describe('#2918 ST-4 — boundary drop + lenient healing to the default (R-8)', () => {
  it('drops the model-forbidden flow/motion/error states to `happy`', () => {
    expect(resolveReplyStatus('talk')).toBe('happy');
    expect(resolveReplyStatus('teleport-out')).toBe('happy');
    expect(resolveReplyStatus('teleport-in')).toBe('happy');
    expect(resolveReplyStatus('error')).toBe('happy');
    expect(resolveReplyStatus('greeting')).toBe('happy');
  });

  it('heals absent / non-string values to `happy`', () => {
    expect(resolveReplyStatus(undefined)).toBe('happy');
    expect(resolveReplyStatus(null)).toBe('happy');
    expect(resolveReplyStatus(123)).toBe('happy');
    expect(resolveReplyStatus(0)).toBe('happy');
    expect(resolveReplyStatus(true)).toBe('happy');
    expect(resolveReplyStatus(false)).toBe('happy');
    expect(resolveReplyStatus(NaN)).toBe('happy');
    expect(resolveReplyStatus({})).toBe('happy');
    expect(resolveReplyStatus([])).toBe('happy');
    expect(resolveReplyStatus(['happy'])).toBe('happy');
    expect(resolveReplyStatus(() => 'happy')).toBe('happy');
    expect(resolveReplyStatus(Symbol('happy'))).toBe('happy');
  });

  it('heals empty / whitespace-only / unknown strings to `happy`', () => {
    expect(resolveReplyStatus('')).toBe('happy');
    expect(resolveReplyStatus('   ')).toBe('happy');
    expect(resolveReplyStatus('\t\n')).toBe('happy');
    expect(resolveReplyStatus('dancing')).toBe('happy');
    expect(resolveReplyStatus('happyish')).toBe('happy');
    expect(resolveReplyStatus('talk ')).toBe('happy');
    expect(resolveReplyStatus(' status ')).toBe('happy');
  });

  it('never treats a substring as a member (exact match only)', () => {
    expect(resolveReplyStatus('hap')).toBe('happy');
    expect(resolveReplyStatus('id')).toBe('happy');
    expect(resolveReplyStatus('work')).toBe('happy');
  });
});

describe('#2918 ST-4 — the result is ALWAYS a frozen-union member (R-8 hard invariant)', () => {
  // `...FREDO_REPLY_STATUSES` is the pass-through set (all 18, `funny` included —
  // a member, so it resolves to itself); the junk below is the heal set.
  const adversarial: unknown[] = [
    ...FREDO_REPLY_STATUSES,
    ...MODEL_FORBIDDEN,
    ...REPLY_STATUS_ALIASES,
    'dancing',
    'waiting',
    'status',
    '',
    '   ',
    null,
    undefined,
    0,
    1,
    -1,
    123,
    true,
    false,
    NaN,
    Infinity,
    {},
    { status: 'happy' },
    [],
    ['happy'],
    Symbol('happy'),
  ];

  it('every adversarial input resolves to a member of FREDO_AVATAR_STATES', () => {
    for (const raw of adversarial) {
      const resolved = resolveReplyStatus(raw);
      expect(isFredoAvatarState(resolved)).toBe(true);
      expect([...FREDO_AVATAR_STATES]).toContain(resolved);
    }
  });

  it('never returns the model-forbidden lifecycle states', () => {
    for (const raw of adversarial) {
      expect([...MODEL_FORBIDDEN]).not.toContain(resolveReplyStatus(raw));
    }
  });

  it('resolves every member to itself inside the matrix (nothing heals by accident)', () => {
    for (const status of FREDO_REPLY_STATUSES) {
      expect(adversarial).toContain(status);
      expect(resolveReplyStatus(status)).toBe(status);
    }
  });
});
