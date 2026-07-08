/**
 * Timing-related constants
 */

/**
 * Event Time-To-Live in milliseconds
 */
export const EVENT_TTL_MS = 60 * 1000; // 60 seconds

/**
 * Delivery Time-To-Live in milliseconds (5 minutes)
 * Used by CLEANUP_EXPIRED_EVENTS to evict stale deliveries from the StreamContext.
 */
export const DELIVERY_TTL_MS = 300 * 1000; // 300 seconds = 5 minutes

/**
 * Cleanup Intervals
 */
export const CLEANUP_INTERVALS = {
  EVENTS: 10 * 1000, // 10 seconds
  EXPIRED_EVENTS: 60 * 1000, // 60 seconds
} as const;

/**
 * Toast Durations in milliseconds
 */
export const TOAST_DURATION = {
  SHORT: 2000,
  MEDIUM: 3000,
  LONG: 5000,
} as const;

/**
 * SSE Reconnection Settings
 */
export const SSE_SETTINGS = {
  RECONNECT_DELAY: 3000, // 3 seconds
  MAX_RECONNECT_ATTEMPTS: 5,
} as const;

/**
 * Animation Durations in seconds
 */
export const ANIMATION_DURATION = {
  FAST: 0.2,
  NORMAL: 0.3,
  SLOW: 0.6,
} as const;
