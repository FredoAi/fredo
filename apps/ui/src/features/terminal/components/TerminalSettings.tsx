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
 * key) and the default CLI (`terminal_default_cli`) that preselects a new
 * session. There is intentionally NO in-panel heading — the settings surface
 * sidebar already labels the section "Terminal". Both keys persist through the
 * unified Save footer (`useSettingsSave`).
 */
export const TerminalSettings: React.FC = () => {
  const [workDir, setWorkDir] = useState('');
  const [defaultCli, setDefaultCli] = useState<TerminalSessionKind>(DEFAULT_KIND);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    void (async () => {
      await ensureTerminalSettingsMigrated();
      const [savedDir, savedCli] = await Promise.all([
        settingsService.get<string>(WORK_DIR_KEY, ''),
        settingsService.get<string>(DEFAULT_CLI_KEY, DEFAULT_KIND),
      ]);
      if (savedDir) setWorkDir(savedDir);
      setDefaultCli(normalizeKind(savedCli));
    })();
  }, []);

  const handleSave = useCallback(async () => {
    setStatus(null);
    try {
      await settingsService.set(WORK_DIR_KEY, workDir);
      await settingsService.set(DEFAULT_CLI_KEY, defaultCli);
      setStatus({ ok: true, message: 'Saved.' });
    } catch (err) {
      setStatus({ ok: false, message: String(err) });
    }
  }, [workDir, defaultCli]);

  useSettingsSave(handleSave);

  return (
    <VStack align="stretch" gap={5} p={4}>
      <VStack align="stretch" gap={1}>
        <Text fontSize="sm" fontWeight="600" color="fg.default">Default CLI</Text>
        <Text fontSize="xs" color="fg.muted">
          New sessions start with this CLI preselected.
        </Text>
        <RadioCard.Root
          value={defaultCli}
          onValueChange={(details) => {
            setDefaultCli(normalizeKind(details.value));
            setStatus(null);
          }}
          orientation="horizontal"
          gap={3}
          mt={1}
        >
          <HStack align="stretch" gap={3}>
            <CliOption value="shell" selected={defaultCli === 'shell'} />
            <CliOption value="opencode" selected={defaultCli === 'opencode'} />
            <CliOption value="copilot" selected={defaultCli === 'copilot'} />
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
