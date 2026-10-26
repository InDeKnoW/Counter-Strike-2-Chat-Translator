$ErrorActionPreference = "Stop"
Write-Host "=== CS2 Chat Translator - Csomagolás barátok számára ==="

$rootDir = "C:\Users\istva\Documents\cs2-chat-translator"
$distDir = "$rootDir\dist\CS2-Chat-Translator"
$zipPath = "$rootDir\dist\CS2-Chat-Translator-Portable.zip"

if (Test-Path $distDir) { 
    try { Remove-Item -Recurse -Force $distDir -ErrorAction Stop } 
    catch { Get-ChildItem -Path $distDir -Recurse -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue }
}
if (Test-Path $zipPath) { Remove-Item -Force $zipPath }

New-Item -ItemType Directory -Path $distDir -Force | Out-Null
New-Item -ItemType Directory -Path "$distDir\runtime" -Force | Out-Null
New-Item -ItemType Directory -Path "$distDir\bin" -Force | Out-Null

Write-Host "1. Futtatható WPF app fordítása és közzététele (.NET 8 LTS - megbízható verzió)..."
dotnet publish "$rootDir\desktop-app\CS2ChatTranslator.csproj" -c Release -r win-x64 --self-contained true -o "$rootDir\dist\publish-selfcontained"
Copy-Item "$rootDir\dist\publish-selfcontained\*" $distDir -Recurse -Force

Write-Host "2. Digitális tanúsítvány hozzáadása (Authenticode aláírás a vírusirtók ellen)..."
try {
    $cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Where-Object { $_.Subject -like "*CS2 Chat Translator*" } | Select-Object -First 1
    if (-not $cert) {
        $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=CS2 Chat Translator Community" -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(5)
    }
    if ($cert) {
        Set-AuthenticodeSignature -FilePath "$distDir\CS2ChatTranslator.exe" -Certificate $cert -HashAlgorithm SHA256 | Out-Null
        Write-Host "      CS2ChatTranslator.exe sikeresen aláírva!"
    }
} catch {
    Write-Host "      Figyelem: Aláírás kihagyva (nem kritikus)."
}

Write-Host "3. Fordító motor és billentyűküldő másolása..."
Copy-Item "$rootDir\bin\cs2-chat-translator.js" "$distDir\bin\" -Force
if (Test-Path "$rootDir\bin\KeySender.exe") {
    Copy-Item "$rootDir\bin\KeySender.exe" "$distDir\bin\" -Force
}
Copy-Item "$rootDir\package.json" "$distDir\" -Force

Write-Host "4. Beágyazott Node.exe másolása (önálló futtatáshoz)..."
$nodePath = (Get-Command node).Source
Copy-Item $nodePath "$distDir\runtime\node.exe" -Force

Write-Host "5. Függőségek másolása (node_modules)..."
Copy-Item "$rootDir\node_modules" "$distDir\node_modules" -Recurse -Force

Write-Host "6. Útmutató és segédfájlok létrehozása..."
$guide = @"
====================================================================
           🎮 CS2 CHAT TRANSLATOR - GYORS ÚTMUTATÓ 🎮
====================================================================

Kedves Játékos! Ez a program valós időben lefordítja a CS2-ben
lévő chat üzeneteket, és segít gyorsan válaszolni a csapatnak.

A program TELJESEN HORDOZHATÓ: semmit sem kell telepítened a gépedre!

--------------------------------------------------------------------
1. LÉPÉS: CS2 INDÍTÁSI OPCIÓ (Csak egyszer kell beállítani!)
--------------------------------------------------------------------
1. Nyisd meg a Steam-et.
2. Jobb klikk Counter-Strike 2 -> Tulajdonságok (Properties).
3. Az "Általános" fülön az "Indítási beállítások"-hoz írd be:
   
   -condebug

4. Zárd be az ablakot.

--------------------------------------------------------------------
2. LÉPÉS: INDÍTÁS
--------------------------------------------------------------------
- Egyszerűen indítsd el az [Inditas.bat] vagy [CS2ChatTranslator.exe] fájlt!
- Ha az Asztalra szeretnél parancsikont, kattints a [Telepites-Asztalra.bat]-ra.

💡 VÍRUSIRTÓ INFORMÁCIÓ (Fontos!):
Mivel ez egy független közösségi szoftver (nem több millió forintos
vállalati Microsoft licenccel aláírva), a Windows SmartScreen első
indításkor kiírhatja: "A Windows védte a számítógépet".
Ez teljesen normális! Kattints a:
  -> [További információ]
  -> [Futtatás mindenképp]
lehetőségre. A program 100%-ban nyílt és biztonságos.

--------------------------------------------------------------------
3. LÉPÉS: TELEFONOS TÁVIRÁNYÍTÓ (Opcionális)
--------------------------------------------------------------------
A program fejlécében kattints a [📱 Telefon] gombra, és olvasd be
a QR kódot a telefonoddal! Így meccs közben a telefonodról is küldhetsz
magyarul beírt, de oroszra/angolra lefordított üzenetet a játékba.

Jó játékot és sok győzelmet! 🏆
"@
[System.IO.File]::WriteAllText("$distDir\HASZNALAT-ES-TELEPITES.txt", $guide, [System.Text.Encoding]::UTF8)

$inditBat = @"
@echo off
chcp 65001 >nul
title CS2 Chat Translator Indító
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -Path '%~dp0' -Recurse | Unblock-File" 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~dp0CS2ChatTranslator.exe' -Verb RunAs" 2>nul || start "" "CS2ChatTranslator.exe"
"@
[System.IO.File]::WriteAllText("$distDir\Inditas.bat", $inditBat, [System.Text.Encoding]::UTF8)

$shBat = @"
@echo off
chcp 65001 >nul
title CS2 Chat Translator - Parancsikon létrehozása
echo =======================================================
echo     CS2 Chat Translator - Asztali parancsikon
echo =======================================================
echo.
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "`$ws = New-Object -ComObject WScript.Shell; " ^
  "`$exe = Join-Path (Get-Location) 'CS2ChatTranslator.exe'; " ^
  "`$desk = [Environment]::GetFolderPath('Desktop'); " ^
  "`$s = `$ws.CreateShortcut((Join-Path `$desk 'CS2 Chat Translator.lnk')); " ^
  "`$s.TargetPath = `$exe; `$s.WorkingDirectory = (Get-Location).Path; `$s.Description = 'CS2 Chat Translator'; `$s.Save(); " ^
  "Get-ChildItem -Path (Get-Location) -Recurse | Unblock-File; " ^
  "Write-Host '      Parancsikon sikeresen létrehozva az Asztalon!'"

echo.
pause
"@
[System.IO.File]::WriteAllText("$distDir\Telepites-Asztalra.bat", $shBat, [System.Text.Encoding]::UTF8)

Write-Host "7. Tömörítés ZIP archívumba..."
Compress-Archive -Path "$distDir\*" -DestinationPath $zipPath -CompressionLevel Optimal

$zipSizeMb = [Math]::Round((Get-Item $zipPath).Length / 1MB, 2)
Write-Host "=== SIKERES! A frissített hordozható csomag elkészült: $zipPath ($zipSizeMb MB) ==="