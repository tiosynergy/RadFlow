@echo off
cd /d D:\RadFlowDev
node scripts\falsify-f4-incident-window.mjs > falsify-f4-iw.log 2>&1
echo DONE >> falsify-f4-iw.log
