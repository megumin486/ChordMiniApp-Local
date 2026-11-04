@echo off
rem One-click launcher for Windows users.
rem
rem Double-click this file: it opens WSL, runs the local launcher there, and
rem opens the app in your browser as soon as the frontend answers.
rem Closing the window (or Ctrl+C) stops both services.
rem
rem It finds everything on its own: the project directory is the folder this
rem file sits in (a Windows drive, or a \\wsl.localhost path), translated to a
rem WSL path, and the distribution is your default WSL one. A repository kept on a
rem Windows drive is treated as source only: if the same project is already set up
rem in the WSL home directory, that copy is the one that runs. Override when needed:
rem   CHORDMINI_WSL_DISTRO  WSL distribution name      (default: your default distro)
rem   CHORDMINI_WSL_DIR     project path inside WSL   (default: this folder, else $HOME/ChordMiniApp)
rem   CHORDMINI_PORT        frontend port             (default: 3000)
rem   NO_BROWSER=1          do not open the browser
rem   NO_SYNC=1             do not copy edited sources into the WSL copy first
setlocal EnableExtensions EnableDelayedExpansion
title ChordMini (WSL)

if not defined CHORDMINI_PORT set "CHORDMINI_PORT=3000"
set "URL=http://127.0.0.1:%CHORDMINI_PORT%"
set "DISTRO=%CHORDMINI_WSL_DISTRO%"
set "HERE=%~dp0"

rem Work out the project path inside WSL and, when the repository lives in the
rem WSL file system (\\wsl.localhost\<distro>\home\...), the distribution too.
set "WSLDIR=%CHORDMINI_WSL_DIR%"
if not defined WSLDIR (
  if /i "!HERE:~0,4!"=="\\ws" (
    set "P=!HERE:\\wsl.localhost\=!"
    set "P=!P:\\wsl$\=!"
    for /f "tokens=1,* delims=\" %%a in ("!P!") do (
      if not defined DISTRO set "DISTRO=%%a"
      set "WSLDIR=/%%b"
      set "WSLDIR=!WSLDIR:\=/!"
    )
  ) else (
    for /f "usebackq delims=" %%p in (`wsl.exe !DISTRO_ARG! -- wslpath -a -u "%~dp0." 2^>nul`) do set "WSLDIR=%%p"
  )
)
set "DISTRO_ARG="
if defined DISTRO set "DISTRO_ARG=-d !DISTRO!"
rem Resolve the WSL home directory once; it backs the fallback below and lets the
rem Windows-drive clone hand over to a prepared copy inside WSL.
set "HOMEDIR="
for /f "usebackq delims=" %%h in (`wsl.exe !DISTRO_ARG! -- bash -lc "printf '%%s' \"$HOME\"" 2^>nul`) do set "HOMEDIR=%%h"
if not defined WSLDIR (
  if not defined HOMEDIR (
    echo   ERROR: could not find a project path or a WSL home directory.
    echo          Set CHORDMINI_WSL_DIR to the project path inside WSL.
    pause
    exit /b 1
  )
  echo   note: could not map this folder into WSL; falling back to the WSL copy in your home directory
  set "WSLDIR=!HOMEDIR!/ChordMiniApp"
)
rem A clone on a Windows drive is normally just the editable source; installing
rem dependencies there is slow and duplicates gigabytes already present in WSL.
if not defined CHORDMINI_WSL_DIR if /i "!WSLDIR:~0,5!"=="/mnt/" (
  set "SRCDIR=!WSLDIR!"
  set "HOMECOPY=!HOMEDIR!/ChordMiniApp"
  wsl.exe !DISTRO_ARG! -- bash -lc "test -f \"$HOME/ChordMiniApp/start.sh\" && test -x \"$HOME/ChordMiniApp/python_backend/.venv/bin/python\" && test -d \"$HOME/ChordMiniApp/node_modules\"" >nul 2>&1
  if not errorlevel 1 (
    set "WSLDIR=!HOMECOPY!"
    echo   note this folder is on a Windows drive and is used as source only;
    echo        running the installed copy at !WSLDIR! instead
    echo        set CHORDMINI_WSL_DIR to run the Windows-drive copy itself
    rem A mirror copy (no .git of its own) receives the edited sources before it
    rem runs, so the WSL side never executes stale code. NO_SYNC=1 skips this.
    if not defined NO_SYNC (
      wsl.exe !DISTRO_ARG! -- bash -lc "if command -v rsync >/dev/null 2>&1; then if test -d '!HOMECOPY!/'.git; then echo '  skip syncing: this copy keeps its own git history'; else if rsync -a --delete --exclude=.git --exclude=node_modules --exclude=.venv --exclude=.next --exclude=state --exclude=python_backend/data --exclude=.env.local '!SRCDIR!/' '!HOMECOPY!/'; then echo '  ok  synced the edited sources into the WSL copy'; else echo '  xx  syncing the sources failed'; exit 1; fi; fi; fi"
      if errorlevel 1 (
        echo   ERROR: could not copy the sources into !WSLDIR!
        echo          Set NO_SYNC=1 to launch it as it is.
        pause
        exit /b 1
      )
    )
  )
)

rem Already serving? Just open it instead of starting a second copy (the
rem launcher refuses to share ports, so clicking twice would otherwise fail).
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { if ((Invoke-WebRequest -UseBasicParsing '%URL%' -TimeoutSec 2).StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>&1
if not errorlevel 1 (
  echo ChordMini is already running at %URL%
  if not "%NO_BROWSER%"=="1" start "" "%URL%"
  rem ping instead of timeout.exe: a Git/MSYS PATH can shadow the latter.
  ping -n 5 127.0.0.1 >nul 2>&1
  exit /b 0
)

rem Anything passed to this file is forwarded to start.sh instead of --prod, so
rem "start.cmd --check" and "start.cmd --prod --rebuild" behave as expected.
set "ARGS=--prod"
if not "%~1"=="" set "ARGS=%*"

if defined DISTRO (
  echo Starting ChordMini in WSL !DISTRO! ...
) else (
  echo Starting ChordMini in your default WSL distribution ...
)
echo   project: !WSLDIR!
echo   url:     %URL%
echo.

if not "%NO_BROWSER%"=="1" call :open_when_ready

wsl.exe !DISTRO_ARG! -- bash -lc "cd '!WSLDIR!' 2>/dev/null || { echo; echo 'ERROR: no project at !WSLDIR! in this WSL distribution.'; echo 'Clone the repository there, or set CHORDMINI_WSL_DIR.'; exit 1; }; ./start.sh %ARGS%"

echo.
echo ChordMini stopped.
pause
exit /b 0

:open_when_ready
rem Poll the frontend for up to five minutes, then hand the URL to the browser.
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$url = '%URL%'; for ($i = 0; $i -lt 300; $i++) { try { if ((Invoke-WebRequest -UseBasicParsing $url -TimeoutSec 2).StatusCode -eq 200) { Start-Process $url; break } } catch {}; Start-Sleep -Seconds 1 }"
exit /b 0