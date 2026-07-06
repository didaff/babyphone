// Logique du Mode Bébé : caméra + micro, appairage QR (offre → réponse),
// wake lock, voile noir, détection de bruit, heartbeat.
(() => {
  const QUALITY_PRESETS = [
    { label: '320p', width: 320, height: 240 },
    { label: '480p', width: 640, height: 480 }
  ];

  const els = {
    video: document.getElementById('local-video'),
    statusBadge: document.getElementById('status-badge'),
    statusText: document.getElementById('status-text'),
    btnSwitchCam: document.getElementById('btn-switch-cam'),
    btnQuality: document.getElementById('btn-quality'),
    pairingHint: document.getElementById('pairing-hint'),
    qrOffer: document.getElementById('qr-offer'),
    btnScanAnswer: document.getElementById('btn-scan-answer'),
    btnRestartPairing: document.getElementById('btn-restart-pairing'),
    noiseThreshold: document.getElementById('noise-threshold'),
    noiseThresholdValue: document.getElementById('noise-threshold-value'),
    noiseMeter: document.getElementById('noise-meter'),
    noiseMeterFill: document.getElementById('noise-meter-fill'),
    veil: document.getElementById('veil')
  };

  let localStream = null;
  let audioTrack = null;
  let videoTrack = null;
  let audioSender = null;
  let videoSender = null;
  let pc = null;
  let dc = null;
  let heartbeatTimer = null;
  let scanAbortController = null;
  let currentFacingMode = 'environment';
  let qualityIndex = 0;
  let wakeLock = null;

  function setStatus(kind, text) {
    els.statusBadge.classList.remove('ok', 'warn', 'danger');
    if (kind) els.statusBadge.classList.add(kind);
    els.statusText.textContent = text;
  }

  // --- Caméra / micro -------------------------------------------------

  async function getCameraStream(facingMode, quality) {
    return navigator.mediaDevices.getUserMedia({
      audio: true,
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: quality.width },
        height: { ideal: quality.height }
      }
    });
  }

  function updatePreviewStream() {
    els.video.srcObject = new MediaStream([videoTrack, audioTrack]);
  }

  async function startCamera() {
    localStream = await getCameraStream(currentFacingMode, QUALITY_PRESETS[qualityIndex]);
    audioTrack = localStream.getAudioTracks()[0];
    videoTrack = localStream.getVideoTracks()[0];
    updatePreviewStream();
  }

  async function switchCamera() {
    currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';
    els.btnSwitchCam.disabled = true;
    try {
      const stream = await getCameraStream(currentFacingMode, QUALITY_PRESETS[qualityIndex]);
      const newVideoTrack = stream.getVideoTracks()[0];
      const newAudioTrack = stream.getAudioTracks()[0];
      if (videoSender) await videoSender.replaceTrack(newVideoTrack);
      videoTrack.stop();
      videoTrack = newVideoTrack;
      // Le micro n'a pas besoin de changer, mais getUserMedia en renvoie un
      // nouveau à chaque appel : on ferme celui-ci pour ne pas laisser deux
      // captures micro ouvertes en parallèle.
      newAudioTrack.stop();
      updatePreviewStream();
    } catch (e) {
      console.warn('switchCamera', e);
      els.pairingHint.textContent = 'Impossible de basculer la caméra : ' + e.message;
    } finally {
      els.btnSwitchCam.disabled = false;
    }
  }

  async function toggleQuality() {
    qualityIndex = (qualityIndex + 1) % QUALITY_PRESETS.length;
    const quality = QUALITY_PRESETS[qualityIndex];
    els.btnQuality.textContent = 'Qualité : ' + quality.label;
    els.btnQuality.disabled = true;
    try {
      const stream = await getCameraStream(currentFacingMode, quality);
      const newVideoTrack = stream.getVideoTracks()[0];
      const newAudioTrack = stream.getAudioTracks()[0];
      if (videoSender) await videoSender.replaceTrack(newVideoTrack);
      videoTrack.stop();
      videoTrack = newVideoTrack;
      newAudioTrack.stop();
      updatePreviewStream();
    } catch (e) {
      console.warn('toggleQuality', e);
    } finally {
      els.btnQuality.disabled = false;
    }
  }

  // --- Appairage QR -----------------------------------------------------

  async function startPairing() {
    els.btnRestartPairing.style.display = 'none';
    els.btnScanAnswer.style.display = 'none';
    els.qrOffer.style.display = 'none';
    setStatus('warn', 'Préparation de l’offre…');

    pc = WebrtcPairing.createPeerConnection();
    audioSender = pc.addTransceiver(audioTrack, { direction: 'sendonly', streams: [localStream] }).sender;
    videoSender = pc.addTransceiver(videoTrack, { direction: 'sendonly', streams: [localStream] }).sender;
    WebrtcPairing.restrictCodecs(pc);

    pc.oniceconnectionstatechange = () => handleIceState(pc.iceConnectionState);

    const { localDescription, dataChannel } = await WebrtcPairing.createOfferNonTrickle(pc);
    dc = dataChannel;
    setupDataChannel(dc);

    try {
      const size = await QrTransport.renderQr(els.qrOffer, { t: 'offer', s: localDescription.sdp });
      console.log('QR offre :', size, 'octets compressés');
    } catch (e) {
      setStatus('danger', 'Erreur QR (SDP trop gros)');
      els.pairingHint.textContent = e.message;
      els.btnRestartPairing.style.display = '';
      return;
    }

    els.qrOffer.style.display = '';
    els.pairingHint.textContent = 'Faites scanner ce QR par le téléphone parent, puis appuyez ci-dessous pour scanner sa réponse.';
    els.btnScanAnswer.style.display = '';
    setStatus('warn', 'En attente du scan…');
  }

  function setupDataChannel(channel) {
    channel.addEventListener('open', () => {
      clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        if (channel.readyState === 'open') {
          channel.send(JSON.stringify({ type: 'hb', ts: Date.now() }));
        }
      }, 2000);
    });
    channel.addEventListener('close', () => clearInterval(heartbeatTimer));
  }

  function handleIceState(state) {
    if (state === 'connected' || state === 'completed') {
      setStatus('ok', 'Connecté');
      els.btnRestartPairing.style.display = 'none';
    } else if (state === 'disconnected' || state === 'checking') {
      setStatus('warn', 'Reconnexion…');
    } else if (state === 'failed' || state === 'closed') {
      setStatus('danger', 'Connexion perdue');
      els.btnRestartPairing.style.display = '';
    }
  }

  async function onScanAnswerClick() {
    els.btnScanAnswer.disabled = true;
    els.pairingHint.textContent = 'Pointez la caméra vers le QR réponse affiché par le parent…';
    scanAbortController = new AbortController();
    try {
      const value = await QrTransport.scanFromVideoElement(els.video, { signal: scanAbortController.signal });
      await WebrtcPairing.applyRemoteAnswer(pc, { type: 'answer', sdp: value.s });
      els.qrOffer.style.display = 'none';
      els.btnScanAnswer.style.display = 'none';
      els.pairingHint.textContent = 'Réponse acceptée, connexion en cours…';
      setStatus('warn', 'Connexion en cours…');
    } catch (e) {
      console.warn('scan réponse', e);
      els.pairingHint.textContent = 'Échec du scan (' + e.message + '). Réessayez.';
      els.btnScanAnswer.disabled = false;
    }
  }

  function restartPairing() {
    if (pc) { try { pc.close(); } catch (e) {} }
    clearInterval(heartbeatTimer);
    startPairing().catch((e) => console.error('restartPairing', e));
  }

  // --- Détection de bruit -------------------------------------------------

  function setupNoiseDetection() {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(new MediaStream([audioTrack]));
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);

    let wasOver = false;
    let lastSentAt = 0;

    els.noiseThresholdValue.textContent = els.noiseThreshold.value;
    els.noiseThreshold.addEventListener('input', () => {
      els.noiseThresholdValue.textContent = els.noiseThreshold.value;
    });

    function tick() {
      analyser.getByteTimeDomainData(data);
      let sumSquares = 0;
      for (let i = 0; i < data.length; i++) {
        const norm = (data[i] - 128) / 128;
        sumSquares += norm * norm;
      }
      const rms = Math.sqrt(sumSquares / data.length);
      const level = Math.min(100, Math.round(rms * 100 * 3)); // *3 : sensibilité perceptuelle
      const threshold = Number(els.noiseThreshold.value);
      const over = level >= threshold;

      els.noiseMeterFill.style.width = level + '%';
      els.noiseMeter.classList.toggle('over', over);

      const now = Date.now();
      const shouldSend = (over !== wasOver) || (over && now - lastSentAt > 1000);
      if (shouldSend && dc && dc.readyState === 'open') {
        dc.send(JSON.stringify({ type: 'noise', over, level }));
        lastSentAt = now;
      }
      wasOver = over;

      requestAnimationFrame(tick);
    }
    tick();
  }

  // --- Wake lock -----------------------------------------------------

  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) {
      console.warn('wakeLock', e);
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestWakeLock();
  });

  // --- Voile noir (inactivité) -----------------------------------------------------

  function setupInactivityVeil() {
    let idleTimer = null;
    function resetIdle() {
      els.veil.classList.remove('active');
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => els.veil.classList.add('active'), 10000);
    }
    ['touchstart', 'click', 'keydown', 'mousemove'].forEach((evt) => {
      window.addEventListener(evt, resetIdle, { passive: true });
    });
    resetIdle();
  }

  // --- Init -----------------------------------------------------

  els.btnSwitchCam.addEventListener('click', switchCamera);
  els.btnQuality.addEventListener('click', toggleQuality);
  els.btnScanAnswer.addEventListener('click', onScanAnswerClick);
  els.btnRestartPairing.addEventListener('click', restartPairing);

  (async function init() {
    try {
      setStatus('warn', 'Démarrage caméra/micro…');
      await startCamera();
      setupNoiseDetection();
      requestWakeLock();
      setupInactivityVeil();
      await startPairing();
    } catch (e) {
      console.error(e);
      setStatus('danger', 'Erreur caméra/micro');
      els.pairingHint.textContent = 'Impossible de démarrer la caméra/micro : ' + e.message +
        ' — vérifiez que la page est servie en HTTPS et que les permissions caméra/micro sont accordées.';
    }
  })();
})();
