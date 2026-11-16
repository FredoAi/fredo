/**
 * Wireframe file-error banner (Spec #3070, ST-6 / UI/UX section 2.7, R-4.11).
 *
 * Renders only while the store has an error, exposes the message in an alert
 * live region, and clears through the icon-only dismiss button.
 */

import React from 'react';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { WireframeFileError } from '../components/WireframeFileError';
import {
  getSnapshot,
  resetWireframeStoreForTests,
  setError,
} from '../store/wireframeDocumentStore';

beforeEach(() => {
  resetWireframeStoreForTests();
});

afterEach(() => {
  cleanup();
});

describe('WireframeFileError', () => {
  it('renders nothing while there is no error', () => {
    renderWithChakra(<WireframeFileError />);

    expect(screen.queryByTestId('wireframe-file-error')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders the message in an alert', () => {
    act(() => setError('This file isn\'t a Wireframe document. Nothing changed.'));

    renderWithChakra(<WireframeFileError />);

    const banner = screen.getByTestId('wireframe-file-error');
    expect(banner).toBe(screen.getByRole('alert'));
    expect(
      screen.getByText("This file isn't a Wireframe document. Nothing changed."),
    ).toBeTruthy();
  });

  it('appears when the store gains an error after mount', () => {
    renderWithChakra(<WireframeFileError />);
    expect(screen.queryByTestId('wireframe-file-error')).toBeNull();

    act(() => setError('Access is denied.'));

    expect(screen.getByTestId('wireframe-file-error')).toBeTruthy();
    expect(screen.getByText('Access is denied.')).toBeTruthy();
  });

  it('dismisses through the icon-only button and clears the store', () => {
    act(() => setError('Access is denied.'));
    renderWithChakra(<WireframeFileError />);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss file error' }));
    });

    expect(screen.queryByTestId('wireframe-file-error')).toBeNull();
    expect(getSnapshot().error).toBeNull();
  });
});
