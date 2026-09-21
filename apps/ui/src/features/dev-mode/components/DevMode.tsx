import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Box, Text, HStack, VStack, Badge, Button, Code, Input, chakra } from '@chakra-ui/react';
import { motion, AnimatePresence } from 'framer-motion';

// Chakra v3 + framer-motion wrapper
const MotionBox = chakra(motion.div as any) as any;
import {
  LuWifi, LuWifiOff, LuTrash2, LuChevronDown, LuChevronRight, LuSearch, LuX,
} from 'react-icons/lu';
import { useDevModeStream, useDevModeFeatureData } from '../hooks/useDevModeStream';
import type { DevModeStreamEvent, DevModeEventState } from '../hooks/useDevModeStream';
import type { FeatureNotificationLogEntry } from '../../../shared/feature-data/store';
import { tint } from '../../../shared/utils/colorTint';
import { SpatiotemporalManifold } from './SpatiotemporalManifold';

// ── State badge colours ───────────────────────────────────────────────────────

const STATE_COLORS: Record<DevModeEventState, string> = {
  Init: '#3b82f6',
  Update: '#f59e0b',
  Response: '#22c55e',
  Error: '#ef4444',
  Timeout: '#6b7280',
};

// ── OTLP payload viewer (retained for rawJson payload inspection) ─────────────

/** Keys that carry human-readable LLM content — shown prominently. */
const CONTENT_KEYS = [
  'gen_ai.prompt',
  'gen_ai.completion',
  'gen_ai.request.messages',
  'gen_ai.response.text',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
  'gen_ai.tool.description',
];

/** Keys shown as a compact metadata grid above the content. */
const META_KEYS = [
  'gen_ai.operation.name',
  'gen_ai.tool.name',
  'gen_ai.request.model',
  'gen_ai.response.model',
  'service.name',
  'span.name',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.cost',
];

