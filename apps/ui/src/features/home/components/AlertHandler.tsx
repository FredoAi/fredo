import React, { useEffect, useRef } from 'react';
import { useAlertEvents } from '../hooks/useAlertEvents';
import { toaster } from '../../../shared/components/ui/toaster';

/**
 * AlertHandler Component
 * 
 * Listens to Fredo_ui_alert events and displays them as toasts.
 * Handles user confirmations and posts responses to the API.
 */
export const AlertHandler: React.FC = () => {
  const { alertEvents } = useAlertEvents();
  const processedAlertIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    alertEvents.forEach((event) => {
      // Alert tool publishes a single Response event (fire-and-forget).
      if (event.state !== 'Response') {
        return;
      }

      // alertId, text, isAlert, needsConfirmation all live in event.payload
      // (the tool calls publishResponse with all fields)
      const pay = event.payload as Record<string, unknown> | null;
      const alertId: string | undefined = pay?.alertId as string | undefined;
      const text: string | undefined = (pay?.text as string | undefined) ?? (pay?.message as string | undefined);
      const isAlert: boolean = (pay?.isAlert as boolean | undefined) ?? false;
      const needsConfirmation: boolean = (pay?.needsConfirmation as boolean | undefined) ?? false;

      if (!alertId || !text) return;
      if (processedAlertIds.current.has(alertId)) return;

      processedAlertIds.current.add(alertId);

      // Determine toast styling based on alert type
      const toastType = isAlert ? 'warning' : 'info';
      const borderColor = isAlert ? 'var(--status-warning)' : 'var(--status-info)';

      // Defer toast creation outside React's rendering cycle to avoid flushSync warning.
      setTimeout(() => {
        const toastId = toaster.create({
          title: isAlert ? 'Alert' : 'Message',
          description: text,
          type: toastType,
          // Confirmation alerts: never auto-dismiss, no X button — only the Confirm action dismisses them.
          // Info alerts: never auto-dismiss either, but the X button is available.
          duration: Infinity,
          action: needsConfirmation
            ? {
                label: 'Confirm',
                onClick: () => handleConfirm(alertId, text, toastId),
              }
            : undefined,
          meta: {
            closable: !needsConfirmation,
          },
          // @ts-ignore - Chakra toaster supports style prop
          style: {
            borderLeft: `4px solid ${borderColor}`,
            background: 'var(--card-bg)',
            color: 'var(--text-primary)',
          },
        });
      }, 0);
    });
  }, [alertEvents]);

  const handleConfirm = (_alertId: string, _alertText: string, toastId: string) => {
    toaster.dismiss(toastId);
  };

  // This component doesn't render anything - it's just an event handler
  return null;
};
