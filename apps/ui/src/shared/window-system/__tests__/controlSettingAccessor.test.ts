/**
 * controlSettingAccessor tests (Spec #2955 B-2/B-3).
 *
 * Pins the control-plane (`control.db`) KV seam the presentation store persists
 * through: `get_control_setting` / `save_control_setting` — NOT the async data
 * plane (`save_setting`). An absent read (`None`) is `null` and is authoritative
 * (no `localStorage` shadow).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/adapterBridge', () => ({
  adapterBridge: {
    invoke: vi.fn(),
  },
}));

import { adapterBridge } from '../../utils/adapterBridge';
import { getControlSetting, saveControlSetting } from '../controlSettingAccessor';

const invokeMock = adapterBridge.invoke as unknown as ReturnType<typeof vi.fn>;

describe('controlSettingAccessor (Spec #2955 — control-plane KV seam)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads through get_control_setting with the key argument', async () => {
    invokeMock.mockResolvedValue('{"terminal":"new-window"}');
    const value = await getControlSetting('app_window_presentation');

    expect(invokeMock).toHaveBeenCalledWith('get_control_setting', {
      key: 'app_window_presentation',
    });
    expect(value).toBe('{"terminal":"new-window"}');
  });

  it('maps an absent read (None / undefined) to null — never localStorage', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem');

    invokeMock.mockResolvedValue(null);
    expect(await getControlSetting('app_window_presentation')).toBeNull();

    invokeMock.mockResolvedValue(undefined);
    expect(await getControlSetting('app_window_presentation')).toBeNull();

    expect(getItem).not.toHaveBeenCalled();
    getItem.mockRestore();
  });

  it('writes through save_control_setting with key + raw value', async () => {
    invokeMock.mockResolvedValue(undefined);
    await saveControlSetting('app_window_presentation', '{"terminal":"new-window"}');

    expect(invokeMock).toHaveBeenCalledWith('save_control_setting', {
      key: 'app_window_presentation',
      value: '{"terminal":"new-window"}',
    });
  });
});
