#!/usr/bin/env node
/**
 * #2926 ST-5 — AC4 config-validity + set-completeness verifier.
 *
 * Read-only: it never writes into `apps/tauri/src-tauri/icons`. The only writes it
 * makes are into a throwaway OS temp directory, used to prove the generator is
 * reproducible. No network access.
 *
 * It asserts, with a named failure and a non-zero exit code for each break:
 *   1. `tauri.conf.json` parses as JSON and its `bundle.icon` array is the frozen
 *      5-path list (unchanged by the icon swap);
 *   2. every `bundle.icon` path exists on disk;
 *   3. every `manifest.sha256` row exists and its sha256 matches the file bytes;
 *   4. every manifest row carries the DECLARED pixel size, re-parsed from the
 *      artifact bytes (PNG IHDR / ICO ICONDIR / ICNS TOC);
 *   5. the ICO frame set is exactly {16,24,32,48,64,128,256};
 *   6. a fresh `--out` regeneration reproduces the shipped bytes byte-for-byte.
 *
 * Usage: node scripts/check-app-icons.mjs   (root script: `pnpm icons:check`)
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  artifactPaths,
  generate,
  ICNS_ELEMENTS,
  ICNS_PATH,
  ICO_FRAMES,
  ICO_PATH,
  ICONS_DIR,
  MANIFEST_PATH,
  PNG_ARTIFACTS,
  REPO_ROOT,
} from './generate-app-icons.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATOR_SCRIPT = join(HERE, 'generate-app-icons.mjs');
const TAURI_CONF = join(REPO_ROOT, 'apps', 'tauri', 'src-tauri', 'tauri.conf.json');

/** `bundle.icon` is frozen — the icon swap must not add or remove a path. */
const FROZEN_BUNDLE_ICON = [
  'icons/32x32.png',
  'icons/128x128.png',
  'icons/128x128@2x.png',
  'icons/icon.icns',
  'icons/icon.ico',
];

const ICO_FRAME_SIZES = [16, 24, 32, 48, 64, 128, 256];

const failures = [];

function fail(name, detail) {
  failures.push(`${name}: ${detail}`);
}

function check(name, condition, detail) {
  if (!condition) fail(name, detail);
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function readPngSize(buffer) {
  const signatureOk =
    buffer.length >= 24 &&
    buffer.readUInt32BE(0) === 0x89504e47 &&
    buffer.readUInt32BE(4) === 0x0d0a1a0a &&
    buffer.toString('ascii', 12, 16) === 'IHDR';
  if (!signatureOk) throw new Error('not a PNG (missing 89 50 4E 47 / IHDR)');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function parseIco(buffer) {
  if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    throw new Error('not an ICO (missing ICONDIR 00 00 01 00)');
  }
  const count = buffer.readUInt16LE(4);
  const frames = [];
  for (let index = 0; index < count; index += 1) {
    const base = 6 + index * 16;
    if (base + 16 > buffer.length) throw new Error(`ICONDIRENTRY ${index} is truncated`);
    const width = buffer.readUInt8(base) === 0 ? 256 : buffer.readUInt8(base);
    const height = buffer.readUInt8(base + 1) === 0 ? 256 : buffer.readUInt8(base + 1);
    const bytes = buffer.readUInt32LE(base + 8);
    const offset = buffer.readUInt32LE(base + 12);
    if (offset + bytes > buffer.length) throw new Error(`ICONDIRENTRY ${index} payload is out of range`);
    frames.push({ width, height, data: buffer.subarray(offset, offset + bytes) });
  }
  return { count, frames };
}

function parseIcns(buffer) {
  if (buffer.length < 8 || buffer.toString('ascii', 0, 4) !== 'icns') {
    throw new Error("not an ICNS (missing 'icns' magic)");
  }
  const total = buffer.readUInt32BE(4);
  if (total !== buffer.length) throw new Error(`ICNS header length ${total} != file length ${buffer.length}`);
  const elements = [];
  let offset = 8;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw new Error(`ICNS element at ${offset} is truncated`);
    const type = buffer.toString('ascii', offset, offset + 4);
    const length = buffer.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > buffer.length) {
      throw new Error(`ICNS element ${type} has an invalid length ${length}`);
    }
    elements.push({ type, data: buffer.subarray(offset + 8, offset + length) });
    offset += length;
  }
  return { elements };
}

function parseManifest(text) {
  const rows = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
    if (!match) throw new Error(`unparseable manifest line: "${raw}"`);
    rows.push({ sha256: match[1], path: match[2] });
  }
  return rows;
}

