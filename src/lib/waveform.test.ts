import { describe, expect, it } from "vitest";
import { decodeWav, placeholderPeaks, resampleBars, wavePeaks } from "./waveform";

/** A minimal 16-bit PCM WAV, optionally with an extra chunk before `data`. */
function wav16(samples: number[], { channels = 1, extraChunk = false } = {}): ArrayBuffer {
  const extra = extraChunk ? 8 + 4 : 0;
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + extra + dataBytes);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, buf.byteLength - 8, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 16000 * 2 * channels, true);
  v.setUint16(32, 2 * channels, true);
  v.setUint16(34, 16, true);
  let o = 36;
  if (extraChunk) {
    str(o, "LIST");
    v.setUint32(o + 4, 4, true);
    str(o + 8, "INFO");
    o += 12;
  }
  str(o, "data");
  v.setUint32(o + 4, dataBytes, true);
  samples.forEach((s, i) => v.setInt16(o + 8 + i * 2, s, true));
  return buf;
}

describe("wavePeaks", () => {
  it("follows the loudness of the audio across the bars", () => {
    // Quiet, medium, loud. The medium bar lands in proportion between them.
    const samples = [...Array(100).fill(1000), ...Array(100).fill(-4500), ...Array(100).fill(8000)];
    const peaks = wavePeaks(wav16(samples), 3)!;
    expect(peaks[0]).toBe(0);
    expect(peaks[1]).toBeCloseTo(0.5, 5);
    expect(peaks[2]).toBe(1);
  });

  it("stretches a narrow band of levels to fill the bar height", () => {
    // Two levels only 10% apart still draw as the lowest and highest bar.
    const peaks = wavePeaks(wav16([...Array(50).fill(9000), ...Array(50).fill(10000)]), 2)!;
    expect(peaks).toEqual([0, 1]);
  });

  it("draws a steady level as full bars rather than empty ones", () => {
    expect(wavePeaks(wav16(Array(40).fill(5000)), 4)).toEqual([1, 1, 1, 1]);
  });

  it("shows silence between words as low bars", () => {
    const word = Array(50).fill(12000);
    const gap = Array(50).fill(0);
    const peaks = wavePeaks(wav16([...word, ...gap, ...word]), 3)!;
    expect(peaks).toEqual([1, 0, 1]);
  });

  it("reads past chunks it does not know", () => {
    const samples = [...Array(10).fill(500), ...Array(10).fill(2000)];
    expect(wavePeaks(wav16(samples, { extraChunk: true }), 2)).toEqual(
      wavePeaks(wav16(samples), 2),
    );
  });

  it("measures the first channel of a stereo file", () => {
    // Left loud then silent; right the reverse, which must be ignored.
    const frames = [...Array(20).fill([9000, 0]), ...Array(20).fill([0, 9000])].flat();
    expect(wavePeaks(wav16(frames, { channels: 2 }), 2)).toEqual([1, 0]);
  });

  it("returns the requested number of bars even for very short audio", () => {
    expect(wavePeaks(wav16([100, 200, 300]), 48)).toHaveLength(48);
  });

  it("is all zero for pure silence rather than dividing by zero", () => {
    expect(wavePeaks(wav16(Array(40).fill(0)), 4)).toEqual([0, 0, 0, 0]);
  });

  it("gives up on something that is not a WAV", () => {
    expect(wavePeaks(new TextEncoder().encode("not audio at all").buffer)).toBeNull();
    expect(wavePeaks(new ArrayBuffer(0))).toBeNull();
    expect(wavePeaks(wav16([]))).toBeNull();
  });
});

describe("placeholderPeaks", () => {
  it("is the same wave every time for the same page", () => {
    expect(placeholderPeaks(7)).toEqual(placeholderPeaks(7));
  });

  it("differs between pages", () => {
    expect(placeholderPeaks(7)).not.toEqual(placeholderPeaks(8));
  });

  it("stays within the drawable range", () => {
    for (const v of placeholderPeaks(3, 200)) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("resampleBars", () => {
  it("groups levels into the number of bars that fit", () => {
    expect(resampleBars([0, 0, 1, 1], 2)).toEqual([0, 1]);
    expect(resampleBars(Array(400).fill(0.5), 37)).toHaveLength(37);
  });

  it("keeps the shape when grouping", () => {
    const levels = [...Array(100).fill(0.2), ...Array(100).fill(0.9), ...Array(100).fill(0.2)];
    expect(resampleBars(levels, 3)).toEqual([0, 1, 0]);
  });

  it("can draw more bars than there are levels", () => {
    expect(resampleBars([0, 1], 4)).toEqual([0, 0, 1, 1]);
  });

  it("draws nothing into no room", () => {
    expect(resampleBars([0.5, 0.7], 0)).toEqual([]);
    expect(resampleBars([], 5)).toEqual([]);
  });
});

describe("decodeWav", () => {
  it("returns the samples as floats with the file's own rate", () => {
    const d = decodeWav(wav16([0, 16384, -32768]))!;
    expect(d.sampleRate).toBe(16000);
    expect(d.frames).toBe(3);
    expect(Array.from(d.channels[0]!)).toEqual([0, 0.5, -1]);
  });

  it("splits an interleaved stereo file into channels", () => {
    const d = decodeWav(wav16([100, -100, 200, -200], { channels: 2 }))!;
    expect(d.channels).toHaveLength(2);
    expect(d.frames).toBe(2);
    expect(d.channels[0]![1]).toBeCloseTo(200 / 32768);
    expect(d.channels[1]![1]).toBeCloseTo(-200 / 32768);
  });

  it("finds the rate past chunks it does not know", () => {
    expect(decodeWav(wav16([1, 2], { extraChunk: true }))!.sampleRate).toBe(16000);
  });

  it("gives up on something that is not a WAV", () => {
    expect(decodeWav(new ArrayBuffer(4))).toBeNull();
    expect(decodeWav(wav16([]))).toBeNull();
  });
});
