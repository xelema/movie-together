// Prise de parole côté client : un appui demande la prise, un second la clôt.
// Le micro et l'AudioContext s'arment dans le geste même : iOS suspend tout
// contexte audio né hors appui. La permission n'est jamais demandée à
// l'entrée de la séance. États intermédiaires et erreurs restent locaux.
import { language } from './labels.js';

const LISTEN_MS = 20_000, PROCESS_GRACE_MS = 15_000, RESULT_MS = 8_000;
// Chaque état porte un nom annoncé : le bouton reste le seul contrôle et les
// lecteurs d'écran entendent la transition comme les voyants voient la couleur.
const STATE_NAMES = {
  idle: ['Parler', '말하기', 'Nói'],
  starting: ['Activation du micro…', '마이크 켜는 중…', 'Đang bật micro…'],
  listening: ['Écoute en cours, appuyer pour terminer', '듣는 중입니다. 눌러서 마치기', 'Đang nghe, nhấn để kết thúc'],
  processing: ['Traduction en cours…', '번역 중…', 'Đang dịch…'],
  error: ['Réessayer de parler', '다시 말하기', 'Thử nói lại'],
};

export function attachVoice({ mic, local, supertitle, player, t, label, onEvent }) {
  let state = 'idle', utterance = null, shownSeq = 0, shownRev = 0, shownFinal = false;
  let stream = null, audioContext = null, source = null, worklet = null, analyser = null;
  let listenTimer = null, watchdog = null, hardware = null, armSeq = 0, spectrumRaf = 0;
  let spectrumBins = null;
  // Télémétrie : transitions, compteurs de trames et latence du fournisseur.
  // Jamais de texte transcrit ou traduit : longueurs et compteurs uniquement.
  let tapAt = 0;
  const sent = { frames: 0, bytes: 0, refused: 0 };
  const emit = fields => { try { onEvent?.('voice', fields); } catch { } };
  const since = () => tapAt ? Math.round(performance.now() - tapAt) : undefined;

  const show = (node, text, ms = 0) => {
    node.textContent = text;
    node.hidden = false;
    clearTimeout(node.hideTimer);
    if (ms) node.hideTimer = setTimeout(() => { node.hidden = true; }, ms);
  };
  const setState = (next, err) => {
    const changed = next !== state;
    state = next;
    if (changed) emit({ state: next, err, ...(next === 'processing' ? { frames: sent.frames, bytes: sent.bytes, refused: sent.refused } : {}) });
    mic.dataset.state = next;
    mic.setAttribute('aria-pressed', String(next === 'listening'));
    const [fr, ko, vi] = STATE_NAMES[next] ?? STATE_NAMES.idle;
    mic.setAttribute('aria-label', t(fr, ko, vi));
  };
  // Pendant l'écoute le bouton devient un rond rouge : quatre barres blanches
  // animées par le niveau réel du micro prouvent que la capture fonctionne.
  const spectrumOff = () => {
    if (spectrumRaf) { cancelAnimationFrame(spectrumRaf); spectrumRaf = 0; }
    mic.querySelectorAll?.('.voice-bar')?.forEach(bar => { bar.style.height = ''; });
  };
  const spectrumOn = () => {
    const bars = mic.querySelectorAll?.('.voice-bar');
    if (!analyser || !bars?.length) return;
    spectrumBins ??= new Uint8Array(analyser.frequencyBinCount);
    // Quatre bandes calées sur les formants de la voix, en indices de bins
    // calculés sur le sampleRate réel : le grave sous 180 Hz est écarté (il
    // sature tout), les bandes hautes reçoivent un poids qui compense leur
    // énergie brute plus faible.
    const hz = (audioContext?.sampleRate || 48000) / analyser.fftSize;
    const bands = [[180, 450, .65], [450, 1000, .95], [1000, 2100, 1.2], [2100, 4000, 1.4]]
      .map(([lo, hi, w]) => [Math.max(1, Math.round(lo / hz)), Math.min(spectrumBins.length - 1, Math.round(hi / hz)), w]);
    const tick = () => {
      if (state !== 'listening' || !analyser) return;
      analyser.getByteFrequencyData(spectrumBins);
      let sum = 0;
      const peaks = bands.map(([from, to, w]) => {
        let peak = 0;
        for (let j = from; j <= to; j++) peak = Math.max(peak, spectrumBins[j]);
        const gated = peak < 50 ? 0 : Math.min(1, (peak - 50) / 180 * w);
        sum += gated;
        return gated;
      });
      // Un quart de l'énergie moyenne irrigue chaque barre : pendant la parole
      // toutes s'animent sans que la bande grave reste collée au maximum.
      const share = sum / bands.length * .25;
      for (let i = 0; i < bars.length; i++) {
        const level = Math.min(1, peaks[i] * .75 + share);
        // Hauteur entière en px : un transform scaleY laissait des traînées
        // de rasterisation au bord demi-pixel de la première barre.
        const h = `${Math.round(4 + level * 16)}px`;
        if (bars[i].style.height !== h) bars[i].style.height = h;
      }
      spectrumRaf = requestAnimationFrame(tick);
    };
    tick();
  };
  const stopCapture = () => {
    clearTimeout(listenTimer);
    spectrumOff();
    // Les noeuds ne sont branchés qu'à l'accord : une déconnexion sans lien
    // lève InvalidAccessError sur certains moteurs.
    try { worklet?.disconnect(); source?.disconnect(); analyser?.disconnect(); } catch {}
    worklet = source = analyser = null;
    // Le flux reste ouvert pour éviter de redemander la permission, mais
    // muet en dehors de l'écoute : aucun échantillon ne peut circuler.
    stream?.getAudioTracks().forEach(track => { track.enabled = false; });
    if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
  };
  const fail = text => {
    utterance = null;
    // Une prise armée mais non branchée (starting) est démontée aussi : le
    // graphe est libéré et la piste rendue muette. Fermer le contexte peut
    // faire échouer un armement encore en vol. Son erreur, plus tardive,
    // n'écrase pas celle affichée ici.
    if (state === 'listening' || state === 'starting') stopCapture();
    clearTimeout(watchdog);
    setState(text ? 'error' : 'idle');
    // Les erreurs locales s'effacent comme les resultats : meme fenetre,
    // meme minuteur, sans jamais emporter la carte qui les remplace.
    if (text) { delete local.dataset.kind; show(local, text, RESULT_MS); }
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
        // L'analyseur observe la source sans sortie pour le spectrogramme. Un
        // contexte sans createAnalyser (doublure de test) ne fait pas échouer
        // la prise : le bouton reste rouge, les barres simplement fixes.
        analyser = audioContext.createAnalyser?.() ?? null;
        if (analyser) { analyser.fftSize = 512; analyser.minDecibels = -85; analyser.maxDecibels = -28; analyser.smoothingTimeConstant = .5; }
        // Le seuil de bufferedAmount décidé dans #39 arrête la prise proprement :
        // aucune trame n'est perdue silencieusement et la page ne se bloque pas.
        worklet.port.onmessage = event => {
          sent.frames++; sent.bytes += event.data?.byteLength ?? 0;
          if (!player.sendFrame(event.data)) {
            sent.refused++;
            emit({ err: 'send-buffer', refused: sent.refused, frames: sent.frames, bytes: sent.bytes });
            abort(t('Connexion lente, prise interrompue.', '연결이 느려 발화를 중단했습니다.', 'Kết nối chậm, đã ngắt lượt nói.'));
          }
        };
      }
      return true;
    } catch (error) {
      emit({ state: 'error', err: error.name, ms: since() });
      // Un armement partiel est démonté : piste muette, contexte libéré, le
      // flux garde la permission pour l'essai suivant.
      stopCapture();
      // Un refus déjà affiché (occupé, quota…) prime une panne matérielle tardive.
      if (state !== 'error') {
        show(local, error.name === 'NotAllowedError'
          ? t('Micro refusé.', '마이크 사용이 거부되었습니다.', 'Quyền micro bị từ chối.')
          : t('Micro indisponible.', '마이크를 사용할 수 없습니다.', 'Micro không khả dụng.'), RESULT_MS);
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
    watchdog = setTimeout(() => abort(t('La traduction a expiré.', '번역 시간이 초과되었습니다.', 'Bản dịch đã hết thời gian.')), PROCESS_GRACE_MS);
  };
  const tap = () => {
    if (state === 'listening') return stopSpeaking();
    if (state !== 'idle' && state !== 'error') return;
    hardware = beginCapture(++armSeq);
    tapAt = performance.now();
    sent.frames = 0; sent.bytes = 0; sent.refused = 0;
    // La langue d'interface au moment de l'appui fixe le sens de la prise :
    // le serveur la fige, un changement de langue en cours d'écoute n'y
    // touche pas.
    player.send({ type: 'voice', action: 'start', lang: language() });
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
      emit({ state: 'started', ms: since(), armMs: since(), sr: audioContext?.sampleRate });
      stream.getAudioTracks().forEach(track => { track.enabled = true; });
      source.connect(worklet);
      if (analyser) source.connect(analyser);
      worklet.connect(audioContext.destination);
      listenTimer = setTimeout(stopSpeaking, LISTEN_MS);
      setState('listening');
      spectrumOn();
      return;
    }
    if (event.state === 'failed') {
      // Un échec identifié ne vaut que pour la prise courante. Un refus sans
      // identifiant ne s'applique qu'à une demande en attente d'accord.
      if (event.utterance ? event.utterance !== utterance : state !== 'starting') return;
      emit({ state: 'failed', err: String(event.error ?? event.message ?? '').slice(0, 120) || undefined, retryAfter: event.retryAfter });
      const suffix = event.retryAfter ? t(` · ${Math.ceil(event.retryAfter)} s`, ` · ${Math.ceil(event.retryAfter)}초`, ` · ${Math.ceil(event.retryAfter)} giây`) : '';
      fail(event.message ? label(event.message) + suffix : undefined);
      return;
    }
    if (event.state === 'heard' || event.state === 'understood') {
      // Le texte compris reste local, en italique et sans préfixe (#47). Il
      // arrive au fil de l'eau ('heard') puis en version finale ('understood').
      if (event.utterance === utterance) { local.dataset.kind = 'transcript'; show(local, event.text, RESULT_MS); emit({ state: event.state, seq: event.seq, heard: event.text?.length, ms: since() }); }
      return;
    }
    if (event.state === 'partial') {
      // Surtitre partagé incrémental : la séquence et la révision du serveur
      // ordonnent les fragments, un message périmé ne réécrit jamais l'affiché.
      if (event.seq < shownSeq || (event.seq === shownSeq && (shownFinal || event.rev <= shownRev))) return;
      if (event.seq > shownSeq) shownFinal = false;
      shownSeq = event.seq; shownRev = event.rev;
      emit({ state: 'partial', seq: event.seq, rev: event.rev, len: event.text?.length, partialMs: since() });
      show(supertitle, event.text, RESULT_MS);
      return;
    }
    if (event.state === 'withdrawn') {
      // Une phrase en échec est retirée chez tous tant qu'aucun résultat
      // définitif ne l'a remplacée.
      if (event.seq === shownSeq && !shownFinal) { clearTimeout(supertitle.hideTimer); supertitle.hidden = true; }
      emit({ state: 'withdrawn', seq: event.seq });
      return;
    }
    if (event.state === 'result') {
      // Le résultat fige le surtitre : un fragment plus ancien ni un résultat
      // périmé ne le remplacent ensuite.
      if (event.seq < shownSeq || (event.seq === shownSeq && shownFinal)) return;
      shownSeq = event.seq; shownFinal = true;
      emit({ state: 'result', seq: event.seq, result: event.text?.length, ms: since() });
      if (!event.utterance || event.utterance === utterance || state === 'processing' || state === 'listening') fail();
      show(supertitle, event.text, RESULT_MS);
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
