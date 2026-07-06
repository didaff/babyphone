// Appairage WebRTC : création de la connexion, restriction des codecs (pour
// réduire la taille du SDP transporté en QR), collecte ICE non-trickle et
// canal de données (heartbeat + alerte bruit).
//
// Dépend de ICE_CONFIG (config.js). Ne dépend PAS de qr-transport.js : ce
// module manipule des RTCSessionDescription, pas des QR — séparation
// volontaire pour préparer le TODO v2 (signaling alternatif via PeerJS).
const WebrtcPairing = (() => {
  function createPeerConnection() {
    return new RTCPeerConnection(ICE_CONFIG);
  }

  // Restreint chaque transceiver à un seul codec (pas de rtx/red/fec) pour
  // minimiser la taille du SDP. Compromis assumé : un peu moins de résilience
  // à la perte de paquets, en échange d'un SDP qui tient dans un QR lisible.
  // Voir TODO v2 dans README.md.
  function restrictCodecs(pc) {
    const preferred = { audio: 'audio/opus', video: 'video/VP8' };
    pc.getTransceivers().forEach((tr) => {
      // receiver.track.kind existe toujours (même sans piste locale envoyée,
      // ex: côté parent qui ne fait que recevoir) ; sender.track peut être null.
      const kind = tr.receiver && tr.receiver.track && tr.receiver.track.kind;
      const mime = preferred[kind];
      if (!mime || typeof tr.setCodecPreferences !== 'function') return;
      try {
        const caps = RTCRtpReceiver.getCapabilities(kind);
        if (!caps) return;
        const codecs = caps.codecs.filter((c) => c.mimeType === mime);
        if (codecs.length) tr.setCodecPreferences(codecs);
      } catch (e) {
        // Non bloquant : au pire le SDP est un peu plus gros.
        console.warn('restrictCodecs', kind, e);
      }
    });
  }

  // Attend la fin de la collecte ICE (non-trickle), avec timeout de secours :
  // au-delà de timeoutMs on part avec les candidats déjà récoltés plutôt que
  // de bloquer indéfiniment (réseau capricieux, hotspot lent à répondre).
  function waitIceGatheringComplete(pc, timeoutMs = 3000) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      };
      const onChange = () => { if (pc.iceGatheringState === 'complete') finish(); };
      pc.addEventListener('icegatheringstatechange', onChange);
      setTimeout(finish, timeoutMs);
    });
  }

  // Côté bébé : crée le canal de données + l'offre, attend la collecte ICE,
  // renvoie la description locale complète (candidats inclus).
  async function createOfferNonTrickle(pc, { iceTimeoutMs = 3000 } = {}) {
    const dc = pc.createDataChannel('control', { ordered: true });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIceGatheringComplete(pc, iceTimeoutMs);
    return { localDescription: pc.localDescription, dataChannel: dc };
  }

  // Côté parent : applique l'offre reçue, crée la réponse, attend la
  // collecte ICE, renvoie la description locale complète.
  async function createAnswerNonTrickle(pc, remoteOffer, { iceTimeoutMs = 3000 } = {}) {
    await pc.setRemoteDescription(remoteOffer);
    restrictCodecs(pc); // les transceivers viennent d'être créés depuis l'offre distante
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIceGatheringComplete(pc, iceTimeoutMs);
    return pc.localDescription;
  }

  // Côté bébé : applique la réponse scannée pour finaliser la connexion.
  async function applyRemoteAnswer(pc, remoteAnswer) {
    await pc.setRemoteDescription(remoteAnswer);
  }

  // Surveille le heartbeat reçu sur le datachannel. Si aucun heartbeat depuis
  // > timeoutMs, appelle onLost() (une seule fois par perte). Se réarme dès
  // qu'un heartbeat revient.
  function createHeartbeatWatchdog({ timeoutMs = 10000, onLost, onRecovered }) {
    let timer = null;
    let lost = false;

    function arm() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!lost) {
          lost = true;
          onLost && onLost();
        }
      }, timeoutMs);
    }

    function beat() {
      if (lost) {
        lost = false;
        onRecovered && onRecovered();
      }
      arm();
    }

    function stop() {
      clearTimeout(timer);
    }

    return { beat, stop };
  }

  return {
    createPeerConnection,
    restrictCodecs,
    waitIceGatheringComplete,
    createOfferNonTrickle,
    createAnswerNonTrickle,
    applyRemoteAnswer,
    createHeartbeatWatchdog
  };
})();
