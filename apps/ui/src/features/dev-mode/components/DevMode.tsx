import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Box, Text, HStack, VStack, Badge, Button, Code, Input, chakra } from '@chakra-ui/react';
import { motion, AnimatePresence } from 'framer-motion';

// Chakra v3 + framer-motion wrapper
const MotionBox = chakra(motion.div as any) as any;
import {
  LuWifi, LuWifiOff, LuTrash2, LuChevronDown, LuChevronRight, LuSearch, LuX, LuRadio,
} from 'react-icons/lu';
import { useDevModeStream } from '../hooks/useDevModeStream';
import type { StreamEvent, EventSource } from '../../../shared/contexts/StreamContext';
import { SpatiotemporalManifold } from './SpatiotemporalManifold';

// ── Source badge colours ──────────────────────────────────────────────────────

const SOURCE_LABELS: Record<EventSource, string> = {
  hook:      'hook',
  otlpGrpc:  'gRPC',
  otlpHttp:  'HTTP',
};

const SOURCE_COLORS: Record<EventSource, string> = {
  hook:      '#f59e0b',   // amber
  otlpGrpc:  '#ff6347',  // tomato-orange
  otlpHttp:  '#ff6347',  // tomato-orange
};

const SIGNAL_COLORS: Record<string, string> = {
  Span:   '#3b82f6',
  Metric: '#22c55e',
  Log:    '#a855f7',
};

// ── State badge colours ───────────────────────────────────────────────────────

const STATE_COLORS: Record<StreamEvent['state'], string> = {
  Init: '#3b82f6',
  Update: '#f59e0b',
  Response: '#22c55e',
  Error: '#ef4444',
};

// ── OTLP payload viewer ───────────────────────────────────────────────────────

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
  event: StreamEvent;
  index: number;
}

