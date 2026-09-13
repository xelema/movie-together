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
//   normalizeRate  restore playbackRate to 1
export function decide({ activating, state, clockReady, hidden, online, silent,
  decoded, seeking, paused, currentTime, bufferedStart, target, serverNow,
  activated, scheduled }) {
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
  // Keep audio at its native speed: repeated time stretching can create audible
  // artifacts. Larger drift still pauses and realigns the entire room.
  return Math.abs(target - currentTime) > 0.35 ? { pause: true, reportUnready: true } : { normalizeRate: true };
}

// The single readiness bit a member reports: activation, clock, liveness,
// decode progress and alignment all folded in.
export function memberReady({ state, failure, rendererReady, recovering, activated,
  clockReady, hidden, online, silent, seeking, readyState, paused, position, target, serverNow }) {
  const running = state.phase === 'playing' && serverNow > state.startsAt + 200;
  return !failure && rendererReady && !recovering && activated && clockReady && !hidden && online &&
    !silent && !seeking && readyState >= 3 &&
    (!running || (!paused && Math.abs(position - target) <= 0.35));
}

// Whether an armed scheduled start may fire now.
export function canBegin({ state, scheduled, activated, failure, hidden, silent }) {
  return state?.phase === 'playing' && state.startsAt === scheduled && activated && !failure && !hidden && !silent;
}
