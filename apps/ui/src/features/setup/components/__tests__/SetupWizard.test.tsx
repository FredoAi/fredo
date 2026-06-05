/**
 * PREREQUISITE:
 * This test file uses vitest + @testing-library/react.
 * Install with: pnpm --filter @fredo/ui add -D vitest @testing-library/react @testing-library/jest-dom
 *
 * Component tests for SetupWizard.
 *
 * REQ-COMP-1: SetupWizard renders all 6 step cards with labels and action buttons
 * for idle steps under the mocked environment.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithChakra } from '@/shared/test-utils/renderWithChakra';
import { SetupWizard } from '../SetupWizard';

// Mock adapterBridge — all checks resolve to { in_path: true } so that
// check_fredo_path returns 'done' and other steps (which look for different
// response keys) fall through to 'idle'.
vi.mock('@/shared/utils/adapterBridge', () => ({
  adapterBridge: {
    invoke: vi.fn().mockResolvedValue({ in_path: true }),
    listen: vi.fn().mockResolvedValue(() => {}),
  },
}));

describe('SetupWizard', () => {
  it('renders all 6 step cards with labels', async () => {
    renderWithChakra(<SetupWizard />);

    // Step labels are always present in the DOM regardless of async status
    expect(screen.getByText('Fredo Path')).toBeInTheDocument();
    expect(screen.getByText('OpenCode CLI')).toBeInTheDocument();
    expect(screen.getByText('Plugin Build')).toBeInTheDocument();
    expect(screen.getByText('Plugin Install')).toBeInTheDocument();
    expect(screen.getByText('Model Download')).toBeInTheDocument();
    expect(screen.getByText('OTel Config')).toBeInTheDocument();
  });

  it('renders action buttons for idle steps after async check resolves', async () => {
    renderWithChakra(<SetupWizard />);

    // Wait for async checks to resolve — at least one idle button appears
    // 'Install' label appears twice (OpenCode CLI + Plugin Install), use getAllByText
    await waitFor(() => {
      expect(screen.getAllByText('Install').length).toBeGreaterThanOrEqual(1);
    });

    expect(screen.getByText('Build')).toBeInTheDocument();            // Plugin Build
    expect(screen.getByText('Download')).toBeInTheDocument();         // Model Download
    expect(screen.getByText('Configure')).toBeInTheDocument();        // OTel Config
  });
});
