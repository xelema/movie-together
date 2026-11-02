import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonResult, readJson, responseError } from '../public/http.js';

const response = (status, body) => ({ ok: status >= 200 && status < 300, status,
  json: () => body instanceof Error ? Promise.reject(body) : Promise.resolve(body) });
const translate = { label: text => `[${text}]`, t: (fr, ko, vi) => `${fr} | ${ko} | ${vi}` };

// A proxy page during a deployment is HTML: the reader must say the server is
// unavailable, with the status, never the browser's JSON parse error.
test('a non-JSON 502 becomes a translated outage message with its status', async () => {
  const error = await jsonResult(response(502, new SyntaxError('Unexpected token \'<\', "<html>" is not valid JSON')), translate)
    .then(() => null, caught => caught);
  assert.ok(error instanceof Error);
  assert.doesNotMatch(error.message, /Unexpected token|JSON/);
  assert.match(error.message, /^Serveur indisponible, réessayez dans un instant\. \| .+ \| .+ \(HTTP 502\)$/);
  assert.equal(error.status, 502);
  assert.equal(error.source, null);
});

test('a server refusal keeps its translated message, status and source', async () => {
  const error = await jsonResult(response(404, { error: 'Code invalide ou expiré.' }), translate).catch(caught => caught);
  assert.equal(error.message, '[Code invalide ou expiré.]');
  assert.equal(error.status, 404);
  assert.equal(error.source, 'Code invalide ou expiré.');
});

test('a client error without a message names its status', () => {
  const error = responseError(413, null, translate);
  assert.match(error.message, /^Une erreur est survenue\. \| .+ \(HTTP 413\)$/);
});

test('a successful JSON body is returned as is; an unreadable one is an error', async () => {
  assert.deepEqual(await jsonResult(response(200, { id: 'r1' }), translate), { id: 'r1' });
  const error = await jsonResult(response(200, new SyntaxError('x')), translate).catch(caught => caught);
  assert.equal(error.status, 200);
  assert.match(error.message, /HTTP 200/);
  assert.equal(await readJson(response(500, new SyntaxError('x'))), null);
});

test('without translations the French message stands', () => {
  assert.equal(responseError(504, null).message, 'Serveur indisponible, réessayez dans un instant. (HTTP 504)');
});
