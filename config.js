// Configuration WebRTC — projet volontairement sans STUN/TURN/broker.
//
// Le babyphone ne fonctionne QUE sur réseau local (hotspot Android ou WiFi
// partagé) : aucun serveur externe n'est nécessaire pour établir la
// connexion, donc aucune config ICE n'est fournie.
//
// Pour brancher un serveur STUN/TURN plus tard (ex: si un jour on veut
// pouvoir se connecter à travers deux réseaux différents), remplacer par :
//
// const ICE_CONFIG = {
//   iceServers: [
//     { urls: 'stun:stun.l.google.com:19302' },
//     { urls: 'turn:mon-turn.example.com:3478', username: '...', credential: '...' }
//   ]
// };
//
// Attention : ça réintroduirait une dépendance à Internet à l'exécution,
// ce qui casse l'objectif "zéro Internet en zone blanche" du projet.
const ICE_CONFIG = { iceServers: [] };
