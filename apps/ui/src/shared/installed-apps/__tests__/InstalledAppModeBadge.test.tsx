/**
 * Spec #3241 ST-5 — the ONE development-mode badge renderer (UI/UX §7).
 *
 * This suite is the anti-drift gate for the painted word: both list surfaces
 * (S3 settings, S4 launcher) render through THIS component, so the token cannot
 * diverge between them. It pins the three properties the design binds:
 *
 *  - `development` renders one node whose text IS the token;
 *  - `released` renders **no node at all** (the absence IS the released state);
 *  - the required `testId` prop is honoured verbatim, so neither surface's bound
 *    hook can be duplicated onto the other.
 */

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { DEVELOPMENT_MARKER_TOKEN } from '@/shared/installed-apps/types';
import { InstalledAppModeBadge } from '../InstalledAppModeBadge';

afterEach(cleanup);

describe('#3241 ST-5 — InstalledAppModeBadge', () => {
  it('renders the painted token for a development build', () => {
    renderWithChakra(
      <InstalledAppModeBadge
        mode="development"
        testId="installed-apps-entry-mode"
        size="row"
      />,
    );

    const badge = screen.getByTestId('installed-apps-entry-mode');
    // The WORD is the whole claim — text-bearing, never colour-only.
    expect(badge.textContent).toBe(DEVELOPMENT_MARKER_TOKEN);
    expect(badge.textContent).toBe('Development');
  });

  it('renders NO node for a released build (no wrapper, no empty span)', () => {
    const { container } = renderWithChakra(
      <InstalledAppModeBadge
        mode="released"
        testId="installed-apps-entry-mode"
        size="row"
      />,
    );

    expect(screen.queryByTestId('installed-apps-entry-mode')).toBeNull();
    // Not merely "no testid": NOTHING at all is rendered — an empty wrapper would
    // still occupy a slot in the row's reading order.
    expect(container.firstChild).toBeNull();
    expect(container.innerHTML).toBe('');
  });

  it('honours the required testId prop verbatim, so each surface keeps its own hook', () => {
    const { unmount } = renderWithChakra(
      <InstalledAppModeBadge mode="development" testId="launcher-installed-app-mode" size="shelf" />,
    );
    expect(screen.getByTestId('launcher-installed-app-mode')).toBeTruthy();
    // The settings hook is NOT painted by the launcher surface.
    expect(screen.queryByTestId('installed-apps-entry-mode')).toBeNull();
    unmount();

    renderWithChakra(
      <InstalledAppModeBadge mode="development" testId="installed-apps-entry-mode" size="row" />,
    );
    expect(screen.getByTestId('installed-apps-entry-mode')).toBeTruthy();
    expect(screen.queryByTestId('launcher-installed-app-mode')).toBeNull();
  });

  it('is a plain, non-interactive span with no ARIA override', () => {
    renderWithChakra(
      <InstalledAppModeBadge
        mode="development"
        testId="installed-apps-entry-mode"
        size="row"
      />,
    );

    const badge = screen.getByTestId('installed-apps-entry-mode');
    // Not a control: no role, no tabindex, no aria-label/aria-hidden. The visible
    // text IS the accessible name, so painted and announced cannot drift.
    expect(badge.tagName).toBe('SPAN');
    expect(badge.getAttribute('role')).toBeNull();
    expect(badge.getAttribute('tabindex')).toBeNull();
    expect(badge.getAttribute('aria-hidden')).toBeNull();
    expect(badge.getAttribute('aria-label')).toBeNull();
    expect(badge.getAttribute('aria-live')).toBeNull();
  });

  it('paints the token VERBATIM — no textTransform uppercases it', () => {
    renderWithChakra(
      <InstalledAppModeBadge mode="development" testId="installed-apps-entry-mode" size="row" />,
    );
    const badge = screen.getByTestId('installed-apps-entry-mode');
    // R-3.6's uniformity rule governs the PAINTED word: `DEVELOPMENT` would break
    // it even though the DOM text matched, so the component must not transform.
    expect(badge.style.textTransform).toBe('');
    expect(badge.textContent).not.toBe('DEVELOPMENT');
    expect(badge.textContent).toBe(DEVELOPMENT_MARKER_TOKEN);
  });
});
