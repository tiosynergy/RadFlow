@echo off
cd /d D:\RadFlowDev
del /q fu57.done 2>nul
node scripts\falsify-u57.mjs > fu57.out 2>&1
echo done > fu57.done
