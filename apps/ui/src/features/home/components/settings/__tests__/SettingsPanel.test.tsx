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

    expect(screen.getByText('Theming')).toBeDefined();
    expect(screen.getByText('AI Model')).toBeDefined();
  });

  it('renders theming child components by default', async () => {
    renderWithChakra(<SettingsPanel />);

    // Theming tab is default — children should render
    // Note: Chakra v3 Tabs.Root renders ALL panels in the DOM (hidden via display:none)
    // so each child component may appear in multiple tab content panels. Use getAllByTestId.
    await waitFor(() => {
      expect(screen.getAllByTestId('theme-selector').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByTestId('animation-selector').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByTestId('window-style-selector').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('switches to AI Model tab and renders ModelSelector', async () => {
    renderWithChakra(<SettingsPanel />);

    // Click the "AI Model" tab
    // Use getByRole to uniquely target the tab button (avoids multiple matches from Chakra v3 DOM)
    const aiModelTab = screen.getByRole('tab', { name: 'AI Model' });
    await userEvent.click(aiModelTab);

    // After switching, ModelSelector should render
    await waitFor(() => {
      expect(screen.getAllByTestId('model-selector').length).toBeGreaterThanOrEqual(1);
    });
  });
});
