import { SyncPlayer } from './sync-player.js';
import { attachTelemetry } from './telemetry.js';
import { label, language, setScopeLanguages, scopeLanguages, vietnamese } from './labels.js';
import { trackName, defaultTrackNames, sourceTitle, trackLayout, languageName } from './track-names.js';
import { SUBTITLE_EXT, SUBTITLE_ACCEPT, IMAGE_SUBTITLE_CODECS } from './subtitle-formats.js';
import { shiftCues, cueIndexAt, shiftSummary, formatTimestamp } from './subtitle-timing.js';
import { subtitleFontSize } from './sync-core.js';
import { attachVoice } from './voice.js';
import { attachWebcam } from './webcam.js';
import { attachFullscreen } from './fullscreen.js';

const $ = id => document.getElementById(id);
const LANGUAGE_OPTIONS = { fr: 'Français', ko: '한국어', vi: 'Tiếng Việt' };
// Le vietnamien passe par le troisième argument ou retombe sur le
// dictionnaire des libellés ; jamais sur le coréen.
const t = (fr, ko, vi) => language() === 'vi' ? vi ?? vietnamese[fr] ?? fr : language() === 'ko' ? ko : fr;
let roomLanguages = null;
function updateLanguagePicker() {
  selectOptions($('language'), scopeLanguages().map(code => [code, LANGUAGE_OPTIONS[code] ?? code]));
}
const adminPage = location.pathname === '/admin';
let session = {}, movies = [], player = null, activeRoom = null, uploadBusy = false, roomMessage = null, diskInfo = null, telemetry = null, voice = null, webcam = null;
function disposePlayer() { telemetry?.dispose(); telemetry = null; voice?.dispose(); voice = null; webcam?.dispose(); webcam = null; player?.dispose(); player = null; window.player = null; refreshBandwidth(); }
const movieCards = new Map(), openPanels = new Set(), closedPanels = new Set();
const playbackUI = new window.Plyr($('video'), {
  controls: ['play-large', 'play', 'progress', 'current-time', 'duration', 'mute', 'volume', 'fullscreen'],
  settings: [], storage: { enabled: false }, clickToPlay: false, keyboard: { focused: false, global: false },
  hideControls: true, tooltips: { controls: true, seek: true }, invertTime: false, toggleInvert: false,
  iconUrl: '/vendor/plyr.svg', blankVideo: '',
  fullscreen: { enabled: true, fallback: true, iosNative: false, container: '#screen' },
  listeners: {
    play: () => { act($('video').paused ? 'play' : 'pause'); player?.togglePlayback().catch(error => notice(error)); return false; },
    seek: event => { if (player?.state) { const to = Number(event.target.value) / 100 * player.state.duration; act('seek', Math.round(to)); player.command('seek', to); } return false; },
  },
});
const settingsButton = document.createElement('button');
settingsButton.id = 'open-settings'; settingsButton.type = 'button'; settingsButton.className = 'plyr__control plyr__controls__item';
settingsButton.textContent = '⚙'; settingsButton.setAttribute('aria-controls', 'player-settings'); settingsButton.setAttribute('aria-expanded', 'false');
playbackUI.elements.controls.insertBefore(settingsButton, playbackUI.elements.buttons.fullscreen);
// Le contrôle plein écran décide depuis l'élément peint plutôt que l'API :
// Chrome pour Android quitte le plein écran derrière le dos de la page quand
// une invite de permission s'ouvre, et le document garde alors un élément
// plein écran que le navigateur a déjà lâché.
const fullscreenControl = window.fullscreenControl = attachFullscreen({ screen: $('screen'), player: playbackUI,
  onEvent: (reason, detail) => act('fullscreen', fullscreenControl.active(), { recovery: reason, detail: String(detail ?? '') }) });
function showSettings(open, focus = false) {
  const wasOpen = !$('player-settings').hidden;
  $('player-settings').hidden = !open; settingsButton.setAttribute('aria-expanded', String(open));
  if (open !== wasOpen) act('settings', open);
  $('screen').classList.toggle('settings-open', open);
  if (open) playbackUI.toggleControls(true);
  player?.positionSubtitles();
  if (focus) (open ? $('close-settings') : settingsButton).focus();
}
settingsButton.addEventListener('click', () => showSettings($('player-settings').hidden, true));
$('close-settings').addEventListener('click', event => showSettings(false, event.detail === 0));
document.addEventListener('pointerdown', event => { if (!$('player-settings').contains(event.target) && !settingsButton.contains(event.target)) showSettings(false); });
$('screen').addEventListener('keydown', event => { if (event.key === 'Escape' && !$('player-settings').hidden) { event.preventDefault(); event.stopPropagation(); showSettings(false, true); } });
playbackUI.on('enterfullscreen exitfullscreen', () => { act('fullscreen', fullscreenControl.active()); showSettings(false); });
let lastMuted, lastVol;
playbackUI.on('volumechange', () => {
  const muted = playbackUI.muted, vol = playbackUI.volume;
  if (lastMuted !== undefined && muted !== lastMuted) act('mute', muted);
  else if (lastVol !== undefined && vol !== lastVol) act('volume', Math.round(vol * 100) / 100);
  lastMuted = muted; lastVol = vol;
});
$('video').addEventListener('enterpictureinpicture', () => act('pip', true));
$('video').addEventListener('leavepictureinpicture', () => act('pip', false));
// Admin-only live bandwidth badge. hls.js exposes a live estimate; native HLS does not.
const bandwidthToggle = $('bandwidth-toggle'), bandwidthBadge = $('bandwidth-badge');
let bandwidthTimer = null;
bandwidthToggle.checked = localStorage.getItem('bandwidth-badge') === 'on';
bandwidthToggle.addEventListener('change', () => {
  localStorage.setItem('bandwidth-badge', bandwidthToggle.checked ? 'on' : 'off');
  refreshBandwidth();
});
function refreshBandwidth() {
  const on = session.admin && player && bandwidthToggle.checked;
  if (on && !bandwidthTimer) bandwidthTimer = setInterval(refreshBandwidth, 1000);
  if (!on && bandwidthTimer) { clearInterval(bandwidthTimer); bandwidthTimer = null; }
  bandwidthBadge.hidden = !on;
  if (on) {
    const bps = player.backend?.hls?.bandwidthEstimate;
    bandwidthBadge.textContent = bps ? `${(bps / 1e6).toFixed(1)} Mb/s` : '—';
  }
}
// The page chrome follows the player controls: visible in pause and on hover, gone during playback.
playbackUI.on('controlsshown', () => { $('watch').dataset.chrome = 'true'; });
playbackUI.on('controlshidden', () => { $('watch').dataset.chrome = 'false'; });
// Clicking the picture only swaps the controls and cursor, never playback:
// Plyr's own buttons move the room. Plyr pins the controls open while paused,
// so a flag re-hides every show a click asks for until a real pointer gesture
// asks for the controls back.
let clickHidden = false, touchHidden = false, touchOnPicture = false, lastSubtitle = -1;
playbackUI.elements.container.addEventListener('mousemove', () => { clickHidden = false; }, true);
playbackUI.elements.container.addEventListener('touchstart', event => {
  clickHidden = false;
  touchHidden = playbackUI.elements.container.classList.contains('plyr--hide-controls');
  touchOnPicture = Boolean(event.target.closest('.plyr__video-wrapper'));
}, true);
playbackUI.elements.container.addEventListener('touchcancel', () => { touchOnPicture = false; }, true);
const toggleOverlay = () => {
  const hidden = touchHidden || playbackUI.elements.container.classList.contains('plyr--hide-controls');
  touchHidden = false;
  if (!player) return;
  // A hide timer armed before the click must not clip the show it asks for.
  clearTimeout(playbackUI.timers.controls);
  clickHidden = !hidden;
  playbackUI.toggleControls(hidden);
};
// A tap that starts on the picture slides the controls up under the finger, so
// the click Chrome then synthesizes is hit-tested against a transport that was
// hidden at touchstart. Capture it and spend it on the overlay alone; a tap
// that started on a control, or a real mouse or pen click, still reaches it.
playbackUI.elements.container.addEventListener('click', event => {
  const onPicture = touchOnPicture;
  touchOnPicture = false;
  if (!onPicture || event.pointerType === 'mouse' || event.pointerType === 'pen' ||
      event.target.closest('.plyr__video-wrapper')) return;
  event.stopPropagation(); event.preventDefault();
  toggleOverlay();
}, true);
playbackUI.elements.container.addEventListener('click', event => {
  // Any non-touch click drops the snapshot an aborted touch gesture left behind.
  if (event.pointerType !== 'touch') touchHidden = false;
  if (!event.target.closest('.plyr__video-wrapper')) return;
  toggleOverlay();
});
playbackUI.on('controlsshown', () => { if (clickHidden) playbackUI.toggleControls(false); });
$('video').addEventListener('play', () => { clickHidden = false; });
// The mic lives outside the Plyr container, so hovering or focusing it never
// reaches the handlers that keep the chrome up. controls.hover is the same
// latch the transport sets. The synthetic container event routes the release
// through Plyr's own hide policy: a grace delay while the pointer stays on
// the player, immediate hide when it leaves.
const micHold = held => event => {
  const controls = playbackUI.elements.controls;
  // The latch stays mouse-and-keyboard only, like Plyr's own: on touch the
  // :hover sticks after a tap and the bar would never drop again, and the
  // first tap can reach the mic before Plyr's touch flag is even set.
  // Firefox still matches :hover while it dispatches pointerleave, so a leave
  // trusts the event itself and only a blur asks whether the pointer stayed.
  const target = event.currentTarget;
  if (controls) controls.hover = event.pointerType !== 'touch' && !playbackUI.touch &&
    (held || (event.type !== 'pointerleave' && target.matches(':hover')) || target.matches(':focus-visible'));
  const container = playbackUI.elements.container, inside = event.relatedTarget && container.contains(event.relatedTarget);
  container.dispatchEvent(new Event(held || inside ? 'mousemove' : 'mouseleave'));
};
for (const toggle of [$('voice-mic'), $('webcam-toggle')])
  for (const [type, held] of [['pointerenter', true], ['focusin', true], ['pointerleave', false], ['focusout', false]])
    toggle.addEventListener(type, micHold(held));
