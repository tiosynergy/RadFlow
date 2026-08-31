@echo off
cd /d D:\RadFlowDev
node scripts\falsify-u67.mjs > falsify-u67.log 2>&1
echo DONE %ERRORLEVEL% >> falsify-u67.log
