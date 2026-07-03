import React, { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  Card,
  Dialog,
  HStack,
  NativeSelect,
  Separator,
  Switch,
  Text,
} from '@chakra-ui/react';
import { LuTrash2, LuTriangleAlert } from 'react-icons/lu';
import { adapterBridge } from '../../../../shared/utils/adapterBridge';
import { settingsService } from '../../../../features/settings';

// ── Types ──────────────────────────────────────────────────────────────────────

interface TelemetryStats {
  spanCount: number;
  metricPointCount: number;
  logCount: number;
  storageBytes: number;
}

const RETENTION_OPTIONS = [
  { value: '7', label: '7 days' },
  { value: '14', label: '14 days' },
  { value: '30', label: '30 days' },
] as const;

const AGGREGATION_OPTIONS = [
  { value: '10', label: '10s' },
  { value: '30', label: '30s' },
  { value: '60', label: '60s' },
  { value: '120', label: '120s' },
  { value: '300', label: '300s' },
] as const;

const LEVEL_OPTIONS = [
  { value: 'TRACE', label: 'TRACE' },
  { value: 'DEBUG', label: 'DEBUG' },
  { value: 'INFO', label: 'INFO' },
  { value: 'WARN', label: 'WARN' },
  { value: 'ERROR', label: 'ERROR' },
] as const;

// ── Helpers ─────────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Component ───────────────────────────────────────────────────────────────────

