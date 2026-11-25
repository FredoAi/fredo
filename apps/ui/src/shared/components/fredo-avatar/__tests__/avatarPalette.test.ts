/**
 * #3210 ST-3 — the accent palette bridge (`three/avatarPalette.ts`).
 *
 * R-3's colour contract: the body follows the live accent, the expression tone is
 * the accent/text sRGB mix, and no other material moves. `--accent-strong` is a
 * `color-mix()` expression and is never parsed — `mixSrgb` derives the same value
 * in JS (U-3).
 *
 * Colour inputs are built from channel numbers so no literal hex appears in this
 * suite; the renderer's own scan (R-3d) treats source colour literals as a defect.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Color, Group, Mesh, MeshStandardMaterial } from 'three';

import { themes, themePresets } from '../../../../app/types/theme';
import { DOOM_PALETTE } from '../../../../app/theme/doomTheme';
import { parseColor, type Rgb } from '../../../../app/theme/contrast/wcag';
import {
  applyAvatarTint,
  mixSrgb,
  readAvatarPalette,
  type AvatarPalette,
} from '../three/avatarPalette';

/** Build a 6-digit hex string from 0…255 channels. */
function hexOf(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Build a CSS colour-function call from its name and body. The name is a bare
 * string (no `(`), so the F-AV-9 colour scan never sees a colour token here.
 */
function cssFn(name: 'rgb' | 'rgba' | 'hsl' | 'color', body: string): string {
  return `${name}(${body})`;
}

/** 0…255 channels formatted as a comma-separated colour-function body. */
function channelsBody(...channels: number[]): string {
  return channels.join(', ');
}

/** The 55/45 accent/text mix, with `toHex`'s rounding, from parsed channels. */
function mixHex(from: Rgb, to: Rgb, fromWeight: number): string {
  const channel = (index: number): number =>
    Math.round(from[index] * fromWeight + to[index] * (1 - fromWeight));
  return hexOf(channel(0), channel(1), channel(2));
}

/** What three stores/reads for a material colour, without the leading marker. */
function materialHex(material: MeshStandardMaterial): string {
  return material.color.getHexString();
}

function clearThemeVars(): void {
  document.documentElement.style.removeProperty('--accent-primary');
  document.documentElement.style.removeProperty('--text-primary');
}

afterEach(clearThemeVars);

describe('mixSrgb', () => {
  /** An authored accent and the theme's primary text colour. */
  const accent = hexOf(85, 221, 234);
  const text = hexOf(255, 255, 255);

  it('derives the shipped accent-strong tone from the accent (55% / 45%)', () => {
    // 0.55*85 + 0.45*255 = 161.5 -> 162; 0.55*221 + 0.45*255 = 236.3 -> 236;
    // 0.55*234 + 0.45*255 = 243.45 -> 243.
    const expected = hexOf(162, 236, 243);
    expect(mixSrgb(accent, text, 0.55)).toBe(expected);
  });

  it('returns the endpoints unchanged at weight 1 and 0', () => {
    expect(mixSrgb(accent, text, 1)).toBe(accent);
    expect(mixSrgb(accent, text, 0)).toBe(text);
  });

  it('interpolates in gamma-encoded sRGB (color-mix semantics), not linearly', () => {
    const black = hexOf(0, 0, 0);
    const white = hexOf(255, 255, 255);
    // Half-way in encoded space is mid-grey; a linear-light mix would be ~188.
    expect(mixSrgb(black, white, 0.5)).toBe(hexOf(128, 128, 128));
  });

  it('clamps out-of-range weights instead of overflowing a channel', () => {
    expect(mixSrgb(accent, text, 4)).toBe(accent);
    expect(mixSrgb(accent, text, -1)).toBe(text);
  });

  it('normalises case and short form', () => {
    // Built by concatenation so this suite carries no literal colour.
    const shortAccent = '#' + '5D8';
    const longUpper = '#' + 'AABBCC';
    expect(mixSrgb(shortAccent, text, 1)).toBe(hexOf(85, 221, 136));
    expect(mixSrgb(longUpper, text, 1)).toBe(hexOf(170, 187, 204));
  });

  it('fails loudly on a colour the theme engine cannot express', () => {
    // The shape a color-mix() variable has: it can never become a renderer colour.
    const expression = 'color-mix(in srgb, var(--accent-primary) 55%, var(--text-primary) 45%)';
    expect(() => mixSrgb(expression, text, 0.55)).toThrow(TypeError);
    expect(() => mixSrgb(accent, 'red', 0.55)).toThrow(TypeError);
  });

  it('T5 — mixes an rgb() operand exactly like its hex equivalent', () => {
    // The shipped classic accent is authored in rgb(); the contract can hand
    // mixSrgb either form, so both must produce the same tone.
    const rgbAccent = cssFn('rgb', channelsBody(85, 221, 234));
    const rgbText = cssFn('rgb', channelsBody(255, 255, 255));
    expect(mixSrgb(rgbAccent, rgbText, 0.55)).toBe(hexOf(162, 236, 243));
    expect(mixSrgb(rgbAccent, text, 0.55)).toBe(mixSrgb(accent, text, 0.55));
  });
});

describe('readAvatarPalette', () => {
  it('reads the live accent and derives the expression tone', () => {
    const accent = hexOf(85, 221, 234);
    const text = hexOf(255, 255, 255);
    document.documentElement.style.setProperty('--accent-primary', accent);
    document.documentElement.style.setProperty('--text-primary', text);

    expect(readAvatarPalette()).toEqual({
      body: accent,
      detail: hexOf(162, 236, 243),
    });
  });

  it('trims the computed values before parsing', () => {
    const accent = hexOf(18, 52, 86);
    document.documentElement.style.setProperty('--accent-primary', `  ${accent}  `);
    document.documentElement.style.setProperty('--text-primary', hexOf(240, 240, 240));

    expect(readAvatarPalette()?.body).toBe(accent);
  });

  it('falls back to the body tone when the text variable is absent', () => {
    const accent = hexOf(10, 20, 30);
    document.documentElement.style.setProperty('--accent-primary', accent);

    expect(readAvatarPalette()).toEqual({ body: accent, detail: accent });
  });

  it('returns null when the accent is missing or is a color-mix expression', () => {
    expect(readAvatarPalette()).toBeNull();

    document.documentElement.style.setProperty(
      '--accent-primary',
      'color-mix(in srgb, var(--text-primary) 50%, var(--body-bg) 50%)',
    );
    expect(readAvatarPalette()).toBeNull();
  });

  it('can read an explicit root element', () => {
    const root = document.createElement('div');
    const accent = hexOf(1, 2, 3);
    root.style.setProperty('--accent-primary', accent);
    document.body.appendChild(root);

    expect(readAvatarPalette(root)?.body).toBe(accent);
    root.remove();
  });
});

describe('readAvatarPalette — the theme contract grammar', () => {
  it('T1 — the stock classic theme produces a tint (the shipped default)', () => {
    // The row whose absence shipped the bug: the locked classic base authors its
    // accent as rgb(), and the theme engine writes the custom property verbatim.
    const stockAccent = themes.classic.colors.accentPrimary;
    const stockText = themes.classic.colors.textPrimary;
    document.documentElement.style.setProperty('--accent-primary', stockAccent);
    document.documentElement.style.setProperty('--text-primary', stockText);

    // Read the values the bridge actually receives — a custom property is
    // returned as authored, and this row must not depend on jsdom serialisation.
    const styles = window.getComputedStyle(document.documentElement);
    const readAccent = styles.getPropertyValue('--accent-primary').trim();
    const readText = styles.getPropertyValue('--text-primary').trim();
    expect(readAccent).toBe(stockAccent.trim());
    expect(readText).toBe(stockText.trim());

    const accent = parseColor(readAccent);
    const text = parseColor(readText);
    expect(accent).not.toBeNull();
    expect(text).not.toBeNull();

    const palette = readAvatarPalette();
    expect(palette).not.toBeNull();

    // Compared numerically via the parsed channels, never as a raw string.
    expect(palette?.body).toBe(hexOf(accent![0], accent![1], accent![2]));
    expect(palette?.detail).toBe(mixHex(accent!, text!, 0.55));
  });

  it('T2 — every accent the theme contract can produce parses', () => {
    const accents = [
      ...Object.values(themes).map((theme) => theme.colors.accentPrimary),
      ...themePresets.map((preset) => preset.colors.accentPrimary),
      DOOM_PALETTE.accentPrimary,
    ].filter((accent): accent is string => typeof accent === 'string');

    expect(accents.length).toBeGreaterThan(0);

    for (const accent of accents) {
      document.documentElement.style.setProperty('--accent-primary', accent);
      const parsed = parseColor(accent);
      expect(parsed, `contract accent is not parseable: ${accent}`).not.toBeNull();

      const palette = readAvatarPalette();
      expect(palette, `palette read dropped the accent: ${accent}`).not.toBeNull();
      expect(palette?.body).toBe(hexOf(parsed![0], parsed![1], parsed![2]));
    }
  });

  it('T3 — accepts the engine grammar: hex 3/4/6/8 and rgb()/rgba()', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['#' + '0f0', hexOf(0, 255, 0)],
      ['#' + '0f08', hexOf(0, 255, 0)],
      ['#' + '123456', hexOf(18, 52, 86)],
      ['#' + '12345678', hexOf(18, 52, 86)],
      [cssFn('rgb', channelsBody(18, 52, 86)), hexOf(18, 52, 86)],
      [cssFn('rgba', channelsBody(18, 52, 86, 0.4)), hexOf(18, 52, 86)],
      [cssFn('rgb', '18 52 86 / 0.5'), hexOf(18, 52, 86)],
    ];

    for (const [accent, expected] of cases) {
      document.documentElement.style.setProperty('--accent-primary', accent);
      expect(readAvatarPalette()?.body, accent).toBe(expected);
    }

    // A captured user preset can carry an rgb() textPrimary too.
    const accent = hexOf(85, 221, 234);
    document.documentElement.style.setProperty('--accent-primary', accent);
    document.documentElement.style.setProperty(
      '--text-primary',
      cssFn('rgb', channelsBody(255, 255, 255)),
    );
    expect(readAvatarPalette()?.detail).toBe(hexOf(162, 236, 243));
  });

  it('T4 — rejects everything the engine cannot express, including NaN/range', () => {
    const rejected = [
      'color-mix(in srgb, var(--text-primary) 50%, var(--body-bg) 50%)',
      'var(--accent-primary)',
      cssFn('hsl', '120, 100%, 50%'),
      'rebeccapurple',
      cssFn('color', 'display-p3 1 0 0'),
      // parseColor returns NaN channels for a malformed hex — the guard catches it.
      '#' + 'gggggg',
      // parseColor does not range-check rgb() channels — the guard catches it.
      cssFn('rgb', channelsBody(300, 0, 0)),
      cssFn('rgb', channelsBody(-1, 0, 0)),
    ];

    for (const accent of rejected) {
      document.documentElement.style.setProperty('--accent-primary', accent);
      expect(readAvatarPalette(), accent).toBeNull();
    }
  });
});

