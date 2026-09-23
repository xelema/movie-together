// Prise de parole côté client : un appui demande la prise, un second la clôt.
// Le micro et l'AudioContext s'arment dans le geste même : iOS suspend tout
// contexte audio né hors appui. La permission n'est jamais demandée à
// l'entrée de la séance. États intermédiaires et erreurs restent locaux.
const LISTEN_MS = 20_000, PROCESS_GRACE_MS = 15_000, RESULT_MS = 8_000;
// Chaque état porte un nom annoncé : le bouton reste le seul contrôle et les
// lecteurs d'écran entendent la transition comme les voyants voient la couleur.
const STATE_NAMES = {
  idle: ['Parler', '말하기'],
  starting: ['Activation du micro…', '마이크 켜는 중…'],
  listening: ['Écoute en cours, appuyer pour terminer', '듣는 중입니다. 눌러서 마치기'],
  processing: ['Traduction en cours…', '번역 중…'],
  error: ['Réessayer de parler', '다시 말하기'],
};

export function attachVoice({ mic, local, supertitle, player, t, label }) {
  let state = 'idle', utterance = null, lastResultSeq = 0;
  let stream = null, audioContext = null, source = null, worklet = null;
  let listenTimer = null, watchdog = null, hardware = null, armSeq = 0;

  const show = (node, text, ms = 0) => {
    node.textContent = text;
    node.hidden = false;
    clearTimeout(node.hideTimer);
    if (ms) node.hideTimer = setTimeout(() => { node.hidden = true; }, ms);
  };
  const setState = next => {
    state = next;
    mic.dataset.state = next;
    mic.setAttribute('aria-pressed', String(next === 'listening'));
    const [fr, ko] = STATE_NAMES[next] ?? STATE_NAMES.idle;
    mic.setAttribute('aria-label', t(fr, ko));
  };
  const stopCapture = () => {
    clearTimeout(listenTimer);
    // Les noeuds ne sont branchés qu'à l'accord : une déconnexion sans lien
    // lève InvalidAccessError sur certains moteurs.
    try { worklet?.disconnect(); source?.disconnect(); } catch {}
    worklet = source = null;
    // Le flux reste ouvert pour éviter de redemander la permission, mais
    // muet en dehors de l'écoute : aucun échantillon ne peut circuler.
    stream?.getAudioTracks().forEach(track => { track.enabled = false; });
    if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
  };
  const fail = text => {
    utterance = null;
    // Une prise armée mais non branchée (starting) est démontée aussi : le
    // graphe est libéré et la piste rendue muette. Fermer le contexte peut
    // faire échouer un armement encore en vol ; son erreur, plus tardive,
    // n'écrase pas celle affichée ici.
    if (state === 'listening' || state === 'starting') stopCapture();
    clearTimeout(watchdog);
    setState(text ? 'error' : 'idle');
    if (text) { delete local.dataset.kind; show(local, text); }
  };
  const abort = text => {
    if (utterance) player.send({ type: 'voice', action: 'cancel' });
    fail(text);
  };
  // Le matériel s'arme dès l'appui mais aucune trame ne part avant l'accord :
  // la source n'est branchée qu'à la réception de 'started'. En cas de refus
  // le flux reste prêt et évite une nouvelle demande de permission.
  const beginCapture = async seq => {
    const stale = () => seq !== armSeq;
    try {
      audioContext ??= new AudioContext();
      const granted = stream ?? await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      // Une permission résolue après une demande plus récente produirait un flux
      // orphelin encore actif : il est arrêté plutôt qu'adopté.
      if (stale()) {
        if (granted !== stream) granted.getTracks().forEach(track => track.stop());
        return false;
      }
      stream = granted;
      // La piste n'est active que pendant l'écoute : elle reste muette tant que
      // la séance n'a pas accordé la prise, et après un refus arrivé entre-temps.
      stream.getAudioTracks().forEach(track => { track.enabled = false; });
      if (!worklet) {
        await audioContext.audioWorklet.addModule('/voice-worklet.js');
        // Un armement périmé ne branche rien : la prise plus récente reconstruit
        // ses propres noeuds au prochain appui.
        if (stale()) return false;
        source = audioContext.createMediaStreamSource(stream);
        worklet = new AudioWorkletNode(audioContext, 'voice-pcm');
        // Le seuil de bufferedAmount décidé dans #39 arrête la prise proprement :
        // aucune trame n'est perdue silencieusement et la page ne se bloque pas.
        worklet.port.onmessage = event => {
          if (!player.sendFrame(event.data)) abort(t('Connexion lente, prise interrompue.', '연결이 느려 발화를 중단했습니다.'));
        };
      }
      return true;
    } catch (error) {
      // Un armement partiel est démonté : piste muette, contexte libéré, le
      // flux garde la permission pour l'essai suivant.
      stopCapture();
      // Un refus déjà affiché (occupé, quota…) prime une panne matérielle tardive.
      if (state !== 'error') {
        show(local, error.name === 'NotAllowedError'
          ? t('Micro refusé.', '마이크 사용이 거부되었습니다.')
          : t('Micro indisponible.', '마이크를 사용할 수 없습니다.'));
        setState('error');
      }
      return false;
    }
  };
  const stopSpeaking = () => {
    if (state !== 'listening') return;
    stopCapture();
    player.send({ type: 'voice', action: 'stop' });
    setState('processing');
    clearTimeout(watchdog);
    watchdog = setTimeout(() => abort(t('La traduction a expiré.', '번역 시간이 초과되었습니다.')), PROCESS_GRACE_MS);
  };
  const tap = () => {
    if (state === 'listening') return stopSpeaking();
    if (state !== 'idle' && state !== 'error') return;
    hardware = beginCapture(++armSeq);
    // La langue d'interface au moment de l'appui fixe le sens de la prise :
    // le serveur la fige, un changement de langue en cours d'écoute n'y
    // touche pas.
    player.send({ type: 'voice', action: 'start', lang: t('fr', 'ko') });
    setState('starting');
  };
  const message = async event => {
    if (!event) return abort();
    if (event.state === 'started') {
      // Une prise accordée sans demande en cours est refermée tout de suite.
      if (state !== 'starting') return player.send({ type: 'voice', action: 'cancel' });
      utterance = event.utterance;
      local.hidden = true;
      delete local.dataset.kind;
      // L'état a pu changer pendant l'armement du micro : une fermeture ou un
      // échec arrivé entre-temps rend la prise morte, on la referme côté serveur.
      const armed = state === 'starting' && await hardware;
      if (!armed || state !== 'starting') {
        player.send({ type: 'voice', action: 'cancel' });
        utterance = null;
        return;
      }
      stream.getAudioTracks().forEach(track => { track.enabled = true; });
      source.connect(worklet);
      worklet.connect(audioContext.destination);
      listenTimer = setTimeout(stopSpeaking, LISTEN_MS);
      setState('listening');
      return;
    }
    if (event.state === 'failed') {
      // Un échec identifié ne vaut que pour la prise courante ; un refus sans
      // identifiant ne s'applique qu'à une demande en attente d'accord.
      if (event.utterance ? event.utterance !== utterance : state !== 'starting') return;
      const suffix = event.retryAfter ? t(` · ${Math.ceil(event.retryAfter)} s`, ` · ${Math.ceil(event.retryAfter)}초`) : '';
      fail(event.message ? label(event.message) + suffix : undefined);
      return;
    }
    if (event.state === 'understood') {
      // Le texte compris reste local, en italique et sans préfixe (#47).
      if (event.utterance === utterance) { local.dataset.kind = 'transcript'; show(local, event.text, RESULT_MS); }
      return;
    }
    if (event.state === 'result') {
      // Un résultat périmé ou réordonné ne remplace jamais un surtitre plus récent.
      if (event.seq <= lastResultSeq) return;
      lastResultSeq = event.seq;
      fail();
      show(supertitle, `${event.speaker} · ${event.text}`, RESULT_MS);
    }
  };
  mic.addEventListener('click', tap);
  return {
    message,
    rename: () => setState(state),
    dispose() {
      mic.removeEventListener('click', tap);
      // Une permission encore en vol est périmée : son flux sera arrêté.
      armSeq++;
      abort();
      stream?.getTracks().forEach(track => track.stop());
      stream = null;
      audioContext?.close().catch(() => {}); audioContext = null;
      mic.dataset.state = 'idle';
    },
  };
}
