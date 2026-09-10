@echo off
echo ========================================
echo  LPSG Video Fetcher - Local Server
echo ========================================
echo.
echo Starting server at http://localhost:8788
echo Press Ctrl+C to stop
echo.
cd /d "%~dp0"
npx wrangler pages dev public
pause
