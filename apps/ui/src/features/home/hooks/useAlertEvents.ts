import { useMemo } from 'react';
import { useStream } from '../../../shared/contexts/StreamContext';
import type { StreamEvent } from '../../../shared/contexts/StreamContext';

/**
 * Alert event from Fredo_ui_alert tool
 * The tool publishes a single Response event — all fields are in event.response.
 */
export interface AlertEvent extends StreamEvent {
  toolName: 'Fredo_ui_alert';
  response?: {
    alertId: string;
    text: string;
    isAlert: boolean;
    needsConfirmation: boolean;
    timestamp: string;
    sent: boolean;
    message: string;
  };
}

/**
 * Hook to access alert events from StreamContext
 */
export const useAlertEvents = () => {
  const { events, getEventsByTool, getLatestEventByTool } = useStream();

  const alertEvents = useMemo(() => {
    return getEventsByTool('Fredo_ui_alert') as AlertEvent[];
  }, [events, getEventsByTool]);

  const latestAlert = useMemo(() => {
    return getLatestEventByTool('Fredo_ui_alert') as AlertEvent | undefined;
  }, [events, getLatestEventByTool]);

  return {
    alertEvents,
    latestAlert,
  };
};
