@echo off
cd /d D:\RadFlowDev
node scripts\falsify-f4-2.mjs > falsify-f4-2.log 2>&1
echo DONE %ERRORLEVEL% >> falsify-f4-2.log
