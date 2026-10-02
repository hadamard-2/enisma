#!/usr/bin/env bash
# Freeze the Python sidecar with PyInstaller and install it as a Tauri externalBin.
#
# Tauri resolves externalBin entries by appending the host target triple, so the
# frozen binary must land at src-tauri/binaries/enisma-sidecar-<triple>[.exe].
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SIDECAR_DIR="$REPO_ROOT/sidecar"
BIN_DIR="$REPO_ROOT/src-tauri/binaries"

TRIPLE="$(rustc --print host-tuple)"
EXT=""
case "$TRIPLE" in
  *windows*) EXT=".exe" ;;
esac

echo "Building sidecar for $TRIPLE ..."
cd "$SIDECAR_DIR"
uv sync
uv run pyinstaller --clean --noconfirm enisma_sidecar.spec

mkdir -p "$BIN_DIR"
cp "$SIDECAR_DIR/dist/enisma-sidecar$EXT" "$BIN_DIR/enisma-sidecar-$TRIPLE$EXT"

# Tie the binary to the sources it was built from, so `tauri build` can refuse
# a stale one (see scripts/sidecar-stamp.ts).
bun "$REPO_ROOT/scripts/sidecar-stamp.ts" write

echo "Installed: $BIN_DIR/enisma-sidecar-$TRIPLE$EXT"
