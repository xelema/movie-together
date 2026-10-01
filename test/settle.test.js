import test from 'node:test';
import assert from 'node:assert/strict';
import { attempt, settle } from '../public/settle.js';

// Node n'a pas les DOMException du navigateur : seul le nom compte ici.
const named = name => Object.assign(new Error(name), { name });

// Une promesse du navigateur peut ne jamais se résoudre : tout appelant doit
// rendre la main dans une borne et lire le résultat observé.
test('settle rend « ok », le nom de l\'erreur, ou « pending »', async () => {
  assert.equal(await settle(Promise.resolve(), 50), 'ok');
  assert.equal(await settle(Promise.reject(named('NotAllowedError')), 50), 'NotAllowedError');
  assert.equal(await settle(new Promise(() => {}), 20), 'pending');
});

test('attempt lit un appel qui jette comme un refus', async () => {
  assert.equal(await settle(attempt(() => { throw new TypeError('boom'); }), 50), 'TypeError');
  assert.equal(await settle(attempt(() => Promise.resolve('valeur')), 50), 'ok');
});
