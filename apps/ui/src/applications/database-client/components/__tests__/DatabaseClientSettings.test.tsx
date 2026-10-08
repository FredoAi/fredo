/**
 * DatabaseClientSettings tests (Spec #2950, ST-7; settings surface).
 *
 * Pins the `DbClientPrefs` defaults, the unified-Save delegation
 * (`useSettingsSave` — no direct save button), persistence through
 * `Fredo_dbclient_prefs`, and the range clamp.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { adapterBridge } from '@/shared/utils/adapterBridge';
import { DBCLIENT_PREFS_KEY } from '../../lib/storage';
import { useSettingsSaveContext, SettingsSaveProvider } from '../../../settings/SettingsSaveContext';
import { clampPref, DatabaseClientSettings } from '../DatabaseClientSettings';

function SaveProbe() {
  const { saveFn } = useSettingsSaveContext();
  return (
    <button data-testid="db-settings-save-probe" onClick={() => void saveFn?.()}>
      save
    </button>
  );
}

function renderSettings() {
  return renderWithChakra(
    <SettingsSaveProvider>
      <DatabaseClientSettings />
      <SaveProbe />
    </SettingsSaveProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  // Force the localStorage fallback — no Tauri host in jsdom.
  adapterBridge.setInvoke(async () => {
    throw new Error('no tauri in test');
  });
});

afterEach(() => {
  localStorage.clear();
  cleanup();
});

describe('clampPref', () => {
  it('clamps to the declared range and falls back for non-finite input', () => {
    expect(clampPref(250, 1, 5000, 100)).toBe(250);
    expect(clampPref(999999, 1, 5000, 100)).toBe(5000);
    expect(clampPref(0, 1, 5000, 100)).toBe(1);
    expect(clampPref(Number.NaN, 1, 5000, 100)).toBe(100);
  });
});

describe('DatabaseClientSettings — defaults', () => {
  it('renders the DbClientPrefs defaults (100 / 100 / confirm true)', async () => {
    renderSettings();
    await waitFor(() =>
      expect(screen.getByTestId('db-settings-default-row-limit')).toHaveValue(100),
    );
    expect(screen.getByTestId('db-settings-page-size')).toHaveValue(100);
    expect(screen.getByTestId('db-settings-confirm-destructive')).toHaveAttribute(
      'data-state',
      'checked',
    );
    expect(screen.getByTestId('dbclient-settings')).toBeInTheDocument();
  });
});

describe('DatabaseClientSettings — unified save persists prefs', () => {
  it('persists the edited row limit under Fredo_dbclient_prefs', async () => {
    renderSettings();
    await waitFor(() =>
      expect(screen.getByTestId('db-settings-default-row-limit')).toHaveValue(100),
    );

    fireEvent.change(screen.getByTestId('db-settings-default-row-limit'), {
      target: { value: '250' },
    });
    fireEvent.change(screen.getByTestId('db-settings-page-size'), { target: { value: '50' } });
    fireEvent.click(screen.getByTestId('db-settings-save-probe'));

    await waitFor(() => {
      const raw = localStorage.getItem(DBCLIENT_PREFS_KEY);
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw as string)).toMatchObject({
        defaultRowLimit: 250,
        pageSize: 50,
        confirmDestructive: true,
      });
    });
    expect(screen.getByTestId('db-settings-status')).toHaveTextContent('Preferences saved');
  });

  it('clamps an out-of-range row limit on save', async () => {
    renderSettings();
    await waitFor(() =>
      expect(screen.getByTestId('db-settings-default-row-limit')).toHaveValue(100),
    );

    fireEvent.change(screen.getByTestId('db-settings-default-row-limit'), {
      target: { value: '999999' },
    });
    fireEvent.click(screen.getByTestId('db-settings-save-probe'));

    await waitFor(() => {
      const raw = localStorage.getItem(DBCLIENT_PREFS_KEY);
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw as string).defaultRowLimit).toBe(5000);
    });
  });

  it('persists the destructive-confirm toggle', async () => {
    renderSettings();
    await waitFor(() =>
      expect(screen.getByTestId('db-settings-confirm-destructive')).toHaveAttribute(
        'data-state',
        'checked',
      ),
    );

    fireEvent.click(screen.getByTestId('db-settings-confirm-destructive-control'));
    await waitFor(() =>
      expect(screen.getByTestId('db-settings-confirm-destructive')).toHaveAttribute(
        'data-state',
        'unchecked',
      ),
    );
    fireEvent.click(screen.getByTestId('db-settings-save-probe'));

    await waitFor(() => {
      const raw = localStorage.getItem(DBCLIENT_PREFS_KEY);
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw as string).confirmDestructive).toBe(false);
    });
  });
});
