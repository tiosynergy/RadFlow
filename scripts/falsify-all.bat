@echo off
rem U-74: ревізія ВСІХ стендів фальсифікації. Довго (десятки хвилин) — це не гейт.
cd /d %~dp0..
node scripts/falsify-all.mjs %*
