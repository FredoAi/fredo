/**
 * Spec #3120 (P6), ST-5 — `LauncherConfirmation` (UI/UX §2.4, QA R-5.2 / R-5.3).
 *
 * The dialog is a real `role="alertdialog"` that names the verb, target(s), consequence,
 * undo availability and (for external verbs) the outside party. Cancel is the initial
 * focus; Esc, Cancel and an outside click all resolve FALSE; Accept resolves TRUE; and
 * nothing auto-confirms on mount.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import type { ConfirmationRequest } from '@/shared/navigation';
import { LauncherConfirmation } from '@/applications/home/components/launcher/LauncherConfirmation';
import {
  LAUNCHER_CONFIRMATION_ACCEPT_TESTID,
  LAUNCHER_CONFIRMATION_CANCEL_TESTID,
  LAUNCHER_CONFIRMATION_CONSEQUENCE_TESTID,
  LAUNCHER_CONFIRMATION_TARGET_TESTID,
  LAUNCHER_CONFIRMATION_TESTID,
  LAUNCHER_CONFIRMATION_UNDO_TESTID,
  LAUNCHER_CONFIRMATION_VERB_TESTID,
} from '@/applications/home/components/launcher/launcherConstants';

function request(overrides: Partial<ConfirmationRequest> = {}): ConfirmationRequest {
  return {
    verbId: 'wireframe.element.delete',
    title: 'Delete',
    targetLabels: ['el-1', 'el-2'],
    targetOverflow: 1,
    consequence: 'Deletes the selected elements. This can be undone from the trail.',
    undoAvailability: { undoable: true },
    externalParty: null,
    ...overrides,
  };
}

function render(requestValue: ConfirmationRequest | null, onResolve = vi.fn()) {
  renderWithChakra(
    <LauncherConfirmation request={requestValue} onResolve={onResolve} reducedMotion />,
  );
  return onResolve;
}

afterEach(() => {
  cleanup();
});

describe('LauncherConfirmation — the alertdialog contract (R-5.2)', () => {
  it('names the verb, target(s), consequence and undo availability', () => {
    render(request());
    const dialog = screen.getByTestId(LAUNCHER_CONFIRMATION_TESTID);

    expect(dialog).toHaveAttribute('role', 'alertdialog');
    expect(dialog).toHaveAccessibleName('Run Delete?');
    expect(screen.getByTestId(LAUNCHER_CONFIRMATION_VERB_TESTID)).toHaveTextContent('Delete');
    expect(screen.getByTestId(LAUNCHER_CONFIRMATION_TARGET_TESTID)).toHaveTextContent(
      'el-1, el-2 +1',
    );
    expect(screen.getByTestId(LAUNCHER_CONFIRMATION_CONSEQUENCE_TESTID)).toHaveTextContent(
      'Deletes the selected elements. This can be undone from the trail.',
    );
    expect(screen.getByTestId(LAUNCHER_CONFIRMATION_UNDO_TESTID)).toHaveTextContent(
      'Undo available',
    );
    expect(dialog).toHaveAttribute(
      'aria-describedby',
      screen.getByTestId(LAUNCHER_CONFIRMATION_CONSEQUENCE_TESTID).id,
    );
    expect(screen.getByTestId(LAUNCHER_CONFIRMATION_ACCEPT_TESTID)).toHaveTextContent('Apply Delete');
  });

  it('hides the target row for a targetless verb and shows the not-undoable reason', () => {
    render(
      request({
        targetLabels: [],
        targetOverflow: 0,
        undoAvailability: { undoable: false, reason: 'not-undoable' },
      }),
    );
    expect(screen.queryByTestId(LAUNCHER_CONFIRMATION_TARGET_TESTID)).toBeNull();
    expect(screen.getByTestId(LAUNCHER_CONFIRMATION_UNDO_TESTID)).toHaveTextContent(
      'Not undoable — not-undoable',
    );
  });

  it('renders the outside-party chip for an external verb', () => {
    render(request({ title: 'Export PNG', externalParty: 'your file system' }));
    expect(screen.getByText('Outside Fredo: your file system')).toBeInTheDocument();
    expect(screen.getByTestId(LAUNCHER_CONFIRMATION_ACCEPT_TESTID)).toHaveTextContent(
      'Apply Export PNG',
    );
  });

  it('renders nothing when there is no pending request', () => {
    render(null);
    expect(screen.queryByTestId(LAUNCHER_CONFIRMATION_TESTID)).toBeNull();
  });
});

describe('LauncherConfirmation — dismissibility (R-5.3)', () => {
  it('never auto-confirms on mount and focuses Cancel first', async () => {
    const onResolve = render(request());
    expect(onResolve).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId(LAUNCHER_CONFIRMATION_CANCEL_TESTID)).toHaveFocus(),
    );
  });

  it('Cancel resolves false', () => {
    const onResolve = render(request());
    fireEvent.click(screen.getByTestId(LAUNCHER_CONFIRMATION_CANCEL_TESTID));
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith(false);
  });

  it('Accept resolves true', () => {
    const onResolve = render(request());
    fireEvent.click(screen.getByTestId(LAUNCHER_CONFIRMATION_ACCEPT_TESTID));
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith(true);
  });

  it('Escape resolves false', async () => {
    const onResolve = render(request());
    fireEvent.keyDown(screen.getByTestId(LAUNCHER_CONFIRMATION_TESTID), { key: 'Escape' });
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith(false));
  });

  it('a real outside pointerdown on the positioner resolves false', async () => {
    const onResolve = render(request());
    const dialog = screen.getByTestId(LAUNCHER_CONFIRMATION_TESTID);

    // Ark defers twice (dismissable layer on one animation frame, its interact-outside
    // tracker on the next) and only then installs the document capture listener on a
    // macrotask. Wait for the whole chain before firing the real outside event.
    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    // The live hit path lands on the positioner, NOT the backdrop (the backdrop computes
    // `pointer-events: none`; the positioner is the full-viewport `auto` layer). Firing on
    // the backdrop node would assert a path the live DOM cannot reach (G-418).
    const positioner = document.querySelector('[data-part="positioner"]');
    expect(positioner).not.toBeNull();
    // The confirmation content is a CHILD of the positioner, so the pointerdown target (the
    // positioner itself) is OUTSIDE the content node — exactly zag's `isEventOutside` test.
    expect(dialog.contains(positioner)).toBe(false);

    fireEvent.pointerDown(positioner as Element);

    await waitFor(() => expect(onResolve).toHaveBeenCalledWith(false));
  });
});

describe('LauncherConfirmation — reduced motion', () => {
  it('removes content and scrim animations under reduced motion', () => {
    render(request());
    expect(screen.getByTestId(LAUNCHER_CONFIRMATION_TESTID).style.animation).toBe('none');
    const backdrop = document.querySelector('[data-part="backdrop"]') as HTMLElement;
    expect(backdrop.style.animation).toBe('none');
  });

  it('animates the content and scrim by default', () => {
    renderWithChakra(
      <LauncherConfirmation request={request()} onResolve={vi.fn()} reducedMotion={false} />,
    );
    expect(screen.getByTestId(LAUNCHER_CONFIRMATION_TESTID).style.animation).toBe(
      'launcher-confirm-in 150ms ease',
    );
    const backdrop = document.querySelector('[data-part="backdrop"]') as HTMLElement;
    expect(backdrop.style.animation).toBe('launcher-confirm-scrim-in 150ms ease');
  });
});
