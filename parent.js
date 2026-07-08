// Logique du Mode Parent : appairage QR (scan offre → réponse), flux
// vidéo/audio, mute, mode audio seul, alerte bruit, et surtout l'alarme de
// déconnexion (point critique de sûreté du projet).
(() => {
  const els = {
    statusBadge: document.getElementById('status-badge'),
    statusText: document.getElementById('status-text'),
    pairingSection: document.getElementById('pairing-section'),
    pairingHint: document.getElementById('pairing-hint'),
    scanWrap: document.getElementById('scan-wrap'),
    scanVideo: document.getElementById('scan-video'),
    btnPhotoOffer: document.getElementById('btn-photo-offer'),
    fileOffer: document.getElementById('file-offer'),
    qrAnswer: document.getElementById('qr-answer'),
    btnRestartPairing: document.getElementById('btn-restart-pairing'),
    liveSection: document.getElementById('live-section'),
    videoWrap: document.getElementById('video-wrap'),
    remoteVideo: document.getElementById('remote-video'),
    btnMute: document.getElementById('btn-mute'),
    btnAudioOnly: document.getElementById('btn-audio-only'),
    flashNoise: document.getElementById('flash-noise'),
    alarm: document.getElementById('alarm'),
    alarmDetail: document.getElementById('alarm-detail'),
    btnAlarmStop: document.getElementById('btn-alarm-stop'),
    btnAlarmRepair: document.getElementById('btn-alarm-repair')
  };

  let pc = null;
  let scanAbort = null;
  let remoteStream = null;
  let remoteVideoTrack = null;
  let audioOnly = false;
  let muted = false;
  let alarmActive = false;
  let audioCtx = null;
  let sirenNodes = null;
  let idleTimer = null;

  function setStatus(kind, text) {
    els.statusBadge.classList.remove('ok', 'warn', 'danger');
    if (kind) els.statusBadge.classList.add(kind);
    els.statusText.textContent = text;
  }

  // --- Watchdog heartbeat : coeur de l'alarme de déconnexion --------------

  const watchdog = WebrtcPairing.createHeartbeatWatchdog({
    timeoutMs: 10000,
    onLost: triggerAlarm,
    onRecovered: clearAlarm
  });

  function triggerAlarm() {
    alarmActive = true;
    els.alarm.classList.add('active');
    els.alarmDetail.textContent = 'Dernier contact avec le téléphone bébé il y a plus de 10 s.';
    setStatus('danger', 'Connexion perdue');
    startSiren();
    if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 500]);
    // Tentative de reconnexion auto en parallèle : ICE restart si la
    // connexion existe encore techniquement. Si le transport est vraiment
    // mort, ceci ne fait rien de plus et l'utilisateur doit ré-appairer
    // (bouton ci-dessous) — un babyphone qui se tait est pire que rien,
    // donc l'alarme reste visible/sonore jusqu'à action explicite ou retour
    // effectif du heartbeat.
    if (pc) { try { pc.restartIce(); } catch (e) { /* ignore */ } }
  }

  function clearAlarm() {
    alarmActive = false;
    els.alarm.classList.remove('active');
    stopSiren();
    setStatus('ok', 'Connecté');
  }

  function startSiren() {
    if (sirenNodes) return;
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    gain.gain.value = 0.6;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    let high = true;
    const sweep = setInterval(() => {
      osc.frequency.setValueAtTime(high ? 1200 : 700, audioCtx.currentTime);
      high = !high;
    }, 350);
    sirenNodes = { osc, gain, sweep };
  }

  function stopSiren() {
    if (!sirenNodes) return;
    clearInterval(sirenNodes.sweep);
    try { sirenNodes.osc.stop(); } catch (e) {}
    sirenNodes.osc.disconnect();
    sirenNodes.gain.disconnect();
    sirenNodes = null;
  }

  els.btnAlarmStop.addEventListener('click', () => stopSiren());
  els.btnAlarmRepair.addEventListener('click', () => {
    stopSiren();
    els.alarm.classList.remove('active');
    alarmActive = false;
    restartPairing();
  });

  // --- Appairage ---------------------------------------------------------

  async function startPairing() {
    els.btnRestartPairing.style.display = 'none';
    els.liveSection.style.display = 'none';
    els.pairingSection.style.display = '';
    els.qrAnswer.style.display = 'none';
    els.scanWrap.style.display = '';
    els.btnPhotoOffer.style.display = '';
    els.pairingHint.textContent = 'Scannez le QR affiché par le téléphone bébé.';
    setStatus('warn', 'Scan du QR bébé…');

    scanAbort = new AbortController();
    let offerValue;
    try {
      offerValue = await QrTransport.scanFromCamera(els.scanVideo, { signal: scanAbort.signal });
    } catch (e) {
      if (scanAbort.signal.aborted) return; // basculé sur la photo
      console.warn('scan offre', e);
      setStatus('danger', 'Échec du scan');
      els.pairingHint.textContent = 'Échec du scan (' + e.message + ').';
      els.btnRestartPairing.style.display = '';
      return;
    }
    await handleOffer(offerValue);
  }

  // Suite du flux une fois l'offre obtenue (peu importe la source : scan live
  // ou photo). Crée la réponse et l'affiche en QR.
  async function handleOffer(offerValue) {
    els.scanWrap.style.display = 'none';
    els.btnPhotoOffer.style.display = 'none';
    els.pairingHint.textContent = 'QR bébé lu. Génération de la réponse…';

    pc = WebrtcPairing.createPeerConnection();
    remoteStream = new MediaStream();
    els.remoteVideo.srcObject = remoteStream;
    remoteVideoTrack = null;

    pc.ontrack = (ev) => {
      remoteStream.addTrack(ev.track);
      if (ev.track.kind === 'video') {
        remoteVideoTrack = ev.track;
        remoteVideoTrack.enabled = !audioOnly;
      }
    };
    pc.ondatachannel = (ev) => setupDataChannel(ev.channel);
    pc.oniceconnectionstatechange = () => handleIceState(pc.iceConnectionState);

    let localDesc;
    try {
      localDesc = await WebrtcPairing.createAnswerNonTrickle(pc, { type: 'offer', sdp: offerValue.s });
    } catch (e) {
      console.error('createAnswer', e);
      setStatus('danger', 'Erreur réponse');
      els.pairingHint.textContent = 'Erreur lors de la création de la réponse : ' + e.message;
      els.btnRestartPairing.style.display = '';
      return;
    }

    try {
      const size = await QrTransport.renderQr(els.qrAnswer, { t: 'answer', s: localDesc.sdp });
      console.log('QR réponse :', size, 'octets compressés');
    } catch (e) {
      setStatus('danger', 'Erreur QR (SDP trop gros)');
      els.pairingHint.textContent = e.message;
      els.btnRestartPairing.style.display = '';
      return;
    }

    els.qrAnswer.style.display = '';
    els.pairingHint.textContent = 'Montrez ce QR au téléphone bébé pour finaliser la connexion.';
    setStatus('warn', 'En attente de connexion…');
  }

  function setupDataChannel(channel) {
    channel.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'hb') {
        watchdog.beat();
        if (els.pairingSection.style.display !== 'none') switchToLiveView();
      } else if (msg.type === 'noise' && msg.over) {
        triggerNoiseAlert();
      }
    });
  }

  function switchToLiveView() {
    els.pairingSection.style.display = 'none';
    els.liveSection.style.display = '';
    setStatus('ok', 'Connecté');
    resetIdleTimer();
  }

  function handleIceState(state) {
    if (alarmActive) return; // le watchdog heartbeat est prioritaire pour l'alarme
    if (state === 'failed' || state === 'closed') {
      setStatus('danger', 'ICE : ' + state);
    } else if (state === 'disconnected') {
      setStatus('warn', 'Reconnexion réseau…');
    } else if (state === 'connected' || state === 'completed') {
      setStatus('ok', 'Connecté');
    }
  }

  function restartPairing() {
    if (pc) { try { pc.close(); } catch (e) {} }
    watchdog.stop();
    startPairing().catch((e) => console.error('restartPairing', e));
  }

  els.btnRestartPairing.addEventListener('click', restartPairing);

  // Repli photo : délègue à l'appareil photo natif (fiable là où la caméra live
  // de Chrome échoue sur certains téléphones) puis décode l'image fixe.
  async function onPhotoOffer() {
    const file = els.fileOffer.files && els.fileOffer.files[0];
    els.fileOffer.value = ''; // permet de re-sélectionner la même photo
    if (!file) return;
    if (scanAbort) scanAbort.abort(); // stoppe le scan live et ferme la caméra
    els.pairingHint.textContent = 'Lecture de la photo…';
    let offerValue;
    try {
      offerValue = await QrTransport.scanFromImageFile(file);
    } catch (e) {
      console.warn('photo offre', e);
      setStatus('danger', 'Photo illisible');
      els.pairingHint.textContent = 'Photo illisible (' + e.message + '). Réessayez.';
      els.btnRestartPairing.style.display = '';
      return;
    }
    await handleOffer(offerValue);
  }
  els.btnPhotoOffer.addEventListener('click', () => els.fileOffer.click());
  els.fileOffer.addEventListener('change', onPhotoOffer);

  // --- Alerte bruit --------------------------------------------------------

  function triggerNoiseAlert() {
    els.flashNoise.classList.remove('active');
    void els.flashNoise.offsetWidth; // force reflow pour rejouer l'animation
    els.flashNoise.classList.add('active');
    if (navigator.vibrate) navigator.vibrate([150, 80, 150]);
  }

  // --- Contrôles utilisateur --------------------------------------------------------

  els.btnMute.addEventListener('click', () => {
    muted = !muted;
    els.remoteVideo.muted = muted;
    els.btnMute.textContent = muted ? '🔈 Son coupé' : '🔇 Muet';
  });

  els.btnAudioOnly.addEventListener('click', () => setAudioOnly(!audioOnly));

  function setAudioOnly(value) {
    audioOnly = value;
    els.videoWrap.classList.toggle('audio-only', audioOnly);
    if (remoteVideoTrack) remoteVideoTrack.enabled = !audioOnly;
    els.btnAudioOnly.textContent = audioOnly ? '📹 Reprendre vidéo' : '🎧 Audio seul';
  }

  // --- Bascule auto en audio seul après 30 s d'inactivité --------------------

  function resetIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => setAudioOnly(true), 30000);
  }
  ['touchstart', 'click', 'keydown', 'mousemove'].forEach((evt) => {
    window.addEventListener(evt, () => {
      if (els.liveSection.style.display !== 'none') resetIdleTimer();
    }, { passive: true });
  });

  startPairing().catch((e) => {
    console.error(e);
    setStatus('danger', 'Erreur init : ' + e.message);
  });
})();
