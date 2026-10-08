@echo off
rem Double-clique sur ce fichier pour lancer le site en local.
rem Laisse cette fenetre ouverte tant que tu utilises le site.
cd /d "%~dp0"
start "" http://localhost:3003
node server.js
pause
