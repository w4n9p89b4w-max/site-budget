#!/bin/bash
# Mac : double-clique sur ce fichier pour lancer le site en local.
# Laisse cette fenetre du Terminal ouverte tant que tu utilises le site.
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js n'est pas installe sur ce Mac."
  echo "  Installe la version \"LTS\" depuis https://nodejs.org puis relance ce fichier."
  echo
  open https://nodejs.org
  read -p "Appuie sur Entree pour fermer..."
  exit 1
fi

# Recupere la derniere version depuis GitHub
if command -v git >/dev/null 2>&1; then
  echo "Recuperation de la derniere version depuis GitHub..."
  if ! git pull --ff-only; then
    echo
    echo "  ATTENTION : impossible de recuperer la derniere version automatiquement."
    echo "  Tu as peut-etre des modifications pas encore envoyees : lance envoyer.command ou demande a Claude."
    echo
    read -p "Appuie sur Entree pour continuer quand meme..."
  fi
fi

# Premier lancement sur ce Mac (ou autre version de Node) : on (re)installe les modules
if ! node -e "require('better-sqlite3')" >/dev/null 2>&1; then
  echo "Installation des modules pour ce Mac, patiente une minute..."
  # --ignore-scripts : better-sqlite3 contient deja les versions compilees
  npm install --ignore-scripts
fi

(sleep 2; open http://localhost:3003) &
node server.js
