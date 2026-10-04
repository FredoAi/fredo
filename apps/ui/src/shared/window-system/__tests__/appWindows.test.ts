/**
 * appWindows tests (Spec #2955 ST-4).
 *
 * Pins the native-window IPC seam (`openAppInOwnWindow` / `closeAppOwnWindow`)
 * and the ONE presentation-aware opener (`createAppOpener`):
 *   - `openAppInOwnWindow` → `open_app_window` `{ appId, title }`;
 *   - `closeAppOwnWindow` → `close_app_window` `{ appId }`, true ONLY on a real
 *     native window (undefined/false → false — never an error);
 *   - `createAppOpener` awaits hydration and branches: `new-window` → the native
 *     host (the in-window opener is NOT called); `same-window`/default/factory →
 *     the in-window opener (the native host is NOT touched);
 *   - a hydration read failure falls back to `same-window` (R-4).
 *
 * `controlSettingAccessor` + `featureRegistry` are mocked at the same seams as
 * the sibling appPresentationStore test, so the suite stays host-agnostic.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../controlSettingAccessor', () => ({
  getControlSetting: vi.fn(),
  saveControlSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../features/featureRegistry', () => ({
  getFeatures: vi.fn(() => []),
}));

import { adapterBridge } from '../../utils/adapterBridge';
import { getControlSetting } from '../controlSettingAccessor';
import { getFeatures } from '../../../features/featureRegistry';
import {
  APP_PRESENTATION_KEY,
  resetAppPresentationStoreForTests,
} from '../appPresentationStore';
import { closeAppOwnWindow, createAppOpener, openAppInOwnWindow } from '../appWindows';
import type { FredoFeatureClass } from '../../classes/FredoFeatureClass';

const getMock = getControlSetting as unknown as ReturnType<typeof vi.fn>;
const getFeaturesMock = getFeatures as unknown as ReturnType<typeof vi.fn>;

const feature = (id: string, name: string): FredoFeatureClass =>
  ({ id, name }) as unknown as FredoFeatureClass;

const TERMINAL = feature('terminal', 'Terminal');
const QUERY_VIEWER = feature('query-viewer', 'Query Viewer');

let invokeMock: ReturnType<typeof vi.fn>;

/**
 * Route the control-plane accessor by key: the canonical key returns the RAW map
 * JSON, the legacy key returns the RAW mode. `null`/`undefined` = absent.
 */
function stored(map: unknown, legacy: unknown = null): void {
  const rawMap = map == null ? null : typeof map === 'string' ? map : JSON.stringify(map);
  const rawLegacy =
    legacy == null ? null : typeof legacy === 'string' ? legacy : JSON.stringify(legacy);
  getMock.mockImplementation(async (key: string) =>
    key === APP_PRESENTATION_KEY ? rawMap : rawLegacy,
  );
}

describe('appWindows (Spec #2955 ST-4 — native host seam + ONE opener)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAppPresentationStoreForTests();
    getFeaturesMock.mockReturnValue([]);
    stored({});
    invokeMock = vi.fn().mockResolvedValue(undefined);
    adapterBridge.setInvoke(invokeMock as never);
  });

  // ── native-host IPC seam ─────────────────────────────────────────────────

  it('openAppInOwnWindow invokes open_app_window with the app id and title', async () => {
    await openAppInOwnWindow('mission-monitor', 'Mission Monitor');

    expect(invokeMock).toHaveBeenCalledWith('open_app_window', {
      appId: 'mission-monitor',
      title: 'Mission Monitor',
    });
  });

  it('closeAppOwnWindow returns true ONLY when a native window existed', async () => {
    invokeMock.mockResolvedValue(true);
    expect(await closeAppOwnWindow('terminal')).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('close_app_window', { appId: 'terminal' });

    invokeMock.mockResolvedValue(false);
    expect(await closeAppOwnWindow('terminal')).toBe(false);

    // Adapter absent / non-boolean → false, never a thrown error.
    invokeMock.mockResolvedValue(undefined);
    expect(await closeAppOwnWindow('terminal')).toBe(false);
  });

  // ── the ONE presentation-aware opener ────────────────────────────────────

  it('opens the native host for a new-window choice and never the in-window opener', async () => {
    stored({ terminal: 'new-window' });
    const inWindow = vi.fn();

    createAppOpener(inWindow)('terminal', TERMINAL);

    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('open_app_window', {
        appId: 'terminal',
        title: 'Terminal',
      }),
    );
    expect(inWindow).not.toHaveBeenCalled();
  });

  it('opens in-window for the default (no choice) and never touches the native host', async () => {
    stored({});
    const inWindow = vi.fn();

    createAppOpener(inWindow)('terminal', TERMINAL);

    await vi.waitFor(() => expect(inWindow).toHaveBeenCalledWith('terminal', TERMINAL));
    expect(invokeMock).not.toHaveBeenCalledWith('open_app_window', expect.anything());
  });

  it('opens in-window for an explicit same-window choice', async () => {
    stored({ terminal: 'same-window' });
    const inWindow = vi.fn();

    createAppOpener(inWindow)('terminal', TERMINAL);

    await vi.waitFor(() => expect(inWindow).toHaveBeenCalledWith('terminal', TERMINAL));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('falls back to in-window when the hydration read fails (R-4, bounded)', async () => {
    getMock.mockRejectedValue(new Error('no host'));
    const inWindow = vi.fn();

    createAppOpener(inWindow)('terminal', TERMINAL);

    await vi.waitFor(() => expect(inWindow).toHaveBeenCalledWith('terminal', TERMINAL));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('defensively opens a factory (isMultiWindow) app in-window even if new-window is stored', async () => {
    getFeaturesMock.mockReturnValue([{ id: 'query-viewer', isMultiWindow: true }]);
    stored({ 'query-viewer': 'new-window' });
    const inWindow = vi.fn();

    createAppOpener(inWindow)('query-viewer', QUERY_VIEWER);

    await vi.waitFor(() => expect(inWindow).toHaveBeenCalledWith('query-viewer', QUERY_VIEWER));
    expect(invokeMock).not.toHaveBeenCalledWith('open_app_window', expect.anything());
  });
});
