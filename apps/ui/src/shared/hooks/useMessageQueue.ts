import { useState, useCallback } from 'react';

interface QueuedMessage {
  id: string;
  type: string;
  data: any;
  timestamp: number;
}

export const useMessageQueue = () => {
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);

  const enqueue = useCallback((type: string, data: any) => {
    const message: QueuedMessage = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      data,
      timestamp: Date.now(),
    };
    setQueue(prev => [...prev, message]);
  }, []);

  const dequeue = useCallback((): QueuedMessage | null => {
    if (queue.length === 0) return null;
    const first = queue[0];
    setQueue(prev => prev.slice(1));
    return first;
  }, [queue]);

  const processQueue = useCallback(async (handler: (message: QueuedMessage) => Promise<void>) => {
    if (isProcessing) return;
    setIsProcessing(true);
    try {
      for (const message of queue) {
        await handler(message);
      }
      setQueue([]);
    } catch (error) {
      console.error('Error processing queue:', error);
    } finally {
      setIsProcessing(false);
    }
  }, [queue, isProcessing]);

  const clearQueue = useCallback(() => {
    setQueue([]);
  }, []);

  const size = queue.length;

  return {
    queue,
    enqueue,
    dequeue,
    processQueue,
    clearQueue,
    isProcessing,
    size,
  };
};
