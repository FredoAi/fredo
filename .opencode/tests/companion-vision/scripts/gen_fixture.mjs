// Deterministic screen-region fixture generator (Spec #3234, R-ST-4).
//
// Renders a dense UI screenshot to a PNG using a hand-coded 5x7 bitmap font and
// zlib (no image library). Deterministic: same params => byte-identical output.
//
// Usage:
//   node gen_fixture.mjs <out.png> <W> <H> <titleScale> <bodyScale> <target-name>
//
// EXACT invocation that regenerates the committed dense fixture
// `apps/tauri/src-tauri/src/applications/llm_server/engine/score/fixtures/screen-dense-text.png`
// byte-for-byte:
//
//   node .opencode/tests/companion-vision/scripts/gen_fixture.mjs \
//     apps/tauri/src-tauri/src/applications/llm_server/engine/score/fixtures/screen-dense-text.png \
//     1344 960 2 2 "Query Viewer"
//
// Recovered build parameters: W=1344, H=960, titleScale=2, bodyScale=2,
// target="Query Viewer". The two scale args are the values the round-1 dense
// fixture was rendered with; they were recovered by a byte-level comparison
// against the surviving scratch render (`.opencode/tmp/3234/cand-a.png`,
// 1024x704) — at titleScale=2/bodyScale=2 the rail and the dense multi-column
// body are byte-identical to it, and the title block matches within a 1-row
// vertical placement offset (the scratch revision rounded the title y one row
// differently). See the R-ST-4 `## Developer` verification comment for the
// byte-diff receipt.
//
// This generator ships BESIDE the asset so the fixture's pin is reproducible after
// the scratch tree is swept (#3223's loss mode — "a committed fixture whose
// generator is scratch is half a pin"). Its presence AND its recorded build
// parameters are asserted in-tree by
// `the_committed_dense_fixture_carries_its_generator_and_its_build_parameters`.
import { writeFileSync } from "node:fs";
import zlib from "node:zlib";

