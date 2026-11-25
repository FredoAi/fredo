#!/usr/bin/env node
/**
 * Avatar asset sync (spec 3210 ST-1/ST-2) — the ONE writer of the shipped avatar
 * asset location.
 *
 * It does two jobs and nothing else:
 *
 *   1. Copy the committed authoring GLB (`.opencode/wireframes/blender/
 *      fredo-character.glb`) to the location the webview serves it from
 *      (`apps/ui/public/avatar/fredo-character.glb`). The GLB is a REAL FILE on
 *      purpose: `public/` files are copied verbatim by Vite, never imported,
 *      never inlined into the JS bundle, so the 3.4 MB parse never blocks the
 *      initial chunk. Both digests are printed so a stale copy is visible.
 *
 *   2. Derive the two committed poster passes (`poster-body.png` = the accent-
 *      tinted body mask, `poster-detail.png` = the authored detail) from the
 *      committed authoring render of the idle clip's first frame
 *      (`.opencode/wireframes/blender/previews/clip_idle_f01.png`, produced by
 *      `render_clips.py`: ORTHO, ortho_scale 2.368, 420x525).
 *
 * WHY a derivation and not a Blender run: the two passes are normally rendered
 * by `render_poster.py` on the authoring machine (Blender + the Lab MCP add-on),
 * which is not available in every implementation environment. This path needs
 * only `sharp` (already a root dependency), is deterministic, and reads the SAME
 * committed render, so the artifacts stay reproducible without the 3D toolchain.
 * The framing it applies is the PRODUCT framing (the frozen silhouette
 * fractions), not the authoring viewer's: the authoring preview puts the figure
 * at ~0.76 of the frame height with room for the hat, while the reserved avatar
 * box frames the body at 0.9233 of the height with the feet at 0.9763 — the live
 * renderer uses those fractions, so the poster must too or the poster-to-live
 * handoff would jump scale.
 *
 * Materials: the preview tints exactly the four base materials (`fredo_body`,
 * `fredo_limb`, `fredo_boot`, `fredo_accent`) cyan at render time and leaves the
 * authored wardrobe untouched, so the cyan-hued pixels ARE the body pass and
 * every other pixel is authored detail. Only the ALPHA of the body pass is used
 * (the CSS fills it with `var(--accent-primary)`), so the preview's stand-in
 * tint is discarded rather than shipped.
 *
 * Usage:
 *   node scripts/sync-avatar-asset.mjs           # write the shipped copies
 *   node scripts/sync-avatar-asset.mjs --check   # verify, write nothing
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';

const ROOT = resolve(import.meta.dirname, '..');

const SRC_GLB = join(ROOT, '.opencode/wireframes/blender/fredo-character.glb');
const SRC_IDLE_RENDER = join(ROOT, '.opencode/wireframes/blender/previews/clip_idle_f01.png');

const DEST_DIR = join(ROOT, 'apps/ui/public/avatar');
const DEST_GLB = join(DEST_DIR, 'fredo-character.glb');
const DEST_BODY = join(DEST_DIR, 'poster-body.png');
const DEST_DETAIL = join(DEST_DIR, 'poster-detail.png');

/** The poster raster: 420x525 — 0.800, the aspect every shipped avatar box uses. */
const POSTER_WIDTH = 420;
const POSTER_HEIGHT = 525;

/**
 * The frozen silhouette framing (the SVG body union the product reserved its
 * footprint around): body height 0.9233 of the box, feet baseline at 0.9763,
 * horizontally centred. Mirrored in the renderer's `AVATAR_FRAMING`.
 */
const CONTENT_HEIGHT_FRACTION = 0.9233;
const BOTTOM_MARGIN_FRACTION = 0.0237;

/** The authoring render's backdrop — a flat, unlit world colour. */
const BACKDROP = { r: 48, g: 58, b: 71 };

/**
 * Alpha ramp for figure coverage. The renderer's emissive body lights a soft halo
 * into the backdrop (measured distances 4-24 from the backdrop colour), while the
 * solid silhouette sits at 64+. The ramp therefore runs across the empty 26-44
 * band: fully transparent below 26 (halo discarded), fully opaque from 44 (the
 * figure, including its darkest shaded faces).
 */
const BACKDROP_LO = 26;
const BACKDROP_HI = 44;

/** A cyan-hued pixel belongs to the body pass; anything else is authored detail. */
const BODY_HUE_THRESHOLD = 4;

const CHECK_ONLY = process.argv.includes('--check');

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function describe(label, path, buffer) {
  process.stdout.write(`${label}  ${path.replace(`${ROOT}/`, '').replaceAll('\\', '/')}  ${buffer.length} B  sha256=${sha256(buffer)}\n`);
}

function fail(message) {
  process.stderr.write(`FAIL  ${message}\n`);
  process.exit(1);
}

