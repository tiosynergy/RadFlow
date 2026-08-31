@echo off
cd /d D:\RadFlowDev
node scripts\falsify-f4-portal.mjs > falsify-f4-portal.log 2>&1
echo DONE >> falsify-f4-portal.log
