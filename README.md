# Babyphone — PWA locale, sans Internet ni serveur

Transforme deux téléphones Android en babyphone : un téléphone **bébé**
(caméra + micro) et un téléphone **parent** (écran + son). Aucune donnée ne
transite par un serveur : la connexion se fait directement entre les deux
téléphones sur le même réseau (hotspot Android ou WiFi), et l'appairage se
fait en scannant deux QR codes l'un après l'autre. Internet n'est utile que
pour installer/mettre à jour l'app — **jamais pour l'utiliser**.

## Arborescence

```
Babyphone/
├── index.html          Accueil (2 boutons Mode Bébé / Mode Parent)
├── bebe.html            Mode Bébé
├── parent.html          Mode Parent
├── aide.html            Page d'aide (procédure hotspot, guide utilisateur)
├── manifest.json         Manifeste PWA (icône, nom, couleur)
├── sw.js                 Service worker (cache offline + mises à jour)
├── css/
│   └── style.css         Feuille de style commune
├── js/
│   ├── config.js          Config ICE (vide volontairement, voir plus bas)
│   ├── qr-transport.js    Compaction SDP + génération/scan de QR
│   ├── webrtc-pairing.js  Connexion WebRTC, codecs, ICE non-trickle, heartbeat
│   ├── app.js             Enregistrement du service worker + bannière MàJ
│   ├── bebe.js             Logique Mode Bébé
│   └── parent.js           Logique Mode Parent
├── vendor/                Librairies vendorées (pas de CDN à l'exécution)
│   ├── qrcode.min.js       Génération de QR (davidshimjs/qrcode, build 1.5.1)
│   ├── jsQR.js             Scan de QR depuis la caméra (jsQR 1.4.0, minifié)
│   └── pako.min.js         Compression deflate du SDP avant encodage QR
└── icons/                 Icônes PWA (192, 512, 512 maskable)
```

Zéro framework, zéro étape de build : ce sont des fichiers statiques servis
tels quels par GitHub Pages.

## Comment ça marche (résumé technique)

1. **Bébé** génère une offre WebRTC (`RTCPeerConnection.createOffer`),
   attend la fin de la collecte des candidats ICE (**non-trickle**, avec un
   filet de sécurité de 3 s pour ne pas bloquer indéfiniment), puis affiche
   cette offre compressée en QR.
2. **Parent** scanne ce QR, génère la réponse, l'affiche à son tour en QR.
3. **Bébé** scanne la réponse (avec sa propre caméra, celle-là même qui
   filme déjà le bébé) → la connexion WebRTC s'établit directement entre
   les deux téléphones.
4. Un `RTCDataChannel` sert de canal de contrôle : heartbeat toutes les 2 s
   (bébé → parent) et signal de bruit détecté.

**Aucun serveur STUN/TURN, aucun broker** (config ICE = liste vide dans
`js/config.js`) : le projet part du principe que les deux téléphones sont
sur le même réseau local (hotspot ou WiFi), donc seuls des candidats ICE
"host" (IP locales) sont nécessaires.

Le SDP brut d'une offre WebRTC est bien trop volumineux pour un QR lisible.
Deux réductions sont appliquées avant l'encodage :
- restriction à **un seul codec par flux** (Opus pour l'audio, VP8 pour la
  vidéo) via `setCodecPreferences`, qui élimine tout le "bruit" de codecs
  non utilisés dans le SDP ;
- **compression deflate** (pako) du JSON `{type, sdp}`, encodé en octets
  bruts dans le QR (mode "byte", pas de base64) pour maximiser la densité
  de données par QR.

## Déploiement sur GitHub Pages (sans ligne de commande)

### A. Créer un compte GitHub (si vous n'en avez pas)

