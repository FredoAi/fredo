/**
 * Stream Event Context - React Context + useReducer
 *
 * Manages streaming events from Tauri IPC using native React state
 */

import React, { createContext, useContext, useReducer, useMemo, useCallback, useEffect } from 'react';
import { EVENT_TTL_MS, CLEANUP_INTERVALS } from '../constants';

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
 * FredoEvent — canonical event shape for the Fredo desktop app.
 *
 * Per REQ-1.1, all fields use camelCase serialization.
 * This is the new event type that complements (not replaces) StreamEvent.
 */
export interface FredoEvent {
  id: string;
  eventType: 'tool_use' | 'agent_session' | 'chat' | 'infrastructure' | 'ui' | 'custom';
  state: 'Init' | 'Update' | 'Response' | 'Error';
  provider: 'open_code' | 'claude_code' | 'internal';
  transport: 'hook' | 'otlp_grpc' | 'otlp_http' | 'web_socket' | 'http_post' | 'internal';
  sessionId: string;
  correlationId?: string;
  toolName?: string;
  payload: Record<string, unknown> | null;
  error?: FredoEventError | null;
  metadata?: Record<string, unknown> | null;
  timestamp: string;
}

export interface FredoEventError {
  message: string;
  code?: string;
  details?: Record<string, unknown>;
}

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
 * Stream state interface
 */
interface StreamState {
  events: StreamEvent[];
  isConnected: boolean;
}

/**
 * Stream actions
 */
type StreamAction =
  | { type: 'ADD_EVENT'; payload: StreamEvent }
  | { type: 'CLEAR_EVENTS' }
  | { type: 'CLEAR_PROCESSED_EVENTS'; payload: { eventKeys: string[] } }
  | { type: 'CLEANUP_EXPIRED_EVENTS'; payload: { ttlMs: number } }
  | { type: 'SET_CONNECTION_STATUS'; payload: boolean };

/**
 * Stream context value
 */
interface StreamContextValue extends StreamState {
  addEvent: (event: StreamEvent) => void;
  clearEvents: () => void;
  clearProcessedEvents: (eventKeys: string[]) => void;
  cleanupExpiredEvents: () => void;
  setConnectionStatus: (connected: boolean) => void;
  getEventsByTool: (toolName: string) => StreamEvent[];
  getLatestEventByTool: (toolName: string) => StreamEvent | undefined;
  getEventsByState: (state: StreamEvent['state']) => StreamEvent[];
  getEventsByCorrelation: (correlationId: string) => StreamEvent[];
}

/**
 * Initial state
 */
const initialState: StreamState = {
  events: [],
  isConnected: false,
};

/**
 * Reducer function
 */
function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.type) {
    case 'ADD_EVENT': {
      // Deduplicate by eventId to guard against duplicate IPC events
      const incoming = action.payload;
      if (incoming.eventId && state.events.some((e) => e.eventId === incoming.eventId)) {
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

    case 'CLEAR_EVENTS':
      return { ...state, events: [] };

    case 'CLEAR_PROCESSED_EVENTS': {
      const keysToRemove = new Set(action.payload.eventKeys);
      const filteredEvents = state.events.filter((event) => {
        return !keysToRemove.has(event.eventId!);
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
  const addEvent = useCallback((event: StreamEvent) => {
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
      clearEvents,
      clearProcessedEvents,
      cleanupExpiredEvents,
      setConnectionStatus,
      getEventsByTool,
      getLatestEventByTool,
      getEventsByState,
      getEventsByCorrelation,
    }),
    [
      state,
      addEvent,
      clearEvents,
      clearProcessedEvents,
      cleanupExpiredEvents,
      setConnectionStatus,
      getEventsByTool,
      getLatestEventByTool,
      getEventsByState,
      getEventsByCorrelation,
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
