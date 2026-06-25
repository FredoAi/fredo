/**
 * Stream Event Context - React Context + useReducer
 *
 * Manages SubscriptionDelivery objects from Tauri IPC using native React state.
 * Raw FredoEvent objects never cross the IPC bridge — only SubscriptionDelivery
 * objects reach the frontend (Spec #295, REQ-11/REQ-12).
 */

import React, { createContext, useContext, useReducer, useMemo, useCallback, useEffect } from 'react';
import type { SubscriptionDelivery, Lifecycle } from '../classes/EventSubscription';
import { EVENT_TTL_MS } from '../constants';

// ── Backward-compatible type re-exports (kept for feature files not yet migrated) ──

/**
 * @deprecated Raw FredoEvent types are kept for backward compatibility with
 * feature files not yet migrated to the Event Contract Engine. New code should
 * work with SubscriptionDelivery exclusively.
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

// ── Stream state — stores SubscriptionDelivery[] instead of FredoEvent[] ──

interface StreamState {
  deliveries: SubscriptionDelivery[];
  isConnected: boolean;
}

/**
 * Stream actions
 */
type StreamAction =
  | { type: 'ADD_DELIVERY'; payload: SubscriptionDelivery }
  | { type: 'CLEAR_DELIVERIES' }
  | { type: 'SET_CONNECTION_STATUS'; payload: boolean };

/**
 * Stream context value
 */
interface StreamContextValue extends StreamState {
  addDelivery: (delivery: SubscriptionDelivery) => void;
  clearDeliveries: () => void;
  setConnectionStatus: (connected: boolean) => void;
  getDeliveriesByContract: (contractName: string) => SubscriptionDelivery[];
  getDeliveriesByLifecycle: (lifecycle: Lifecycle) => SubscriptionDelivery[];
  getDeliveriesByCorrelationKey: (correlationKey: string) => SubscriptionDelivery[];

  // ── @deprecated backward-compat properties (for feature files not yet migrated) ──
  /** @deprecated Use deliveries instead */
  events: FredoEvent[];
  /** @deprecated Use clearDeliveries instead */
  clearEvents: () => void;
  /** @deprecated Use getDeliveriesByLifecycle(lifecycle) instead */
  getEventsByTool: (toolName: string) => FredoEvent[];
  /** @deprecated */
  getLatestEventByTool: (toolName: string) => FredoEvent | undefined;
  /** @deprecated */
  getEventsByState: (state: FredoEvent['state']) => FredoEvent[];
  /** @deprecated Use getDeliveriesByCorrelationKey instead */
  getEventsByCorrelation: (correlationId: string) => FredoEvent[];
}

/**
 * Initial state
 */
const initialState: StreamState = {
  deliveries: [],
  isConnected: false,
};

/**
 * Reducer function
 */
function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.type) {
    case 'ADD_DELIVERY': {
      // Deduplicate by correlationKey+lifecycle to guard against duplicate IPC events
      const incoming = action.payload;
      const isDuplicate = state.deliveries.some(
        (d) => d.correlationKey === incoming.correlationKey && d.lifecycle === incoming.lifecycle
      );
      if (isDuplicate) {
        return state;
      }

      const newDeliveries = [...state.deliveries, incoming];

      // Remove deliveries older than TTL (60 seconds)
      const now = Date.now();
      const filteredDeliveries = newDeliveries.filter((d) => {
        const deliveryTime = new Date(d.timestamp).getTime();
        const age = now - deliveryTime;
        return age < EVENT_TTL_MS;
      });

      return { ...state, deliveries: filteredDeliveries };
    }

    case 'CLEAR_DELIVERIES':
      return { ...state, deliveries: [] };

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
  const addDelivery = useCallback((delivery: SubscriptionDelivery) => {
    dispatch({ type: 'ADD_DELIVERY', payload: delivery });
  }, []);

  const clearDeliveries = useCallback(() => {
    dispatch({ type: 'CLEAR_DELIVERIES' });
  }, []);

  const setConnectionStatus = useCallback((connected: boolean) => {
    dispatch({ type: 'SET_CONNECTION_STATUS', payload: connected });
  }, []);

  // Selectors (memoized to prevent re-renders)
  const getDeliveriesByContract = useCallback((contractName: string) => {
    return state.deliveries.filter((d) => d.contractName === contractName);
  }, [state.deliveries]);

  const getDeliveriesByLifecycle = useCallback((lifecycle: Lifecycle) => {
    return state.deliveries.filter((d) => d.lifecycle === lifecycle);
  }, [state.deliveries]);

  const getDeliveriesByCorrelationKey = useCallback((correlationKey: string) => {
    return state.deliveries.filter((d) => d.correlationKey === correlationKey);
  }, [state.deliveries]);

  // ── @deprecated backward-compat selectors (return empty arrays) ──
  const clearEvents = useCallback(() => {}, []);

  const getEventsByTool = useCallback((_toolName: string) => {
    return [] as FredoEvent[];
  }, []);

  const getLatestEventByTool = useCallback((_toolName: string) => {
    return undefined;
  }, []);

  const getEventsByState = useCallback((_state: FredoEvent['state']) => {
    return [] as FredoEvent[];
  }, []);

  const getEventsByCorrelation = useCallback((_correlationId: string) => {
    return [] as FredoEvent[];
  }, []);

  // Memoize context value
  const value = useMemo<StreamContextValue>(
    () => ({
      ...state,
      addDelivery,
      clearDeliveries,
      setConnectionStatus,
      getDeliveriesByContract,
      getDeliveriesByLifecycle,
      getDeliveriesByCorrelationKey,
      // Backward-compat aliases
      events: [],
      clearEvents,
      getEventsByTool,
      getLatestEventByTool,
      getEventsByState,
      getEventsByCorrelation,
    }),
    [
      state,
      addDelivery,
      clearDeliveries,
      setConnectionStatus,
      getDeliveriesByContract,
      getDeliveriesByLifecycle,
      getDeliveriesByCorrelationKey,
      clearEvents,
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
 * Convenience hooks for ECE-based consumption
 */
export function useDeliveriesByContract(contractName: string) {
  const { deliveries } = useStream();
  return useMemo(
    () => deliveries.filter((d) => d.contractName === contractName),
    [deliveries, contractName]
  );
}

export function useDeliveriesByLifecycle(lifecycle: Lifecycle) {
  const { deliveries } = useStream();
  return useMemo(
    () => deliveries.filter((d) => d.lifecycle === lifecycle),
    [deliveries, lifecycle]
  );
}

export function useConnectionStatus() {
  const { isConnected } = useStream();
  return useMemo(
    () => ({ isConnected }),
    [isConnected]
  );
}
