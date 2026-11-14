@echo off
title Wairua Scribe
cd /d "%~dp0"
echo.
echo   Wairua Scribe - servidor local
echo   Abre http://localhost:8000 en Chrome o Edge.
echo   No cierres esta ventana mientras uses la app. Ctrl+C para detener.
echo.
start "" cmd /c "timeout /t 3 >/dev/null & start http://localhost:8000"

py -3 --version >/dev/null 2>&1
if %errorlevel%==0 ( py -3 -m http.server 8000 & goto :fin )

python --version >/dev/null 2>&1
if %errorlevel%==0 ( python -m http.server 8000 & goto :fin )

where npx >/dev/null 2>&1
if %errorlevel%==0 ( npx --yes http-server -p 8000 -c-1 & goto :fin )

echo   No se ha encontrado Python ni Node.js.
echo   Instala Python desde https://www.python.org/downloads/ (marca "Add python.exe to PATH")
echo   o desde Microsoft Store, y vuelve a abrir este archivo.
echo.
:fin
pause
