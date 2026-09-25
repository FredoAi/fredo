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
 * Exposes the working directory (`terminal_work_dir`, migrated from the legacy
 * key) and the default session TYPE (`terminal_default_cli`, whose value domain
 * now includes the plain-shell `'shell'` kind) that preselects a new session.
 * There is intentionally NO in-panel heading — the settings surface sidebar
 * already labels the section "Terminal". Both keys persist through the unified
 * Save footer (`useSettingsSave`).
 *
 * Changing a default writes ONLY those two setting keys — it never mutates a
 * live session or a persisted record (Spec 2942 R-4.3).
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

  const handleSave = useCallback(async () => {
    setStatus(null);
    try {
      await settingsService.set(WORK_DIR_KEY, workDir);
      await settingsService.set(DEFAULT_CLI_KEY, defaultKind);
      setStatus({ ok: true, message: 'Saved.' });
    } catch (err) {
      setStatus({ ok: false, message: String(err) });
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
