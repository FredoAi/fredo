/**
 * Stream Event Context - React Context + useReducer
 *
 * Manages streaming events from Tauri IPC using native React state.
 * Stores SubscriptionDelivery objects (not raw FredoEvents).
 */

import React, { createContext, useContext, useReducer, useMemo, useCallback, useEffect } from 'react';
import { EVENT_TTL_MS, CLEANUP_INTERVALS } from '../constants';
import type { SubscriptionDelivery, EventContract, Lifecycle } from '../classes/EventSubscription';

/**
 * --- LEGACY TYPES (kept for backward compatibility with replay/storage) ---
 * Raw FredoEvent type — used only for session replay and localStorage persistence.
 * The IPC channel no longer carries FredoEvent; only SubscriptionDelivery.
 */
export type EventSource = 'hook' | 'otlpGrpc' | 'otlpHttp';
export type OtlpSignal  = 'Span' | 'Metric' | 'Log';

export interface OtlpPayload {
  signal: OtlpSignal;
  attributes: Record<string, any>;
}

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
  source?: EventSource;
  otlp?: OtlpPayload;
}

/**
 * Stream state interface — stores SubscriptionDelivery[] instead of FredoEvent[]
 */
interface StreamState {
  /** Primary event store — SubscriptionDelivery objects from the Contract Engine */
  deliveries: SubscriptionDelivery<EventContract>[];
  /** Legacy events (FredoEvent) — kept for replay/migration */
  events: FredoEvent[];
  isConnected: boolean;
}

/**
 * Stream actions
 */
type StreamAction =
  | { type: 'ADD_DELIVERY'; payload: SubscriptionDelivery<EventContract> }
  | { type: 'ADD_EVENT'; payload: FredoEvent }
  | { type: 'CLEAR_EVENTS' }
  | { type: 'CLEAR_PROCESSED_EVENTS'; payload: { eventKeys: string[] } }
  | { type: 'CLEANUP_EXPIRED_EVENTS'; payload: { ttlMs: number } }
  | { type: 'SET_CONNECTION_STATUS'; payload: boolean };

/**
 * Stream context value
 */
interface StreamContextValue extends StreamState {
  addDelivery: (delivery: SubscriptionDelivery<EventContract>) => void;
  addEvent: (event: FredoEvent) => void;
  clearEvents: () => void;
  clearProcessedEvents: (eventKeys: string[]) => void;
  cleanupExpiredEvents: () => void;
  setConnectionStatus: (connected: boolean) => void;
  getEventsByTool: (toolName: string) => FredoEvent[];
  getLatestEventByTool: (toolName: string) => FredoEvent | undefined;
  getEventsByState: (state: FredoEvent['state']) => FredoEvent[];
  getEventsByCorrelation: (correlationId: string) => FredoEvent[];
  getDeliveriesByContract: (contractName: string) => SubscriptionDelivery<EventContract>[];
  getDeliveriesByLifecycle: (lifecycle: Lifecycle) => SubscriptionDelivery<EventContract>[];
  getLatestDelivery: (contractName: string) => SubscriptionDelivery<EventContract> | undefined;
}

/**
 * Initial state
 */
const initialState: StreamState = {
  deliveries: [],
  events: [],
  isConnected: false,
};

/**
 * Reducer function
 */
function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.type) {
    case 'ADD_DELIVERY': {
      const incoming = action.payload;
      return {
        ...state,
        deliveries: [...state.deliveries, incoming],
      };
    }

    case 'ADD_EVENT': {
      const incoming = action.payload;
      if (incoming.id && state.events.some((e) => e.id === incoming.id)) {
        return state;
      }

      const newEvents = [...state.events, incoming];
      
      const now = Date.now();
      const filteredEvents = newEvents.filter((e) => {
        const eventTime = new Date(e.timestamp).getTime();
        const age = now - eventTime;
        return age < EVENT_TTL_MS;
      });
      
      return { ...state, events: filteredEvents };
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
      const filteredEvents = state.events.filter((e) => {
        const eventTime = new Date(e.timestamp).getTime();
        const age = now - eventTime;
        return age < action.payload.ttlMs;
      });
      
      return { ...state, events: filteredEvents };
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
  const addDelivery = useCallback((delivery: SubscriptionDelivery<EventContract>) => {
    dispatch({ type: 'ADD_DELIVERY', payload: delivery });
  }, []);

  const addEvent = useCallback((event: FredoEvent) => {
    dispatch({ type: 'ADD_EVENT', payload: event });
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

  const getDeliveriesByLifecycle = useCallback((lifecycle: Lifecycle) => {
    return state.deliveries.filter((d) => d.lifecycle === lifecycle);
  }, [state.deliveries]);

  const getLatestDelivery = useCallback((contractName: string) => {
    const matching = state.deliveries.filter((d) => d.contractName === contractName);
    return matching[matching.length - 1];
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
      addDelivery,
      addEvent,
      clearEvents,
      clearProcessedEvents,
      cleanupExpiredEvents,
      setConnectionStatus,
      getEventsByTool,
      getLatestEventByTool,
      getEventsByState,
      getEventsByCorrelation,
      getDeliveriesByContract,
      getDeliveriesByLifecycle,
      getLatestDelivery,
    }),
    [
      state,
      addDelivery,
      addEvent,
      clearEvents,
      clearProcessedEvents,
      cleanupExpiredEvents,
      setConnectionStatus,
      getEventsByTool,
      getLatestEventByTool,
      getEventsByState,
      getEventsByCorrelation,
      getDeliveriesByContract,
      getDeliveriesByLifecycle,
      getLatestDelivery,
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
export function useStepperEvents() {
  const { events } = useStream();
  return useMemo(
    () => events.filter((event) => event.toolName === 'Fredo_ui_stepper'),
    [events]
  );
}

export function useLatestStepperEvent() {
  const { events } = useStream();
  return useMemo(() => {
    const stepperEvents = events.filter((event) => event.toolName === 'Fredo_ui_stepper');
    return stepperEvents[stepperEvents.length - 1];
  }, [events]);
}

export function useConnectionStatus() {
  const { isConnected } = useStream();
  return useMemo(
    () => ({ isConnected }),
    [isConnected]
  );
}
