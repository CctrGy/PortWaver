@echo off
setlocal

set "ROOT_DIR=%~dp0"
set "PYTHON=%ROOT_DIR%.venv\Scripts\python.exe"

if not exist "%PYTHON%" (
    echo [ERROR] The virtual environment does not exist.
    echo Run setup.cmd before compiling.
    pause
    exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT_DIR%tools\create_icon.ps1" -Source "%ROOT_DIR%icon.png" -Destination "%ROOT_DIR%icon.ico"
if errorlevel 1 goto :build_error

"%PYTHON%" -m pip install -r "%ROOT_DIR%requirements-build.txt"
if errorlevel 1 goto :build_error

"%PYTHON%" -m PyInstaller ^
    --noconfirm ^
    --clean ^
    --onefile ^
    --windowed ^
    --name PortWaver ^
    --icon "%ROOT_DIR%icon.ico" ^
    --add-data "%ROOT_DIR%GUI;GUI" ^
    --add-data "%ROOT_DIR%data\PortWaver\device_ids.config;data\PortWaver" ^
    --add-data "%ROOT_DIR%data\PortWaver\language.json;data\PortWaver" ^
    --add-data "%ROOT_DIR%data\PortWaver\preferences.settings;data\PortWaver" ^
    --add-data "%ROOT_DIR%data\PortWaver\serial.settings;data\PortWaver" ^
    --add-data "%ROOT_DIR%data\PortWaver\theme.json;data\PortWaver" ^
    --add-data "%ROOT_DIR%data\PortWaver\window_state.settings;data\PortWaver" ^
    --add-data "%ROOT_DIR%icon.png;." ^
    --add-data "%ROOT_DIR%icon.ico;." ^
    "%ROOT_DIR%main.py"
if errorlevel 1 goto :build_error

echo Build completed: "%ROOT_DIR%dist\PortWaver.exe"
exit /b 0

:build_error
echo [ERROR] PortWaver could not be compiled.
pause
exit /b 1
