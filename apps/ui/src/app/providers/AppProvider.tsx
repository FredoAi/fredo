import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { useStream } from '../../shared/contexts/StreamContext';
import type { SubscriptionDelivery, EventContract } from '../../shared/classes/EventSubscription';
import { MCP_BASE_URL, STEP_STATUSES } from '../../shared/constants';
import type { HostAdapter } from '../adapters/HostAdapter';
import { adapterBridge } from '../../shared/utils/adapterBridge';

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
  const { addDelivery, setConnectionStatus } = useStream();

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
      // SubscriptionDelivery — normalize and forward to StreamContext
      if (msg && typeof msg === 'object' && 'contractName' in msg && 'lifecycle' in msg) {
        const contractName = String(msg.contractName ?? '');
        const lifecycle = (msg.lifecycle as SubscriptionDelivery['lifecycle']) || 'Update';
        const correlationKey = String(msg.correlationKey ?? '');
        const fields = (msg.fields as Record<string, unknown>) || {};
        const timestamp = msg.timestamp ? String(msg.timestamp) : new Date().toISOString();
        const timedOut = Boolean(msg.timedOut);

        const delivery: SubscriptionDelivery = {
          contractName,
          lifecycle,
          correlationKey,
          fields,
          timestamp,
          timedOut,
          // Backward-compat fields for Mission Monitor and other feature files
          contract: { name: contractName } as EventContract,
          correlationId: correlationKey,
        };

        addDelivery(delivery);
        return;
      }

      // NOTE: Raw FredoEvent messages no longer cross the IPC bridge (REQ-11).
      // Only SubscriptionDelivery-shaped messages are accepted.
    });
    return unsubscribe;
  }, [adapter, addDelivery]);

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
