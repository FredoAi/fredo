import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  Button,
  Dialog,
  HStack,
  Icon,
  Input,
  RadioCard,
  Skeleton,
  Text,
  VStack,
} from '@chakra-ui/react';
import { LuAppWindow, LuExternalLink } from 'react-icons/lu';
import type { IconType } from 'react-icons';
import { settingsService } from '../../settings';
import { useSettingsSave } from '../../settings/SettingsSaveContext';
import {
  ensureTerminalSettingsMigrated,
  DEFAULT_CLI_KEY,
  WORK_DIR_KEY,
} from '../settings';
import { DEFAULT_KIND, normalizeKind, type TerminalSessionKind } from '../sessionModel';
import type { TerminalSessionInfo } from '../sessionModel';
import { CliOption } from './CliOption';
import {
  getTerminalPresentation,
  hydrateTerminalPresentation,
  isTerminalPresentationHydrated,
  normalizePresentationMode,
  setTerminalPresentation,
  subscribeTerminalPresentation,
  useTerminalPresentation,
  type TerminalPresentation,
} from '../presentation';
import { adapterBridge } from '../../../shared/utils/adapterBridge';
import { closeWindow, getWindowSnapshot } from '../../../shared/window-system/windowStore';
import { tint } from '../../../shared/utils/colorTint';

/**
 * Settings → Terminal (auto-discovered via `hasSettings` — no shell edit).
 *
 * Three fields, all persisted through the unified Save footer
 * (`useSettingsSave`):
 *  - "Presentation" (`terminal_presentation_mode`, Spec #2947) — whether
 *    Terminal opens inside the main Fredo window (`same-window`) or in its own
 *    native window (`new-window`).
 *  - "Default session type" (`terminal_default_cli`)
 *  - "Working directory" (`terminal_work_dir`)
 *
 * Mode-change teardown (Spec #2947 ST-6, SI adjudication): when the mode
 * actually CHANGES and a live Terminal host exists, the user first confirms —
 * the change ends live sessions, so it is never silent (R-5.3). On confirm the
 * module store moves synchronously (R-1.1), the superseded in-window host is
 * dropped in the SAME tick (`closeWindow('terminal')`, before React can remount
 * it as a launcher), and the shipped `close_terminal_window` path tree-kills
 * every live session with records retained → resumable (R-5.1). Cancelling
 * aborts with nothing mutated. With NO live host the mode applies silently.
 *
 * The mode is consumed from the module-scoped presentation store
 * (`presentation.ts`) via `useSyncExternalStore` — never a `useEffect` +
 * `setState`, never an array `.length` dependency (#523 rule).
 */

/** One presentation choice — icon + title + indicator + border (never colour alone). */
const PresentationOption: React.FC<{
  value: TerminalPresentation;
  title: string;
  description: string;
  icon: IconType;
  selected: boolean;
}> = ({ value, title, description, icon, selected }) => (
  <RadioCard.Item value={value}>
    <RadioCard.ItemHiddenInput
      aria-checked={selected}
      data-testid={`terminal-presentation-mode-${value}`}
    />
    <RadioCard.ItemControl
      borderWidth="1px"
      borderColor="border.default"
      bg={selected ? tint('var(--accent-primary)', 12) : 'bg.surface'}
    >
      <RadioCard.ItemContent>
        <HStack gap={2}>
          <Icon as={icon} boxSize="16px" color="fg.muted" />
          <RadioCard.ItemText fontWeight="600" color="fg.default">
            {title}
          </RadioCard.ItemText>
        </HStack>
        <RadioCard.ItemDescription>
          <Text fontSize="xs" color="fg.muted">
            {description}
          </Text>
        </RadioCard.ItemDescription>
      </RadioCard.ItemContent>
      <RadioCard.ItemIndicator />
    </RadioCard.ItemControl>
  </RadioCard.Item>
);

/**
 * True when a live Terminal host exists: the in-window kernel workspace
 * (`terminal`) is open, or the backend holds at least one live session
 * (`starting`/`running`) — which covers the native `terminal` window host too.
 * The backend session list is the only host-agnostic probe available to the
 * main webview.
 */