const OtlpPayloadView: React.FC<{ attrs: Record<string, any> }> = ({ attrs }) => {
  const metaEntries = META_KEYS.filter(k => attrs[k] != null).map(k => [k.split('.').pop()!, String(attrs[k])]);
  const contentEntries = CONTENT_KEYS.filter(k => attrs[k] != null).map(k => ({ key: k, value: attrs[k] }));
  const remaining = Object.entries(attrs).filter(
    ([k]) => !META_KEYS.includes(k) && !CONTENT_KEYS.includes(k)
  );

  const renderValue = (v: any): string =>
    typeof v === 'string' ? v : JSON.stringify(v, null, 2);

  return (
    <Box mt={2} display="flex" flexDirection="column" gap={2}>
      {/* Metadata chips */}
      {metaEntries.length > 0 && (
        <Box display="flex" flexWrap="wrap" gap="6px">
          {metaEntries.map(([k, v]) => (
            <Box key={k} px="6px" py="2px" borderRadius="md" background="var(--card-bg)" border="1px solid var(--border-color)">
              <Text as="span" fontSize="9px" color="var(--text-secondary)" mr={1}>{k}</Text>
              <Text as="span" fontSize="9px" color="var(--text-primary)" fontWeight="600">{v}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Content sections */}
      {contentEntries.map(({ key, value }) => (
        <Box key={key}>
          <Text fontSize="9px" color="var(--text-secondary)" textTransform="uppercase" letterSpacing="0.08em" mb="3px">
            {key.replace('gen_ai.', '').replace(/_/g, ' ')}
          </Text>
          <Box
            p={2}
            borderRadius="md"
            background="#ffffff08"
            border="1px solid var(--border-color)"
            maxHeight="240px"
            overflowY="auto"
          >
            <Code display="block" whiteSpace="pre-wrap" wordBreak="break-all" fontSize="10px"
              color={key.includes('completion') || key.includes('result') ? '#86efac' : 'var(--text-primary)'}
              background="transparent"
            >
              {renderValue(value)}
            </Code>
          </Box>
        </Box>
      ))}

      {/* Remaining attrs collapsed */}
      {remaining.length > 0 && (
        <Box>
          <Text fontSize="9px" color="var(--text-secondary)" textTransform="uppercase" letterSpacing="0.08em" mb="3px">
            raw attributes
          </Text>
          <Code display="block" whiteSpace="pre-wrap" wordBreak="break-all" fontSize="10px"
            color="var(--text-secondary)" background="transparent"
          >
            {JSON.stringify(Object.fromEntries(remaining), null, 2)}
          </Code>
        </Box>
      )}
    </Box>
  );
};

// ── Single event row ──────────────────────────────────────────────────────────

interface EventRowProps {
  event: DevModeStreamEvent;
  index: number;
}

const EventRow: React.FC<EventRowProps> = ({ event, index }) => {
  const [expanded, setExpanded] = useState(false);

  const payload = event.payload;
  const hasPayload = payload !== undefined && payload !== null;

  // Render the structured viewer when the row payload carries the plugin's
  // gen_ai.* long-tail (the rawJson projection), the plain JSON view otherwise.
  const hasGenaiAttrs = hasPayload && META_KEYS.concat(CONTENT_KEYS).some((k) => k in (payload as object));
  const showTool = event.toolName !== event.eventType;

  const timeLabel = new Date(event.timestamp).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });

  return (
    <MotionBox
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 } as any}
      background="var(--card-bg)"
      border="1px solid"
      borderColor="var(--border-color)"
      borderRadius="md"
      overflow="hidden"
      mb="4px"
    >
      <HStack
        px={3}
        py="6px"
        gap={2}
        cursor={hasPayload ? 'pointer' : 'default'}
        _hover={hasPayload ? { background: 'var(--card-hover-bg)' } : undefined}
        onClick={hasPayload ? () => setExpanded((v) => !v) : undefined}
        flexWrap="nowrap"
        overflow="hidden"
      >
        <Box color="var(--text-secondary)" flexShrink={0} style={{ width: 14 }}>
          {hasPayload ? (expanded ? <LuChevronDown size={13} /> : <LuChevronRight size={13} />) : null}
        </Box>
        <Text fontSize="10px" color="var(--text-secondary)" fontFamily="monospace" flexShrink={0} style={{ minWidth: 28, textAlign: 'right' }}>
          #{index}
        </Text>
        <Text fontSize="11px" color="var(--text-secondary)" fontFamily="monospace" flexShrink={0}>
          {timeLabel}
        </Text>
        <Text fontSize="12px" color="var(--text-primary)" fontWeight="600" flex="1" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
          {event.toolName}
          {showTool && (
            <Text as="span" fontSize="10px" color="var(--text-secondary)" fontWeight="400" ml={1}>
              ({event.eventType})
            </Text>
          )}
        </Text>
        <Badge
          flexShrink={0}
          fontSize="9px"
          px={2}
          py="1px"
          borderRadius="full"
          background={STATE_COLORS[event.state] + '22'}
          color={STATE_COLORS[event.state]}
          border="1px solid"
          borderColor={STATE_COLORS[event.state] + '55'}
          textTransform="uppercase"
          letterSpacing="0.05em"
        >
          {event.state}
        </Badge>
      </HStack>

      <AnimatePresence>
        {expanded && hasPayload && (
          <MotionBox
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 } as any}
            overflow="hidden"
          >
            <Box px={3} pb={2} borderTop="1px solid" borderColor="var(--border-color)" background="var(--body-bg)">
              {hasGenaiAttrs && typeof payload === 'object' && payload !== null
                ? <OtlpPayloadView attrs={payload as Record<string, any>} />
                : (
                  <Code display="block" whiteSpace="pre-wrap" wordBreak="break-all" fontSize="10px" color="var(--text-primary)" background="transparent" mt={2}>
                    {JSON.stringify(payload, null, 2)}
                  </Code>
                )}
            </Box>
          </MotionBox>
        )}
      </AnimatePresence>
    </MotionBox>
  );
};

// ── Feature-data probe feed (Spec #2896 ST-5 / A-12) ─────────────────────────
//
// Screenshot-visible per-watch evidence: the watch table lists every known
// (hook-registered) watch with its delivery count — a 0-delivery watch stays
// visible (sibling-field isolation) — and the list shows every received
// `featureBatch` notification with whether THIS webview's store applied it
// (a stale version guard drop is visible as `dropped`).

