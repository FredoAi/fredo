import React, { createContext, useContext, type ReactNode } from 'react';
import { usePersistedSetting } from '../hooks/usePersistedSetting';

export const WINDOW_STYLES = [
  { id: 'default', name: 'Default', description: 'Clean default style' },
  { id: 'traffic', name: 'Traffic', description: 'Colored dot buttons' },
  { id: 'linux', name: 'Linux', description: 'Dark/light gradient' },
  { id: 'yk2000', name: 'Y2K', description: 'Classic retro' },
  { id: 'aero', name: 'Aero', description: 'Translucent glass blur' },
] as const;

export type WindowStyleId = typeof WINDOW_STYLES[number]['id'];

interface WindowStyleContextType {
  windowStyle: WindowStyleId;
  setWindowStyle: (style: WindowStyleId) => void;
}

const WindowStyleContext = createContext<WindowStyleContextType | undefined>(undefined);

export const useWindowStyle = (): WindowStyleContextType => {
  const ctx = useContext(WindowStyleContext);
  if (!ctx) throw new Error('useWindowStyle must be used within WindowStyleProvider');
  return ctx;
};

export const WindowStyleProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [windowStyle, setWindowStyle] = usePersistedSetting<WindowStyleId>('Fredo_window_style', 'default');

  return (
    <WindowStyleContext.Provider value={{ windowStyle, setWindowStyle }}>
      {children}
    </WindowStyleContext.Provider>
  );
};
