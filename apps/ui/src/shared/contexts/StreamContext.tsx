/**
 * Stream Event Context - React Context + useReducer
 *
 * Manages the contract delivery queue from the ECE (Rust backend) via
 * Tauri IPC. The ECE buffers raw FredoEvent objects, evaluates
 * completeWhen conditions, and delivers ContractDelivery objects.
 *
 * ── Pipeline ──────────────────────────────────────────────────────────────
 * The sole data is `deliveries: ContractDelivery[]`. Components that
 * extend FredoFeatureClass receive deliveries through `handleDelivery`.
 * Non-feature components use useContractDelivery or useStepperEvents.
 *
 * ── Deprecated Backward Compat ────────────────────────────────────────────
 * FredoEvent types and legacy selectors (events, getEventsByTool, etc.) are
 * kept as empty/no-op stubs so files not yet migrated still compile. They
 * do NOT participate in state or runtime data flow.
 */

import React, { createContext, useContext, useReducer, useMemo, useCallback } from 'react';
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
 * @deprecated Events pipeline removed in SP#311. Kept for type-level backward compat.
 */
export type EventType = 'tool_use' | 'agent_session' | 'chat' | 'infrastructure' | 'ui' | 'custom';

/**
 * @deprecated Events pipeline removed in SP#311. Kept for type-level backward compat.
 */
export type EventProvider = 'open_code' | 'claude_code' | 'internal';

/**
 * @deprecated Events pipeline removed in SP#311. Kept for type-level backward compat.
 */
export type Transport = 'hook' | 'otlp_grpc' | 'otlp_http' | 'web_socket' | 'http_post' | 'internal';

/**
 * @deprecated Events pipeline removed in SP#311. Kept for type-level backward compat.
 */
export interface FredoEventError {
  message: string;
  code?: string;
  details?: Record<string, unknown>;
}

/**
 * @deprecated Events pipeline removed in SP#311. Kept for type-level backward compat.
 */
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
 * @deprecated Events pipeline removed in SP#311. Kept for type-level backward compat.
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
 * Stream state interface
 */
interface StreamState {
  /** Primary delivery queue from the ECE */
  deliveries: ContractDelivery[];
  isConnected: boolean;
}

/**
 * Stream actions
 */
type StreamAction =
  | { type: 'ADD_DELIVERY'; payload: ContractDelivery }
  | { type: 'CLEAR_EVENTS' }
  | { type: 'SET_CONNECTION_STATUS'; payload: boolean };

/**
 * Stream context value
 */
interface StreamContextValue extends StreamState {
  /** Add a contract delivery from the ECE */
  addDelivery: (delivery: ContractDelivery) => void;
  clearEvents: () => void;
  setConnectionStatus: (connected: boolean) => void;
  /** Get deliveries for a specific contract name */
  getDeliveriesByContract: (contractName: string) => ContractDelivery[];

  // ── @deprecated Backward-compat stubs (always empty/no-op) ──────────────
  events: FredoEvent[];
  addEvent: (event: FredoEvent) => void;
  clearProcessedEvents: (eventKeys: string[]) => void;
  cleanupExpiredEvents: () => void;
  getEventsByTool: (toolName: string) => FredoEvent[];
  getLatestEventByTool: (toolName: string) => FredoEvent | undefined;
  getEventsByState: (state: FredoEvent['state']) => FredoEvent[];
  getEventsByCorrelation: (correlationId: string) => FredoEvent[];
}

/**
 * Initial state
 */
const initialState: StreamState = {
  deliveries: [],
  isConnected: false,
};

const EMPTY_EVENTS: FredoEvent[] = [];

/**
 * Reducer function
 */
function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.type) {
    case 'ADD_DELIVERY': {
      const delivery = action.payload;
      // Deduplicate by id
      if (delivery.id && state.deliveries.some((d) => d.id === delivery.id)) {
        return state;
      }

      return { ...state, deliveries: [...state.deliveries, delivery] };
    }

    case 'CLEAR_EVENTS':
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
  const addDelivery = useCallback((delivery: ContractDelivery) => {
    dispatch({ type: 'ADD_DELIVERY', payload: delivery });
  }, []);

  const clearEvents = useCallback(() => {
    dispatch({ type: 'CLEAR_EVENTS' });
  }, []);

  const setConnectionStatus = useCallback((connected: boolean) => {
    dispatch({ type: 'SET_CONNECTION_STATUS', payload: connected });
  }, []);

  // Selectors (memoized to prevent re-renders)
  const getDeliveriesByContract = useCallback((contractName: string) => {
    return state.deliveries.filter((d) => d.contractName === contractName);
  }, [state.deliveries]);

  // ── @deprecated Backward-compat stubs ───────────────────────────────────

  // events is always empty — the event pipeline has been removed.
  // Use deliveries instead.
  const events: FredoEvent[] = EMPTY_EVENTS;

  const addEvent = useCallback((_event: FredoEvent) => {
    // No-op — the old ADD_EVENT pipeline is removed.
    // Deliveries are now the sole data path.
  }, []);

  const clearProcessedEvents = useCallback((_eventKeys: string[]) => {
    // No-op — events no longer exist in state.
  }, []);

  const cleanupExpiredEvents = useCallback(() => {
    // No-op — events no longer exist in state.
    // The ECE handles expiration via timeout field on contracts.
  }, []);

  const getEventsByTool = useCallback((_toolName: string) => {
    return EMPTY_EVENTS;
  }, []);

  const getLatestEventByTool = useCallback((_toolName: string) => {
    return undefined;
  }, []);

  const getEventsByState = useCallback((_state: FredoEvent['state']) => {
    return EMPTY_EVENTS;
  }, []);

  const getEventsByCorrelation = useCallback((_correlationId: string) => {
    return EMPTY_EVENTS;
  }, []);

  // Memoize context value
  const value = useMemo<StreamContextValue>(
    () => ({
      ...state,
      addDelivery,
      clearEvents,
      setConnectionStatus,
      getDeliveriesByContract,
      // Backward-compat stubs
      events,
      addEvent,
      clearProcessedEvents,
      cleanupExpiredEvents,
      getEventsByTool,
      getLatestEventByTool,
      getEventsByState,
      getEventsByCorrelation,
    }),
    [
      state,
      addDelivery,
      clearEvents,
      setConnectionStatus,
      getDeliveriesByContract,
      events,
      addEvent,
      clearProcessedEvents,
      cleanupExpiredEvents,
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
