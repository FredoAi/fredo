/// <reference types="vite/client" />

/**
 * API-related constants
 *
 * In dev (Vite proxy):  relative paths — proxy forwards /api → localhost:3000
 * In production / standalone: set VITE_API_URL to the backend origin
 */
export const API_BASE_URL = import.meta.env.VITE_API_URL || '';
export const MCP_BASE_URL = import.meta.env.VITE_MCP_URL || 'http://localhost:3001';
