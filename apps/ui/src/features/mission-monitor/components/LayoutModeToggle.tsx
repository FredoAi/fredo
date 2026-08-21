import React, { useCallback, useRef } from 'react';
import { Button } from '@chakra-ui/react';
import type { LayoutMode } from '../lib/layout';

// ── #2752 ST-3: Chain/Force layout toggle (EARS-1, EARS-5, EARS-7) ─────────────
//
// Floating segmented control overlaying the Mission Monitor canvas
// (mm-canvas-wrapper, MissionMonitorPanel.tsx:829-831). Pure-prop like
// SessionTokenBar: the panel owns the persisted state
// (usePersistedSetting<LayoutMode>(LAYOUT_MODE_KEY, 'chain', serializeValue)) and
// passes `mode` + `onChange` down; this component renders the DOM and the a11y
// contract only (AC5 / EARS-7).
//
// Design decisions (UI/UX spec §2 — binding):
//  - Explicit Chakra v3 `Button`s with `aria-pressed`, NOT `SegmentGroup.Root`:
//    AC5 literally requires `aria-pressed` on the active option, and a
//    SegmentGroup's Zag radio-group machine exposes `role="radio"` +
//    `aria-checked` — never `aria-pressed`. Explicit buttons also give
//    byte-exact control over every state surface through Fredo's `var(--*)`
//    tokens (NFR-1). NO `variant` on the buttons: the global
//    `button[data-variant="outline"]` borderColor rule (system.ts) would
//    otherwise override the active/inactive border contract.
//  - Roving tabindex (segmented-control pattern): Tab enters at the ACTIVE
//    option (tabIndex 0), ArrowRight/ArrowDown move to the next option AND
//    select it (optimistic — selection follows focus, no wrap), ArrowLeft/
//    ArrowUp move back, Home/End jump to first/last, Space/Enter select
//    natively (button default). Re-click on the active option is a no-op
//    (toggle semantics — there is no "none" state).
//  - `className="nowheel"` (ReactFlow noWheelClassName,
//    MissionMonitorPanel.tsx:532): wheel over the toggle must not zoom the
//    canvas.
//  - Theming: every color resolves through theme tokens only (var(--card-bg),
//    var(--border-color), var(--body-bg), var(--text-primary),
//    var(--text-secondary), var(--accent-primary) + alpha suffixes) — zero
//    hardcoded hex/rgba in feature source (NFR-1; guard at
//    MissionMonitorPanel.test.tsx:325-337).

export interface LayoutModeToggleProps {
  mode: LayoutMode;
  onChange: (mode: LayoutMode) => void;
}

/** The two options, in display order (left = chain, right = force). */
const OPTIONS: ReadonlyArray<{ value: LayoutMode; label: string }> = [
  { value: 'chain', label: 'Chain' },
  { value: 'force', label: 'Force' },
];

/** Shared option-button chrome (UI/UX §2 table — binding). */
const OPTION_BASE_PROPS = {
  size: 'sm' as const,
  fontSize: '10px',
  fontWeight: 600,
  letterSpacing: '0.02em',
  paddingInline: '10px',
  height: '22px',
  borderRadius: 4,
  // Focus-visible: accent ring visible on both light and dark themes.
  _focusVisible: {
    boxShadow: '0 0 0 2px var(--accent-primary)66',
    outline: 'none',
  },
} as const;

export const LayoutModeToggle: React.FC<LayoutModeToggleProps> = ({ mode, onChange }) => {
  // Roving-tabindex focus registry: after an arrow key selects a new option,
  // move DOM focus to the newly-active button (focus follows selection).
  const buttonRefs = useRef<Partial<Record<LayoutMode, HTMLButtonElement | null>>>({});

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      const currentIndex = OPTIONS.findIndex((o) => o.value === mode);
      let nextIndex = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        nextIndex = currentIndex + 1;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        nextIndex = currentIndex - 1;
      } else if (e.key === 'Home') {
        nextIndex = 0;
      } else if (e.key === 'End') {
        nextIndex = OPTIONS.length - 1;
      } else {
        // Space/Enter select natively (button default) — no interception.
        return;
      }
      e.preventDefault();
      // No wrap: arrows at the ends are no-ops (Home/End jump explicitly).
      if (nextIndex < 0 || nextIndex >= OPTIONS.length) return;
      const next = OPTIONS[nextIndex].value;
      if (next === mode) return;
      onChange(next);
      buttonRefs.current[next]?.focus();
    },
    [mode, onChange],
  );

  return (
    <div
      role="group"
      aria-label="Layout mode"
      data-testid="mm-layout-toggle"
      className="nowheel"
      style={{
        position: 'absolute',
        top: 10,
        left: 10,
        zIndex: 10,
        display: 'inline-flex',
        gap: 2,
        padding: 3,
        background: 'var(--card-bg)',
        border: '1px solid var(--border-color)',
        borderRadius: 6,
        // Dark halo in light theme / light halo in dark theme (same trick as
        // the MiniMap maskColor var(--body-bg)99, MissionMonitorPanel.tsx:563).
        boxShadow: '0 2px 10px var(--body-bg)88',
      }}
    >
      {OPTIONS.map((option) => {
        const active = option.value === mode;
        return (
          <Button
            key={option.value}
            ref={(el) => {
              buttonRefs.current[option.value] = el;
            }}
            {...OPTION_BASE_PROPS}
            aria-pressed={active}
            tabIndex={active ? 0 : -1}
            onClick={() => {
              // Re-click on the active option is a no-op (no "none" state).
              if (option.value !== mode) onChange(option.value);
            }}
            onKeyDown={handleKeyDown}
            background={active ? 'var(--accent-primary)22' : 'transparent'}
            color={active ? 'var(--accent-primary)' : 'var(--text-secondary)'}
            border={active ? '1px solid var(--accent-primary)55' : '1px solid transparent'}
            _hover={
              active
                ? { background: 'var(--accent-primary)22' } // already pressed — unchanged
                : { color: 'var(--text-primary)', borderColor: 'var(--accent-primary)88' }
            }
          >
            {option.label}
          </Button>
        );
      })}
    </div>
  );
};
