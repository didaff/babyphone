// Transport du signaling WebRTC (offre/réponse SDP) par QR code.
//
// Format transporté : JSON {t:'offer'|'answer', s: <sdp>} -> UTF-8 -> deflate
// brut (pako.deflateRaw, sans en-tête zlib pour gagner quelques octets) ->
// octets bruts encodés dans le QR en mode "byte" (pas de base64 : on
// utilise directement result.binaryData renvoyé par jsQR, qui contient les
// octets tels quels, pour ne jamais faire transiter le binaire par un
// décodage UTF-8 qui le corromprait).
//
// Pourquoi la compression : une offre WebRTC "brute" (candidats ICE +
// tous les codecs proposés par défaut) dépasse largement ce qu'un QR peut
// contenir de façon lisible à l'écran d'un téléphone. webrtc-pairing.js
// restreint déjà les codecs à un seul par flux (setCodecPreferences) avant
// d'appeler renderQr ; la compression réduit encore la taille (répétitions
// de "a=candidate:", "a=rtcp-fb:", etc.).
const QrTransport = (() => {
  const MAX_QR_BYTES = 2800; // marge sous le plafond réel (~2953 o, version 40 / EC "L")

  function encode(obj) {
    const json = JSON.stringify(obj);
    return pako.deflateRaw(json);
  }

  function decode(bytes) {
    const json = pako.inflateRaw(bytes, { to: 'string' });
    return JSON.parse(json);
  }

  // Dessine le QR dans containerEl (un <div> vidé puis rempli d'un <canvas>).
  // Retourne la taille en octets du payload compressé (utile pour diagnostiquer
  // un SDP trop volumineux).
  async function renderQr(containerEl, obj) {
    const bytes = encode(obj);
    if (bytes.length > MAX_QR_BYTES) {
      throw new Error(
        `Signal trop volumineux pour un QR lisible (${bytes.length} o, max ${MAX_QR_BYTES} o). ` +
        `Réessayez l'appairage : ICE gathering incomplet ou trop de codecs proposés.`
      );
    }
    containerEl.innerHTML = '';
    const canvas = document.createElement('canvas');
    containerEl.appendChild(canvas);
    await QRCode.toCanvas(canvas, [{ data: bytes, mode: 'byte' }], {
      errorCorrectionLevel: 'L',
      margin: 2,
      scale: 6
    });
    // La lib fixe une taille en dur en style inline (ex: width/height: 462px)
    // qui déborde de l'écran sur un petit téléphone et empêche de voir le QR
    // en entier. On la remplace pour laisser le CSS (.qr-wrap canvas) contraindre
    // le canvas à la largeur du conteneur ; la résolution interne (canvas.width)
    // reste inchangée, donc le QR reste net.
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    return bytes.length;
  }

  async function openCamera(videoEl, facingMode = 'environment') {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facingMode } },
      audio: false
    });
    videoEl.srcObject = stream;
    videoEl.setAttribute('playsinline', ''); // iOS/Android : pas de plein écran auto
    await videoEl.play();
    return stream;
  }

  function stopStream(stream) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
  }

  // Boucle de scan sur un <video> DÉJÀ en lecture (peu importe l'origine du
  // flux). Ne touche pas à la caméra : utile côté bébé, qui réutilise le
  // flux caméra déjà en cours d'envoi au parent pour scanner le QR réponse
  // (pas besoin d'un deuxième getUserMedia). Résout avec le payload décodé,
  // ou rejette sur annulation via options.signal (AbortController).
  // options.onTick(qrDetecte:boolean) est appelé à chaque frame analysée.
  function scanFromVideoElement(videoEl, options = {}) {
    const { signal, onTick } = options;
    return new Promise((resolve, reject) => {
      let done = false;
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      function finish(err, value) {
        if (done) return;
        done = true;
        if (err) reject(err); else resolve(value);
      }

      if (signal) {
        if (signal.aborted) return finish(new Error('annulé'));
        signal.addEventListener('abort', () => finish(new Error('annulé')));
      }

      requestAnimationFrame(tick);

      function tick() {
        if (done) return;
        if (videoEl.readyState === videoEl.HAVE_ENOUGH_DATA && videoEl.videoWidth) {
          canvas.width = videoEl.videoWidth;
          canvas.height = videoEl.videoHeight;
          ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
          const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' });
          const detected = !!(code && code.binaryData && code.binaryData.length);
          if (onTick) onTick(detected);
          if (detected) {
            try {
              const value = decode(new Uint8Array(code.binaryData));
              return finish(null, value);
            } catch (e) {
              // frame lue mais payload corrompu/partiel (reflet, flou) : on continue
            }
          }
        }
        requestAnimationFrame(tick);
      }
    });
  }

  // Scanne en ouvrant sa propre caméra dédiée (côté parent, qui n'a pas déjà
  // de flux vidéo actif). Coupe la caméra dès qu'un QR valide est décodé ou
  // en cas d'échec/annulation.
  async function scanFromCamera(videoEl, options = {}) {
    const { facingMode = 'environment' } = options;
    const stream = await openCamera(videoEl, facingMode);
    try {
      const value = await scanFromVideoElement(videoEl, options);
      stopStream(stream);
      return value;
    } catch (e) {
      stopStream(stream);
      throw e;
    }
  }

  return {
    encode, decode, renderQr, openCamera, stopStream,
    scanFromVideoElement, scanFromCamera, MAX_QR_BYTES
  };
})();
