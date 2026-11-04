@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo First run: installing dependencies, please wait...
  call npm install
)
npm start
if errorlevel 1 pause
