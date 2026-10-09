# Budget Mensuel — notes du projet

Site perso d'Etienne et Noa : https://budgetmensuel.fayetcardoso.fr
Le projet est sur GitHub (dépôt privé https://github.com/w4n9p89b4w-max/site-budget) et utilisé depuis plusieurs ordinateurs.
L'utilisateur ne veut PAS de OneDrive : chaque PC a une copie locale (ex. C:\Projets\site-budget).
Répondre en français, simplement (l'utilisateur n'est pas développeur).

## Fichiers
- `index.html` : toute la page (HTML + CSS + JS dans un seul fichier).
- `server.js` : le vrai serveur du site (Express + SQLite, port 3003), repris de `J:\budget mensuel\server.js`.
  Ajouts faits ici : création des colonnes manquantes sur une base neuve, table et API `/api/accounts`.
- `budget.db` : base de test locale (pas les vraies données), propre à chaque ordinateur, non envoyée sur GitHub.
- `lancer.bat` : récupère la dernière version (git pull), installe les modules au besoin, lance le site → http://localhost:3003.
- `envoyer.bat` : enregistre et envoie les modifications sur GitHub.
- `IMG_*.PNG` : captures/maquettes envoyées par l'utilisateur comme modèles de design.

## Points importants
- Les données sont communes à Etienne et Noa (le serveur ne filtre pas par utilisateur).
- En ligne, le serveur sert la page depuis un dossier `public/`. Mise en ligne = copier `index.html` dans `public/` ET remplacer `server.js` (sinon les comptes ne s'enregistrent pas).
- Ne jamais lire `J:\budget mensuel\cles api.txt` (clés API).

## Refonte en cours (depuis le 08/10/2026)
- Style "appli mobile" crème / doré (police Nunito) d'après les captures de l'utilisateur.
- Accueil : Total Patrimoine, cartes de comptes (solde saisi puis mis à jour par les transactions), boutons Dépense / Revenu / Transfert, liste des transactions (À venir + récentes).
- Barre du bas : Accueil, Budget, Stats, Réglages. Le journal complet s'ouvre depuis l'accueil.
- Les anciennes banques codées en dur (cepac, revolut, ca) sont abandonnées : l'utilisateur crée ses comptes.
- Prévu plus tard : création de compte utilisateur à l'arrivée sur le site, page Objectifs, refonte des pages Budget / Stats / Réglages.

## Façon de travailler
- Début de session : `git pull`. Chaque étape validée = un commit, puis `git push` pour que l'autre PC l'ait.
- Ne jamais supprimer de fichiers de l'utilisateur sans les avoir mis de côté (réécriture d'historique git comprise).
- Tester en largeur téléphone (375 px) dans le navigateur intégré.
