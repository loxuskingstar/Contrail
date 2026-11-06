# Contrail en application de bureau (sans Docker)

Contrail s'installe comme n'importe quel logiciel : on télécharge le fichier de son système, on l'ouvre, on suit l'assistant.
Aucune ligne de commande, aucun Python, aucun Docker. Tout est dans l'installeur, qui fonctionne donc **sans Internet**.

| Système | Fichier | Installation |
|---|---|---|
| **Windows** 10/11 | `Contrail-X.Y.Z-Windows-Setup.exe` | Double-clic → l'assistant demande **le dossier d'installation**, propose un **raccourci sur le Bureau** (et le démarrage avec Windows) |
| **macOS** 11+ | `Contrail-X.Y.Z-macOS-arm64.dmg` (Apple Silicon) ou `…-x86_64.dmg` (Intel) | Ouvrir le .dmg → glisser **Contrail** sur **Applications** |
| **Debian / Ubuntu / Mint** | `Contrail-X.Y.Z-Linux-amd64.deb` | Double-clic (gestionnaire de logiciels) ou `sudo apt install ./Contrail-….deb` |
| **Autres Linux** | `Contrail-X.Y.Z-Linux-x86_64.tar.gz` | Extraire, double-cliquer sur `install.sh` (ou `./install.sh`) : il demande **le dossier** et le **raccourci Bureau** ; pas besoin d'être root |

## Premier lancement
Contrail démarre, ouvre votre navigateur sur `http://localhost:8765` et laisse une icône dans la zone de notification
(Windows : à côté de l'horloge · macOS : barre de menus). Clic droit sur l'icône : *Ouvrir*, *Ouvrir le dossier de données*, *Quitter*.
Relancer Contrail alors qu'il tourne déjà ne fait qu'ouvrir le navigateur.

Les installeurs ne sont pas signés (une signature de code est payante) : le système affiche donc un avertissement la première fois.
- **Windows SmartScreen** : « Informations complémentaires » → « Exécuter quand même ».
- **macOS** : clic droit sur Contrail dans Applications → « Ouvrir » → « Ouvrir » (une seule fois).
- Certains antivirus signalent à tort les applications Python empaquetées : ajoutez le dossier d'installation aux exceptions si besoin.

## Où sont mes données ?
Dans le dossier de données de l'utilisateur, **séparé du programme** : mettre à jour (réinstaller par-dessus) ou désinstaller ne les supprime pas
(la désinstallation demande explicitement si vous voulez aussi les effacer).

| Système | Dossier |
|---|---|
| Windows | `%APPDATA%\Contrail` |
| macOS | `~/Library/Application Support/Contrail` |
| Linux | `~/.local/share/contrail` |

Pour migrer depuis une instance Docker : *Réglages → Sauvegardes* (export zip), puis restaurer dans la nouvelle installation.

## Utiliser Contrail depuis le téléphone
Par défaut, seul l'ordinateur y accède. Lancez le raccourci **« Contrail (accès depuis le téléphone) »** (menu Démarrer / menu des applications),
ou `Contrail --lan` : l'adresse réseau s'affiche dans le menu de l'icône (`http://192.168.x.x:8765`). Téléphone et ordinateur doivent être sur le même Wi-Fi ;
Windows demandera d'autoriser Contrail dans le pare-feu. À n'utiliser que sur un réseau de confiance (domicile) : sans mot de passe, toute personne du réseau peut ouvrir Contrail.

## Sans installeur : lanceur depuis les sources, y compris hors ligne
Si vous préférez ne pas utiliser l'installeur (ou si votre système n'est pas couvert), `python desktop/launcher.py` (Windows : `py desktop\launcher.py`) lance Contrail depuis les sources. La procédure complète, avec la préparation des paquets pour une machine sans Internet (`pip download … -d wheels` puis `pip install --no-index --find-links wheels …`) en syntaxe Linux, macOS et Windows, est dans le [README principal](../README.md#installation-sans-docker).

## Limites par rapport à la version Docker
- Une instance par ordinateur : pour un accès permanent depuis plusieurs appareils, un petit serveur / NAS avec Docker reste préférable.
- La lecture automatique des immatriculations sur photo (OCR) demande Tesseract, non fourni ; le reste fonctionne sans.
- L'ordinateur doit être allumé et Contrail lancé pour y accéder depuis le téléphone.

## Pour les développeurs : construire les installeurs
Les installeurs Windows et macOS ne se construisent que sur leur système : le workflow GitHub Actions
`.github/workflows/desktop.yml` construit les quatre (Windows, macOS Apple Silicon, macOS Intel, Linux) à chaque tag `vX.Y.Z`
ou à la demande, les teste (démarrage de l'application figée) et publie une Release.

En local (exemple Linux) :
```bash
pip install -r requirements.txt pyinstaller pystray
pyinstaller --noconfirm desktop/contrail.spec        # → dist/Contrail
bash desktop/linux/build_linux.sh 2.2.0              # → .deb et .tar.gz
python desktop/launcher.py --no-tray                 # lancer depuis les sources
```
Sous Windows : `iscc /DAppVersion=2.2.0 /DSourceDir=%CD%\dist\Contrail desktop\windows\contrail.iss` (Inno Setup 6).
Sous macOS : `bash desktop/macos/build_dmg.sh 2.2.0`.
