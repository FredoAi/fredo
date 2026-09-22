#!/usr/bin/env node
/**
 * #2926 ST-2 / #2930 ST-1 — deterministic app-icon generator.
 *
 * The shipped OS icon set is a pure function of ONE committed SVG source,
 * `apps/tauri/src-tauri/icons/fredo-icon-large.svg` (the full bust), for EVERY
 * target: every PNG size, every ICO frame including 16 and 24, every ICNS
 * element and the Square/Store logos. Nothing else is an input — not the
 * retired blue-cyclops art, not `.opencode/wireframes/fredo-avatar.png` (which
 * bakes a glow + black background, both forbidden), not any in-app bitmap.
 *
 * #2930 ST-1 — 16/24 px legibility mitigation (one source, raster only).
 * Every target other than the two pinned sub-32 px sizes keeps the original
 * single-render normalisation byte-for-byte. The pinned 16 px and 24 px targets
 * get a deterministic raster post-process on that SAME render: a 16x
 * supersample, a 16x16 block average, then an accent-ink coverage snap. The snap
 * never selects a different source and never emits a colour outside the baked
 * palette.
 *
 * The generator:
 *   1. rasterises each manifest row from the one source with the root `sharp`
 *      dependency (no new packages),
 *   2. packs `icon.ico` / `icon.icns` with small local PNG-container writers,
 *   3. writes `manifest.sha256` (sorted path + sha256 of every artifact).
 *
 * `tauri icon` is deliberately NOT used: it derives every frame from a single
 * source (no per-size treatment) and its per-platform resolution lives inside a
 * prebuilt binary that cannot be audited in-repo.
 *
 * Determinism / idempotence: the same source + pinned sharp produce
 * byte-identical files, so re-running is a no-op at the byte level
 * (`scripts/check-app-icons.mjs` proves it by regenerating into a temp dir and
 * diffing hashes). The writer only ever writes the paths it owns — unknown files
 * in the icons directory are left alone. The sub-32 px snap is a pure function:
 * integer coverage counts, fixed floors and a fixed tie-break order.
 *
 * Usage:
 *   node scripts/generate-app-icons.mjs            # regenerate apps/tauri/src-tauri/icons/
 *   node scripts/generate-app-icons.mjs --out DIR  # same set into DIR (determinism check)
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repository root (this script lives in `<root>/scripts`). */
export const REPO_ROOT = resolve(HERE, '..');

/** The one directory the shipped set lives in (source + artifacts). */
export const ICONS_DIR = join(REPO_ROOT, 'apps', 'tauri', 'src-tauri', 'icons');

/** The ONE committed SVG source file that drives every target. */
export const MASTER = 'fredo-icon-large.svg';

/** Intrinsic pixel size of the source (its `width`/`height` attributes). */
const MASTER_PX = 1024;

/** The artifact manifest file written into the icons directory. */
export const MANIFEST_PATH = 'manifest.sha256';

/**
 * The pinned sub-32 px targets and their accent-ink coverage floors. 16 px and
 * 24 px are the only sub-32 px targets in the shipped set; every other size
 * (30 px and above) keeps the original single-render path byte-for-byte.
 */
export const SNAP_FLOOR = { 16: 0.2, 24: 0.15 };

/** Supersample factor for the sub-32 px raster path. */
export const SUPERSAMPLE = 16;

/** PNG artifacts — every row derives from the one source. */
export const PNG_ARTIFACTS = [
  { path: '32x32.png', size: 32 },
  { path: '64x64.png', size: 64 },
  { path: '128x128.png', size: 128 },
  { path: '128x128@2x.png', size: 256 },
  { path: 'icon.png', size: 512 },
  { path: 'StoreLogo.png', size: 50 },
  { path: 'Square30x30Logo.png', size: 30 },
  { path: 'Square44x44Logo.png', size: 44 },
  { path: 'Square71x71Logo.png', size: 71 },
  { path: 'Square89x89Logo.png', size: 89 },
  { path: 'Square107x107Logo.png', size: 107 },
  { path: 'Square142x142Logo.png', size: 142 },
  { path: 'Square150x150Logo.png', size: 150 },
  { path: 'Square284x284Logo.png', size: 284 },
  { path: 'Square310x310Logo.png', size: 310 },
];

/** `icon.ico` frames — the Windows frame selection is unchanged (16 … 256). */
export const ICO_PATH = 'icon.ico';
export const ICO_FRAMES = [16, 24, 32, 48, 64, 128, 256];

/** `icon.icns` TOC elements (PNG payloads). */
export const ICNS_PATH = 'icon.icns';
export const ICNS_ELEMENTS = [
  { type: 'icp4', size: 16 },
  { type: 'icp5', size: 32 },
  { type: 'ic07', size: 128 },
  { type: 'ic08', size: 256 },
  { type: 'ic09', size: 512 },
];

