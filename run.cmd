@echo off
setlocal

set "ROOT_DIR=%~dp0"
set "PYTHON=%ROOT_DIR%.venv\Scripts\python.exe"
set "PYTHONW=%ROOT_DIR%.venv\Scripts\pythonw.exe"
if not exist "%PYTHON%" (
    echo [ERROR] No existe el entorno virtual en "%ROOT_DIR%.venv".
    echo Ejecuta primero setup.cmd para crearlo e instalar las dependencias.
    pause
    exit /b 1
)

"%PYTHON%" -c "import webview" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] pywebview no esta instalado en el entorno virtual.
    echo Ejecuta setup.cmd para instalar las dependencias.
    pause
    exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT_DIR%tools\create_icon.ps1" -Source "%ROOT_DIR%icon.png" -Destination "%ROOT_DIR%icon.ico" >nul
if errorlevel 1 (
    echo [ERROR] No se pudo convertir icon.png a icon.ico.
    pause
    exit /b 1
)

start "PortWaver" "%PYTHONW%" "%ROOT_DIR%main.py" %*
exit /b 0
