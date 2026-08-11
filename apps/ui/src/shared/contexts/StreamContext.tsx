/**
 * Stream Event Context - React Context + useReducer
 *
 * Manages the contract delivery queue from the ECE (Rust backend) via
 * Tauri IPC. The ECE buffers raw FredoEvent objects, evaluates
 * completeWhen conditions, and delivers ContractDelivery objects.
 *
 * ── New Pipeline ──────────────────────────────────────────────────────────
 * The primary data is `deliveries: ContractDelivery[]`. Components that
 * extend FredoFeatureClass receive deliveries through `handleDelivery`.
 * Non-feature components use useDeliveryFilter or useStepperEvents.
 *
 * ── Backward Compatibility ────────────────────────────────────────────────
 * `events: FredoEvent[]` and all legacy selectors (getEventsByTool, etc.)
 * are kept for features not yet migrated. New components should use
 * deliveries.
 */

import React, { createContext, useContext, useReducer, useMemo, useCallback, useEffect } from 'react';
import { EVENT_TTL_MS, DELIVERY_TTL_MS, CLEANUP_INTERVALS } from '../constants';
import type { ContractDelivery } from '../classes/EventSubscription';

/**
 * Stream event structure (from backend)
 */
// Note: Rust serializes EventSource enum with rename_all = "camelCase"
export type EventSource = 'hook' | 'otlpGrpc' | 'otlpHttp';
export type OtlpSignal  = 'Span' | 'Metric' | 'Log';

export interface OtlpPayload {
  signal: OtlpSignal;
  attributes: Record<string, any>;
}

/**
 * FredoEvent type exports — per REQ-1.13, REQ-1.14, REQ-1.16
 * Kept for backward compat with features not yet migrated to the ECE.
 */
export type EventType = 'tool_use' | 'agent_session' | 'chat' | 'infrastructure' | 'ui' | 'custom';
export type EventProvider = 'open_code' | 'claude_code' | 'internal';
export type Transport = 'hook' | 'otlp_grpc' | 'otlp_http' | 'web_socket' | 'http_post' | 'internal';

export interface FredoEventError {
  message: string;
  code?: string;
  details?: Record<string, unknown>;
}

export interface FredoEvent {
  id: string;
  eventType: EventType;
  state: 'Init' | 'Update' | 'Response' | 'Error';
  provider: EventProvider;
  transport: Transport;
  sessionId: string;
  correlationId?: string;
  toolName?: string;
  payload: Record<string, unknown> | null;
  error?: FredoEventError | null;
  metadata?: Record<string, unknown> | null;
  timestamp: string;
}

/**
 * @deprecated Use FredoEvent instead. StreamEvent is kept for backward compatibility
 * with legacy sessions in localStorage. New code should use FredoEvent.
 */
export interface StreamEvent {
  toolName: string;
  sessionId: string;
  state: 'Init' | 'Update' | 'Response' | 'Error';
  input?: any;
  response?: any;
  data?: any;
  timestamp: string;
  eventId?: string;
  correlationId?: string;
  error?: {
    message: string;
    code?: string;
    stack?: string;
    details?: any;
  };
  /** Discriminates where the event originated. Absent on legacy events = Hook. */
  source?: EventSource;
  /** Present only for OTLP-sourced events. */
  otlp?: OtlpPayload;
}

/**
 * Convert a ContractDelivery to a backward-compat FredoEvent.
 * Maps contractName → toolName, lifecycle → state, etc.
 */
function deliveryToFredoEvent(delivery: ContractDelivery): FredoEvent {
  const stateMap: Record<string, FredoEvent['state']> = {
    init: 'Init',
    update: 'Update',
    end: 'Response',
  };
  return {
    id: delivery.id,
    eventType: 'custom',
    state: stateMap[delivery.lifecycle] || 'Update',
    provider: (delivery.provider as EventProvider) || 'internal',
    transport: 'internal',
    sessionId: delivery.key?.sessionId || 'ece',
    correlationId: delivery.key?.correlationId,
    toolName: delivery.contractName,
    payload: delivery.payload as Record<string, unknown> | null,
    error: null,
    metadata: null,
    timestamp: delivery.timestamp,
  };
}

/**
 * Stream state interface
 */
interface StreamState {
  /** @deprecated Use deliveries instead. Kept for backward compat. */
  events: FredoEvent[];
  /** Primary delivery queue from the ECE */
  deliveries: ContractDelivery[];
  isConnected: boolean;
}

