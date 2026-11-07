# ✈ Contrail

**Journal de plane spotting et de vols, auto-hébergé.** Contrail consigne vos observations d'avions et vos vols personnels, les enrichit automatiquement (données appareil, EXIF, météo historique, immatriculation lue sur la photo) et les transforme en statistiques, cartes et succès — sans dépendre d'aucune plateforme tierce payante. Toutes les données restent chez vous, dans un unique dossier `./data`.

> ⚠️ **Clause de maintenance — projet personnel.**
> Ce projet est avant tout développé pour un **usage personnel**. Bien qu'il soit mis à disposition publiquement (open source), **l'auteur ne s'engage à assurer aucune maintenance continue, aucune correction de bugs ni aucun support technique sur le long terme.** Utilisez-le en connaissance de cause, et faites des sauvegardes.

---

> 💻 **Sans Docker** : des installeurs prêts à l'emploi (Windows `.exe`, macOS `.dmg`, Linux `.deb` / `.tar.gz`) installent Contrail comme un logiciel ordinaire, avec choix du dossier et raccourci sur le Bureau — voir [`desktop/README.md`](desktop/README.md).
>
> 🪟 **Sous Windows, le plus simple est d'utiliser l'installeur `.exe` dédié de la [dernière Release](../../releases/latest)** (`Contrail-<version>-Windows-Setup.exe`) : un double-clic, sans Python ni ligne de commande. Les commandes pour le [fabriquer vous-même](#créer-soi-même-linstalleur) ne sont utiles que pour une version non publiée ou modifiée.

## Sommaire

1. [Fonctionnalités](#fonctionnalités)
2. [Installation avec Docker (recommandé)](#installation-avec-docker-recommandé)
3. [Installation sans Docker](#installation-sans-docker) — dont l'[installeur](#créer-soi-même-linstalleur) (à télécharger ou à fabriquer), le [lanceur](#avec-le-lanceur-en-ligne) et l'[installation hors ligne](#installation-hors-ligne-sans-internet-sur-la-machine-cible)
4. [Configuration des API](#configuration-des-api)
5. [Accès mobile, HTTPS et PWA](#accès-mobile-https-et-pwa)
6. [Données, migration et sauvegardes](#données-migration-et-sauvegardes) — dont la [session de test](#session-de-test)
7. [Import et export](#import-et-export)
8. [Architecture technique](#architecture-technique)
9. [Limites connues et choix de conception](#limites-connues-et-choix-de-conception)
10. [Développement](#développement)
11. [Licence et crédits](#licence-et-crédits)

---

## Nouveautés des versions 4.x

- **4.5.1 — Désignations propres** : l'autocomplétion écrit « Airbus A330-300 » (et non « AIRBUS A-330-300 »), « B737-800 » (inchangé), « ATR 72-600 »…, et les désignations déjà enregistrées sont remises en forme une fois au premier démarrage.
- **4.5 — Matériel photo, filtres et démarrage** : panneau de filtres réorganisé en sections (avion, lieu et période, prise de vue, matériel, à compléter, collection) avec compteur de résultats en direct et nouveaux filtres (période, note minimale, avec GPS, avec description, sans type, sans numéro de série, sans boîtier/objectif) ; onglet **Matériel** (boîtiers, objectifs, setups ; ce que l'EXIF détecte s'y ajoute seul, le reste se saisit à la main, renommage/fusion), choix du matériel et des setups dans le formulaire de spot (et en modification en lot), **filtres boîtier et objectif séparés** dans la recherche ; interface qui démarre depuis le cache local (langue, réglages et session chargés en parallèle, fichiers préchargés).
- **4.4 — Enregistrement plus rapide** : la photo est analysée en deux temps (EXIF et aéroport d'abord, quasi instantanés et sans décoder l'image ; immatriculation ensuite, en arrière-plan), la lecture s'arrête dès qu'une immatriculation nette est trouvée, le moteur OCR et les bases d'aéroports sont préchauffés au démarrage, et les rattrapages de données ne s'exécutent plus qu'une fois par version (démarrage ≈ 30× plus rapide sur 30 000 spots, carte globale plus rapide).
- **4.3 — Lecture des immatriculations et remplissage** : Tesseract est remplacé par **RapidOCR** (modèles PP-OCR embarqués, 100 % local, sans programme externe) : plusieurs cadrages de la photo, confiance de lecture, validation du format par pays. Le **numéro de série (MSN)** et l'année de construction sont repris de la base OpenSky quand elle est importée (réimportez-la une fois : Réglages > Données).
- **4.2 — Exports PDF** : un vrai PDF mis en page (couverture, chiffres clés, graphique, classements, photos) pour le **bilan annuel**, la **liste de spots** (avec les filtres de la page, regroupement par année, jour ou lieu), la **fiche d'un spot** et le **carnet de vols**. Format, orientation, couleur d'accent, police, couverture, photos, pied de page et auteur se règlent à chaque export ou une fois pour toutes (Réglages > Données > Exports PDF).
- **4.1 — Carte globale** : regroupement des lieux proches selon le zoom (disques multicolores = répartition des types), nombre de spots dans les ronds, légende des couleurs et tailles, popups retravaillés, lecture animée par année, trimestre, mois ou semaine (cumulatif ou période seule) et **fonds satellite gratuits** (Esri World Imagery, orthophotos IGN pour la France).
- **4.0.1 — Enregistrement en arrière-plan** : un spot s'enregistre sans bloquer l'écran ; une pastille flottante en bas à droite indique l'avancement, le succès (elle disparaît après deux secondes) ou l'échec (réessayer, garder en brouillon).

### Nouveautés de la version 4.0

- **Enregistrement plus rapide** : encodage WebP allégé (réglage « Encodage des photos »), vignette tirée de la version réduite, barre de progression à l'envoi.
- **Import en lot** (`#/bulk`) : plusieurs photos d'un coup, date, aéroport et immatriculation (OCR) préremplis, vérification avant enregistrement.
- **Carte globale** (`#/map`) : tous les lieux, période réglable et lecture animée année par année.
- **Bilans annuels** (`#/reports`) : chiffres, premières, classements, meilleures photos, export PDF ; widget d'accueil « Bilan de l'année ».
- **Doublons de photos** (`#/duplicates`) : détection accélérée, suppression ou « garder les deux ».
- **Modification en masse** depuis la sélection de la liste des spots (pays, aéroport, exploitant, type de vol, note, immatriculation…).
- **Patrouilles** : page dédiée, passages, avions identifiés, fusion, renommage, badge « Patrouille revue ».
- **Personnalisation** (Réglages > Apparence) : densité, arrondis, police, taille du texte, style des graphiques, animations, menu latéral compact et entrées masquables, disposition de l'accueil, cartes de statistiques masquables.
- **Fiabilité** : rattrapages de données exécutés une fois par version, contrôle statique du front (`scripts/lint_front.py`), test de fumée navigateur (`tests/e2e_smoke.py`).

## Fonctionnalités

### Spotting
- **Ajout d'un spot** avec remplissage automatique du modèle, du code type OACI, de la compagnie, du MSN et du code Mode-S. Sources interrogées dans l'ordre : vos spots précédents → cache local (30 jours) → **hexdb.io** (sans clé) → **AirLabs** et **Aviationstack** (clés gratuites).
- **OCR local** (Tesseract) : l'immatriculation est lue directement sur la photo, avec plusieurs passes de prétraitement, validation par préfixe de nationalité OACI et classement des candidats (appareils déjà connus et pays de l'aéroport favorisés).
- **Pays d'immatriculation** déduit du préfixe (≈ 200 préfixes, y compris les cas particuliers B-H… Hong Kong, B-1xxxx Taïwan, VP-B Bermudes…), avec drapeau.
- **Étiquettes** multiples et colorées, créées à la volée depuis le formulaire.
- **Audio** joint à l'observation : fichier (mp3, m4a, ogg, wav, webm) **ou enregistrement direct au micro** depuis le terrain.
- **Trois vues** : liste détaillée, galerie, carte. La carte regroupe les spots par lieu (point de vue, coordonnées GPS ou aéroport), avec une pastille par lieu (vignette + nombre de spots) et des **clusters** au dézoom ; un **panneau latéral** liste les lieux visibles et se met à jour en déplaçant la carte, puis détaille le lieu choisi (période, types, appareils avec vignette ou silhouette, nombre de rencontres).
- **Badges dynamiques** : premier modèle, nouvelle compagnie, nouvel aéroport, revu ×N, avion le plus spotté, livrée spéciale, déjà volé dedans, militaire, nuit, heure dorée (calculée d'après la hauteur du soleil au moment du spot).
- Filtres combinables, tri, recherche plein texte, **sélection multiple** (appui long) et actions groupées, **gestes** : glisser une ligne pour la mettre en favori ou la supprimer, balayer une fiche pour passer au spot suivant.

### Mes vols
- Carnet de vols (date, aéroports, horaires, numéro de vol, compagnie, immatriculation, siège, classe, motif).
- **Fiche détaillée d'un vol** : billet (codes, villes, heures locales et UTC), carte du grand cercle, vitesse moyenne, cabine, appareil (silhouette, spots de cet appareil, photo Planespotters à défaut), mise en perspective (n-ième vol, passages sur la route, premier vol avec la compagnie ou sur le type…), vols précédent et suivant, **vol retour** ou duplication en un clic, **export en carte d'embarquement** (paysage, 4:5, story, couleurs et signature).
- Distance orthodromique et **durée calculées automatiquement** (fuseaux horaires des aéroports pris en compte).
- **Carte des trajets en grand cercle** (gestion de l'antiméridien), tours de la Terre, pourcentage de la distance Terre-Lune.
- **Références croisées** : notification et badge si vous spottez un avion dans lequel vous avez volé, et inversement.

### Collection & flottes
- Liste des compagnies observées et **taux de complétion de flotte** (anneau de progression, détail par type, appareils vus / manquants).
- **Flottes complètes sans AirLabs** : construites hors-ligne depuis la base de référence locale, qui fusionne tar1090-db (très à jour) et la base d'appareils d'OpenSky Network (code OACI de l'opérateur). Le code OACI est propagé aux appareils connus seulement par le nom de l'opérateur, et les variantes de nom (« AIR FRANCE S.A. ») sont rapprochées. Une compagnie ou **toutes les compagnies observées** d'un coup, en complément ou en remplacement. AirLabs reste disponible (toutes les pages sont parcourues), ainsi que l'import manuel (copier-coller depuis un tableur). Regroupement par famille d'appareils (A320 family, 737, 777…), aviation légère écartée par défaut, **exclusion** des appareils retirés ou mal rattachés (les exclusions survivent aux mises à jour).
- **Traqueur de livrées spéciales** : catégorisation automatique (rétro, alliance, commémorative, logojet, engagée…) à partir du champ « Livrée », dans plusieurs langues.

### Tableau de bord & statistiques
- **Accueil modulable** : 11 widgets activables et réordonnables (glisser-déposer) — photo à la une, raccourcis, derniers spots, « Ce jour-là », activité sur 12 mois, types favoris, succès, watchlist, vols, carte, lumière du jour.
- **Calendrier d'activité** (jour par jour, sur l'année ou les 53 dernières semaines) avec jours actifs, plus longue série et série en cours.
- **Statistiques** par année ou depuis le début, graphiques homogènes (barres fines, grille discrète, valeur au survol) : totaux, top 10 des appareils, aéroports, types, compagnies, pays, constructeurs, étiquettes, répartition par mois / heure / jour de la semaine / année, meilleure journée.
- **Statistiques matériel (EXIF)** : combo boîtier + objectif le plus productif, boîtiers, objectifs, focales.
- **Timeline par cellule** : chronologie et carte de toutes les rencontres avec une immatriculation (spots et vols), changements d'opérateur ou de livrée.

### Gamification & partage
- **226 succès** répartis en 51 séries à paliers (bronze, argent, or, platine, diamant), du premier spot aux 5 000 spots, de la première nuit au spot par 25 kt de vent, du premier vol à l'aller-retour Terre-Lune. Chaque palier rapporte des points qui déterminent un **rang** (de Novice à Légende) ; la page met en avant les succès presque débloqués. Les déblocages des versions précédentes sont conservés.
- **Objectifs de l'année** (spots, types, appareils différents) : progression, repère du rythme attendu, projection de fin d'année, nombre à faire par semaine, comparaison avec l'an dernier à la même date, série de jours en cours.
- **Générateur de story** : image récapitulative au format story, post 4:5, carré ou paysage, **huit styles** (verre sombre / clair, dégradé, minimal, carte d'embarquement, tableau des départs, magazine, plan technique), **palettes** prédéfinies ou **couleurs libres** (accent, secondaire, fond, texte), police des titres, signature, cadrage de la photo ; téléchargement PNG ou partage natif.
- **Partage d'un spot en image** (et non en lien) : éditeur avec six modèles (cadre, plein cadre, polaroid, carte de collection, carte d'embarquement, fiche d'observation), format **Auto** (le canevas prend les proportions de la photo, affichée en entier) ou story / 4:5 / carré / paysage, option **photo entière** sur fond flouté pour tous les modèles, informations affichées au choix (compagnie, aéroport, date, réglages photo, météo, badges), palettes et couleurs, cadrage ; téléchargement, partage natif ou copie dans le presse-papiers. Un spot sans photo utilise la silhouette de son type d'appareil.
- **Liens publics sécurisés** (jeton aléatoire, expiration facultative, révocables, compteur de vues) pour une galerie filtrée, un spot, une cellule, un vol ou l'ensemble de vos vols. Les notes personnelles et les coordonnées GPS précises ne sont jamais publiées.

### Enrichissement automatique
- **EXIF** : boîtier, objectif, focale (et équivalent 24×36), ouverture, vitesse, ISO, date de prise de vue, GPS → aéroport le plus proche proposé.
- **METAR / TAF historiques** associés à chaque spot, décodés (vent, rafales, visibilité, nuages, température, QNH, catégorie VFR/MVFR/IFR/LIFR). Sources : aviationweather.gov (≈ 15 derniers jours) puis l'archive de l'Iowa Environmental Mesonet pour les dates plus anciennes. Une tâche de fond rattrape les spots créés hors-ligne.

### Outils de terrain
- **Répertoire des points de vue** : position (carte), pistes, accès, **direction de visée** ; la course du soleil est calculée localement pour indiquer les créneaux où le soleil est dans le dos, l'heure dorée, le lever et le coucher, pour n'importe quelle date.
- **Radar en direct** (OpenSky Network, avec repli automatique sur adsb.lol / adsb.fi / airplanes.live quand le quota est atteint) centré sur votre position ou votre aéroport de référence : **silhouette selon le type d'appareil** (quadriréacteur, gros porteur, moyen-courrier, jet régional, turbopropulseur, affaires, aviation légère, hélicoptère, chasse, planeur, ballon, drone), appareils de la watchlist en rouge, déjà spottés en vert, militaires distingués ; fiche détaillée avec **photo de l'appareil** (la vôtre si vous l'avez déjà spotté, sinon Planespotters.net avec crédit du photographe), immatriculation, type, route, altitude, vitesse, squawk, et bouton « Spotter » qui pré-remplit le formulaire. **Filtres** (indicatif / immatriculation / hex / type, en vol / au sol, militaires, watchlist, pas encore spottés, tranche d'altitude, types d'appareils, mémorisés) et **trajectoire** tracée derrière l'avion sélectionné (positions vues depuis l'ouverture du radar ; un clic dans le vide la masque).
- **Base de référence des appareils** facultative (≈ 10 Mo, téléchargée ou importée dans Réglages › Intégrations) : base communautaire hors-ligne Mode-S ↔ immatriculation ↔ type ↔ opérateur, partagée par les sessions. Elle sert au radar, au remplissage automatique et à la complétion des flottes.
- **Watchlist & alertes** : vérification périodique ; notification quand un appareil suivi est détecté en vol, avec mention spéciale s'il se dirige vers l'un de vos aéroports de référence.

### Mobilité, intégrité, maintenance
- **PWA installable**, fonctionnement **hors-ligne** : la coquille et les données consultées restent accessibles ; les nouveaux spots (photo et audio compris) sont stockés en **brouillons** (IndexedDB) et **synchronisés automatiquement** au retour du réseau, de façon idempotente.
- **Détection des doublons** (même immatriculation, même aéroport, même jour), en direct dans le formulaire et à l'enregistrement.
- **Sauvegardes automatiques** planifiées (.zip de la base et de la configuration, médias en option), rotation, téléchargement en un clic, **restauration** depuis l'interface (avec sauvegarde de sécurité préalable).
- **Import de masse CSV** (JetPhotos, Planespotters, myFlightradar24, OpenFlights, tableur) avec reconnaissance automatique des colonnes, et **export** CSV / JSON complet.

### Interface
- Interface **sobre** : surfaces pleines, filets fins, une seule couleur d'accent, ombres discrètes ; grand titre en tête de page et actions à portée de pouce sur mobile.
- Mode clair / sombre / automatique, **couleur d'accent** au choix, mobile-first, navigation inférieure sur mobile et barre latérale sur ordinateur.
- **Quatre langues** : français, anglais, espagnol, japonais.
- Fonctions avancées repliées par défaut (volets, menus contextuels), **modules désactivables** (vols, flottes, radar, météo, OCR, points de vue, watchlist, gamification) pour garder une interface épurée.

### Nouveautés de la version 3.0
- **Sorties de spotting** : les spots d'un même jour et d'un même site (aéroport ou lieu libre) sont regroupés automatiquement en une sortie, avec chiffres clés (spots, avions, types, nouveaux avions, livrées spéciales…), METAR, chronologie, nom et notes modifiables, navigation de sortie en sortie. Les spots existants sont rattachés à la migration.
- **Meetings aériens** : fusionne plusieurs sorties du même site en une sortie sur plusieurs jours (bouton « Fusionner » dans la liste, ou proposition automatique quand une autre sortie du site tombe à ±3 jours), « Séparer les jours » défait la fusion. Un meeting peut être **planifié avant l'événement** (dates + site) : les spots pris ces jours-là, y compris ceux qui existent déjà, s'y rangent seuls. Le meeting a son **programme « à voir »** (types, immatriculations ou démonstrations ; les types et immatriculations se cochent seuls dès qu'un spot correspond), un bilan par jour (spots, nouveautés, météo), le rythme de prise de vue par heure, les types rares et les formations, et un bouton « Ajouter un spot » prérempli (site et jour).
- **Rareté** : avec la base de référence importée, chaque type reçoit un palier d'après le nombre d'exemplaires connus (exceptionnel ≤ 25, très rare ≤ 250, rare ≤ 2 000, peu commun ≤ 10 000, commun au-delà) : badge sur les spots et filtre « Rareté du type ».
- **Aéroports** (onglet du menu) : carte de tous vos aéroports, puis fiche par aéroport avec carte et points de vue, heure locale, altitude, sortie record, avions les plus revus, types rares vus, fréquentation, saisonnalité, types et compagnies les plus vus, points de vue, sorties, derniers spots.
- **Métadonnées IPTC/XMP à l'export** : photo seule (menu de la fiche), sélection multiple ou liste filtrée en archive .zip. Légende, titre, mots-clés (immatriculation, type, compagnie, aéroport, livrée, étiquettes), lieu, date, GPS, auteur et copyright (Réglages › Données). Si l'original est conservé et en JPEG, il n'est pas ré-encodé.
- **Corbeille** : suppressions (spots, vols, groupes) réversibles pendant 30 jours (réglable), restauration complète (étiquettes, patrouille), fichiers conservés jusqu'à la purge, bouton « Annuler » après chaque suppression.
- **Photos HEIC/HEIF** (iPhone) acceptées à l'import, converties en WebP, aperçu JPEG généré par le serveur pour les navigateurs qui ne les lisent pas.
- **Performances** : index dédiés, résultats mémorisés tant que les données ne changent pas (statistiques, tableau de bord, badges, succès, carte, facettes), badges calculés en une passe, pagination par clé. Mesuré avec `python scripts/bench.py --n 10000` ; la liste, la fiche et le tableau de bord restent sous quelques dizaines de millisecondes à 50 000 spots.
- **Watchlist** : repli sur adsb.lol, adsb.fi et airplanes.live quand OpenSky est en quota.

### Ajouts par rapport au cahier des charges
Recherche globale (`/` ou `Ctrl+K`), notifications in-app et système, relais **ntfy / webhook**, authentification facultative par mot de passe, enregistrement audio au micro, cible de partage Android (« Partager vers Contrail » depuis la galerie), coller une image depuis le presse-papiers, aéroport le plus proche via le GPS de la photo, notes et favoris, sélection multiple, pays d'immatriculation et drapeaux, heure dorée / nuit calculées, import myFlightradar24, restauration de sauvegarde, script de données de démonstration, documentation OpenAPI, tests automatisés.

---

## Installation avec Docker (recommandé)

Prérequis : Docker et Docker Compose v2.24 ou plus récent.

```bash
git clone <url-du-dépôt> contrail && cd contrail
cp .env.example .env          # facultatif : mot de passe, clés API, port…
docker compose up -d --build
```

L'application est disponible sur **http://localhost:8000** (ou le port défini par `CONTRAIL_PORT`).

- Le dossier `./data` est créé à côté du `docker-compose.yml` et monté dans le conteneur : c'est le seul état à sauvegarder.
- Au démarrage, le conteneur rend `./data` accessible à son utilisateur interne puis abandonne les droits root : peu importe que Docker ait créé le dossier en tant que root. Les fichiers appartiennent à l'UID/GID 1000 par défaut ; pour qu'ils appartiennent à votre compte, renseignez `PUID` et `PGID` dans `.env` (sortie de `id -u` et `id -g`).
- Si vous imposez un utilisateur avec l'option `user:` de compose, l'entrypoint ne peut plus corriger les droits : faites alors `sudo chown -R <uid>:<gid> ./data`.
- Mise à jour : `git pull && docker compose up -d --build`. Le schéma de base est migré automatiquement au démarrage.

L'image installe Tesseract : l'OCR fonctionne sans configuration.

## Installation sans Docker

Deux voies, sans Docker : l'**installeur** prêt à l'emploi (Windows, macOS, Linux — voir [`desktop/README.md`](desktop/README.md)) ou le **lanceur** `desktop/launcher.py` depuis les sources, décrit ci-dessous. Le lanceur démarre le serveur, ouvre le navigateur, place une icône dans la zone de notification et range les données dans le dossier propre à chaque système.

Prérequis : **Python 3.11 ou plus récent** (testé en 3.11 et 3.13) ; la lecture automatique des immatriculations (RapidOCR, installé par `pip install -r requirements.txt` avec ses modèles, aucun programme externe) fonctionne hors-ligne. Tesseract n'est plus qu'un repli facultatif.

### Créer soi-même l'installeur

> 🪟 Sous Windows, inutile en général : téléchargez simplement le `.exe` de la [dernière Release](../../releases/latest). Ce qui suit sert à fabriquer un installeur depuis vos propres sources (version modifiée, ou pas encore publiée).

Un script construit l'installeur de **votre** système (PyInstaller, puis Inno Setup sous Windows, `.deb` / `.tar.gz` sous Linux, `.dmg` sous macOS). Il installe les dépendances, lit la version dans `app/core.py` et dépose le résultat dans `dist/`. À lancer à la racine du projet, avec **Python 3.11+** :

**Windows (PowerShell)** — prérequis : [Inno Setup 6](https://jrsoftware.org/isinfo.php), par exemple `winget install JRSoftware.InnoSetup`
```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-setup.ps1
# → dist\Contrail-<version>-Windows-Setup.exe
```

**Windows (Git Bash), Linux, macOS**
```bash
bash scripts/build-setup.sh
# Windows → dist/Contrail-<version>-Windows-Setup.exe ; Linux → .deb et .tar.gz ; macOS → .dmg (dans dist/)
```

Options (identiques pour les deux scripts) : une version imposée (`-Version 4.5.1` en PowerShell, `bash scripts/build-setup.sh 4.5.1`), `-SkipPyInstaller` / `--skip-pyinstaller` pour réutiliser un `dist/Contrail` déjà construit, `-Clean` / `--clean` pour repartir de zéro.

Un installeur ne se construit que sur son propre système. Pour obtenir les quatre d'un coup (Windows, macOS Apple Silicon et Intel, Linux), poussez un tag `vX.Y.Z` : le workflow GitHub `desktop.yml` les construit, les teste et les publie dans une Release. Détails dans [`desktop/README.md`](desktop/README.md).

### Avec le lanceur (en ligne)

À exécuter à la racine du projet. Sous Windows, utilisez PowerShell ; si l'activation du venv est bloquée, lancez une fois `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

**Linux**
```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt pystray
python desktop/launcher.py
```

**macOS**
```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt pystray
python desktop/launcher.py
```

**Windows (PowerShell)**
```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt pystray
python desktop\launcher.py
```

`pystray` est facultatif : sans lui, le lanceur fonctionne sans icône de notification (`--no-tray`). Linux peut demander `sudo apt install python3-venv python3-tk` si le venv ou la boîte d'erreur échouent. L'application s'ouvre sur `http://localhost:8765` (un autre port libre est choisi si celui-ci est pris).

### Installation hors ligne (sans Internet sur la machine cible)

Le principe : télécharger les paquets Python (« wheels ») sur une machine connectée, copier le dossier avec le projet, puis installer sans réseau. **La machine de préparation doit avoir le même système, la même architecture et la même version mineure de Python (3.11, 3.12, 3.13…) que la machine cible**, sinon pip ne trouve pas les bons binaires (Pillow, pydantic, uvloop…).

*1. Sur la machine connectée* — depuis la racine du projet :

**Linux / macOS**
```bash
python3 -m venv .venv && source .venv/bin/activate
python -m pip install --upgrade pip
pip download -r requirements.txt pystray -d wheels
```

**Windows (PowerShell)**
```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip download -r requirements.txt pystray -d wheels
```

Copiez ensuite le projet complet, **dossier `wheels/` compris** (clé USB, disque externe), sur la machine cible. Ne copiez pas le `.venv` : il n'est pas portable.

*2. Sur la machine hors ligne* — dans le dossier copié :

**Linux**
```bash
python3 -m venv .venv && source .venv/bin/activate
pip install --no-index --find-links wheels -r requirements.txt pystray
python desktop/launcher.py
```

**macOS**
```bash
python3 -m venv .venv && source .venv/bin/activate
pip install --no-index --find-links wheels -r requirements.txt pystray
python desktop/launcher.py
```

**Windows (PowerShell)**
```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install --no-index --find-links wheels -r requirements.txt pystray
python desktop\launcher.py
```

Contrail ne demande plus Internet pour fonctionner : la base d'aéroports (`airportsdata`) et les fuseaux horaires (`tzdata`) sont embarqués dans les paquets. Seuls les services externes optionnels (fonds de carte, géocodage des villes, API de vol, météo) exigent une connexion ; hors ligne, le carnet, les photos, les statistiques et les succès restent pleinement utilisables. Pour une machine sans Python du tout, utilisez plutôt l'installeur de bureau, qui embarque son propre interpréteur.

### Options du lanceur

| Option | Effet |
|---|---|
| `--port 9000` | Port d'écoute (8765 par défaut ; variable `CONTRAIL_PORT`) |
| `--data-dir CHEMIN` | Dossier de données (photos, base) |
| `--lan` | Écoute sur le réseau local, pour l'ouvrir depuis un téléphone |
| `--no-browser` | N'ouvre pas le navigateur |
| `--no-tray` | Pas d'icône de notification |
| `--console` | Journal dans le terminal (diagnostic) |
| `--stop` | Arrête l'instance en cours |

Exemples : `python desktop/launcher.py --lan --no-browser` (Linux/macOS) ; `python desktop\launcher.py --data-dir D:\Contrail --port 9000` (Windows). Le journal et les éventuels plantages sont écrits dans `contrail.log` et `contrail-crash.log`, dans le dossier de données.

Dossier de données par défaut : Windows `%APPDATA%\Contrail` · macOS `~/Library/Application Support/Contrail` · Linux `~/.local/share/contrail`.

### Avec uvicorn (serveur seul, sans lanceur)

```bash
python -m venv .venv && source .venv/bin/activate      # Windows : .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Les données sont alors écrites dans `./data` (modifiable avec `CONTRAIL_DATA_DIR`). Pour découvrir l'interface avec des données fictives : `python scripts/seed_demo.py --url http://localhost:8000` sur une instance vide.

## Configuration des API

Toutes les intégrations sont **facultatives** et **gratuites**. Les clés se saisissent soit dans **Réglages › Intégrations**, soit dans `.env` (les variables d'environnement priment et apparaissent alors en lecture seule dans l'interface).

| Service | Variable(s) | Clé ? | Usage |
|---|---|---|---|
| hexdb.io | — | non | Immatriculation ↔ Mode-S, type, propriétaire, routes par indicatif |
| AirLabs | `AIRLABS_API_KEY` | oui (gratuite) | MSN, Mode-S, **flottes complètes**, vols en cours pour la watchlist |
| Aviationstack | `AVIATIONSTACK_API_KEY` | oui (gratuite) | Source complémentaire (expérimental, HTTP uniquement sur le plan gratuit) |
| OpenSky Network | `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET` | non (recommandée) | Radar en direct et watchlist (la watchlist n'a pas encore de repli) ; un client API OAuth2 augmente fortement le quota anonyme |
| aviationweather.gov | — | non | METAR / TAF des ~15 derniers jours |
| Iowa Environmental Mesonet | — | non | Archive METAR au-delà |
| Planespotters.net | — | non | Photo d'un appareil dans le radar et l'historique d'une cellule, chargée **directement par votre navigateur** (jamais par le serveur), avec le nom du photographe et un lien vers la photo, comme l'exigent ses conditions |
| tar1090-db (Mictronics) | — | non | Base de référence des appareils (~ 10 Mo), téléchargée à la demande depuis GitHub |
| OpenSky Network (base d'appareils) | — | non | Code OACI de l'opérateur de chaque appareil (~ 100 Mo), pour construire les flottes complètes ; fusionnée avec tar1090-db |
| OpenFreeMap | — | non | Fonds de carte vectoriels (MapLibre GL), gratuits et sans limite d'usage annoncée ; choix du style dans Réglages › Apparence |
| ntfy | `NTFY_URL` | non | Notifications push sur téléphone (ex. `https://ntfy.sh/un-sujet-secret`) |
| Webhook | `WEBHOOK_URL` | — | POST JSON `{kind, title, body, link}` vers votre domotique, Gotify, etc. |

Autres variables : `CONTRAIL_PASSWORD` (active l'authentification), `PUBLIC_BASE_URL` (adresse utilisée dans les liens de partage et les notifications), `CONTRAIL_OFFLINE=1` (coupe tout appel sortant), `CONTRAIL_DISABLE_SCHEDULER=1`, `LOG_LEVEL`.

## Accès mobile, HTTPS et PWA

Les navigateurs n'activent le service worker (installation, mode hors-ligne, brouillons, notifications) que sur **`localhost` ou en HTTPS**. Pour l'utiliser depuis un téléphone :

- **Tailscale** : `tailscale serve --bg 8000` expose l'instance en HTTPS sur votre tailnet (`https://<machine>.<tailnet>.ts.net`), sans ouvrir de port.
- **Reverse proxy** (Caddy, Traefik, Nginx Proxy Manager…) avec un certificat Let's Encrypt. Exemple Caddy : `contrail.mondomaine.fr { reverse_proxy localhost:8000 }`.

Si l'instance est exposée sur Internet, **définissez `CONTRAIL_PASSWORD`**. Les pages `/s/<jeton>` des liens de partage restent publiques par conception ; tout le reste (API et médias) exige la connexion.

Une fois servie en HTTPS, utilisez « Ajouter à l'écran d'accueil » : Contrail s'ouvre en plein écran, propose les raccourcis « Nouveau spot » et « Radar », et apparaît dans le menu de partage d'Android pour les photos.

## Session de test

Pour découvrir l'application ou essayer une manipulation sans risque, ouvrez **Réglages › Données › Ouvrir la session de test** (ou le bouton « Essayer avec le jeu de test » sur un accueil vide).

- La session de test utilise une **base totalement séparée**, stockée dans `data/sandbox/`. Vos données réelles ne sont ni lues ni modifiées tant qu'elle est active ; un bandeau le rappelle en haut de chaque page.
- Elle est préremplie avec un **jeu de données fictif sans aucune image** (`app/fixtures/jeu_de_test.json`) : 62 spots répartis sur deux ans et une douzaine d'aéroports, avec étiquettes, livrées spéciales, appareils militaires, données EXIF et METAR décodés ; 14 vols ; 3 points de vue orientés ; deux flottes partielles (Air France, easyJet) ; une watchlist. Les dates sont relatives au jour du chargement, si bien que « Ce jour-là », l'activité du mois et les statistiques restent parlantes.
- **Réinitialiser** efface tout ce qui a été créé dans la session et recharge le jeu d'origine ; **Quitter** vous ramène à vos données.
- La session est mémorisée par navigateur (cookie) : vous pouvez garder vos vraies données sur le téléphone et la session de test sur l'ordinateur. Les brouillons hors-ligne restent attachés à la session dans laquelle ils ont été créés, et les liens de partage créés en session de test (préfixe `t-`) affichent les données de test.
- Le fichier JSON est lisible et modifiable : ajoutez-y vos propres cas puis cliquez sur « Réinitialiser » pour les charger.

## Données, migration et sauvegardes

Tout l'état vit dans **un seul dossier** :

```
data/
├── contrail.db        base SQLite (mode WAL)
├── config.json        clés API saisies depuis l'interface
├── secret.key         clé de signature des sessions
├── images/AAAA/MM/    photos optimisées (WebP)
├── thumbs/            miniatures (WebP)
├── originals/         originaux (si l'option est activée)
├── audio/             enregistrements joints
├── backups/           archives .zip
├── exports/  tmp/
└── sandbox/           session de test (même structure, supprimable sans risque)
```

- **Migration** : arrêtez le conteneur, copiez `data/` sur la nouvelle machine, relancez. C'est tout.
- `data/` est exclu de Git (`.gitignore`) et de l'image Docker (`.dockerignore`).
- **Sauvegardes** : Réglages › Données. Fréquence (6 h à hebdomadaire), nombre d'archives conservées, inclusion des médias. L'archive standard contient la base (instantané cohérent via l'API de sauvegarde SQLite) et la configuration ; l'archive complète ajoute photos et audio.
- **Restauration** : depuis la même page, en téléversant un .zip. L'intégrité de l'archive est vérifiée et une sauvegarde de sécurité de l'état actuel est créée avant remplacement.

## Import et export

**Import de spots** : CSV quelconque (séparateur détecté automatiquement, encodages UTF-8 / Windows-1252). Les colonnes usuelles sont reconnues en français, anglais, espagnol et japonais (*Registration, Reg, Immatriculation, Aircraft, Type, Airline, Operator, Location, Airport, Date, Time, MSN, c/n, Livery, Notes, Tags…*) et la correspondance reste modifiable avant import. Les aéroports peuvent être donnés en code OACI, code IATA, « Nom (LFBO) » ou nom seul. Options : format de date jour/mois ou mois/jour, doublons ignorés, aéroport par défaut, **complément des données via les API en arrière-plan**.

**Import de vols** : compatible avec l'export CSV de **myFlightradar24** (codes de siège, de classe et de motif convertis, codes OACI extraits de « Air France (AF/AFR) » ou « Toulouse / Blagnac (TLS/LFBO) ») et avec les CSV génériques.

**Export** : spots et vols en CSV (UTF-8 avec BOM, lisible par Excel), export JSON intégral de toutes les tables, photos en JPEG avec métadonnées IPTC/XMP (une à une ou en archive .zip, jusqu'à 2 000 par archive).

**Export PDF** : bilan annuel, liste de spots filtrée, fiche d'un spot et carnet de vols, mis en page par le serveur (bibliothèque reportlab, polices Inter et Fraunces embarquées). Le style est personnalisable à chaque export ou par défaut dans Réglages > Données > Exports PDF.

## Architecture technique

- **Backend** : Python 3.12, FastAPI, SQLite (sans ORM, migrations versionnées par `PRAGMA user_version`), Pillow (EXIF, WebP), RapidOCR (onnxruntime), httpx, `airportsdata` (≈ 28 000 aéroports hors-ligne avec fuseaux horaires). Planificateur interne asyncio (sauvegardes, watchlist, rattrapage météo).
- **Frontend** : PWA en JavaScript natif (modules ES), **sans étape de build** ; MapLibre GL JS et un sous-ensemble d'icônes Lucide embarqués localement. Graphiques et carte du soleil en SVG, story en Canvas.
- **API** documentée : `/api/docs` (OpenAPI).

```
app/
  main.py            point d'entrée, middleware d'authentification, fichiers statiques
  core.py db.py      configuration, chemins, connexion SQLite, schéma
  auth.py            authentification facultative (cookie signé)
  routers/           spots, flights, stats (stats, flottes, cellules), field (points de vue, soleil,
                     radar, watchlist), share, io (import/export/sauvegardes), misc
  services/          aircraft, registration, media (EXIF/WebP/OCR), weather (METAR), geo (aéroports,
                     orthodromie, soleil), collection (badges, livrées), gamification, opensky,
                     backup, notify, scheduler
static/
  index.html sw.js manifest.webmanifest
  css/app.css  i18n/{fr,en,es,ja}.json
  js/app.js api.js ui.js i18n.js offline.js lib/ views/
tests/test_api.py    tests de bout en bout de l'API (hors-ligne)
scripts/seed_demo.py données de démonstration
```

## Limites connues et choix de conception

Quelques points du cahier des charges ont été interprétés, ou sont bornés par ce que permettent les API gratuites :

- **MSN stocké en texte** et non en entier : de nombreux numéros de série sont alphanumériques ou comportent des zéros significatifs ; un entier les corromprait.
- **Type de vol** stocké sous forme de code (`commercial`, `test`, `delivery`…) traduit à l'affichage, plutôt qu'en libellé français, pour que l'interface reste multilingue.
- **Images stockées en fichiers WebP** dans `data/images/` (option prévue par le cahier des charges) plutôt qu'en base64 dans la base : base légère, sauvegardes rapides, cache navigateur efficace.
- **Watchlist « vols prévus »** : aucune API gratuite ne fournit de façon fiable l'affectation future d'une immatriculation à un vol programmé. Contrail détecte donc l'appareil **dès qu'il est en vol** (OpenSky) et, avec une clé AirLabs, indique ses aéroports de départ et d'arrivée ; l'alerte signale explicitement s'il se dirige vers l'un de vos aéroports de référence.
- **Couverture des données appareil** : hexdb.io et les plans gratuits d'AirLabs / Aviationstack ne connaissent pas tous les appareils (notamment l'aviation générale et militaire) ; le formulaire reste entièrement modifiable à la main et l'historique local prime toujours.
- **Météo** : le METAR retenu est le plus proche de l'heure du spot dans une fenêtre de ± 2 h ; certaines stations ne sont pas archivées.
- **OCR** : efficace sur une immatriculation bien visible et contrastée (fuselage, dérive) ; la lecture est proposée, jamais imposée.
- **Fond de carte** : cartes vectorielles **MapLibre GL JS** (embarqué localement) avec les styles gratuits et sans clé d'**OpenFreeMap** (Positron, Liberty, Bright, Dark, Fiord), basés sur les données OpenStreetMap. Le mode automatique suit le thème clair/sombre ; OpenStreetMap raster ou n'importe quelle URL de style MapLibre (serveur de tuiles auto-hébergé, par exemple) sont sélectionnables dans Réglages › Apparence. Les tuiles ne sont pas mises en cache par Contrail : sans réseau, les cartes s'affichent sur un fond uni, avec vos marqueurs et trajets.
- **Silhouettes du radar** : le type exact n'est connu que si l'appareil figure dans la base de référence ou dans le cache ; sinon la silhouette est déduite de la catégorie ADS-B transmise (souvent absente), et l'appareil apparaît sous une forme générique.
- **Base de référence** : tar1090-db depuis le dépôt GitHub `wiedehopf/tar1090-db` (branche `csv`) ; base OpenSky : dernière `aircraft-database-complete-AAAA-MM.csv` du compartiment `s3.opensky-network.org/data-samples/metadata/` (repli : `aircraftDatabase.csv`). Si une adresse ou un format change, importez le fichier à la main. Les flottes qui en sont tirées reflètent les déclarations des registres : appareils stockés, en location ou récemment cédés peuvent y figurer ; l'exclusion d'un appareil survit aux mises à jour.
- **Photos Planespotters** : affichées uniquement en ligne, jamais copiées dans vos données ni utilisées dans les images de partage (droits du photographe).
- **Mono-utilisateur** : une instance correspond à un carnet.

## Développement

```bash
pip install -r requirements-dev.txt
make dev     # serveur avec rechargement automatique
make test    # tests de l'API, sans aucun appel réseau
```

Les traductions sont des fichiers JSON plats dans `static/i18n/` ; le français fait référence et sert de repli pour toute clé manquante. Après modification d'un fichier statique, incrémentez `VERSION` dans `static/sw.js` pour forcer la mise à jour du cache des clients.

## Licence et crédits

Distribué sous licence MIT (voir `LICENSE`). Rappel : **aucune garantie, aucune maintenance ni aucun support ne sont assurés** (voir la clause en tête de document).

Cartes © contributeurs [OpenStreetMap](https://www.openstreetmap.org/copyright) · [OpenFreeMap](https://openfreemap.org) · [OpenMapTiles](https://openmaptiles.org) · [MapLibre GL JS](https://maplibre.org) (BSD-3) · icônes [Lucide](https://lucide.dev) (ISC) · polices Inter, JetBrains Mono, Fraunces et Caveat (SIL Open Font License, licences dans `static/vendor/fonts/`) · base d'appareils Mictronics / [tar1090-db](https://github.com/wiedehopf/tar1090-db) · photos [Planespotters.net](https://www.planespotters.net) · [airportsdata](https://github.com/mborsetti/airportsdata) (MIT) · hélistations et terrains [OurAirports](https://ourairports.com) (domaine public) · [RapidOCR](https://github.com/RapidAI/RapidOCR) / PP-OCR (Apache-2.0) · données : hexdb.io, AirLabs, Aviationstack, OpenSky Network, aviationweather.gov (NOAA), Iowa Environmental Mesonet — chacune soumise à ses propres conditions d'utilisation.
