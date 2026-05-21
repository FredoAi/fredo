import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { useStream, type StreamEvent, type EventType } from '../../shared/contexts/StreamContext';
import { MCP_BASE_URL, STEP_STATUSES } from '../../shared/constants';
import type { HostAdapter } from '../adapters/HostAdapter';
import { adapterBridge } from '../../shared/utils/adapterBridge';

/** Maps a raw state string to the canonical set */
function normalizeState(state: string): StreamEvent['state'] {
  const valid = ['Init', 'Update', 'Response', 'Error'] as const;
  return valid.includes(state as any) ? (state as StreamEvent['state']) : 'Update';
}

export interface Step {
  name: string;
  description: string;
  status: typeof STEP_STATUSES[keyof typeof STEP_STATUSES];
  needsPermit: boolean;
}

interface AppState {
  isEnabled: boolean;
  isOnTargetUrl: boolean;
  currentUrl: string;
  FredoContent: string;
  currentPage: 'main' | 'steps' | 'dev-mode' | 'settings';
  steps: Step[];
  showDiagram: boolean;
  viewingLiveDiagram: boolean;
  isLoadingDiagram: boolean;
  diagramError: string;
  parseError: string;
}

interface AppActions {
  setIsEnabled: (enabled: boolean) => void;
  setIsOnTargetUrl: (isOn: boolean) => void;
  setCurrentUrl: (url: string) => void;
  setFredoContent: (content: string) => void;
  setCurrentPage: (page: 'main' | 'steps' | 'dev-mode' | 'settings') => void;
  setSteps: (steps: Step[]) => void;
  addStep: (step: Step) => void;
  updateStep: (index: number, step: Partial<Step>) => void;
  setShowDiagram: (show: boolean) => void;
  setViewingLiveDiagram: (viewing: boolean) => void;
  setIsLoadingDiagram: (loading: boolean) => void;
  setDiagramError: (error: string) => void;
  setParseError: (error: string) => void;
}

interface AppContextType extends AppState, AppActions {}

const AppContext = createContext<AppContextType | null>(null);

export const useExtension = () => {
  const context = useContext(AppContext);
  if (!context) throw new Error('useExtension must be used within AppProvider');
  return context;
};

interface AppProviderProps {
  adapter: HostAdapter;
  children: ReactNode;
}

export const AppProvider: React.FC<AppProviderProps> = ({ adapter, children }) => {
  const { addEvent, setConnectionStatus } = useStream();

  const [isEnabled, setIsEnabled] = useState(true);
  const [isOnTargetUrl, setIsOnTargetUrl] = useState(false);
  const [currentUrl, setCurrentUrl] = useState('');
  const [FredoContent, setFredoContent] = useState('');
  const [currentPage, setCurrentPage] = useState<'main' | 'steps' | 'dev-mode' | 'settings'>('main');
  const [steps, setSteps] = useState<Step[]>([]);
  const [showDiagram, setShowDiagram] = useState(false);
  const [viewingLiveDiagram, setViewingLiveDiagram] = useState(false);
  const [isLoadingDiagram, setIsLoadingDiagram] = useState(false);
  const [diagramError, setDiagramError] = useState('');
  const [parseError, setParseError] = useState('');

  const currentPageRef = useRef<'main' | 'steps' | 'dev-mode' | 'settings'>('main');
  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  // Mark as connected on mount — Tauri IPC is always available once the app starts.
  useEffect(() => {
    setConnectionStatus(true);
    return () => setConnectionStatus(false);
  }, []);

  // Forward Tauri IPC events from the adapter into StreamContext.
  useEffect(() => {
    const unsubscribe = adapter.onMessage((msg: Record<string, unknown>) => {
      // FredoEvent — already in the correct shape, just normalize state
      if (msg && typeof msg === 'object' && 'eventType' in msg) {
        addEvent({
          toolName: msg.toolName as string,
          sessionId: (msg.sessionId as string) || 'tauri',
          state: normalizeState(msg.state as string),
          input: msg.input,
          response: msg.response,
          data: msg.data,
          timestamp: msg.timestamp ? String(msg.timestamp) : new Date().toISOString(),
          eventId: (msg.id as string) || crypto.randomUUID(),
          correlationId: msg.correlationId as string | undefined,
          error: msg.error as StreamEvent['error'],
          source: msg.source as StreamEvent['source'],
          otlp: msg.otlp as StreamEvent['otlp'],
        });
        return;
      }

      // StreamEvent (legacy shape) — normalize and add FredoEvent-compatible fields
      if (msg && typeof msg === 'object' && 'toolName' in msg && 'state' in msg) {
        const toolName = msg.toolName as string;

        // Auto-navigate to stepper on Fredo_ui_stepper Init
        if (toolName === 'Fredo_ui_stepper' && msg.state === 'Init') {
          if (currentPageRef.current !== 'steps' && currentPageRef.current !== 'dev-mode') {
            setCurrentPage('steps');
          }
        }

        addEvent({
          toolName,
          sessionId: (msg.sessionId as string) || 'tauri',
          state: normalizeState(msg.state as string),
          input: msg.input,
          response: msg.response,
          data: msg.data,
          timestamp: msg.timestamp ? String(msg.timestamp) : new Date().toISOString(),
          eventId: msg.eventId as string | undefined,
          correlationId: msg.correlationId as string | undefined,
          error: msg.error as StreamEvent['error'],
          source: msg.source as StreamEvent['source'],
          otlp: msg.otlp as StreamEvent['otlp'],
        });
        return;
      }
    });
    return unsubscribe;
  }, [adapter, addEvent]);

  const addStep = (step: Step) => setSteps((prev) => [...prev, step]);
  const updateStep = (index: number, stepUpdate: Partial<Step>) =>
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...stepUpdate } : s)));

  return (
    <AppContext.Provider
      value={{
        isEnabled, isOnTargetUrl, currentUrl, FredoContent, currentPage,
        steps, showDiagram, viewingLiveDiagram, isLoadingDiagram,
        diagramError, parseError,
        setIsEnabled, setIsOnTargetUrl, setCurrentUrl, setFredoContent, setCurrentPage,
        setSteps, addStep, updateStep, setShowDiagram,
        setViewingLiveDiagram, setIsLoadingDiagram, setDiagramError, setParseError,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};
