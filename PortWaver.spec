# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['U:\\PortWaver\\main.py'],
    pathex=[],
    binaries=[],
    datas=[('U:\\PortWaver\\GUI', 'GUI'), ('U:\\PortWaver\\data\\PortWaver\\device_ids.config', 'data\\PortWaver'), ('U:\\PortWaver\\data\\PortWaver\\language.json', 'data\\PortWaver'), ('U:\\PortWaver\\data\\PortWaver\\preferences.settings', 'data\\PortWaver'), ('U:\\PortWaver\\data\\PortWaver\\serial.settings', 'data\\PortWaver'), ('U:\\PortWaver\\data\\PortWaver\\theme.json', 'data\\PortWaver'), ('U:\\PortWaver\\data\\PortWaver\\window_state.settings', 'data\\PortWaver'), ('U:\\PortWaver\\icon.png', '.'), ('U:\\PortWaver\\icon.ico', '.')],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='PortWaver',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['U:\\PortWaver\\icon.ico'],
)
