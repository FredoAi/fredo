/**
 * Platform modifier resolution (Spec #3151 ST-1) — the re-homed home of the ONE
 * platform→primary-modifier rule.
 *
 * This module replaces the retired navigation engine's `detectPlatform` /
 * `resolvePrimaryModifier` (`shared/navigation/keys.ts`) and its `Platform` type
 * (`shared/navigation/types.ts`). The behaviour is preserved VERBATIM: the
 * `navigator.platform` / `navigator.userAgent` probe, the mac/linux/win32
 * decision order, and the unconditional win32 (Ctrl-primary) fallback for a
 * non-browser or unrecognised environment.
 *
 * No DOM, no React, no Tauri, no listener — this is a pure leaf that the zone
 * chord matcher (surviving live feature), the settings chord labels and the
 * re-homed platform-chord listener all read.
 */

/** A platform the primary-modifier decision is made for. */
export type PrimaryPlatform = 'win32' | 'linux' | 'darwin';

/**
 * Detect the active platform. `navigator` is the only ambient browser read; a
 * non-browser/test environment defaults to win32 (Ctrl primary), matching the
 * shipped Windows-first target.
 */
export function detectPrimaryPlatform(): PrimaryPlatform {
  if (typeof navigator === 'undefined') return 'win32';
  const haystack = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
  if (/mac|darwin|iphone|ipad|ipod/i.test(haystack)) return 'darwin';
  if (/linux/i.test(haystack)) return 'linux';
  return 'win32';
}

/** win32/linux → `'ctrl'`; darwin → `'meta'`. Injectable for determinism. */
export function resolvePrimaryModifier(platform?: PrimaryPlatform): 'ctrl' | 'meta' {
  return (platform ?? detectPrimaryPlatform()) === 'darwin' ? 'meta' : 'ctrl';
}

/** The modifier flags a chord reads (the pointer/`KeyboardEvent` modifier shape). */
export interface PrimaryModifierFlags {
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

/**
 * Split the held modifiers into the PLATFORM-NEUTRAL `primary` flag and the
 * `other` one (the ctrl/meta modifier that is NOT primary on this platform).
 *
 * `primary` is Ctrl on win32/linux and Meta on darwin; `other` is the
 * complement, so a chord matcher can require "primary held and the other
 * modifier NOT held" without re-deriving the platform rule. This is the exact
 * rule the zone chord matcher and the re-homed platform-chord listener share.
 */
export function splitPrimaryModifiers(
  mods: PrimaryModifierFlags,
  platform?: PrimaryPlatform,
): { readonly primary: boolean; readonly other: boolean } {
  const primaryMod = resolvePrimaryModifier(platform);
  return {
    primary: primaryMod === 'ctrl' ? mods.ctrl : mods.meta,
    other: primaryMod === 'ctrl' ? mods.meta : mods.ctrl,
  };
}
