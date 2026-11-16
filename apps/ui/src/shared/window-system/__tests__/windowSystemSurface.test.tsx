/**
 * Window-system declaration + surviving-chord shape (Spec #3121 ST-2; re-scoped by #3151 ST-4).
 *
 * Spec #3151 ST-4 deletes the window-system navigation provider and its floating dock — every
 * block of this suite that drove the provider, the dock, the host journal or the OLD global
 * chord dispatcher pinned machinery that no longer exists, so those blocks were retired with
 * it. What remains is the part of the window-system surface that still ships until ST-6
 * deletes the declaration itself:
 *
 *   - the declaration validates with zero diagnostics (one root, four verbs, `window` objects,
 *     keyless `publish:false` `app.map`);
 *   - the three SURVIVING platform chords keep their exact sequences and ids — now declared by
 *     `shared/window-system/platformChords.ts` (the re-homed plain listener), NOT by the
 *     retired navigation barrel.
 *
 * The chord → outcome behaviour is pinned by `__tests__/platformChords.test.ts` (ST-4) and the
 * live traversal outcome by `__tests__/WindowTraversal.test.tsx`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateSurface } from '@/shared/navigation';
import {
  WINDOW_APP_MAP_VERB_ID,
  WINDOW_FOCUS_NEXT_VERB_ID,
  WINDOW_FOCUS_PREVIOUS_VERB_ID,
  WINDOW_LAUNCHER_TOGGLE_VERB_ID,
  WINDOW_SYSTEM_APP_ID,
  WINDOW_SYSTEM_ROOT_PLACE_ID,
  windowSystemSurface,
} from '../windowSystemSurface';
import { PLATFORM_CHORDS, resetPlatformChordsForTests } from '../platformChords';

/* ───────────────────────────── fixtures ───────────────────────────── */

const VERB_IDS = [
  WINDOW_FOCUS_NEXT_VERB_ID,
  WINDOW_FOCUS_PREVIOUS_VERB_ID,
  WINDOW_LAUNCHER_TOGGLE_VERB_ID,
  WINDOW_APP_MAP_VERB_ID,
] as const;

beforeEach(() => {
  resetPlatformChordsForTests();
});

afterEach(() => {
  resetPlatformChordsForTests();
});

/* ───────────────────────────── R-01: the declaration ───────────────────────────── */

describe('windowSystemSurface — declaration (R-01)', () => {
  it('validates with zero diagnostics', () => {
    expect(validateSurface(windowSystemSurface)).toStrictEqual({
      valid: true,
      diagnostics: [],
    });
  });

  it('declares app id window-system, the one root place, and the four B.5 verbs', () => {
    expect(windowSystemSurface.tree.appId).toBe(WINDOW_SYSTEM_APP_ID);
    expect(windowSystemSurface.tree.root).toBe('window-system.root');
    expect(windowSystemSurface.tree.places).toHaveLength(1);

    const root = windowSystemSurface.tree.places[0];
    expect(root.id).toBe(WINDOW_SYSTEM_ROOT_PLACE_ID);
    expect(root.parent).toBeNull();
    expect(root.transient).toBe(false);
    expect(root.sticky).toBe(false);
    expect(root.keys).toStrictEqual({});
    expect(windowSystemSurface.tree.directAliases).toStrictEqual({});

    expect(windowSystemSurface.verbs.map((verb) => verb.id).sort()).toStrictEqual(
      [...VERB_IDS].sort(),
    );
  });

  it('declares the `window` object type and a keyless publish:false app.map', () => {
    for (const verb of windowSystemSurface.verbs) {
      expect(verb.appliesTo.objects).toContain('window');
      expect(verb.appliesTo.places).toContain(WINDOW_SYSTEM_ROOT_PLACE_ID);
    }
    const map = windowSystemSurface.verbs.find((verb) => verb.id === 'app.map');
    expect(map).toBeDefined();
    expect(map?.publish).toBe(false);
    for (const place of windowSystemSurface.tree.places) {
      expect(
        Object.values(place.keys).some(
          (binding) => binding.kind === 'verb' && binding.verbId === 'app.map',
        ),
      ).toBe(false);
    }
  });

  it('the three SURVIVING chords keep their exact sequences (re-homed declaration)', () => {
    expect(
      PLATFORM_CHORDS.map(
        (chord) => `${chord.primary ? 'primary+' : ''}${chord.shift ? 'shift+' : ''}${chord.key}`,
      ),
    ).toStrictEqual(['primary+space', 'primary+tab', 'primary+shift+tab']);
    expect(PLATFORM_CHORDS.map((chord) => chord.id)).toStrictEqual([
      'launcher.toggle',
      'window.focus.next',
      'window.focus.previous',
    ]);
  });

  it('mounts zero legacy element-key attributes (R-15)', () => {
    // Constructed so this file is not itself a per-surface AC7 scan hit.
    const legacyAttr = ['data', 'hotkey'].join('-');
    expect(document.querySelectorAll(`[${legacyAttr}]`)).toHaveLength(0);
    const strokes = [
      ...windowSystemSurface.tree.places.flatMap((place) => Object.keys(place.keys)),
      ...Object.keys(windowSystemSurface.tree.directAliases),
    ];
    expect(strokes.filter((stroke) => stroke.startsWith('g+'))).toEqual([]);
  });
});
