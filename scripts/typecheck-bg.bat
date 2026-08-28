@echo off
REM ===== Фоновий typecheck =====
REM Навіщо: міст Desktop Commander рве будь-який виклик приблизно на 60 с, а
REM `tsc --noEmit` на цьому проєкті йде довше. Тому не чекаємо в самому виклику,
REM а пускаємо у фоні й опитуємо МАРКЕР — той самий прийом, що описаний у
REM «пастках середовища» (NEXT_SESSION_PROMPT.md).
REM
REM Використання:
REM   start "" /b scripts\typecheck-bg.bat
REM   ...далі опитувати tsc-done.marker, потім читати tsc.log
REM
REM Обидва файли (tsc.log, tsc-done.marker) — у .gitignore: вони переписуються
REM на кожному запуску.
REM
REM Шлях береться від розташування скрипта (%~dp0..), а НЕ хардкодом: перша
REM версія лежала в корені з `cd /d D:\RadFlowDev` і на іншій машині або після
REM перейменування теки мовчки тайпчекала б не той проєкт.
cd /d "%~dp0.."
if exist tsc-done.marker del /q tsc-done.marker
call npm run typecheck > tsc.log 2>&1
echo done> tsc-done.marker
