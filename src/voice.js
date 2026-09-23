// Fournisseur Gemini (#44) : un seul appel generateContent par prise renvoie
// langue source, transcription et traduction en JSON structuré. La clé et le
// choix du modèle restent côté serveur ; sans clé configurée le service est
// absent et la capacité annonce indisponible, jamais simulée.
const MODEL = 'gemini-3.1-flash-lite';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const NAMES = { fr: 'French', ko: 'Korean' };

const promptFor = pair =>
  `This audio holds one short spoken utterance in ${NAMES[pair[0]] ?? pair[0]} or ${NAMES[pair[1]] ?? pair[1]}. ` +
  'Detect the language actually spoken and answer with the JSON fields only: ' +
  '"language", the ISO 639-1 code of the utterance (it may be neither language of the pair); ' +
  '"text", the exact transcription in that language; ' +
  `"translation", the translation into the other language of the pair (${pair[0]} -> ${pair[1]} or ${pair[1]} -> ${pair[0]}). ` +
  `If the utterance is in neither language, translate into ${NAMES[pair[0]] ?? pair[0]}. No commentary.`;

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
            { inlineData: { mimeType: 'audio/L16;codec=pcm;rate=16000', data: pcm.toString('base64') } },
            { text: promptFor(pair) },
          ] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: {
                language: { type: 'STRING', description: 'ISO 639-1 code of the spoken language' },
                text: { type: 'STRING', description: 'Transcription in the source language' },
                translation: { type: 'STRING', description: 'Translation into the other language of the pair' },
              },
              required: ['language', 'text', 'translation'],
              propertyOrdering: ['language', 'text', 'translation'],
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
