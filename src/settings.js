// Réglages opérationnels que l'administrateur modifie à chaud depuis la page
// admin. `category` groupe l'écran, `env` fournit un défaut de déploiement,
// `dynamic` marque les seuils repris par les séances déjà ouvertes. Tout autre
// réglage ne vaut que pour les nouvelles opérations : une séance, une session
// ou un envoi gardent les paramètres qui définissaient leur comportement, et
// les cadences globales (tickMs, sweepMs) ne sont relues qu'au démarrage.
export const FIELDS = {
  minBuffer:            { category: 'sync',     env: 'MIN_BUFFER_SECONDS', def: 4,     min: 2,    max: 300,    unit: 's', dynamic: true },
  lowBuffer:            { category: 'sync',     env: 'LOW_BUFFER_SECONDS', def: 2,     min: 1,    max: 299,    unit: 's', dynamic: true },
  backBufferSeconds:    { category: 'sync',     env: 'BACK_BUFFER_SECONDS', def: 5,    min: 0,    max: 120,    unit: 's', dynamic: true },
  maxBufferMb:          { category: 'sync',     env: 'MAX_BUFFER_MB', def: 50,   min: 20,   max: 250,    unit: 'Mo', dynamic: true },
  reportTimeout:        { category: 'sync',     def: 3,     min: 1,   max: 60,     unit: 's' },
  startDelay:           { category: 'sync',     def: 1,     min: 0.5, max: 30,     unit: 's', step: 0.1 },
  tickMs:               { category: 'sync',     def: 200,   min: 50,  max: 2000,   unit: 'ms' },
  sweepMs:              { category: 'sync',     def: 10000, min: 1000,max: 120000, unit: 'ms' },
  ttlHours:             { category: 'rooms',    def: 12,    min: 1,   max: 168,    unit: 'h' },
  maxRooms:             { category: 'rooms',    def: 20,    min: 1,   max: 100 },
  maxClients:           { category: 'rooms',    def: 8,     min: 1,   max: 32 },
  maxSocketsPerSession: { category: 'rooms',    def: 2,     min: 1,   max: 8 },
  chunkMb:              { category: 'uploads',  def: 8,     min: 1,   max: 64,     unit: 'Mo' },
  maxPending:           { category: 'uploads',  def: 2,     min: 1,   max: 10 },
  maxMovieGb:           { category: 'uploads',  def: 20,    min: 1,   max: 200,    unit: 'Go' },
  maxSubtitleMb:        { category: 'uploads',  def: 2,     min: 0.5, max: 50,     unit: 'Mo', step: 0.5 },
  maxExternalTracks:    { category: 'uploads',  def: 24,    min: 1,   max: 96 },
  encodeThreads:        { category: 'media',    env: 'ENCODE_THREADS', def: 2, min: 1, max: 8 },
  segmentSeconds:       { category: 'media',    def: 4,     min: 1,   max: 15,     unit: 's' },
  loginLimit:           { category: 'security', def: 10,    min: 1,   max: 1000 },
  inviteLimit:          { category: 'security', def: 20,    min: 1,   max: 1000 },
  voiceQuota:           { category: 'voice',    def: 3,     min: 1,   max: 30 },
  voiceWindow:          { category: 'voice',    def: 60,    min: 10,  max: 600,   unit: 's' },
  voiceCooldown:        { category: 'voice',    def: 2,     min: 0,   max: 60,    unit: 's' },
};

// Contraintes entre champs, vérifiées sur les valeurs fusionnées : un PATCH
// partiel ne doit pas pouvoir laisser la configuration dans un état invalide.
const RULES = [
  { keys: ['minBuffer', 'lowBuffer'],
    test: values => values.minBuffer > values.lowBuffer,
    message: 'Seuils invalides : 1 ≤ réserve < démarrage ≤ 300 s.' },
  { keys: ['startDelay', 'reportTimeout'],
    test: values => values.startDelay < values.reportTimeout,
    message: 'Réglages invalides : le délai de départ doit rester sous le délai de rapport.' },
];

const fail = (status, message) => Object.assign(new Error(message), { status });
const valid = (field, value) => Number.isFinite(value) && value >= field.min && value <= field.max &&
  (field.step === undefined ? Number.isInteger(value)
    : Math.abs(value / field.step - Math.round(value / field.step)) < 1e-6);
const check = values => { for (const rule of RULES) if (!rule.test(values)) throw fail(400, rule.message); };

export function createSettings({ env = {}, saved = {} } = {}) {
  const defaults = {}, overrides = {};
  for (const [key, field] of Object.entries(FIELDS)) {
    defaults[key] = field.def;
    if (field.env === undefined || env[field.env] === undefined) continue;
    const parsed = Number(env[field.env]);
    if (valid(field, parsed)) defaults[key] = parsed;
    else console.warn(`[settings] ${field.env}=${env[field.env]} hors limites, défaut ${field.def} conservé.`);
  }
  // Un env qui casse une règle croisée retombe sur les défauts des clés liées.
  for (const rule of RULES) {
    if (rule.test(defaults)) continue;
    for (const key of rule.keys) defaults[key] = FIELDS[key].def;
    console.warn(`[settings] valeurs d'environnement incompatibles (${rule.keys.join(', ')}), défauts conservés.`);
  }
  for (const [key, value] of Object.entries(saved ?? {})) {
    const field = FIELDS[key];
    if (field && valid(field, value)) overrides[key] = value;
  }
  const merged = () => ({ ...defaults, ...overrides });
  try { check(merged()); } catch {
    for (const rule of RULES) for (const key of rule.keys) delete overrides[key];
    console.warn('[settings] seuils enregistrés incompatibles ignorés.');
  }
  return {
    get: key => overrides[key] ?? defaults[key],
    values: merged,
    defaults: () => ({ ...defaults }),
    overrides: () => ({ ...overrides }),
    describe: () => Object.entries(FIELDS).map(([key, field]) => ({
      key, ...field, def: undefined, default: defaults[key],
      overridden: key in overrides, value: overrides[key] ?? defaults[key] })),
    update(patch = {}) {
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw fail(400, 'Réglages invalides.');
      const next = { ...overrides };
      for (const [key, value] of Object.entries(patch)) {
        const field = FIELDS[key];
        if (!field) throw fail(400, 'Réglage inconnu.');
        if (!valid(field, value)) throw fail(400, `Valeur invalide pour ${key}.`);
        next[key] = value;
      }
      check({ ...defaults, ...next });
      for (const key of Object.keys(overrides)) delete overrides[key];
      Object.assign(overrides, next);
      return merged();
    },
    reset() {
      for (const key of Object.keys(overrides)) delete overrides[key];
      return merged();
    },
  };
}
