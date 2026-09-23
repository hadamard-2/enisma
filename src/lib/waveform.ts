/**
 * The bar heights the audio player draws: measured from a take when there is
 * one, invented when there is not.
 *
 * Pure and in its own module so it can be tested: vitest only picks up
 * `src/**​/*.test.ts`, so nothing in a `.tsx` file is exercised by any test.
 */

/** How many bars the player draws. */
export const WAVE_BARS = 48;
/**
 * How finely a take is measured before being grouped into bars. The player
 * draws as many bars as its width holds, so the take is measured once at this
 * resolution and regrouped on every resize instead of re-read.
 */
export const WAVE_RESOLUTION = 400;

type Pcm = { samples: Int16Array | Float32Array; channels: number; scale: number };

function ascii(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/**
 * Find the sample data in a RIFF/WAVE file.
 *
 * Walks the chunk list rather than assuming the canonical 44-byte header, so
 * a writer that adds a LIST or fact chunk is still read. Handles the two
 * encodings a take can arrive in — 16-bit integer and 32-bit float PCM — and
 * returns null for anything else, which the caller treats as "no waveform",
 * not as an error: playback does not depend on this.
 */
function readPcm(buf: ArrayBuffer): Pcm | null {
  if (buf.byteLength < 12) return null;
  const view = new DataView(buf);
  if (ascii(view, 0) !== "RIFF" || ascii(view, 8) !== "WAVE") return null;

  let format = 0;
  let channels = 0;
  let bits = 0;
  let offset = 12;
  while (offset + 8 <= buf.byteLength) {
    const id = ascii(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= buf.byteLength) {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === "data") {
      // A writer that never went back to patch the size leaves 0 or
      // 0xFFFFFFFF here; either way the data runs to the end of the file.
      const end = size === 0 || body + size > buf.byteLength ? buf.byteLength : body + size;
      if (channels < 1) return null;
      // Typed arrays need an aligned offset; copying is the fallback.
      if (format === 1 && bits === 16) {
        const n = Math.floor((end - body) / 2);
        const samples =
          body % 2 === 0 ? new Int16Array(buf, body, n) : new Int16Array(buf.slice(body, body + n * 2));
        return { samples, channels, scale: 32768 };
      }
      if (format === 3 && bits === 32) {
        const n = Math.floor((end - body) / 4);
        const samples =
          body % 4 === 0 ? new Float32Array(buf, body, n) : new Float32Array(buf.slice(body, body + n * 4));
        return { samples, channels, scale: 1 };
      }
      return null;
    }
    // Chunks are padded to an even length.
    offset = body + size + (size % 2);
  }
  return null;
}

/** A take's audio as the player needs it: one Float32Array per channel, -1..1. */
export type DecodedWav = { sampleRate: number; channels: Float32Array[]; frames: number };

/**
 * Decode a 16-bit or 32-bit-float PCM WAV for playback through Web Audio.
 *
 * Decoded here rather than handed to the browser because the webview's media
 * stack cannot be trusted with it: WebKitGTK's <audio> — GStreamer underneath —
 * reported the position the user asked for after a seek while actually playing
 * from somewhere else (seek to 0, hear 87s). Holding the samples ourselves
 * makes every seek exact, and needs no codec at all. Null for anything that is
 * not a WAV this can read.
 */
export function decodeWav(buf: ArrayBuffer): DecodedWav | null {
  const pcm = readPcm(buf);
  if (!pcm) return null;
  const frames = Math.floor(pcm.samples.length / pcm.channels);
  if (frames === 0) return null;
  const sampleRate = new DataView(buf).getUint32(pcmSampleRateOffset(buf), true);
  const channels = Array.from({ length: pcm.channels }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < pcm.channels; c++) {
      channels[c]![f] = pcm.samples[f * pcm.channels + c]! / pcm.scale;
    }
  }
  return { sampleRate, channels, frames };
}

