import { ChakraProvider } from '@chakra-ui/react';
import React from 'react';
import { system } from '../../../app/theme/system';

export function Provider({ children }: { children: React.ReactNode }) {
  return (
    <ChakraProvider value={system}>
      {children}
    </ChakraProvider>
  );
}
