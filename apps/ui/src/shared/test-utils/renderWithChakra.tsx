import React from 'react';
import { ChakraProvider, createSystem, defaultBaseConfig } from '@chakra-ui/react';
import { render, type RenderOptions } from '@testing-library/react';

const testSystem = createSystem({
  ...defaultBaseConfig,
  disableLayers: true,
  preflight: false,
  globalCss: {},
});

function TestProviders({ children }: { children: React.ReactNode }) {
  return <ChakraProvider value={testSystem}>{children}</ChakraProvider>;
}

export function renderWithChakra(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>,
) {
  return render(ui, { wrapper: TestProviders, ...options });
}
