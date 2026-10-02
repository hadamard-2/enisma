import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { binaryPath, checkStamp, sidecarInputs, stampOf, stampPath, writeStamp } from "./sidecar-stamp";

const enc = (s: string) => new TextEncoder().encode(s);

/** A throwaway repo with a sidecar folder and an empty binaries folder. */
function repo(files: Record<string, string> = { "server.py": "print(1)", "uv.lock": "lock" }) {
  const root = mkdtempSync(join(tmpdir(), "stamp-"));
  mkdirSync(join(root, "sidecar", "tests"), { recursive: true });
  mkdirSync(join(root, "src-tauri", "binaries"), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, "sidecar", name), body);
  return root;
}

describe("stampOf", () => {
  it("does not depend on the order files are given in", () => {
    const a = { name: "a.py", bytes: enc("1") };
    const b = { name: "b.py", bytes: enc("2") };
    expect(stampOf([a, b])).toBe(stampOf([b, a]));
  });

  it("changes when a file's content changes", () => {
    expect(stampOf([{ name: "a.py", bytes: enc("1") }])).not.toBe(
      stampOf([{ name: "a.py", bytes: enc("2") }]),
    );
  });

  it("changes when a file is renamed", () => {
    expect(stampOf([{ name: "a.py", bytes: enc("1") }])).not.toBe(
      stampOf([{ name: "b.py", bytes: enc("1") }]),
    );
  });
});

describe("sidecarInputs", () => {
  it("takes top-level Python and the named build inputs, not tests", () => {
    const root = repo({
      "server.py": "",
      "models.py": "",
      "pyproject.toml": "",
      "uv.lock": "",
      "enisma_sidecar.spec": "",
      "models.json": "",
      "README.md": "",
    });
    writeFileSync(join(root, "sidecar", "tests", "test_x.py"), "");
    expect(sidecarInputs(join(root, "sidecar"))).toEqual([
      "enisma_sidecar.spec",
      "models.json",
      "models.py",
      "pyproject.toml",
      "server.py",
      "uv.lock",
    ]);
  });
});

describe("checkStamp", () => {
  const triple = "x86_64-unknown-linux-gnu";

  it("fails when there is no binary", () => {
    const result = checkStamp(repo(), triple);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("scripts/build-sidecar.sh");
  });

  it("fails when the binary has no stamp", () => {
    const root = repo();
    writeFileSync(binaryPath(root, triple), "bin");
    const result = checkStamp(root, triple);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("no stamp");
  });

  it("passes right after a stamp is written", () => {
    const root = repo();
    writeFileSync(binaryPath(root, triple), "bin");
    writeStamp(root, triple);
    expect(checkStamp(root, triple)).toEqual({ ok: true });
  });

  it("fails once a source changes after the build", () => {
    const root = repo();
    writeFileSync(binaryPath(root, triple), "bin");
    writeStamp(root, triple);
    writeFileSync(join(root, "sidecar", "server.py"), "print(2)");
    const result = checkStamp(root, triple);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("different sidecar sources");
  });

  it("names the Windows binary with its extension", () => {
    expect(binaryPath("/r", "x86_64-pc-windows-msvc")).toMatch(/enisma-sidecar-x86_64-pc-windows-msvc\.exe$/);
    expect(stampPath("/r", "x86_64-pc-windows-msvc")).toMatch(/enisma-sidecar-x86_64-pc-windows-msvc\.stamp$/);
  });
});
