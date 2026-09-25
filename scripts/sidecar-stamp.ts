/**
 * A fingerprint of the sidecar's sources, kept next to the frozen binary.
 *
 * `tauri build` bundles whatever sits in `src-tauri/binaries/`, and that folder
 * is gitignored, so nothing else ties the binary to the code it was built
 * from. `scripts/build-sidecar.sh` writes the stamp right after freezing;
 * `beforeBuildCommand` checks it and refuses to bundle a binary built from
 * different sources. Only the host triple's binary is checked, because that is
 * the only one Tauri bundles.
 *
 * Usage: `bun scripts/sidecar-stamp.ts write|check`.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Build inputs besides the Python modules themselves. */
const NAMED_INPUTS = ["pyproject.toml", "uv.lock", "hearbook_sidecar.spec", "models.json"];

/** Every file whose change should force a rebuild, by name, sorted. Tests are not among them. */
export function sidecarInputs(sidecarDir: string): string[] {
  const modules = readdirSync(sidecarDir).filter((n) => n.endsWith(".py"));
  const named = NAMED_INPUTS.filter((n) => existsSync(join(sidecarDir, n)));
  return [...modules, ...named].sort();
}

/**
 * SHA-256 over each file's name, length and bytes, in name order. The name is
 * included so a rename changes the stamp; the length keeps one file's end from
 * running into the next file's start.
 */
export function stampOf(files: { name: string; bytes: Uint8Array }[]): string {
  const hash = createHash("sha256");
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const f of sorted) {
    hash.update(f.name);
    hash.update("\0");
    hash.update(String(f.bytes.length));
    hash.update("\0");
    hash.update(f.bytes);
  }
  return hash.digest("hex");
}

function currentStamp(repoRoot: string): string {
  const dir = join(repoRoot, "sidecar");
  return stampOf(sidecarInputs(dir).map((name) => ({ name, bytes: readFileSync(join(dir, name)) })));
}

export function binaryPath(repoRoot: string, triple: string): string {
  const ext = triple.includes("windows") ? ".exe" : "";
  return join(repoRoot, "src-tauri", "binaries", `hearbook-sidecar-${triple}${ext}`);
}

export function stampPath(repoRoot: string, triple: string): string {
  return join(repoRoot, "src-tauri", "binaries", `hearbook-sidecar-${triple}.stamp`);
}

export function writeStamp(repoRoot: string, triple: string): void {
  writeFileSync(stampPath(repoRoot, triple), currentStamp(repoRoot) + "\n");
}

const FIX = "Run scripts/build-sidecar.sh to rebuild it.";

export function checkStamp(
  repoRoot: string,
  triple: string,
): { ok: true } | { ok: false; message: string } {
  const bin = binaryPath(repoRoot, triple);
  if (!existsSync(bin)) {
    return { ok: false, message: `No sidecar binary at ${bin}. ${FIX}` };
  }
  const stamp = stampPath(repoRoot, triple);
  if (!existsSync(stamp)) {
    return { ok: false, message: `The sidecar binary at ${bin} has no stamp, so its sources are unknown. ${FIX}` };
  }
  if (readFileSync(stamp, "utf8").trim() !== currentStamp(repoRoot)) {
    return { ok: false, message: `The sidecar binary at ${bin} was built from different sidecar sources. ${FIX}` };
  }
  return { ok: true };
}

function hostTriple(): string {
  return execSync("rustc --print host-tuple", { encoding: "utf8" }).trim();
}

if (import.meta.main) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const command = process.argv[2];
  const triple = hostTriple();
  if (command === "write") {
    writeStamp(repoRoot, triple);
    console.log(`Stamped ${binaryPath(repoRoot, triple)}`);
  } else if (command === "check") {
    const result = checkStamp(repoRoot, triple);
    if (!result.ok) {
      console.error(result.message);
      process.exit(1);
    }
  } else {
    console.error("usage: bun scripts/sidecar-stamp.ts write|check");
    process.exit(2);
  }
}
