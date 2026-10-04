import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  Box,
  Button,
  Dialog,
  HStack,
  Heading,
  Icon,
  RadioCard,
  Skeleton,
  Text,
  VStack,
} from '@chakra-ui/react';
import { LuAppWindow, LuCircleAlert, LuCircleCheck, LuExternalLink, LuInfo } from 'react-icons/lu';
import type { IconType } from 'react-icons';
import { dedupeByFeatureId, getFeatures } from '../../featureRegistry';
import {
  DEFAULT_APP_PRESENTATION,
  getAppPresentation,
  hydrateAppPresentation,
  isAppPresentationHydrated,
  normalizeAppPresentation,
  setAppPresentation,
  subscribeAppPresentation,
  useAppPresentationMap,
  type AppPresentation,
} from '../../../shared/window-system/appPresentationStore';
import { closeAppOwnWindow } from '../../../shared/window-system/appWindows';
import { useWindowActions } from '../../../shared/window-system/useWindowActions';
import { adapterBridge } from '../../../shared/utils/adapterBridge';
import { getWindowSnapshot } from '../../../shared/window-system/windowStore';
import { tint } from '../../../shared/utils/colorTint';

/**
 * Settings → Apps (Spec #2955 ST-3) — the ONE place a user chooses, per app,
 * whether it opens inside the main Fredo window ("Main window" /
 * `same-window`) or in its own separate OS window ("Own window" /
 * `new-window`). This subsumes #2947's Terminal-only presentation control:
 * Terminal is now just one row here, so there are never two competing controls.
 *
 * Write-through, no Save footer: selecting a mode moves the module-scoped
 * presentation store synchronously (`setAppPresentation`, optimistic) and then
 * tears down the superseded host — the in-window entry via `closeWindow(id)`
 * and the native window via `closeAppOwnWindow(id)` (both idempotent).
 *
 * Terminal is special only in that a live host (in-window workspace or a live
 * backend session) must be confirmed before its sessions end: the shipped
 * `hasLiveTerminalHost()` probe moved here from `TerminalSettings.tsx`. Cancel
 * mutates nothing; Confirm applies the mode + teardown. Every other app has no
 * confirm (its teardown is cheap).
 *
 * Re-render hygiene (#523): the registry slice is a `useMemo(..., [])` (the
 * registry is immutable after startup) and the store is read through
 * `useSyncExternalStore` — never `useEffect` + `setState`, never an array
 * `.length` dependency.
 */

/** The Terminal feature id — the one row that owns a live-session confirm. */
const TERMINAL_APP_ID = 'terminal';

/**
 * The minimal backend session shape the live-host probe reads. Kept local so the
 * settings shell never imports another feature's model.
 */
interface TerminalSessionStatusRow {
  status: string;
}

/**
 * True when a live Terminal host exists: the in-window kernel workspace
 * (`terminal`) is open, or the backend holds at least one live session
 * (`starting`/`running`) — which covers the native `terminal` window host too.
 * The backend session list is the only host-agnostic probe available to the
 * main webview. Moved verbatim from `TerminalSettings.tsx` (#2947 → #2955 ST-3).
 */
async function hasLiveTerminalHost(): Promise<boolean> {
  if (getWindowSnapshot().some((w) => w.id === TERMINAL_APP_ID)) return true;
  try {
    const sessions =
      await adapterBridge.invoke<TerminalSessionStatusRow[]>('list_terminal_sessions');
    return (sessions ?? []).some((s) => s.status === 'starting' || s.status === 'running');
  } catch {
    return false;
  }
}

/**
 * One presentation choice — icon + title + indicator (never colour alone). A
 * disabled option (the factory app's "Own window") reads as intentionally
 * unavailable, not broken: dashed border, muted, `not-allowed` cursor.
 */
const ModeOption: React.FC<{
  appId: string;
  value: AppPresentation;
  title: string;
  icon: IconType;
  selected: boolean;
  disabled?: boolean;
}> = ({ appId, value, title, icon, selected, disabled = false }) => (
  <RadioCard.Item value={value} disabled={disabled}>
    <RadioCard.ItemHiddenInput
      aria-checked={selected}
      data-testid={`app-presentation-mode-${appId}-${value}`}
    />
    <RadioCard.ItemControl
      borderWidth="1px"
      borderRadius="md"
      borderStyle={disabled ? 'dashed' : 'solid'}
      borderColor={selected ? 'var(--accent-primary)' : 'border.default'}
      bg={selected ? tint('var(--accent-primary)', 12) : 'bg.surface'}
      opacity={disabled ? 0.55 : 1}
      cursor={disabled ? 'not-allowed' : 'pointer'}
      transition="background 0.15s ease, border-color 0.15s ease"
      _hover={disabled ? undefined : { borderColor: 'var(--accent-primary)' }}
      _focusWithin={{ outline: '2px solid var(--accent-primary)', outlineOffset: '2px' }}
    >
      <HStack gap={2}>
        <Icon as={icon} boxSize="16px" color="fg.muted" />
        <RadioCard.ItemText fontWeight="600" color={disabled ? 'fg.muted' : 'fg.default'}>
          {title}
        </RadioCard.ItemText>
      </HStack>
      <RadioCard.ItemIndicator />
    </RadioCard.ItemControl>
  </RadioCard.Item>
);

