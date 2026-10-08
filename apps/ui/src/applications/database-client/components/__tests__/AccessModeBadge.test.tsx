/**
 * AccessModeBadge tests (Spec #2950, ST-7; R-5.1/R-5.7).
 *
 * Pins the always-visible mode badge: read-only and read/write use DISTINCT
 * semantic status tokens, read/write is keyboard-focusable, and the
 * disconnected state still renders (R-5.1 "visible at all times").
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { AccessModeBadge } from '../AccessModeBadge';

afterEach(() => cleanup());

describe('AccessModeBadge', () => {
  it('renders read-only with the read-only status token and is focusable', () => {
    renderWithChakra(<AccessModeBadge mode="readOnly" />);
    const badge = screen.getByTestId('db-access-mode-badge');
    expect(badge).toHaveTextContent('Read-only');
    expect(badge).toHaveAttribute('data-mode', 'readOnly');
    expect(badge).toHaveAttribute('data-token', 'status.info');
    expect(badge).toHaveAttribute('tabindex', '0');
  });

  it('renders read/write with a DISTINCT status token and is focusable (R-5.7)', () => {
    renderWithChakra(<AccessModeBadge mode="readWrite" />);
    const badge = screen.getByTestId('db-access-mode-badge');
    expect(badge).toHaveTextContent('Read/write');
    expect(badge).toHaveAttribute('data-mode', 'readWrite');
    expect(badge).toHaveAttribute('data-token', 'status.warning');
    expect(badge).toHaveAttribute('tabindex', '0');
    expect(badge.getAttribute('data-token')).not.toBe('status.info');
  });

  it('still renders when no connection is active (R-5.1 — visible at all times)', () => {
    renderWithChakra(<AccessModeBadge mode={null} />);
    const badge = screen.getByTestId('db-access-mode-badge');
    expect(badge).toHaveTextContent('Not connected');
    expect(badge).toHaveAttribute('data-mode', 'none');
  });
});
