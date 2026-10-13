# Budget Mensuel — notes du projet

Site perso d'Etienne et Noa : https://budgetmensuel.fayetcardoso.fr
Le projet est sur GitHub (dépôt privé https://github.com/w4n9p89b4w-max/site-budget) et utilisé depuis plusieurs ordinateurs : un PC Windows et un MacBook Air.
L'utilisateur ne veut PAS de OneDrive : chaque ordinateur a une copie locale (Windows : C:\Projets\site-budget, Mac : ~/Projets/site-budget).
Répondre en français, simplement (l'utilisateur n'est pas développeur).

## Fichiers
- `index.html` : toute la page (HTML + CSS + JS dans un seul fichier).
- `server.js` : le vrai serveur du site (Express + SQLite, port 3003), repris de `J:\budget mensuel\server.js`.
  Ajouts faits ici : création des colonnes manquantes sur une base neuve, table et API `/api/accounts`.
- `budget.db` : base de test locale (pas les vraies données), propre à chaque ordinateur, non envoyée sur GitHub.
- `lancer.bat` : récupère la dernière version (git pull), installe les modules au besoin, lance le site → http://localhost:3003.
- `envoyer.bat` : enregistre et envoie les modifications sur GitHub.
- `lancer.command` / `envoyer.command` : les mêmes pour le Mac (garder fins de ligne LF et le droit d'exécution, voir `.gitattributes`).
- Installer les modules avec `npm install --ignore-scripts` (better-sqlite3 contient déjà les versions compilées Windows et Mac).
- `remplir-demo.js` : remplit un compte de la base locale avec des données d'exemple (comptes, opérations, régulières, objectifs). `node remplir-demo.js [email]`, `--effacer` pour tout retirer. Le compte doit exister sur l'ordinateur. `--compte-test` crée en plus un compte de test local (identifiants en haut du script) et le remplit.
- `releve-test.js` : fabrique un faux relevé (`releve-test.csv` + `releve-test.pdf`, non envoyés sur GitHub) à partir des opérations de la base locale, pour essayer l'ajout éclair : copies exactes, décalées d'un ou deux jours, un piège (même jour et même montant, autre dépense) et des nouvelles. `node releve-test.js [email]` (compte de test par défaut) ; affiche ce qui est attendu.
- `IMG_*.PNG` : captures/maquettes envoyées par l'utilisateur comme modèles de design.

## Points importants
- Comptes utilisateurs (depuis le 11/10/2026) : connexion par mail ou identifiant + mot de passe (empreinte scrypt, sessions par jeton).
  Un « foyer » regroupe jusqu'à 3 comptes liés par un code d'invitation ; chaque foyer ne voit que ses données (colonne household_id, ou clé préfixée « h<id>| »).
  Les données d'avant les comptes sont mises de côté dans la base (sans foyer), invisibles.
- Mot de passe oublié : lien par mail via nodemailer, réglé dans `mail.config.json` (jamais sur GitHub, voir .gitignore). Sans ce fichier, le lien s'affiche dans la fenêtre du serveur.
- En ligne, le serveur sert la page depuis un dossier `public/`. Mise en ligne = copier dans `public/` : `index.html`, `sw.js`, `manifest.webmanifest`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` ; ET remplacer `server.js` (sinon les comptes et les notifications ne marchent pas).
- Mail : modele `mail.config.exemple.json` a copier en `mail.config.json` (rempli par l'utilisateur, jamais sur GitHub).
- Ajout éclair (Réglages, depuis le 13/10/2026) : photo de ticket, relevé PDF / CSV / capture lus par l'API Anthropic (route `/api/import` de server.js, module `@anthropic-ai/sdk`), puis vérification et ajout en une fois. Doublons (même montant, même sens, à 3 jours près, même compte) : « presque sûr / probable / possible », comparaison côte à côte et choix « ne pas ajouter / ajouter quand même » (ordinateur : fenêtre où glisser le document, lien « ouvrir depuis un dossier », Ctrl + V d’une capture ; fenêtre large, fiches côte à côte ; téléphone : liste en cartes et écran « Contrôler les doublons » un par un).
  Relevés à plusieurs comptes (ex. Revolut et ses Pockets) : Claude donne la liste des comptes, le compte de chaque ligne et les mouvements internes ; on associe chaque compte du relevé à un compte du site (ou « Créer », ou « Ne pas importer » ; choix retenus sur l'appareil, clé `budget_qk_map`). Les mouvements internes deviennent des transferts (les deux moitiés rapprochées ; une ligne seule ne touche que son compte, pour garder les soldes du relevé). Un compte créé démarre au solde de début du relevé.
  Clé dans `anthropic.config.json` (modèle : `anthropic.config.exemple.json` ; jamais sur GitHub, voir .gitignore), modèle réglable dedans (`claude-opus-5-5` par défaut). En ligne : copier ce fichier sur le serveur et lancer `npm install --ignore-scripts`.
- Administration (compte admin, Réglages → Administration → « Données › » sur un foyer) : sauvegardes du serveur dans `sauvegardes/foyer-<id>/` (jamais sur GitHub ; à garder sur le serveur en ligne) : une chaque nuit à partir de 3 h, une avant chaque effacement ou remise, 40 gardées par foyer. Remettre une sauvegarde, en télécharger une, ou effacer les données d'un foyer (les membres gardent leur compte ; il faut écrire EFFACER).
- Notifications (depuis le 11/10/2026) : Web Push fait main dans server.js (chiffrement aes128gcm + VAPID, sans module). Cles creees au 1er lancement dans `vapid.json` (jamais sur GitHub ; a garder sur le serveur, sinon les appareils doivent se reabonner).
  Rappel du soir (heure choisie), echeances du jour (9 h, heure de Paris), alertes de budget 80 % / 100 % (envoyees par le site, une fois par groupe et par mois). Sur iPhone : seulement une fois le site ajoute a l'ecran d'accueil (iOS 16.4+). Necessite HTTPS en ligne.
- Apparence : clair / sombre / automatique (Reglages). Le theme sombre est calcule a partir des couleurs du CSS (buildDark), rien a maintenir a la main ; exceptions dans DARK_SKIP.
- Mode démo : sur github.io (GitHub Pages) ou avec `?demo=1`, la page n'appelle pas le serveur et garde les données dans le navigateur (clé `budget_demo`). Sans effet sur le vrai site.
- Ne jamais lire `J:\budget mensuel\cles api.txt` (clés API).

## Refonte en cours (depuis le 08/10/2026)
- Style "appli mobile" crème / doré (police Nunito) d'après les captures de l'utilisateur.
- Accueil : Total Patrimoine, cartes de comptes (solde saisi puis mis à jour par les transactions), boutons Dépense / Revenu / Transfert, liste des transactions (À venir + récentes).
- Ordre des comptes : lien « ⇅ Modifier l’ordre des comptes » sous les cartes (ou appui long sur une carte) → on fait glisser les cartes, « Terminé » enregistre (`/api/accounts/order`, colonne sort_order).
- Barre du bas : Accueil, Budget, Stats, Réglages. Le journal complet s'ouvre depuis l'accueil.
- Les anciennes banques codées en dur (cepac, revolut, ca) sont abandonnées : l'utilisateur crée ses comptes.
- Prévu plus tard : création de compte utilisateur à l'arrivée sur le site, page Objectifs, refonte des pages Budget / Stats / Réglages.

## Façon de travailler
- Début de session : `git pull`. Chaque étape validée = un commit, puis `git push` pour que l'autre PC l'ait.
- Ne jamais supprimer de fichiers de l'utilisateur sans les avoir mis de côté (réécriture d'historique git comprise).
- Tester en largeur téléphone (375 px) dans le navigateur intégré.
- Voir la version en cours sur l'iPhone : lancer `lancer.bat`/`lancer.command`, puis ouvrir dans Safari l'adresse « Sur ton iPhone » affichée par le serveur (même Wi-Fi). Windows : autoriser Node.js sur « Réseaux privés » si le pare-feu le demande.
