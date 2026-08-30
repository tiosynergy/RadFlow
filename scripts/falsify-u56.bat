@echo off
cd /d D:\RadFlowDev
del /q fu56.done 2>nul
node scripts\falsify-u56.mjs > fu56.out 2>&1
echo done > fu56.done
