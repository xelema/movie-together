import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Reserve, reserveBudget, reserveLoader } from '../public/reserve.js';

const MB = 1024 ** 2;
const track = (type, level, count, duration = 4) => Array.from({ length: count }, (_, sn) =>
  ({ url: `${type}${level}_${sn}`, sn, level, type, start: sn * duration, duration }));
const created = [];
afterEach(() => { for (const reserve of created.splice(0)) reserve.destroy(); });
const tick = () => new Promise(resolve => setImmediate(resolve));

const setup = ({ budget = 100 * MB, ahead = 300, parallel = 2, size = MB } = {}) => {
  let clock = 0;
  const lists = { main: track('main', 0, 100), audio: track('audio', 0, 100) };
  const pending = new Map();
  const fetch = (url, signal) => new Promise((resolve, reject) => {
    pending.set(url, { resolve: () => resolve(new ArrayBuffer(size)), reject });
    signal.addEventListener('abort', () => pending.delete(url) && reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const reserve = new Reserve({ budget, ahead, parallel, fetch, now: () => clock,
    fragments: (type, level) => level === 0 ? lists[type] : track(type, level, 100) });
  created.push(reserve);
  const finish = async url => { pending.get(url).resolve(); pending.delete(url); await tick(); };
  return { reserve, lists, pending, finish, advance: ms => { clock += ms; } };
};

test('reserveBudget scales with device memory and stays off on tiny devices', () => {
  assert.equal(reserveBudget(undefined), 384 * MB);
  assert.equal(reserveBudget(8), 768 * MB);
  assert.equal(reserveBudget(4), 384 * MB);
  assert.equal(reserveBudget(2), 96 * MB);
  assert.equal(reserveBudget(1), 0);
});

test('the reserve fetches past what hls.js asked for, in time order across tracks', async () => {
  const { reserve, lists, pending, finish } = setup();
  reserve.take(lists.main[3]); reserve.take(lists.audio[3]);
  reserve.refill();
  assert.deepEqual([...pending.keys()], ['main0_4', 'audio0_4']);
  await finish('main0_4');
  assert.deepEqual([...pending.keys()], ['audio0_4', 'main0_5']);
  await finish('audio0_4');
  assert.deepEqual([...pending.keys()], ['main0_5', 'audio0_5']);
  assert.equal(reserve.seconds, 4);
});

test('a ready fragment is handed over once and frees a slot', async () => {
  const { reserve, lists, pending, finish } = setup({ parallel: 1 });
  reserve.take(lists.main[0]); reserve.refill();
  await finish('main0_1');
  await finish('main0_2');
  const entry = reserve.take(lists.main[1]);
  assert.equal(entry.data.byteLength, MB);
  assert.equal(reserve.take(lists.main[1]), null);
  assert.ok(pending.has('main0_3'));
});

test('a load hls.js runs itself holds the reserve back until it lands', async () => {
  const { reserve, lists, pending } = setup();
  assert.equal(reserve.take(lists.main[0]), null);
  const done = reserve.urgentLoad();
  reserve.refill();
  assert.equal(pending.size, 0);
  done(); done();
  assert.equal(reserve.urgent, 0);
  assert.deepEqual([...pending.keys()], ['main0_1', 'main0_2']);
});

test('a seek drops and aborts what the new window does not cover', async () => {
  const { reserve, lists, pending, finish } = setup({ parallel: 1 });
  reserve.take(lists.main[0]); reserve.refill();
  await finish('main0_1');
  assert.deepEqual([...pending.keys()], ['main0_2']);
  reserve.take(lists.main[50]);
  await tick();
  assert.equal(reserve.entries.has('main0_1'), false);
  assert.deepEqual([...pending.keys()], ['main0_51']);
});

test('a seek inside the reserve is served without the network', async () => {
  const { reserve, lists, finish } = setup({ parallel: 3 });
  reserve.take(lists.main[0]); reserve.refill();
  await finish('main0_1'); await finish('main0_2'); await finish('main0_3');
  assert.ok(reserve.take(lists.main[3]).data);
  assert.equal(reserve.entries.has('main0_1'), false);
});

test('the reserve stops at its byte budget and its time horizon', async () => {
  const budgeted = setup({ budget: 2 * MB, parallel: 1 });
  budgeted.reserve.take(budgeted.lists.main[0]); budgeted.reserve.refill();
  await budgeted.finish('main0_1'); await budgeted.finish('main0_2');
  assert.equal(budgeted.pending.size, 0);
  const near = setup({ ahead: 8, parallel: 5 });
  near.reserve.take(near.lists.main[0]); near.reserve.refill();
  assert.deepEqual([...near.pending.keys()], ['main0_1']);
});

test('a failed fetch is dropped and the reserve waits before trying again', async () => {
  const { reserve, lists, pending, advance } = setup({ parallel: 1 });
  reserve.take(lists.main[0]); reserve.refill();
  pending.get('main0_1').reject(new Error('HTTP 503')); pending.delete('main0_1');
  await tick();
  assert.equal(reserve.entries.size, 0);
  assert.equal(pending.size, 0);
  advance(5000); reserve.refill();
  assert.deepEqual([...pending.keys()], ['main0_1']);
});

test('init segments, subtitles and audio track switches stay out of the reserve', async () => {
  const { reserve, lists, pending, finish } = setup({ parallel: 1 });
  assert.equal(reserve.take({ sn: 'initSegment', type: 'main', level: 0, url: 'init' }), null);
  assert.equal(reserve.take({ sn: 3, type: 'subtitle', level: 0, url: 'sub' }), null);
  assert.deepEqual(reserve.anchors, {});
  reserve.take(lists.audio[0]); reserve.refill();
  await finish('audio0_1');
  reserve.take(track('audio', 1, 10)[1]); reserve.refill();
  assert.equal(reserve.entries.size, 1);
  assert.ok(pending.has('audio1_2'));
});

class StockLoader {
  constructor() { this.stats = { aborted: false, loaded: 0, total: 0, loading: { start: 0, first: 0, end: 0 } }; this.calls = []; }
  load(context, config, callbacks) { this.calls.push({ context, callbacks }); }
  abort() { this.aborted = true; }
  destroy() { this.destroyed = true; }
}

test('the loader serves reserved fragments with their real download timing', async () => {
  const { reserve, lists, finish, advance } = setup({ parallel: 1 });
  const taken = [];
  const Loader = reserveLoader(StockLoader, reserve, (frag, entry) => taken.push([frag.sn, entry ? 'hit' : 'miss']));
  const first = new Loader();
  first.load({ frag: lists.main[0], url: 'main0_0', rangeStart: 0, rangeEnd: 0 }, {}, { onSuccess() {} });
  assert.equal(first.calls.length, 1);
  assert.equal(reserve.urgent, 1);
  first.calls[0].callbacks.onSuccess({}, first.stats, {}, null);
  assert.equal(reserve.urgent, 0);
  advance(700);
  await finish('main0_1');
  const second = new Loader();
  let delivered;
  second.load({ frag: lists.main[1], url: 'main0_1', rangeStart: 0, rangeEnd: 0 }, {}, { onSuccess: (response, stats) => { delivered = { response, stats }; } });
  await tick();
  assert.equal(second.calls.length, 0);
  assert.equal(delivered.response.data.byteLength, MB);
  assert.equal(delivered.stats.loaded, MB);
  assert.deepEqual(delivered.stats.loading, { start: 0, first: 700, end: 700 });
  assert.deepEqual(taken, [[0, 'miss'], [1, 'hit']]);
});

test('the loader falls back to the network when a pending fragment fails, and honours abort', async () => {
  const { reserve, lists, pending } = setup({ parallel: 2 });
  const Loader = reserveLoader(StockLoader, reserve);
  reserve.take(lists.main[0]); reserve.refill();
  const failing = new Loader();
  failing.load({ frag: lists.main[1], url: 'main0_1', rangeStart: 0, rangeEnd: 0 }, {}, {});
  pending.get('main0_1').reject(new Error('HTTP 500'));
  await tick();
  assert.equal(failing.calls.length, 1);
  const aborted = new Loader();
  let onAbort = 0, onSuccess = 0;
  aborted.load({ frag: lists.main[2], url: 'main0_2', rangeStart: 0, rangeEnd: 0 }, {}, { onAbort: () => onAbort++, onSuccess: () => onSuccess++ });
  aborted.abort();
  pending.get('main0_2').resolve();
  await tick();
  assert.equal(onAbort, 1);
  assert.equal(onSuccess, 0);
});

test('a pending fragment that outlasts hls.js load timeout goes back to the network', async () => {
  const { reserve, lists } = setup({ parallel: 1 });
  const Loader = reserveLoader(StockLoader, reserve);
  reserve.take(lists.main[0]); reserve.refill();
  const loader = new Loader();
  loader.load({ frag: lists.main[1], url: 'main0_1', rangeStart: 0, rangeEnd: 0 }, { loadPolicy: { maxLoadTimeMs: 5 } }, { onSuccess() {} });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(loader.calls.length, 1);
  assert.equal(reserve.urgent, 1);
});

test('byte-range loads bypass the reserve and leave its anchor alone', () => {
  const { reserve, lists } = setup();
  const loader = new (reserveLoader(StockLoader, reserve))();
  loader.load({ frag: lists.main[4], url: 'main0_4', rangeStart: 0, rangeEnd: 1000 }, {}, { onSuccess() {} });
  assert.equal(loader.calls.length, 1);
  assert.deepEqual(reserve.anchors, {});
  assert.equal(reserve.urgent, 0);
});
