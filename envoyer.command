#!/bin/bash
# Mac : double-clique sur ce fichier quand tu as fini de travailler sur ce Mac :
# il enregistre tes modifications et les envoie sur GitHub.
cd "$(dirname "$0")"

# Signature des modifications (reglee une seule fois par ordinateur)
git config user.email >/dev/null || git config user.email "etiennefayet28@gmail.com"
git config user.name >/dev/null || git config user.name "Etienne"

git add -A
if git diff --cached --quiet; then
  echo "Aucune nouvelle modification a enregistrer."
else
  git commit -m "Modifications du $(date '+%d/%m/%Y %H:%M') (Mac)"
fi

echo "Envoi sur GitHub..."
git pull --rebase
if git push; then
  echo
  echo "  C'est envoye ! Tu peux reprendre sur un autre ordinateur."
else
  echo
  echo "  L'envoi a echoue. Demande a Claude de regarder."
fi
echo
read -p "Appuie sur Entree pour fermer..."
