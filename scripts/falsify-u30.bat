@echo off
cd /d D:\RadFlowDev
if exist fals.done del /q fals.done
node scripts\falsify-u30.mjs > fals.log 2>&1
echo %ERRORLEVEL% > fals.done
