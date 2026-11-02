# ✈ Contrail

**Journal de plane spotting et de vols, auto-hébergé.** Contrail consigne vos observations d'avions et vos vols personnels, les enrichit automatiquement (données appareil, EXIF, météo historique, immatriculation lue sur la photo) et les transforme en statistiques, cartes et succès — sans dépendre d'aucune plateforme tierce payante. Toutes les données restent chez vous, dans un unique dossier `./data`.

> ⚠️ **Clause de maintenance — projet personnel.**
> Ce projet est avant tout développé pour un **usage personnel**. Bien qu'il soit mis à disposition publiquement (open source), **l'auteur ne s'engage à assurer aucune maintenance continue, aucune correction de bugs ni aucun support technique sur le long terme.** Utilisez-le en connaissance de cause, et faites des sauvegardes.

---

## Sommaire

1. [Fonctionnalités](#fonctionnalités)
2. [Installation avec Docker (recommandé)](#installation-avec-docker-recommandé)
3. [Installation sans Docker](#installation-sans-docker)
4. [Configuration des API](#configuration-des-api)
5. [Accès mobile, HTTPS et PWA](#accès-mobile-https-et-pwa)
6. [Données, migration et sauvegardes](#données-migration-et-sauvegardes)
7. [Import et export](#import-et-export)
8. [Architecture technique](#architecture-technique)
9. [Limites connues et choix de conception](#limites-connues-et-choix-de-conception)
10. [Développement](#développement)
11. [Licence et crédits](#licence-et-crédits)

---

## Fonctionnalités

### Spotting
- **Ajout d'un spot** avec remplissage automatique du modèle, du code type OACI, de la compagnie, du MSN et du code Mode-S. Sources interrogées dans l'ordre : vos spots précédents → cache local (30 jours) → **hexdb.io** (sans clé) → **AirLabs** et **Aviationstack** (clés gratuites).
- **OCR local** (Tesseract) : l'immatriculation est lue directement sur la photo, avec plusieurs passes de prétraitement, validation par préfixe de nationalité OACI et classement des candidats (appareils déjà connus et pays de l'aéroport favorisés).
- **Pays d'immatriculation** déduit du préfixe (≈ 200 préfixes, y compris les cas particuliers B-H… Hong Kong, B-1xxxx Taïwan, VP-B Bermudes…), avec drapeau.
- **Étiquettes** multiples et colorées, créées à la volée depuis le formulaire.
- **Audio** joint à l'observation : fichier (mp3, m4a, ogg, wav, webm) **ou enregistrement direct au micro** depuis le terrain.
- **Trois vues** : liste détaillée, galerie, carte (regroupement par aéroport / point de vue).
- **Badges dynamiques** : premier modèle, nouvelle compagnie, nouvel aéroport, revu ×N, avion le plus spotté, livrée spéciale, déjà volé dedans, militaire, nuit, heure dorée (calculée d'après la hauteur du soleil au moment du spot).
- Filtres combinables, tri, recherche plein texte, **sélection multiple** (appui long) et actions groupées, **gestes** : glisser une ligne pour la mettre en favori ou la supprimer, balayer une fiche pour passer au spot suivant.

### Mes vols
- Carnet de vols (date, aéroports, horaires, numéro de vol, compagnie, immatriculation, siège, classe, motif).
- Distance orthodromique et **durée calculées automatiquement** (fuseaux horaires des aéroports pris en compte).
- **Carte des trajets en grand cercle** (gestion de l'antiméridien), tours de la Terre, pourcentage de la distance Terre-Lune.
- **Références croisées** : notification et badge si vous spottez un avion dans lequel vous avez volé, et inversement.

### Collection & flottes
- Liste des compagnies observées et **taux de complétion de flotte** (anneau de progression, détail par type, appareils vus / manquants).
- Flotte récupérée via **AirLabs** ou **importée à la main** (copier-coller depuis un tableur).
- **Traqueur de livrées spéciales** : catégorisation automatique (rétro, alliance, commémorative, logojet, engagée…) à partir du champ « Livrée », dans plusieurs langues.

### Tableau de bord & statistiques
- **Accueil modulable** : 11 widgets activables et réordonnables (glisser-déposer) — photo à la une, raccourcis, derniers spots, « Ce jour-là », activité sur 12 mois, types favoris, succès, watchlist, vols, carte, lumière du jour.
- **Statistiques** par année ou depuis le début : totaux, top 10 des appareils, aéroports, types, compagnies, pays, constructeurs, étiquettes, répartition par mois / heure / jour de la semaine / année, meilleure journée.
- **Statistiques matériel (EXIF)** : combo boîtier + objectif le plus productif, boîtiers, objectifs, focales.
- **Timeline par cellule** : chronologie et carte de toutes les rencontres avec une immatriculation (spots et vols), changements d'opérateur ou de livrée.

### Gamification & partage
- **34 succès** répartis en quatre catégories, avec progression.
- **Générateur de story** : image récapitulative au format story, post 4:5, carré ou paysage, quatre styles, statistiques au choix, photo d'arrière-plan ; téléchargement PNG ou partage natif.
- **Liens publics sécurisés** (jeton aléatoire, expiration facultative, révocables, compteur de vues) pour une galerie filtrée, un spot, une cellule, un vol ou l'ensemble de vos vols. Les notes personnelles et les coordonnées GPS précises ne sont jamais publiées.

### Enrichissement automatique
- **EXIF** : boîtier, objectif, focale (et équivalent 24×36), ouverture, vitesse, ISO, date de prise de vue, GPS → aéroport le plus proche proposé.
- **METAR / TAF historiques** associés à chaque spot, décodés (vent, rafales, visibilité, nuages, température, QNH, catégorie VFR/MVFR/IFR/LIFR). Sources : aviationweather.gov (≈ 15 derniers jours) puis l'archive de l'Iowa Environmental Mesonet pour les dates plus anciennes. Une tâche de fond rattrape les spots créés hors-ligne.

### Outils de terrain
- **Répertoire des points de vue** : position (carte), pistes, accès, **direction de visée** ; la course du soleil est calculée localement pour indiquer les créneaux où le soleil est dans le dos, l'heure dorée, le lever et le coucher, pour n'importe quelle date.
- **Radar en direct** (OpenSky Network) centré sur votre position ou votre aéroport de référence : appareils de la watchlist en rouge, déjà spottés en vert, fiche détaillée (immatriculation, type, route, altitude, vitesse, squawk) et bouton « Spotter » qui pré-remplit le formulaire.
- **Watchlist & alertes** : vérification périodique ; notification quand un appareil suivi est détecté en vol, avec mention spéciale s'il se dirige vers l'un de vos aéroports de référence.

### Mobilité, intégrité, maintenance
- **PWA installable**, fonctionnement **hors-ligne** : la coquille et les données consultées restent accessibles ; les nouveaux spots (photo et audio compris) sont stockés en **brouillons** (IndexedDB) et **synchronisés automatiquement** au retour du réseau, de façon idempotente.
- **Détection des doublons** (même immatriculation, même aéroport, même jour), en direct dans le formulaire et à l'enregistrement.
- **Sauvegardes automatiques** planifiées (.zip de la base et de la configuration, médias en option), rotation, téléchargement en un clic, **restauration** depuis l'interface (avec sauvegarde de sécurité préalable).
- **Import de masse CSV** (JetPhotos, Planespotters, myFlightradar24, OpenFlights, tableur) avec reconnaissance automatique des colonnes, et **export** CSV / JSON complet.

### Interface
- Inspiration **One UI** (grand titre dans la zone de lecture, actions dans la zone du pouce) et **Liquid Glass** (surfaces translucides, flou d'arrière-plan, reflets doux, coins arrondis).
- Mode clair / sombre / automatique, **couleur d'accent** au choix, mobile-first, navigation inférieure sur mobile et barre latérale sur ordinateur.
- **Quatre langues** : français, anglais, espagnol, japonais.
- Fonctions avancées repliées par défaut (volets, menus contextuels), **modules désactivables** (vols, flottes, radar, météo, OCR, points de vue, watchlist, gamification) pour garder une interface épurée.

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

Prérequis : Python 3.11+ et, pour l'OCR, Tesseract (`apt install tesseract-ocr`, `brew install tesseract` ou l'installateur Windows).

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Les données sont écrites dans `./data` (modifiable avec la variable `CONTRAIL_DATA_DIR`). Sans Tesseract, tout fonctionne sauf la lecture automatique de l'immatriculation.

Pour découvrir l'interface avec des données fictives : `python scripts/seed_demo.py --url http://localhost:8000` sur une instance vide.

## Configuration des API

Toutes les intégrations sont **facultatives** et **gratuites**. Les clés se saisissent soit dans **Réglages › Intégrations**, soit dans `.env` (les variables d'environnement priment et apparaissent alors en lecture seule dans l'interface).

| Service | Variable(s) | Clé ? | Usage |
|---|---|---|---|
| hexdb.io | — | non | Immatriculation ↔ Mode-S, type, propriétaire, routes par indicatif |
| AirLabs | `AIRLABS_API_KEY` | oui (gratuite) | MSN, Mode-S, **flottes complètes**, vols en cours pour la watchlist |
| Aviationstack | `AVIATIONSTACK_API_KEY` | oui (gratuite) | Source complémentaire (expérimental, HTTP uniquement sur le plan gratuit) |
| OpenSky Network | `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET` | non (recommandée) | Radar en direct et watchlist ; un client API OAuth2 augmente fortement le quota anonyme |
| aviationweather.gov | — | non | METAR / TAF des ~15 derniers jours |
| Iowa Environmental Mesonet | — | non | Archive METAR au-delà |
| OpenStreetMap | — | non | Fonds de carte (Leaflet) |
| ntfy | `NTFY_URL` | non | Notifications push sur téléphone (ex. `https://ntfy.sh/un-sujet-secret`) |
| Webhook | `WEBHOOK_URL` | — | POST JSON `{kind, title, body, link}` vers votre domotique, Gotify, etc. |

Autres variables : `CONTRAIL_PASSWORD` (active l'authentification), `PUBLIC_BASE_URL` (adresse utilisée dans les liens de partage et les notifications), `CONTRAIL_OFFLINE=1` (coupe tout appel sortant), `CONTRAIL_DISABLE_SCHEDULER=1`, `LOG_LEVEL`.

## Accès mobile, HTTPS et PWA

Les navigateurs n'activent le service worker (installation, mode hors-ligne, brouillons, notifications) que sur **`localhost` ou en HTTPS**. Pour l'utiliser depuis un téléphone :

- **Tailscale** : `tailscale serve --bg 8000` expose l'instance en HTTPS sur votre tailnet (`https://<machine>.<tailnet>.ts.net`), sans ouvrir de port.
- **Reverse proxy** (Caddy, Traefik, Nginx Proxy Manager…) avec un certificat Let's Encrypt. Exemple Caddy : `contrail.mondomaine.fr { reverse_proxy localhost:8000 }`.

Si l'instance est exposée sur Internet, **définissez `CONTRAIL_PASSWORD`**. Les pages `/s/<jeton>` des liens de partage restent publiques par conception ; tout le reste (API et médias) exige la connexion.

Une fois servie en HTTPS, utilisez « Ajouter à l'écran d'accueil » : Contrail s'ouvre en plein écran, propose les raccourcis « Nouveau spot » et « Radar », et apparaît dans le menu de partage d'Android pour les photos.

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
```

- **Migration** : arrêtez le conteneur, copiez `data/` sur la nouvelle machine, relancez. C'est tout.
- `data/` est exclu de Git (`.gitignore`) et de l'image Docker (`.dockerignore`).
- **Sauvegardes** : Réglages › Données. Fréquence (6 h à hebdomadaire), nombre d'archives conservées, inclusion des médias. L'archive standard contient la base (instantané cohérent via l'API de sauvegarde SQLite) et la configuration ; l'archive complète ajoute photos et audio.
- **Restauration** : depuis la même page, en téléversant un .zip. L'intégrité de l'archive est vérifiée et une sauvegarde de sécurité de l'état actuel est créée avant remplacement.

## Import et export

**Import de spots** : CSV quelconque (séparateur détecté automatiquement, encodages UTF-8 / Windows-1252). Les colonnes usuelles sont reconnues en français, anglais, espagnol et japonais (*Registration, Reg, Immatriculation, Aircraft, Type, Airline, Operator, Location, Airport, Date, Time, MSN, c/n, Livery, Notes, Tags…*) et la correspondance reste modifiable avant import. Les aéroports peuvent être donnés en code OACI, code IATA, « Nom (LFBO) » ou nom seul. Options : format de date jour/mois ou mois/jour, doublons ignorés, aéroport par défaut, **complément des données via les API en arrière-plan**.

**Import de vols** : compatible avec l'export CSV de **myFlightradar24** (codes de siège, de classe et de motif convertis, codes OACI extraits de « Air France (AF/AFR) » ou « Toulouse / Blagnac (TLS/LFBO) ») et avec les CSV génériques.

**Export** : spots et vols en CSV (UTF-8 avec BOM, lisible par Excel), export JSON intégral de toutes les tables.

## Architecture technique

- **Backend** : Python 3.12, FastAPI, SQLite (sans ORM, migrations versionnées par `PRAGMA user_version`), Pillow (EXIF, WebP), pytesseract, httpx, `airportsdata` (≈ 28 000 aéroports hors-ligne avec fuseaux horaires). Planificateur interne asyncio (sauvegardes, watchlist, rattrapage météo).
- **Frontend** : PWA en JavaScript natif (modules ES), **sans étape de build** ; Leaflet et un sous-ensemble d'icônes Lucide embarqués localement pour le hors-ligne. Graphiques et carte du soleil en SVG, story en Canvas.
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
- **Fond de carte** : les tuiles OpenStreetMap ne sont pas toutes disponibles hors-ligne (seules les tuiles déjà consultées sont mises en cache, dans la limite de 1 500).
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

Cartes © contributeurs [OpenStreetMap](https://www.openstreetmap.org/copyright) · [Leaflet](https://leafletjs.com) (BSD-2) · icônes [Lucide](https://lucide.dev) (ISC) · [airportsdata](https://github.com/mborsetti/airportsdata) (MIT) · [Tesseract OCR](https://github.com/tesseract-ocr/tesseract) (Apache-2.0) · données : hexdb.io, AirLabs, Aviationstack, OpenSky Network, aviationweather.gov (NOAA), Iowa Environmental Mesonet — chacune soumise à ses propres conditions d'utilisation.