/**
 * Stream actions
 */
type StreamAction =
  | { type: 'ADD_EVENT'; payload: FredoEvent }
  | { type: 'ADD_DELIVERY'; payload: ContractDelivery }
  | { type: 'CLEAR_EVENTS' }
  | { type: 'CLEAR_PROCESSED_EVENTS'; payload: { eventKeys: string[] } }
  | { type: 'CLEANUP_EXPIRED_EVENTS'; payload: { ttlMs: number } }
  | { type: 'SET_CONNECTION_STATUS'; payload: boolean };

/**
 * Stream context value
 */
interface StreamContextValue extends StreamState {
  /** @deprecated Use addDelivery instead */
  addEvent: (event: FredoEvent) => void;
  /** Add a contract delivery from the ECE */
  addDelivery: (delivery: ContractDelivery) => void;
  clearEvents: () => void;
  clearProcessedEvents: (eventKeys: string[]) => void;
  cleanupExpiredEvents: () => void;
  setConnectionStatus: (connected: boolean) => void;
  /** @deprecated Use deliveries and filter by contractName instead */
  getEventsByTool: (toolName: string) => FredoEvent[];
  /** @deprecated Use deliveries and filter by contractName instead */
  getLatestEventByTool: (toolName: string) => FredoEvent | undefined;
  /** @deprecated Use deliveries and filter by lifecycle instead */
  getEventsByState: (state: FredoEvent['state']) => FredoEvent[];
  /** @deprecated Use deliveries and filter by key fields instead */
  getEventsByCorrelation: (correlationId: string) => FredoEvent[];
  /** Get deliveries for a specific contract name */
  getDeliveriesByContract: (contractName: string) => ContractDelivery[];
}

/**
 * Initial state
 */
const initialState: StreamState = {
  events: [],
  deliveries: [],
  isConnected: false,
};

/**
 * Reducer function
 */
function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.type) {
    case 'ADD_EVENT': {
      // Deduplicate by id to guard against duplicate IPC events
      const incoming = action.payload;
      if (incoming.id && state.events.some((e) => e.id === incoming.id)) {
        return state;
      }

      const newEvents = [...state.events, incoming];
      
      // Remove events older than TTL (60 seconds)
      const now = Date.now();
      const filteredEvents = newEvents.filter((e) => {
        const eventTime = new Date(e.timestamp).getTime();
        const age = now - eventTime;
        return age < EVENT_TTL_MS;
      });
      
      return { ...state, events: filteredEvents };
    }

    case 'ADD_DELIVERY': {
      const delivery = action.payload;
      // Deduplicate by id
      if (delivery.id && state.deliveries.some((d) => d.id === delivery.id)) {
        return state;
      }

      let newDeliveries = [...state.deliveries, delivery];

      // Cap deliveries at 5000, evict oldest entries when exceeded (REQ-1)
      if (newDeliveries.length > 5000) {
        newDeliveries = newDeliveries.slice(newDeliveries.length - 5000);
      }

      // Also add a backward-compat FredoEvent derived from the delivery
      const fredoEvent = deliveryToFredoEvent(delivery);
      const newEvents = [...state.events, fredoEvent];

      return { ...state, deliveries: newDeliveries, events: newEvents };
    }

    case 'CLEAR_EVENTS':
      return { ...state, events: [], deliveries: [] };

    case 'CLEAR_PROCESSED_EVENTS': {
      const keysToRemove = new Set(action.payload.eventKeys);
      const filteredEvents = state.events.filter((event) => {
        return !keysToRemove.has(event.id!);
      });
      
      return { ...state, events: filteredEvents };
    }

    case 'CLEANUP_EXPIRED_EVENTS': {
      const now = Date.now();
      const ttlMs = action.payload.ttlMs;
      const filteredEvents = state.events.filter((e) => {
        const eventTime = new Date(e.timestamp).getTime();
        const age = now - eventTime;
        return age < ttlMs;
      });
      
      // Also remove deliveries older than DELIVERY_TTL_MS (REQ-2)
      const filteredDeliveries = state.deliveries.filter((d) => {
        const deliveryTime = new Date(d.timestamp).getTime();
        const age = now - deliveryTime;
        return age < DELIVERY_TTL_MS;
      });
      
      return { ...state, events: filteredEvents, deliveries: filteredDeliveries };
    }

    case 'SET_CONNECTION_STATUS':
      return { ...state, isConnected: action.payload };

    default:
      return state;
  }
}

