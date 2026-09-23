// Fournisseur Gemini (#44) : un seul appel generateContent par prise renvoie
// langue source, transcription, langue cible, traduction et certitude en JSON
// structuré. La clé et le choix du modèle restent côté serveur ; sans clé
// configurée le service est absent et la capacité annonce indisponible,
// jamais simulée.
const MODEL = 'gemini-3.1-flash-lite';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const NAMES = { fr: 'French', ko: 'Korean' };

const promptFor = pair =>
  `This audio holds one short spoken utterance in ${NAMES[pair[0]] ?? pair[0]} or ${NAMES[pair[1]] ?? pair[1]}. ` +
  'Detect the language actually spoken and answer with the JSON fields only: ' +
  '"language", the ISO 639-1 code of the utterance (it may be neither language of the pair); ' +
  '"text", the exact transcription in that language; ' +
  `"target", the ISO 639-1 code of the language translated into (one of the pair: ${pair[0]} or ${pair[1]}); ` +
  '"translation", the translation into the target language; ' +
  '"confidence", your certainty in the detected language between 0 and 1. ' +
  `If the utterance is in neither language, translate into ${NAMES[pair[0]] ?? pair[0]}. No commentary.`;

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
    async translate(pcm, { pair }) {
      const response = await fetchImpl(`${ENDPOINT}/${model}:generateContent`, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [
            { inlineData: { mimeType: 'audio/wav', data: wavFor(pcm).toString('base64') } },
            { text: promptFor(pair) },
          ] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: {
                language: { type: 'STRING', description: 'ISO 639-1 code of the spoken language' },
                text: { type: 'STRING', description: 'Transcription in the source language' },
                target: { type: 'STRING', description: 'ISO 639-1 code of the language translated into' },
                translation: { type: 'STRING', description: 'Translation into the target language' },
                confidence: { type: 'NUMBER', description: 'Certainty in the detected language, 0 to 1' },
              },
              required: ['language', 'text', 'target', 'translation', 'confidence'],
              propertyOrdering: ['language', 'text', 'target', 'translation', 'confidence'],
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
