// Visio en face-à-face : la caméra se demande au premier appui, jamais à
// l'entrée de la séance, et la signalisation WebRTC passe par le relais de la
// séance. Le flux reste pair-à-pair : le serveur ne voit que des messages
// JSON. Aucun son n'est capturé (audio: false) pour préserver la fidélité du
// film, et chaque piste est arrêtée proprement pour que le voyant s'éteigne.
const STUN = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];
const STATE_NAMES = {
  idle: 'Activer la caméra',
  starting: 'Activation de la caméra…',
  active: 'Couper la caméra',
  error: 'Caméra indisponible sur cet appareil.',
};
const MIN_W = 140, MIN_H = 105, MAX_W = 480, MAX_H = 360;

export function attachWebcam({ toggle, overlay, player, t, label }) {
  const stage = overlay.parentElement;
  const body = overlay.querySelector('.webcam-body') || overlay;
  let remote = overlay.querySelector('#webcam-remote-video');
  let preview = overlay.querySelector('#webcam-self-preview');
  const placeholder = overlay.querySelector('#webcam-placeholder');
  const peerName = overlay.querySelector('#webcam-peer');
  const dot = overlay.querySelector('#webcam-status');
  const minimize = overlay.querySelector('#webcam-minimize');
  const close = overlay.querySelector('#webcam-close');
  const header = overlay.querySelector('.webcam-header');
  const grip = overlay.querySelector('#webcam-resize');

  const ensureRemote = () => {
    if (!remote && typeof document !== 'undefined') {
      remote = document.createElement('video');
      remote.id = 'webcam-remote-video';
      remote.autoplay = true;
      remote.playsInline = true;
      remote.muted = true;
      body.prepend(remote);
    }
    return remote;
  };
  const ensurePreview = () => {
    if (!preview && typeof document !== 'undefined') {
      preview = document.createElement('video');
      preview.id = 'webcam-self-preview';
      preview.autoplay = true;
      preview.playsInline = true;
      preview.muted = true;
      body.append(preview);
    }
    return preview;
  };

  let state = 'idle', stream = null, pc = null, peerId = null, disposed = false;
  let makingOffer = false, ignoreOffer = false, dismissed = false, peerActive = false;
  let note = '', noteTimer = null, savedHeight = '', announcedFor = null;
  let pendingCandidates = [];

  const setState = next => {
    state = next;
    toggle.dataset.state = next;
    toggle.setAttribute('aria-pressed', String(next === 'active'));
    toggle.setAttribute('aria-label', label(STATE_NAMES[next] ?? STATE_NAMES.idle));
  };
  const render = () => {
    const live = Boolean(remote?.srcObject);
    if (dot) dot.dataset.live = String(live);
    placeholder.textContent = live ? '' : note || (peerActive ? label('En attente de la caméra…') : '');
    overlay.hidden = dismissed || (!live && !stream && !placeholder.textContent);
    // When remote is not live but local camera is active, enlarge local preview to fill overlay
    const solo = Boolean(stream && !live);
    overlay.dataset.solo = String(solo);
    if (preview) preview.hidden = !stream;
  };
  // Les erreurs locales s'effacent seules : le bouton repasse au repos et la
  // vignette disparaît si rien d'autre ne la maintient.
  const say = (text, ms = 6000) => {
    note = text;
    render();
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { note = ''; if (state === 'error') setState('idle'); render(); }, ms);
  };
  const send = payload => player.send({ type: 'webcam', ...payload });
  // L'annonce repart dès que la socket ou le pair change : une reconnexion ou
  // une arrivée tardive republie l'état, sans spammer à chaque état reçu.
  const announce = () => {
    const key = `${player.memberId}|${peerId}`;
    if (!stream || announcedFor === key) return;
    announcedFor = key;
    send({ action: 'status', active: true });
  };
  // Négociation dite « parfaite » : le pair le moins poli ignore une offre qui
  // entre en collision avec la sienne, l'autre fait machine arrière. Les
  // memberId sont des UUID : l'ordre arbitraire suffit à départager deux pairs.
  const polite = () => String(player.memberId) < String(peerId);
  const connect = () => {
    if (pc) return pc;
    pc = new RTCPeerConnection({
      iceServers: [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }
      ]
    });
    pc.onnegotiationneeded = async () => {
      try {
        makingOffer = true;
        await pc.setLocalDescription();
        send({ action: 'signal', to: peerId ?? undefined, signal: { description: pc.localDescription } });
      } catch { /* une négociation interrompue est reprise au changement suivant */ }
      finally { makingOffer = false; }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) send({ action: 'signal', to: peerId ?? undefined, signal: { candidate } });
    };
    pc.ontrack = event => {
      const v = ensureRemote();
      v.srcObject = event.streams[0];
      dismissed = false;
      render();
    };
    pc.onconnectionstatechange = () => {
      if (pc && ['failed'].includes(pc.connectionState)) {
        try { pc.restartIce?.(); } catch {}
      } else if (pc && ['closed'].includes(pc.connectionState) && remote) {
        remote.srcObject = null; render();
      }
    };
    return pc;
  };
  const resetRemote = reconnect => {
    peerActive = false; peerId = null;
    if (peerName) peerName.textContent = '';
    if (remote) {
      remote.srcObject = null;
      remote.remove?.();
      remote = null;
    }
    ignoreOffer = false;
    pendingCandidates = [];
    try { pc?.close(); } catch {}
    pc = null;
    // La caméra locale survit à une reconnexion : la session neuve reçoit les
    // pistes et repart sur une négociation propre.
    if (reconnect && stream) {
      const conn = connect();
      for (const track of stream.getTracks()) conn.addTrack(track, stream);
    }
    render();
  };
  const message = async event => {
    // Déconnexion de la séance : le distant est parti, on raccroche sans
    // toucher à la caméra locale.
    if (!event) return resetRemote(true);
    if (event.action === 'signal') {
      peerId = event.from;
      if (peerName && event.name) peerName.textContent = event.name;
      const conn = connect();
      const signal = event.signal ?? {};
      try {
        if (signal.description) {
          const collision = signal.description.type === 'offer' && (makingOffer || conn.signalingState !== 'stable');
          ignoreOffer = !polite() && collision;
          if (ignoreOffer) return;
          await conn.setRemoteDescription(signal.description);
          if (signal.description.type === 'offer') {
            await conn.setLocalDescription();
            send({ action: 'signal', to: peerId, signal: { description: conn.localDescription } });
          }
          while (pendingCandidates.length) {
            const cand = pendingCandidates.shift();
            try { await conn.addIceCandidate(cand); } catch {}
          }
        } else if (signal.candidate) {
          if (!conn.remoteDescription) {
            pendingCandidates.push(signal.candidate);
          } else {
            try { await conn.addIceCandidate(signal.candidate); }
            catch (error) { if (!ignoreOffer) throw error; }
          }
        }
      } catch { /* signalisation périmée ou malformée : ignorée */ }
      return;
    }
    if (event.action === 'status') {
      peerId = event.from;
      if (peerName && event.name) peerName.textContent = event.name;
      peerActive = !!event.active;
      if (!peerActive && remote) {
        remote.srcObject = null;
        remote.remove?.();
        remote = null;
      }
      dismissed = false;
      if (peerActive && stream) {
        const conn = connect();
        const senders = conn.getSenders?.() ?? [];
        for (const track of stream.getTracks()) {
          if (!senders.some(s => s.track === track)) conn.addTrack(track, stream);
        }
      }
      render();
      return;
    }
    // Un pair arrive après nous : la caméra locale repart sur une session
    // WebRTC propre, refait l'offre et republie son état.
    if (event.action === 'peer-joined') {
      peerId = event.from;
      if (peerName && event.name) peerName.textContent = event.name;
      if (stream) {
        ignoreOffer = false;
        pendingCandidates = [];
        try { pc?.close(); } catch {}
        pc = null;
        const conn = connect();
        for (const track of stream.getTracks()) conn.addTrack(track, stream);
        try {
          makingOffer = true;
          await conn.setLocalDescription();
          send({ action: 'signal', to: peerId, signal: { description: conn.localDescription } });
        } finally { makingOffer = false; }
        announce();
      }
      return;
    }
    if (event.action === 'peer-left') resetRemote(false);
  };
  const stopCamera = (notify = true) => {
    if (stream) for (const track of stream.getTracks()) track.stop();
    stream = null;
    if (preview) {
      preview.srcObject = null;
      preview.remove?.();
      preview = null;
    }
    try { if (pc) for (const sender of pc.getSenders()) if (sender.track) pc.removeTrack(sender); } catch {}
    if (notify) { announcedFor = null; send({ action: 'status', active: false }); }
    setState('idle');
    render();
  };
  const tap = async () => {
    if (state === 'starting') return;
    if (state === 'active') return stopCamera();
    setState('starting');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('caméra absente');
      const granted = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { max: 30 } }, audio: false });
      // Une permission résolue après un second geste ou le démontage produirait
      // un flux orphelin encore actif : il est arrêté plutôt qu'adopté.
      if (disposed || state !== 'starting') { granted.getTracks().forEach(track => track.stop()); return; }
      stream = granted;
      const prev = ensurePreview();
      prev.srcObject = stream;
      const conn = connect();
      for (const track of stream.getTracks()) conn.addTrack(track, stream);
      announce();
      setState('active');
      render();
    } catch {
      setState('error');
      say(label('Caméra indisponible sur cet appareil.'));
    }
  };
  // Déplacement borné à la scène : la vignette ne peut jamais sortir de
  // l'écran, en lecture normale comme en plein écran.
  const beginDrag = event => {
    if (event.target.closest('#webcam-resize') || event.target.closest('button')) return;
    event.preventDefault();
    const rect = overlay.getBoundingClientRect(), bounds = stage.getBoundingClientRect();
    overlay.style.left = `${rect.left - bounds.left}px`;
    overlay.style.top = `${rect.top - bounds.top}px`;
    overlay.style.right = 'auto';
    const dx = event.clientX - rect.left, dy = event.clientY - rect.top;
    overlay.setPointerCapture(event.pointerId);
    const move = e => {
      const box = stage.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - box.left - dx, box.width - rect.width));
      const y = Math.max(0, Math.min(e.clientY - box.top - dy, box.height - rect.height));
      overlay.style.left = `${x}px`;
      overlay.style.top = `${y}px`;
    };
    const end = () => {
      overlay.removeEventListener('pointermove', move);
      overlay.removeEventListener('pointerup', end);
      overlay.removeEventListener('pointercancel', end);
    };
    overlay.addEventListener('pointermove', move);
    overlay.addEventListener('pointerup', end);
    overlay.addEventListener('pointercancel', end);
  };
  overlay.addEventListener('pointerdown', beginDrag);
  if (header && header !== overlay) header.addEventListener('pointerdown', beginDrag);
  const handles = overlay.querySelectorAll ? overlay.querySelectorAll('.webcam-resize-handle') : [];
  const resizeHandles = handles.length ? handles : (grip ? [grip] : []);
  const beginResize = event => {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const corner = handle.dataset.corner || 'se';
    const rect = overlay.getBoundingClientRect();
    const box = stage.getBoundingClientRect();
    handle.setPointerCapture(event.pointerId);

    const move = e => {
      let w = rect.width;
      let left = rect.left - box.left;
      let top = rect.top - box.top;

      if (corner === 'se') {
        const maxW = Math.min(MAX_W, box.width - left);
        const maxH = box.height - top;
        w = Math.max(MIN_W, Math.min(e.clientX - rect.left, maxW));
        let h = Math.round(w * 3 / 4);
        if (h > maxH) { h = maxH; w = Math.round(h * 4 / 3); }
        overlay.style.width = `${w}px`;
        overlay.style.height = `${h}px`;
      } else if (corner === 'sw') {
        const maxW = Math.min(MAX_W, rect.right - box.left);
        const maxH = box.height - top;
        w = Math.max(MIN_W, Math.min(rect.right - e.clientX, maxW));
        let h = Math.round(w * 3 / 4);
        if (h > maxH) { h = maxH; w = Math.round(h * 4 / 3); }
        overlay.style.width = `${w}px`;
        overlay.style.height = `${h}px`;
        overlay.style.left = `${rect.right - box.left - w}px`;
        overlay.style.right = 'auto';
      } else if (corner === 'ne') {
        const maxW = Math.min(MAX_W, box.width - left);
        const maxH = rect.bottom - box.top;
        w = Math.max(MIN_W, Math.min(e.clientX - rect.left, maxW));
        let h = Math.round(w * 3 / 4);
        if (h > maxH) { h = maxH; w = Math.round(h * 4 / 3); }
        overlay.style.width = `${w}px`;
        overlay.style.height = `${h}px`;
        overlay.style.top = `${rect.bottom - box.top - h}px`;
        overlay.style.bottom = 'auto';
      } else if (corner === 'nw') {
        const maxW = Math.min(MAX_W, rect.right - box.left);
        const maxH = rect.bottom - box.top;
        w = Math.max(MIN_W, Math.min(rect.right - e.clientX, maxW));
        let h = Math.round(w * 3 / 4);
        if (h > maxH) { h = maxH; w = Math.round(h * 4 / 3); }
        overlay.style.width = `${w}px`;
        overlay.style.height = `${h}px`;
        overlay.style.left = `${rect.right - box.left - w}px`;
        overlay.style.top = `${rect.bottom - box.top - h}px`;
        overlay.style.right = 'auto';
        overlay.style.bottom = 'auto';
      }
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };
  for (const h of resizeHandles) {
    h.addEventListener('pointerdown', beginResize);
  }
  minimize?.addEventListener('click', () => {
    const minimized = overlay.dataset.minimized === 'true';
    overlay.dataset.minimized = String(!minimized);
    if (minimized) overlay.style.height = savedHeight;
    else { savedHeight = overlay.style.height; overlay.style.height = 'auto'; }
    minimize.setAttribute('aria-label', label(minimized ? 'Réduire' : 'Agrandir'));
  });
  close?.addEventListener('click', () => { dismissed = true; render(); });
  toggle.addEventListener('click', tap);
  const rename = () => {
    setState(state);
    minimize?.setAttribute('aria-label', label(overlay.dataset.minimized === 'true' ? 'Agrandir' : 'Réduire'));
    close?.setAttribute('aria-label', label('Fermer'));
    render();
  };
  rename();
  return {
    message,
    announce,
    rename,
    dispose() {
      disposed = true;
      toggle.removeEventListener('click', tap);
      overlay.removeEventListener('pointerdown', beginDrag);
      header?.removeEventListener('pointerdown', beginDrag);
      grip?.removeEventListener('pointerdown', beginResize);
      clearTimeout(noteTimer);
      stopCamera(false);
      try { pc?.close(); } catch {}
      pc = null;
      if (remote) {
        remote.srcObject = null;
        remote.remove?.();
        remote = null;
      }
      toggle.dataset.state = 'idle';
      overlay.hidden = true;
    },
  };
}
