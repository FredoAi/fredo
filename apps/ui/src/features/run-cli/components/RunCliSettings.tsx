import React, { useState, useCallback, useEffect } from 'react';
import { VStack, HStack, Text, Input } from '@chakra-ui/react';
import { settingsService } from '../../settings';
import { useSettingsSave } from '../../settings/SettingsSaveContext';

export const RunCliSettings: React.FC = () => {
  const [workDir, setWorkDir] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    settingsService.get('run_cli_work_dir', '')
      .then(v => { if (v) setWorkDir(v as string); });
  }, []);

  const handleSave = useCallback(async () => {
    setStatus(null);
    try {
      await settingsService.set('run_cli_work_dir', workDir);
      setStatus({ ok: true, message: 'Saved.' });
    } catch (err) {
      setStatus({ ok: false, message: String(err) });
    }
  }, [workDir]);

  useSettingsSave(handleSave);

  return (
    <VStack align="stretch" gap={4} p={4}>
      <Text fontWeight="semibold" fontSize="sm">Run CLI Settings</Text>

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
          <Text fontSize="xs" color={status.ok ? 'green.400' : 'red.400'}>
            {status.message}
          </Text>
        )}
      </HStack>
    </VStack>
  );
};
