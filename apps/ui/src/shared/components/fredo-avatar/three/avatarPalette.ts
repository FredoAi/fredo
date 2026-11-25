/**
 * #3210 ST-3 — the accent palette bridge (AC3 / R-3).
 *
 * The rendered body must follow the user's accent with NO remount, and every
 * avatar colour must originate in the theme contract. Two hard rules shape this
 * module (`### Resolved Unknowns` U-3):
 *
 *  1. ONLY literal-valued CSS variables are parsed. `--accent-primary` is written
 *     as a literal colour string by `ThemeProvider` in every branch (base, preset,
 *     override, Doom), so it parses. `--accent-strong` is a live `color-mix()`
 *     expression and CANNOT become a renderer colour — parsing it paints black.
 *  2. The expression tone is therefore DERIVED in JS: `mixSrgb(accent, text, 0.55)`
 *     reproduces `color-mix(in srgb, … 55% / 45%)`, which interpolates the
 *     gamma-encoded sRGB channels — exactly what `mixSrgb` does.
 *
 * There is no colour table in this module: the wardrobe / brass / FX materials
 * ship authored colours in the GLB and are never touched. The four neutral
 * body-family materials are the only tint targets (`applyAvatarTint`).
 */

import { Color, type Material, type Mesh, type Object3D } from 'three';

/** The two CSS variables the avatar is allowed to read (both literal-valued). */
const ACCENT_VARIABLE = '--accent-primary';
const TEXT_PRIMARY_VARIABLE = '--text-primary';

/** The shipped `--accent-strong` weights: accent 55% / text 45%. */
const DETAIL_ACCENT_WEIGHT = 0.55;

/**
 * The GLB's four neutral (white) body-family materials — the ONLY tint targets.
 * Names come from the authoring manifest's material list; the body silhouette
 * tracks the accent and the expression tone derives from it.
 */
const BODY_MATERIAL_NAMES: readonly string[] = ['fredo_body', 'fredo_limb', 'fredo_boot'];
const DETAIL_MATERIAL_NAMES: readonly string[] = ['fredo_accent'];

/** A resolved palette: body hex + derived expression hex, both renderer-ready. */
export interface AvatarPalette {
  /** The body family's colour — the live accent, normalised. */
  readonly body: string;
  /** The expression tone — the accent/text sRGB mix, normalised. */
  readonly detail: string;
}

interface RgbChannels {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const HEX_DIGITS = /^[0-9a-f]+$/i;

/** Parse a literal hex colour (3- or 6-digit) into 0…255 sRGB channels. */
function parseHex(value: string): RgbChannels | null {
  const text = value.trim().toLowerCase();
  if (!text.startsWith('#')) return null;

  const digits = text.slice(1);
  if (!HEX_DIGITS.test(digits)) return null;

  if (digits.length === 3) {
    const r = Number.parseInt(digits[0] + digits[0], 16);
    const g = Number.parseInt(digits[1] + digits[1], 16);
    const b = Number.parseInt(digits[2] + digits[2], 16);
    return { r, g, b };
  }

  if (digits.length === 6) {
    return {
      r: Number.parseInt(digits.slice(0, 2), 16),
      g: Number.parseInt(digits.slice(2, 4), 16),
      b: Number.parseInt(digits.slice(4, 6), 16),
    };
  }

  return null;
}

/** Format 0…255 sRGB channels as a lowercase 6-digit hex string. */
function toHex(channels: RgbChannels): string {
  const part = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  return `#${part(channels.r)}${part(channels.g)}${part(channels.b)}`;
}

/** Interpolate two parsed colours in gamma-encoded sRGB space (the `color-mix` rule). */
function mixChannels(
  from: RgbChannels,
  to: RgbChannels,
  fromWeight: number,
): RgbChannels {
  const weight = Math.min(1, Math.max(0, fromWeight));
  const toWeight = 1 - weight;
  return {
    r: from.r * weight + to.r * toWeight,
    g: from.g * weight + to.g * toWeight,
    b: from.b * weight + to.b * toWeight,
  };
}

/**
 * Mix two literal colours exactly as `color-mix(in srgb, a <weight>, b …)` does.
 *
 * A malformed operand is a programming error: callers hand it values that already
 * passed {@link readAvatarPalette}'s validation, so it fails loudly instead of
 * silently painting the wrong colour.
 */
export function mixSrgb(a: string, b: string, aWeight: number): string {
  const from = parseHex(a);
  const to = parseHex(b);
  if (!from || !to) {
    throw new TypeError('mixSrgb expects two literal hex colours');
  }
  const weight = Number.isFinite(aWeight) ? aWeight : 1;
  return toHex(mixChannels(from, to, weight));
}

/**
 * Read the live palette off the theming application's variables.
 *
 * Returns `null` when the accent variable is missing or unparsable, so the caller
 * keeps the previous tint rather than flashing a black body. `root` defaults to
 * the document element (where `ThemeProvider` writes the variables).
 */
export function readAvatarPalette(root?: HTMLElement | null): AvatarPalette | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;

  const element = root ?? document.documentElement;
  if (!element) return null;

  const styles = window.getComputedStyle(element);
  const accent = parseHex(styles.getPropertyValue(ACCENT_VARIABLE));
  if (!accent) return null;

  const text = parseHex(styles.getPropertyValue(TEXT_PRIMARY_VARIABLE));
  const body = toHex(accent);

  return {
    body,
    detail: text ? toHex(mixChannels(accent, text, DETAIL_ACCENT_WEIGHT)) : body,
  };
}

/** Copy a resolved colour onto a material's albedo (and emissive, when it has one). */
function paintMaterial(material: Material, colour: Color): void {
  const tintable = material as Material & { color?: Color; emissive?: Color };
  tintable.color?.copy(colour);
  tintable.emissive?.copy(colour);
}

/**
 * Re-tint the character's body-family materials IN PLACE (AC3: no remount, no
 * re-fetch, no scene rebuild).
 *
 * Mutating `material.color` is all a re-tint needs — the scene graph, the canvas,
 * the mixer and every authored (wardrobe / brass / FX) material are untouched, so
 * a palette change costs one paint pass and cannot flash.
 */
export function applyAvatarTint(root: Object3D, palette: AvatarPalette): void {
  const bodyColour = new Color(palette.body);
  const detailColour = new Color(palette.detail);
  const bodyNames = new Set(BODY_MATERIAL_NAMES);
  const detailNames = new Set(DETAIL_MATERIAL_NAMES);
  const seen = new Set<string>();

  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh || !mesh.material) return;

    const materials: Material[] = Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material];

    for (const material of materials) {
      if (seen.has(material.uuid)) continue;
      seen.add(material.uuid);

      const name = material.name;
      if (bodyNames.has(name)) {
        paintMaterial(material, bodyColour);
      } else if (detailNames.has(name)) {
        paintMaterial(material, detailColour);
      }
    }
  });
}
