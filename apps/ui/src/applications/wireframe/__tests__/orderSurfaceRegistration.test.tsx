/**
 * Wireframe's order surface is REGISTERED BY THE PRODUCT (Spec #3243, round 2, D1).
 *
 * ## Why this suite exists at all
 *
 * `shared/order/wireframeOrderSurface.ts` DEFINES the surface and returns a
 * disposer (`registerWireframeOrderSurface`). For a whole round it had **no
 * production caller** — only tests called it — so `listOrderSurfaceAppIds()` was
 * `[]` in the shipped product, every Wireframe order classified `unknown`, and
 * the gate refused it.
 *
 * The dispatch suite (`shared/order/__tests__/useOrderSkillDispatch.test.tsx`)
 * registered the surface in its OWN `beforeEach`, so it exercised the dispatcher
 * against a state no user could reach and stayed green over a broken product.
 * A suite that supplies the wiring cannot detect that the wiring is missing.
 *
 * **So this suite supplies NOTHING but the mount.** It never calls
 * `registerOrderSurface` or `registerWireframeOrderSurface`: the only thing that
 * can put `wireframe` in the registry here is the app's own mount path. That is
 * the property that reddens on a tree where the registration is absent.
 *
 * ## The four properties, and which of them can discriminate
 *
 * | property | pre-fix status |
 * |---|---|
 * | 0. the mount path registers | **RED** — `[]`, this suite is the discriminator |
 * | 1. re-mount REPLACES (never accumulates) | red if it appended; green pre-fix |
 * | 2. an EARLIER mount's disposer is a no-op after a later registration | red if a cleanup cleared a live entry; green pre-fix |
 * | 3. the current mount's disposer CLEARS | **vacuous pre-fix** — an empty registry has nothing to clear |
 *
 * Property 3 is stated as vacuous on the pre-fix tree rather than presented as a
 * second red-then-green cycle: a green-before/green-after assertion is a
 * non-discriminating reading, and it is labelled here so no later reader counts
 * two cycles where one exists. Properties 1/2/3 are still asserted, because
 * "the registry goes empty at the wrong moment" (a stale cleanup clearing a live
 * surface) reads EXACTLY like the original defect and would be blamed on it.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, waitFor } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import {
  listOrderSurfaceAppIds,
  readOrderSurface,
  resetOrderSurfacesForTests,
} from '@/shared/order/actionRisk';
import { WireframeEditor } from '../components/WireframeEditor';
import { WIREFRAME_APP_ID } from '../model/document';
import { resetWireframeStoreForTests } from '../store/wireframeDocumentStore';

/**
 * The Konva canvas cannot mount under jsdom (no `canvas` module) and is not the
 * subject here: the shell + its effects are. Stubbed with an inert marker div,
 * the same seam the app's own pointer-control suite uses, so the REAL shell runs.
 */
vi.mock('../components/WireframeCanvas', () => ({
  WireframeCanvas: () => <div data-testid="wireframe-canvas-stub" />,
}));

/** Every live registration of the app under test (never a count of OTHER apps). */
function wireframeRegistrations(): readonly string[] {
  return listOrderSurfaceAppIds().filter((appId) => appId === WIREFRAME_APP_ID);
}

beforeEach(() => {
  resetWireframeStoreForTests();
  // Clearing the registry is the OPPOSITE of supplying the wiring: it removes
  // anything a previous row left, so only the mount path under test can add it.
  resetOrderSurfacesForTests();
});

afterEach(() => {
  // Unmount FIRST: the shell's cleanup is the disposer under test, so the
  // registry must be observed empty by the product's own path, not by a reset.
  cleanup();
  resetOrderSurfacesForTests();
  resetWireframeStoreForTests();
});

describe('#3243 D1 — the PRODUCT registers Wireframe’s order surface', () => {
  it('mounting the shell registers the surface (property 0 — the discriminator)', async () => {
    // NOTHING in this suite registers anything: with no production wiring the
    // registry is `[]` here, which is exactly the shipped defect this row caught.
    expect(listOrderSurfaceAppIds()).toEqual([]);

    renderWithChakra(<WireframeEditor />);

    await waitFor(() => expect(listOrderSurfaceAppIds()).toContain('wireframe'));
    // One entry, and it is the declared surface — not a placeholder.
    expect(wireframeRegistrations()).toHaveLength(1);
    expect(readOrderSurface(WIREFRAME_APP_ID)?.actions).toHaveLength(4);
  });

  it('unmounting clears the registration (property 3 — the disposer is the cleanup)', async () => {
    const { unmount } = renderWithChakra(<WireframeEditor />);
    await waitFor(() => expect(listOrderSurfaceAppIds()).toContain('wireframe'));

    unmount();

    // VACUOUS ON THE PRE-FIX TREE: an empty registry satisfies this without any
    // disposer existing. It is asserted anyway because on the post-fix tree it is
    // the only thing that proves the cleanup — and a leaked registration is the
    // defect it guards.
    expect(listOrderSurfaceAppIds()).not.toContain('wireframe');
    expect(readOrderSurface(WIREFRAME_APP_ID)).toBeNull();
  });

  it('a remount leaves exactly ONE live registration (property 1 — replace, never accumulate)', async () => {
    const first = renderWithChakra(<WireframeEditor />);
    await waitFor(() => expect(listOrderSurfaceAppIds()).toContain('wireframe'));
    first.unmount();

    renderWithChakra(<WireframeEditor />);
    await waitFor(() => expect(listOrderSurfaceAppIds()).toContain('wireframe'));

    expect(wireframeRegistrations()).toHaveLength(1);
    // And it is a LIVE surface, not just a key: a zero-action entry would satisfy
    // a bare presence check while every order classified `unknown`.
    expect(readOrderSurface(WIREFRAME_APP_ID)?.actions).toHaveLength(4);
  });

  it('unmounting an EARLIER mount never clears the live surface a later mount owns', async () => {
    // Two shells are two registrations of the same app: the second REPLACES the
    // first, so the first's disposer is stale. A cleanup without the identity
    // guard would delete the entry the SECOND mount now owns — the registry going
    // empty at the wrong moment, which reads exactly like the missing wiring.
    const earlier = renderWithChakra(<WireframeEditor />);
    await waitFor(() => expect(listOrderSurfaceAppIds()).toContain('wireframe'));

    const later = renderWithChakra(<WireframeEditor />);
    await waitFor(() => expect(wireframeRegistrations()).toHaveLength(1));

    earlier.unmount();

    expect(listOrderSurfaceAppIds()).toContain('wireframe');
    expect(readOrderSurface(WIREFRAME_APP_ID)?.actions).toHaveLength(4);

    later.unmount();

    // The ordinary path still works after the stale one was exercised.
    expect(listOrderSurfaceAppIds()).not.toContain('wireframe');
  });

  it("registers under React.StrictMode (the app's real root) with exactly ONE live entry", async () => {
    // `main.tsx` renders the whole app inside `<React.StrictMode>`, so every mount
    // effect runs register → dispose → register. A cleanup that unconditionally
    // deleted would leave ZERO entries here while every non-StrictMode row above
    // stayed green — this row is the one that sees the double invoke.
    renderWithChakra(
      <React.StrictMode>
        <WireframeEditor />
      </React.StrictMode>,
    );

    await waitFor(() => expect(wireframeRegistrations()).toHaveLength(1));
    expect(readOrderSurface(WIREFRAME_APP_ID)?.actions).toHaveLength(4);
  });
});
