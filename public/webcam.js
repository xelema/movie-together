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
  const remote = overlay.querySelector('#webcam-remote-video');
  const preview = overlay.querySelector('#webcam-self-preview');
  const placeholder = overlay.querySelector('#webcam-placeholder');
  const peerName = overlay.querySelector('#webcam-peer');
  const dot = overlay.querySelector('#webcam-status');
  const minimize = overlay.querySelector('#webcam-minimize');
  const close = overlay.querySelector('#webcam-close');
  const header = overlay.querySelector('.webcam-header');
  const grip = overlay.querySelector('#webcam-resize');
  let state = 'idle', stream = null, pc = null, peerId = null, disposed = false;
  let makingOffer = false, ignoreOffer = false, dismissed = false, peerActive = false;
  let note = '', noteTimer = null, savedHeight = '', announcedFor = null;

  const setState = next => {
    state = next;
    toggle.dataset.state = next;
    toggle.setAttribute('aria-pressed', String(next === 'active'));
    toggle.setAttribute('aria-label', label(STATE_NAMES[next] ?? STATE_NAMES.idle));
  };
  const render = () => {
    const live = !!remote.srcObject;
    dot.dataset.live = String(live);
    placeholder.textContent = live ? '' : note || (peerActive ? label('En attente de la caméra…') : '');
    overlay.hidden = dismissed || (!live && !stream && !placeholder.textContent);
    preview.hidden = !stream;
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
  // L'annonce ne part qu'une fois par connexion : memberId change à chaque
  // socket, une reconnexion republie donc l'état automatiquement.
  const announce = () => {
    if (!stream || announcedFor === player.memberId) return;
    announcedFor = player.memberId;
    send({ action: 'status', active: true });
  };
  // Négociation dite « parfaite » : le pair le moins poli ignore une offre qui
  // entre en collision avec la sienne, l'autre fait machine arrière. Les
  // memberId sont des UUID : l'ordre arbitraire suffit à départager deux pairs.
  const polite = () => String(player.memberId) < String(peerId);
  const connect = () => {
    if (pc) return pc;
    pc = new RTCPeerConnection({ iceServers: [{ urls: STUN }] });
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
      remote.srcObject = event.streams[0];
      dismissed = false;
      render();
    };
    pc.onconnectionstatechange = () => {
      if (pc && ['failed', 'closed'].includes(pc.connectionState)) { remote.srcObject = null; render(); }
    };
    return pc;
  };
  const resetRemote = reconnect => {
    peerActive = false; peerId = null;
    peerName.textContent = '';
    remote.srcObject = null;
    ignoreOffer = false;
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
      if (event.name) peerName.textContent = event.name;
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
        } else if (signal.candidate) {
          try { await conn.addIceCandidate(signal.candidate); }
          catch (error) { if (!ignoreOffer) throw error; }
        }
      } catch { /* signalisation périmée ou malformée : ignorée */ }
      return;
    }
    if (event.action === 'status') {
      peerId = event.from;
      if (event.name) peerName.textContent = event.name;
      peerActive = !!event.active;
      if (!peerActive) remote.srcObject = null;
      dismissed = false;
      render();
      return;
    }
    if (event.action === 'peer-left') resetRemote(false);
  };
  const stopCamera = (notify = true) => {
    if (stream) for (const track of stream.getTracks()) track.stop();
    stream = null;
    preview.srcObject = null;
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
      preview.srcObject = stream;
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
    if (event.target.closest('button')) return;
    event.preventDefault();
    const rect = overlay.getBoundingClientRect(), bounds = stage.getBoundingClientRect();
    overlay.style.left = `${rect.left - bounds.left}px`;
    overlay.style.top = `${rect.top - bounds.top}px`;
    overlay.style.right = 'auto';
    const dx = event.clientX - rect.left, dy = event.clientY - rect.top;
    header.setPointerCapture(event.pointerId);
    const move = e => {
      const box = stage.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - box.left - dx, box.width - rect.width));
      const y = Math.max(0, Math.min(e.clientY - box.top - dy, box.height - rect.height));
      overlay.style.left = `${x}px`;
      overlay.style.top = `${y}px`;
    };
    const end = () => {
      header.removeEventListener('pointermove', move);
      header.removeEventListener('pointerup', end);
      header.removeEventListener('pointercancel', end);
    };
    header.addEventListener('pointermove', move);
    header.addEventListener('pointerup', end);
    header.addEventListener('pointercancel', end);
  };
  header.addEventListener('pointerdown', beginDrag);
  const beginResize = event => {
    event.preventDefault();
    const rect = overlay.getBoundingClientRect();
    grip.setPointerCapture(event.pointerId);
    const move = e => {
      const box = stage.getBoundingClientRect();
      overlay.style.width = `${Math.max(MIN_W, Math.min(e.clientX - rect.left, MAX_W, box.width - (rect.left - box.left)))}px`;
      overlay.style.height = `${Math.max(MIN_H, Math.min(e.clientY - rect.top, MAX_H, box.height - (rect.top - box.top)))}px`;
    };
    const end = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  };
  grip.addEventListener('pointerdown', beginResize);
  minimize.addEventListener('click', () => {
    const minimized = overlay.dataset.minimized === 'true';
    overlay.dataset.minimized = String(!minimized);
    if (minimized) overlay.style.height = savedHeight;
    else { savedHeight = overlay.style.height; overlay.style.height = 'auto'; }
    minimize.setAttribute('aria-label', label(minimized ? 'Réduire' : 'Agrandir'));
  });
  close.addEventListener('click', () => { dismissed = true; render(); });
  toggle.addEventListener('click', tap);
  const rename = () => {
    setState(state);
    minimize.setAttribute('aria-label', label(overlay.dataset.minimized === 'true' ? 'Agrandir' : 'Réduire'));
    close.setAttribute('aria-label', label('Fermer'));
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
      header.removeEventListener('pointerdown', beginDrag);
      grip.removeEventListener('pointerdown', beginResize);
      clearTimeout(noteTimer);
      stopCamera(false);
      try { pc?.close(); } catch {}
      pc = null;
      remote.srcObject = null;
      toggle.dataset.state = 'idle';
      overlay.hidden = true;
    },
  };
}
