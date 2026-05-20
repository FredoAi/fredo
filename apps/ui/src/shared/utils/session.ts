/**
 * Session management utilities for URL-aware SSE connection tracking
 */

export interface StoredSession {
  connectionId: string;
  timestamp: number;
}

const SESSION_PREFIX = 'Fredo_session_';
const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

// Agent conversation URL pattern: https://agent.digitalcoedevops.com/chat/{conversationId}
// Conversation IDs are MongoDB ObjectIDs (24 hex chars) or similar long IDs
// Excludes keywords like "new", "settings" by requiring minimum 20 characters
const AGENT_CHAT_PATTERN = /^https:\/\/agent\.digitalcoedevops\.com\/chat\/([a-f0-9]{20,})$/;

/**
 * Extract conversation URL from window.location
 * Strips query params and hash to get stable conversation identifier
 * 
 * Example: https://agent.digitalcoedevops.com/chat/abc123?foo=bar#section
 * Returns: https://agent.digitalcoedevops.com/chat/abc123
 */
export function getConversationUrl(url?: string): string {
  const targetUrl = url || window.location.href;
  const parsedUrl = new URL(targetUrl);
  return `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;
}

/**
 * Extract conversation ID from Agent URL
 * 
 * @param url - Full or normalized conversation URL
 * @returns Conversation ID if URL matches pattern, null otherwise
 * 
 * Example: https://agent.digitalcoedevops.com/chat/6992208c563503de8a6b89e2
 * Returns: "6992208c563503de8a6b89e2"
 */
export function extractConversationId(url: string): string | null {
  try {
    const normalizedUrl = getConversationUrl(url);
    const match = normalizedUrl.match(AGENT_CHAT_PATTERN);
    return match ? match[1] : null;
  } catch (error) {
    console.error('[Session] Error extracting conversation ID:', error);
    return null;
  }
}

/**
 * Check if URL is a valid Agent conversation URL
 * Only matches exact pattern: https://agent.digitalcoedevops.com/chat/{id}
 * 
 * @param url - Full or normalized conversation URL
 * @returns true if URL has a conversation ID, false otherwise
 */
export function isValidConversationUrl(url: string): boolean {
  return extractConversationId(url) !== null;
}

/**
 * Get stored session for a specific conversation URL
 * Returns null if no session exists, URL is invalid, or if session has expired
 */
export function getStoredSession(conversationUrl: string): StoredSession | null {
  try {
    // Validate URL before retrieving session
    if (!isValidConversationUrl(conversationUrl)) {
      console.log('[Session] Cannot retrieve - invalid URL:', conversationUrl);
      return null;
    }
    
    const key = `${SESSION_PREFIX}${conversationUrl}`;
    const stored = localStorage.getItem(key);
    
    if (!stored) {
      console.log('[Session] No session found for:', conversationUrl);
      return null;
    }
    
    const session: StoredSession = JSON.parse(stored);
    
    // Check if session has expired
    const age = Date.now() - session.timestamp;
    if (age > SESSION_EXPIRY_MS) {
      localStorage.removeItem(key);
      return null;
    }
    
    return session;
  } catch (error) {
    console.error('[Session] Error reading session:', error);
    return null;
  }
}

/**
 * Store session for a specific conversation URL
 * Only stores if URL is a valid conversation URL
 */
export function storeSession(conversationUrl: string, connectionId: string): void {
  try {
    // Validate URL before storing session (defensive programming)
    if (!isValidConversationUrl(conversationUrl)) {
      return;
    }
    
    const key = `${SESSION_PREFIX}${conversationUrl}`;
    const session: StoredSession = {
      connectionId,
      timestamp: Date.now()
    };
    
    localStorage.setItem(key, JSON.stringify(session));
  } catch (error) {
    console.error('[Session] Error storing session:', error);
  }
}

/**
 * Remove session for a specific conversation URL
 */
export function removeSession(conversationUrl: string): void {
  try {
    const key = `${SESSION_PREFIX}${conversationUrl}`;
    localStorage.removeItem(key);
    console.log('[Session] Removed session for:', conversationUrl);
  } catch (error) {
    console.error('[Session] Error removing session:', error);
  }
}

/**
 * Clean up all expired sessions from localStorage
 */
export function cleanupExpiredSessions(): void {
  try {
    const keysToRemove: string[] = [];
    
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(SESSION_PREFIX)) {
        continue;
      }
      
      const stored = localStorage.getItem(key);
      if (!stored) {
        continue;
      }
      
      try {
        const session: StoredSession = JSON.parse(stored);
        const age = Date.now() - session.timestamp;
        
        if (age > SESSION_EXPIRY_MS) {
          keysToRemove.push(key);
        }
      } catch {
        // Invalid JSON, remove it
        keysToRemove.push(key);
      }
    }
    
    keysToRemove.forEach(key => {
      localStorage.removeItem(key);
    });
    
    if (keysToRemove.length > 0) {
      console.log(`[Session] Cleaned up ${keysToRemove.length} expired session(s)`);
    }
  } catch (error) {
    console.error('[Session] Error during cleanup:', error);
  }
}