/** Copy the authoring GLB into the served asset location (byte-identical). */
function syncGlb() {
  const source = readFileSync(SRC_GLB);
  describe('glb  source ', SRC_GLB, source);

  if (CHECK_ONLY) {
    if (!existsSync(DEST_GLB)) fail(`missing shipped copy ${DEST_GLB}`);
    const shipped = readFileSync(DEST_GLB);
    describe('glb  shipped', DEST_GLB, shipped);
    if (sha256(shipped) !== sha256(source)) fail('shipped GLB differs from the authoring GLB');
    return;
  }

  mkdirSync(dirname(DEST_GLB), { recursive: true });
  copyFileSync(SRC_GLB, DEST_GLB);
  const shipped = readFileSync(DEST_GLB);
  describe('glb  shipped', DEST_GLB, shipped);
  if (sha256(shipped) !== sha256(source)) fail('copy is not byte-identical to the authoring GLB');
}

/**
 * Derive the two poster passes.
 *
 * Returns { body, detail, framing } where `framing` is the measured silhouette
 * occupancy of the emitted raster (the receipt this script prints).
 */
async function derivePoster() {
  const { data, info } = await sharp(SRC_IDLE_RENDER).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  // Two native-resolution companion planes, resampled together so the two
  // emitted passes stay complementary: PACKED (R = figure coverage, G = body/detail
  // class where 255 is the body pass) and the authored COLOUR (detail pass only).
  // Both are 3-channel because a single-channel raw resize comes back as sRGB.
  const packedPlane = Buffer.alloc(width * height * 3);
  const colourPlane = Buffer.alloc(width * height * 3);
  let figurePixels = 0;
  let bodyPixels = 0;
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      const i = p * channels;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      const distance = Math.hypot(r - BACKDROP.r, g - BACKDROP.g, b - BACKDROP.b);
      const coverage = Math.min(1, Math.max(0, (distance - BACKDROP_LO) / (BACKDROP_HI - BACKDROP_LO)));
      if (coverage <= 0) continue;

      figurePixels += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      const isBody = b - r > BODY_HUE_THRESHOLD;
      if (isBody) bodyPixels += 1;

      packedPlane[p * 3] = Math.round(coverage * 255);
      packedPlane[p * 3 + 1] = isBody ? 255 : 0;
      colourPlane[p * 3] = r;
      colourPlane[p * 3 + 1] = g;
      colourPlane[p * 3 + 2] = b;
    }
  }

  if (figurePixels === 0) fail('the idle render contains no figure pixels');

  // Product framing: scale the figure so its ink height is CONTENT_HEIGHT_FRACTION
  // of the poster and its feet sit at 1 - BOTTOM_MARGIN_FRACTION, then centre it.
  const inkHeight = maxY - minY + 1;
  const inkWidth = maxX - minX + 1;
  const scale = (CONTENT_HEIGHT_FRACTION * POSTER_HEIGHT) / inkHeight;
  const cropWidth = Math.min(width, POSTER_WIDTH / scale);
  const cropHeight = Math.min(height, POSTER_HEIGHT / scale);
  const centreX = (minX + maxX + 1) / 2;
  const bottomEdge = maxY + 1;
  const cropLeft = Math.max(0, Math.min(width - cropWidth, centreX - cropWidth / 2));
  // Anchor the crop on the figure's FEET, not on its bottom edge: the poster keeps
  // the frozen bottom margin below the feet (y = 1 - BOTTOM_MARGIN_FRACTION).
  const feetPx = (1 - BOTTOM_MARGIN_FRACTION) * POSTER_HEIGHT;
  const cropTop = Math.max(0, Math.min(height - cropHeight, bottomEdge - feetPx / scale));

  const extract = {
    left: Math.round(cropLeft),
    top: Math.round(cropTop),
    width: Math.round(cropWidth),
    height: Math.round(cropHeight),
  };
  if (extract.width < 8 || extract.height < 8) fail(`degenerate crop ${JSON.stringify(extract)}`);

  const resample = async (input) => {
    const { data, info } = await sharp(input, { raw: { width, height, channels: 3 } })
      // Pre-resize crop, then a FILL (not cover) resize: the crop is computed to
      // the poster's aspect, so fill is the exact 1:1 mapping the framing maths
      // assumes and cannot letterbox or re-crop the silhouette.
      .extract(extract)
      .resize(POSTER_WIDTH, POSTER_HEIGHT, { kernel: 'lanczos3', fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, info };
  };

  const packed = await resample(packedPlane);
  const colour = await resample(colourPlane);

  const px = POSTER_WIDTH * POSTER_HEIGHT;
  const bodyRgba = Buffer.alloc(px * 4);
  const detailRgba = Buffer.alloc(px * 4);
  for (let p = 0; p < px; p += 1) {
    const cover = packed.data[p * 3] / 255;
    const bodyShare = Math.min(1, Math.max(0, packed.data[p * 3 + 1] / 255));

    const bodyAlpha = Math.round(cover * bodyShare * 255);
    const detailAlpha = Math.round(cover * (1 - bodyShare) * 255);

    // The body pass is a MASK — its colour is discarded by the CSS, so keep it
    // neutral. The detail pass keeps the authored colours exactly as rendered.
    bodyRgba[p * 4] = 255;
    bodyRgba[p * 4 + 1] = 255;
    bodyRgba[p * 4 + 2] = 255;
    bodyRgba[p * 4 + 3] = bodyAlpha;

    detailRgba[p * 4] = colour.data[p * 3];
    detailRgba[p * 4 + 1] = colour.data[p * 3 + 1];
    detailRgba[p * 4 + 2] = colour.data[p * 3 + 2];
    detailRgba[p * 4 + 3] = detailAlpha;
  }

  const encode = (rgba) =>
    sharp(rgba, { raw: { width: POSTER_WIDTH, height: POSTER_HEIGHT, channels: 4 } })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();

  const body = await encode(bodyRgba);
  const detail = await encode(detailRgba);

  const framing = await measureFraming(body, detail);

  return { body, detail, framing, extract, figurePixels, bodyPixels, inkWidth, inkHeight };
}