/** The baked palette — the ONLY colours the sub-32 px snap may emit. */
const INK_RGB = [0x00, 0xd1, 0xd1];
const TILE_RGB = [0x0c, 0x11, 0x17];
const INTERIOR_RGB = [0x0a, 0x37, 0x3c];

/** Sub-pixel classes (integer, so the coverage counts stay exact). */
const TRANSPARENT = 0;
const TILE = 1;
const INTERIOR = 2;
const INK = 3;

/** A sub-pixel with alpha below this is transparent, never a colour. */
const ALPHA_FLOOR = 128;

/** Every artifact path this generator owns, sorted (manifest order). */
export function artifactPaths() {
  return [
    ...PNG_ARTIFACTS.map((artifact) => artifact.path),
    ICO_PATH,
    ICNS_PATH,
  ].sort();
}

/**
 * Classifies one RGBA sub-pixel as the nearest baked-palette colour. The
 * distance is a plain squared RGB distance; an exact tie prefers ink, then tile,
 * then interior. `alpha >= ALPHA_FLOOR` is guaranteed by the caller.
 */
function nearestPalette(r, g, b) {
  const dInk = (r - INK_RGB[0]) ** 2 + (g - INK_RGB[1]) ** 2 + (b - INK_RGB[2]) ** 2;
  const dTile = (r - TILE_RGB[0]) ** 2 + (g - TILE_RGB[1]) ** 2 + (b - TILE_RGB[2]) ** 2;
  const dInterior = (r - INTERIOR_RGB[0]) ** 2 + (g - INTERIOR_RGB[1]) ** 2 + (b - INTERIOR_RGB[2]) ** 2;
  if (dInk <= dTile && dInk <= dInterior) return INK;
  if (dTile <= dInterior) return TILE;
  return INTERIOR;
}

/**
 * The deterministic sub-32 px raster post-process.
 *
 * For every output pixel the 16x16 supersampled block is averaged: the block's
 * accent-ink coverage is the fraction of its sub-pixels that are accent ink
 * (`alpha >= 128` and nearest the ink colour). Coverage at or above the pinned
 * floor is written as fully opaque ink; below the floor the pixel takes its
 * block-majority source colour — transparent, tile or interior — with the fixed
 * tie-break order transparent > tile > interior. Coverage is an integer count,
 * so the snap is a pure function.
 */
export function snapCoverage({ data, info }, size, floor) {
  const { width, height, channels } = info;
  const side = size * SUPERSAMPLE;
  if (width !== side || height !== side) {
    throw new Error(`generate-app-icons: supersample is ${width}x${height}, expected ${side}x${side}`);
  }
  if (channels !== 4) {
    throw new Error(`generate-app-icons: supersample has ${channels} channels, expected 4 (RGBA)`);
  }

  const block = SUPERSAMPLE * SUPERSAMPLE;
  const minInk = Math.ceil(floor * block);
  const out = Buffer.alloc(size * size * 4);

  for (let oy = 0; oy < size; oy += 1) {
    for (let ox = 0; ox < size; ox += 1) {
      const counts = [0, 0, 0, 0];
      for (let y = oy * SUPERSAMPLE; y < (oy + 1) * SUPERSAMPLE; y += 1) {
        for (let x = ox * SUPERSAMPLE; x < (ox + 1) * SUPERSAMPLE; x += 1) {
          const index = (y * width + x) * channels;
          if (data[index + 3] < ALPHA_FLOOR) {
            counts[TRANSPARENT] += 1;
          } else {
            counts[nearestPalette(data[index], data[index + 1], data[index + 2])] += 1;
          }
        }
      }

      const offset = (oy * size + ox) * 4;
      if (counts[INK] >= minInk) {
        out[offset] = INK_RGB[0];
        out[offset + 1] = INK_RGB[1];
        out[offset + 2] = INK_RGB[2];
        out[offset + 3] = 255;
        continue;
      }

      // Block-majority source colour; fixed tie-break transparent > tile > interior.
      let best = TRANSPARENT;
      if (counts[TILE] > counts[best]) best = TILE;
      if (counts[INTERIOR] > counts[best]) best = INTERIOR;
      if (best === TRANSPARENT) {
        out[offset] = 0;
        out[offset + 1] = 0;
        out[offset + 2] = 0;
        out[offset + 3] = 0;
      } else {
        const rgb = best === TILE ? TILE_RGB : INTERIOR_RGB;
        out[offset] = rgb[0];
        out[offset + 1] = rgb[1];
        out[offset + 2] = rgb[2];
        out[offset + 3] = 255;
      }
    }
  }

  return out;
}

