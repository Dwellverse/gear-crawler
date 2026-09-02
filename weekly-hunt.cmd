@echo off
rem Weekly crawl: hunt the ranked gaps (demand-weighted), hand everything found to the
rem app, and post the snapshot to the admin card. Scheduled via Task Scheduler as
rem "GearPlug weekly hunt"; logs append to weekly-hunt.log next to this file.
rem
rem Terra2 sleeps by design (see CLAUDE.md power strategy) — the task is registered
rem with StartWhenAvailable, so a run missed while asleep fires on the next wake
rem rather than waking the machine for it.

setlocal
set "PATH=C:\Users\James\Tools\node20\node-v20.20.2-win-x64;%PATH%"
cd /d C:\Users\James\dev\gearplug\gear-crawler

echo ============================================================ >> weekly-hunt.log
echo [%date% %time%] weekly hunt starting >> weekly-hunt.log

node src\cli.js hunt --top 15 --apply    >> weekly-hunt.log 2>&1
node src\cli.js handoff --limit 40       >> weekly-hunt.log 2>&1
node src\cli.js handoff --limit 40       >> weekly-hunt.log 2>&1
node src\cli.js report --note "weekly scheduled hunt" >> weekly-hunt.log 2>&1

echo [%date% %time%] weekly hunt finished >> weekly-hunt.log
endlocal
