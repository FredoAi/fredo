import React, { useState, useCallback, useEffect } from 'react';
import { Box, VStack, HStack, Text, Button, Input, Spinner } from '@chakra-ui/react';
import { LuFolder, LuX } from 'react-icons/lu';
import { adapterBridge } from '../../../shared/utils/adapterBridge';
import { useSettingsSave } from '../../settings/SettingsSaveContext';

const SETTING_KEY = 'kubeconfig_path';

export const DiagramSettings: React.FC = () => {
  const [path, setPath] = useState('');
  const [initializing, setInitializing] = useState(true);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);

  // Load saved kubeconfig path from SQLite on mount, falling back to default
  useEffect(() => {
    adapterBridge
      .invoke<string | null>('get_setting', { key: SETTING_KEY })
      .then((saved) => { setPath(saved ?? ''); })
      .catch(console.error)
      .finally(() => setInitializing(false));
  }, []);

  const handleBrowse = useCallback(async () => {
    const selected = await adapterBridge.invoke<string>('open_file_dialog');
    if (selected) { setPath(selected); setStatus(null); }
  }, []);

  const handlePathChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setPath(e.target.value);
    setStatus(null);
  }, []);

  const handleClear = useCallback(() => {
    setPath('');
    setStatus(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!path) {
      setStatus({ ok: false, message: 'Select a kubeconfig file first.' });
      return;
    }
    setStatus(null);
    try {
      await adapterBridge.invoke('save_setting', { key: SETTING_KEY, value: path });
      await adapterBridge.invoke('start_k8s_diagram', { kubeconfigPath: path });
      setStatus({ ok: true, message: 'Saved. Diagram is loading…' });
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : 'Unknown error' });
    }
  }, [path]);

  // Register save fn with the modal’s unified Save button
  useSettingsSave(path ? handleSave : null);

  if (initializing) {
    return (
      <VStack padding={4} align="center">
        <Spinner size="sm" color="var(--accent-primary)" />
      </VStack>
    );
  }

  return (
    <VStack align="stretch" gap={4} padding={4}>
      <Box>
        <Text
          fontSize="xs"
          fontWeight="600"
          color="var(--text-secondary)"
          textTransform="uppercase"
          letterSpacing="0.05em"
          marginBottom={2}
        >
          Kubeconfig File
        </Text>
        <HStack gap={2}>
          <Input
            value={path}
            onChange={handlePathChange}
            placeholder="~/.kube/config"
            size="sm"
            flex="1"
            background="var(--card-bg)"
            borderColor="var(--border-color)"
            color="var(--text-primary)"
          />
          <Button size="sm" variant="outline"
            color="var(--text-primary)"
            borderColor="var(--border-color)"
            _hover={{ borderColor: 'var(--accent-primary)' }}
            onClick={handleBrowse} title="Browse for kubeconfig">
            <LuFolder />
          </Button>
          {path && (
            <Button size="sm" variant="ghost"
              color="var(--text-secondary)"
              _hover={{ color: 'var(--text-primary)' }}
              onClick={handleClear} title="Clear path">
              <LuX />
            </Button>
          )}
        </HStack>
        <Text fontSize="xs" color="var(--text-muted)" marginTop={1}>
          Path to your kubeconfig file. The diagram will connect to the current-context cluster.
        </Text>
      </Box>

      {status && (
        <Text fontSize="xs" color={status.ok ? 'var(--status-success)' : 'var(--status-error)'}>
          {status.message}
        </Text>
      )}
    </VStack>
  );
};
