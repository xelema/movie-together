// Fournisseur Gemini (#44) : un seul appel generateContent par prise renvoie
// la transcription source et la traduction finale en JSON structuré. Le sens
// est fixé par la langue d'interface de l'orateur, jamais détecté par le
// modèle. La clé et le choix du modèle restent côté serveur. Sans clé
// configurée le service est absent et la capacité annonce indisponible,
// jamais simulée. La séance interrompt un appel encore en vol via le signal
// passé à translate (#46).
const MODEL = 'gemini-3.1-flash-lite';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const NAMES = { fr: 'French', ko: 'Korean' };

const promptFor = (source, target) =>
  `This audio holds one short spoken utterance in ${NAMES[source] ?? source}. ` +
  `Transcribe it exactly, then translate it into ${NAMES[target] ?? target}. ` +
  'Answer with the JSON fields only: "text", the exact transcription in the spoken ' +
  `language, and "translation", the translation into ${NAMES[target] ?? target}. No commentary.`;

// Le conteneur WAV déclare le format des trames s16 mono 16 kHz sans dépendre
// des paramètres MIME du PCM brut. La charge utile est copiée telle quelle.
const wavFor = pcm => {
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
};

export function createVoiceService({ env = process.env, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  if (!apiKey) return null;
  const model = env.GEMINI_MODEL || MODEL;
  return {
    async translate(pcm, { source, target, signal }) {
      const response = await fetchImpl(`${ENDPOINT}/${model}:generateContent`, {
        method: 'POST',
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)),
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [
            { inlineData: { mimeType: 'audio/wav', data: wavFor(pcm).toString('base64') } },
            { text: promptFor(source, target) },
          ] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: {
                text: { type: 'STRING', description: 'Exact transcription in the source language' },
                translation: { type: 'STRING', description: 'Translation into the target language' },
              },
              required: ['text', 'translation'],
              propertyOrdering: ['text', 'translation'],
            },
          },
        }),
      });
      if (!response.ok) throw new Error(`Gemini HTTP ${response.status}`);
      const payload = await response.json();
      const part = payload?.candidates?.[0]?.content?.parts?.find(item => typeof item.text === 'string');
      // Un JSON absent ou invalide est une faute fournisseur : la séance le
      // traduit en erreur locale, rien n'est diffusé.
      return JSON.parse(part?.text);
    },
  };
}
