// Transport du signaling WebRTC (offre/réponse SDP) par QR code.
//
// Format transporté : JSON {t:'offer'|'answer', s: <sdp>} -> UTF-8 -> deflate
// brut (pako.deflateRaw, sans en-tête zlib) -> base64 -> QR en mode texte.
//
// Pourquoi base64 (et plus les octets bruts) : la lecture s'appuie EN PRIORITÉ
// sur l'API native BarcodeDetector (décodeur ZXing/MLKit de l'OS, bien plus
// robuste que jsQR au flou, aux reflets et au scan écran-vers-écran). Or
// BarcodeDetector n'expose que rawValue (une chaîne), pas les octets bruts :
// un payload binaire y serait décodé en UTF-8 et corrompu. On encode donc le
// binaire compressé en base64 (ASCII sûr), lisible proprement par le décodeur
// natif ET par jsQR (repli si BarcodeDetector est absent). Coût : +33 % de
// taille (base64), à compenser ensuite en allégeant le SDP.
//
// Pourquoi la compression : une offre WebRTC "brute" (candidats ICE +
// tous les codecs proposés par défaut) dépasse largement ce qu'un QR peut
// contenir de façon lisible à l'écran d'un téléphone. webrtc-pairing.js
// restreint déjà les codecs à un seul par flux (setCodecPreferences) avant
// d'appeler renderQr ; la compression réduit encore la taille (répétitions
// de "a=candidate:", "a=rtcp-fb:", etc.).
const QrTransport = (() => {
  // Plafond en caractères base64 tenant dans un QR mode octet version 40 / EC "L"
  // (~2953 o). base64 étant de l'ASCII, 1 caractère = 1 octet dans le QR.
  const MAX_QR_CHARS = 2900;

  function encode(obj) {
    const json = JSON.stringify(obj);
    return pako.deflateRaw(json); // Uint8Array
  }

  // bytes (Uint8Array) -> base64. Chunké pour ne pas dépasser la limite
  // d'arguments de String.fromCharCode sur un gros tableau.
  function bytesToB64(bytes) {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function b64ToBytes(str) {
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // Décode le texte lu dans un QR (base64) vers l'objet {t, s}.
  function decode(text) {
    const bytes = b64ToBytes(text);
    const json = pako.inflateRaw(bytes, { to: 'string' });
    return JSON.parse(json);
  }

  // BarcodeDetector natif si disponible ET gérant le QR ; sinon null (repli
  // jsQR). Résolu une seule fois puis mémoïsé (getSupportedFormats est async).
  let _detectorPromise = null;
  function getDetector() {
    if (_detectorPromise) return _detectorPromise;
    _detectorPromise = (async () => {
      try {
        if (!('BarcodeDetector' in window)) return null;
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (!formats || !formats.includes('qr_code')) return null;
        return new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch (e) {
        return null;
      }
    })();
    return _detectorPromise;
  }

  // Dessine le QR dans containerEl (un <div> vidé puis rempli d'un <canvas>).
  // Retourne la taille en octets du payload compressé (utile pour diagnostiquer
  // un SDP trop volumineux).
  async function renderQr(containerEl, obj) {
    const bytes = encode(obj);
    const text = bytesToB64(bytes);
    if (text.length > MAX_QR_CHARS) {
      throw new Error(
        `Signal trop volumineux pour un QR lisible (${bytes.length} o compressés, ` +
        `${text.length} car. base64, max ${MAX_QR_CHARS}). ` +
        `Réessayez l'appairage : ICE gathering incomplet ou trop de codecs proposés.`
      );
    }
    containerEl.innerHTML = '';
    const canvas = document.createElement('canvas');
    containerEl.appendChild(canvas);
    await QRCode.toCanvas(canvas, text, {
      errorCorrectionLevel: 'L',
      margin: 4, // quiet zone standard (4 modules) : nettement mieux détecté qu'à 2
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
      video: {
        facingMode: { ideal: facingMode },
        // Résolution haute demandée : un flux 640x480 par défaut rend le QR
        // écran-vers-écran trop mou pour être décodé. On vise du 720p.
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });
    videoEl.srcObject = stream;
    videoEl.setAttribute('playsinline', ''); // iOS/Android : pas de plein écran auto
    await videoEl.play();
    applyAutofocus(stream); // best-effort, non bloquant
    // Tap pour relancer la mise au point : filet de sécurité si l'AF reste
    // bloqué sur une distance lointaine (fréquent en écran-vers-écran).
    videoEl.addEventListener('click', () => applyAutofocus(stream), { passive: true });
    return stream;
  }

  // Force si possible l'autofocus continu sur le flux caméra. Sans ça, certains
  // téléphones (ex. Galaxy Z Flip sous Chrome) laissent la caméra sur une mise
  // au point lointaine et le QR reste flou, alors que d'autres (Pixel) scannent
  // sans problème. Best-effort et silencieux : les contraintes avancées ne sont
  // pas supportées partout, et un échec ne doit pas bloquer le scan.
  async function applyAutofocus(stream) {
    const track = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
    if (!track || !track.getCapabilities || !track.applyConstraints) return;
    try {
      const caps = track.getCapabilities();
      if (caps.focusMode && caps.focusMode.includes('continuous')) {
        await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
      }
    } catch (e) {
      console.warn('autofocus non applicable', e);
    }
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
      let busy = false;      // une seule analyse de frame en vol à la fois
      let detector = null;   // BarcodeDetector natif, ou null si repli jsQR
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

      // Traite un texte lu ; résout la promesse et renvoie true si le payload
      // est valide, sinon false (on continue à scanner).
      function consume(text) {
        const detected = !!(text && text.length);
        if (onTick) onTick(detected);
        if (detected) {
          try {
            finish(null, decode(text));
            return true;
          } catch (e) {
            // frame lue mais payload corrompu/partiel (reflet, flou) : on continue
          }
        }
        return false;
      }

      // Démarre la boucle seulement une fois qu'on sait si le décodeur natif
      // est disponible (évite de gaspiller des frames sur jsQR entre-temps).
      getDetector().then((d) => {
        detector = d;
        requestAnimationFrame(tick);
      });

      async function tick() {
        if (done) return;
        if (busy || videoEl.readyState !== videoEl.HAVE_ENOUGH_DATA || !videoEl.videoWidth) {
          return void requestAnimationFrame(tick);
        }
        busy = true;
        try {
          if (detector) {
            // Chemin natif : décodage direct sur l'élément <video>.
            const codes = await detector.detect(videoEl);
            if (!done) {
              if (codes && codes.length) {
                if (consume(codes[0].rawValue)) return;
              } else if (onTick) {
                onTick(false);
              }
            }
          } else {
            // Repli jsQR : rasterisation de la frame puis décodage JS. On tente
            // les deux polarités (attemptBoth) — plus tolérant que dontInvert.
            canvas.width = videoEl.videoWidth;
            canvas.height = videoEl.videoHeight;
            ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
            const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'attemptBoth' });
            if (!done && consume(code && code.data)) return;
          }
        } catch (e) {
          // detect() peut lever ponctuellement (frame non prête, source refusée).
          // On abandonne le chemin natif et on bascule sur jsQR pour la suite.
          if (detector) {
            console.warn('BarcodeDetector.detect a échoué, repli jsQR', e);
            detector = null;
          }
        } finally {
          busy = false;
        }
        if (!done) requestAnimationFrame(tick);
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

  // Décode un QR depuis une image fixe (photo prise par l'appareil natif via
  // un <input type=file capture>). Contourne totalement l'interface caméra live
  // de Chrome (getUserMedia), défaillante sur certains téléphones (ex. Galaxy
  // Z Flip : autofocus KO en live alors que l'app photo native lit le QR sans
  // souci). Une image nette et fixe est bien plus fiable qu'un flux mou.
  async function scanFromImageFile(file) {
    const bitmap = await createImageBitmap(file);
    try {
      // Chemin natif : BarcodeDetector accepte directement l'ImageBitmap
      // (pleine résolution = meilleures chances sur un QR dense).
      const detector = await getDetector();
      if (detector) {
        try {
          const codes = await detector.detect(bitmap);
          if (codes && codes.length) return decode(codes[0].rawValue);
        } catch (e) {
          // repli jsQR ci-dessous
        }
      }
      // Repli jsQR : on sous-échantillonne (une photo 12 Mpx écroulerait jsQR).
      const MAX = 1600;
      const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0, w, h);
      const frame = ctx.getImageData(0, 0, w, h);
      const code = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'attemptBoth' });
      if (code && code.data) return decode(code.data);
      throw new Error('aucun QR lisible sur la photo — cadrez bien le QR, sans reflet, et réessayez');
    } finally {
      if (bitmap.close) bitmap.close();
    }
  }

  return {
    encode, decode, renderQr, openCamera, stopStream,
    scanFromVideoElement, scanFromCamera, scanFromImageFile, applyAutofocus, MAX_QR_CHARS
  };
})();