/**
 * Rasterises the one source to `size` x `size`.
 *
 * Sizes other than the two pinned sub-32 px targets keep the original
 * normalisation: the SVG is rendered at an integer multiple of its intrinsic
 * size (at least 2x, never smaller than the target), then resized with
 * `fit: 'fill'` (sharp's default lanczos3 kernel). The source is already square
 * and pre-composed, so no aspect distortion occurs, and the integer-scaled
 * render keeps the result stable across target sizes. That path is
 * BYTE-IDENTICAL to the pre-#2930 output.
 *
 * The pinned 16 px / 24 px targets take the deterministic raster snap instead,
 * still from the same one source (see `snapCoverage`).
 */
export async function rasterise(size, iconsDir = ICONS_DIR) {
  const svg = readFileSync(join(iconsDir, MASTER));
  const floor = SNAP_FLOOR[size];

  if (floor === undefined) {
    const renderScale = Math.max(2, Math.ceil(size / MASTER_PX));
    return sharp(svg, { density: 72 * renderScale })
      .resize(size, size, { fit: 'fill' })
      .png({ compressionLevel: 9, adaptiveFiltering: false })
      .toBuffer();
  }

  const side = size * SUPERSAMPLE;
  const hi = await sharp(svg, { density: (72 * size * SUPERSAMPLE) / MASTER_PX })
    .resize(side, side, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = snapCoverage(hi, size, floor);
  return sharp(out, { raw: { width: size, height: size, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
}

/**
 * Packs PNG frames into a PNG-compressed ICO container (Windows Vista+).
 *
 * ICONDIR: reserved(2) type(2)=1 count(2). Each 16-byte ICONDIRENTRY carries the
 * 1-byte width/height (0 means 256), planes/bitCount, the payload byte length and
 * the payload's absolute offset.
 */
export function packIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);

  const entries = [];
  let offset = 6 + frames.length * 16;
  for (const frame of frames) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(frame.size >= 256 ? 0 : frame.size, 0);
    entry.writeUInt8(frame.size >= 256 ? 0 : frame.size, 1);
    entry.writeUInt8(0, 2); // colour count
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(frame.png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += frame.png.length;
  }

  return Buffer.concat([header, ...entries, ...frames.map((frame) => frame.png)]);
}

/**
 * Packs PNG payloads into an ICNS container.
 *
 * Header: magic 'icns' + total byte length (both big-endian). Each element is a
 * 4-byte ASCII type + 4-byte big-endian element length (header included) + payload.
 */
export function packIcns(elements) {
  const chunks = [];
  for (const element of elements) {
    const header = Buffer.alloc(8);
    header.write(element.type, 0, 4, 'ascii');
    header.writeUInt32BE(8 + element.png.length, 4);
    chunks.push(header, element.png);
  }
  const total = 8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(total, 4);
  return Buffer.concat([header, ...chunks]);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Generates the full artifact set into `targetDir` (defaults to the shipped icons
 * directory) and writes `manifest.sha256`. Returns `{ outDir, entries }` where
 * `entries` is the sorted `{ path, sha256 }` list backing the manifest.
 */
export async function generate({ outDir, iconsDir = ICONS_DIR } = {}) {
  const target = outDir ? resolve(outDir) : iconsDir;
  mkdirSync(target, { recursive: true });

  const entries = [];
  const write = (path, buffer) => {
    writeFileSync(join(target, path), buffer);
    entries.push({ path, sha256: sha256(buffer) });
  };

  for (const artifact of PNG_ARTIFACTS) {
    write(artifact.path, await rasterise(artifact.size, iconsDir));
  }

  const icoFrames = [];
  for (const size of ICO_FRAMES) {
    icoFrames.push({ size, png: await rasterise(size, iconsDir) });
  }
  write(ICO_PATH, packIco(icoFrames));

  const icnsElements = [];
  for (const element of ICNS_ELEMENTS) {
    icnsElements.push({ type: element.type, png: await rasterise(element.size, iconsDir) });
  }
  write(ICNS_PATH, packIcns(icnsElements));

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = entries.map((entry) => `${entry.sha256}  ${entry.path}\n`).join('');
  writeFileSync(join(target, MANIFEST_PATH), manifest, 'utf8');

  return { outDir: target, entries };
}

function parseArgs(argv) {
  let outDir;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') {
      outDir = argv[i + 1];
      if (!outDir) throw new Error('generate-app-icons: --out requires a directory');
      i += 1;
    } else {
      throw new Error(`generate-app-icons: unknown argument "${argv[i]}"`);
    }
  }
  return { outDir };
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const { outDir } = parseArgs(process.argv.slice(2));
  const { outDir: writtenDir, entries } = await generate({ outDir });
  console.log(`generate-app-icons: wrote ${entries.length + 1} files to ${writtenDir}`);
  for (const entry of entries) console.log(`  ${entry.sha256}  ${entry.path}`);
  console.log(`  (manifest) ${MANIFEST_PATH}`);
}