1. Allez sur `github.com` → « Sign up » → suivez les étapes (email, mot de
   passe, nom d'utilisateur).

### B. Créer le dépôt (repo)

1. Une fois connecté, cliquez sur le **+** en haut à droite → **New
   repository**.
2. Nom du repo : par exemple `babyphone`. Laissez-le **Public** (nécessaire
   pour GitHub Pages gratuit). Ne cochez aucune case d'initialisation
   (pas de README, pas de .gitignore — on va tout envoyer nous-mêmes).
3. Cliquez **Create repository**.

### C. Envoyer les fichiers (upload via l'interface web)

1. Sur la page du repo fraîchement créé, cliquez sur **uploading an
   existing file** (ou **Add file → Upload files** si le lien n'apparaît
   pas).
2. **Glissez-déposez tout le contenu du dossier `Babyphone/`** (pas le
   dossier lui-même, son contenu : `index.html`, `bebe.html`, `css/`,
   `js/`, `vendor/`, `icons/`, etc.) dans la zone d'upload. Le
   glisser-déposer d'un dossier entier fonctionne dans l'interface GitHub :
   les sous-dossiers (`css/`, `js/`, `vendor/`, `icons/`) doivent apparaître
   dans la liste des fichiers à envoyer.
3. En bas de page, ajoutez un message de commit (ex : "Première version")
   puis cliquez **Commit changes**.

### D. Activer GitHub Pages

1. Dans le repo, onglet **Settings** (Paramètres) → menu de gauche
   **Pages**.
2. Sous **Build and deployment → Source**, choisissez **Deploy from a
   branch**.
3. **Branch** : choisissez `main` et le dossier `/ (root)` → **Save**.
4. Patientez 1-2 minutes. Rechargez la page Settings → Pages : une bannière
   verte indique l'URL publique, du type :
   `https://<votre-nom-utilisateur>.github.io/babyphone/`

C'est cette URL qu'il faut envoyer aux téléphones bébé et parent (et aux
amis qui veulent l'installer).

### E. Mettre à jour l'app plus tard

1. Retournez dans le repo GitHub, ouvrez le fichier modifié (ou utilisez à
   nouveau **Add file → Upload files** pour remplacer des fichiers).
2. **Important** : ouvrez `sw.js`, modifiez la ligne
   `const SW_VERSION = 'v1';` en `'v2'` (puis `'v3'`, etc. à chaque mise à
   jour) et validez (Commit changes). Sans ce changement, les téléphones
   qui ont déjà l'app en cache ne verront jamais la mise à jour.
3. Quand un téléphone rouvre l'app avec une connexion Internet, une
   bannière **« Nouvelle version disponible »** apparaît en bas d'écran ;
   un appui sur **Mettre à jour** recharge l'app avec la nouvelle version.

## Guide utilisateur

Voir la page **Aide** dans l'app (`aide.html`, accessible depuis
l'accueil) pour la procédure pas à pas : activation du hotspot côté bébé,
connexion du parent, lancement des deux modes, envoi de l'app à un ami.

Résumé :
- **Bébé** : activer le point d'accès WiFi (hotspot) Android, brancher le
  téléphone sur secteur, lancer « Mode Bébé ».
- **Parent** : se connecter à ce hotspot (accepter « pas d'accès à
  Internet »), lancer « Mode Parent », scanner le QR.
- **Envoyer à un ami** : partager l'URL GitHub Pages + « Ajouter à l'écran
  d'accueil ».

## Limites assumées

- **Les deux écrans restent allumés** en permanence : un navigateur ne peut
  pas maintenir caméra/micro/connexion actifs en arrière-plan. Le téléphone
  bébé doit rester **branché sur secteur**.
- Portée = portée WiFi du hotspot (un même bâtiment/appartement).
- Le hotspot doit être créé côté Android (testé sur ce projet).
- Premier chargement de l'app : Internet requis une seule fois par
  téléphone (installation), puis plus jamais.
- Un seul codec par flux (Opus/VP8, pas de retransmission RTX) pour tenir
  dans un QR : compromis assumé au profit de la robustesse de l'appairage
  plutôt que de la résilience fine à la perte de paquets.
- Pas de multi-QR / QR animé : si le SDP dépasse la capacité d'un QR
  lisible (rare, mais peut arriver avec beaucoup de candidats ICE sur un
  réseau avec plusieurs interfaces actives), l'app affiche une erreur
  explicite plutôt qu'un échec silencieux.

## Point dur du projet — à tester en tout premier sur téléphones réels

L'appairage double QR dépend de candidats ICE **locaux réels** (IP de type
`192.168.x.x`), pas de noms mDNS (`xxxxxxxx.local`) non résolus. Chrome
Android peut masquer les IP locales derrière un nom mDNS par défaut ; la
permission caméra/micro déjà accordée doit normalement débloquer les vraies
IP. **Tester la connexion en mode avion + hotspot dès que l'appairage QR
est fonctionnel**, avant de construire dessus.

## TODO v2 (non implémenté, architecture préparée pour)

- **Appairage "confort"** via un broker PeerJS quand Internet est
  disponible (1 seul scan au lieu de 2). `js/qr-transport.js` et
  `js/webrtc-pairing.js` sont volontairement séparés du reste pour pouvoir
  ajouter une implémentation alternative du signaling sans toucher au
  reste de l'app.
- Réglage de sensibilité du bruit mémorisé (`localStorage`).
- Historique des alertes bruit avec horodatage.

## Critère de succès v1

Deux Android, **mode avion + hotspot** (zéro Internet) : le parent voit et
entend le bébé, reçoit l'alerte bruit, et si on coupe le hotspot le
téléphone parent sonne fort en moins de 15 s. Connexion stable plusieurs
heures, téléphone bébé sur secteur.
