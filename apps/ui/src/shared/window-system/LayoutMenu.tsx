/**
 * LayoutMenu — named-layout management (Spec #2949 ST-5, R6 save / R7 restore).
 *
 * The Layout control that lives in the `WorkspaceToolbar`: a menu trigger
 * (`layout-menu-button`) that lists every saved layout as a restore control
 * (`layout-restore-<id>`) with a delete affordance (`layout-delete-<id>`), plus
 * a **Save current…** action (`layout-save`) that opens a name field
 * (`layout-name-input`).
 *
 * v1 management scope is save / restore / delete ONLY — no rename and no
 * set-default (binding convergence adjudication). Restore/delete/save all go
 * through the module-scoped `workspaceLayoutStore` actions; the store owns the
 * `Fredo_workspace_layout` persistence (debounced + gesture-suppressed) so this
 * component adds no extra wiring.
 *
 * Name validation happens HERE (the store still has a defensive fallback): a
 * name must be non-empty after trimming, at most `MAX_LAYOUT_NAME_LENGTH`
 * chars, and not duplicate (case-insensitive) an existing saved layout.
 *
 * Accessibility: the popup is a `role="menu"` (`aria-haspopup="menu"` on the
 * trigger); every control is a real tab-reachable `<button>`/`<input>`. Actions
 * are announced through the toolbar's single `aria-live="polite"` region via
 * the `onAnnounce` callback, so the workspace never renders two announcers.
 *
 * Token-native: every colour is a theme CSS var (`var(--header-bg)`,
 * `var(--card-hover-bg)`, `var(--border-color)`, `var(--text-*)`), a Chakra
 * semantic token, or a `tint()` color-mix. No hardcoded hex/rgba and no
 * `var(--x)NN` alpha-append.
 */

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Box, Text, chakra } from '@chakra-ui/react';

import { tint } from '../utils/colorTint';
import type { SavedLayout } from './paneLayout';
import { deleteLayout, restoreLayout, saveLayout } from './workspaceLayoutStore';

/** Longest accepted saved-layout name (mirrors the store's clamp). */
export const MAX_LAYOUT_NAME_LENGTH = 40;

export interface LayoutMenuProps {
  /** Saved arrangements, in store order. */
  savedLayouts: SavedLayout[];
  /** The currently-applied saved layout (highlighted), or `null` for ad-hoc. */
  activeLayoutId: string | null;
  /** Report an action in the toolbar's single `aria-live` region. */
  onAnnounce: (message: string) => void;
}

interface MenuItemProps {
  testId: string;
  label: string;
  active?: boolean;
  danger?: boolean;
  /** Share the row with a sibling (restore + delete). */
  grow?: boolean;
  /** Stay at its intrinsic width so a row sibling can grow. */
  shrink?: boolean;
  onClick: () => void;
  children: ReactNode;
}

/** One row inside the menu — a theme-token button. */
function MenuItem({
  testId,
  label,
  active,
  danger,
  grow,
  shrink,
  onClick,
  children,
}: MenuItemProps) {
  return (
    <chakra.button
      type="button"
      role="menuitem"
      data-testid={testId}
      aria-label={label}
      data-active={active ? 'true' : 'false'}
      onClick={onClick}
      css={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        minWidth: '0',
        width: grow || shrink ? 'auto' : '100%',
        flex: grow ? '1' : undefined,
        flexShrink: shrink ? 0 : undefined,
        padding: '5px 8px',
        borderRadius: '4px',
        border: 'none',
        background: active ? tint('var(--accent-primary)', 14) : 'transparent',
        color: danger
          ? 'var(--status-error)'
          : active
            ? 'var(--text-primary)'
            : 'var(--text-secondary)',
        fontFamily: 'var(--font-primary)',
        fontSize: '12px',
        textAlign: 'left',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        '&:hover': {
          background: danger
            ? tint('var(--status-error)', 14)
            : active
              ? tint('var(--accent-primary)', 20)
              : 'var(--card-hover-bg)',
          color: danger ? 'var(--status-error)' : 'var(--text-primary)',
        },
        '&:focus-visible': {
          outline: 'none',
          boxShadow: `0 0 0 2px ${tint('var(--accent-primary)', 40)}`,
        },
      }}
    >
      {children}
    </chakra.button>
  );
}

