import React, { useEffect, useState } from 'react';
import { chakra, VStack, Box, Text, HStack } from '@chakra-ui/react';
import { invoke } from '@tauri-apps/api/core';

const MODELS = [
  {
    id: 'gemma-4-e2b',
    name: 'Gemma 4 E2B',
    description: 'Google Gemma 4 E2B · Q4_K_M · Vision ✓',
  },
  {
    id: 'minicpm-v-4-6',
    name: 'MiniCPM-V 4.6',
    description: 'OpenBMB MiniCPM-V 4.6 · Q4_K_M · Vision ✓',
  },
] as const;

type ModelId = (typeof MODELS)[number]['id'];

export const ModelSelector: React.FC = () => {
  const [selected, setSelected] = useState<ModelId>('gemma-4-e2b');
  const [saving, setSaving] = useState(false);

  // Load persisted selection on mount.
  useEffect(() => {
    invoke<string | null>('get_setting', { key: 'llm_model' })
      .then((val) => {
        if (val && MODELS.some((m) => m.id === val)) {
          setSelected(val as ModelId);
        }
      })
      .catch(() => {});
  }, []);

  const handleChange = async (id: ModelId) => {
    setSelected(id);
    setSaving(true);
    try {
      await invoke('save_setting', { key: 'llm_model', value: id });
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  return (
    <VStack gap={2} align="stretch">
      {MODELS.map((model) => {
        const isSelected = selected === model.id;
        return (
          <Box
            key={model.id}
            as="button"
            onClick={() => handleChange(model.id)}
            p={3}
            borderRadius="md"
            border="1px solid"
            borderColor={isSelected ? 'var(--accent-primary)' : 'var(--border-color)'}
            background={isSelected ? 'rgba(147, 51, 234, 0.08)' : 'var(--card-bg)'}
            textAlign="left"
            cursor="pointer"
            transition="all 0.15s"
            _hover={{ borderColor: 'var(--accent-primary)' }}
          >
            <HStack gap={2} align="center">
              <Box
                w={3}
                h={3}
                borderRadius="full"
                border="2px solid"
                borderColor={isSelected ? 'var(--accent-primary)' : 'var(--text-secondary)'}
                background={isSelected ? 'var(--accent-primary)' : 'transparent'}
                flexShrink={0}
              />
              <VStack gap={0} align="start">
                <Text fontSize="sm" fontWeight="600" color="var(--text-primary)">
                  {model.name}
                </Text>
                <Text fontSize="xs" color="var(--text-secondary)">
                  {model.description}
                </Text>
              </VStack>
            </HStack>
          </Box>
        );
      })}

      {saving && (
        <Text fontSize="xs" color="var(--text-secondary)" textAlign="center">
          Saving… restart app to switch models.
        </Text>
      )}

      <Text fontSize="xs" color="var(--text-secondary)" mt={1}>
        Model change takes effect on next app launch.
      </Text>
    </VStack>
  );
};
