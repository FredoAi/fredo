import { useState, useCallback } from 'react';

interface QueuedMessage {
  id: string;
  type: string;
  data: any;
  timestamp: number;
}

/**
 * Custom hook for managing message queue during animations or transitions
 */
export const useMessageQueue = () => {
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  
  /**
   * Add message to queue
   */
  const enqueue = useCallback((type: string, data: any) => {
    const message: QueuedMessage = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      data,
      timestamp: Date.now(),
    };
    
    setQueue(prev => [...prev, message]);
  }, []);
  
  /**
   * Process next message in queue
   */
  const dequeue = useCallback((): QueuedMessage | null => {
    let message: QueuedMessage | null = null;
    
    setQueue(prev => {
      if (prev.length === 0) return prev;
      
      const [first, ...rest] = prev;
      message = first;
      return rest;
    });
    
    return message;
  }, []);
  
  /**
   * Process all messages in queue with handler
   */
  const processQueue = useCallback(async (handler: (message: QueuedMessage) => Promise<void>) => {
    if (isProcessing || queue.length === 0) return;
    
    setIsProcessing(true);
    
    try {
      while (queue.length > 0) {
        const message = dequeue();
        if (message) {
          await handler(message);
        }
      }
    } catch (error) {
      console.error('Error processing queue:', error);
    } finally {
      setIsProcessing(false);
    }
  }, [queue, isProcessing, dequeue]);
  
  /**
   * Clear all messages from queue
   */
  const clearQueue = useCallback(() => {
    setQueue([]);
  }, []);
  
  /**
   * Get queue size
   */
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
