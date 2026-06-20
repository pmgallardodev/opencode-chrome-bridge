@echo off
setlocal
cd /d "%~dp0"
set "NO_PAUSE="
set "NO_OPEN="

:parse_args
if "%~1"=="" goto args_done
if /i "%~1"=="--no-pause" (
  set "NO_PAUSE=1"
) else if /i "%~1"=="--no-open" (
  set "NO_OPEN=1"
) else (
  echo ERROR: Unknown setup option. Supported options are --no-pause and --no-open.
  if not defined NO_PAUSE pause
  exit /b 1
)
shift
goto parse_args

:args_done
set "SETUP_ARGS="
if defined NO_OPEN set "SETUP_ARGS=--no-open"

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: A supported Node.js release is required and node must be available through PATH.
  echo This setup does not install prerequisites. Contact the person who provided these instructions.
  if not defined NO_PAUSE pause
  exit /b 1
)

node "%~dp0scripts\setup-windows.mjs" %SETUP_ARGS%
set "SETUP_EXIT=%ERRORLEVEL%"
if not defined NO_PAUSE pause
exit /b %SETUP_EXIT%
