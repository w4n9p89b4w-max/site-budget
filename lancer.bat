@echo off
rem Double-clique sur ce fichier pour lancer le site en local.
rem Laisse cette fenetre ouverte tant que tu utilises le site.
cd /d "%~dp0"
title Site budget - serveur local

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js n'est pas installe sur cet ordinateur.
  echo  Installe la version "LTS" depuis https://nodejs.org puis relance ce fichier.
  echo.
  start "" https://nodejs.org
  pause
  exit /b
)

rem Premier lancement sur cet ordinateur (ou autre version de Node) : on (re)installe les modules
node -e "require('better-sqlite3')" >nul 2>nul
if errorlevel 1 (
  echo Installation des modules pour cet ordinateur, patiente une minute...
  call npm install
  call npm rebuild better-sqlite3
)

start "" http://localhost:3003
node server.js
pause
