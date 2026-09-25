// Member-side synchronization policy, pure of DOM and media elements so it is
// directly testable. SyncPlayer gathers the observables each tick or event,
// asks these functions what to do, and applies the returned actions.

// Events the player caused itself must not echo back as room commands: pause
// and seek mark this window before touching the media element.
export const INTERNAL_EVENT_MS = 500;
export const selfCaused = (now, internalUntil) => now <= internalUntil;

// Where the room's film is now, in room time.
export function roomTarget(state, serverNow) {
  if (!state) return 0;
  return Math.min(state.duration, state.position +
    (state.phase === 'playing' ? Math.max(0, serverNow - state.startsAt) / 1000 : 0));
}

// One reconcile tick: which local actions keep this member aligned.
//   pause          freeze the element and mark its events self-caused
//   seekTo         realign to this media-element position
//   scheduleStart  arm the start timer, firing in startIn ms
//   reportUnready  send a forced not-ready report (drift too large)
//   rate           catch up or fall back by stretching playback briefly
//   normalizeRate  restore playbackRate to 1
export function decide({ activating, state, clockReady, hidden, online, silent,
  decoded, seeking, paused, currentTime, bufferedStart, target, serverNow,
  activated, scheduled, rate }) {
  if (activating) return {};
  if (!state || !clockReady || hidden || !online || silent) return { pause: true };
  if (state.phase !== 'playing' || serverNow < state.startsAt) {
    const action = { pause: true };
    // B-frame reordering can leave a tiny initial gap after lossless remuxing.
    const seekTarget = bufferedStart > target && bufferedStart - target <= 0.1 ? bufferedStart + 0.00001 : target;
    // A seek issued before the first decoded frame never completes on WebKit and
    // would wedge the player in seeking, blocking the whole room.
    if (decoded && !seeking &&
      (Math.abs(currentTime - seekTarget) > 0.1 || (Math.abs(bufferedStart - seekTarget) <= 0.1 && currentTime < bufferedStart)))
      action.seekTo = seekTarget;
    if (state.phase === 'playing' && activated && scheduled !== state.startsAt)
      Object.assign(action, { scheduleStart: true, startIn: Math.max(0, state.startsAt - serverNow) });
    return action;
  }
  if (paused) return {};
  // Pour préserver la qualité du film (audio natif sans étirement WSOLA et
  // vidéo à 24 fps sans judder), les petits écarts restent à 1.0x : une
  // dérive sous 1.2 s (1.5 s au démarrage pendant le calage du décodeur)
  // ne touche à rien. Au-delà, un micro-ajustement doux (±4%) résorbe le retard
  // sans déformation audible jusqu'à revenir sous 0.5 s. Seul un vrai
  // décrochage (> 2.5 s) déclenche une pause et un recalage de la salle.
  const drift = target - currentTime;
  if (Math.abs(drift) > 2.5) return { pause: true, reportUnready: true };
  const starting = serverNow - state.startsAt < 500;
  const correcting = rate !== undefined && rate !== 1;
  const threshold = correcting ? 0.5 : (starting ? 1.5 : 1.2);
  if (Math.abs(drift) > threshold) return { rate: drift > 0 ? 1.04 : 0.96 };
  return { normalizeRate: true };
}

// The single readiness bit a member reports: activation, clock, liveness,
// decode progress and alignment all folded in. `readyBlockers` names each
// failing gate; the names ride the report so a stuck séance can say why.
export function readyBlockers({ state, failure, rendererReady, recovering, activated,
  clockReady, hidden, online, silent, seeking, readyState, paused, position, target, serverNow }) {
  const running = state.phase === 'playing' && serverNow > state.startsAt + 200;
  const blockers = [];
  if (failure) blockers.push('failure');
  if (!rendererReady) blockers.push('renderer');
  if (recovering) blockers.push('recovering');
  if (!activated) blockers.push('activation');
  if (!clockReady) blockers.push('clock');
  if (hidden) blockers.push('hidden');
  if (!online) blockers.push('offline');
  if (silent) blockers.push('silent');
  if (seeking) blockers.push('seeking');
  if (readyState < 3) blockers.push('data');
  if (running && (paused || Math.abs(position - target) > 2.5)) blockers.push('drift');
  return blockers;
}
export const memberReady = observables => readyBlockers(observables).length === 0;

// Whether an armed scheduled start may fire now.
export function canBegin({ state, scheduled, activated, failure, hidden, silent }) {
  return state?.phase === 'playing' && state.startsAt === scheduled && activated && !failure && !hidden && !silent;
}

// Subtitle glyphs scale with the rendered picture, not the window: the old
// 2.4vw rule produced 30.72 px on a 720 px tall picture, and a 25% bump makes
// 38.4 px the reference ratio. The floor keeps a tiny render readable.
export const subtitleFontSize = pictureHeight => Math.max(18, pictureHeight * (38.4 / 720));

// Only one text track may paint at once; WebKit can expose the same HLS
// subtitle as duplicate TextTracks all in showing mode. The viewer's pick
// (index among subtitle/caption tracks) survives while it is showing, so a
// duplicate with earlier cues cannot demote it; otherwise keep the showing
// track with live cues, else the first showing one. The caller demotes the rest.
export function shownSubtitleTrack(tracks, selected = -1) {
  const subtitles = tracks.filter(track => ['subtitles', 'captions'].includes(track.kind));
  const showing = subtitles.filter(track => track.mode === 'showing');
  if (showing.includes(subtitles[selected])) return subtitles[selected];
  return showing.find(track => track.activeCues?.length) ?? showing[0] ?? null;
}

// Blink unschedules a track's cues when its mode passes through 'disabled' and
// never revives them on 'showing': a re-selected track can stay visible with
// cues that never enter activeCues. The transition strands the whole list, so
// re-register every cue once per stranding. The flag clears as soon as the
// track reads healthy again, and the snapshot keeps the live cue list stable
// while it is rebuilt.
export function reviveSubtitleCues(track, time) {
  const list = track.cues;
  if (!list?.length) { track.revived = false; return; }
  // La liste est triée par startTime et activeCues ne compte que quelques cues
  // : un scan indexé qui coupe à la première cue stale ou à la première cue
  // future évite Array.from/Set à chaque tick sur des milliers d'entrées.
  let stale = false;
  for (let i = 0; i < list.length; i++) {
    const cue = list[i];
    if (cue.startTime > time) break;
    if (cue.endTime <= time) continue;
    const active = track.activeCues ?? [];
    let live = false;
    for (let j = 0; j < active.length; j++) if (active[j] === cue) { live = true; break; }
    if (!live) { stale = true; break; }
  }
  if (!stale) { track.revived = false; return; }
  if (track.revived) return;
  track.revived = true;
  // removeCue mutates the live list: the re-registration replays a snapshot.
  const cues = Array.from(list);
  for (const cue of cues) { track.removeCue(cue); track.addCue(cue); }
}