// A straight jump from the bar onto the mic is a single hit-test step: the
// mic's enter runs before the bar's own leave, and that leave clears the
// latch it just set. Bound after Plyr's listener, this hands the hold back
// whenever the mic still owns it: the pointer landing on it (relatedTarget
// covers leave-before-enter engines) or keyboard focus holding it.
playbackUI.elements.controls.addEventListener('mouseleave', event => {
  const held = [$('voice-mic'), $('webcam-toggle')].some(mic =>
    mic.contains(event.relatedTarget) || mic.matches(':hover') || mic.matches(':focus-visible'));
  if (!playbackUI.touch && held) playbackUI.elements.controls.hover = true;
});
// Route transport shortcuts through the shared clock, not Plyr's local playback.
$('screen').addEventListener('keydown', event => {
  if (!player || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
      event.target.closest('input, select, textarea, button, [contenteditable=true]')) return;
  const key = event.key.toLowerCase();
  if (![' ', 'k', 'j', 'l', 'c', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'm', 'f'].includes(key)) return;
  event.preventDefault();
  if (event.repeat) return;
  const seek = delta => { const to = Math.max(0, Math.min(player.state?.duration || 0, player.position() + delta)); act('seek', Math.round(to)); player.command('seek', to); };
  if (key === ' ' || key === 'k') { act($('video').paused ? 'play' : 'pause'); player.togglePlayback().catch(error => notice(error)); }
  else if (key === 'arrowleft' || key === 'j') seek(-10);
  else if (key === 'arrowright' || key === 'l') seek(10);
  else if (key === 'arrowup') { playbackUI.muted = false; playbackUI.volume = Math.min(1, playbackUI.volume + 0.05); }
  else if (key === 'arrowdown') playbackUI.volume = Math.max(0, playbackUI.volume - 0.05);
  else if (key === 'c') {
    const select = $('subtitles'), options = [...select.options];
    const next = select.value === '-1'
      ? (options.find(option => option.value === String(lastSubtitle)) ?? options.find(option => option.value !== '-1'))?.value ?? '-1'
      : (lastSubtitle = Number(select.value), '-1');
    select.value = next;
    act('track-subs', Number(next));
    player.changeTrack('subtitles', Number(next));
  }
  else if (key === 'm') playbackUI.muted = !playbackUI.muted;
  else fullscreenControl.toggle().then(() => act('fullscreen', fullscreenControl.active()));
  clickHidden = false;
  playbackUI.toggleControls(true);
});
function translate() {
  updateLanguagePicker();
  const lang = language();
  document.documentElement.lang = lang; $('language').value = lang;
  $('language-flag').src = `/flags/${lang}.svg`;
  for (const node of document.querySelectorAll('[data-fr]')) node.textContent = node.dataset[lang] ?? node.dataset.fr;
  bandwidthBadge.title = bandwidthBadge.ariaLabel = t('Débit en direct', '실시간 속도');
  const words = { play: t('Lecture', '재생'), pause: t('Pause', '일시정지'), seek: t('Avancer ou reculer', '재생 위치'),
    currentTime: t('Position', '재생 위치'), duration: t('Durée', '길이'), volume: t('Volume', '음량'),
    mute: t('Couper le son', '음소거'), unmute: t('Activer le son', '소리 켜기'),
    enterFullscreen: t('Plein écran', '전체 화면'), exitFullscreen: t('Quitter le plein écran', '전체 화면 종료'),
    seekLabel: t('{currentTime} sur {duration}', '{duration} 중 {currentTime}', '{currentTime} trên {duration}'),
    played: t('Lu', '재생됨'), buffered: t('Chargé', '버퍼링됨') };
  Object.assign(playbackUI.config.i18n, words);
  for (const [key, text] of Object.entries(words)) {
    for (const node of playbackUI.elements.container.querySelectorAll(`[data-plyr=${key}]`)) {
      node.setAttribute('aria-label', text);
      for (const tooltip of node.querySelectorAll('.plyr__tooltip')) tooltip.textContent = text;
    }
  }
  for (const [button, normal, pressed] of [[playbackUI.elements.buttons.mute, words.mute, words.unmute],
    [playbackUI.elements.buttons.fullscreen, words.enterFullscreen, words.exitFullscreen]]) {
    if (!button) continue;
    button.querySelector('.label--not-pressed').textContent = normal;
    button.querySelector('.label--pressed').textContent = pressed;
  }
  playbackUI.elements.buttons.fullscreen?.setAttribute('aria-label', playbackUI.fullscreen.active ? words.exitFullscreen : words.enterFullscreen);
  settingsButton.setAttribute('aria-label', t('Réglages', '설정'));
  $('player-settings').setAttribute('aria-label', t('Réglages', '설정')); $('close-settings').setAttribute('aria-label', t('Fermer', '닫기'));
  $('notice-close').setAttribute('aria-label', t('Fermer', '닫기'));
  $('room-name').setAttribute('aria-label', t('Votre pseudo', '닉네임'));
  $('timing-seek').setAttribute('aria-label', t('Avancer ou reculer', '재생 위치'));
  $('timing-track').setAttribute('aria-label', t('Frise des répliques', '대사 타임라인', 'Dòng thời gian phụ đề'));
  timingPlayLabel();
  renderTimingOrigin();
  $('timing-auto').title = t('Recaler automatiquement les répliques sur la bande son.',
    '음성에 맞춰 대사 싱크를 자동으로 맞춥니다.', 'Tự động căn phụ đề theo âm thanh.');
  $('screen').setAttribute('aria-label', t('Lecteur vidéo', '동영상 플레이어'));
  if (voice) voice.rename(); else $('voice-mic').setAttribute('aria-label', t('Parler', '말하기'));
  if (webcam) webcam.rename(); else $('webcam-toggle').setAttribute('aria-label', t('Activer la caméra', '카메라 켜기'));
  if (player) player.tracks();
  updatePlayback(player); updateFilmMeta();
}

