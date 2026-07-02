import React, { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  Field,
  HStack,
  NativeSelect,
  Separator,
  Switch,
  Text,
  VStack,
} from '@chakra-ui/react';
import { LuTrash2 } from 'react-icons/lu';
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
  { value: '60', label: '60 days' },
  { value: '90', label: '90 days' },
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

  /** Handle purge button. */
  const handlePurge = async () => {
    setPurging(true);
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
    <VStack gap={4} align="stretch">
      {loadingInitial ? null : (
        <>
          {/* ── Toggle Section ── */}
          <Box>
            <HStack justify="space-between" align="center">
              <VStack align="start" gap={0}>
                <Text fontSize="sm" fontWeight="600" color="fg.default">
                  Telemetry Tracing
                </Text>
                <Text fontSize="xs" color="fg.muted">
                  Collect OpenTelemetry-compatible span traces
                </Text>
              </VStack>
              <Switch.Root
                checked={enabled}
                disabled={toggling}
                onCheckedChange={(e) => handleToggle(e.checked)}
                colorPalette="accent"
                size="md"
              >
                <Switch.HiddenInput />
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Root>
            </HStack>
          </Box>

          <Separator borderColor="border.subtle" />

          {/* ── Metrics Section ── */}
          <Box>
            <VStack gap={3}>
              <HStack justify="space-between" align="center">
                <VStack align="start" gap={0}>
                  <Text fontSize="sm" fontWeight="600" color="fg.default">
                    Metrics
                  </Text>
                  <Text fontSize="xs" color="fg.muted">
                    Collect metric counters, histograms, and gauges
                  </Text>
                </VStack>
                <Switch.Root
                  checked={metricsEnabled}
                  disabled={metricsToggling || !enabled}
                  onCheckedChange={(e) => handleMetricsToggle(e.checked)}
                  colorPalette="accent"
                  size="md"
                >
                  <Switch.HiddenInput />
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                </Switch.Root>
              </HStack>

              <Field.Root>
                <VStack align="start" gap={1}>
                  <Text fontSize="sm" fontWeight="600" color="fg.default">
                    Aggregation Window
                  </Text>
                  <Text fontSize="xs" color="fg.muted">
                    How often metric data is aggregated and persisted
                  </Text>
                </VStack>
                <NativeSelect.Root
                  size="sm"
                  width="auto"
                  disabled={!enabled || !metricsEnabled}
                >
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
              </Field.Root>
            </VStack>
          </Box>

          <Separator borderColor="border.subtle" />

          {/* ── Logging Section ── */}
          <Box>
            <VStack gap={3}>
              <HStack justify="space-between" align="center">
                <VStack align="start" gap={0}>
                  <Text fontSize="sm" fontWeight="600" color="fg.default">
                    Logging
                  </Text>
                  <Text fontSize="xs" color="fg.muted">
                    Structured operational logging to SQLite
                  </Text>
                </VStack>
                <Switch.Root
                  checked={loggingEnabled}
                  disabled={loggingToggling || !enabled}
                  onCheckedChange={(e) => handleLoggingToggle(e.checked)}
                  colorPalette="accent"
                  size="md"
                >
                  <Switch.HiddenInput />
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                </Switch.Root>
              </HStack>

              <Field.Root>
                <VStack align="start" gap={1}>
                  <Text fontSize="sm" fontWeight="600" color="fg.default">
                    Minimum Level
                  </Text>
                  <Text fontSize="xs" color="fg.muted">
                    Only log events at this level and above
                  </Text>
                </VStack>
                <NativeSelect.Root
                  size="sm"
                  width="auto"
                  disabled={!enabled || !loggingEnabled}
                >
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
              </Field.Root>
            </VStack>
          </Box>

          <Separator borderColor="border.subtle" />

          {/* ── Retention Section ── */}
          <Box>
            <Field.Root>
              <VStack align="start" gap={1}>
                <Text fontSize="sm" fontWeight="600" color="fg.default">
                  Retention Period
                </Text>
                <Text fontSize="xs" color="fg.muted">
                  Auto-delete spans older than this many days
                </Text>
              </VStack>
              <NativeSelect.Root
                size="sm"
                width="auto"
                disabled={!enabled}
              >
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
            </Field.Root>
          </Box>

          <Separator borderColor="border.subtle" />

          {/* ── Statistics Section ── */}
          <Box>
            <VStack align="start" gap={2}>
              <Text fontSize="sm" fontWeight="600" color="fg.default">
                Storage
              </Text>
              <HStack gap={6}>
                <VStack align="start" gap={0}>
                  <Text fontSize="xs" color="fg.muted" fontFamily="body">
                    Spans
                  </Text>
                  <Text
                    fontSize="md"
                    fontWeight="600"
                    color="fg.default"
                    fontFamily="mono"
                    letterSpacing="-0.02em"
                  >
                    {stats.spanCount.toLocaleString()}
                  </Text>
                </VStack>
                <VStack align="start" gap={0}>
                  <Text fontSize="xs" color="fg.muted" fontFamily="body">
                    Metric Points
                  </Text>
                  <Text
                    fontSize="md"
                    fontWeight="600"
                    color="fg.default"
                    fontFamily="mono"
                    letterSpacing="-0.02em"
                  >
                    {stats.metricPointCount.toLocaleString()}
                  </Text>
                  <Text fontSize="xs" color="fg.muted" fontFamily="body">
                    ~{formatBytes(stats.metricPointCount * 200)} est.
                  </Text>
                </VStack>
                <VStack align="start" gap={0}>
                  <Text fontSize="xs" color="fg.muted" fontFamily="body">
                    Logs
                  </Text>
                  <Text
                    fontSize="md"
                    fontWeight="600"
                    color="fg.default"
                    fontFamily="mono"
                    letterSpacing="-0.02em"
                  >
                    {stats.logCount.toLocaleString()}
                  </Text>
                  <Text fontSize="xs" color="fg.muted" fontFamily="body">
                    ~{formatBytes(stats.logCount * 250)} est.
                  </Text>
                </VStack>
                <VStack align="start" gap={0}>
                  <Text fontSize="xs" color="fg.muted" fontFamily="body">
                    Storage
                  </Text>
                  <Text
                    fontSize="md"
                    fontWeight="600"
                    color="fg.default"
                    fontFamily="mono"
                    letterSpacing="-0.02em"
                  >
                    {formatBytes(stats.storageBytes)}
                  </Text>
                </VStack>
              </HStack>
            </VStack>
          </Box>

          {/* ── Purge Button ── */}
          <HStack justify="flex-start" pt={1}>
            <Button
              variant="outline"
              colorPalette="red"
              size="sm"
              disabled={purging}
              loading={purging}
              loadingText="Purging…"
              onClick={handlePurge}
            >
              <LuTrash2 size={14} />
              Purge All Telemetry
            </Button>
          </HStack>
        </>
      )}
    </VStack>
  );
};
