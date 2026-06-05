/**
 * renderWithChakra — Test utility that wraps components in ChakraProvider.
 *
 * All component tests MUST use this instead of raw `render` from
 * @testing-library/react to ensure Chakra v3 compound components
 * (Tabs.Root, Field.Root, Dialog.Root, etc.) render correctly.
 */

import React from 'react';
import { ChakraProvider, defaultSystem } from '@chakra-ui/react';
import { render, type RenderOptions } from '@testing-library/react';

function AllProviders({ children }: { children: React.ReactNode }) {
  return <ChakraProvider value={defaultSystem}>{children}</ChakraProvider>;
}

export function renderWithChakra(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>,
) {
  return render(ui, { wrapper: AllProviders, ...options });
}