function updatePlayback(controller) {
  if (!controller) return;
  const phase = controller.state?.phase;
  const waiting = roomMessage?.members.filter(member => member.waiting)
    .map(member => member.reason ? `${member.name} (${why(member)})` : member.name) ?? [];
  const needsSound = controller.activationBlocked;
  // A paused room waiting on the viewer's click is not loading: the overlay
  // would hide the central play button under an endless spinner.
  const loading = controller.recovering || (!controller.activated && phase !== 'paused');
  const message = controller.failure ? label(controller.failure) : navigator.onLine === false ? t('Connexion perdue. Séance en pause.', '연결이 끊겨 일시정지되었습니다.') : !phase ? t('Reconnexion…', '다시 연결 중…') :
    needsSound ? t('Un clic pour activer le son', '클릭하여 소리를 켜세요') :
    loading ? t('Chargement du film…', '영화를 불러오는 중…') :
    phase === 'buffering' ? waiting.length ? t(`En attente de ${waiting.join(', ')}…`, `${waiting.join(', ')} 님을 기다리는 중…`, `Đang chờ ${waiting.join(', ')}…`) : t('La séance va commencer…', '곧 재생됩니다…', 'Buổi xem sắp bắt đầu…') : '';
  const overlay = !!message;
  const playing = controller.activated && ['playing', 'buffering'].includes(phase);
  const key = JSON.stringify([message, controller.failure, needsSound, phase, playing, language()]);
  if (controller.playbackUIKey === key) return;
  controller.playbackUIKey = key;
  $('buffering-overlay').hidden = !overlay;
  $('screen').dataset.overlay = String(overlay);
  const busy = overlay && !controller.failure && !needsSound;
  $('video').setAttribute('aria-busy', String(busy));
  $('playback-spinner').hidden = !busy;
  if ($('buffering-label').textContent !== message) $('buffering-label').textContent = message;
  $('allow-sound').hidden = !needsSound || !!controller.failure;
  $('playback-status').textContent = overlay ? '' : phase === 'paused' ? t('En pause', '일시정지') : '';
  $('watch').dataset.playing = String(playing);
  if (!playing) $('watch').dataset.chrome = 'true';
  for (const control of playbackUI.elements.buttons.play ?? []) {
    const text = playing ? t('Pause', '일시정지') : t('Lecture', '재생');
    control.setAttribute('aria-label', text);
    for (const tooltip of control.querySelectorAll('.plyr__tooltip')) tooltip.textContent = text;
  }
}
// Errors and links to read stay until closed, confirmations fade on their own.
let noticeTimer = null;
function notice(message = '', sticky = false) {
  const error = message instanceof Error;
  $('notice').textContent = label(error ? message.message : message);
  $('toast').dataset.tone = error ? 'danger' : '';
  clearTimeout(noticeTimer);
  if (message && !error && !sticky) noticeTimer = setTimeout(notice, 5000);
}
$('notice-close').addEventListener('click', () => notice());
// Sections are shown by clearing [hidden]; replay the entrance animation whenever that happens.
new MutationObserver(records => {
  for (const { target } of records) {
    if (target.hidden || target.tagName !== 'SECTION') continue;
    target.classList.remove('enter'); void target.offsetWidth; target.classList.add('enter');
  }
}).observe(document.querySelector('main'), { attributes: true, subtree: true, attributeFilter: ['hidden'] });
// Journal des intentions utilisateur : la télémétrie enrichit chaque action
// de la position et de la phase courantes (pos/phase/epoch).
const act = (action, value, fields) => { try { telemetry?.event('action', { act: action, value, ...fields }); } catch { } };
async function api(url, { body, method = 'GET', ...options } = {}) {
  const started = performance.now();
  let status;
  try {
    const response = await fetch(url, { method, ...options, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...options.headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    status = response.status;
    const result = await response.json();
    if (!response.ok) throw new Error(label(result.error || t('Une erreur est survenue.', '오류가 발생했습니다.')));
    return result;
  } catch (error) {
    // Jamais le corps de la réponse : chemin, méthode, statut, durée, message.
    telemetry?.event('api', { path: String(url).slice(0, 200), method, status,
      ms: Math.round(performance.now() - started), err: String(error?.message ?? error).slice(0, 200) });
    throw error;
  }
}
function handle(action) { return async event => { event?.preventDefault(); try { await action(event); } catch (error) { notice(error); } }; }
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
// Diagnostic codes, kept untranslated so they match the server logs verbatim.
const why = member => !member.reason ? '' : member.reason + (member.blockers?.length ? `: ${member.blockers.join(', ')}` : '') +
  (member.failure ? ` [${member.failure}]` : '') +
  (member.reason === 'low-buffer' && member.needed ? ` ${Math.max(0, Math.round(member.buffered))}s/${Math.round(member.needed)}s` : '');
function button(text, action, className) { const node = el('button', text, className); node.type = 'button'; node.addEventListener('click', handle(action)); return node; }
function field(text, input) { const node = el('label', text); input.setAttribute('aria-label', text); node.append(input); return node; }
function selectOptions(select, choices) {
  const previous = select.value;
  select.replaceChildren(...choices.map(([value, text]) => { const node = el('option', text); node.value = value; return node; }));
  if (choices.some(([value]) => String(value) === previous)) select.value = previous;
}
const IMAGE_SUBTITLES = new Set(IMAGE_SUBTITLE_CODECS);
const unavailableReason = (track, kind) =>
  kind === 'subtitles' && IMAGE_SUBTITLES.has(track.codec)
    ? t('sous-titres image, pas de conversion en texte possible', '이미지 자막은 텍스트로 변환할 수 없습니다')
    : !track.codec || track.codec === 'unknown' ? t('format non reconnu', '형식을 알 수 없습니다')
    : t('format non pris en charge', '지원되지 않는 형식입니다');
function trackInfo(track, kind) {
  const parts = [];
  if (!track.compatible) parts.push(`${t('Indisponible', '사용 불가')} : ${unavailableReason(track, kind)}`);
  const title = sourceTitle(track);
  if (title) parts.push(`${t('Nom d’origine', '원본 이름')} : ${title}`);
  parts.push(track.language ?? 'und', track.codec);
  if (kind === 'audio') {
    const layout = trackLayout(track);
    if (layout) parts.push(layout);
    if (track.compatible && !track.copy) parts.push(t('converti en AAC', 'AAC로 변환'));
  }
  if (track.forced) parts.push(t('forcés', '강제'));
  if (track.commentary) parts.push(t('commentaire', '코멘터리'));
  if (track.hearingImpaired) parts.push('SDH');
  if (track.visualImpaired) parts.push(t('audiodescription', '음성 해설'));
  if (track.defaultTrack) parts.push(t('par défaut', '기본'));
  return parts.filter(Boolean).join(' · ');
}
function runtime(seconds) {
  const total = Math.round(seconds / 60), hours = Math.floor(total / 60), minutes = total % 60;
  return hours ? t(`${hours} h ${String(minutes).padStart(2, '0')}`, `${hours}시간 ${minutes}분`, `${hours} giờ ${minutes} phút`) : t(`${minutes} min`, `${minutes}분`, `${minutes} phút`);
}
function formatSize(bytes) {
  const gb = bytes / 1024 ** 3;
  const text = gb >= 1 ? gb.toFixed(gb < 10 ? 1 : 0) : String(Math.max(1, Math.round(bytes / 1024 ** 2)));
  return gb >= 1 ? t(`${text} Go`, `${text}GB`, `${text}GB`) : t(`${text} Mo`, `${text}MB`, `${text}MB`);
}
function renderDisk() {
  if (!diskInfo) return;
  // Same margin as POST /api/uploads: the server needs room for the original plus its preparation.
  const needed = ($('upload-file').files[0]?.size ?? 0) * 2.2;
  const space = t(`${formatSize(diskInfo.free)} libres sur ${formatSize(diskInfo.total)}`,
    `${formatSize(diskInfo.total)} 중 ${formatSize(diskInfo.free)} 사용 가능`,
  `Còn ${formatSize(diskInfo.free)} trên ${formatSize(diskInfo.total)}`);
  const insufficient = needed > diskInfo.free;
  $('disk-space').textContent = insufficient
    ? t(`${space}. Espace insuffisant : il faut environ ${formatSize(needed)} pour ce film et sa préparation.`,
        `${space}. 공간 부족: 이 영화와 준비에는 약 ${formatSize(needed)}가 필요합니다.`,
        `${space}. Thiếu dung lượng: phim và việc chuẩn bị cần khoảng ${formatSize(needed)}.`)
    : space;
  $('disk-space').classList.toggle('insufficient', insufficient);
}
function updateFilmMeta() {
  const duration = roomMessage?.movie?.duration;
  const audio = $('audio').selectedOptions[0]?.textContent;
  const subtitles = $('subtitles').value === '-1' ? t('Sans sous-titres', '자막 없음') : $('subtitles').selectedOptions[0]?.textContent;
  $('movie-meta').textContent = [duration ? runtime(duration) : '', audio, subtitles].filter(Boolean).join(' · ');
}
async function refresh() {
  session = await api('/api/session');
  setScopeLanguages(player ? roomLanguages ?? ['fr', 'ko', 'vi']
    : adminPage && session.admin ? session.adminLanguages ?? ['fr', 'ko']
    : ['fr', 'ko', 'vi']);
  if (session.admin) {
    const voiceLabel = $('create-voice-label');
    const viPair = session.adminLanguages?.includes('vi');
    voiceLabel.dataset.fr = viPair ? 'Traduction vocale (français ↔ vietnamien)' : 'Traduction vocale (français ↔ coréen)';
    voiceLabel.dataset.ko = '음성 번역 (프랑스어 ↔ 한국어)';
    voiceLabel.dataset.vi = viPair ? 'Dịch giọng nói (tiếng Pháp ↔ tiếng Việt)' : 'Dịch giọng nói (tiếng Pháp ↔ tiếng Hàn)';
  }
  translate();
  $('logout').hidden = !session.authenticated; $('entry').hidden = !!player || (adminPage && session.admin);
  $('join-form').hidden = adminPage; $('login-form').hidden = !adminPage;
  $('library').hidden = !adminPage || !session.admin || !!player;
  $('choose-film').hidden = !session.admin;
  $('bandwidth-row').hidden = !session.admin;
  refreshBandwidth();
  if (!session.admin) return;
  movies = await api('/api/movies');
  selectOptions($('room-movie'), movies.filter(movie => movie.status === 'ready').map(movie => [movie.id, movie.title]));
  if (player || !adminPage) return;
  const lang = language();
  const signature = movie => JSON.stringify([lang, movie.status, movie.progress, movie.title, movie.error,
    movie.probe, movie.trackNames, movie.externalTracks, movie.subtitles]);
  const render = movie => {
    const key = signature(movie), cached = movieCards.get(movie.id);
    if (cached?.key === key) return cached.node;
    const node = movieCard(movie);
    movieCards.set(movie.id, { key, node });
    return node;
  };
  const pending = movies.filter(movie => movie.status !== 'ready');
  const ready = movies.filter(movie => movie.status === 'ready');
  $('movies-pending').replaceChildren(...pending.map(render));
  $('movies-ready').replaceChildren(...ready.map(render));
  for (const id of [...movieCards.keys()]) if (!movies.some(movie => movie.id === id)) { movieCards.delete(id); openPanels.delete(id); closedPanels.delete(id); }
  $('pending-heading').hidden = !pending.length; $('ready-heading').hidden = !ready.length; $('library-empty').hidden = !!movies.length;
  const rooms = await api('/api/rooms');
  $('rooms-empty').hidden = !!rooms.length;
  $('rooms-count').textContent = rooms.length || ''; $('films-count').textContent = movies.length || '';
  renderSettings(await api('/api/settings'));
  $('rooms').replaceChildren(...rooms.map(room => {
    const card = el('div', undefined, 'card');
    card.append(el('p', `${movies.find(movie => movie.id === room.movieId)?.title ?? ''} · ${room.participants} ${t('personne(s)', '명')} · ${t('jusqu’à', '까지')} ${new Date(room.expires).toTimeString().slice(0, 5)}`), el('code', room.code),
      button(t('Ouvrir', '열기'), () => enterRoom(room.id, undefined, { code: room.code, title: movies.find(movie => movie.id === room.movieId)?.title, enter: 'open' })), button(t('Copier le lien', '링크 복사'), () => copyLink(room.link)),
      button(t('Fermer la séance', '시청방 닫기'), async () => { await api(`/api/rooms/${room.id}`, { method: 'DELETE' }); await refresh(); }, 'danger'));
    return card;
  }));
  diskInfo = await api('/api/storage').catch(() => diskInfo);
  renderDisk();
  const uploads = await api('/api/uploads');
  $('pending-uploads').replaceChildren(...uploads.map(upload => {
    const card = el('div', undefined, 'card'); card.append(el('p', `${upload.name} · ${Math.round(upload.offset / upload.size * 100)} %`), el('p', t('Choisissez à nouveau le même fichier pour reprendre.', '같은 파일을 선택하면 이어서 업로드합니다.')),
      button(t('Supprimer cet envoi', '업로드 삭제'), async () => { await api(`/api/uploads/${upload.id}`, { method: 'DELETE' }); await refresh(); }, 'danger')); return card;
  }));
}
async function copyLink(link) {
  // Clipboard needs a secure context; on plain HTTP show the link instead.
  if (!navigator.clipboard) { notice(`${t('Lien', '링크')} : ${link}`, true); return; }
  await navigator.clipboard.writeText(link); notice(t('Lien copié.', '링크를 복사했습니다.'));
}
// Uploaded, checked, prepared, ready: where the film stands in its lifecycle at a glance.
function stepper(movie) {
  const { status } = movie, verified = !!movie.probe?.compatible;
  const states = ['done',
    verified ? 'done' : status === 'probing' ? 'active' : ['incompatible', 'failed'].includes(status) ? 'failed' : 'todo',
    !verified ? 'todo' : status === 'processing' ? 'active' : status === 'failed' ? 'failed' : 'todo', 'todo'];
  const percent = movie.progress ? ` ${movie.progress.percent} %` : '';
  const labels = [t('Envoyé', '업로드됨'), t('Vérifié', '확인됨'), t(`Préparation${percent}`, `준비${percent}`), t('Prêt', '준비 완료')];
  const list = el('ol', undefined, 'steps');
  list.append(...labels.map((text, index) => {
    const item = el('li', text); item.dataset.state = states[index];
    if (states[index] === 'active') item.setAttribute('aria-current', 'step');
    return item;
  }));
  return list;
}
function movieCard(movie) {
  const card = el('article', undefined, 'card'); card.append(el('h2', movie.title));
  const states = { ready: [t('Prêt à regarder', '시청 준비 완료'), 'ready'], uploaded: [t('À préparer', '준비 필요'), 'pending'],
    processing: [t('Préparation en cours…', '준비 중…'), 'pending'], probing: [t('Vérification…', '확인 중…'), 'pending'],
    failed: [t('Préparation échouée. Réessayez.', '준비에 실패했습니다. 다시 시도하세요.'), 'danger'],
    incompatible: [t('Ce fichier ne peut pas être lu.', '이 파일은 재생할 수 없습니다.'), 'danger'] };
  const [statusText, tone] = states[movie.status] ?? ['', 'pending'];
  const status = el('p', undefined, 'status'); status.dataset.tone = tone;
  status.append(el('span', undefined, 'dot'), document.createTextNode(statusText));
  if (movie.status !== 'ready') card.append(stepper(movie));
  card.append(status);
  if (movie.progress) {
    const bar = el('progress', undefined, 'card-progress'); bar.max = 100; bar.value = movie.progress.percent;
    card.append(bar);
  }
  if (movie.error) card.append(el('p', label(movie.error), 'media-error'));
  if (['processing', 'probing'].includes(movie.status)) return card;
  if (movie.status === 'ready') {
    const meta = [movie.duration ? runtime(movie.duration) : '',
      movie.audio?.length ? t(`${movie.audio.length} audio`, `음성 ${movie.audio.length}개`, `${movie.audio.length} âm thanh`) : '',
      movie.subtitles?.length ? t(`${movie.subtitles.length} sous-titres`, `자막 ${movie.subtitles.length}개`, `${movie.subtitles.length} phụ đề`) : '']
      .filter(Boolean).join(' · ');
    if (meta) card.append(el('p', meta, 'hint'));
    const create = async () => {
      randomCode(); $('create-voice').checked = $('create-webcam').checked = false;
      const code = await askDialog('create-dialog', 'create-code'); if (!code) return;
      const room = await api('/api/rooms', { method: 'POST', body: { movieId: movie.id, code, voice: $('create-voice').checked, webcam: $('create-webcam').checked } });
      await enterRoom(room.id, undefined, { code: room.code, title: movie.title, enter: 'create' });
    };
    card.append(button(t('Créer une séance', '시청방 만들기'), create));
    card.classList.add('clickable');
    card.addEventListener('click', event => { if (!event.target.closest('details, button, input, select, a, label')) handle(create)(); });
    card.append(manageDetails(movie));
    return card;
  }
  const audio = [], subtitles = [];
  const prepare = async () => {
    const chosen = list => list.filter(item => item.checkbox.checked);
    const naming = list => Object.fromEntries(chosen(list)
      .map(item => [item.index, item.field.value.trim()])
      .filter(([, value]) => value));
    await api(`/api/movies/${movie.id}/prepare`, { method: 'POST', body: {
      audio: chosen(audio).map(item => item.index), subtitles: chosen(subtitles).map(item => item.index),
      names: { audio: naming(audio), subtitles: naming(subtitles) },
    } }); await refresh();
  };
  if (['uploaded', 'failed'].includes(movie.status) && movie.probe?.compatible) card.append(button(t('Préparer le film', '영화 준비'), prepare));
  card.append(manageDetails(movie, { audio, subtitles, prepare }));
  return card;
}
function manageDetails(movie, selection) {
  const details = el('details');
  // An automatic open is not a user choice: it must not mark the panel as open.
  if (openPanels.has(movie.id)) details.open = true;
  else if (selection && !closedPanels.has(movie.id)) { details.dataset.auto = '1'; details.open = true; }
  details.addEventListener('toggle', () => {
    if (details.dataset.auto) { delete details.dataset.auto; return; }
    if (details.open) { openPanels.add(movie.id); closedPanels.delete(movie.id); }
    else { openPanels.delete(movie.id); closedPanels.add(movie.id); }
  });
  details.append(el('summary', selection ? t('Gérer le film', '영화 관리') : `⚙ ${t('Gérer le film', '영화 관리')}`));
  const title = el('input'); title.value = movie.title; title.maxLength = 150; title.setAttribute('aria-label', t('Titre', '제목'));
  const titleRow = el('div', undefined, 'title-row');
  titleRow.append(title, button(t('Enregistrer', '저장'), async () => { await api(`/api/movies/${movie.id}`, { method: 'PATCH', body: { title: title.value } }); await refresh(); }));
  const titleLabel = el('label'); titleLabel.append(el('span', t('Titre', '제목')), titleRow);
  details.append(titleLabel);
  if (selection) details.append(el('p', t('Ces noms sont ceux que verront les participants.', '참가자에게 표시되는 이름입니다.'), 'hint'));
  for (const [tracks, selected, heading, kind] of (selection ? [
    [movie.probe?.audio ?? [], selection.audio, t('Langues du film', '음성 언어'), 'audio'],
    [movie.probe?.subtitles ?? [], selection.subtitles, t('Sous-titres du film', '영화 자막'), 'subtitles']] : [])) {
    if (!tracks.length) continue;
    details.append(el('h3', heading));
    const fallbacks = defaultTrackNames(tracks, kind);
    for (const [position, track] of tracks.entries()) {
      const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = track.compatible; checkbox.disabled = !track.compatible;
      checkbox.setAttribute('aria-label', t('Garder cette piste', '이 트랙 사용'));
      const nameField = el('input'); nameField.maxLength = 60; nameField.disabled = !track.compatible;
      nameField.value = movie.trackNames?.[kind]?.[track.index] ?? fallbacks.get(track.index);
      nameField.setAttribute('aria-label', `${heading} ${position + 1}`);
      selected.push({ checkbox, index: track.index, field: nameField });
      const row = el('div', undefined, 'track-row'); row.append(checkbox, nameField);
      row.append(el('small', trackInfo(track, kind), 'track-hint'));
      details.append(row);
    }
  }
  details.append(el('h3', t('Sous-titres ajoutés', '추가된 자막')));
  const added = [
    ...(movie.externalTracks ?? []).map(track => ({ track, pending: true })),
    ...(movie.status === 'ready' ? (movie.subtitles ?? []).filter(track => track.external).map(track => ({ track, pending: false })) : []),
  ];
  if (!added.length) details.append(el('p', t('Aucun sous-titre ajouté.', '추가된 자막이 없습니다.'), 'hint'));
  for (const { track, pending } of added) {
    const row = el('div', undefined, 'track-row');
    row.append(el('span', `${track.label} · ${track.language}`, 'track-name'));
    if (pending && movie.status === 'ready') row.append(el('small', t('en attente', '대기 중'), 'track-tag'));
    // Le retiming n'a de sens que sur une piste déjà convertie en .vtt servi.
    const timingButton = button(t('Éditer le timing', '싱크 편집', 'Sửa timing'), () => openTiming(movie, track), 'ghost');
    timingButton.disabled = pending;
    if (pending) timingButton.title = t('Préparer le film pour éditer le timing.', '싱크를 편집하려면 영화를 먼저 준비하세요.', 'Hãy chuẩn bị phim trước để sửa timing.');
    row.append(timingButton);
    row.append(button(t('Retirer', '제거'), async () => {
      await api(`/api/movies/${movie.id}/${pending ? 'external' : 'subtitles'}/${track.id}`, { method: 'DELETE' });
      await refresh();
    }, 'ghost'));
    details.append(row);
  }
  const subFile = el('input'); subFile.type = 'file'; subFile.accept = SUBTITLE_ACCEPT;
  const subLang = el('select'); subLang.setAttribute('aria-label', t('Langue', '언어'));
  const second = (session.adminLanguages ?? ['fr', 'ko']).find(code => code !== 'fr') ?? 'ko';
  selectOptions(subLang, [['fr', 'French'], [second, languageName(second)], ['en', 'English'], ['und', 'Other']]);
  const subName = el('input'); subName.maxLength = 100; subName.placeholder = 'Ex. Korean'; subName.setAttribute('aria-label', t('Nom affiché', '표시 이름'));
  const addRow = el('div', undefined, 'add-row'); addRow.append(subLang, subName,
    button(t('Ajouter', '추가'), async () => {
      const file = subFile.files[0];
      const maxSubMb = settingsValues.maxSubtitleMb ?? 2;
      if (!file || !SUBTITLE_EXT.test(file.name) || file.size > maxSubMb * 1024 ** 2) throw new Error(t(`Choisir un fichier de sous-titres de moins de ${maxSubMb} Mo (SRT, VTT, SMI, ASS, SUB…).`, `자막 파일을 선택하세요 (SRT, VTT, SMI, ASS, SUB 등, 최대 ${maxSubMb}MB).`, `Chọn tệp phụ đề nhỏ hơn ${maxSubMb}MB (SRT, VTT, SMI, ASS, SUB…).`));
      const trackLabel = subName.value.trim() || subLang.selectedOptions[0].textContent;
      if (movie.status === 'ready') {
        const response = await fetch(`/api/movies/${movie.id}/subtitles?label=${encodeURIComponent(trackLabel)}&language=${subLang.value}&name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: file });
        const result = await response.json();
        if (!response.ok) throw new Error(label(result.error || t('Une erreur est survenue.', '오류가 발생했습니다.')));
        notice(t('Sous-titres ajoutés.', '자막이 추가되었습니다.'));
      } else await upload(file, { kind: 'subtitle', movieId: movie.id, label: trackLabel, language: subLang.value });
      await refresh();
    }));
  details.append(field(t(`Fichier de sous-titres (${settingsValues.maxSubtitleMb ?? 2} Mo maximum)`, `자막 파일 (최대 ${settingsValues.maxSubtitleMb ?? 2}MB)`, `Tệp phụ đề (tối đa ${settingsValues.maxSubtitleMb ?? 2}MB)`), subFile), addRow);
  details.append(el('p', selection
    ? t('La préparation applique la sélection ci-dessus.', '준비하면 위에서 선택한 트랙이 적용됩니다.')
    : t('Préparer à nouveau reconduit les pistes déjà choisies.', '다시 준비하면 선택한 트랙이 그대로 적용됩니다.'), 'hint'));
  const actions = el('div', undefined, 'panel-actions');
  if (selection) {
    if (movie.probe?.compatible) actions.append(button(t('Préparer le film', '영화 준비'), selection.prepare));
    else actions.append(button(t('Vérifier le fichier', '파일 확인'), async () => { await api(`/api/movies/${movie.id}/probe`, { method: 'POST', body: {} }); await refresh(); }));
  } else actions.append(button(t('Préparer à nouveau', '다시 준비'), async () => {
    await api(`/api/movies/${movie.id}/prepare`, { method: 'POST', body: {} }); await refresh();
  }));
  actions.append(button(t('Supprimer le film', '영화 삭제'), async () => {
    if (confirm(t(`Supprimer définitivement « ${movie.title} » ?`, `« ${movie.title} » 영화를 영구 삭제할까요?`, `Xóa vĩnh viễn « ${movie.title} » ?`))) { await api(`/api/movies/${movie.id}`, { method: 'DELETE' }); await refresh(); }
  }, 'danger'));
  details.append(actions);
  return details;
}

async function enterRoom(id, name, context = {}) {
  let named = false;
  if (!name) {
    $('room-name').value = localStorage.getItem('nickname') || '';
    $('name-context').hidden = !context.code;
    $('name-code').textContent = context.code ?? ''; $('name-movie').textContent = context.title ?? '';
    name = await askDialog('name-dialog', 'room-name');
    if (!name) return;
    named = true;
  }
  $('room-code').textContent = context.code ?? '';
  localStorage.setItem('nickname', name); showSettings(false);
  const roomState = await api(`/api/rooms/${id}`); session = await api('/api/session');
  roomLanguages = roomState.languages ?? null;
  setScopeLanguages(roomLanguages ?? ['fr', 'ko', 'vi']); translate();
  disposePlayer(); activeRoom = id; roomMessage = null;
  $('voice-mic').hidden = $('voice-local').hidden = $('voice-result').hidden = true;
  $('webcam-toggle').hidden = $('webcam-overlay').hidden = true;
  $('entry').hidden = true; $('library').hidden = true; $('watch').hidden = false; $('choose-film').hidden = !session.admin;
  // La dérogation #telemetry=off est reportée dans le hash : la télémétrie la lit
  // à l'attache, donc une réécriture qui l'efface la rendrait sans effet.
  const keep = new URLSearchParams(location.hash.slice(1)).get('telemetry');
  history.replaceState(null, '', `${adminPage ? '/admin' : '/'}#room=${id}${keep ? `&telemetry=${keep}` : ''}`);
  player = window.player = new SyncPlayer({ video: $('video'), roomId: id, name,
    forceShader: sessionStorage.getItem('hdr') === 'shader',
    onVoice: message => voice?.message(message),
    onWebcam: message => webcam?.message(message),
    onStatus: message => { telemetry?.event('status', { msg: message }); $('playback-status').textContent = label(message); updatePlayback(player); },
    onActivation: () => updatePlayback(player),
    onTracks: (audio, subtitles) => {
      selectOptions($('audio'), audio.length ? audio.map(track => [track.index, trackName(track)]) : [[-1, t('Sans son', '음성 없음')]]); $('audio').disabled = audio.length < 2;
      selectOptions($('subtitles'), [[-1, t('Sans sous-titres', '자막 없음')], ...subtitles.map(track => [track.index, trackName(track)])]); $('subtitles').disabled = !subtitles.length;
      if (player) { $('audio').value = String(audio.length ? player.audioChoice : -1); $('subtitles').value = String(player.subtitleChoice); }
      updateFilmMeta();
    },
    onState: (message, controller) => {
      roomMessage = message; updatePlayback(controller);
      const voice = message.voice;
      $('voice-mic').hidden = !voice?.enabled;
      if (voice) {
        $('voice-mic').disabled = !voice.available;
        $('voice-mic').title = voice.available ? '' : t('Traduction vocale indisponible', '음성 번역을 사용할 수 없습니다');
      }
      $('webcam-toggle').hidden = !message.webcam?.enabled;
      webcam?.announce();
      const key = JSON.stringify([message.movie?.id, message.movie?.title, message.code, controller.memberId,
        language(), message.members.map(({ id, name, waiting, reason, blockers, failure, buffered }) => [id, name, waiting, reason, blockers, failure, Math.round(buffered ?? 0)])]);
      if (controller.roomUIKey === key) return;
      controller.roomUIKey = key;
      $('movie-title').textContent = message.movie?.title ?? ''; $('room-movie').value = message.movie?.id ?? '';
      if (message.code) $('room-code').textContent = message.code;
      updateFilmMeta();
      const ready = message.members.filter(member => !member.waiting).length, total = message.members.length;
      $('member-count').textContent = total ? t(`${ready} personne${ready > 1 ? 's' : ''} prête${ready > 1 ? 's' : ''} sur ${total}`, `${total}명 중 ${ready}명 준비 완료`, `${ready}/${total} người sẵn sàng`) : '';
      $('participants').replaceChildren(...message.members.map(member => {
        const item = el('li'); item.dataset.ready = String(!member.waiting);
        item.append(el('span', ([...member.name.trim()][0] ?? '?').toUpperCase(), 'avatar'),
          el('strong', `${member.name}${member.id === controller.memberId ? t(' · vous', ' · 나') : ''}`),
          el('span', member.waiting ? t('Chargement…', '준비 중…') : t('Prêt', '준비 완료'), member.waiting ? undefined : 'visually-hidden'));
        if (member.waiting && member.reason) item.append(el('small', why(member), 'track-tag'));
        return item;
      }));
    },
  });
  // Le journal client démarre avec la séance, avant la première trame :
  // contexte connu dès l'entrée (code, probe, langues, film, réglages, rôle)
  // plus la manière d'entrer. Un accès en échec ne doit jamais casser l'entrée.
  try {
    telemetry = attachTelemetry(player, $('video'), id, { context: {
      code: roomState.code ?? context.code, probe: roomState.probe === true,
      languages: roomState.languages ?? roomLanguages, movie: roomState.movie,
      sync: roomState.sync, admin: session.admin === true, name,
      forceShader: sessionStorage.getItem('hdr') === 'shader', hdr: sessionStorage.getItem('hdr'),
      enter: context.enter ?? (adminPage ? 'admin' : 'room') } });
  } catch { telemetry = null; }
  act('join');
  if (named) act('nickname');
  if (sessionStorage.getItem('hdr')) act('hdr', sessionStorage.getItem('hdr'));
  const onEvent = (type, fields) => { try { telemetry?.event(type, fields); } catch { } };
  voice = attachVoice({ mic: $('voice-mic'), local: $('voice-local'), supertitle: $('voice-result'), player, t, label, onEvent });
  webcam = attachWebcam({ toggle: $('webcam-toggle'), overlay: $('webcam-overlay'), player, t, label, onEvent });
  refreshBandwidth();
  if (session.admin) { movies = await api('/api/movies'); selectOptions($('room-movie'), movies.filter(movie => movie.status === 'ready').map(movie => [movie.id, movie.title])); }
}
$('language').addEventListener('change', handle(async () => { localStorage.setItem('language', $('language').value); translate(); notice(); if (!player && !uploadBusy) await refresh(); }));
$('login-form').addEventListener('submit', handle(async event => { await api('/api/login', { method: 'POST', body: { password: new FormData(event.target).get('password') } }); event.target.reset(); notice(); await refresh(); }));
$('join-form').addEventListener('submit', handle(async event => {
  const data = new FormData(event.target);
  const room = await api('/api/join', { method: 'POST', body: { code: data.get('code') } }); notice();
  await enterRoom(room.id, undefined, { code: String(data.get('code')).trim(), enter: /[#&?]invite=/.test(location.hash) ? 'invite' : 'join' });
}));
// A pasted invitation link would be cut by maxlength before any input event, so it is caught at paste time.
$('join-form').elements.code.addEventListener('paste', event => {
  const code = /[#&?]invite=([^&\s]+)/.exec(event.clipboardData.getData('text'))?.[1];
  if (!code) return;
  event.preventDefault(); event.target.value = code;
});
$('logout').addEventListener('click', handle(async () => { disposePlayer(); activeRoom = null; roomLanguages = null; $('watch').hidden = true; history.replaceState(null, '', adminPage ? '/admin' : '/'); await api('/api/logout', { method: 'POST', body: {} }); await refresh(); }));
$('refresh').addEventListener('click', handle(refresh));
const tabs = [...document.querySelectorAll('#admin-tabs [role=tab]')];
function showTab(name) {
  sessionStorage.setItem('admin-tab', name);
  for (const tab of tabs) {
    const on = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1; $(`tab-${tab.dataset.tab}`).hidden = !on;
  }
}
showTab(tabs.some(tab => tab.dataset.tab === sessionStorage.getItem('admin-tab')) ? sessionStorage.getItem('admin-tab') : 'films');
for (const tab of tabs) tab.addEventListener('click', () => showTab(tab.dataset.tab));
$('admin-tabs').addEventListener('keydown', event => {
  const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
  if (!step) return;
  const next = tabs[(tabs.indexOf(document.activeElement) + step + tabs.length) % tabs.length];
  showTab(next.dataset.tab); next.focus();
});
$('allow-sound').addEventListener('click', handle(() => player?.activate()));
$('copy-invite').addEventListener('click', handle(() => { act('invite'); copyLink(`${location.origin}/#invite=${encodeURIComponent($('room-code').textContent)}`); }));
$('upload-file').addEventListener('change', handle(async () => {
  renderDisk();
  if ($('upload-file').files[0] && !$('disk-space').classList.contains('insufficient')) await upload($('upload-file').files[0]);
}));
// A film dropped anywhere on the library goes to the upload; a subtitle dropped on its own card input keeps the native path.
const filesDrag = event => event.dataTransfer?.types.includes('Files') && !$('library').hidden && !uploadBusy &&
  !(event.target.matches?.('input[type=file]') && event.target !== $('upload-file'));
document.addEventListener('dragover', event => {
  if (!filesDrag(event)) return;
  event.preventDefault(); showTab('films'); $('upload-form').classList.add('dragging');
});
document.addEventListener('dragleave', event => { if (!event.relatedTarget) $('upload-form').classList.remove('dragging'); });
document.addEventListener('drop', event => {
  $('upload-form').classList.remove('dragging');
  if (!filesDrag(event) || !event.dataTransfer.files.length) return;
  event.preventDefault();
  const transfer = new DataTransfer(); transfer.items.add(event.dataTransfer.files[0]);
  $('upload-file').files = transfer.files; $('upload-file').dispatchEvent(new Event('change'));
});
$('audio').addEventListener('change', () => { act('track-audio', Number($('audio').value)); player?.changeTrack('audio', Number($('audio').value)); });
$('subtitles').addEventListener('change', () => {
  const value = Number($('subtitles').value);
  act('track-subs', value);
  if (value !== -1) lastSubtitle = value;
  player?.changeTrack('subtitles', value);
});
// A per-viewer multiplier on the picture-based size, shared by subtitles and the translated supertitle.
const subtitleScale = () => { $('screen').style.setProperty('--subtitle-scale', $('subtitle-size').value); localStorage.setItem('subtitle-scale', $('subtitle-size').value); };
if ([...$('subtitle-size').options].some(option => option.value === localStorage.getItem('subtitle-scale'))) $('subtitle-size').value = localStorage.getItem('subtitle-scale');
subtitleScale();
$('subtitle-size').addEventListener('change', subtitleScale);
$('leave').addEventListener('click', handle(async () => { act('leave'); disposePlayer(); activeRoom = null; roomLanguages = null; $('watch').hidden = true; history.replaceState(null, '', adminPage ? '/admin' : '/'); await refresh(); }));
$('choose-film').addEventListener('submit', handle(() => api(`/api/rooms/${activeRoom}/movie`, { method: 'POST', body: { movieId: $('room-movie').value } })));
const SETTING_LABELS = {
  minBuffer: ['Buffer de démarrage (s)', '시작 버퍼 (초)'],
  lowBuffer: ['Réserve de lecture (s)', '재생 예비 버퍼 (초)'],
  reportTimeout: ['Expiration des rapports (s)', '보고서 만료 (초)'],
  startDelay: ['Délai avant le départ (s)', '시작 지연 (초)'],
  tickMs: ['Cadence des états (ms)', '상태 전송 주기 (ms)'],
  sweepMs: ['Cadence de présence (ms)', '연결 점검 주기 (ms)'],
  ttlHours: ['Durée des sessions et séances (h)', '세션·시청방 유지 (시간)'],
  maxRooms: ['Séances simultanées', '동시 시청방 수'],
  maxClients: ['Participants par séance', '시청방당 참가자 수'],
  maxSocketsPerSession: ['Connexions par participant', '참가자당 연결 수'],
  chunkMb: ['Taille des blocs d’envoi (Mo)', '업로드 청크 크기 (MB)'],
  maxPending: ['Envois simultanés', '동시 업로드 수'],
  maxMovieGb: ['Taille maximale d’un film (Go)', '영화 최대 크기 (GB)'],
  maxSubtitleMb: ['Taille maximale d’un sous-titre (Mo)', '자막 최대 크기 (MB)'],
  maxExternalTracks: ['Sous-titres ajoutés par film', '영화당 추가 자막 수'],
  encodeThreads: ['Threads de préparation', '준비 스레드 수'],
  segmentSeconds: ['Durée des segments (s)', '세그먼트 길이 (초)'],
  loginLimit: ['Essais de connexion par 15 min', '15분당 로그인 시도 수'],
  inviteLimit: ['Essais de code par minute', '분당 코드 시도 수'],
  voiceQuota: ['Appels de traduction par participant', '참가자당 번역 호출 수'],
  voiceWindow: ['Fenêtre du quota de traduction (s)', '번역 쿼터 시간 창 (초)'],
  voiceCooldown: ['Délai entre deux prises (s)', '연속 발화 최소 간격 (초)'],
  telemetryDays: ['Durée de conservation des journaux (j)', '로그 보관 기간 (일)'],
  telemetryMb: ['Taille maximale des journaux (Mo)', '로그 최대 크기 (MB)'],
  telemetryFileMb: ['Taille d’un journal avant rotation (Mo)', '로그 파일 최대 크기 (MB)'],
};
// Aide au survol, en français seul : l'attribut title sert aussi de
// description accessible pour le lecteur d'écran.
const SETTING_DESCRIPTIONS = {
  minBuffer: 'Secondes de tampon à accumuler avant de lancer ou reprendre la lecture.',
  lowBuffer: 'En dessous de cette réserve pendant la lecture, la séance se met en pause pour recharger.',
  reportTimeout: 'Sans rapport d’un participant pendant ce délai, son état de lecture est ignoré.',
  startDelay: 'Compte à rebours entre le déclenchement de la lecture et le départ effectif.',
  tickMs: 'Intervalle entre deux envois de l’état de lecture aux participants.',
  sweepMs: 'Intervalle entre deux vérifications des connexions encore présentes.',
  ttlHours: 'Durée de vie d’une session ou d’une séance laissée inactive.',
  maxRooms: 'Nombre de séances pouvant être ouvertes en même temps.',
  maxClients: 'Nombre de participants acceptés dans une même séance.',
  maxSocketsPerSession: 'Connexions simultanées autorisées pour un même participant, par exemple plusieurs onglets.',
  chunkMb: 'Taille de chaque morceau envoyé pendant l’envoi d’un fichier.',
  maxPending: 'Nombre d’envois de fichiers pouvant être en cours en même temps.',
  maxMovieGb: 'Taille maximale acceptée pour un fichier film.',
  maxSubtitleMb: 'Taille maximale acceptée pour un fichier de sous-titres ajouté.',
  maxExternalTracks: 'Nombre de pistes de sous-titres ajoutables à un film.',
  encodeThreads: 'Nombre de threads ffmpeg utilisés pendant la préparation d’un film.',
  segmentSeconds: 'Durée de chaque segment vidéo produit pour la lecture.',
  loginLimit: 'Tentatives de connexion autorisées par tranche de 15 minutes.',
  inviteLimit: 'Tentatives de code d’invitation autorisées par minute.',
  voiceQuota: 'Nombre maximal d’appels au fournisseur de traduction par participant sur la fenêtre glissante.',
  voiceWindow: 'Durée de la fenêtre glissante sur laquelle le quota de traduction est compté.',
  voiceCooldown: 'Délai minimal après chaque prise de parole avant qu’un nouveau départ soit accepté.',
  telemetryDays: 'Âge maximal d’un fichier de télémétrie avant suppression.',
  telemetryMb: 'Taille totale maximale du dossier de télémétrie ; les journaux les plus anciens sont supprimés.',
  telemetryFileMb: 'Taille à partir de laquelle un journal de télémétrie est fermé et remplacé.',
};
const SETTING_CATEGORIES = { sync: ['Synchronisation', '동기화'], rooms: ['Séances', '시청방'],
  uploads: ['Envois', '업로드'], media: ['Préparation', '준비'], security: ['Sécurité', '보안'], voice: ['Traduction vocale', '음성 번역'],
  telemetry: ['Télémétrie', '텔레메트리'] };
let settingsValues = {};
const settingInputs = new Map();
function renderSettings(payload) {
  const form = $('settings-form');
  if (!form.childElementCount) {
    for (const [category, [fr, ko]] of Object.entries(SETTING_CATEGORIES)) {
      const fields = payload.fields.filter(field => field.category === category);
      if (!fields.length) continue;
      const group = el('fieldset');
      group.append(el('legend', t(fr, ko)));
      for (const field of fields) {
        const input = el('input');
        input.type = 'number'; input.id = `set-${field.key}`; input.required = true;
        input.min = field.min; input.max = field.max; input.step = field.step ?? 1;
        const hint = el('small', undefined, 'setting-hint');
        const label = el('label');
        const text = el('span', t(...(SETTING_LABELS[field.key] ?? [field.key, field.key])));
        text.title = input.title = SETTING_DESCRIPTIONS[field.key];
        label.append(text, input);
        const row = el('div', undefined, 'setting-row');
        row.append(label, hint);
        group.append(row);
        settingInputs.set(field.key, { input, hint });
      }
      form.append(group);
    }
    const actions = el('div', undefined, 'dialog-actions');
    const save = el('button', t('Enregistrer', '저장')); save.id = 'settings-save';
    const reset = button(t('Valeurs par défaut', '기본값'), async () => {
      renderSettings(await api('/api/settings/reset', { method: 'POST', body: {} }));
      notice(t('Valeurs par défaut rétablies.', '기본값을 복원했습니다.'));
    }, 'ghost');
    reset.id = 'settings-reset';
    actions.append(save, reset);
    form.append(actions);
  }
  settingsValues = Object.fromEntries(payload.fields.map(field => [field.key, field.value]));
  for (const field of payload.fields) {
    const { input, hint } = settingInputs.get(field.key);
    if (document.activeElement !== input) input.value = field.value;
    hint.textContent = field.overridden ? t(`défaut : ${field.default}`, `기본값: ${field.default}`, `mặc định: ${field.default}`) : '';
  }
  const fileLabel = $('upload-file-label');
  fileLabel.dataset.fr = `Fichier du film (${settingsValues.maxMovieGb} Go maximum)`;
  fileLabel.dataset.ko = `영화 파일 (최대 ${settingsValues.maxMovieGb}GB)`;
  fileLabel.dataset.vi = `Tệp phim (tối đa ${settingsValues.maxMovieGb}GB)`;
  fileLabel.textContent = fileLabel.dataset[language()] ?? fileLabel.dataset.fr;
}
$('settings-form').addEventListener('submit', handle(async () => {
  const body = Object.fromEntries([...settingInputs].map(([key, { input }]) => [key, Number(input.value)]));
  renderSettings(await api('/api/settings', { method: 'PATCH', body }));
  notice(t('Réglages enregistrés.', '설정을 저장했습니다.'));
}));
// ── Éditeur de timing d'une piste de sous-titres ajoutée ────────────────
// Le brouillon vit dans la boîte de dialogue : les répliques ne sont
// persistées qu'à l'enregistrement, donc annuler/Esc ne coûte rien. Le lecteur
// reste minimal (pas de Plyr) — ici on vérifie une piste, on ne fait pas séance.
let timing = null, timingBlocks = [], timingRows = [], timingDrag = null, timingScrubbing = false;
const timingDialog = $('timing-dialog'), timingVideo = $('timing-video');
async function openTiming(movie, track) {
  const payload = await api(`/api/movies/${movie.id}/subtitles/${track.id}/cues`);
  timing = { movie, track, cues: payload.cues, origin: payload.origin ?? null, duration: payload.duration || 1, selected: -1, active: -1, hls: null, positioned: false };
  $('timing-context').textContent = `${movie.title} · ${track.label} · ${track.language}`;
  timingPlayLabel();
  $('timing-offset').value = '0'; $('timing-propagate').checked = false;
  $('timing-seek').value = '0'; $('timing-time').textContent = formatTimestamp(0);
  $('timing-playhead').style.left = '0%'; $('timing-overlay').textContent = '';
  timingVideo.removeAttribute('src'); timingVideo.load();
  $('timing-loading').hidden = false;
  // Pas de pistes natives : hls.js créerait des <track> en data: que la CSP
  // refuse, et l'éditeur rend lui-même la réplique courante dans l'overlay.
  const url = `/media/${movie.id}/master.m3u8`;
  if (window.Hls?.isSupported()) {
    timing.hls = new window.Hls({ renderTextTracksNatively: false });
    timing.hls.loadSource(url); timing.hls.attachMedia(timingVideo);
  } else if (timingVideo.canPlayType('application/vnd.apple.mpegurl')) timingVideo.src = url;
  buildTiming(); renderTiming();
  timingDialog.showModal();
  timingLayout();
}
// Blocs et lignes persistent pendant l'édition : les répliques ne s'ajoutent
// ni ne se suppriment ici, et un bloc gardé garde sa capture de pointeur.
function buildTiming() {
  timingBlocks = timing.cues.map(() => {
    const block = el('button', undefined, 'timing-cue'); block.type = 'button';
    return block;
  });
  $('timing-track').replaceChildren($('timing-playhead'), ...timingBlocks);
  timingRows = timing.cues.map((cue, index) => {
    const row = el('li');
    row.append(el('span', '', 'timing-range'), el('span', cue.text.replaceAll('\n', ' ⏎ '), 'cue-text'));
    row.addEventListener('click', () => {
      timing.selected = index; timingVideo.currentTime = timing.cues[index].start; renderTiming();
    });
    return row;
  });
  $('timing-cues').replaceChildren(...timingRows);
}
function renderTiming() {
  const span = timing.duration || 1;
  for (const [index, cue] of timing.cues.entries()) {
    const block = timingBlocks[index];
    block.style.left = `${Math.min(100, cue.start / span * 100)}%`;
    block.style.width = `${Math.max(0.4, (cue.end - cue.start) / span * 100)}%`;
    block.dataset.selected = String(index === timing.selected);
    block.title = `${formatTimestamp(cue.start)} → ${formatTimestamp(cue.end)}`;
    const row = timingRows[index];
    row.dataset.selected = String(index === timing.selected);
    row.firstChild.textContent = `${formatTimestamp(cue.start)} → ${formatTimestamp(cue.end)}`;
  }
  const cue = timing.cues[timing.selected];
  $('timing-edit').hidden = !cue;
  if (cue) {
    if (document.activeElement !== $('timing-edit-start')) $('timing-edit-start').value = cue.start.toFixed(3);
    if (document.activeElement !== $('timing-edit-end')) $('timing-edit-end').value = cue.end.toFixed(3);
  }
  timingOverlayText();
  renderTimingOrigin();
}
// Le décalage courant par rapport à la copie d'origine figée à l'import : il
// se recalcule à chaque rendu, donc il décrit le brouillon affiché (recalage
// compris) et ne reste jamais périmé. Une piste importée avant le suivi n'a
// pas de référence : l'affichage l'annonce au lieu d'inventer un chiffre.
function renderTimingOrigin() {
  if (!timing) return;
  const shift = shiftSummary(timing.cues, timing.origin);
  const label = t('Décalage actuel', '현재 오프셋', 'Độ lệch hiện tại');
  $('timing-origin').textContent = !shift.origin
    ? `${label} : ${t('origine inconnue', '원본 불명', 'không rõ nguồn gốc')}`
    : `${label} : ${(shift.shiftMs / 1000).toLocaleString(language(), { minimumFractionDigits: 3, maximumFractionDigits: 3, signDisplay: 'exceptZero' })} s`
      + (shift.uniform ? '' : ` · ${t(`${shift.editedCues} répliques ajustées individuellement`,
        `대사 ${shift.editedCues}개 개별 조정`, `${shift.editedCues} câu chỉnh riêng`)}`);
  // Le bouton n'a rien à rétablir que si le brouillon porte déjà le timing
  // d'origine (décalage uniforme nul, durées intactes). Une retouche isolée —
  // médiane nulle mais non uniforme, durée changée — garde un chemin de retour.
  $('timing-reset').disabled = !timing.origin || (shift.origin && shift.uniform && !shift.shiftMs && !shift.durationsChanged);
}
function timingOverlayText() {
  if (!timing) return;
  const active = cueIndexAt(timing.cues, timingVideo.currentTime);
  $('timing-overlay').textContent = active >= 0 ? timing.cues[active].text : '';
  if (active !== timing.active) {
    timing.active = active;
    timingBlocks.forEach((node, index) => node.dataset.active = String(index === active));
    timingRows.forEach((node, index) => node.dataset.active = String(index === active));
    if (active >= 0) timingRows[active]?.scrollIntoView({ block: 'nearest' });
  }
}
// La taille de la réplique affichée suit la hauteur réellement peinte, comme
// les sous-titres de la séance sur .video-stage.
const timingLayout = () => {
  if (!timing) return;
  const box = timingVideo.getBoundingClientRect(), aspect = timingVideo.videoWidth / timingVideo.videoHeight || 16 / 9;
  const picture = Math.min(box.height, box.width / aspect);
  if (picture > 0) timingDialog.querySelector('.timing-stage').style.setProperty('--subtitle-size', `${subtitleFontSize(picture)}px`);
};
// Clic sur la piste = seek ; clic sur une réplique = sélection + seek à son
// début ; glisser la décale d'un bloc (snap 10 ms), ainsi que les suivantes
// quand la propagation est cochée.
$('timing-track').addEventListener('pointerdown', event => {
  if (!timing) return;
  const box = $('timing-track').getBoundingClientRect();
  const index = timingBlocks.indexOf(event.target.closest('.timing-cue'));
  if (index < 0) {
    timingVideo.currentTime = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) * timing.duration;
    return;
  }
  timingDrag = { index, x: event.clientX, moved: false, cues: timing.cues };
  event.target.setPointerCapture(event.pointerId);
});
$('timing-track').addEventListener('pointermove', event => {
  if (!timingDrag || !timing) return;
  const box = $('timing-track').getBoundingClientRect();
  const delta = Math.round((event.clientX - timingDrag.x) / box.width * timing.duration * 100) / 100;
  if (!timingDrag.moved && !delta) return;
  timingDrag.moved = true;
  const to = $('timing-propagate').checked ? timing.cues.length : timingDrag.index + 1;
  timing.cues = shiftCues(timingDrag.cues, delta, timingDrag.index, to);
  renderTiming();
});
$('timing-track').addEventListener('pointerup', () => {
  if (!timingDrag) return;
  const { index, moved } = timingDrag; timingDrag = null;
  if (!moved && timing) { timing.selected = index; timingVideo.currentTime = timing.cues[index].start; }
  if (timing) renderTiming();
});
$('timing-track').addEventListener('pointercancel', () => { timingDrag = null; });
// Déclaration de fonction (hissée) : translate() l'appelle et s'exécute plus haut
// dans le module que cet éditeur.
function timingPlayLabel() {
  const playing = !timingVideo.paused;
  $('timing-play').dataset.state = playing ? 'playing' : 'paused';
  $('timing-play').setAttribute('aria-label', playing ? t('Pause', '일시정지', 'Tạm dừng') : t('Lecture', '재생', 'Phát'));
}
timingVideo.addEventListener('play', timingPlayLabel);
timingVideo.addEventListener('pause', timingPlayLabel);
$('timing-play').addEventListener('click', () => {
  if (!timing) return;
  if (timingVideo.paused) timingVideo.play().catch(() => {}); else timingVideo.pause();
});
$('timing-back').addEventListener('click', () => { timingVideo.currentTime = Math.max(0, timingVideo.currentTime - 5); });
$('timing-forward').addEventListener('click', () => { timingVideo.currentTime = Math.min(timing?.duration ?? Infinity, timingVideo.currentTime + 5); });
$('timing-seek').addEventListener('input', () => { if (timing) timingVideo.currentTime = Number($('timing-seek').value) / 1000 * timing.duration; });
$('timing-seek').addEventListener('pointerdown', () => { timingScrubbing = true; });
$('timing-seek').addEventListener('pointerup', () => { timingScrubbing = false; });
// À l'ouverture l'aperçu se cale sur la première réplique : le texte apparaît
// sur l'image tout de suite, sans attendre un premier clic dans du noir.
timingVideo.addEventListener('loadedmetadata', () => {
  timingLayout();
  $('timing-loading').hidden = true;
  if (timing && !timing.positioned && timing.cues[0]?.start > 0) {
    timing.positioned = true;
    timingVideo.currentTime = timing.cues[0].start;
  }
});
window.addEventListener('resize', timingLayout);
timingVideo.addEventListener('timeupdate', () => {
  if (!timing) return;
  const now = timingVideo.currentTime;
  $('timing-playhead').style.left = `${Math.min(100, now / timing.duration * 100)}%`;
  if (!timingScrubbing) $('timing-seek').value = String(Math.round(now / timing.duration * 1000));
  $('timing-time').textContent = formatTimestamp(now);
  timingOverlayText();
});
// Champs de la réplique sélectionnée : une valeur invalide est réaffichée
// telle que dans le brouillon — rien n'est perdu.
const timingCommit = () => {
  const cue = timing?.cues[timing.selected];
  if (!cue) return;
  const start = Number($('timing-edit-start').value), end = Number($('timing-edit-end').value);
  if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start) { cue.start = start; cue.end = end; }
  renderTiming();
};
$('timing-edit-start').addEventListener('change', timingCommit);
$('timing-edit-end').addEventListener('change', timingCommit);
for (const [id, input, ms] of [
  ['timing-edit-start-minus', 'timing-edit-start', -100], ['timing-edit-start-plus', 'timing-edit-start', 100],
  ['timing-edit-end-minus', 'timing-edit-end', -100], ['timing-edit-end-plus', 'timing-edit-end', 100]]) {
  $(id).addEventListener('click', () => { $(input).value = (Number($(input).value) + ms / 1000).toFixed(3); timingCommit(); });
}
$('timing-edit-start-playhead').addEventListener('click', () => { $('timing-edit-start').value = timingVideo.currentTime.toFixed(3); timingCommit(); });
$('timing-edit-end-playhead').addEventListener('click', () => { $('timing-edit-end').value = timingVideo.currentTime.toFixed(3); timingCommit(); });
// Décalage : l'input porte un montant en ms appliqué à la saisie, les quatre
// boutons sont des raccourcis appliqués tout de suite. La case limite le
// décalage à la réplique sélectionnée et aux suivantes.
const applyOffset = ms => {
  if (!timing || !Number.isFinite(ms) || !ms) return;
  const from = $('timing-propagate').checked && timing.selected >= 0 ? timing.selected : 0;
  timing.cues = shiftCues(timing.cues, ms / 1000, from);
  renderTiming();
};
for (const [id, ms] of [['timing-offset-minus-1s', -1000], ['timing-offset-minus-100ms', -100],
  ['timing-offset-plus-100ms', 100], ['timing-offset-plus-1s', 1000]]) {
  $(id).addEventListener('click', () => { $('timing-offset').value = ms; applyOffset(ms); });
}
$('timing-offset').addEventListener('change', () => applyOffset(Number($('timing-offset').value)));
// Recalage automatique : le serveur mesure le décalage répliques/parole en
// tâche de fond (POST 202 puis sondage), le résultat est ensuite posé comme
// un décalage saisi à la main — l'aperçu reste un brouillon à valider. Le
// sondage s'arrête avec la boîte : `timing` repasse à null à la fermeture.
$('timing-auto').addEventListener('click', handle(async () => {
  if (!timing) return;
  const url = `/api/movies/${timing.movie.id}/subtitles/${timing.track.id}/auto-timing`;
  $('timing-auto').disabled = true;
  try {
    await api(url, { method: 'POST', body: {} });
    notice(t('Analyse de la bande son…', '음성 분석 중…', 'Đang phân tích âm thanh…'));
    const deadline = Date.now() + 300_000;
    while (timing && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (!timing) return;
      const state = await api(url);
      if (state.state === 'running') continue;
      if (state.state === 'error') throw new Error(state.error);
      const result = state.result;
      if (!result) return;
      if (result.offset === null) {
        notice(result.reason === 'no-speech'
          ? t('Aucune parole détectée dans la bande son.', '음성이 감지되지 않았습니다.', 'Không phát hiện lời thoại trong âm thanh.')
          : result.reason === 'too-few-cues'
            ? t('Pas assez de répliques pour mesurer un décalage.', '대사가 너무 적어 오프셋을 측정할 수 없습니다.', 'Không đủ câu thoại để đo độ lệch.')
            : t('Aucun décalage fiable trouvé.', '신뢰할 수 있는 오프셋을 찾지 못했습니다.', 'Không tìm thấy độ lệch đáng tin.'));
        return;
      }
      const ms = Math.round(result.offset * 1000);
      $('timing-offset').value = ms;
      applyOffset(ms);
      const confidence = { high: t('confiance haute', '신뢰도 높음', 'độ tin cậy cao'),
        medium: t('confiance moyenne', '신뢰도 보통', 'độ tin cậy trung bình'),
        low: t('confiance faible', '신뢰도 낮음', 'độ tin cậy thấp') }[result.confidence] ?? result.confidence;
      notice(`${t('Décalage trouvé', '오프셋 발견', 'Đã tìm thấy độ lệch')} : ${result.offset > 0 ? '+' : ''}${result.offset.toFixed(2)} s · ${confidence}`);
      return;
    }
    if (timing) notice(t('Analyse trop longue : réessayez.', '분석이 너무 오래 걸립니다. 다시 시도하세요.', 'Phân tích quá lâu, hãy thử lại.'));
  } finally { $('timing-auto').disabled = false; }
}));
// La réinitialisation réécrit le .vtt servi côté serveur : le brouillon est
// remplacé par les répliques relues, pas par une copie de l'affichage.
$('timing-reset').addEventListener('click', handle(async () => {
  if (!timing) return;
  if (!confirm(t('Rétablir le timing du fichier d’origine ? Les retouches seront perdues.',
    '원본 파일의 싱크로 되돌릴까요? 수정 내용이 사라집니다.', 'Khôi phục timing của tệp gốc? Mọi chỉnh sửa sẽ mất.'))) return;
  const payload = await api(`/api/movies/${timing.movie.id}/subtitles/${timing.track.id}/cues/reset`, { method: 'POST', body: {} });
  timing.cues = payload.cues;
  timing.selected = -1; timing.active = -1;
  buildTiming(); renderTiming();
  notice(t('Timing réinitialisé.', '싱크를 되돌렸습니다.', 'Đã khôi phục timing.'));
}));
$('timing-cancel').addEventListener('click', () => timingDialog.close());
$('timing-close').addEventListener('click', () => timingDialog.close());
$('timing-save').addEventListener('click', handle(async () => {
  if (!timing) return;
  await api(`/api/movies/${timing.movie.id}/subtitles/${timing.track.id}/cues`, { method: 'PUT', body: { cues: timing.cues } });
  timingDialog.close();
  notice(t('Timing enregistré.', '싱크를 저장했습니다.', 'Đã lưu timing.'));
}));
timingDialog.addEventListener('close', () => {
  timing?.hls?.destroy(); timing = null; timingDrag = null;
  timingVideo.pause(); timingVideo.removeAttribute('src'); timingVideo.load();
  $('timing-overlay').textContent = '';
});

window.addEventListener('beforeunload', event => { if (uploadBusy) { event.preventDefault(); event.returnValue = ''; } });
setInterval(() => { if (!player && !uploadBusy && movies.some(movie => ['processing', 'probing'].includes(movie.status))) refresh().catch(error => notice(error)); }, 3000);
translate();
await handle(async () => {
  await refresh(); const params = new URLSearchParams(location.hash.slice(1));
  if (['fr', 'ko', 'vi'].includes(params.get('lang'))) { localStorage.setItem('language', params.get('lang')); translate(); }
  if (params.has('hdr')) sessionStorage.setItem('hdr', params.get('hdr'));
  if (params.has('invite')) $('join-form').elements.code.value = params.get('invite');
  else if (params.has('room')) await enterRoom(params.get('room'));
})();
function askDialog(id, input) {
  return new Promise(resolve => {
    const dialog = $(id); dialog.returnValue = '';
    const cancel = () => { dialog.returnValue = 'cancel'; };
    dialog.addEventListener('cancel', cancel);
    dialog.addEventListener('close', () => { dialog.removeEventListener('cancel', cancel); resolve(dialog.returnValue === 'cancel' ? '' : $(input).value.trim()); }, { once: true });
    dialog.showModal();
  });
}
function randomCode() { $('create-code').value = Array.from(crypto.getRandomValues(new Uint8Array(4)), n => n.toString(16).padStart(2, '0')).join(''); }
$('random-code').addEventListener('click', randomCode);
async function upload(file, extra = {}) {
  if (uploadBusy) return;
  if (!file) throw new Error(t('Choisir un fichier.', '파일을 선택하세요.'));
  // crypto.subtle exists only in a secure context (HTTPS or localhost).
  if (!crypto.subtle) throw new Error(t('L’envoi exige une page servie en HTTPS ou en localhost.', '업로드하려면 HTTPS 또는 localhost 페이지가 필요합니다.'));
  uploadBusy = true; $('upload-file').disabled = true;
  try {
    const pending = await api('/api/uploads');
    // Check both ends plus metadata before resuming; never confuse two same-size filenames.
    const sample = new Blob([file.slice(0, 1024 ** 2), file.slice(Math.max(0, file.size - 1024 ** 2)), `${file.name}:${file.size}:${file.lastModified}`]);
    const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await sample.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
    let info = pending.find(item => item.name === file.name && item.size === file.size && item.fingerprint === fingerprint && item.movieId === extra.movieId && (item.kind || 'movie') === (extra.kind || 'movie'));
    if (!info) info = await api('/api/uploads', { method: 'POST', body: { name: file.name, size: file.size, fingerprint, ...extra } });
    let offset = info.offset, retries = 0;
    const started = performance.now(), startOffset = offset;
    while (offset < file.size) {
      try {
        const response = await fetch(`/api/uploads/${info.id}`, { method: 'PUT', headers: {
          'Content-Type': 'application/octet-stream', 'Upload-Offset': String(offset),
        }, body: file.slice(offset, offset + (info.chunkSize ?? 8 * 1024 ** 2)) });
        const result = await response.json();
        if (response.status === 409 && Number.isFinite(result.offset)) offset = result.offset;
        else if (!response.ok) throw new Error(result.error);
        else offset = result.offset;
        retries = 0; $('upload-progress').value = offset / file.size * 100;
        // Average since this session started: steadier than the last chunk, and a resumed upload does not count what was already there.
        const rate = (offset - startOffset) / ((performance.now() - started) / 1000);
        const left = rate > 0 ? Math.round((file.size - offset) / rate) : 0;
        $('upload-status').textContent = [`${formatSize(offset)} / ${formatSize(file.size)}`,
          rate > 0 ? t(`${formatSize(rate)}/s`, `${formatSize(rate)}/초`, `${formatSize(rate)}/s`) : '',
          left ? t(`encore ${left < 60 ? `${left} s` : runtime(left)}`, `${left < 60 ? `${left}초` : runtime(left)} 남음`, `còn ${left < 60 ? `${left} giây` : runtime(left)}`) : ''].filter(Boolean).join(' · ');
      } catch (error) {
        if (++retries > 5) throw error;
        $('upload-status').textContent = t(`Nouvel essai ${retries}/5…`, `다시 시도 중 ${retries}/5…`, `Thử lại lần ${retries}/5…`);
        await new Promise(resolve => setTimeout(resolve, retries * 1000));
        offset = (await api(`/api/uploads/${info.id}`)).offset;
      }
    }
    $('upload-status').textContent = label('Analyse du fichier…');
    await api(`/api/uploads/${info.id}/complete`, { method: 'POST', body: {} });
    $('upload-status').textContent = t('Fichier ajouté. Préparez le film pour l’utiliser.', '파일이 추가되었습니다. 영화를 준비하면 사용할 수 있습니다.'); $('upload-progress').value = 0;
    await refresh();
  } finally { uploadBusy = false; $('upload-file').disabled = false; $('upload-file').value = ''; }
}