const FEATURE_KIND_COLORS: Record<string, string> = {
  insert: 'var(--status-success)',
  update: 'var(--status-info)',
  remove: 'var(--status-error)',
};

const FeatureKindBadge: React.FC<{ kind: FeatureNotificationLogEntry['kind'] }> = ({ kind }) => {
  const color = FEATURE_KIND_COLORS[kind] ?? 'var(--text-secondary)';
  return (
    <Badge
      flexShrink={0}
      fontSize="9px"
      px={2}
      py="1px"
      borderRadius="full"
      background={tint(color, 14)}
      color={color}
      border="1px solid"
      borderColor={tint(color, 33)}
      textTransform="uppercase"
      letterSpacing="0.05em"
    >
      {kind}
    </Badge>
  );
};

const FeatureDataFeed: React.FC = () => {
  const { notifications, watches, clear } = useDevModeFeatureData();
  const appliedCount = notifications.filter((n) => n.applied).length;
  const droppedCount = notifications.length - appliedCount;

  return (
    <Box flex="1" display="flex" flexDirection="column" overflow="hidden">
      {/* Summary */}
      <Box
        px={3}
        py={2}
        borderBottom="1px solid"
        borderColor="var(--border-color)"
        background="var(--header-bg)"
        flexShrink={0}
      >
        <HStack gap={3} flexWrap="wrap" align="center">
          <Text fontSize="10px" color="var(--text-secondary)">
            {notifications.length} notification{notifications.length === 1 ? '' : 's'}
          </Text>
          <Badge
            fontSize="9px"
            px={2}
            py="1px"
            borderRadius="full"
            background={tint('var(--status-success)', 14)}
            color="var(--status-success)"
            border="1px solid"
            borderColor={tint('var(--status-success)', 33)}
          >
            {appliedCount} applied
          </Badge>
          <Badge
            fontSize="9px"
            px={2}
            py="1px"
            borderRadius="full"
            background={tint('var(--status-warning)', 14)}
            color="var(--status-warning)"
            border="1px solid"
            borderColor={tint('var(--status-warning)', 33)}
          >
            {droppedCount} dropped
          </Badge>
          <Text fontSize="10px" color="var(--text-secondary)">
            {watches.length} watch{watches.length === 1 ? '' : 'es'}
          </Text>
          {notifications.length > 0 && (
            <Button
              size="xs"
              variant="ghost"
              color="var(--text-secondary)"
              _hover={{ color: 'var(--status-error)', background: tint('var(--status-error)', 10) }}
              onClick={clear}
              aria-label="Clear feature-data notifications"
              px={2}
              height="22px"
            >
              <HStack gap={1}>
                <LuTrash2 size={10} />
                <Text fontSize="10px">Clear</Text>
              </HStack>
            </Button>
          )}
        </HStack>
      </Box>

      {/* Per-watch summary — a known watch with 0 deliveries stays visible */}
      <Box
        px={3}
        py={2}
        borderBottom="1px solid"
        borderColor="var(--border-color)"
        flexShrink={0}
        maxHeight="170px"
        overflowY="auto"
      >
        <Text
          fontSize="9px"
          color="var(--text-secondary)"
          fontWeight="600"
          letterSpacing="0.08em"
          textTransform="uppercase"
          mb="4px"
        >
          Watches
        </Text>
        {watches.length === 0 ? (
          <Text fontSize="10px" color="var(--text-secondary)">
            No watches observed yet.
          </Text>
        ) : (
          watches.map((watch) => (
            <HStack key={watch.watchId} gap={2} py="1px" flexWrap="nowrap" overflow="hidden">
              <Text
                fontSize="10px"
                color="var(--text-primary)"
                fontFamily="monospace"
                flexShrink={0}
                title={watch.watchId}
              >
                {watch.watchId.slice(0, 8)}
              </Text>
              <Text fontSize="10px" color="var(--text-secondary)" flexShrink={0}>
                {watch.featureId ?? 'canonical'} · {watch.table}
              </Text>
              {watch.scope && (
                <Text
                  fontSize="9px"
                  color="var(--text-secondary)"
                  fontFamily="monospace"
                  flex="1"
                  overflow="hidden"
                  textOverflow="ellipsis"
                  whiteSpace="nowrap"
                  title={watch.scope}
                >
                  {watch.scope}
                </Text>
              )}
              <Badge
                flexShrink={0}
                fontSize="9px"
                px={2}
                py="1px"
                borderRadius="full"
                background={tint('var(--accent-primary)', 12)}
                color="var(--accent-primary)"
                border="1px solid"
                borderColor={tint('var(--accent-primary)', 30)}
              >
                {watch.delivered} delivered
              </Badge>
              {watch.delivered === 0 && (
                <Badge
                  flexShrink={0}
                  fontSize="9px"
                  px={2}
                  py="1px"
                  borderRadius="full"
                  background={tint('var(--status-warning)', 14)}
                  color="var(--status-warning)"
                  border="1px solid"
                  borderColor={tint('var(--status-warning)', 33)}
                >
                  0 deliveries
                </Badge>
              )}
            </HStack>
          ))
        )}
      </Box>

      {/* Notification list */}
      <Box
        flex="1"
        overflowY="auto"
        px={2}
        py={2}
        css={{
          '&::-webkit-scrollbar': { width: '4px' },
          '&::-webkit-scrollbar-track': { background: 'transparent' },
          '&::-webkit-scrollbar-thumb': { background: 'var(--border-color)', borderRadius: '2px' },
        }}
      >
        {notifications.length === 0 ? (
          <VStack height="100%" align="center" justify="center" gap={2} color="var(--text-secondary)" pt={12}>
            <Text fontSize="13px">No feature-data notifications yet</Text>
            <Text fontSize="11px" textAlign="center" maxWidth="280px">
              Register a watch with feature_data_watch — every featureBatch delivery (and every
              version-guard drop) appears here.
            </Text>
          </VStack>
        ) : (
          notifications.map((notification) => {
            const timeLabel = new Date(notification.timestamp).toLocaleTimeString('en-US', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false,
            });
            return (
              <Box
                key={notification.id}
                background="var(--card-bg)"
                border="1px solid"
                borderColor="var(--border-color)"
                borderRadius="md"
                px={3}
                py="5px"
                mb="4px"
              >
                <HStack gap={2} flexWrap="nowrap" overflow="hidden">
                  <Text fontSize="10px" color="var(--text-secondary)" fontFamily="monospace" flexShrink={0}>
                    {timeLabel}
                  </Text>
                  <Text
                    fontSize="10px"
                    color="var(--text-primary)"
                    fontFamily="monospace"
                    flexShrink={0}
                    title={notification.watchId}
                  >
                    {notification.watchId.slice(0, 8)}
                  </Text>
                  <Text fontSize="10px" color="var(--text-secondary)" flexShrink={0}>
                    {notification.featureId ?? 'canonical'} · {notification.table}
                  </Text>
                  <FeatureKindBadge kind={notification.kind} />
                  <Text
                    fontSize="10px"
                    color="var(--text-primary)"
                    fontFamily="monospace"
                    flex="1"
                    overflow="hidden"
                    textOverflow="ellipsis"
                    whiteSpace="nowrap"
                    title={JSON.stringify(notification.key)}
                  >
                    {JSON.stringify(notification.key)}
                  </Text>
                  <Badge
                    flexShrink={0}
                    fontSize="9px"
                    px={2}
                    py="1px"
                    borderRadius="full"
                    background={tint(notification.applied ? 'var(--status-success)' : 'var(--status-warning)', 14)}
                    color={notification.applied ? 'var(--status-success)' : 'var(--status-warning)'}
                    border="1px solid"
                    borderColor={tint(notification.applied ? 'var(--status-success)' : 'var(--status-warning)', 33)}
                  >
                    {notification.applied ? 'applied' : 'dropped'}
                  </Badge>
                  <Text fontSize="9px" color="var(--text-secondary)" flexShrink={0} fontFamily="monospace">
                    v{notification.version}
                  </Text>
                </HStack>
                {notification.changedFields.length > 0 && (
                  <Text fontSize="9px" color="var(--text-secondary)" fontFamily="monospace" mt="2px">
                    changed: {notification.changedFields.join(', ')}
                  </Text>
                )}
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );
};

// ── Main component ────────────────────────────────────────────────────────────

const ALL_STATES = ['Init', 'Update', 'Response', 'Error', 'Timeout'] as const;

/** Top-level Dev Mode views — RTDB row stream vs the feature-data probe feed. */
const VIEWS: Array<{ id: 'rows' | 'feature-data'; label: string }> = [
  { id: 'rows', label: 'Rows' },
  { id: 'feature-data', label: 'Feature Data' },
];

export const DevMode: React.FC = () => {
  const { events, eventTypes, isConnected, clearEvents } = useDevModeStream();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<'rows' | 'feature-data'>('rows');

  // ── Filter state ────────────────────────────────────────────────────────────
  const [query, setQuery] = useState('');
  const [activeStates, setActiveStates] = useState<Set<DevModeEventState>>(new Set(ALL_STATES));
  const [selectedEventType, setSelectedEventType] = useState<string | null>(null);

  const toggleState = (state: DevModeEventState) => {
    setActiveStates((prev) => {
      const next = new Set(prev);
      if (next.has(state)) {
        // Don't allow deselecting all
        if (next.size === 1) return prev;
        next.delete(state);
      } else {
        next.add(state);
      }
      return next;
    });
  };

  const filteredEvents = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events.filter((e) => {
      if (!activeStates.has(e.state)) return false;
      if (selectedEventType && e.toolName !== selectedEventType) return false;
      if (!q) return true;
      if (e.toolName.toLowerCase().includes(q)) return true;
      try {
        if (JSON.stringify(e.payload).toLowerCase().includes(q)) return true;
      } catch { /* ignore */ }
      return false;
    });
  }, [events, query, activeStates, selectedEventType]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [filteredEvents.length]);

  const allStatesActive = activeStates.size === ALL_STATES.length;

  return (
    <Box width="100%" height="100%" display="flex" flexDirection="column" background="var(--body-bg)" overflow="hidden">
      {/* Header */}
      <Box px={3} py={2} background="var(--header-bg)" borderBottom="1px solid" borderColor="var(--border-color)" flexShrink={0}>
        <HStack justify="space-between" align="center">
          <HStack gap={2} align="center">
            <Text fontSize="13px" fontWeight="700" color="var(--text-primary)" letterSpacing="0.03em">
              Dev Mode
            </Text>
            <HStack gap={1} px={2} py="2px" borderRadius="full" background={isConnected ? '#22c55e22' : '#ef444422'} border="1px solid" borderColor={isConnected ? '#22c55e55' : '#ef444455'}>
              {isConnected ? <LuWifi size={10} color="#22c55e" /> : <LuWifiOff size={10} color="#ef4444" />}
              <Text fontSize="9px" color={isConnected ? '#22c55e' : '#ef4444'} fontWeight="600" textTransform="uppercase" letterSpacing="0.05em">
                {isConnected ? 'live' : 'offline'}
              </Text>
            </HStack>
            {events.length > 0 && (
              <Text fontSize="10px" color="var(--text-secondary)">
                {filteredEvents.length !== events.length
                  ? `${filteredEvents.length} / ${events.length}`
                  : `${events.length}`}{' '}
                event{events.length !== 1 ? 's' : ''}
              </Text>
            )}
          </HStack>
          {events.length > 0 && (
            <Button size="xs" variant="ghost" color="var(--text-secondary)" _hover={{ color: '#ef4444', background: '#ef444415' }} onClick={clearEvents} aria-label="Clear events" px={2} height="24px">
              <HStack gap={1}>
                <LuTrash2 size={11} />
                <Text fontSize="10px">Clear</Text>
              </HStack>
            </Button>
          )}
        </HStack>
      </Box>

      {/* View switch — RTDB row stream vs the feature-data probe feed (A-12) */}
      <Box px={2} py="4px" borderBottom="1px solid" borderColor="var(--border-color)" background="var(--header-bg)" flexShrink={0}>
        <HStack gap="4px">
          {VIEWS.map((entry) => {
            const active = view === entry.id;
            return (
              <Box
                key={entry.id}
                as="button"
                onClick={() => setView(entry.id)}
                px="7px"
                py="2px"
                borderRadius="full"
                fontSize="9px"
                fontWeight="600"
                letterSpacing="0.05em"
                cursor="pointer"
                border="1px solid"
                transition="all 0.15s"
                background={active ? tint('var(--accent-primary)', 13) : 'transparent'}
                color={active ? 'var(--accent-primary)' : 'var(--text-secondary)'}
                borderColor={active ? tint('var(--accent-primary)', 33) : 'var(--border-color)'}
                _hover={{ borderColor: tint('var(--accent-primary)', 53), color: 'var(--accent-primary)' }}
                style={{ userSelect: 'none' }}
              >
                {entry.label}
              </Box>
            );
          })}
        </HStack>
      </Box>

      {view === 'rows' ? (
        <>
          {/* Filter bar */}
      <Box px={2} py="6px" borderBottom="1px solid" borderColor="var(--border-color)" background="var(--header-bg)" flexShrink={0}>
        {/* Search input */}
        <HStack gap={2} mb="6px">
          <Box position="relative" flex="1">
            <Box position="absolute" left={2} top="50%" transform="translateY(-50%)" color="var(--text-secondary)" pointerEvents="none">
              <LuSearch size={11} />
            </Box>
            <Input
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder="Filter by event type or payload…"
              size="xs"
              pl={6}
              pr={query ? 6 : 2}
              height="24px"
              fontSize="11px"
              background="var(--card-bg)"
              border="1px solid"
              borderColor="var(--border-color)"
              color="var(--text-primary)"
              _placeholder={{ color: 'var(--text-secondary)' }}
              _focus={{ borderColor: 'var(--accent-primary)', boxShadow: 'none', outline: 'none' }}
              borderRadius="md"
            />
            {query && (
              <Box
                position="absolute"
                right={2}
                top="50%"
                transform="translateY(-50%)"
                cursor="pointer"
                color="var(--text-secondary)"
                _hover={{ color: 'var(--text-primary)' }}
                onClick={() => setQuery('')}
              >
                <LuX size={10} />
              </Box>
            )}
          </Box>
        </HStack>

        {/* State toggle chips */}
        <HStack gap="4px" mb={eventTypes.length > 0 ? '6px' : 0}>
          {ALL_STATES.map((state) => {
            const active = activeStates.has(state);
            const color = STATE_COLORS[state];
            return (
              <Box
                key={state}
                as="button"
                onClick={() => toggleState(state)}
                px="7px"
                py="2px"
                borderRadius="full"
                fontSize="9px"
                fontWeight="600"
                letterSpacing="0.05em"
                textTransform="uppercase"
                cursor="pointer"
                border="1px solid"
                transition="all 0.15s"
                background={active ? color + '22' : 'transparent'}
                color={active ? color : 'var(--text-secondary)'}
                borderColor={active ? color + '55' : 'var(--border-color)'}
                _hover={{ borderColor: color + '88', color: color }}
                style={{ userSelect: 'none' }}
              >
                {state}
              </Box>
            );
          })}
          {!allStatesActive && (
            <Box
              as="button"
              onClick={() => setActiveStates(new Set(ALL_STATES))}
              px="7px"
              py="2px"
              borderRadius="full"
              fontSize="9px"
              fontWeight="600"
              letterSpacing="0.05em"
              cursor="pointer"
              border="1px solid"
              borderColor="var(--border-color)"
              color="var(--text-secondary)"
              _hover={{ color: 'var(--text-primary)', borderColor: 'var(--text-secondary)' }}
              style={{ userSelect: 'none' }}
            >
              All
            </Box>
          )}
        </HStack>

        {/* Event type filter chips */}
        {eventTypes.length > 0 && (
          <HStack gap="4px" flexWrap="wrap">
            <Text fontSize="9px" color="var(--text-secondary)" fontWeight="600" letterSpacing="0.05em" textTransform="uppercase" flexShrink={0}>
              Event
            </Text>
            <Box
              as="button"
              onClick={() => setSelectedEventType(null)}
              px="7px"
              py="2px"
              borderRadius="full"
              fontSize="9px"
              fontWeight="600"
              letterSpacing="0.05em"
              cursor="pointer"
              border="1px solid"
              transition="all 0.15s"
              background={selectedEventType === null ? tint('var(--accent-primary)', 13) : 'transparent'}
              color={selectedEventType === null ? 'var(--accent-primary)' : 'var(--text-secondary)'}
              borderColor={selectedEventType === null ? tint('var(--accent-primary)', 33) : 'var(--border-color)'}
              _hover={{ borderColor: tint('var(--accent-primary)', 53), color: 'var(--accent-primary)' }}
              style={{ userSelect: 'none' }}
            >
              All
            </Box>
            {eventTypes.map((et) => {
              const isSelected = et === selectedEventType;
              return (
                <Box
                  key={et}
                  as="button"
                  onClick={() => setSelectedEventType((prev) => (prev === et ? null : et))}
                  px="7px"
                  py="2px"
                  borderRadius="full"
                  fontSize="9px"
                  fontWeight="600"
                  letterSpacing="0.05em"
                  cursor="pointer"
                  border="1px solid"
                  transition="all 0.15s"
                  background={isSelected ? '#3b82f622' : 'transparent'}
                  color={isSelected ? '#3b82f6' : 'var(--text-secondary)'}
                  borderColor={isSelected ? '#3b82f655' : 'var(--border-color)'}
                  _hover={{ borderColor: '#3b82f688', color: '#3b82f6' }}
                  style={{ userSelect: 'none' }}
                >
                  {et}
                </Box>
              );
            })}
          </HStack>
        )}
      </Box>

      {/* 3-D Manifold */}
      {filteredEvents.length > 0 && <SpatiotemporalManifold events={filteredEvents} />}

      {/* Column labels */}
      {filteredEvents.length > 0 && (
        <Box px={3} py="4px" borderBottom="1px solid" borderColor="var(--border-color)" background="var(--header-bg)" flexShrink={0}>
          <HStack gap={2} pl="14px">
            <Text fontSize="9px" color="var(--text-secondary)" style={{ minWidth: 28, textAlign: 'right' }}>#</Text>
            <Text fontSize="9px" color="var(--text-secondary)" style={{ minWidth: 64 }}>TIME</Text>
            <Text fontSize="9px" color="var(--text-secondary)" flex="1">EVENT</Text>
            <Text fontSize="9px" color="var(--text-secondary)" style={{ minWidth: 60 }}>STATE</Text>
          </HStack>
        </Box>
      )}

      {/* Event list */}
      <Box
        ref={scrollRef as any}
        flex="1"
        overflowY="auto"
        px={2}
        py={2}
        css={{
          '&::-webkit-scrollbar': { width: '4px' },
          '&::-webkit-scrollbar-track': { background: 'transparent' },
          '&::-webkit-scrollbar-thumb': { background: 'var(--border-color)', borderRadius: '2px' },
        }}
      >
        {events.length === 0 ? (
          <VStack height="100%" align="center" justify="center" gap={2} color="var(--text-secondary)" pt={12}>
            <Text fontSize="13px">
              {isConnected ? 'Waiting for row mutations…' : 'Connecting to event stream…'}
            </Text>
            <Text fontSize="11px" textAlign="center" maxWidth="220px">
              Start an OpenCode session — classified RTDB rows appear here as they land.
            </Text>
          </VStack>
        ) : filteredEvents.length === 0 ? (
          <VStack height="100%" align="center" justify="center" gap={2} color="var(--text-secondary)" pt={12}>
            <Text fontSize="13px">No matching events</Text>
            <Text fontSize="11px" color="var(--text-secondary)">
              Try a different search or toggle more states.
            </Text>
          </VStack>
        ) : (
          filteredEvents.map((event, i) => (
            <EventRow
              key={event.id ?? `${event.sessionId}-${event.toolName}-${i}`}
              event={event}
              index={filteredEvents.length - i}
            />
          ))
        )}
      </Box>
        </>
      ) : (
        <FeatureDataFeed />
      )}
    </Box>
  );
};
