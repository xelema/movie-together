import { SyncPlayer } from './sync-player.js';
import { attachTelemetry } from './telemetry.js';
import { label } from './labels.js';
import { trackName, defaultTrackNames, sourceTitle, trackLayout } from './track-names.js';
import { SUBTITLE_EXT, SUBTITLE_ACCEPT, IMAGE_SUBTITLE_CODECS } from './subtitle-formats.js';

const $ = id => document.getElementById(id);
const t = (fr, ko) => sessionStorage.getItem('language') === 'ko' ? ko : fr;
const adminPage = location.pathname === '/admin';
let session = {}, movies = [], player = null, activeRoom = null, uploadBusy = false, roomMessage = null, diskInfo = null, telemetry = null;
function disposePlayer() { telemetry?.dispose(); telemetry = null; player?.dispose(); player = null; window.player = null; refreshBandwidth(); }
const movieCards = new Map(), openPanels = new Set(), closedPanels = new Set();
const playbackUI = new window.Plyr($('video'), {
  controls: ['play-large', 'play', 'progress', 'current-time', 'duration', 'mute', 'volume', 'fullscreen'],
  settings: [], storage: { enabled: false }, clickToPlay: false, keyboard: { focused: false, global: false },
  hideControls: true, tooltips: { controls: true, seek: true }, invertTime: false, toggleInvert: false,
  iconUrl: '/vendor/plyr.svg', blankVideo: '',
  fullscreen: { enabled: true, fallback: true, iosNative: false, container: '#screen' },
  listeners: {
    play: () => { player?.togglePlayback().catch(error => notice(error.message)); return false; },
    seek: event => { if (player?.state) player.command('seek', Number(event.target.value) / 100 * player.state.duration); return false; },
  },
});
const settingsButton = document.createElement('button');
settingsButton.id = 'open-settings'; settingsButton.type = 'button'; settingsButton.className = 'plyr__control plyr__controls__item';
settingsButton.textContent = '⚙'; settingsButton.setAttribute('aria-controls', 'player-settings'); settingsButton.setAttribute('aria-expanded', 'false');
playbackUI.elements.controls.insertBefore(settingsButton, playbackUI.elements.buttons.fullscreen);
function showSettings(open, focus = false) {
  $('player-settings').hidden = !open; settingsButton.setAttribute('aria-expanded', String(open));
  $('screen').classList.toggle('settings-open', open);
  if (open) playbackUI.toggleControls(true);
  player?.positionSubtitles();
  if (focus) (open ? $('close-settings') : settingsButton).focus();
}
settingsButton.addEventListener('click', () => showSettings($('player-settings').hidden, true));
$('close-settings').addEventListener('click', event => showSettings(false, event.detail === 0));
document.addEventListener('pointerdown', event => { if (!$('player-settings').contains(event.target) && !settingsButton.contains(event.target)) showSettings(false); });
$('screen').addEventListener('keydown', event => { if (event.key === 'Escape' && !$('player-settings').hidden) { event.preventDefault(); event.stopPropagation(); showSettings(false, true); } });
playbackUI.on('enterfullscreen exitfullscreen', () => showSettings(false));
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
// Route transport shortcuts through the shared clock, not Plyr's local playback.
$('screen').addEventListener('keydown', event => {
  if (!player || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
      event.target.closest('input, select, textarea, button, [contenteditable=true]')) return;
  const key = event.key.toLowerCase();
  if (![' ', 'k', 'arrowleft', 'arrowright', 'm', 'f'].includes(key)) return;
  event.preventDefault();
  if (event.repeat) return;
  if (key === ' ' || key === 'k') player.togglePlayback().catch(error => notice(error.message));
  else if (key.startsWith('arrow')) player.command('seek', Math.max(0, Math.min(player.state?.duration || 0, player.position() + (key === 'arrowleft' ? -10 : 10))));
  else if (key === 'm') playbackUI.muted = !playbackUI.muted;
  else playbackUI.fullscreen.toggle();
  playbackUI.toggleControls(true);
});
function translate() {
  const lang = sessionStorage.getItem('language') === 'ko' ? 'ko' : 'fr';
  document.documentElement.lang = lang; $('language').value = lang;
  $('language-flag').src = `/flags/${lang}.svg`;
  for (const node of document.querySelectorAll('[data-fr]')) node.textContent = node.dataset[lang];
  bandwidthBadge.title = bandwidthBadge.ariaLabel = t('Débit en direct', '실시간 속도');
  const words = { play: t('Lecture', '재생'), pause: t('Pause', '일시정지'), seek: t('Avancer ou reculer', '재생 위치'),
    currentTime: t('Position', '재생 위치'), duration: t('Durée', '길이'), volume: t('Volume', '음량'),
    mute: t('Couper le son', '음소거'), unmute: t('Activer le son', '소리 켜기'),
    enterFullscreen: t('Plein écran', '전체 화면'), exitFullscreen: t('Quitter le plein écran', '전체 화면 종료'),
    seekLabel: t('{currentTime} sur {duration}', '{duration} 중 {currentTime}'),
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
  $('room-name').setAttribute('aria-label', t('Votre pseudo', '닉네임'));
  $('screen').setAttribute('aria-label', t('Lecteur vidéo', '동영상 플레이어'));
  if (player) player.tracks();
  updatePlayback(player); updateFilmMeta();
}

function updatePlayback(controller) {
  if (!controller) return;
  const phase = controller.state?.phase;
  const waiting = roomMessage?.members.filter(member => member.waiting)
    .map(member => member.reason ? `${member.name} (${why(member)})` : member.name) ?? [];
  const needsSound = controller.activationBlocked;
  const loading = !controller.activated || controller.recovering;
  const message = controller.failure ? label(controller.failure) : navigator.onLine === false ? t('Connexion perdue. Séance en pause.', '연결이 끊겨 일시정지되었습니다.') : !phase ? t('Reconnexion…', '다시 연결 중…') :
    needsSound ? t('Un clic pour activer le son', '클릭하여 소리를 켜세요') :
    loading ? t('Chargement du film…', '영화를 불러오는 중…') :
    phase === 'buffering' ? waiting.length ? t(`En attente de ${waiting.join(', ')}…`, `${waiting.join(', ')} 님을 기다리는 중…`) : t('La séance va commencer…', '곧 재생됩니다…') : '';
  const overlay = !!message;
  const playing = controller.activated && ['playing', 'buffering'].includes(phase);
  const key = JSON.stringify([message, controller.failure, needsSound, phase, playing, t('fr', 'ko')]);
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
function notice(message = '') { $('notice').textContent = label(message); }
// Sections are shown by clearing [hidden]; replay the entrance animation whenever that happens.
new MutationObserver(records => {
  for (const { target } of records) {
    if (target.hidden || target.tagName !== 'SECTION') continue;
    target.classList.remove('enter'); void target.offsetWidth; target.classList.add('enter');
  }
}).observe(document.querySelector('main'), { attributes: true, subtree: true, attributeFilter: ['hidden'] });
async function api(url, { body, method = 'GET', ...options } = {}) {
  const response = await fetch(url, { method, ...options, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...options.headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(label(result.error || t('Une erreur est survenue.', '오류가 발생했습니다.')));
  return result;
}
function handle(action) { return async event => { event?.preventDefault(); try { await action(event); } catch (error) { notice(error.message); } }; }
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
  return hours ? t(`${hours} h ${String(minutes).padStart(2, '0')}`, `${hours}시간 ${minutes}분`) : t(`${minutes} min`, `${minutes}분`);
}
function formatSize(bytes) {
  const gb = bytes / 1024 ** 3;
  const text = gb >= 1 ? gb.toFixed(gb < 10 ? 1 : 0) : String(Math.max(1, Math.round(bytes / 1024 ** 2)));
  return gb >= 1 ? t(`${text} Go`, `${text}GB`) : t(`${text} Mo`, `${text}MB`);
}
function renderDisk() {
  if (!diskInfo) return;
  // Same margin as POST /api/uploads: the server needs room for the original plus its preparation.
  const needed = ($('upload-file').files[0]?.size ?? 0) * 2.2;
  const space = t(`${formatSize(diskInfo.free)} libres sur ${formatSize(diskInfo.total)}`,
    `${formatSize(diskInfo.total)} 중 ${formatSize(diskInfo.free)} 사용 가능`);
  const insufficient = needed > diskInfo.free;
  $('disk-space').textContent = insufficient
    ? t(`${space}. Espace insuffisant : il faut environ ${formatSize(needed)} pour ce film et sa préparation.`,
        `${space}. 공간 부족: 이 영화와 준비에는 약 ${formatSize(needed)}가 필요합니다.`)
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
  const language = sessionStorage.getItem('language') === 'ko' ? 'ko' : 'fr';
  const signature = movie => JSON.stringify([language, movie.status, movie.progress, movie.title, movie.error,
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
  $('pending-heading').hidden = !pending.length; $('ready-heading').hidden = !ready.length;
  const rooms = await api('/api/rooms');
  $('rooms-section').hidden = !rooms.length;
  renderSettings(await api('/api/settings'));
  $('rooms').replaceChildren(...rooms.map(room => {
    const card = el('div', undefined, 'card');
    card.append(el('p', `${movies.find(movie => movie.id === room.movieId)?.title ?? ''} · ${room.participants} ${t('personne(s)', '명')} · ${t('jusqu’à', '까지')} ${new Date(room.expires).toTimeString().slice(0, 5)}`), el('code', room.code),
      button(t('Ouvrir', '열기'), () => enterRoom(room.id, undefined, { code: room.code, title: movies.find(movie => movie.id === room.movieId)?.title })), button(t('Copier le lien', '링크 복사'), async () => {
        // Clipboard needs a secure context; on plain HTTP show the link instead.
        if (!navigator.clipboard) { notice(`${t('Lien', '링크')} : ${room.link}`); return; }
        await navigator.clipboard.writeText(room.link); notice(t('Lien copié.', '링크를 복사했습니다.'));
      }),
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
function movieCard(movie) {
  const card = el('article', undefined, 'card'); card.append(el('h2', movie.title));
  const states = { ready: [t('Prêt à regarder', '시청 준비 완료'), 'ready'], uploaded: [t('À préparer', '준비 필요'), 'pending'],
    processing: [t('Préparation en cours…', '준비 중…'), 'pending'], probing: [t('Vérification…', '확인 중…'), 'pending'],
    failed: [t('Préparation échouée. Réessayez.', '준비에 실패했습니다. 다시 시도하세요.'), 'danger'],
    incompatible: [t('Ce fichier ne peut pas être lu.', '이 파일은 재생할 수 없습니다.'), 'danger'] };
  const [statusText, tone] = states[movie.status] ?? ['', 'pending'];
  const status = el('p', undefined, 'status'); status.dataset.tone = tone;
  status.append(el('span', undefined, 'dot'), document.createTextNode(statusText));
  card.append(status);
  if (movie.progress) {
    const bar = el('progress', undefined, 'card-progress'); bar.max = 100; bar.value = movie.progress.percent;
    card.append(bar, el('p', `${movie.progress.percent} %`, 'hint'));
  }
  if (movie.error) card.append(el('p', label(movie.error), 'media-error'));
  if (['processing', 'probing'].includes(movie.status)) return card;
  if (movie.status === 'ready') {
    const meta = [movie.duration ? runtime(movie.duration) : '',
      movie.audio?.length ? t(`${movie.audio.length} audio`, `음성 ${movie.audio.length}개`) : '',
      movie.subtitles?.length ? t(`${movie.subtitles.length} sous-titres`, `자막 ${movie.subtitles.length}개`) : '']
      .filter(Boolean).join(' · ');
    if (meta) card.append(el('p', meta, 'hint'));
    const create = async () => {
      randomCode();
      const code = await askDialog('create-dialog', 'create-code'); if (!code) return;
      const room = await api('/api/rooms', { method: 'POST', body: { movieId: movie.id, code } });
      notice(`${t('Invitation', '초대')}: ${room.link}`);
      await enterRoom(room.id, undefined, { code: room.code, title: movie.title });
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
    row.append(button(t('Retirer', '제거'), async () => {
      await api(`/api/movies/${movie.id}/${pending ? 'external' : 'subtitles'}/${track.id}`, { method: 'DELETE' });
      await refresh();
    }, 'ghost'));
    details.append(row);
  }
  const subFile = el('input'); subFile.type = 'file'; subFile.accept = SUBTITLE_ACCEPT;
  const subLang = el('select'); subLang.setAttribute('aria-label', t('Langue', '언어'));
  selectOptions(subLang, [['fr', 'French'], ['ko', 'Korean'], ['en', 'English'], ['und', 'Other']]);
  const subName = el('input'); subName.maxLength = 100; subName.placeholder = 'Ex. Korean'; subName.setAttribute('aria-label', t('Nom affiché', '표시 이름'));
  const addRow = el('div', undefined, 'add-row'); addRow.append(subLang, subName,
    button(t('Ajouter', '추가'), async () => {
      const file = subFile.files[0];
      const maxSubMb = settingsValues.maxSubtitleMb ?? 2;
      if (!file || !SUBTITLE_EXT.test(file.name) || file.size > maxSubMb * 1024 ** 2) throw new Error(t(`Choisir un fichier de sous-titres de moins de ${maxSubMb} Mo (SRT, VTT, SMI, ASS, SUB…).`, `자막 파일을 선택하세요 (SRT, VTT, SMI, ASS, SUB 등, 최대 ${maxSubMb}MB).`));
      const trackLabel = subName.value.trim() || subLang.selectedOptions[0].textContent;
      if (movie.status === 'ready') {
        const response = await fetch(`/api/movies/${movie.id}/subtitles?label=${encodeURIComponent(trackLabel)}&language=${subLang.value}&name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: file });
        const result = await response.json();
        if (!response.ok) throw new Error(label(result.error || t('Une erreur est survenue.', '오류가 발생했습니다.')));
        notice(t('Sous-titres ajoutés.', '자막이 추가되었습니다.'));
      } else await upload(file, { kind: 'subtitle', movieId: movie.id, label: trackLabel, language: subLang.value });
      await refresh();
    }));
  details.append(field(t(`Fichier de sous-titres (${settingsValues.maxSubtitleMb ?? 2} Mo maximum)`, `자막 파일 (최대 ${settingsValues.maxSubtitleMb ?? 2}MB)`), subFile), addRow);
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
    if (confirm(t(`Supprimer définitivement « ${movie.title} » ?`, `« ${movie.title} » 영화를 영구 삭제할까요?`))) { await api(`/api/movies/${movie.id}`, { method: 'DELETE' }); await refresh(); }
  }, 'danger'));
  details.append(actions);
  return details;
}

async function enterRoom(id, name, context = {}) {
  if (!name) {
    $('room-name').value = sessionStorage.getItem('nickname') || '';
    $('name-context').hidden = !context.code;
    $('name-code').textContent = context.code ?? ''; $('name-movie').textContent = context.title ?? '';
    name = await askDialog('name-dialog', 'room-name');
    if (!name) return;
  }
  $('room-code').textContent = context.code ?? '';
  sessionStorage.setItem('nickname', name); showSettings(false);
  await api(`/api/rooms/${id}`); session = await api('/api/session');
  disposePlayer(); activeRoom = id; roomMessage = null;
  $('entry').hidden = true; $('library').hidden = true; $('watch').hidden = false; $('choose-film').hidden = !session.admin;
  history.replaceState(null, '', `${adminPage ? '/admin' : '/'}#room=${id}`);
  player = window.player = new SyncPlayer({ video: $('video'), roomId: id, name,
    forceShader: sessionStorage.getItem('hdr') === 'shader',
    onStatus: message => { telemetry?.event('status', { msg: message }); $('playback-status').textContent = label(message); updatePlayback(player); },
    onActivation: () => updatePlayback(player),
    onTracks: (audio, subtitles) => {
      selectOptions($('audio'), audio.length ? audio.map(track => [track.index, trackName(track)]) : [[-1, t('Sans son', '음성 없음')]]); $('audio').disabled = audio.length < 2;
      selectOptions($('subtitles'), [[-1, t('Sans sous-titres', '자막 없음')], ...subtitles.map(track => [track.index, trackName(track)])]); $('subtitles').disabled = !subtitles.length;
      if (player) { $('audio').value = String(audio.length ? player.audioChoice : -1); $('subtitles').value = String(player.subtitleChoice); }
      updateFilmMeta();
    },
    onState: (message, controller) => {
      if (message.probe && !telemetry) telemetry = attachTelemetry(controller, $('video'), id);
      roomMessage = message; updatePlayback(controller);
      const key = JSON.stringify([message.movie?.id, message.movie?.title, message.code, controller.memberId,
        t('fr', 'ko'), message.members.map(({ id, name, waiting, reason, blockers, failure, buffered }) => [id, name, waiting, reason, blockers, failure, Math.round(buffered ?? 0)])]);
      if (controller.roomUIKey === key) return;
      controller.roomUIKey = key;
      $('movie-title').textContent = message.movie?.title ?? ''; $('room-movie').value = message.movie?.id ?? '';
      if (message.code) $('room-code').textContent = message.code;
      updateFilmMeta();
      const ready = message.members.filter(member => !member.waiting).length, total = message.members.length;
      $('member-count').textContent = total ? t(`${ready} personne${ready > 1 ? 's' : ''} prête${ready > 1 ? 's' : ''} sur ${total}`, `${total}명 중 ${ready}명 준비 완료`) : '';
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
  refreshBandwidth();
  if (session.admin) { movies = await api('/api/movies'); selectOptions($('room-movie'), movies.filter(movie => movie.status === 'ready').map(movie => [movie.id, movie.title])); }
}
$('language').addEventListener('change', handle(async () => { sessionStorage.setItem('language', $('language').value); translate(); notice(); if (!player && !uploadBusy) await refresh(); }));
$('login-form').addEventListener('submit', handle(async event => { await api('/api/login', { method: 'POST', body: { password: new FormData(event.target).get('password') } }); event.target.reset(); notice(); await refresh(); }));
$('join-form').addEventListener('submit', handle(async event => {
  const data = new FormData(event.target);
  const room = await api('/api/join', { method: 'POST', body: { code: data.get('code') } }); notice();
  await enterRoom(room.id, undefined, { code: String(data.get('code')).trim() });
}));
$('logout').addEventListener('click', handle(async () => { disposePlayer(); $('watch').hidden = true; history.replaceState(null, '', adminPage ? '/admin' : '/'); await api('/api/logout', { method: 'POST', body: {} }); await refresh(); }));
$('refresh').addEventListener('click', handle(refresh));
$('allow-sound').addEventListener('click', handle(() => player?.activate()));
$('upload-form').addEventListener('submit', handle(() => upload($('upload-file').files[0])));
$('upload-file').addEventListener('change', renderDisk);
$('audio').addEventListener('change', () => player?.changeTrack('audio', Number($('audio').value)));
$('subtitles').addEventListener('change', () => player?.changeTrack('subtitles', Number($('subtitles').value)));
$('leave').addEventListener('click', handle(async () => { disposePlayer(); activeRoom = null; $('watch').hidden = true; history.replaceState(null, '', adminPage ? '/admin' : '/'); await refresh(); }));
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
};
const SETTING_CATEGORIES = { sync: ['Synchronisation', '동기화'], rooms: ['Séances', '시청방'],
  uploads: ['Envois', '업로드'], media: ['Préparation', '준비'], security: ['Sécurité', '보안'] };
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
    hint.textContent = field.overridden ? t(`défaut : ${field.default}`, `기본값: ${field.default}`) : '';
  }
  const fileLabel = $('upload-file-label');
  fileLabel.dataset.fr = `Fichier du film (${settingsValues.maxMovieGb} Go maximum)`;
  fileLabel.dataset.ko = `영화 파일 (최대 ${settingsValues.maxMovieGb}GB)`;
  fileLabel.textContent = t(fileLabel.dataset.fr, fileLabel.dataset.ko);
}
$('settings-form').addEventListener('submit', handle(async () => {
  const body = Object.fromEntries([...settingInputs].map(([key, { input }]) => [key, Number(input.value)]));
  renderSettings(await api('/api/settings', { method: 'PATCH', body }));
  notice(t('Réglages enregistrés.', '설정을 저장했습니다.'));
}));
window.addEventListener('beforeunload', event => { if (uploadBusy) { event.preventDefault(); event.returnValue = ''; } });
setInterval(() => { if (!player && !uploadBusy && movies.some(movie => ['processing', 'probing'].includes(movie.status))) refresh().catch(error => notice(error.message)); }, 3000);
translate();
await handle(async () => {
  await refresh(); const params = new URLSearchParams(location.hash.slice(1));
  if (['fr', 'ko'].includes(params.get('lang'))) { sessionStorage.setItem('language', params.get('lang')); translate(); }
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
  uploadBusy = true; $('upload-button').disabled = true;
  try {
    const pending = await api('/api/uploads');
    // Check both ends plus metadata before resuming; never confuse two same-size filenames.
    const sample = new Blob([file.slice(0, 1024 ** 2), file.slice(Math.max(0, file.size - 1024 ** 2)), `${file.name}:${file.size}:${file.lastModified}`]);
    const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await sample.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
    let info = pending.find(item => item.name === file.name && item.size === file.size && item.fingerprint === fingerprint && item.movieId === extra.movieId && (item.kind || 'movie') === (extra.kind || 'movie'));
    if (!info) info = await api('/api/uploads', { method: 'POST', body: { name: file.name, size: file.size, fingerprint, ...extra } });
    let offset = info.offset, retries = 0;
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
        $('upload-status').textContent = `${(offset / 1024 ** 3).toFixed(2)} / ${(file.size / 1024 ** 3).toFixed(2)} Go`;
      } catch (error) {
        if (++retries > 5) throw error;
        $('upload-status').textContent = t(`Nouvel essai ${retries}/5…`, `다시 시도 중 ${retries}/5…`);
        await new Promise(resolve => setTimeout(resolve, retries * 1000));
        offset = (await api(`/api/uploads/${info.id}`)).offset;
      }
    }
    $('upload-status').textContent = label('Analyse du fichier…');
    await api(`/api/uploads/${info.id}/complete`, { method: 'POST', body: {} });
    $('upload-status').textContent = t('Fichier ajouté. Préparez le film pour l’utiliser.', '파일이 추가되었습니다. 영화를 준비하면 사용할 수 있습니다.'); $('upload-progress').value = 0;
    await refresh();
  } finally { uploadBusy = false; $('upload-button').disabled = false; }
}
