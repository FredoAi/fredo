/**
 * PREREQUISITE:
 * This test file uses vitest + @testing-library/react.
 * Install with: pnpm --filter @fredo/ui add -D vitest @testing-library/react @testing-library/jest-dom
 *
 * Component tests for SettingsPanel.
 *
 * #2817 — the decorative base-theme / animation controls were removed from the
 * legacy SettingsPanel tab, so the panel now exposes only the AI Model + Telemetry
 * tabs. The removed controls must render nowhere.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { SettingsPanel } from '../SettingsPanel';

// Mock child components so they render as simple indicators
vi.mock('../ModelSelector', () => ({
  ModelSelector: () => <div data-testid="model-selector">ModelSelector</div>,
}));

describe('SettingsPanel', () => {
  it('renders "AI Model" and "Telemetry" tab triggers', () => {
    renderWithChakra(<SettingsPanel />);

    expect(screen.getByText('AI Model')).toBeDefined();
    expect(screen.getByText('Telemetry')).toBeDefined();
  });

  it('renders no base-theme or animation controls (#2817 removal)', () => {
    renderWithChakra(<SettingsPanel />);

    // The removed base-theme and animation controls render nowhere.
    expect(screen.queryAllByTestId('theme-selector').length).toBe(0);
    expect(screen.queryAllByTestId('animation-selector').length).toBe(0);
  });

  it('switches to AI Model tab and renders ModelSelector', async () => {
    renderWithChakra(<SettingsPanel />);

    // Click the "AI Model" tab
    // Use getByRole to uniquely target the tab button (avoids multiple matches from Chakra v3 DOM)
    const aiModelTab = screen.getAllByRole('tab', { name: 'AI Model' })[0];
    await userEvent.click(aiModelTab);

    // After switching, ModelSelector should render
    await waitFor(() => {
      expect(screen.getAllByTestId('model-selector').length).toBeGreaterThanOrEqual(1);
    });
  });
});