const EventRow: React.FC<EventRowProps> = ({ event, index }) => {
  const [expanded, setExpanded] = useState(false);

  const payload =
    event.otlp
      ? event.otlp.attributes
      : event.state === 'Init' ? event.input
      : event.state === 'Response' ? event.response
      : event.state === 'Error' ? event.error
      : (() => {
          try { return JSON.parse(event.data as string); }
          catch { return event.data; }
        })();

  const hasPayload = payload !== undefined && payload !== null;

  const isOtlp = event.source === 'otlpGrpc' || event.source === 'otlpHttp';
  const sourceKey: EventSource = event.source ?? 'hook';

  // For hook events, prefer event_type from the payload over toolName
  const hookMeta = event.input ?? event.response;
  const hookEventType: string | undefined = (hookMeta as any)?.event_type;
  const eventType = isOtlp
    ? event.toolName
    : hookEventType ?? event.toolName;
  // Show toolName as a dim secondary label when event_type differs
  const showTool = !isOtlp && hookEventType && hookEventType !== event.toolName;

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
          {eventType}
          {showTool && (
            <Text as="span" fontSize="10px" color="var(--text-secondary)" fontWeight="400" ml={1}>
              ({event.toolName})
            </Text>
          )}
        </Text>
        {/* OTLP signal badge */}
        {isOtlp && event.otlp && (
          <Badge
            flexShrink={0}
            fontSize="9px"
            px={2}
            py="1px"
            borderRadius="full"
            background={(SIGNAL_COLORS[event.otlp.signal] ?? '#888') + '22'}
            color={SIGNAL_COLORS[event.otlp.signal] ?? '#888'}
            border="1px solid"
            borderColor={(SIGNAL_COLORS[event.otlp.signal] ?? '#888') + '55'}
            textTransform="uppercase"
            letterSpacing="0.05em"
          >
            {event.otlp.signal}
          </Badge>
        )}
        {/* Source badge — only show if not the default hook */}
        {sourceKey !== 'hook' && (
          <Badge
            flexShrink={0}
            fontSize="9px"
            px={2}
            py="1px"
            borderRadius="full"
            background={SOURCE_COLORS[sourceKey] + '22'}
            color={SOURCE_COLORS[sourceKey]}
            border="1px solid"
            borderColor={SOURCE_COLORS[sourceKey] + '55'}
            letterSpacing="0.03em"
          >
            {SOURCE_LABELS[sourceKey]}
          </Badge>
        )}
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
              {isOtlp && typeof payload === 'object' && payload !== null
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

// ── Main component ────────────────────────────────────────────────────────────

const ALL_STATES = ['Init', 'Update', 'Response', 'Error'] as const;
const ALL_SOURCES: EventSource[] = ['hook', 'otlpGrpc', 'otlpHttp'];

export const DevMode: React.FC = () => {
  const { events, eventTypes, sources, isConnected, clearEvents } = useDevModeStream();
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Filter state ────────────────────────────────────────────────────────────
  const [query, setQuery] = useState('');
  const [activeStates, setActiveStates] = useState<Set<StreamEvent['state']>>(new Set(ALL_STATES));
  const [selectedEventType, setSelectedEventType] = useState<string | null>(null);
  const [activeSource, setActiveSource] = useState<EventSource | null>(null);

  const toggleState = (state: StreamEvent['state']) => {
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
      const isOtlp = e.source === 'otlpGrpc' || e.source === 'otlpHttp';
      const et = isOtlp
        ? (e.otlp ? `${e.otlp.signal.toLowerCase()}:${e.toolName}` : e.toolName)
        : ((e.input ?? e.response) as any)?.event_type ?? e.toolName;
      if (selectedEventType && et !== selectedEventType) return false;
      if (activeSource && (e.source ?? 'hook') !== activeSource) return false;
      if (!q) return true;
      if (et.toLowerCase().includes(q)) return true;
      try {
        const payload = e.otlp?.attributes ?? e.input ?? e.response;
        if (JSON.stringify(payload).toLowerCase().includes(q)) return true;
      } catch { /* ignore */ }
      return false;
    });
  }, [events, query, activeStates, selectedEventType, activeSource]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [filteredEvents.length]);

  const allStatesActive = activeStates.size === ALL_STATES.length;

  return (
    <Box width="100%" height="100vh" display="flex" flexDirection="column" background="var(--body-bg)" overflow="hidden">
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
              background={selectedEventType === null ? 'var(--accent-primary)22' : 'transparent'}
              color={selectedEventType === null ? 'var(--accent-primary)' : 'var(--text-secondary)'}
              borderColor={selectedEventType === null ? 'var(--accent-primary)55' : 'var(--border-color)'}
              _hover={{ borderColor: 'var(--accent-primary)88', color: 'var(--accent-primary)' }}
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

        {/* Source filter chips — only shown once >1 source detected */}
        {sources.length > 1 && (
          <HStack gap="4px" flexWrap="wrap" mt="4px">
            <Text fontSize="9px" color="var(--text-secondary)" fontWeight="600" letterSpacing="0.05em" textTransform="uppercase" flexShrink={0}>
              <LuRadio size={9} style={{ display: 'inline', marginRight: 3 }} />
              Src
            </Text>
            <Box
              as="button"
              onClick={() => setActiveSource(null)}
              px="7px" py="2px" borderRadius="full" fontSize="9px" fontWeight="600"
              letterSpacing="0.05em" cursor="pointer" border="1px solid" transition="all 0.15s"
              background={activeSource === null ? 'var(--accent-primary)22' : 'transparent'}
              color={activeSource === null ? 'var(--accent-primary)' : 'var(--text-secondary)'}
              borderColor={activeSource === null ? 'var(--accent-primary)55' : 'var(--border-color)'}
              style={{ userSelect: 'none' }}
            >
              All
            </Box>
            {ALL_SOURCES.filter((s) => sources.includes(s)).map((s) => {
              const isActive = activeSource === s;
              const color = SOURCE_COLORS[s];
              return (
                <Box
                  key={s}
                  as="button"
                  onClick={() => setActiveSource((prev) => (prev === s ? null : s))}
                  px="7px" py="2px" borderRadius="full" fontSize="9px" fontWeight="600"
                  letterSpacing="0.05em" cursor="pointer" border="1px solid" transition="all 0.15s"
                  background={isActive ? color + '22' : 'transparent'}
                  color={isActive ? color : 'var(--text-secondary)'}
                  borderColor={isActive ? color + '55' : 'var(--border-color)'}
                  _hover={{ borderColor: color + '88', color }}
                  style={{ userSelect: 'none' }}
                >
                  {SOURCE_LABELS[s]}
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
              {isConnected ? 'Waiting for events…' : 'Connecting to event stream…'}
            </Text>
            <Text fontSize="11px" textAlign="center" maxWidth="220px">
              Start an OpenCode session — Fredo will receive OTLP telemetry automatically.
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
              key={event.eventId ?? `${event.sessionId}-${event.toolName}-${i}`}
              event={event}
              index={filteredEvents.length - i}
            />
          ))
        )}
      </Box>
    </Box>
  );
};
