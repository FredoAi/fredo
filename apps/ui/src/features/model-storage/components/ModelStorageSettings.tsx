import React, { useState, useCallback, useEffect } from 'react';
import { VStack, HStack, Text, Input } from '@chakra-ui/react';
import { settingsService } from '../../settings';
import { useSettingsSave } from '../../settings/SettingsSaveContext';

const MODELS_DIR_KEY = 'models_dir';
const DEFAULT_MODELS_DIR = '~/fredo-models';

export const ModelStorageSettings: React.FC = () => {
  const [modelsDir, setModelsDir] = useState(DEFAULT_MODELS_DIR);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    settingsService.get<string>(MODELS_DIR_KEY, DEFAULT_MODELS_DIR)
      .then(v => { setModelsDir(v); });
  }, []);

  const handleSave = useCallback(async () => {
    setStatus(null);
    try {
      await settingsService.set(MODELS_DIR_KEY, modelsDir);
      setStatus({ ok: true, message: 'Saved.' });
    } catch (err) {
      setStatus({ ok: false, message: String(err) });
    }
  }, [modelsDir]);

  useSettingsSave(handleSave);

  return (
    <VStack align="stretch" gap={4} p={4}>
      <Text fontWeight="semibold" fontSize="sm">Model Storage Settings</Text>

      <VStack align="stretch" gap={1}>
        <Text fontSize="xs" color="var(--text-secondary)">Models Directory</Text>
        <Text fontSize="xs" color="var(--text-muted)">
          Directory where downloaded models are stored.
        </Text>
        <Input
          size="sm"
          placeholder={DEFAULT_MODELS_DIR}
          value={modelsDir}
          onChange={e => { setModelsDir(e.target.value); setStatus(null); }}
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
