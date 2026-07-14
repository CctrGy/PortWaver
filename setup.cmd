@echo off
setlocal

set "ROOT_DIR=%~dp0"
set "VENV_DIR=%ROOT_DIR%.venv"
set "VENV_PYTHON=%VENV_DIR%\Scripts\python.exe"

if not exist "%VENV_PYTHON%" (
    echo Creating the Python virtual environment...
    py -3 -m venv "%VENV_DIR%" 2>nul
    if errorlevel 1 python -m venv "%VENV_DIR%"
)

if not exist "%VENV_PYTHON%" (
    echo [ERROR] Python could not create the virtual environment.
    pause
    exit /b 1
)

echo Installing project dependencies...
"%VENV_PYTHON%" -m pip install --upgrade pip
if errorlevel 1 goto :install_error
"%VENV_PYTHON%" -m pip install -r "%ROOT_DIR%requirements.txt"
if errorlevel 1 goto :install_error

echo Environment ready. Run run.cmd to start PortWaver.
exit /b 0

:install_error
echo [ERROR] The Python dependencies could not be installed.
pause
exit /b 1
