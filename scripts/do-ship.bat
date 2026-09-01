@echo off
cd /d D:\RadFlowDev
del /q D:\RadFlowDev\scripts\run-all3.bat 2>nul
del /q D:\RadFlowDev\scripts\run-u72b.bat 2>nul
del /q D:\RadFlowDev\scripts\run-ft.bat 2>nul
del /q D:\RadFlowDev\scripts\run-build.bat 2>nul
del /q D:\RadFlowDev\.all3.log 2>nul
del /q D:\RadFlowDev\.all3.done 2>nul
del /q D:\RadFlowDev\.u72b.log 2>nul
del /q D:\RadFlowDev\.u72b.done 2>nul
del /q D:\RadFlowDev\.ft.log 2>nul
del /q D:\RadFlowDev\.ft.done 2>nul
del /q D:\RadFlowDev\.build.log 2>nul
del /q D:\RadFlowDev\.build.done 2>nul
git add -A
git status --porcelain
git commit -F .commitmsg
git push origin dev
git checkout main
git merge --no-ff -F .commitmsg dev
git push origin main
git checkout dev
git merge --ff-only main
git push origin dev
git ls-remote origin main dev
git status --porcelain
