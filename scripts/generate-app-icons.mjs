#!/usr/bin/env node
/**
 * #2926 ST-2 — deterministic app-icon generator.
 *
 * The shipped OS icon set is a pure function of TWO committed SVG masters
 * (`apps/tauri/src-tauri/icons/fredo-icon-large.svg` for target sizes >= 30 px and
 * `fredo-icon-small.svg` for the 16/24 px targets). Nothing else is an input —
 * not the retired blue-cyclops art, not `.opencode/wireframes/fredo-avatar.png`
 * (which bakes a glow + black background, both forbidden), not any in-app bitmap.
 *
 * The generator:
 *   1. rasterises each manifest row from its master with the root `sharp`
 *      dependency (no new packages),
 *   2. packs `icon.ico` / `icon.icns` with small local PNG-container writers,
 *   3. writes `manifest.sha256` (sorted path + sha256 of every artifact).
 *
 * `tauri icon` is deliberately NOT used: it derives every frame from a single
 * source (no per-size treatment) and its per-platform resolution lives inside a
 * prebuilt binary that cannot be audited in-repo.
 *
 * Determinism / idempotence: the same masters + pinned sharp produce byte-identical
 * files, so re-running is a no-op at the byte level (`scripts/check-app-icons.mjs`
 * proves it by regenerating into a temp dir and diffing hashes). The writer only
 * ever writes the paths it owns — unknown files in the icons directory are left
 * alone.
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

/** The one directory the shipped set lives in (source masters + artifacts). */
export const ICONS_DIR = join(REPO_ROOT, 'apps', 'tauri', 'src-tauri', 'icons');

/** The committed master file names. */
export const LARGE_MASTER = 'fredo-icon-large.svg';
export const SMALL_MASTER = 'fredo-icon-small.svg';

/** Intrinsic pixel size of each master (its `width`/`height` attributes). */
const MASTER_PX = { large: 1024, small: 16 };

/** The artifact manifest file written into the icons directory. */
export const MANIFEST_PATH = 'manifest.sha256';

/**
 * PNG artifacts. `master` selects the per-size treatment: <= 24 px takes the
 * grid-aligned head-only small master, >= 30 px the full-bust large master.
 */
export const PNG_ARTIFACTS = [
  { path: '32x32.png', size: 32, master: 'large' },
  { path: '64x64.png', size: 64, master: 'large' },
  { path: '128x128.png', size: 128, master: 'large' },
  { path: '128x128@2x.png', size: 256, master: 'large' },
  { path: 'icon.png', size: 512, master: 'large' },
  { path: 'StoreLogo.png', size: 50, master: 'large' },
  { path: 'Square30x30Logo.png', size: 30, master: 'large' },
  { path: 'Square44x44Logo.png', size: 44, master: 'large' },
  { path: 'Square71x71Logo.png', size: 71, master: 'large' },
  { path: 'Square89x89Logo.png', size: 89, master: 'large' },
  { path: 'Square107x107Logo.png', size: 107, master: 'large' },
  { path: 'Square142x142Logo.png', size: 142, master: 'large' },
  { path: 'Square150x150Logo.png', size: 150, master: 'large' },
  { path: 'Square284x284Logo.png', size: 284, master: 'large' },
  { path: 'Square310x310Logo.png', size: 310, master: 'large' },
];

/** `icon.ico` frames — 16/24 head-only, 32+ full bust (Windows frame selection unchanged). */
export const ICO_PATH = 'icon.ico';
export const ICO_FRAMES = [
  { size: 16, master: 'small' },
  { size: 24, master: 'small' },
  { size: 32, master: 'large' },
  { size: 48, master: 'large' },
  { size: 64, master: 'large' },
  { size: 128, master: 'large' },
  { size: 256, master: 'large' },
];

/** `icon.icns` TOC elements (PNG payloads). */
export const ICNS_PATH = 'icon.icns';
export const ICNS_ELEMENTS = [
  { type: 'icp4', size: 16, master: 'small' },
  { type: 'icp5', size: 32, master: 'large' },
  { type: 'ic07', size: 128, master: 'large' },
  { type: 'ic08', size: 256, master: 'large' },
  { type: 'ic09', size: 512, master: 'large' },
];

/** Every artifact path this generator owns, sorted (manifest order). */
export function artifactPaths() {
  return [
    ...PNG_ARTIFACTS.map((artifact) => artifact.path),
    ICO_PATH,
    ICNS_PATH,
  ].sort();
}

function masterFile(master, iconsDir) {
  return join(iconsDir, master === 'small' ? SMALL_MASTER : LARGE_MASTER);
}

/**
 * Rasterises one master to `size` x `size`.
 *
 * The SVG is rendered at an integer multiple of its intrinsic size (at least 2x,
 * and never smaller than the target) and then resized with `fit: 'fill'` — the
 * masters are already square and pre-composed, so no aspect distortion occurs, and
 * the integer-scaled render keeps the result stable across target sizes.
 */
export async function rasterise(master, size, iconsDir = ICONS_DIR) {
  const px = MASTER_PX[master];
  if (!px) throw new Error(`generate-app-icons: unknown master "${master}"`);
  const renderScale = Math.max(2, Math.ceil(size / px));
  const svg = readFileSync(masterFile(master, iconsDir));
  return sharp(svg, { density: 72 * renderScale })
    .resize(size, size, { fit: 'fill' })
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
    write(artifact.path, await rasterise(artifact.master, artifact.size, iconsDir));
  }

  const icoFrames = [];
  for (const frame of ICO_FRAMES) {
    icoFrames.push({ size: frame.size, png: await rasterise(frame.master, frame.size, iconsDir) });
  }
  write(ICO_PATH, packIco(icoFrames));

  const icnsElements = [];
  for (const element of ICNS_ELEMENTS) {
    icnsElements.push({ type: element.type, png: await rasterise(element.master, element.size, iconsDir) });
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