interface AppRowProps {
  appId: string;
  name: string;
  icon: IconType;
  mode: AppPresentation;
  disabled: boolean;
  onSelect: (appId: string, mode: AppPresentation) => void;
}

/**
 * One app's control strip: identity left, a two-up Main/Own toggle right.
 * Primitive props + `React.memo` so N rows stay cheap; no fresh-object churn.
 */
const AppRow = React.memo(function AppRow({
  appId,
  name,
  icon,
  mode,
  disabled,
  onSelect,
}: AppRowProps) {
  return (
    <Box
      data-testid={`app-presentation-row-${appId}`}
      px={5}
      py={3}
      borderBottom="1px solid"
      borderColor="border.subtle"
      _last={{ borderBottom: 'none' }}
    >
      <HStack align="center" justify="space-between" gap={4}>
        <HStack gap={3} minW={0}>
          <Icon as={icon} boxSize="18px" color="fg.muted" flexShrink={0} />
          <Text
            id={`app-presentation-row-${appId}-label`}
            fontWeight="600"
            color="fg.default"
            truncate
          >
            {name}
          </Text>
        </HStack>
        <RadioCard.Root
          value={mode}
          onValueChange={(details) => onSelect(appId, normalizeAppPresentation(details.value))}
          orientation="horizontal"
          gap={2}
          aria-labelledby={`app-presentation-row-${appId}-label`}
          data-testid={`app-presentation-mode-${appId}`}
        >
          <HStack gap={2}>
            <ModeOption
              appId={appId}
              value="same-window"
              title="Main window"
              icon={LuAppWindow}
              selected={mode === 'same-window'}
            />
            <ModeOption
              appId={appId}
              value="new-window"
              title="Own window"
              icon={LuExternalLink}
              selected={mode === 'new-window'}
              disabled={disabled}
            />
          </HStack>
        </RadioCard.Root>
      </HStack>
      {disabled && (
        <HStack
          data-testid={`app-presentation-multi-window-note-${appId}`}
          gap={2}
          mt={2}
          bg={tint('var(--status-info)', 10)}
          borderWidth="1px"
          borderColor={tint('var(--status-info)', 30)}
          borderRadius="md"
          px={3}
          py={2}
        >
          <Icon as={LuInfo} color="var(--status-info)" boxSize="14px" flexShrink={0} />
          <Text fontSize="xs" color="fg.muted">
            This app opens multiple independent views, so it can&apos;t share one window. It always
            opens in the main Fredo window.
          </Text>
        </HStack>
      )}
    </Box>
  );
});

