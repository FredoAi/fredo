import React, { useCallback, useEffect, useState } from 'react';
import { HStack, Input, RadioCard, Text, VStack } from '@chakra-ui/react';
import { settingsService } from '../../settings';
import { useSettingsSave } from '../../settings/SettingsSaveContext';
import {
  ensureTerminalSettingsMigrated,
  DEFAULT_CLI_KEY,
  WORK_DIR_KEY,
} from '../settings';
import { DEFAULT_KIND, normalizeKind, type TerminalSessionKind } from '../sessionModel';
import { CliOption } from './CliOption';

/**
 * Settings → Terminal (auto-discovered via `hasSettings` — no shell edit).
 *
 * Two fields, persisted through the unified Save footer (`useSettingsSave`):
 *  - "Default session type" (`terminal_default_cli`)
 *  - "Working directory" (`terminal_work_dir`)
 *
 * The Terminal presentation control (Spec #2947) was SUBSUMED by the platform-
 * wide Settings → Apps section (Spec #2955 ST-3): Terminal is now one row there,
 * so this panel no longer offers a Main/Own choice and no longer owns the
 * confirm-before-ending-sessions dialog. There is exactly ONE presentation
 * control in the product. The terminal session/PTY model is untouched.
 */
export const TerminalSettings: React.FC = () => {
  const [workDir, setWorkDir] = useState('');
  const [defaultKind, setDefaultKind] = useState<TerminalSessionKind>(DEFAULT_KIND);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
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

  /** Persist both fields through the unified Save footer. */
  const handleSave = useCallback(async () => {
    setStatus(null);
    try {
      await settingsService.set(WORK_DIR_KEY, workDir);
      await settingsService.set(DEFAULT_CLI_KEY, defaultKind);
      setStatus({ ok: true, message: 'Saved.' });
    } catch {
      setStatus({ ok: false, message: "Couldn't save this setting. Try again." });
    }
  }, [workDir, defaultKind]);

  useSettingsSave(handleSave);

  return (
    <VStack align="stretch" gap={5} p={4}>
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
    </VStack>
  );
};
