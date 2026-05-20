import React from 'react';
import { chakra } from '@chakra-ui/react';
import { useTheme } from '../../../../app/providers/ThemeProvider';

export const ThemeSelector: React.FC = () => {
  const { currentTheme, setTheme, availableThemes } = useTheme();

  return (
    <chakra.select
      width="100%"
      p={2}
      borderRadius="md"
      bg="var(--card-bg)"
      border="1px solid"
      borderColor="var(--border-color)"
      color="var(--text-primary)"
      fontSize="sm"
      fontWeight="500"
      cursor="pointer"
      transition="all 0.2s"
      aria-label="Theme"
      title="Theme"
      value={currentTheme}
      onChange={(e) => setTheme(e.target.value as any)}
      _hover={{
        borderColor: 'var(--accent-primary)'
      }}
      _focus={{
        outline: 'none',
        borderColor: 'var(--accent-primary)',
        boxShadow: '0 0 0 1px var(--accent-primary)'
      }}
    >
      {availableThemes.map((theme) => (
        <option key={theme.id} value={theme.id}>
          {theme.name}
        </option>
      ))}
    </chakra.select>
  );
};
