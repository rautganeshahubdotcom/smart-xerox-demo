@echo off
title Uploading to GitHub
cd /d "%~dp0"
echo ===================================================
echo Uploading your Smart Xerox Demo to GitHub...
echo ===================================================
echo.

:: Add the remote repository
git remote add origin https://github.com/rautganeshahubdotcom/smart-xerox-demo.git

:: Rename local branch to main (GitHub's default)
git branch -M main

:: Push the code to GitHub
git push -u origin main

echo.
echo ===================================================
echo Done! 
echo (If a browser window or popup appeared asking you to log in to GitHub, make sure you completed it so the upload finishes).
echo ===================================================
pause
