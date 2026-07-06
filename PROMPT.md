# Prompt Claude Code — Babyphone PWA (local-first, zéro serveur)

> Contexte utilisateur : médecin, pas développeur. Tout expliquer pas à pas,
> ne rien supposer d'installé, donner chaque commande à copier-coller.

---

## Objectif

PWA (web-app installable) qui transforme deux téléphones Android en babyphone :
un tél « bébé » (émetteur caméra + micro) et un tél « parent » (récepteur).
Distribution : une URL GitHub Pages. **Doit fonctionner sans aucun accès
Internet à l'exécution** (zones blanches fréquentes) : Internet ne sert qu'à
installer/mettre à jour l'app.

## Architecture imposée

- **HTML/CSS/JS vanilla**, pas de framework, pas de build step (fichiers
  statiques servis tels quels par GitHub Pages).
- **WebRTC en réseau local uniquement.** Cas nominal : le tél bébé crée un
  point d'accès (hotspot Android), le tél parent s'y connecte. Fonctionne
  aussi si les deux téléphones sont sur le même WiFi.
- **Signaling sans serveur : échange SDP par double QR.**
  1. Tél bébé : génère l'offre WebRTC, attend la fin de la collecte ICE
     (**non-trickle**, timeout 3 s), affiche l'offre en QR.
  2. Tél parent : scanne ce QR, génère la réponse, l'affiche en QR.
  3. Tél bébé : scanne la réponse → connexion établie.
  - SDP compressé/minifié pour tenir dans un QR lisible (pako ou
    reconstruction minimale du SDP — au choix, mais tester la lisibilité du
    QR à taille d'écran réelle).
- **Aucun STUN, aucun TURN, aucun broker** (PeerJS supprimé). Config ICE =
  constante unique vide en haut du code, avec commentaire expliquant comment
  brancher STUN/TURN plus tard si besoin.
- **Service worker** : cache complet de l'app dès la première visite →
  fonctionnement 100 % hors ligne ensuite. Stratégie de mise à jour explicite
  (version dans le SW, bannière « nouvelle version disponible » quand il y a
  du réseau) pour éviter les caches périmés silencieux.
- Librairies : `qrcode` (génération) + `jsQR` (scan, pas `BarcodeDetector`).
  Vendorées localement (pas de CDN à l'exécution — hors ligne oblige).

## Fonctions v1

1. **Accueil** : deux gros boutons « Mode Bébé » / « Mode Parent » + rappel
   court de la procédure hotspot.
2. **Mode Bébé** :
   - Caméra (arrière par défaut, bascule avant/arrière) + micro via
     `getUserMedia`.
   - Appairage double QR (ci-dessus).
   - **Wake Lock** (Screen Wake Lock API) — écran jamais éteint.
   - Voile noir après 10 s (tap pour réveiller) : écran assombri, flux
     maintenu.
   - **Détection de bruit** : Web Audio API / AnalyserNode, seuil réglable
     par curseur, indicateur local + signal envoyé au parent via datachannel.
   - **Heartbeat** : ping datachannel vers le parent toutes les 2 s.
3. **Mode Parent** :
   - Scan du QR bébé, affichage du QR réponse.
   - Flux vidéo + audio en direct. Bouton mute.
   - **Mode audio seul** (coupe la piste vidéo, écran quasi noir) — c'est le
     mode d'écoute longue par défaut après 30 s sans interaction.
   - **Alerte bruit** : vibration (API Vibration) + flash visuel quand le
     bébé signale un dépassement.
   - **Alarme de déconnexion — point critique de sûreté** : si aucun
     heartbeat depuis 10 s → **alarme sonore forte** (oscillateur Web Audio,
     pas un mp3) + affichage plein écran rouge. Un babyphone qui se coupe en
     silence est pire que pas de babyphone. Tentative de reconnexion auto en
     parallèle (ICE restart si possible, sinon guider vers un ré-appairage).
   - Indicateur d'état permanent : connecté / reconnexion / perdu.
4. **Qualité vidéo** : 320p par défaut (constraints getUserMedia), bascule
   480p. Priorité à la stabilité sur des heures, pas à la définition.

## Limites assumées (à documenter dans le README et dans l'app)

- **Les deux écrans restent allumés** (pas de fonctionnement en arrière-plan
  dans un navigateur). Tél bébé branché sur secteur obligatoire.
- Portée = portée WiFi du hotspot (même bâtiment).
- Le hotspot doit être créé côté Android (OK ici, les deux tél le sont).
- Premier chargement de l'app : Internet requis une fois par téléphone.

## Livrables

1. Arborescence + code commenté de chaque fichier.
2. **Guide déploiement GitHub Pages pas à pas** pour non-développeur :
   création du compte GitHub, création du repo, upload des fichiers **via
   l'interface web** (pas de git en ligne de commande), activation de Pages,
   récupération de l'URL. Prévoir aussi la procédure de mise à jour.
3. **Guide utilisateur** (dans le README + page d'aide dans l'app) :
   - Côté bébé : activer le hotspot (chemin Android), brancher sur secteur,
     lancer le mode bébé.
   - Côté parent : se connecter au hotspot (accepter « ce réseau n'a pas
     accès à Internet »), lancer le mode parent, scanner.
   - Guide amis = envoyer l'URL + « Ajouter à l'écran d'accueil ».
4. `README.md` : récap, limites, TODO v2.

## Workflow de test (important)

`getUserMedia` exige HTTPS : **pas de test caméra en local via `file://`**.
Deux options à mettre en place dès le début :
- Serveur de dev local (`npx serve` ou équivalent) + test navigateur PC pour
  la logique/UI (le PC a une webcam) ;
- Déploiement GitHub Pages très tôt, test réel sur les deux téléphones à
  chaque étape clé. **Tester l'appairage double QR sur téléphones réels dès
  qu'il est codé** — c'est le point dur du projet (vérifier notamment que
  les candidats ICE locaux sont bien des IP réelles et pas des noms mDNS
  irrésolus ; la permission caméra accordée doit exposer les vraies IP).

## TODO v2 (préparer l'isolation du code, ne pas implémenter)

- Appairage « confort » via broker PeerJS quand Internet dispo (1 scan au
  lieu de 2) — d'où l'isolation de la couche signaling.
- Réglage de sensibilité mémorisé (localStorage).
- Historique des alertes bruit avec horodatage.
- **Écrans éteints** : dès la v1 stable, tester sur les deux téléphones réels
  (a) parent écran verrouillé → l'audio WebRTC et l'alarme continuent-ils ?
  (b) bébé en mode audio seul écran verrouillé → la capture micro
  continue-t-elle ? (Chrome le permet en principe ; les surcouches
  constructeur peuvent tuer l'app — documenter le réglage « exclure Chrome
  de l'optimisation batterie » si besoin.) La vidéo écran éteint est
  impossible en PWA (foreground service natif requis) : seul cas qui
  justifierait un emballage Capacitor ultérieur, en réutilisant ce code.

## Critère de succès v1

Deux Android, **mode avion + hotspot** (zéro Internet) : le parent voit et
entend le bébé, reçoit l'alerte bruit, et si on coupe le hotspot le tél
parent sonne fort en moins de 15 s. Connexion stable plusieurs heures, tél
bébé sur secteur.
