# PyInstaller spec for the HearBook sidecar — single-file binary.
#
# Build:  uv run pyinstaller --clean --noconfirm hearbook_sidecar.spec
# Output: dist/hearbook-sidecar  (use scripts/build-sidecar.sh to install it
#         into src-tauri/binaries/ with the required -<target-triple> suffix).
#
# uvicorn resolves its event-loop/protocol implementations by dynamic import,
# so those modules are listed as hidden imports to survive freezing.

from PyInstaller.utils.hooks import collect_data_files

# uroman loads ~3.9 MB of romanization tables from its own package directory at
# construction time, and it does not raise when they are missing -- it logs one
# line to stderr and romanizes nothing. Without these, a frozen build would
# start cleanly and then fail every Ge'ez page with a message about the user's
# text. hiddenimports carries .py modules only, hence this.
uroman_data = collect_data_files('uroman')

a = Analysis(
    ['server.py'],
    pathex=[],
    binaries=[],
    # The model manifest is read from disk beside server.py at runtime, so the
    # frozen binary has to carry it or every models.* call raises on load.
    datas=[('models.json', '.')] + uroman_data,
    hiddenimports=[
        'uvicorn.logging',
        'uvicorn.loops.auto',
        'uvicorn.loops.asyncio',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.lifespan.on',
        # engine_mms imports these inside its constructor (they cost native
        # library loads and seconds of table building), so static analysis
        # cannot see them.
        'sherpa_onnx',
        'uroman',
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