/**
 * Create context
 */
const StreamContext = createContext<StreamContextValue | undefined>(undefined);

/**
 * Provider component
 */
export function StreamProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(streamReducer, initialState);

  // Actions
  /** @deprecated Use addDelivery instead */
  const addEvent = useCallback((event: FredoEvent) => {
    dispatch({ type: 'ADD_EVENT', payload: event });
  }, []);

  const addDelivery = useCallback((delivery: ContractDelivery) => {
    dispatch({ type: 'ADD_DELIVERY', payload: delivery });
  }, []);

  const clearEvents = useCallback(() => {
    dispatch({ type: 'CLEAR_EVENTS' });
  }, []);

  const clearProcessedEvents = useCallback((eventKeys: string[]) => {
    dispatch({ type: 'CLEAR_PROCESSED_EVENTS', payload: { eventKeys } });
  }, []);

  const cleanupExpiredEvents = useCallback(() => {
    dispatch({ type: 'CLEANUP_EXPIRED_EVENTS', payload: { ttlMs: EVENT_TTL_MS } });
  }, []);

  const setConnectionStatus = useCallback((connected: boolean) => {
    dispatch({ type: 'SET_CONNECTION_STATUS', payload: connected });
  }, []);

  // Selectors (memoized to prevent re-renders)
  const getEventsByTool = useCallback((toolName: string) => {
    return state.events.filter((event) => event.toolName === toolName);
  }, [state.events]);

  const getLatestEventByTool = useCallback((toolName: string) => {
    const events = state.events.filter((event) => event.toolName === toolName);
    return events[events.length - 1];
  }, [state.events]);

  const getEventsByState = useCallback((stateFilter: StreamEvent['state']) => {
    return state.events.filter((event) => event.state === stateFilter);
  }, [state.events]);

  const getEventsByCorrelation = useCallback((correlationId: string) => {
    return state.events.filter((event) => event.correlationId === correlationId);
  }, [state.events]);

  const getDeliveriesByContract = useCallback((contractName: string) => {
    return state.deliveries.filter((d) => d.contractName === contractName);
  }, [state.deliveries]);

  // Auto-cleanup timer
  useEffect(() => {
    const interval = setInterval(() => {
      cleanupExpiredEvents();
    }, CLEANUP_INTERVALS.EVENTS);

    return () => clearInterval(interval);
  }, [cleanupExpiredEvents]);

  // Memoize context value
  const value = useMemo<StreamContextValue>(
    () => ({
      ...state,
      addEvent,
      addDelivery,
      clearEvents,
      clearProcessedEvents,
      cleanupExpiredEvents,
      setConnectionStatus,
      getEventsByTool,
      getLatestEventByTool,
      getEventsByState,
      getEventsByCorrelation,
      getDeliveriesByContract,
    }),
    [
      state,
      addEvent,
      addDelivery,
      clearEvents,
      clearProcessedEvents,
      cleanupExpiredEvents,
      setConnectionStatus,
      getEventsByTool,
      getLatestEventByTool,
      getEventsByState,
      getEventsByCorrelation,
      getDeliveriesByContract,
    ]
  );

  return <StreamContext.Provider value={value}>{children}</StreamContext.Provider>;
}

/**
 * Hook to use stream context
 */
export function useStream() {
  const context = useContext(StreamContext);
  if (context === undefined) {
    throw new Error('useStream must be used within a StreamProvider');
  }
  return context;
}

/**
 * Convenience hooks for specific use cases
 */

/**
 * Get all stepper deliveries from the ECE contract pipeline.
 * Uses the contract delivery queue instead of raw FredoEvent events.
 */
export function useStepperEvents() {
  const { deliveries } = useStream();
  return useMemo(
    () => deliveries.filter((d) => d.contractName === 'Fredo_ui_stepper'),
    [deliveries]
  );
}

/**
 * Get the latest stepper delivery from the ECE contract pipeline.
 */
export function useLatestStepperEvent() {
  const { deliveries } = useStream();
  return useMemo(() => {
    const stepperDeliveries = deliveries.filter((d) => d.contractName === 'Fredo_ui_stepper');
    return stepperDeliveries[stepperDeliveries.length - 1];
  }, [deliveries]);
}

export function useConnectionStatus() {
  const { isConnected } = useStream();
  return useMemo(
    () => ({ isConnected }),
    [isConnected]
  );
}
