// Fournisseur Gemini Live Translate : chaque prise ouvre une session
// WebSocket BidiGenerateContent (v1beta), y pousse le PCM 16 kHz et lit la
// traduction au fil de l'eau dans outputTranscription. Le sens est fixé par
// la langue d'interface de l'orateur (targetLanguageCode), la langue source
// reste détectée par le modèle. La clé reste côté serveur et n'apparaît ni
// dans les journaux ni dans les erreurs remontées. Sans clé configurée le
// service est absent et la capacité annonce indisponible, jamais simulée.
import { WebSocket } from 'ws';

const MODEL = 'gemini-3.5-live-translate-preview';
const ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const RATE = 16000;
// Le modèle ne termine sa traduction que s'il continue à recevoir de l'audio :
// activity_end et audio_stream_end coupent la fin. Comme dans le POC bouton.py,
// l'arrêt pousse 2 s de silence d'un coup, en morceaux de 50 ms.
const FLUSH = Buffer.alloc(RATE * 2 * 2);
const FLUSH_CHUNK = RATE * 2 / 20;

// La consigne décrit la relation et impose le registre, jamais le contexte
// (mentionner le film fait réécrire les phrases, mesuré dans le POC). Sur ce
// modèle preview elle n'est pas documentée : elle force le banmal en pratique
// mais Google peut cesser de l'appliquer, c'est la première chose à vérifier
// si le registre redevient poli.
const PROMPTS = {
  ko: 'You interpret between close friends. Translate each spoken utterance into natural spoken Korean banmal, the way close friends talk. Never use jondaemal: no -yo, no -seumnida, no dangsin, no jeo/je. Be faithful: translate exactly what is said, never add, drop or change details. Keep questions as questions.',
  fr: 'You interpret between close friends. Translate each spoken utterance into natural, friendly spoken French. Be faithful: translate exactly what is said, never add, drop or change details. Keep questions as questions.',
  vi: 'You interpret between close friends. The French man is named the French speaker. Translate each spoken utterance into natural, friendly spoken Vietnamese, the way close friends talk. Be faithful: translate exactly what is said, never add, drop or change details. Keep questions as questions.',
};

export function createVoiceService({ env = process.env, connect } = {}) {
  const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  if (!apiKey) return null;
  const model = env.GEMINI_MODEL || MODEL;
  const open = connect ?? (url => new WebSocket(url));
  return {
    // Une session par prise : send() empile tant que setupComplete n'est pas
    // arrivé (l'audio capté pendant la connexion part d'un coup), flush()
    // termine la phrase, close() interrompt tout. Les textes remontent par
    // onText (traduction) et onSource (transcription), la fin par onEnd.
    openSession({ source, target }) {
      const ws = open(`${ENDPOINT}?key=${apiKey}`);
      const session = { onText: null, onSource: null, onEnd: null };
      let ready = false, ended = false;
      const pending = [];
      // Une fin quelconque efface l'audio encore en file : les copies
      // n'attendent pas le ramasse-miettes.
      const finish = error => {
        if (ended) return;
        ended = true;
        for (const pcm of pending.splice(0)) pcm.fill(0);
        session.onEnd?.(error);
      };
      // Un socket mourant refuse la trame (CLOSING/CLOSED) : même panne
      // générique qu'une erreur distante, jamais de détail remonté.
      const sendAudio = pcm => {
        try {
          ws.send(JSON.stringify({
            realtimeInput: { audio: { data: pcm.toString('base64'), mimeType: `audio/pcm;rate=${RATE}` } } }));
        } catch { finish(new Error('provider error')); }
      };
      ws.on('open', () => ws.send(JSON.stringify({ setup: {
        model: `models/${model}`,
        // Nids mélangés, mesurés sur la vraie poignée de main (sans audio) :
        // la traduction va dans generationConfig, les transcriptions au
        // niveau setup. generationConfig.inputAudioTranscription et
        // setup.translationConfig sont tous deux refusés en 1007.
        generationConfig: {
          responseModalities: ['AUDIO'],
          translationConfig: { targetLanguageCode: target, echoTargetLanguage: false },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: { parts: [{ text: PROMPTS[target] ?? PROMPTS.ko }] },
      } })));
      ws.on('message', data => {
        let message;
        try { message = JSON.parse(data); } catch { return; }
        // Le détail fournisseur ne remonte jamais : il pourrait citer l'URL
        // signée. La séance traduit tout en panne générique.
        if (message.error) return finish(new Error('provider error'));
        if (message.setupComplete !== undefined) {
          ready = true;
          for (const pcm of pending.splice(0)) sendAudio(pcm);
          return;
        }
        const content = message.serverContent;
        if (!content) return;
        if (content.outputTranscription?.text) session.onText?.(content.outputTranscription.text);
        if (content.inputTranscription?.text) session.onSource?.(content.inputTranscription.text);
      });
      ws.on('error', () => finish(new Error('provider error')));
      ws.on('close', () => finish(null));
      session.send = pcm => {
        if (ended) return;
        // La copie isole la file d'attente : l'appelant peut effacer sa trame
        // d'origine sans vider l'audio encore retenu côté fournisseur.
        if (ready) sendAudio(pcm);
        else pending.push(Buffer.from(pcm));
      };
      session.flush = () => {
        for (let i = 0; i < FLUSH.length; i += FLUSH_CHUNK) session.send(FLUSH.subarray(i, i + FLUSH_CHUNK));
      };
      session.close = () => {
        ended = true;
        for (const pcm of pending.splice(0)) pcm.fill(0);
        try { ws.terminate(); } catch {}
      };
      return session;
    },
  };
}