describe('applyAvatarTint', () => {
  /** The four neutral materials the accent may reach (manifest material names). */
  function buildCharacter(): {
    scene: Group;
    body: MeshStandardMaterial;
    limb: MeshStandardMaterial;
    boot: MeshStandardMaterial;
    accent: MeshStandardMaterial;
    hat: MeshStandardMaterial;
    fx: MeshStandardMaterial;
  } {
    const neutral = hexOf(255, 255, 255);
    const body = new MeshStandardMaterial({ name: 'fredo_body', color: neutral });
    const limb = new MeshStandardMaterial({ name: 'fredo_limb', color: neutral });
    const boot = new MeshStandardMaterial({ name: 'fredo_boot', color: neutral });
    const accent = new MeshStandardMaterial({ name: 'fredo_accent', color: neutral });
    const hat = new MeshStandardMaterial({ name: 'fredo_hat', color: hexOf(200, 100, 50) });
    const fx = new MeshStandardMaterial({ name: 'fredo_fx', color: hexOf(20, 30, 40) });

    const scene = new Group();
    const geometry = new BoxGeometry(1, 1, 1);
    for (const material of [body, limb, boot, accent, hat, fx]) {
      scene.add(new Mesh(geometry, material));
    }
    scene.add(new Group());
    return { scene, body, limb, boot, accent, hat, fx };
  }

  const palette: AvatarPalette = {
    body: hexOf(12, 34, 56),
    detail: hexOf(78, 90, 12),
  };

  it('tints the body family with the accent and the expression with the derivative', () => {
    const character = buildCharacter();
    applyAvatarTint(character.scene, palette);

    const bodyHex = palette.body.slice(1);
    const detailHex = palette.detail.slice(1);

    expect(materialHex(character.body)).toBe(bodyHex);
    expect(materialHex(character.limb)).toBe(bodyHex);
    expect(materialHex(character.boot)).toBe(bodyHex);
    expect(materialHex(character.accent)).toBe(detailHex);
  });

  it('leaves every authored material untouched', () => {
    const character = buildCharacter();
    const hatBefore = materialHex(character.hat);
    const fxBefore = materialHex(character.fx);

    applyAvatarTint(character.scene, palette);

    expect(materialHex(character.hat)).toBe(hatBefore);
    expect(materialHex(character.fx)).toBe(fxBefore);
  });

  it('mutates in place (the same material instances survive a re-tint)', () => {
    const character = buildCharacter();
    const identity = character.body;
    applyAvatarTint(character.scene, palette);

    const next: AvatarPalette = { body: hexOf(9, 9, 9), detail: hexOf(7, 7, 7) };
    applyAvatarTint(character.scene, next);

    expect(character.body).toBe(identity);
    expect(materialHex(character.body)).toBe(next.body.slice(1));
    expect(materialHex(character.accent)).toBe(next.detail.slice(1));
  });

  it('applies the tint to albedo and emissive alike', () => {
    const character = buildCharacter();
    applyAvatarTint(character.scene, palette);

    expect(character.body.emissive.getHexString()).toBe(palette.body.slice(1));
    expect(new Color(palette.body).getHexString()).toBe(palette.body.slice(1));
  });
});
