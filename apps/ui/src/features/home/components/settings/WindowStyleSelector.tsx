import React from 'react';
import { chakra } from '@chakra-ui/react';
import { useWindowStyle, WINDOW_STYLES, type WindowStyleId } from '../../../../shared/contexts/WindowStyleContext';

export const WindowStyleSelector: React.FC = () => {
  const { windowStyle, setWindowStyle } = useWindowStyle();

  return (
    <chakra.select
      width="100%"
      p={2}
      borderRadius="md"
      background="var(--card-bg)"
      border="1px solid"
      borderColor="var(--border-color)"
      color="var(--text-primary)"
      fontSize="sm"
      fontWeight="500"
      cursor="pointer"
      transition="all 0.2s"
      fontFamily="var(--font-family)"
      aria-label="Window style"
      title="Window style"
      value={windowStyle}
      onChange={(e) => setWindowStyle(e.target.value as WindowStyleId)}
      _hover={{ borderColor: 'var(--accent-primary)' }}
      _focus={{
        outline: 'none',
        borderColor: 'var(--accent-primary)',
        boxShadow: '0 0 0 1px var(--accent-primary)',
      }}
    >
      {WINDOW_STYLES.map((style) => (
        <option key={style.id} value={style.id}>
          {style.name} — {style.description}
        </option>
      ))}
    </chakra.select>
  );
};
