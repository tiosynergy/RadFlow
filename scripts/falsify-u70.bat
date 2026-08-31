@echo off
cd /d D:\RadFlowDev
node scripts\falsify-u70.mjs > falsify-u70.log 2>&1
echo DONE %ERRORLEVEL% >> falsify-u70.log
