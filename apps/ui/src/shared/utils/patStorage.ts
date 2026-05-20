/**
 * Azure DevOps PAT storage utilities
 * All persistence goes through settingsService → SQLite (Tauri) with localStorage fallback.
 *
 * Write functions are async (return Promise<void>).
 * Read functions remain synchronous by reading the localStorage mirror,
 * which settingsService always keeps in sync.
 */

import type { AzdoUserProfile } from './azdoApi';
import { settingsService } from '../../features/settings';

const STORAGE_PREFIX = 'Fredo_azdo_';
const PAT_KEY = `${STORAGE_PREFIX}pat`;
const ORG_KEY = `${STORAGE_PREFIX}org`;
const PROJECT_KEY = `${STORAGE_PREFIX}project`;
const PROFILE_KEY = `${STORAGE_PREFIX}profile`;

function encodePAT(pat: string): string { return btoa(pat); }
function decodePAT(encoded: string): string {
  try { return atob(encoded); } catch { throw new Error('Invalid PAT encoding'); }
}

// ── Writes (async — go through settingsService → SQLite + localStorage) ───────

export async function storePAT(pat: string): Promise<void> {
  await settingsService.set(PAT_KEY, encodePAT(pat));
}

export async function storeOrg(org: string): Promise<void> {
  await settingsService.set(ORG_KEY, org);
}

export async function storeProject(project: string): Promise<void> {
  await settingsService.set(PROJECT_KEY, project);
}

export async function storeUserProfile(profile: AzdoUserProfile): Promise<void> {
  await settingsService.set(PROFILE_KEY, JSON.stringify(profile));
}

export async function clearAzdoData(): Promise<void> {
  await Promise.all([
    settingsService.remove(PAT_KEY),
    settingsService.remove(ORG_KEY),
    settingsService.remove(PROJECT_KEY),
    settingsService.remove(PROFILE_KEY),
  ]);
}

// ── Reads (sync from localStorage mirror — always up-to-date after a write) ───

export function getPAT(): string | null {
  const encoded = localStorage.getItem(PAT_KEY);
  if (!encoded) return null;
  try { return decodePAT(encoded); } catch { return null; }
}

export function getOrg(): string | null {
  return localStorage.getItem(ORG_KEY);
}

export function getProject(): string | null {
  return localStorage.getItem(PROJECT_KEY);
}

export function getUserProfile(): AzdoUserProfile | null {
  const stored = localStorage.getItem(PROFILE_KEY);
  if (!stored) return null;
  try { return JSON.parse(stored) as AzdoUserProfile; } catch { return null; }
}

// ── Convenience checks ────────────────────────────────────────────────────────

export function hasPAT(): boolean { return getPAT() !== null; }
export function hasOrg(): boolean { return getOrg() !== null; }
export function hasProject(): boolean { return getProject() !== null; }
export function hasProfile(): boolean { return getUserProfile() !== null; }
export function isAzdoConfigured(): boolean {
  return hasPAT() && hasOrg() && hasProject() && hasProfile();
}
