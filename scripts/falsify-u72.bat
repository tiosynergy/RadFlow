@echo off
cd /d D:\RadFlowDev
node scripts\falsify-u72.mjs > falsify-u72.log 2>&1
echo DONE %ERRORLEVEL% >> falsify-u72.log
