@echo off
REM Повний гейт одним фоновим прогоном: tsc -> eslint -> vitest(json) -> build.
REM Через міст Desktop Commander не можна чекати довше ~60 с, тож запускаємо
REM ЦЕЙ файл через `start "" /b` і опитуємо chk.done. Інлайнове ланцюжкове
REM цитування (cmd /c "(...) & echo done") ламало `cd` і гнало eslint із чужої
REM теки — саме тому крок винесений у .bat (с48).
cd /d D:\RadFlowDev
if exist chk.done del /q chk.done
(
  call npx tsc --noEmit ^
  && call npx eslint . ^
  && call npx vitest run --reporter=json --outputFile=.full.json ^
  && call npm run build
) > chk.log 2>&1
echo %ERRORLEVEL% > chk.done
