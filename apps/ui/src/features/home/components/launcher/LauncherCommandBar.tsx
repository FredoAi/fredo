/**
 * Fredo launcher command bar (Spec #2808 ST-3).
 *
 * The `>` search-or-command input (desktop.png): a centered, ~560px max-width
 * native-capable Chakra text input with an accent `>` chevron prefix and a
 * muted monoweight magnifier suffix. This is a CONTROLLED component — the host
 * owns the query string and the grid filtering; this component renders the
 * query and reports changes up via `onQueryChange`. It is a launcher grid
 * filter, NOT a global command dispatcher (per the ST-3 non-goals), and it is
 * drawn with a native-capable Chakra `Input` (never `NativeSelect`).
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

/** Muted monoweight magnifier suffix (currentColor). */
function MagnifierGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="4.25" stroke="currentColor" strokeWidth="1.3" />
      <line
        x1="9.4"
        y1="9.4"
        x2="12.2"
        y2="12.2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function LauncherCommandBar({
  query,
  onQueryChange,
  gridOpen = false,
  ariaActivedescendant,
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
          <Box as="span" color="fg.muted" display="flex" alignItems="center" aria-hidden="true">
            <MagnifierGlyph />
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
            outline: 'none',
          }}
        />
      </InputGroup>
    </Box>
  );
}
