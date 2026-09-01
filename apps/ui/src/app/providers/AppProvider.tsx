import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { useStream, applyRowDelivery, applyRowDeliveries } from '../../shared/contexts/StreamContext';
import { isRowDelivery, isRowDeliveryBatch } from '../../shared/classes/EventSubscription';
import type { ContractDelivery } from '../../shared/classes/EventSubscription';
import { MCP_BASE_URL, STEP_STATUSES } from '../../shared/constants';
import type { HostAdapter } from '../adapters/HostAdapter';

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

  // Forward messages from the host's "fredo-stream-event" IPC channel into
  // the two coexisting pipelines (Spec #2788 strangler):
  //  1. RTDB RowDelivery envelopes → the module-scoped row store (P4.1):
  //     BATCH envelopes ({"rowBatch": [...]}, F-33 fix W-1) are checked
  //     FIRST and applied via the bulk path (one epoch bump per touched
  //     partition); single RowDelivery envelopes keep the per-delivery path.
  //  2. v1 ContractDelivery envelopes (ECE) → StreamContext.addDelivery —
  //     UNTOUCHED; features still run on v1 contracts until P4.2/P4.3.
  useEffect(() => {
    const unsubscribe = adapter.onMessage((msg: Record<string, unknown>) => {
      // RTDB BATCH envelope — discriminate by the `rowBatch` field BEFORE the
      // single-delivery path (backward compatible: singles still work).
      if (isRowDeliveryBatch(msg)) {
        applyRowDeliveries(msg.rowBatch);
        return;
      }

      // RTDB row delivery — discriminate by field presence (queryId + kind
      // in the insert/update/remove domain; ContractDelivery has none of these).
      if (isRowDelivery(msg)) {
        applyRowDelivery(msg);
        return;
      }

      // ContractDelivery from the ECE — the v1 pipeline
      if (msg && typeof msg === 'object' && 'contractName' in msg && 'lifecycle' in msg) {
        const delivery = msg as unknown as ContractDelivery;

        // Auto-navigate to stepper on Fredo_ui_stepper Init
        if (delivery.contractName === 'Fredo_ui_stepper' && delivery.lifecycle === 'init') {
          if (currentPageRef.current !== 'steps' && currentPageRef.current !== 'dev-mode') {
            setCurrentPage('steps');
          }
        }

        addDelivery(delivery);
        return;
      }

      // NOTE: Raw FredoEvent objects are no longer delivered via IPC per REQ-14.
      // The ECE silently drops unmatched events (REQ-9). Only ContractDelivery
      // objects reach the frontend.
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
