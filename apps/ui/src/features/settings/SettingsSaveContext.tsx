/**
 * SettingsSaveContext — part of the settings infrastructure module.
 *
 * Allows any feature's settings panel to register a save function with the
 * parent modal. The modal renders a single unified Save button and delegates
 * to whatever fn is currently registered.
 *
 * Usage in a panel:
 *   useSettingsSave(handleSave);          // show Save button
 *   useSettingsSave(isEditing ? fn : null); // conditionally show Save button
 */

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

type SaveFn = () => Promise<void>;

interface SettingsSaveContextValue {
  /** Register (or clear) the active save function. */
  registerSave: (fn: SaveFn | null) => void;
  /** The currently registered save function — null when no panel needs a Save button. */
  saveFn: SaveFn | null;
}

const SettingsSaveContext = createContext<SettingsSaveContextValue>({
  registerSave: () => {},
  saveFn: null,
});

export const SettingsSaveProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [saveFn, setSaveFn] = useState<SaveFn | null>(null);

  // Note: fn must be wrapped so React doesn't treat it as a state-updater
  const registerSave = useCallback((fn: SaveFn | null) => {
    setSaveFn(fn === null ? null : () => fn);
  }, []);

  return (
    <SettingsSaveContext.Provider value={{ registerSave, saveFn }}>
      {children}
    </SettingsSaveContext.Provider>
  );
};

export const useSettingsSaveContext = () => useContext(SettingsSaveContext);

/**
 * Call in a settings panel to register its save function.
 * The modal will show/hide the unified Save button based on whether fn is null.
 * Clears automatically when the panel unmounts.
 */
export function useSettingsSave(fn: SaveFn | null): void {
  const { registerSave } = useSettingsSaveContext();
  useEffect(() => {
    registerSave(fn);
    return () => registerSave(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fn]);
}
