/**
 * Spec #3120 (P6), ST-1 — the ONE host registry the launcher reaches synchronously.
 *
 * An application's navigation provider registers its single `NavigationHost` (with the declared
 * surface) on mount and unregisters on unmount. The launcher reads the registry directly — a
 * synchronous `Map` lookup, never a subscription or an IPC call — so `Ctrl+Space` over a
 * registered app can build the context header and route an intent without a network round-trip
 * (NFR-1). An app with no registration is the AC1 fallback (`null`), which keeps the shipped
 * launcher DOM byte-identical.
 *
 * The registry is module-scoped (it must survive component mount/unmount cycles) and holds NO
 * state beyond the live registrations — no persistence, no clock, no I/O.
 */

import type { ContextEnvelope, Surface } from '../types';
import type { NavigationHost } from './host';

/** One application's live registration. */
export interface NavigationHostRegistration {
  readonly appId: string;
  readonly surface: Surface;
  readonly host: NavigationHost;
}

interface RegistryEntry {
  readonly registration: NavigationHostRegistration;
}

/** Module-scoped: the live registrations keyed by `appId` (last registration wins). */
const registry = new Map<string, RegistryEntry>();

/**
 * Spec #3120 ST-2 — the companion publisher subscribes here so a host that mounts after
 * boot (an app opening) republishes the per-surface manifest. Notified AFTER the registry
 * changes, so a listener that reads `listRegisteredSurfaces()` sees the new state.
 */
const listeners = new Set<() => void>();

/** Subscribe to navigation-host registration/unregistration. */
export function subscribeNavigationHosts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyNavigationHosts(): void {
  // Copy before iterating so an unsubscribe during notification is safe.
  for (const listener of [...listeners]) listener();
}

/**
 * Register one app's host on provider mount; the returned disposer unregisters it. Both the
 * registration and the unregistration are idempotent: registering again replaces the entry (a
 * StrictMode remount), and calling the disposer twice — or after a newer registration — is a
 * no-op that never removes the newer host.
 */
export function registerNavigationHost(registration: NavigationHostRegistration): () => void {
  const entry: RegistryEntry = { registration };
  registry.set(registration.appId, entry);
  notifyNavigationHosts();
  return () => {
    if (registry.get(registration.appId) === entry) {
      registry.delete(registration.appId);
      notifyNavigationHosts();
    }
  };
}

/** The registered host for `appId`, or `null` when the app declared no surface. */
export function getNavigationHost(appId: string): NavigationHost | null {
  return registry.get(appId)?.registration.host ?? null;
}

/** The registered declaration for `appId`, or `null` when the app declared no surface. */
export function getRegisteredSurface(appId: string): Surface | null {
  return registry.get(appId)?.registration.surface ?? null;
}

/** Every registered declaration, in registration order. */
export function listRegisteredSurfaces(): readonly Surface[] {
  return [...registry.values()].map((entry) => entry.registration.surface);
}

/**
 * A FRESH context envelope from the registered host, or `null` when no host is registered for
 * `appId` (the AC1 fallback). The envelope is built on demand — never a cached snapshot.
 */
export function describeContext(appId: string): ContextEnvelope | null {
  const host = getNavigationHost(appId);
  return host === null ? null : host.describeContext();
}
