/**
 * Spec #3120 (P6), ST-5 — `resolveLauncherRoute` precedence (plan §3.6, QA R-6.4).
 *
 *   0. captureLive first (the shipped none/listening verdict),
 *   1. `>` → palette,
 *   2. undo → `{kind:'undo', args}`,
 *   3. no-match-undo → clarify UNDO_NO_MATCH_COPY,
 *   4. ambiguous → clarify UNDO_AMBIGUOUS_COPY,
 *   5. otherwise → the shipped `resolveEnterAction`, unchanged.
 */

import { describe, expect, it } from 'vitest';

import type { FredoApplicationClass } from '@/shared/classes/FredoApplicationClass';
import {
  UNDO_AMBIGUOUS_COPY,
  UNDO_NO_MATCH_COPY,
} from '@/applications/home/components/launcher/launcherUndoQuery';
import {
  resolveLauncherRoute,
  type ResolveLauncherRouteInput,
} from '@/applications/home/components/launcher/launcherRoute';

const entry = (id: string, name: string): FredoApplicationClass =>
  ({ id, name }) as unknown as FredoApplicationClass;

const SETTINGS = entry('settings-app', 'Settings');

function input(overrides: Partial<ResolveLauncherRouteInput> = {}): ResolveLauncherRouteInput {
  return {
    query: '',
    entries: [SETTINGS],
    textOrigin: 'typed',
    companionActive: false,
    captureLive: false,
    paletteActive: false,
    ...overrides,
  };
}

describe('resolveLauncherRoute — precedence', () => {
  it('captureLive outranks every content rule (including a `>` query)', () => {
    expect(resolveLauncherRoute(input({ captureLive: true, query: '> delete' }))).toEqual({
      kind: 'enter',
      action: { kind: 'none', reason: 'listening' },
    });
    expect(
      resolveLauncherRoute(input({ captureLive: true, query: "undo the companion's last change" })),
    ).toEqual({ kind: 'enter', action: { kind: 'none', reason: 'listening' } });
  });

  it('a `>` prefix (even after whitespace) routes to the palette', () => {
    expect(resolveLauncherRoute(input({ query: '> delete' }))).toEqual({ kind: 'palette' });
    expect(resolveLauncherRoute(input({ query: '   >' }))).toEqual({ kind: 'palette' });
  });

  it('a matched undo phrase routes to undo with its args', () => {
    expect(resolveLauncherRoute(input({ query: "undo the companion's last change" }))).toEqual({
      kind: 'undo',
      args: { actor: 'companion', count: '1' },
    });
    expect(resolveLauncherRoute(input({ query: 'undo' }))).toEqual({
      kind: 'undo',
      args: { count: '1' },
    });
  });

  it('no-match-undo → clarify UNDO_NO_MATCH_COPY (never the companion)', () => {
    expect(resolveLauncherRoute(input({ query: 'undo the red one', companionActive: true }))).toEqual({
      kind: 'clarify',
      message: UNDO_NO_MATCH_COPY,
    });
  });

  it('ambiguous undo → clarify UNDO_AMBIGUOUS_COPY', () => {
    expect(resolveLauncherRoute(input({ query: 'undo that' }))).toEqual({
      kind: 'clarify',
      message: UNDO_AMBIGUOUS_COPY,
    });
    expect(resolveLauncherRoute(input({ query: 'undo it' }))).toEqual({
      kind: 'clarify',
      message: UNDO_AMBIGUOUS_COPY,
    });
  });

  it('falls through to the shipped Enter verdict for a plain query', () => {
    expect(resolveLauncherRoute(input({ query: 'set' }))).toEqual({
      kind: 'enter',
      action: { kind: 'launch', feature: SETTINGS },
    });
    expect(resolveLauncherRoute(input({ query: 'make it nicer', companionActive: true }))).toEqual({
      kind: 'enter',
      action: { kind: 'send', textOrigin: 'typed' },
    });
    expect(resolveLauncherRoute(input({ query: 'make it nicer' }))).toEqual({
      kind: 'enter',
      action: { kind: 'none', reason: 'no-match-no-companion' },
    });
    expect(
      resolveLauncherRoute(input({ query: 'set', textOrigin: 'dictated', companionActive: true })),
    ).toEqual({ kind: 'enter', action: { kind: 'send', textOrigin: 'dictated' } });
  });

  it('an empty query stays the shipped empty no-op', () => {
    expect(resolveLauncherRoute(input({ query: '   ' }))).toEqual({
      kind: 'enter',
      action: { kind: 'none', reason: 'empty' },
    });
  });
});
