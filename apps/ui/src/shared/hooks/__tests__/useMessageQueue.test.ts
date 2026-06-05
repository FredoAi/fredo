/**
 * PREREQUISITE: Requires vitest, @testing-library/react, @testing-library/jest-dom, and jsdom
 * to be installed in apps/ui/package.json before running.
 *   npm i -D vitest @testing-library/react @testing-library/jest-dom jsdom
 * Run with: npx vitest run
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMessageQueue } from '../useMessageQueue';

describe('useMessageQueue', () => {
  it('should return initial state with empty queue and not processing', () => {
    const { result } = renderHook(() => useMessageQueue());

    expect(result.current.queue).toEqual([]);
    expect(result.current.isProcessing).toBe(false);
    expect(result.current.size).toBe(0);
  });

  it('should enqueue messages and update size', () => {
    const { result } = renderHook(() => useMessageQueue());

    act(() => {
      result.current.enqueue('info', { text: 'hello' });
    });

    expect(result.current.size).toBe(1);
    expect(result.current.queue).toHaveLength(1);
    expect(result.current.queue[0].type).toBe('info');
    expect(result.current.queue[0].data).toEqual({ text: 'hello' });
  });

  it('should enqueue multiple messages', () => {
    const { result } = renderHook(() => useMessageQueue());

    act(() => {
      result.current.enqueue('type-a', { id: 1 });
      result.current.enqueue('type-b', { id: 2 });
    });

    expect(result.current.size).toBe(2);
    expect(result.current.queue[0].type).toBe('type-a');
    expect(result.current.queue[1].type).toBe('type-b');
  });

  it('should dequeue the first message (FIFO)', () => {
    const { result } = renderHook(() => useMessageQueue());

    act(() => {
      result.current.enqueue('first', { seq: 1 });
      result.current.enqueue('second', { seq: 2 });
    });

    let dequeued: unknown = null;
    act(() => {
      dequeued = result.current.dequeue();
    });

    expect(dequeued).not.toBeNull();
    if (dequeued) {
      const msg = dequeued as { type: string; data: { seq: number } };
      expect(msg.type).toBe('first');
      expect(msg.data.seq).toBe(1);
    }
    expect(result.current.size).toBe(1);
  });

  it('should return null when dequeueing from an empty queue', () => {
    const { result } = renderHook(() => useMessageQueue());

    let dequeued: unknown = null;
    act(() => {
      dequeued = result.current.dequeue();
    });

    expect(dequeued).toBeNull();
  });

  it('should clear the queue', () => {
    const { result } = renderHook(() => useMessageQueue());

    act(() => {
      result.current.enqueue('a', {});
      result.current.enqueue('b', {});
    });
    expect(result.current.size).toBe(2);

    act(() => {
      result.current.clearQueue();
    });

    expect(result.current.queue).toEqual([]);
    expect(result.current.size).toBe(0);
  });

  it('should process the queue with a handler and consume all messages', async () => {
    const { result } = renderHook(() => useMessageQueue());

    act(() => {
      result.current.enqueue('task', { id: 1 });
      result.current.enqueue('task', { id: 2 });
    });
    expect(result.current.size).toBe(2);

    const handler = vi.fn().mockResolvedValue(undefined);

    await act(async () => {
      await result.current.processQueue(handler);
    });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(result.current.size).toBe(0);
    expect(result.current.isProcessing).toBe(false);
  });

  it('should not process the queue if already processing', async () => {
    const { result } = renderHook(() => useMessageQueue());

    act(() => {
      result.current.enqueue('task', { id: 1 });
    });

    const handler = vi.fn().mockImplementation(async () => {
      // Simulate slow handler — during this time, isProcessing is true
      await new Promise((r) => setTimeout(r, 10));
    });

    let firstPromise: Promise<void>;
    act(() => {
      firstPromise = result.current.processQueue(handler);
    });

    // Attempt to process again while still processing (after first has started)
    let secondPromise: Promise<void>;
    act(() => {
      secondPromise = result.current.processQueue(handler);
    });

    await act(async () => {
      await firstPromise;
    });
    await act(async () => {
      await secondPromise;
    });

    // Handler should only have been called once (first processQueue found messages)
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should handle handler errors gracefully (edge case)', async () => {
    const { result } = renderHook(() => useMessageQueue());

    act(() => {
      result.current.enqueue('failing', { data: 'bad' });
    });

    const handler = vi.fn().mockRejectedValue(new Error('handler error'));

    await act(async () => {
      await result.current.processQueue(handler);
    });

    // Queue should be cleared and isProcessing reset despite error
    expect(result.current.isProcessing).toBe(false);
  });

  it('should not call handler if queue is empty (edge case)', async () => {
    const { result } = renderHook(() => useMessageQueue());

    const handler = vi.fn();

    await act(async () => {
      await result.current.processQueue(handler);
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result.current.isProcessing).toBe(false);
  });
});
