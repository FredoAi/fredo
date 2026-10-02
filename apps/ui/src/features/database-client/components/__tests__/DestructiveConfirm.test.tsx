/**
 * DestructiveConfirm tests (Spec #2950, ST-5; R-5.3 UI).
 *
 * Pins the blocking confirmation contract: the dialog names the detected class
 * and shows the preview, it NEVER auto-confirms, initial focus lands on Cancel,
 * and the confirm/cancel callbacks are the only exits.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { DestructiveConfirm } from '../DestructiveConfirm';
import type { DbConfirmationRequired } from '../../lib/types';

const confirmation: DbConfirmationRequired = {
  statementClass: 'destructive',
  statementHash: 'hash-123',
  preview: 'DELETE FROM users WHERE active = false',
};

afterEach(() => {
  cleanup();
});

describe('DestructiveConfirm — blocking confirmation (R-5.3 UI)', () => {
  it('renders nothing when there is no pending confirmation', () => {
    renderWithChakra(
      <DestructiveConfirm confirmation={null} onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(screen.queryByTestId('db-destructive-confirm')).toBeNull();
  });

  it('names the statement class and shows the preview', () => {
    renderWithChakra(
      <DestructiveConfirm confirmation={confirmation} onConfirm={() => {}} onCancel={() => {}} />,
    );

    const dialog = screen.getByTestId('db-destructive-confirm');
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByTestId('db-destructive-class')).toHaveTextContent('destructive');
    expect(screen.getByTestId('db-destructive-preview')).toHaveTextContent(
      'DELETE FROM users WHERE active = false',
    );
  });

  it('never auto-confirms — the hash is echoed only on an explicit press', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderWithChakra(
      <DestructiveConfirm confirmation={confirmation} onConfirm={onConfirm} onCancel={onCancel} />,
    );

    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('db-destructive-run'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('cancels without executing anything', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderWithChakra(
      <DestructiveConfirm confirmation={confirmation} onConfirm={onConfirm} onCancel={onCancel} />,
    );

    fireEvent.click(screen.getByTestId('db-destructive-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('puts initial focus on the least-destructive action (Cancel)', async () => {
    renderWithChakra(
      <DestructiveConfirm confirmation={confirmation} onConfirm={() => {}} onCancel={() => {}} />,
    );
    await waitFor(() => expect(screen.getByTestId('db-destructive-cancel')).toHaveFocus());
  });
});
