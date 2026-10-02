# Releasing

1. Bump the version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json`.
2. Commit, then push a `v<version>` tag.
3. Wait for the Release workflow (`.github/workflows/release.yml`) to build and smoke-test Linux, Windows and macOS.
4. Review and publish the resulting draft Release. A draft is visible only to people with write access to the repo; publishing makes it public.

A manual run from Actions (workflow dispatch, no tag) builds the same three bundles as downloadable run artifacts without creating a Release — useful for checking a change before tagging.

`bun run tauri build` refuses to bundle a sidecar built from different sources than what's on disk; if it does, run `scripts/build-sidecar.sh` to rebuild it.

Release builds are unsigned: Windows gets an NSIS installer with no code signature, and macOS gets an ad-hoc signed, un-notarized app.
