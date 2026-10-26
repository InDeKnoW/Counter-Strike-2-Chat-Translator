@echo off
title CS2 Chat Translator
cd /d "C:\Users\istva\Documents\cs2-chat-translator"

for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":7420" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)

"C:\Users\istva\AppData\Local\Programs\nodejs\node.exe" "bin\cs2-chat-translator.js"
pause
