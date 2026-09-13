const fail = (status, message) => Object.assign(new Error(message), { status });

// Media job guards. The pipeline is single-threaded by policy: one heavy job
// at a time (import, probe, preparation, subtitle insert), per-movie locks
// keep prepared bytes stable while a ready movie is edited, and per-upload
// locks serialize chunk writes against finalization. Routes claim through
// this interface so each rule is defined once instead of re-derived per route.
export function createJobs({ getMovie, movieInUse } = {}) {
  const movieLocks = new Set(), uploadLocks = new Set();
  let heavy = false;

  const claim = (set, key, message) => {
    if (set.has(key)) throw fail(409, message);
    set.add(key);
    return () => set.delete(key);
  };

  return {
    // Read paths: a movie only serves while ready and untouched.
    playable: movie => movie?.status === 'ready' && !movieLocks.has(movie.id),

    // A movie can be edited only while quiescent: no job holds it, no running
    // job has set its status, no room shows it.
    idle(id) {
      const movie = getMovie(id);
      if (movieLocks.has(id)) throw fail(409, 'Modification du film en cours.');
      if (['processing', 'probing'].includes(movie.status)) throw fail(409, 'Traitement en cours.');
      if (movieInUse(id)) throw fail(409, 'Film utilisé dans une room.');
      return movie;
    },

    // Fast edits only check that no heavy job is running; they are too short
    // to hold the pipeline themselves.
    heavyBusy: () => heavy,

    claimHeavy(message = 'Un import est déjà en cours.') {
      if (heavy) throw fail(409, message);
      heavy = true;
      return () => { heavy = false; };
    },
    claimMovie: id => claim(movieLocks, id, 'Modification du film en cours.'),
    claimUpload: id => claim(uploadLocks, id, 'Upload occupé.'),

    // Completing an upload is a heavy job that also holds its upload.
    claimImport(id) {
      if (heavy || uploadLocks.has(id)) throw fail(409, 'Un import est déjà en cours.');
      heavy = true; uploadLocks.add(id);
      return () => { heavy = false; uploadLocks.delete(id); };
    },

    // Inserting a subtitle into a ready movie is heavy and rewrites its bytes.
    claimEdit(movie, message = 'Un import est déjà en cours.') {
      if (heavy) throw fail(409, message);
      if (movieLocks.has(movie.id)) throw fail(409, 'Modification du film en cours.');
      heavy = true; movieLocks.add(movie.id);
      return () => { heavy = false; movieLocks.delete(movie.id); };
    },
  };
}
