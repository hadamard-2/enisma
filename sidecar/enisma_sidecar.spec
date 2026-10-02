# PyInstaller spec for the Enisma sidecar — single-file binary.
#
# Build:  uv run pyinstaller --clean --noconfirm enisma_sidecar.spec
# Output: dist/enisma-sidecar  (use scripts/build-sidecar.sh to install it
#         into src-tauri/binaries/ with the required -<target-triple> suffix).
#
# Most of what follows is here because PyInstaller's static analysis cannot see
# it: uvicorn resolves its event-loop/protocol implementations by dynamic
# import, and the three TTS native stacks reach their shared libraries and data
# tables through filesystem paths rather than through `import`. See the README
# section "What the frozen binary carries" for why each entry earns its place.

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs

# --- data ------------------------------------------------------------------

# espeak-ng's dictionaries and voice definitions. espeakng_loader.get_data_path()
# returns `Path(__file__).parent / 'espeak-ng-data'` and raises if it is absent,
# so this whole tree has to sit beside the frozen espeakng_loader package.
espeak_data = collect_data_files('espeakng_loader')

# uroman loads ~3.9 MB of romanization tables from its own package directory at
# construction time, and it does not raise when they are missing -- it logs one
# line to stderr and romanizes nothing. Without these, a frozen build would
# start cleanly and then fail every Ge'ez page with a message about the user's
# text. hiddenimports carries .py modules only, hence this.
uroman_data = collect_data_files('uroman')

# --- native libraries -------------------------------------------------------

# onnxruntime's own runtime. This resolves only to
# libonnxruntime_providers_shared.so, and that is correct.
#
# The wheel DOES also contain onnxruntime/capi/libonnxruntime.so.1.30.0 (a real
# 28 MB stripped ELF shared object -- an `ls` will find it). Nothing in the
# wheel links to or loads it: `readelf -d` on
# onnxruntime_pybind11_state...so lists no libonnxruntime among its NEEDED
# entries, because this wheel links ONNX Runtime STATICALLY into that module,
# and libonnxruntime_providers_shared.so does not need it either. It is dead
# weight, so leaving it out costs nothing.
#
# Do not "restore" a collection of it. The reason to skip it is that nothing
# uses it -- not that it is missing from the wheel.
onnxruntime_libs = collect_dynamic_libs('onnxruntime')

# sherpa-onnx's C/C++ APIs and the libonnxruntime.so that sherpa-onnx-core
# supplies. Sherpa's compiled extension reaches this one by soname through
# $ORIGIN and never imports it, so nothing in the import graph reveals it and
# only an explicit collection puts it in the bundle. The destination
# (sherpa_onnx/lib) matters: the extension module lives there too and finds its
# siblings beside it.
sherpa_libs = collect_dynamic_libs('sherpa_onnx')

# libespeak-ng.so, which espeakng_loader.get_library_path() ctypes-loads from
# its own package directory by name.
espeak_libs = collect_dynamic_libs('espeakng_loader')

a = Analysis(
    ['server.py'],
    pathex=[],
    binaries=[*onnxruntime_libs, *sherpa_libs, *espeak_libs],
    # The model manifest is read from disk beside server.py at runtime, so the
    # frozen binary has to carry it or every models.* call raises on load.
    datas=[('models.json', '.'), *espeak_data, *uroman_data],
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
        # sherpa_onnx/lib has no __init__.py, so the compiled extension behind
        # `from sherpa_onnx.lib._sherpa_onnx import ...` sits in a namespace
        # package the analysis does not always walk into.
        'sherpa_onnx.lib._sherpa_onnx',
        'onnxruntime',
        'uroman',
        'num2words2',
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
    name='enisma-sidecar',
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
