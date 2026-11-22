// Réserve hors MSE : les segments qui suivent ce que hls.js a déjà demandé sont
// téléchargés à l'avance et gardés en mémoire, puis remis à hls.js sans réseau
// quand il les réclame. Le tampon MSE plafonne vers 150 Mo (bien moins sur une
// TV), soit 40 s d'un film à 30 Mbit/s : un creux du trajet Europe-Corée plus
// long coupait le film. La réserve tient plusieurs minutes et se remplit aussi
// pendant les pauses. Un segment manquant que hls.js réclame passe toujours
// devant : la réserve se tait tant qu'il n'est pas arrivé.
const MB = 1024 ** 2;
const KINDS = ['main', 'audio'];
const RETRY_AFTER_ERROR_MS = 5000;
// A stuck download must not hold a slot, nor a fragment hls.js waits for.
const FETCH_TIMEOUT_MS = 60_000;
// Init segments carry sn 'initSegment' and subtitles are tiny: neither is reserved.
const reserved = frag => KINDS.includes(frag?.type) && Number.isInteger(frag.sn);

// ponytail: mémoire seulement, plafond fixe par taille d'appareil. Passer par
// Cache Storage ou OPFS si une réserve de dizaines de minutes devient utile.
export const reserveBudget = memoryGb => memoryGb === undefined ? 384 * MB
  : memoryGb >= 8 ? 768 * MB : memoryGb >= 4 ? 384 * MB : memoryGb >= 2 ? 96 * MB : 0;

export const fetchBytes = (url, signal) =>
  fetch(url, { credentials: 'same-origin', signal }).then(response => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.arrayBuffer();
  });

export class Reserve {
  constructor({ fragments, fetch = fetchBytes, budget, ahead = 300, parallel = 2, now = () => performance.now() }) {
    Object.assign(this, { fragments, fetch, budget, ahead, parallel, now });
    this.entries = new Map();
    this.anchors = {};
    this.urgent = 0;
    this.pausedUntil = 0;
    this.hits = 0; this.misses = 0;
  }

  get bytes() { let total = 0; for (const entry of this.entries.values()) total += entry.bytes; return total; }

  // Seconds ready in a row after what hls.js last asked for, on the video track.
  get seconds() {
    const anchor = this.anchors.main, list = anchor && this.fragments('main', anchor.level);
    let total = 0;
    for (let i = (anchor?.sn ?? 0) - (list?.[0]?.sn ?? 0) + 1; list && i < list.length; i++) {
      if (!this.entries.get(list[i].url)?.data) break;
      total += list[i].duration;
    }
    return total;
  }

  // hls.js wants this fragment now: hand over what the reserve holds (ready or
  // still downloading), or null when hls.js must fetch it itself.
  take(frag) {
    if (!reserved(frag)) return null;
    const previous = this.anchors[frag.type];
    this.anchors[frag.type] = frag;
    const entry = this.entries.get(frag.url) ?? null;
    this.entries.delete(frag.url);
    if (previous && (frag.sn !== previous.sn + 1 || frag.level !== previous.level)) this.trim();
    if (!entry) { this.misses++; return null; }
    this.hits++;
    this.refill();
    return entry;
  }

  // Wraps a load hls.js runs itself: the reserve stays quiet until it lands.
  urgentLoad() {
    this.urgent++;
    let done = false;
    return () => { if (done) return; done = true; this.urgent--; this.refill(); };
  }

  wanted(frag) {
    const anchor = this.anchors[frag.type];
    return Boolean(anchor) && frag.level === anchor.level && frag.sn > anchor.sn && frag.start < anchor.start + this.ahead;
  }

  trim() {
    for (const [url, entry] of this.entries) if (!this.wanted(entry.frag)) { entry.abort?.(); this.entries.delete(url); }
  }

