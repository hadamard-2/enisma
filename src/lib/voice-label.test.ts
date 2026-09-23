import { describe, expect, it } from "vitest";
import { describeKokoroVoice, singleSpeakerVoice } from "./voice-label";

describe("describeKokoroVoice", () => {
  it("reads accent, gender and name out of a Kokoro id", () => {
    expect(describeKokoroVoice("af_heart")).toEqual({
      name: "Heart",
      accent: "american",
      gender: "female",
    });
    expect(describeKokoroVoice("bm_george")).toEqual({
      name: "George",
      accent: "british",
      gender: "male",
    });
  });

  it("covers every voice the manifest ships", () => {
    for (const id of ["af_heart", "af_bella", "af_nicole", "am_michael", "am_adam", "bf_emma", "bm_george"]) {
      const label = describeKokoroVoice(id);
      expect(label.accent).not.toBeNull();
      expect(label.gender).not.toBeNull();
    }
  });

  it("keeps a parsed name but drops an accent it has no label for", () => {
    expect(describeKokoroVoice("jf_alpha")).toEqual({
      name: "Alpha",
      accent: null,
      gender: "female",
    });
  });

  it("capitalizes each part of a multi-word name", () => {
    expect(describeKokoroVoice("af_river_song").name).toBe("River Song");
  });

  it("shows an id outside the convention unchanged", () => {
    for (const id of ["heart", "AF_HEART", "ax_heart", ""]) {
      expect(describeKokoroVoice(id)).toEqual({ name: id, accent: null, gender: null });
    }
  });
});

describe("singleSpeakerVoice", () => {
  it("names a male voice for each MMS language", () => {
    for (const lang of ["am", "ti", "om"]) {
      expect(singleSpeakerVoice(lang)).toEqual({ nameKey: `voices.name.${lang}`, gender: "male" });
    }
  });

  it("has nothing for English, which offers a choice", () => {
    expect(singleSpeakerVoice("en")).toBeNull();
  });
});
