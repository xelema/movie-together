import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobs } from '../src/jobs.js';

function setup(status = 'ready', inUse = () => false) {
  const movie = { id: 'm1', status };
  const jobs = createJobs({ getMovie: () => movie, movieInUse: inUse });
  return { movie, jobs };
}

test('a ready movie is playable and editable', () => {
  const { movie, jobs } = setup();
  assert.ok(jobs.playable(movie));
  assert.equal(jobs.idle('m1'), movie);
});

test('a movie under a lock is neither playable nor editable until released', () => {
  const { movie, jobs } = setup();
  const release = jobs.claimMovie('m1');
  assert.equal(jobs.playable(movie), false);
  assert.throws(() => jobs.idle('m1'), /Modification du film en cours/);
  release();
  assert.equal(jobs.idle('m1'), movie);
});

test('a movie whose status says a job is running is not editable', () => {
  assert.throws(() => setup('processing').jobs.idle('m1'), /Traitement en cours/);
});

test('a movie shown in a room is not editable', () => {
  assert.throws(() => setup('ready', () => true).jobs.idle('m1'), /Film utilisé dans une room/);
});

test('one heavy job at a time, freed by its release', () => {
  const { jobs } = setup();
  const done = jobs.claimHeavy();
  assert.ok(jobs.heavyBusy());
  assert.throws(() => jobs.claimHeavy(), /Un import est déjà en cours/);
  done();
  assert.equal(jobs.heavyBusy(), false);
});

test('an import holds the upload and the pipeline under one claim', () => {
  const { jobs } = setup();
  const done = jobs.claimImport('u1');
  assert.throws(() => jobs.claimUpload('u1'), /Upload occupé/);
  assert.throws(() => jobs.claimImport('u2'), /Un import est déjà en cours/);
  done();
  assert.equal(jobs.heavyBusy(), false);
  jobs.claimUpload('u1')();
});

test('a subtitle edit holds the movie and the pipeline under one claim', () => {
  const { movie, jobs } = setup();
  const release = jobs.claimEdit(movie);
  assert.ok(jobs.heavyBusy());
  assert.equal(jobs.playable(movie), false);
  release();
  assert.ok(jobs.playable(movie));
});