export function LayoutMenu({ savedLayouts, activeLayoutId, onAnnounce }: LayoutMenuProps) {
  const [open, setOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close the popup on an outside pointerdown (a fresh ref/id per render is
  // never an effect dep — only the `open` primitive is).
  useEffect(() => {
    if (!open) return undefined;
    function handlePointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
        setSaveOpen(false);
        setError(null);
      }
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  function closeMenu(): void {
    setOpen(false);
    setSaveOpen(false);
    setError(null);
  }

  function handleRestore(layout: SavedLayout): void {
    restoreLayout(layout.id);
    onAnnounce(`Restored layout ${layout.name}`);
    closeMenu();
  }

  function handleDelete(layout: SavedLayout): void {
    deleteLayout(layout.id);
    onAnnounce(`Deleted layout ${layout.name}`);
  }

  function handleSave(event: FormEvent): void {
    event.preventDefault();
    const trimmed = draftName.trim();
    if (trimmed.length === 0) {
      setError('Enter a layout name.');
      onAnnounce('A layout name is required.');
      return;
    }
    if (trimmed.length > MAX_LAYOUT_NAME_LENGTH) {
      setError(`Use ${MAX_LAYOUT_NAME_LENGTH} characters or fewer.`);
      onAnnounce(`Layout name must be ${MAX_LAYOUT_NAME_LENGTH} characters or fewer.`);
      return;
    }
    if (
      savedLayouts.some(
        (layout) => layout.name.trim().toLowerCase() === trimmed.toLowerCase(),
      )
    ) {
      setError('That name is already saved.');
      onAnnounce('A layout with that name already exists.');
      return;
    }
    const saved = saveLayout(trimmed);
    setDraftName('');
    setError(null);
    closeMenu();
    onAnnounce(`Saved layout ${saved.name}`);
  }

  return (
    <Box ref={rootRef} position="relative" display="inline-flex" pointerEvents="auto">
      <chakra.button
        type="button"
        data-testid="layout-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        css={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          padding: '3px 8px',
          borderRadius: '4px',
          border: '1px solid',
          borderColor: open ? 'var(--accent-primary)' : 'var(--border-color)',
          background: open ? tint('var(--accent-primary)', 12) : 'transparent',
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-primary)',
          fontSize: '11px',
          cursor: 'pointer',
          '&:hover': { background: 'var(--card-hover-bg)' },
          '&:focus-visible': {
            outline: 'none',
            boxShadow: `0 0 0 2px ${tint('var(--accent-primary)', 40)}`,
          },
        }}
      >
        Layout
        <Box as="span" aria-hidden="true" fontSize="9px" color="var(--text-secondary)">
          ▾
        </Box>
      </chakra.button>

      {open && (
        <Box
          role="menu"
          aria-label="Saved layouts"
          data-testid="layout-menu"
          position="absolute"
          top="100%"
          left="0"
          mt="1"
          minWidth="220px"
          maxWidth="280px"
          py="1"
          px="1"
          zIndex={60}
          bg="bg.surface"
          border="1px solid"
          borderColor="border.default"
          borderRadius="6px"
          boxShadow={`0 8px 24px ${tint('var(--accent-primary)', 14)}`}
          fontFamily="var(--font-primary)"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              closeMenu();
            }
          }}
        >
          {savedLayouts.length === 0 ? (
            <Text px="2" py="1.5" fontSize="12px" color="fg.muted" data-testid="layout-empty">
              No saved layouts
            </Text>
          ) : (
            <Box display="flex" flexDirection="column" gap="0.5">
              {savedLayouts.map((layout) => (
                <Box key={layout.id} display="flex" alignItems="center" gap="1" minWidth="0">
                  <MenuItem
                    testId={`layout-restore-${layout.id}`}
                    label={`Restore layout ${layout.name}`}
                    active={activeLayoutId === layout.id}
                    grow
                    onClick={() => handleRestore(layout)}
                  >
                    <Box
                      as="span"
                      flex="1"
                      minWidth="0"
                      overflow="hidden"
                      textOverflow="ellipsis"
                    >
                      {layout.name}
                    </Box>
                  </MenuItem>
                  <MenuItem
                    testId={`layout-delete-${layout.id}`}
                    label={`Delete layout ${layout.name}`}
                    danger
                    shrink
                    onClick={() => handleDelete(layout)}
                  >
                    <Box as="span" aria-hidden="true" fontSize="13px" lineHeight="1">
                      ×
                    </Box>
                  </MenuItem>
                </Box>
              ))}
            </Box>
          )}

          <Box h="1px" my="1" bg="border.default" role="separator" aria-orientation="horizontal" />

          {saveOpen ? (
            <Box as="form" px="1.5" py="1" onSubmit={handleSave} data-testid="layout-save-form">
              <chakra.input
                type="text"
                data-testid="layout-name-input"
                aria-label="Layout name"
                aria-invalid={error !== null}
                placeholder="Layout name"
                value={draftName}
                autoFocus
                onChange={(event) => {
                  setDraftName(event.target.value);
                  setError(null);
                }}
                css={{
                  width: '100%',
                  padding: '4px 8px',
                  borderRadius: '4px',
                  border: '1px solid',
                  borderColor: error ? 'var(--status-error)' : 'var(--border-color)',
                  background: 'var(--card-bg)',
                  color: 'var(--text-primary)',
                  fontFamily: 'var(--font-primary)',
                  fontSize: '12px',
                  '&:focus-visible': {
                    outline: 'none',
                    boxShadow: `0 0 0 2px ${tint('var(--accent-primary)', 40)}`,
                  },
                }}
              />
              {error && (
                <Text
                  data-testid="layout-name-error"
                  mt="1"
                  fontSize="11px"
                  color="status.error"
                  role="alert"
                >
                  {error}
                </Text>
              )}
              <Box display="flex" gap="1" mt="1.5">
                <chakra.button
                  type="submit"
                  data-testid="layout-save-confirm"
                  css={{
                    padding: '4px 10px',
                    borderRadius: '4px',
                    border: '1px solid',
                    borderColor: 'var(--accent-primary)',
                    background: tint('var(--accent-primary)', 18),
                    color: 'var(--text-primary)',
                    fontFamily: 'var(--font-primary)',
                    fontSize: '11px',
                    cursor: 'pointer',
                    '&:hover': { background: tint('var(--accent-primary)', 28) },
                    '&:focus-visible': {
                      outline: 'none',
                      boxShadow: `0 0 0 2px ${tint('var(--accent-primary)', 40)}`,
                    },
                  }}
                >
                  Save
                </chakra.button>
                <chakra.button
                  type="button"
                  data-testid="layout-save-cancel"
                  onClick={() => {
                    setSaveOpen(false);
                    setDraftName('');
                    setError(null);
                  }}
                  css={{
                    padding: '4px 10px',
                    borderRadius: '4px',
                    border: '1px solid',
                    borderColor: 'var(--border-color)',
                    background: 'transparent',
                    color: 'var(--text-secondary)',
                    fontFamily: 'var(--font-primary)',
                    fontSize: '11px',
                    cursor: 'pointer',
                    '&:hover': { background: 'var(--card-hover-bg)' },
                    '&:focus-visible': {
                      outline: 'none',
                      boxShadow: `0 0 0 2px ${tint('var(--accent-primary)', 40)}`,
                    },
                  }}
                >
                  Cancel
                </chakra.button>
              </Box>
            </Box>
          ) : (
            <MenuItem
              testId="layout-save"
              label="Save current layout"
              onClick={() => {
                setSaveOpen(true);
                setDraftName('');
                setError(null);
              }}
            >
              Save current…
            </MenuItem>
          )}
        </Box>
      )}
    </Box>
  );
}