// 5 wide x 7 tall. Each glyph is 7 rows of 5 chars: '#' = ink, '.' = paper.
const F = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".####", "#....", "#....", "#....", "#....", "#....", ".####"],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".####", "#....", "#....", "#.###", "#...#", "#...#", ".###."],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
  J: ["#####", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#...#", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  0: [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  1: ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  2: [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  3: ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
  4: ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  5: ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  6: [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."],
  7: ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  8: [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  9: [".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
  "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
  ":": [".....", "..#..", ".....", ".....", "..#..", ".....", "....."],
  ".": [".....", ".....", ".....", ".....", ".....", ".....", "..#.."],
  "/": ["....#", "...#.", "...#.", "..#..", ".#...", ".#...", "#...."],
  "_": [".....", ".....", ".....", ".....", ".....", ".....", "#####"],
};

const GW = 5, GH = 7;

class Canvas {
  constructor(w, h, bg) {
    this.w = w; this.h = h;
    this.px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      this.px[i * 3] = bg[0]; this.px[i * 3 + 1] = bg[1]; this.px[i * 3 + 2] = bg[2];
    }
  }
  set(x, y, c) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    this.px[i] = c[0]; this.px[i + 1] = c[1]; this.px[i + 2] = c[2];
  }
  fill(x0, y0, w, h, c) {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.set(x, y, c);
  }
  rect(x0, y0, w, h, c) {
    for (let x = x0; x < x0 + w; x++) { this.set(x, y0, c); this.set(x, y0 + h - 1, c); }
    for (let y = y0; y < y0 + h; y++) { this.set(x0, y, c); this.set(x0 + w - 1, y, c); }
  }
  glyph(ch, x, y, s, c) {
    const g = F[ch.toUpperCase()] || F[" "];
    for (let ry = 0; ry < GH; ry++)
      for (let rx = 0; rx < GW; rx++)
        if (g[ry][rx] === "#")
          this.fill(x + rx * s, y + ry * s, s, s, c);
  }
  text(str, x, y, s, c) {
    let cx = x;
    for (const ch of str) { this.glyph(ch, cx, y, s, c); cx += (GW + 1) * s; }
  }
  // Wrap `str` to lines no wider than `maxChars`, drawing at (x,y) with line gap.
  wrap(str, x, y, s, c, maxChars, lineGap) {
    const words = str.split(" ");
    let line = "";
    let cy = y;
    const flush = () => { if (line) { this.text(line, x, cy, s, c); cy += GH * s + lineGap; line = ""; } };
    for (const w of words) {
      const cand = line ? line + " " + w : w;
      if (cand.length > maxChars) { flush(); line = w; } else line = cand;
    }
    flush();
    return cy;
  }
}

function encodePng(canvas) {
  const stride = canvas.w * 3;
  const raw = Buffer.alloc(canvas.h * (stride + 1));
  for (let y = 0; y < canvas.h; y++) {
    raw[y * (stride + 1)] = 0; // filter none
    canvas.px.subarray(y * stride, (y + 1) * stride).forEach((v, i) => {
      raw[y * (stride + 1) + 1 + i] = v;
    });
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const chunks = [];
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
    chunks.push(len, t, data, crc);
  };
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(canvas.w, 0); ihdr.writeUInt32BE(canvas.h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunk("IHDR", ihdr);
  chunk("IDAT", idat);
  chunk("IEND", Buffer.alloc(0));
  return Buffer.concat([sig, ...chunks]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const [, , out, wArg, hArg, tsArg, bsArg, name] = process.argv;
const W = Number(wArg), H = Number(hArg), TS = Number(tsArg), BS = Number(bsArg);
const TARGET = name;

const BG = [18, 20, 28];
const PANEL = [30, 33, 45];
const PANEL2 = [24, 26, 36];
const TITLEBAR = [44, 48, 66];
const INK = [225, 228, 238];
const DIM = [150, 156, 172];
const ACCENT = [120, 170, 255];
const CHROME = [70, 76, 96];

const c = new Canvas(W, H, BG);

// A left rail of "app icons" plus a dense window list, so the region is genuinely
// busy: the target name appears once, in a small title bar amid distractors.
const rail = Math.round(W * 0.06);
c.fill(0, 0, rail, H, PANEL2);
for (let i = 0; i < 14; i++) {
  const y = 20 + i * Math.round(H * 0.065);
  c.rect(8, y, rail - 16, Math.round(H * 0.045), CHROME);
}

// Main window.
const wx = rail + Math.round(W * 0.02);
const wy = Math.round(H * 0.04);
const ww = W - wx - Math.round(W * 0.02);
const wh = H - wy - Math.round(H * 0.04);
c.fill(wx, wy, ww, wh, PANEL);
c.rect(wx, wy, ww, wh, CHROME);

// Title bar with the target app name (this is the discriminator's read target).
const tb = Math.max(GH * TS + Math.round(H * 0.02), Math.round(H * 0.05));
c.fill(wx + 1, wy + 1, ww - 2, tb, TITLEBAR);
c.text(TARGET, wx + Math.round(W * 0.02), wy + Math.round((tb - GH * TS) / 2), TS, INK);
// window controls
c.fill(wx + ww - 46, wy + Math.round(tb * 0.3), 10, 10, CHROME);
c.fill(wx + ww - 30, wy + Math.round(tb * 0.3), 10, 10, CHROME);
c.fill(wx + ww - 14, wy + Math.round(tb * 0.3), 10, 10, CHROME);

// Body: a dense multi-column list of distractor rows (small text everywhere).
const bodyY = wy + tb + Math.round(H * 0.02);
const colGap = 8;
const colW = (ww - 4 * colGap) / 3;
const distractors = [
  "session 4412 running agent build 12 tokens",
  "session 4413 idle waiting for input",
  "tool read file engine mtp rs line 655",
  "tool grep open app registry mission",
  "span invoke agent status ok latency 42 ms",
  "span chat child cached content attached",
  "session 4414 running plan mode tokens",
  "warning retention days 30 rows max",
  "session 4415 done cost 0.004 usd",
  "settings appearance dark accent purple",
  "settings companion present model loaded",
  "settings telemetry retention bounded",
  "query viewer columns session tokens cost",
  "dev mode overlay inspect element keys",
  "taskbar clock online led green steady",
];
let idx = 0;
for (let col = 0; col < 3; col++) {
  let y = bodyY;
  const maxChars = Math.floor(colW / ((GW + 1) * BS));
  while (y < wy + wh - GH * BS - 6) {
    const line = distractors[idx % distractors.length];
    idx++;
    const ink = idx % 5 === 0 ? DIM : INK;
    y = c.wrap(line, wx + colGap + col * (colW + colGap), y, BS, ink, maxChars, Math.max(2, BS));
    // a thin separator
    c.fill(wx + colGap + col * (colW + colGap), y - Math.max(2, BS) + 1, colW - 4, 1, PANEL2);
    y += Math.max(3, 2 * BS);
  }
}

// Bottom status strip.
const ss = Math.round(H * 0.03);
c.fill(wx + 1, wy + wh - ss, ww - 2, ss - 1, PANEL2);
c.text("read 13 write 0  session 4412  uptime 00:42", wx + Math.round(W * 0.02), wy + wh - ss + Math.max(1, Math.round((ss - GH * BS) / 2)), BS, ACCENT);

writeFileSync(out, encodePng(c));
console.log("wrote", out, `${W}x${H}`, "titleScale", TS, "bodyScale", BS, "target", JSON.stringify(TARGET));
