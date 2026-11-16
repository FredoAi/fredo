/**
 * Spec #3120 (rework) ST-2 — pure companion target resolution.
 *
 * Work bullet (a): the default-target order (requested → topmost frame at the
 * landing point → window app → focused app → null) and the named-app override
 * (whole-word, case-insensitive, longest match over name+id; ambiguous = null).
 */

import { describe, expect, it } from 'vitest';

import {
  resolveCompanionTargetApp,
  resolveNamedAppMention,
} from '../composerTarget';
import type { CompanionTargetFrame, FredoAppRef } from '../composerTarget';
import type { ReplyRect } from '../../components/companion/replySurfaceLayout';

function rect(left: number, top: number, width: number, height: number): ReplyRect {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

const APPS: FredoAppRef[] = [
  { id: 'wireframe', name: 'Wireframe', showable: true },
  { id: 'mission-monitor', name: 'Mission Monitor', showable: true },
  { id: 'query-viewer', name: 'Query Viewer', showable: true },
  { id: 'hidden-lab', name: 'Hidden Lab', showable: false },
  { id: 'mission', name: 'Mission', showable: true },
];

describe('resolveCompanionTargetApp — BINDING order', () => {
  const frames: CompanionTargetFrame[] = [
    { appId: 'lower', rect: rect(0, 0, 500, 400) },
    { appId: 'upper', rect: rect(100, 50, 600, 500) },
  ];

  it('requestedAppId wins over the point, the window and the focused app', () => {
    expect(
      resolveCompanionTargetApp({
        requestedAppId: 'requested-app',
        windowAppId: 'window-app',
        frames,
        point: { x: 150, y: 100 },
        focusedAppId: 'focused-app',
      }),
    ).toBe('requested-app');
  });

  it('picks the TOPMOST frame containing the landing point (frames arrive low z → high z)', () => {
    // (150,100) is inside both frames; the LAST frame is the topmost.
    expect(
      resolveCompanionTargetApp({
        frames,
        point: { x: 150, y: 100 },
        windowAppId: 'window-app',
        focusedAppId: 'focused-app',
      }),
    ).toBe('upper');
  });

  it('falls through to the window app when the point is outside every frame', () => {
    expect(
      resolveCompanionTargetApp({
        frames,
        point: { x: 900, y: 900 },
        windowAppId: 'window-app',
        focusedAppId: 'focused-app',
      }),
    ).toBe('window-app');
  });

  it('treats the bottom/right frame edges as outside (half-open containment)', () => {
    expect(
      resolveCompanionTargetApp({
        frames: [{ appId: 'only', rect: rect(10, 10, 100, 100) }],
        point: { x: 110, y: 60 },
        focusedAppId: 'focused-app',
      }),
    ).toBe('focused-app');
    expect(
      resolveCompanionTargetApp({
        frames: [{ appId: 'only', rect: rect(10, 10, 100, 100) }],
        point: { x: 60, y: 110 },
        focusedAppId: 'focused-app',
      }),
    ).toBe('focused-app');
  });

  it('falls through to the focused app and then null', () => {
    expect(
      resolveCompanionTargetApp({ frames: [], focusedAppId: 'focused-app' }),
    ).toBe('focused-app');
    expect(resolveCompanionTargetApp({})).toBeNull();
    expect(
      resolveCompanionTargetApp({
        requestedAppId: '   ',
        windowAppId: '',
        focusedAppId: null,
      }),
    ).toBeNull();
  });

  it('ignores a non-finite landing point instead of matching a frame', () => {
    expect(
      resolveCompanionTargetApp({
        frames,
        point: { x: Number.NaN, y: 100 },
        windowAppId: 'window-app',
      }),
    ).toBe('window-app');
  });
});

describe('resolveNamedAppMention — whole-word, case-insensitive, longest match', () => {
  it('matches a full app name case-insensitively', () => {
    expect(resolveNamedAppMention('Change the WIREFRAME style', APPS)).toBe('wireframe');
  });

  it('matches the app id with a dash boundary', () => {
    expect(resolveNamedAppMention('focus mission-monitor please', APPS)).toBe('mission-monitor');
  });

  it('prefers the LONGEST match over shared prefixes', () => {
    // "Mission Monitor" (15 chars) out-runs "Mission" (7).
    expect(resolveNamedAppMention('open Mission Monitor now', APPS)).toBe('mission-monitor');
  });

  it('returns null when two distinct apps tie at the longest match', () => {
    // "Wireframe" and "Query Viewer" both match at their full lengths (9 vs 12)
    // — the longest is Query Viewer, which is NOT a tie.
    expect(resolveNamedAppMention('Wireframe and Query Viewer', APPS)).toBe('query-viewer');
    // Equal-length distinct names → ambiguous.
    expect(
      resolveNamedAppMention('Mission Monitor and Wireframe', [
        { id: 'a', name: 'Mission Monitor', showable: true },
        { id: 'b', name: 'Mission Monitor', showable: true },
      ]),
    ).toBeNull();
  });

  it('returns null for 0 matches, a non-showable app and a partial mention', () => {
    expect(resolveNamedAppMention('change the palette', APPS)).toBeNull();
    expect(resolveNamedAppMention('open Hidden Lab', APPS)).toBeNull();
    // "Wire" is a prefix, not a whole word of "Wireframe".
    expect(resolveNamedAppMention('open the Wire app', APPS)).toBeNull();
  });

  it('returns null for empty/whitespace instructions', () => {
    expect(resolveNamedAppMention('', APPS)).toBeNull();
    expect(resolveNamedAppMention('   ', APPS)).toBeNull();
  });

  it('matches punctuation-adjacent mentions (whole-word boundaries, not regex state)', () => {
    expect(resolveNamedAppMention('switch (wireframe) to light', APPS)).toBe('wireframe');
    expect(resolveNamedAppMention('open Mission Monitor.', APPS)).toBe('mission-monitor');
  });
});
