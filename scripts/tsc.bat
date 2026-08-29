cd /d D:\RadFlowDev
if exist tsc.done del /q tsc.done
call npx tsc --noEmit > tsc.log 2>&1
echo %ERRORLEVEL% > tsc.done
