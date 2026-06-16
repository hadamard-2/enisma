# PyInstaller spec for the HearBook sidecar — single-file binary.
#
# Build:  uv run pyinstaller --clean --noconfirm hearbook_sidecar.spec
# Output: dist/hearbook-sidecar  (use scripts/build-sidecar.sh to install it
#         into src-tauri/binaries/ with the required -<target-triple> suffix).
#
# uvicorn resolves its event-loop/protocol implementations by dynamic import,
# so those modules are listed as hidden imports to survive freezing.

a = Analysis(
    ['server.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[
        'uvicorn.logging',
        'uvicorn.loops.auto',
        'uvicorn.loops.asyncio',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.lifespan.on',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='hearbook-sidecar',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