/**
 * Measure the emitted silhouette from the two passes' alpha channels — the
 * receipt that the product framing actually landed, that neither pass paints
 * outside the figure, and that the two together never over-paint a pixel (their
 * alphas sum to at most full coverage; fractional boundary shares are expected,
 * since both planes are resampled with the same kernel).
 */
async function measureFraming(body, detail) {
  const read = async (buffer) => {
    const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, info };
  };
  const a = await read(body);
  const d = await read(detail);
  const { width, height, channels } = a.info;
  if (d.info.width !== width || d.info.height !== height) fail('poster passes disagree on size');

  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  let bodyCount = 0;
  let detailCount = 0;
  let overlaps = 0;
  let overPainted = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      const bodyAlpha = a.data[i + 3];
      const detailAlpha = d.data[i + 3];
      if (bodyAlpha + detailAlpha > 255 + 1) overPainted += 1;
      const inBody = bodyAlpha > 8;
      const inDetail = detailAlpha > 8;
      if (inBody && inDetail) overlaps += 1;
      if (!inBody && !inDetail) continue;
      if (inBody) bodyCount += 1;
      else detailCount += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (overPainted !== 0) fail(`poster passes over-paint ${overPainted} px (alphas must sum to <= full coverage)`);
  if (maxY < 0) fail('the emitted poster has no ink');

  const framing = {
    width,
    height,
    bodyCount,
    detailCount,
    overlaps,
    inkHeightFraction: (maxY - minY + 1) / height,
    inkWidthFraction: (maxX - minX + 1) / width,
    feetFraction: (maxY + 1) / height,
    centreXFraction: (minX + maxX + 1) / 2 / width,
  };

  // The framing is the contract, so verify it against the emitted raster rather
  // than trusting the crop maths (a rounded extract must not move the silhouette).
  const TOLERANCE = 0.01;
  if (Math.abs(framing.inkHeightFraction - CONTENT_HEIGHT_FRACTION) > TOLERANCE) {
    fail(`ink height ${framing.inkHeightFraction.toFixed(4)} misses the ${CONTENT_HEIGHT_FRACTION} target`);
  }
  if (Math.abs(framing.feetFraction - (1 - BOTTOM_MARGIN_FRACTION)) > TOLERANCE) {
    fail(`feet baseline ${framing.feetFraction.toFixed(4)} misses the ${1 - BOTTOM_MARGIN_FRACTION} target`);
  }
  if (Math.abs(framing.centreXFraction - 0.5) > TOLERANCE) {
    fail(`figure centre ${framing.centreXFraction.toFixed(4)} is not horizontally centred`);
  }

  return framing;
}

async function main() {
  syncGlb();

  const derived = await derivePoster();
  const framing = derived.framing;
  process.stdout.write(
    `poster framing  ${framing.width}x${framing.height}  body=${framing.bodyCount}px  detail=${framing.detailCount}px  ` +
      `shared-boundary=${framing.overlaps}px\n`,
  );
  process.stdout.write(
    `                inkHeight=${framing.inkHeightFraction.toFixed(4)} (target ${CONTENT_HEIGHT_FRACTION})  ` +
      `inkWidth=${framing.inkWidthFraction.toFixed(4)}  feet=${framing.feetFraction.toFixed(4)} ` +
      `(target ${(1 - BOTTOM_MARGIN_FRACTION).toFixed(4)})  centreX=${framing.centreXFraction.toFixed(4)}\n`,
  );

  if (CHECK_ONLY) {
    for (const [label, path, buffer] of [
      ['poster body ', DEST_BODY, derived.body],
      ['poster detail', DEST_DETAIL, derived.detail],
    ]) {
      if (!existsSync(path)) fail(`missing shipped copy ${path}`);
      const shipped = readFileSync(path);
      describe(label, path, shipped);
      if (sha256(shipped) !== sha256(buffer)) fail(`${path} does not match a fresh derivation`);
    }
    return;
  }

  mkdirSync(DEST_DIR, { recursive: true });
  writeFileSync(DEST_BODY, derived.body);
  writeFileSync(DEST_DETAIL, derived.detail);
  describe('poster body ', DEST_BODY, derived.body);
  describe('poster detail', DEST_DETAIL, derived.detail);
}

await main();
