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

rem Recupere la derniere version depuis GitHub (si rien n'est en cours de modification ici)
where git >nul 2>nul
if not errorlevel 1 (
  echo Recuperation de la derniere version depuis GitHub...
  git pull --ff-only
  if errorlevel 1 (
    echo.
    echo  ATTENTION : impossible de recuperer la derniere version automatiquement.
    echo  Tu as peut-etre des modifications pas encore envoyees : lance envoyer.bat ou demande a Claude.
    echo.
    pause
  )
)

rem Premier lancement sur cet ordinateur (ou autre version de Node) : on (re)installe les modules
node -e "require('better-sqlite3');require('@anthropic-ai/sdk')" >nul 2>nul
if errorlevel 1 (
  echo Installation des modules pour cet ordinateur, patiente une minute...
  rem --ignore-scripts : better-sqlite3 contient deja les versions compilees, pas besoin de Visual Studio
  call npm install --ignore-scripts
)

start "" http://localhost:3003
node server.js
pause
