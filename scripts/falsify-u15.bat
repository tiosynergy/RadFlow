cd /d D:\RadFlowDev
if exist fu15.done del /q fu15.done
node scripts\falsify-u15.mjs > fu15.log 2>&1
echo %ERRORLEVEL% > fu15.done
