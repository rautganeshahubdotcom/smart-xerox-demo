@echo off
title Smart Xerox Server
echo ==========================================
echo   Starting Smart Xerox Server...
echo ==========================================

:: Start Node.js server in background
cd /d "c:\Users\rautg\Downloads\KP works\web_xerox_automation"
start /min "SmartXerox-Server" cmd /c "node server.js"

:: Wait for server to boot
timeout /t 3 /nobreak >nul

:: Start Ngrok tunnel
start /min "SmartXerox-Ngrok" cmd /c "ngrok http 3000"

echo ==========================================
echo   Smart Xerox is LIVE!
echo   Close this window - server keeps running
echo ==========================================
timeout /t 5 /nobreak >nul
