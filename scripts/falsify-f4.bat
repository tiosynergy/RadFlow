@echo off
REM Стенд фальсифікації Ф4 одним фоновим прогоном (міст DC рве виклик на ~60 с).
REM Запуск: start /b cmd /c scripts\falsify-f4.bat ; далі опитувати f4.done
cd /d D:\RadFlowDev
if exist f4.done del /q f4.done
node scripts/falsify-f4-affected.mjs > f4.log 2>&1
echo %ERRORLEVEL% > f4.done
