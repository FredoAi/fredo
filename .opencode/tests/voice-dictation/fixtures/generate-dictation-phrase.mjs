// Deterministic generator for the ST-9 capture-feed fixture (issue #2887).
//
// Produces `dictation-phrase-16k-mono.wav`: 16 kHz, mono, 16-bit PCM, exactly
// 1.6 s = 25,600 samples = eight 3200-sample capture chunks.
//
// HONESTY / PROVENANCE
// --------------------
// This is NOT recorded speech and is not intelligible. It is a deterministic
// synthetic waveform whose ONLY job is to be a valid 16 kHz mono 16-bit PCM WAV
// with non-zero signal at sample 0, so the env-gated capture feed
// (`FREDO_STT_FEED_WAV`, apps/tauri/src-tauri/src/infrastructure/voice/capture.rs)
// has audio to be live on, paced 1x real time. It exercises the paced-feed /
// liveness path. The transcript-CONTENT claim is carried by the sanctioned
// synthetic `stt:transcript` lever (`.opencode/tests/voice-input/smoke.md`
// S-12/S-14/S-15) and by the shipped unit pins — never by this file.
//
// Regenerate (deterministic: byte-identical output, no randomness, no clock):
//   node .opencode/tests/voice-dictation/fixtures/generate-dictation-phrase.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SAMPLE_RATE = 16000;
const TOTAL_SAMPLES = 25600; // 1.6 s
const WORD_SLOT = 6400; // 0.4 s per word slot
const WORD_BURST = 4800; // 0.3 s of signal, 0.1 s of silence

const data = Buffer.alloc(TOTAL_SAMPLES * 2);
let peak = 0;
for (let i = 0; i < TOTAL_SAMPLES; i += 1) {
  const slot = i % WORD_SLOT;
  let value = 0;
  if (slot < WORD_BURST) {
    // Cosine carriers start at their maximum, so sample 0 is non-zero: the
    // opening word starts AT sample 0 and a dropped opening cannot hide behind
    // leading silence. The exponential decay makes each slot a word-like burst.
    const env = Math.exp(-slot / 1800);
    const t = i / SAMPLE_RATE;
    const wave =
      0.5 * Math.cos(2 * Math.PI * 120 * t) +
      0.3 * Math.cos(2 * Math.PI * 240 * t) +
      0.15 * Math.cos(2 * Math.PI * 480 * t) +
      0.1 * Math.cos(2 * Math.PI * 960 * t);
    value = 0.45 * env * wave;
  }
  const sample = Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
  peak = Math.max(peak, Math.abs(sample));
  data.writeInt16LE(sample, i * 2);
}

const header = Buffer.alloc(44);
header.write('RIFF', 0, 'ascii');
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVE', 8, 'ascii');
header.write('fmt ', 12, 'ascii');
header.writeUInt32LE(16, 16); // fmt chunk size
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(SAMPLE_RATE, 24);
header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
header.writeUInt16LE(2, 32); // block align
header.writeUInt16LE(16, 34); // bits per sample
header.write('data', 36, 'ascii');
header.writeUInt32LE(data.length, 40);

const out = join(dirname(fileURLToPath(import.meta.url)), 'dictation-phrase-16k-mono.wav');
writeFileSync(out, Buffer.concat([header, data]));
console.log(
  `wrote ${out}: 16000 Hz mono 16-bit PCM, ${TOTAL_SAMPLES} samples ` +
    `(${(TOTAL_SAMPLES / SAMPLE_RATE).toFixed(1)} s, ${TOTAL_SAMPLES / 3200} chunks), ` +
    `first=${data.readInt16LE(0)}, peak=${peak}`,
);