export const AppPresentationSettings: React.FC = () => {
  // Computed once — the registry is immutable after startup (same rationale as
  // SettingsSurface's feature-tab memo).
  const apps = useMemo(() => dedupeByFeatureId(getFeatures()).filter((f) => f.showable), []);
  // Stable `useSyncExternalStore` snapshot; re-renders only on a real mutation.
  const map = useAppPresentationMap();
  const hydrated = useSyncExternalStore(
    subscribeAppPresentation,
    isAppPresentationHydrated,
    isAppPresentationHydrated,
  );
  const { closeWindow } = useWindowActions();

  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);
  // Non-null = the Terminal confirm dialog is open for that pending mode.
  const [pending, setPending] = useState<{ appId: string; mode: AppPresentation } | null>(null);

  // Hydrate once on mount — no state write, so no effect loop.
  useEffect(() => {
    void hydrateAppPresentation();
  }, []);

  const commit = useCallback(
    (appId: string, mode: AppPresentation) => {
      setStatus(null);
      // Optimistic + store-first: the radio repaints synchronously, then the
      // superseded in-window host is dropped in the same tick (before React can
      // remount it), then the native host is closed (best-effort — a failed
      // teardown must not report the setting as unsaved).
      const persisted = setAppPresentation(appId, mode);
      closeWindow(appId);
      void closeAppOwnWindow(appId).catch(() => {
        // Best-effort: the mode is already applied.
      });
      persisted
        .then(() => {
          const name = apps.find((f) => f.id === appId)?.name ?? appId;
          setStatus({
            kind: 'ok',
            message:
              mode === 'new-window'
                ? `${name} now opens in its own window.`
                : `${name} now opens in the main window.`,
          });
        })
        .catch(() => {
          setStatus({ kind: 'error', message: "Couldn't save that choice. Try again." });
        });
    },
    [apps, closeWindow],
  );

  const handleSelect = useCallback(
    (appId: string, mode: AppPresentation) => {
      setStatus(null);
      if (mode === getAppPresentation(appId)) {
        // Selecting the persisted mode is a no-op — and clears any stale
        // confirm for this app (defensive; the modal normally blocks this).
        setPending((current) => (current && current.appId === appId ? null : current));
        return;
      }
      if (appId === TERMINAL_APP_ID) {
        void hasLiveTerminalHost().then((live) => {
          if (live) {
            // R-5.3 — confirm before ending live sessions; nothing mutated yet.
            setPending({ appId, mode });
            return;
          }
          commit(appId, mode);
        });
        return;
      }
      commit(appId, mode);
    },
    [commit],
  );

  const handleCancel = useCallback(() => setPending(null), []);
  const handleConfirm = useCallback(() => {
    const current = pending;
    setPending(null);
    if (current) commit(current.appId, current.mode);
  }, [pending, commit]);

  return (
    <VStack data-testid="app-presentation-settings" align="stretch" gap={0} p={0}>
      <VStack align="stretch" gap={1} px={5} pt={5} pb={3}>
        <Heading as="h2" size="md" fontFamily="heading" color="fg.default">
          Apps
        </Heading>
        <Text fontSize="sm" color="fg.muted">
          Choose where each app opens. Changes apply immediately.
        </Text>
      </VStack>

      {/* ONE live region for the whole section (always mounted). */}
      <Box
        role="status"
        aria-live="polite"
        data-testid="app-presentation-status"
        px={5}
        pb={2}
        minH="20px"
      >
        {status && (
          <HStack
            gap={2}
            color={status.kind === 'ok' ? 'var(--status-success)' : 'var(--status-error)'}
          >
            <Icon
              as={status.kind === 'ok' ? LuCircleCheck : LuCircleAlert}
              boxSize="14px"
              flexShrink={0}
            />
            <Text fontSize="xs">{status.message}</Text>
          </HStack>
        )}
      </Box>

      {!hydrated ? (
        <VStack data-testid="app-presentation-loading" align="stretch" gap={0}>
          {[0, 1, 2].map((row) => (
            <HStack
              key={row}
              px={5}
              py={3}
              gap={4}
              borderBottom="1px solid"
              borderColor="border.subtle"
            >
              <Skeleton boxSize="18px" borderRadius="full" />
              <Skeleton height="14px" width="120px" />
              <Skeleton height="40px" width="240px" borderRadius="md" ml="auto" />
            </HStack>
          ))}
        </VStack>
      ) : apps.length === 0 ? (
        <Text px={5} py={3} fontSize="sm" color="fg.muted">
          No apps can be configured yet.
        </Text>
      ) : (
        apps.map((feature) => {
          const disabled = feature.isMultiWindow === true;
          // Factory apps always resolve to the main-window default (belt-and-
          // suspenders with the store's own factory normalization).
          const persisted = disabled
            ? DEFAULT_APP_PRESENTATION
            : (map[feature.id] ?? DEFAULT_APP_PRESENTATION);
          const mode =
            pending && pending.appId === feature.id ? pending.mode : persisted;
          return (
            <AppRow
              key={feature.id}
              appId={feature.id}
              name={feature.name}
              icon={feature.icon}
              mode={mode}
              disabled={disabled}
              onSelect={handleSelect}
            />
          );
        })
      )}

      <Dialog.Root
        open={pending !== null}
        onOpenChange={(details) => {
          if (!details.open) handleCancel();
        }}
      >
        <Dialog.Backdrop bg="var(--overlay-bg)" />
        <Dialog.Positioner>
          <Dialog.Content
            maxW="md"
            background="var(--card-bg)"
            borderColor="var(--border-color)"
            borderWidth="1px"
            borderRadius="lg"
          >
            <Dialog.Header>
              <Dialog.Title color="fg.default">Change where Terminal opens?</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Text fontSize="sm" color="fg.muted">
                Changing this ends your live terminal sessions. They stay resumable — you can
                reopen them from the previous-sessions list.
              </Text>
            </Dialog.Body>
            <Dialog.Footer gap={2}>
              <Button
                variant="ghost"
                size="sm"
                color="var(--text-secondary)"
                onClick={handleCancel}
                data-testid="app-presentation-change-cancel"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                background="var(--accent-primary)"
                color="var(--accent-contrast)"
                _hover={{ opacity: 0.9 }}
                onClick={handleConfirm}
                data-testid="app-presentation-change-confirm"
              >
                Change and end sessions
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Dialog.Root>
    </VStack>
  );
};
