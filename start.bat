@echo off
cd /d "%~dp0"
title AcousticLab 3D
echo ============================================
echo   AcousticLab 3D - Room Acoustics Simulator
echo ============================================
echo.
if exist "node_modules" goto run
echo [First run] Installing dependencies, this may take 1-2 minutes...
call npm install
if errorlevel 1 goto fail
echo.
:run
echo Starting dev server, your browser will open automatically...
echo Close this window to stop the server.
echo.
call npm start
if errorlevel 1 goto fail
exit /b 0
:fail
echo.
echo Startup failed. Please check the error messages above.
pause
exit /b 1
