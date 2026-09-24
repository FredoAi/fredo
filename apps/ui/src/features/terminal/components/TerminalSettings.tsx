import React, { useState, useCallback, useEffect } from 'react';
import { VStack, HStack, Text, Input } from '@chakra-ui/react';
import { settingsService } from '../../settings';
import { useSettingsSave } from '../../settings/SettingsSaveContext';
import { ensureTerminalSettingsMigrated, WORK_DIR_KEY } from '../settings';

export const TerminalSettings: React.FC = () => {
  const [workDir, setWorkDir] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    void (async () => {
      await ensureTerminalSettingsMigrated();
      const v = await settingsService.get<string>(WORK_DIR_KEY, '');
      if (v) setWorkDir(v);
    })();
  }, []);

  const handleSave = useCallback(async () => {
    setStatus(null);
    try {
      await settingsService.set(WORK_DIR_KEY, workDir);
      setStatus({ ok: true, message: 'Saved.' });
    } catch (err) {
      setStatus({ ok: false, message: String(err) });
    }
  }, [workDir]);

  useSettingsSave(handleSave);

  return (
    <VStack align="stretch" gap={4} p={4}>
      <VStack align="stretch" gap={1}>
        <Text fontSize="xs" color="var(--text-secondary)">Working Directory</Text>
        <Text fontSize="xs" color="var(--text-muted)">Directory the CLI runs in (blank = home folder).</Text>
        <Input
          size="sm"
          placeholder="C:\Users\you\my-repo"
          value={workDir}
          onChange={e => { setWorkDir(e.target.value); setStatus(null); }}
        />
      </VStack>

      <HStack justify="space-between">
        {status && (
          <Text fontSize="xs" color={status.ok ? 'var(--status-success)' : 'var(--status-error)'}>
            {status.message}
          </Text>
        )}
      </HStack>
    </VStack>
  );
};
