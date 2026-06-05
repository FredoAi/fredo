/**
 * PREREQUISITE:
 * This test file uses vitest + @testing-library/react.
 * Install with: pnpm --filter @fredo/ui add -D vitest @testing-library/react @testing-library/jest-dom
 *
 * Component tests for SettingsPanel.
 *
 * REQ-COMP-4: SettingsPanel renders "Theming" and "AI Model" tabs, tab switching
 * works, and child components mount inside tab content.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { SettingsPanel } from '../SettingsPanel';

// Mock child components so they render as simple indicators
vi.mock('../ThemeSelector', () => ({
  ThemeSelector: () => <div data-testid="theme-selector">ThemeSelector</div>,
}));

vi.mock('../AnimationSelector', () => ({
  AnimationSelector: () => (
    <div data-testid="animation-selector">AnimationSelector</div>
  ),
}));

vi.mock('../WindowStyleSelector', () => ({
  WindowStyleSelector: () => (
    <div data-testid="window-style-selector">WindowStyleSelector</div>
  ),
}));

vi.mock('../ModelSelector', () => ({
  ModelSelector: () => <div data-testid="model-selector">ModelSelector</div>,
}));

describe('SettingsPanel', () => {
  it('renders "Theming" and "AI Model" tab triggers', () => {
    renderWithChakra(<SettingsPanel />);

    expect(screen.getByText('Theming')).toBeInTheDocument();
    expect(screen.getByText('AI Model')).toBeInTheDocument();
  });

  it('renders theming child components by default', async () => {
    renderWithChakra(<SettingsPanel />);

    // Theming tab is default — children should render
    await waitFor(() => {
      expect(screen.getByTestId('theme-selector')).toBeInTheDocument();
      expect(screen.getByTestId('animation-selector')).toBeInTheDocument();
      expect(screen.getByTestId('window-style-selector')).toBeInTheDocument();
    });
  });

  it('switches to AI Model tab and renders ModelSelector', async () => {
    renderWithChakra(<SettingsPanel />);

    // Click the "AI Model" tab
    const aiModelTab = screen.getByText('AI Model');
    await userEvent.click(aiModelTab);

    // After switching, ModelSelector should render
    await waitFor(() => {
      expect(screen.getByTestId('model-selector')).toBeInTheDocument();
    });
  });
});