async function hasLiveTerminalHost(): Promise<boolean> {
  if (getWindowSnapshot().some((w) => w.id === 'terminal')) return true;
  try {
    const sessions =
      await adapterBridge.invoke<TerminalSessionInfo[]>('list_terminal_sessions');
    return (sessions ?? []).some((s) => s.status === 'starting' || s.status === 'running');
  } catch {
    return false;
  }
}

export const TerminalSettings: React.FC = () => {
  const [workDir, setWorkDir] = useState('');
  const [defaultKind, setDefaultKind] = useState<TerminalSessionKind>(DEFAULT_KIND);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  // `null` = follow the persisted store; a value = the user's unsaved selection.
  const [draftMode, setDraftMode] = useState<TerminalPresentation | null>(null);
  // Non-null = the confirmation dialog is open for that pending mode.
  const [pendingMode, setPendingMode] = useState<TerminalPresentation | null>(null);

  const persistedMode = useTerminalPresentation();
  const hydrated = useSyncExternalStore(
    subscribeTerminalPresentation,
    isTerminalPresentationHydrated,
    isTerminalPresentationHydrated,
  );
  const displayedMode = draftMode ?? persistedMode;
  const dirty = draftMode !== null && draftMode !== persistedMode;

  useEffect(() => {
    void hydrateTerminalPresentation();
    void (async () => {
      await ensureTerminalSettingsMigrated();
      const [savedDir, savedKind] = await Promise.all([
        settingsService.get<string>(WORK_DIR_KEY, ''),
        settingsService.get<string>(DEFAULT_CLI_KEY, DEFAULT_KIND),
      ]);
      if (savedDir) setWorkDir(savedDir);
      setDefaultKind(normalizeKind(savedKind));
    })();
  }, []);

  /**
   * Persist every field. When `nextMode` is non-null the module store is moved
   * synchronously (R-1.1); `teardown` additionally ends the superseded host
   * through the shipped `closeWindow('terminal')` + `close_terminal_window`
   * path (R-5.1) — only ever reached behind the confirmation.
   */
  const persistSettings = useCallback(
    async (nextMode: TerminalPresentation | null, teardown: boolean) => {
      setStatus(null);
      try {
        await settingsService.set(WORK_DIR_KEY, workDir);
        await settingsService.set(DEFAULT_CLI_KEY, defaultKind);
        if (nextMode) {
          // Store-first: notify subscribers synchronously, then — when a live
          // host exists — drop the superseded in-window host in the SAME tick
          // (before React can remount it as a launcher) and tree-kill every
          // live session (records retained → resumable).
          const persisted = setTerminalPresentation(nextMode);
          if (teardown) {
            closeWindow('terminal');
            try {
              await adapterBridge.invoke('close_terminal_window');
            } catch {
              // Best-effort: the mode is already applied; a failed teardown
              // must not report the setting as unsaved.
            }
          }
          await persisted;
        }
        setDraftMode(null);
        setStatus({ ok: true, message: 'Saved.' });
      } catch {
        setStatus({ ok: false, message: "Couldn't save this setting. Try again." });
      }
    },
    [workDir, defaultKind],
  );

  const handleSave = useCallback(async () => {
    setStatus(null);
    const next = displayedMode;
    if (next !== getTerminalPresentation()) {
      const live = await hasLiveTerminalHost();
      if (live) {
        // R-5.3 — confirm before ending live sessions; nothing is mutated yet.
        setPendingMode(next);
        return;
      }
      // No live host: apply silently (no dialog, no teardown).
      await persistSettings(next, false);
      return;
    }
    await persistSettings(null, false);
  }, [displayedMode, persistSettings]);

  useSettingsSave(handleSave);

  const handleCancelModeChange = useCallback(() => {
    setPendingMode(null);
    setDraftMode(null); // revert to the persisted mode — nothing mutated
  }, []);

  const handleConfirmModeChange = useCallback(() => {
    const mode = pendingMode;
    setPendingMode(null);
    if (mode) void persistSettings(mode, true);
  }, [pendingMode, persistSettings]);

  return (
    <VStack align="stretch" gap={5} p={4}>
      <VStack align="stretch" gap={1}>
        <Text id="terminal-presentation-mode-label" fontSize="sm" fontWeight="600" color="fg.default">
          Presentation
        </Text>
        <Text id="terminal-presentation-mode-help" fontSize="xs" color="fg.muted">
          Where Terminal opens when you launch it.
        </Text>
        {!hydrated ? (
          <Skeleton
            data-testid="terminal-presentation-mode-loading"
            height="56px"
            borderRadius="md"
            mt={1}
          />
        ) : (
          <RadioCard.Root
            value={displayedMode}
            onValueChange={(details) => {
              setDraftMode(normalizePresentationMode(details.value));
              setStatus(null);
            }}
            orientation="horizontal"
            gap={3}
            mt={1}
            colorPalette="accent"
            data-testid="terminal-presentation-mode"
            aria-labelledby="terminal-presentation-mode-label"
            aria-describedby="terminal-presentation-mode-help"
          >
            <HStack align="stretch" gap={3} wrap="wrap">
              <PresentationOption
                value="same-window"
                title="Same window"
                description="Opens inside the main Fredo window."
                icon={LuAppWindow}
                selected={displayedMode === 'same-window'}
              />
              <PresentationOption
                value="new-window"
                title="Separate window"
                description="Opens in its own desktop window."
                icon={LuExternalLink}
                selected={displayedMode === 'new-window'}
              />
            </HStack>
          </RadioCard.Root>
        )}
        {dirty && (
          <Text
            data-testid="terminal-presentation-mode-hint"
            fontSize="xs"
            color="fg.muted"
          >
            Takes effect the next time Terminal opens.
          </Text>
        )}
      </VStack>

      <VStack align="stretch" gap={1}>
        <Text fontSize="sm" fontWeight="600" color="fg.default">Default session type</Text>
        <Text fontSize="xs" color="fg.muted">
          New sessions start as this type.
        </Text>
        <RadioCard.Root
          value={defaultKind}
          onValueChange={(details) => {
            setDefaultKind(normalizeKind(details.value));
            setStatus(null);
          }}
          orientation="horizontal"
          gap={3}
          mt={1}
        >
          <HStack align="stretch" gap={3} wrap="wrap">
            <CliOption value="shell" selected={defaultKind === 'shell'} />
            <CliOption value="opencode" selected={defaultKind === 'opencode'} />
            <CliOption value="copilot" selected={defaultKind === 'copilot'} />
          </HStack>
        </RadioCard.Root>
      </VStack>

      <VStack align="stretch" gap={1}>
        <Text fontSize="sm" fontWeight="600" color="fg.default">Working directory</Text>
        <Text fontSize="xs" color="fg.muted">Used to prefill new sessions. Blank = home folder.</Text>
        <Input
          size="sm"
          placeholder="C:\Users\you\my-repo"
          value={workDir}
          onChange={(e) => {
            setWorkDir(e.target.value);
            setStatus(null);
          }}
        />
      </VStack>

      {status && (
        <Text
          fontSize="xs"
          color={status.ok ? 'var(--status-success)' : 'var(--status-error)'}
        >
          {status.message}
        </Text>
      )}

      <Dialog.Root
        open={pendingMode !== null}
        onOpenChange={(details) => {
          if (!details.open) handleCancelModeChange();
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
              <Dialog.Title color="fg.default">Change presentation mode?</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Text fontSize="sm" color="fg.muted">
                Changing this ends your live terminal sessions. They stay resumable — you can
                reopen them from the previous-sessions list. The new mode applies the next time
                Terminal opens.
              </Text>
            </Dialog.Body>
            <Dialog.Footer gap={2}>
              <Button
                variant="ghost"
                size="sm"
                color="var(--text-secondary)"
                onClick={handleCancelModeChange}
                data-testid="terminal-presentation-mode-cancel"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                background="var(--accent-primary)"
                color="var(--accent-contrast)"
                _hover={{ opacity: 0.9 }}
                onClick={handleConfirmModeChange}
                data-testid="terminal-presentation-mode-confirm"
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
