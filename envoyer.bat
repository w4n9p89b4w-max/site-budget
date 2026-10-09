@echo off
rem Double-clique sur ce fichier quand tu as fini de travailler sur cet ordinateur :
rem il enregistre tes modifications et les envoie sur GitHub.
cd /d "%~dp0"
title Site budget - envoi sur GitHub

rem Signature des modifications (reglee une seule fois par ordinateur)
git config user.email >nul 2>nul || git config user.email "etiennefayet28@gmail.com"
git config user.name >nul 2>nul || git config user.name "Etienne"

git add -A
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "Modifications du %date% %time:~0,5%"
) else (
  echo Aucune nouvelle modification a enregistrer.
)

echo Envoi sur GitHub...
git pull --rebase
git push
if errorlevel 1 (
  echo.
  echo  L'envoi a echoue. Demande a Claude de regarder.
) else (
  echo.
  echo  C'est envoye ! Tu peux reprendre sur un autre ordinateur.
)
echo.
pause
