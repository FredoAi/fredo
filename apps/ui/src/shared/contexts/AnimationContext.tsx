import React, { createContext, useContext, type ReactNode } from 'react';
import { usePersistedSetting } from '../hooks/usePersistedSetting';

export type AnimationType = 'hyperspeed' | 'magnet-lines' | 'cubes' | 'random';

interface AnimationContextType {
  animationType: AnimationType;
  setAnimationType: (type: AnimationType) => void;
}

const AnimationContext = createContext<AnimationContextType | undefined>(undefined);

export const useAnimation = (): AnimationContextType => {
  const ctx = useContext(AnimationContext);
  if (!ctx) throw new Error('useAnimation must be used within AnimationProvider');
  return ctx;
};

export const AnimationProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [animationType, setAnimationType] = usePersistedSetting<AnimationType>('animationType', 'hyperspeed');

  return (
    <AnimationContext.Provider value={{ animationType, setAnimationType }}>
      {children}
    </AnimationContext.Provider>
  );
};
