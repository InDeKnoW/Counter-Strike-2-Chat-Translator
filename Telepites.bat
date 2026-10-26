@echo off
chcp 65001 >nul
title CS2 Chat Translator - Telepítő & Beállító
echo =======================================================
echo         CS2 Chat Translator - Automatikus Telepítő
echo =======================================================
echo.

cd /d "%~dp0"

echo [1/4] Node.js ellenőrzése...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [HIBA] A Node.js nincs telepítve a gépen!
    echo Kérlek töltsd le és telepítsd a hivatalos oldalról: https://nodejs.org/
    echo A letöltés után indítsd újra ezt a telepítőt.
    pause
    exit /b 1
)
echo       Node.js rendben.

echo.
echo [2/4] Függőségek ellenőrzése (npm install)...
if not exist "node_modules" (
    call npm install --omit=dev
) else (
    echo       Függőségek már telepítve vannak.
)

echo.
echo [3/4] Asztali alkalmazás ellenőrzése...
if not exist "desktop-app\bin\Release\net10.0-windows\CS2ChatTranslator.exe" (
    echo       Asztali app lefordítása (.NET)...
    where dotnet >nul 2>&1
    if %errorlevel% equ 0 (
        dotnet build desktop-app -c Release
    ) else (
        echo [FIGYELEM] dotnet parancs nem található, meglévő bináris használata...
    )
)
echo       Asztali alkalmazás készen áll.

echo.
echo [4/4] Parancsikonok létrehozása (Asztal és Start menü)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell; " ^
  "$exe = Join-Path (Get-Location) 'desktop-app\bin\Release\net10.0-windows\CS2ChatTranslator.exe'; " ^
  "$desk = [Environment]::GetFolderPath('Desktop'); " ^
  "$startMenu = [Environment]::GetFolderPath('Programs'); " ^
  "$s1 = $ws.CreateShortcut((Join-Path $desk 'CS2 Chat Translator.lnk')); " ^
  "$s1.TargetPath = $exe; $s1.WorkingDirectory = (Get-Location).Path; $s1.Description = 'CS2 Chat Translator'; $s1.Save(); " ^
  "$s2 = $ws.CreateShortcut((Join-Path $startMenu 'CS2 Chat Translator.lnk')); " ^
  "$s2.TargetPath = $exe; $s2.WorkingDirectory = (Get-Location).Path; $s2.Description = 'CS2 Chat Translator'; $s2.Save(); " ^
  "Write-Host '      Parancsikonok sikeresen elhelyezve az Asztalon és a Start Menüben!'"

echo.
echo =======================================================
echo           A TELEPÍTÉS SIKERESEN BEFEJEZŐDÖTT!
echo =======================================================
echo.
echo Mostantól indíthatod az alkalmazást:
echo   - Az Asztalról: 'CS2 Chat Translator'
echo   - A Start Menüből: keresd a 'CS2 Chat Translator'-t
echo.
set /p START_NOW="Szeretnéd most elindítani az alkalmazást? (I/N): "
if /i "%START_NOW%"=="I" (
    start "" "desktop-app\bin\Release\net10.0-windows\CS2ChatTranslator.exe"
)