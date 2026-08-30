@echo off
REM Повний гейт одним фоновим прогоном: tsc -> eslint -> vitest(json) -> build.
REM ⚠️ с50: крок лінта зве САМЕ `npm run lint`, а не `npx eslint .` — інакше
REM цей файл лишався б поблажливим повз package.json. Замірено: `eslint .` без
REM `--max-warnings 0` вертає 0 навіть на попередженнях (фаза 2 аудиту).
REM Через міст Desktop Commander не можна чекати довше ~60 с, тож запускаємо
REM ЦЕЙ файл через `start "" /b` і опитуємо chk.done. Інлайнове ланцюжкове
REM цитування (cmd /c "(...) & echo done") ламало `cd` і гнало eslint із чужої
REM теки — саме тому крок винесений у .bat (с48).
cd /d D:\RadFlowDev
if exist chk.done del /q chk.done
(
  call npx tsc --noEmit ^
  && call npm run lint ^
  && call npx vitest run --reporter=json --outputFile=.full.json ^
  && call npm run build
) > chk.log 2>&1
echo %ERRORLEVEL% > chk.done