  next() {
    let best = null;
    for (const type of KINDS) {
      const anchor = this.anchors[type], list = anchor && this.fragments(type, anchor.level);
      if (!list?.length) continue;
      for (let i = anchor.sn - list[0].sn + 1; i < list.length; i++) {
        const frag = list[i];
        if (frag.start >= anchor.start + this.ahead) break;
        if (this.entries.has(frag.url)) continue;
        if (!best || frag.start < best.start) best = frag;
        break;
      }
    }
    return best;
  }

  refill() {
    if (this.destroyed || this.urgent || this.now() < this.pausedUntil) return;
    let inflight = 0;
    for (const entry of this.entries.values()) if (!entry.data) inflight++;
    while (inflight < this.parallel && this.bytes < this.budget) {
      const frag = this.next();
      if (!frag) return;
      this.start(frag);
      inflight++;
    }
  }

  start(frag) {
    const { url, sn, level, start, duration, type } = frag;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const entry = { frag: { url, sn, level, start, duration, type }, bytes: 0, data: null,
      timing: { start: this.now() }, abort: () => controller.abort() };
    entry.promise = this.fetch(url, controller.signal).finally(() => clearTimeout(timer)).then(data => {
      Object.assign(entry, { data, bytes: data.byteLength, abort: null });
      entry.timing.first = entry.timing.end = this.now();
      return entry;
    });
    entry.promise.catch(error => {
      if (this.entries.get(url) === entry) this.entries.delete(url);
      if (error?.name !== 'AbortError') this.pausedUntil = this.now() + RETRY_AFTER_ERROR_MS;
    }).finally(() => this.refill());
    this.entries.set(url, entry);
  }

  destroy() {
    this.destroyed = true;
    for (const entry of this.entries.values()) entry.abort?.();
    this.entries.clear();
  }
}

// hls.js fragment loader backed by the reserve. Fragments the reserve does not
// hold go to the stock loader, flagged urgent.
export function reserveLoader(Base, reserve, onTake) {
  return class ReserveLoader extends Base {
    load(context, config, callbacks) {
      const frag = context.frag;
      const whole = !context.rangeEnd;
      const entry = whole && reserved(frag) ? reserve.take(frag) : null;
      if (whole && reserved(frag)) onTake?.(frag, entry);
      if (!entry) return this.direct(context, config, callbacks);
      this.context = context; this.served = callbacks;
      // hls.js times its own loads out: a pending fragment gets the same limit,
      // then the stock loader takes over with hls.js's retry policy.
      const limit = config?.loadPolicy?.maxLoadTimeMs;
      const timer = !entry.data && limit && setTimeout(() => entry.abort?.(), limit);
      entry.promise.then(ready => {
        clearTimeout(timer);
        if (this.stats.aborted || this.served !== callbacks) return;
        Object.assign(this.stats.loading, ready.timing);
        this.stats.loaded = this.stats.total = ready.bytes;
        callbacks.onSuccess({ url: context.url, data: ready.data, code: 200 }, this.stats, context, null);
      }, () => {
        clearTimeout(timer);
        if (this.stats.aborted || this.served !== callbacks) return;
        this.served = null;
        this.direct(context, config, callbacks);
      });
    }

    direct(context, config, callbacks) {
      if (context.rangeEnd || !reserved(context.frag)) return super.load(context, config, callbacks);
      const done = reserve.urgentLoad();
      const wrap = name => callbacks[name] && ((...args) => { done(); return callbacks[name](...args); });
      this.release = done;
      super.load(context, config, { ...callbacks, onSuccess: wrap('onSuccess'), onError: wrap('onError'),
        onTimeout: wrap('onTimeout'), onAbort: wrap('onAbort') });
    }

    abort() {
      this.release?.();
      if (!this.served) return super.abort();
      this.stats.aborted = true;
      this.served.onAbort?.(this.stats, this.context, null);
    }

    destroy() {
      this.release?.();
      this.stats.aborted = true;
      super.destroy();
    }
  };
}
