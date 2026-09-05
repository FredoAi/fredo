/**
 * Fredo launcher command bar (Spec #2808 ST-3).
 *
 * The `>` search-or-command input (desktop-light.png): a centered, ~560px
 * max-width native-capable Chakra text input with an accent `>` chevron prefix
 * and a `—` MINIMIZE control at the right edge (a vertical divider + a short
 * dash whose click collapses the launcher to bare chrome via `onMinimize`).
 * This is a CONTROLLED component — the host owns the query string and the grid
 * filtering; this component renders the query and reports changes up via
 * `onQueryChange`. It is a launcher grid filter, NOT a global command
 * dispatcher (per the ST-3 non-goals), and it is drawn with a native-capable
 * Chakra `Input` (never `NativeSelect`). `onFocus`/`onBlur` report the
 * reached/left-engaged signals to the host (#2819).
 *
 * Token-native contract (AC5): every color is a theme CSS var referenced
 * directly (`var(--card-bg)`, `var(--border-color)`, `var(--accent-primary)`),
 * a Chakra semantic token (`accent.default`, `fg.default`, `fg.muted`), or a
 * shared `tint()` color-mix. There is NO hardcoded hex/rgba and NO
 * `var(--x)NN` alpha-append anywhere in this file.
 */

import type { ChangeEvent } from 'react';
import { Box, Input, InputGroup } from '@chakra-ui/react';

export interface LauncherCommandBarProps {
  /** Live query string (controlled by the host). */
  query: string;
  /** Reports every query change up to the host (the host filters the grid). */
  onQueryChange: (q: string) => void;
  /** Whether the launcher grid is open — drives `aria-expanded`. */
  gridOpen?: boolean;
  /** Active grid tile id during grid roving-tabindex focus — drives `aria-activedescendant`. */
  ariaActivedescendant?: string;
  /** Reached-engaged signal: the input received focus (#2819 — host reveals the grid). */
  onFocus?: () => void;
  /** Leaves-engaged signal: the input lost focus (#2819 — the host guards focus-within). */
  onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
  /** The `—` minimize control was clicked (#2819 — host collapses the shell to bare chrome). */
  onMinimize?: () => void;
}

/** Accent `>` chevron prefix (monoweight, currentColor). */
function ChevronGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M4.5 2.5 8 6l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Wireframe `—` MINIMIZE dash (a short horizontal bar, muted `currentColor`). */
function MinusGlyph() {
  return (
    <Box as="span" width="12px" height="1.5px" borderRadius="1px" bg="currentColor" aria-hidden="true" />
  );
}

export function LauncherCommandBar({
  query,
  onQueryChange,
  gridOpen = false,
  ariaActivedescendant,
  onFocus,
  onBlur,
  onMinimize,
}: LauncherCommandBarProps) {
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => onQueryChange(e.target.value);

  return (
    <Box display="flex" justifyContent="center" w="100%" px="4">
      <InputGroup
        width="100%"
        maxWidth="560px"
        startElement={
          <Box as="span" color="accent.default" display="flex" alignItems="center" aria-hidden="true">
            <ChevronGlyph />
          </Box>
        }
        endElement={
          <Box
            as="button"
            aria-label="Minimize launcher"
            onClick={onMinimize}
            onMouseDown={(e) => e.preventDefault()}
            display="flex"
            alignItems="center"
            height="100%"
            pl="10px"
            ml="10px"
            borderLeft="1px solid"
            borderLeftColor="var(--border-color)"
            color="var(--text-secondary)"
            cursor={onMinimize ? 'pointer' : 'default'}
            _hover={onMinimize ? { color: 'accent.default' } : undefined}
            css={{
              '&:focus-visible': { outline: '2px solid var(--accent-primary)', outlineOffset: '2px' },
            }}
          >
            <MinusGlyph />
          </Box>
        }
      >
        <Input
          role="searchbox"
          aria-label="Search or command"
          aria-expanded={gridOpen}
          aria-controls="fredo-launcher-grid"
          aria-activedescendant={ariaActivedescendant}
          placeholder="search or command"
          value={query}
          onChange={handleChange}
          onFocus={onFocus}
          onBlur={onBlur}
          bg="var(--card-bg)"
          border="1px solid"
          borderColor="var(--border-color)"
          borderRadius="8px"
          height="48px"
          fontFamily="var(--font-primary)"
          fontSize="14px"
          fontWeight="regular"
          color="fg.default"
          _placeholder={{ color: 'fg.muted' }}
          _hover={{ borderColor: 'var(--accent-primary)' }}
          _focus={{
            borderColor: 'var(--accent-primary)',
            boxShadow: 'none',
            outline: 'none',
          }}
          _focusVisible={{
            borderColor: 'var(--accent-primary)',
            boxShadow: 'none',
            outline: '2px solid var(--accent-primary)',
            outlineOffset: '2px',
          }}
        />
      </InputGroup>
    </Box>
  );
}