function runCheck() {
  // --- 1. tauri.conf.json parses and bundle.icon is the frozen list ---
  let config;
  try {
    config = JSON.parse(readFileSync(TAURI_CONF, 'utf8'));
  } catch (error) {
    fail('config', `tauri.conf.json does not parse: ${error.message}`);
    return;
  }
  const bundleIcon = config?.bundle?.icon;
  check(
    'config',
    JSON.stringify(bundleIcon) === JSON.stringify(FROZEN_BUNDLE_ICON),
    `bundle.icon is ${JSON.stringify(bundleIcon)}, expected ${JSON.stringify(FROZEN_BUNDLE_ICON)}`,
  );

  // --- 2. every bundle.icon path exists ---
  for (const relativePath of FROZEN_BUNDLE_ICON) {
    check('bundle-path', existsSync(join(REPO_ROOT, 'apps', 'tauri', 'src-tauri', relativePath)), `${relativePath} does not exist`);
  }

  // --- 3. manifest set + hashes ---
  const manifestFile = join(ICONS_DIR, MANIFEST_PATH);
  if (!existsSync(manifestFile)) {
    fail('manifest', `${MANIFEST_PATH} does not exist`);
    return;
  }
  const rows = parseManifest(readFileSync(manifestFile, 'utf8'));
  const expectedPaths = artifactPaths();
  const actualPaths = rows.map((row) => row.path).sort();
  check(
    'manifest-set',
    JSON.stringify(actualPaths) === JSON.stringify(expectedPaths),
    `manifest lists ${JSON.stringify(actualPaths)}, expected ${JSON.stringify(expectedPaths)}`,
  );

  const buffers = new Map();
  for (const row of rows) {
    const file = join(ICONS_DIR, row.path);
    if (!existsSync(file)) {
      fail('manifest-row', `${row.path} is missing`);
      continue;
    }
    const buffer = readFileSync(file);
    buffers.set(row.path, buffer);
    check('manifest-hash', sha256(buffer) === row.sha256, `${row.path} sha256 is ${sha256(buffer)}, manifest says ${row.sha256}`);
  }

  // --- 4. declared pixel sizes, re-parsed from the bytes ---
  for (const artifact of PNG_ARTIFACTS) {
    const buffer = buffers.get(artifact.path);
    if (!buffer) continue;
    try {
      const size = readPngSize(buffer);
      check(
        'png-size',
        size.width === artifact.size && size.height === artifact.size,
        `${artifact.path} is ${size.width}x${size.height}, declared ${artifact.size}x${artifact.size}`,
      );
    } catch (error) {
      fail('png-size', `${artifact.path}: ${error.message}`);
    }
  }

  const icoBuffer = buffers.get(ICO_PATH);
  if (icoBuffer) {
    try {
      const ico = parseIco(icoBuffer);
      const sizes = ico.frames.map((frame) => frame.width).sort((a, b) => a - b);
      check(
        'ico-frames',
        JSON.stringify(sizes) === JSON.stringify(ICO_FRAME_SIZES),
        `icon.ico frame set is ${JSON.stringify(sizes)}, expected ${JSON.stringify(ICO_FRAME_SIZES)}`,
      );
      for (const frame of ico.frames) {
        const size = readPngSize(frame.data);
        check(
          'ico-frame-png',
          size.width === frame.width && size.height === frame.height,
          `icon.ico ${frame.width}px frame embeds a ${size.width}x${size.height} PNG`,
        );
      }
    } catch (error) {
      fail('ico-structure', `icon.ico: ${error.message}`);
    }
  }

  const icnsBuffer = buffers.get(ICNS_PATH);
  if (icnsBuffer) {
    try {
      const icns = parseIcns(icnsBuffer);
      const declared = new Map(ICNS_ELEMENTS.map((element) => [element.type, element.size]));
      const actualTypes = icns.elements.map((element) => element.type).sort();
      const expectedTypes = [...declared.keys()].sort();
      check(
        'icns-toc',
        JSON.stringify(actualTypes) === JSON.stringify(expectedTypes),
        `icon.icns element set is ${JSON.stringify(actualTypes)}, expected ${JSON.stringify(expectedTypes)}`,
      );
      for (const element of icns.elements) {
        const expected = declared.get(element.type);
        if (expected === undefined) continue;
        const size = readPngSize(element.data);
        check(
          'icns-element-png',
          size.width === expected && size.height === expected,
          `icon.icns ${element.type} embeds a ${size.width}x${size.height} PNG, declared ${expected}`,
        );
      }
    } catch (error) {
      fail('icns-structure', `icon.icns: ${error.message}`);
    }
  }

  // --- 5. a fresh --out regeneration reproduces the shipped hashes ---
  const temp = mkdtempSync(join(tmpdir(), 'fredo-icons-check-'));
  try {
    execFileSync(process.execPath, [GENERATOR_SCRIPT, '--out', temp], { cwd: REPO_ROOT, stdio: 'pipe' });
    const tempManifest = parseManifest(readFileSync(join(temp, MANIFEST_PATH), 'utf8'));
    const shippedManifest = rows.map((row) => `${row.sha256}  ${row.path}`).join('\n');
    const regeneratedManifest = tempManifest.map((row) => `${row.sha256}  ${row.path}`).join('\n');
    check('determinism', regeneratedManifest === shippedManifest, 'a fresh --out regeneration produced a different manifest');
    for (const row of tempManifest) {
      const shipped = buffers.get(row.path);
      if (!shipped) continue;
      check(
        'determinism-bytes',
        sha256(shipped) === row.sha256,
        `${row.path} is not reproduced byte-for-byte by a fresh regeneration`,
      );
    }
  } catch (error) {
    fail('determinism', `fresh --out regeneration failed: ${error.message}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  // Guard the checker's own contract: it must never need to write into icons/.
  check('generator-import', typeof generate === 'function', 'generator module did not export generate()');
}

runCheck();

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`icons:check FAILED (${failures.length} failure${failures.length === 1 ? '' : 's'})`);
  process.exitCode = 1;
} else {
  console.log(`icons:check OK — config, ${ICONS_DIR.split(/[\\/]/).slice(-1)[0]} inventory, sizes and determinism verified`);
  console.log(`icons:check OK — ${artifactPaths().length} artifacts + ${MANIFEST_PATH}`);
  console.log(`icons:check OK — bundle.icon = ${FROZEN_BUNDLE_ICON.join(', ')}`);
}
