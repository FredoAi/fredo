/**
 * Response Queue - Stores feature responses until handshake is established
 */

interface QueuedResponse {
  featureId: string;
  data: any;
  timestamp: string;
}

const QUEUE_KEY = 'Fredo_response_queue';

/**
 * Add a response to the queue for later sending
 */
export function queueResponse(featureId: string, data: any): void {
  try {
    const queue = getQueue();
    queue.push({
      featureId,
      data,
      timestamp: new Date().toISOString(),
    });
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    console.log(`[ResponseQueue] Queued response for ${featureId}`);
  } catch (error) {
    console.error('[ResponseQueue] Failed to queue response:', error);
  }
}

/**
 * Get all queued responses
 */
export function getQueue(): QueuedResponse[] {
  try {
    const queueJson = localStorage.getItem(QUEUE_KEY);
    return queueJson ? JSON.parse(queueJson) : [];
  } catch (error) {
    console.error('[ResponseQueue] Failed to read queue:', error);
    return [];
  }
}

/**
 * Clear the queue after successfully sending
 */
export function clearQueue(): void {
  try {
    localStorage.removeItem(QUEUE_KEY);
    console.log('[ResponseQueue] Queue cleared');
  } catch (error) {
    console.error('[ResponseQueue] Failed to clear queue:', error);
  }
}

/**
 * Get the number of queued responses
 */
export function getQueueSize(): number {
  return getQueue().length;
}
