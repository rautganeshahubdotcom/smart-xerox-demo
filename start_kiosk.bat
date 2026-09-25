@echo off
title Smart Xerox Kiosk Server
echo ===================================================
echo Starting Smart Xerox Backend Server...
echo ===================================================
cd /d "%~dp0"

:: Start the Node server
start cmd /k "title Node Server && node server.js"

echo Server started! 
echo.
echo Now starting Ngrok to put the website on the internet...
echo (Make sure you have added your static domain below)
echo.

:: Replace the domain below with your actual static ngrok domain
:: Example: ngrok http --domain=tough-tiger-strictly.ngrok-free.app 3000
ngrok http 3000

pause