export const TelemetrySettings: React.FC = () => {
  const [enabled, setEnabled] = useState(true);
  const [metricsEnabled, setMetricsEnabled] = useState(true);
  const [aggregationWindow, setAggregationWindow] = useState('60');
  const [retentionDays, setRetentionDays] = useState('7');
  const [stats, setStats] = useState<TelemetryStats>({ spanCount: 0, metricPointCount: 0, logCount: 0, storageBytes: 0 });
  const [toggling, setToggling] = useState(false);
  const [metricsToggling, setMetricsToggling] = useState(false);
  const [loggingEnabled, setLoggingEnabled] = useState(true);
  const [loggingLevel, setLoggingLevel] = useState('INFO');
  const [loggingToggling, setLoggingToggling] = useState(false);
  const [purging, setPurging] = useState(false);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [showPurgeDialog, setShowPurgeDialog] = useState(false);

  /** Fetch span count + storage statistics. */
  const refreshStats = useCallback(async () => {
    try {
      const result = await adapterBridge.invoke<TelemetryStats>('telemetry_get_stats');
      if (result) setStats(result);
    } catch {
      // IPC not available (dev mode or backend not ready)
    }
  }, []);

  // On mount: read persisted settings + fetch stats
  useEffect(() => {
    (async () => {
      try {
        const [enabledVal, metricsEnabledVal, aggregationVal, retentionVal, loggingEnabledVal, loggingLevelVal] = await Promise.all([
          settingsService.get<boolean>('tracing.enabled', true, (raw) => raw === 'true'),
          settingsService.get<boolean>('tracing.metrics_enabled', true, (raw) => raw === 'true'),
          settingsService.get<string>('tracing.metrics_aggregation_s', '60'),
          settingsService.get<string>('tracing.retention_days', '7'),
          settingsService.get<boolean>('tracing.logging_enabled', true, (raw) => raw === 'true'),
          settingsService.get<string>('tracing.logging_level', 'INFO'),
        ]);
        setEnabled(enabledVal);
        setMetricsEnabled(metricsEnabledVal);
        setAggregationWindow(aggregationVal);
        setRetentionDays(retentionVal);
        setLoggingEnabled(loggingEnabledVal);
        setLoggingLevel(loggingLevelVal);
      } catch {
        // defaults already set
      }
      await refreshStats();
      setLoadingInitial(false);
    })();
  }, [refreshStats]);

  /** Handle toggle switch change. */
  const handleToggle = async (checked: boolean) => {
    setToggling(true);
    try {
      await adapterBridge.invoke('telemetry_toggle', { enabled: checked });
      await settingsService.set('tracing.enabled', String(checked));
      setEnabled(checked);
    } catch {
      // IPC unavailable — revert
    } finally {
      setToggling(false);
    }
  };

  /** Handle metrics toggle switch change. */
  const handleMetricsToggle = async (checked: boolean) => {
    setMetricsToggling(true);
    try {
      await adapterBridge.invoke('telemetry_metrics_toggle', { enabled: checked });
      await settingsService.set('tracing.metrics_enabled', String(checked));
      setMetricsEnabled(checked);
    } catch {
      // IPC unavailable — revert
    } finally {
      setMetricsToggling(false);
    }
  };

  /** Handle logging toggle switch change. */
  const handleLoggingToggle = async (checked: boolean) => {
    setLoggingToggling(true);
    try {
      await adapterBridge.invoke('telemetry_logging_toggle', { enabled: checked });
      await settingsService.set('tracing.logging_enabled', String(checked));
      setLoggingEnabled(checked);
    } catch {
      // IPC unavailable — revert
    } finally {
      setLoggingToggling(false);
    }
  };

  /** Handle logging level change. */
  const handleLoggingLevelChange = async (value: string) => {
    setLoggingLevel(value);
    try {
      await adapterBridge.invoke('telemetry_logging_set_level', { level: value });
    } catch {
      // IPC unavailable
    }
    await settingsService.set('tracing.logging_level', value);
  };

  /** Handle aggregation window change. */
  const handleAggregationChange = async (value: string) => {
    setAggregationWindow(value);
    await settingsService.set('tracing.metrics_aggregation_s', value);
  };

  /** Handle retention days change. */
  const handleRetentionChange = async (value: string) => {
    setRetentionDays(value);
    await settingsService.set('tracing.retention_days', value);
  };

  /** Handle purge confirmation — close dialog, invoke purge, refresh stats. */
  const handlePurgeConfirm = async () => {
    setPurging(true);
    setShowPurgeDialog(false);
    try {
      await adapterBridge.invoke('telemetry_purge');
      await refreshStats();
    } catch {
      // IPC unavailable
    } finally {
      setPurging(false);
    }
  };

  return (
    <Card.Root
      bg="bg.surface"
      border="1px solid"
      borderColor="border.default"
      borderRadius="lg"
    >
      <Card.Body display="flex" flexDirection="column" gap={4}>
        {loadingInitial ? null : (
          <>
            {/* ── Toggle Rows ── */}
            <HStack justify="space-between" align="center">
              <Text fontSize="sm" fontWeight="500" color="fg.default">
                Tracing
              </Text>
              <Switch.Root
                checked={enabled}
                disabled={toggling}
                onCheckedChange={(e) => handleToggle(e.checked)}
                colorPalette="purple"
                size="md"
              >
                <Switch.HiddenInput />
                <Switch.Control />
              </Switch.Root>
            </HStack>

            <HStack justify="space-between" align="center">
              <Text fontSize="sm" fontWeight="500" color="fg.default">
                Metrics
              </Text>
              <Switch.Root
                checked={metricsEnabled}
                disabled={metricsToggling || !enabled}
                onCheckedChange={(e) => handleMetricsToggle(e.checked)}
                colorPalette="purple"
                size="md"
              >
                <Switch.HiddenInput />
                <Switch.Control />
              </Switch.Root>
            </HStack>

            <HStack justify="space-between" align="center">
              <Text fontSize="sm" fontWeight="500" color="fg.default">
                Logging
              </Text>
              <Switch.Root
                checked={loggingEnabled}
                disabled={loggingToggling || !enabled}
                onCheckedChange={(e) => handleLoggingToggle(e.checked)}
                colorPalette="purple"
                size="md"
              >
                <Switch.HiddenInput />
                <Switch.Control />
              </Switch.Root>
            </HStack>

            <Separator borderColor="border.default" />

            {/* ── Config Rows ── */}
            <HStack justify="space-between" align="center">
              <Text fontSize="sm" fontWeight="500" color="fg.default">
                Retention
              </Text>
              <NativeSelect.Root size="sm" width="auto" disabled={!enabled}>
                <NativeSelect.Field
                  value={retentionDays}
                  onChange={(e) => handleRetentionChange(e.currentTarget.value)}
                >
                  {RETENTION_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </NativeSelect.Field>
                <NativeSelect.Indicator />
              </NativeSelect.Root>
            </HStack>

            <HStack justify="space-between" align="center">
              <Text fontSize="sm" fontWeight="500" color="fg.default">
                Min Log Level
              </Text>
              <NativeSelect.Root size="sm" width="auto" disabled={!enabled || !loggingEnabled}>
                <NativeSelect.Field
                  value={loggingLevel}
                  onChange={(e) => handleLoggingLevelChange(e.currentTarget.value)}
                >
                  {LEVEL_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </NativeSelect.Field>
                <NativeSelect.Indicator />
              </NativeSelect.Root>
            </HStack>

            <HStack justify="space-between" align="center">
              <Text fontSize="sm" fontWeight="500" color="fg.default">
                Aggregation
              </Text>
              <NativeSelect.Root size="sm" width="auto" disabled={!enabled || !metricsEnabled}>
                <NativeSelect.Field
                  value={aggregationWindow}
                  onChange={(e) => handleAggregationChange(e.currentTarget.value)}
                >
                  {AGGREGATION_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </NativeSelect.Field>
                <NativeSelect.Indicator />
              </NativeSelect.Root>
            </HStack>

            <Separator borderColor="border.default" />

            {/* ── Purge Button ── */}
            <HStack justify="flex-start">
              <Button
                variant="outline"
                colorPalette="red"
                size="sm"
                disabled={purging}
                loading={purging}
                loadingText="Purging…"
                onClick={() => setShowPurgeDialog(true)}
              >
                <LuTrash2 size={14} />
                Purge All Telemetry
              </Button>
            </HStack>

            {/* ── Stats (inline compact) ── */}
            <HStack gap={4} fontSize="xs" color="fg.muted" fontFamily="mono">
              <Text>{stats.spanCount.toLocaleString()} spans</Text>
              <Text>{stats.metricPointCount.toLocaleString()} metrics</Text>
              <Text>{stats.logCount.toLocaleString()} logs</Text>
              <Text>{formatBytes(stats.storageBytes)}</Text>
            </HStack>

            {/* ── Purge Confirmation Dialog ── */}
            <Dialog.Root
              open={showPurgeDialog}
              onOpenChange={(details) => setShowPurgeDialog(details.open)}
            >
              <Dialog.Backdrop bg="rgba(0,0,0,0.55)" backdropFilter="blur(4px)" />
              <Dialog.Positioner>
                <Dialog.Content
                  bg="bg.surface"
                  borderColor="border.default"
                  borderWidth="1px"
                  borderRadius="lg"
                >
                  <Dialog.Header>
                    <Dialog.Title color="fg.default">
                      <HStack gap={2}>
                        <Box color="status.error" fontSize="lg">
                          <LuTriangleAlert />
                        </Box>
                        <Text>Purge telemetry data?</Text>
                      </HStack>
                    </Dialog.Title>
                  </Dialog.Header>
                  <Dialog.Body>
                    <Text color="fg.default">
                      This will permanently delete all stored telemetry data including
                      spans, metrics, and logs. This action cannot be undone.
                    </Text>
                  </Dialog.Body>
                  <Dialog.Footer gap={2}>
                    <Button
                      variant="outline"
                      size="sm"
                      colorPalette="gray"
                      onClick={() => setShowPurgeDialog(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      colorPalette="red"
                      size="sm"
                      disabled={purging}
                      loading={purging}
                      loadingText="Purging…"
                      onClick={handlePurgeConfirm}
                    >
                      Yes, purge everything
                    </Button>
                  </Dialog.Footer>
                  <Dialog.CloseTrigger
                    position="absolute"
                    top="8px"
                    right="8px"
                    color="fg.muted"
                    onClick={() => setShowPurgeDialog(false)}
                  />
                </Dialog.Content>
              </Dialog.Positioner>
            </Dialog.Root>
          </>
        )}
      </Card.Body>
    </Card.Root>
  );
};
