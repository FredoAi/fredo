/**
 * Feature class exports
 *
 * Exports both backward-compat legacy types and new ECE contract types.
 */

export * from './EventSubscription.js';
export * from './FredoApplicationClass.js';
export * from './types.js';

/** The optional application command surface contract (Spec #3097). */
export type { ApplicationCommandSurface } from '../hotkeys/commandSurface.js';