/** Byte offset of the sample rate inside the `fmt ` chunk. */
function pcmSampleRateOffset(buf: ArrayBuffer): number {
  const view = new DataView(buf);
  let offset = 12;
  while (offset + 8 <= buf.byteLength) {
    const size = view.getUint32(offset + 4, true);
    if (ascii(view, offset) === "fmt ") return offset + 12;
    offset += 8 + size + (size % 2);
  }
  return 24;
}

/**
 * Loudness per bar, 0-1, measured from a WAV file.
 *
 * Each bar is the RMS of its slice of the first channel. RMS rather than peak
 * because speech is spiky: peaks make every bar look nearly full.
 *
 * The bars are then stretched so the quietest is 0 and the loudest 1, rather
 * than simply divided by the loudest. A page runs to minutes, so each bar
 * averages seconds of speech and the raw levels all sit within a narrow band
 * near the top — measured on a real 135s take, every bar landed between 0.5
 * and 1, which draws as a flat block. Stretching to the take's own range is
 * what a voice-message waveform does, and it keeps the shape honest: a bar is
 * still taller exactly when that stretch of audio is louder. Returns null
 * when the file cannot be read or holds no samples.
 */
export function wavePeaks(buf: ArrayBuffer, bars: number = WAVE_BARS): number[] | null {
  const pcm = readPcm(buf);
  if (!pcm || bars < 1) return null;
  const frames = Math.floor(pcm.samples.length / pcm.channels);
  if (frames === 0) return null;

  const levels: number[] = [];
  for (let b = 0; b < bars; b++) {
    const start = Math.floor((b * frames) / bars);
    const end = Math.max(start + 1, Math.floor(((b + 1) * frames) / bars));
    let sum = 0;
    for (let f = start; f < end && f < frames; f++) {
      const s = pcm.samples[f * pcm.channels]! / pcm.scale;
      sum += s * s;
    }
    levels.push(Math.sqrt(sum / (end - start)));
  }
  const lo = Math.min(...levels);
  const hi = Math.max(...levels);
  // A level with nothing to stretch against — silence, or a steady tone — is
  // drawn as it is: empty for silence, full for sound.
  if (hi - lo < 1e-9) return levels.map(() => (hi > 0 ? 1 : 0));
  return levels.map((l) => (l - lo) / (hi - lo));
}

/**
 * Group fine-grained levels into `bars` bars, each the mean of its share, and
 * stretch the result to span 0-1 again (see `wavePeaks` for why).
 */
export function resampleBars(levels: readonly number[], bars: number): number[] {
  if (bars < 1 || levels.length === 0) return [];
  const out: number[] = [];
  for (let b = 0; b < bars; b++) {
    const start = Math.floor((b * levels.length) / bars);
    const end = Math.max(start + 1, Math.floor(((b + 1) * levels.length) / bars));
    let sum = 0;
    for (let i = start; i < end; i++) sum += levels[Math.min(i, levels.length - 1)]!;
    out.push(sum / (end - start));
  }
  const lo = Math.min(...out);
  const hi = Math.max(...out);
  if (hi - lo < 1e-9) return out.map(() => (hi > 0 ? 1 : 0));
  return out.map((v) => (v - lo) / (hi - lo));
}

/** mulberry32: a tiny seeded PRNG, so a page's invented wave never jitters. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * An invented waveform, for a page with no take yet.
 *
 * Seeded so that the same page always shows the same wave — a random one that
 * changed on every render would read as something happening. Neighbouring
 * values are blended so it has the rise and fall of speech rather than noise.
 */
export function placeholderPeaks(seed: number, bars: number = WAVE_BARS): number[] {
  const rand = seeded(seed);
  const raw = Array.from({ length: bars }, () => 0.15 + 0.85 * rand());
  return raw.map((v, i) => {
    const prev = raw[i - 1] ?? v;
    const next = raw[i + 1] ?? v;
    return (prev + 2 * v + next) / 4;
  });
}
