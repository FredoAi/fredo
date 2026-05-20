import React, { useState, useCallback, useEffect } from 'react';
import { VStack, HStack, Text, IconButton, Input } from '@chakra-ui/react';
import { LuBot, LuTerminal } from 'react-icons/lu';
import { settingsService } from '../../settings';
import { useSettingsSave } from '../../settings/SettingsSaveContext';

export const RunCliSettings: React.FC = () => {
  const [provider, setProvider] = useState<'copilot' | 'claude'>('copilot');
  const [workDir, setWorkDir] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    settingsService.get('run_cli_provider', 'copilot')
      .then(v => { if (v === 'copilot' || v === 'claude') setProvider(v as 'copilot' | 'claude'); });
    settingsService.get('run_cli_work_dir', '')
      .then(v => { if (v) setWorkDir(v as string); });
  }, []);

  const handleSave = useCallback(async () => {
    setStatus(null);
    try {
      await settingsService.set('run_cli_provider', provider);
      await settingsService.set('run_cli_work_dir', workDir);
      setStatus({ ok: true, message: 'Saved.' });
    } catch (err) {
      setStatus({ ok: false, message: String(err) });
    }
  }, [provider, workDir]);

  useSettingsSave(handleSave);

  const activeStyle = {
    outline: '2px solid var(--accent-primary)',
    outlineOffset: '2px',
    background: 'var(--accent-primary)15',
  };

  return (
    <VStack align="stretch" gap={4} p={4}>
      <Text fontWeight="semibold" fontSize="sm">Run CLI Settings</Text>

      <VStack align="stretch" gap={1}>
        <Text fontSize="xs" color="var(--text-secondary)">Provider</Text>
        <Text fontSize="xs" color="var(--text-muted)">Which CLI to launch when you press Start.</Text>
        <HStack gap={2} mt={1}>
          <IconButton aria-label="GitHub Copilot" size="md" variant="ghost"
            color="var(--text-primary)"
            onClick={() => setProvider('copilot')}
            style={provider === 'copilot' ? activeStyle : undefined}>
            <LuBot />
          </IconButton>
          <Text fontSize="xs" color="var(--text-secondary)" mr={4}>Copilot</Text>
          <IconButton aria-label="Claude" size="md" variant="ghost"
            color="var(--text-primary)"
            onClick={() => setProvider('claude')}
            style={provider === 'claude' ? activeStyle : undefined}>
            <LuTerminal />
          </IconButton>
          <Text fontSize="xs" color="var(--text-secondary)">Claude</Text>
        </HStack>
      </VStack>

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
