import { SyncPlayer } from './sync-player.js';
import { label } from './labels.js';

const $ = id => document.getElementById(id);
const t = (fr, ko) => sessionStorage.getItem('language') === 'ko' ? ko : fr;
const adminPage = location.pathname === '/admin';
let session = {}, movies = [], player = null, activeRoom = null, uploadBusy = false, roomMessage = null;
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
  updatePlayback(player);
}

function updatePlayback(controller) {
  if (!controller) return;
  const phase = controller.state?.phase;
  const waiting = roomMessage?.members.filter(member => member.waiting).map(member => member.name) ?? [];
  const needsSound = controller.activationBlocked;
  const loading = !controller.activated || controller.recovering;
  const message = controller.failure ? label(controller.failure) : navigator.onLine === false ? t('Connexion perdue. Séance en pause.', '연결이 끊겨 일시정지되었습니다.') : !phase ? t('Reconnexion…', '다시 연결 중…') :
    needsSound ? t('Un clic pour activer le son', '클릭하여 소리를 켜세요') :
    loading ? t('Chargement du film…', '영화를 불러오는 중…') :
    phase === 'buffering' ? waiting.length ? t(`En attente de ${waiting.join(', ')}…`, `${waiting.join(', ')} 님을 기다리는 중…`) : t('La séance va commencer…', '곧 재생됩니다…') : '';
  const overlay = !!message;
  $('buffering-overlay').hidden = !overlay;
  $('screen').dataset.overlay = String(overlay);
  const busy = overlay && !controller.failure && !needsSound;
  $('video').setAttribute('aria-busy', String(busy));
  $('playback-spinner').hidden = !busy;
  if ($('buffering-label').textContent !== message) $('buffering-label').textContent = message;
  $('allow-sound').hidden = !needsSound || !!controller.failure;
  $('playback-status').textContent = overlay ? '' : phase === 'paused' ? t('En pause', '일시정지') : '';
  const playing = controller.activated && ['playing', 'buffering'].includes(phase);
  $('screen').dataset.playing = String(playing);
  for (const control of playbackUI.elements.buttons.play ?? []) {
    const text = playing ? t('Pause', '일시정지') : t('Lecture', '재생');
    control.setAttribute('aria-label', text);
    for (const tooltip of control.querySelectorAll('.plyr__tooltip')) tooltip.textContent = text;
  }
}
function notice(message = '') { $('notice').textContent = label(message); }
async function api(url, { body, method = 'GET', ...options } = {}) {
  const response = await fetch(url, { method, ...options, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...options.headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(label(result.error || t('Une erreur est survenue.', '오류가 발생했습니다.')));
  return result;
}
function handle(action) { return async event => { event?.preventDefault(); try { await action(event); } catch (error) { notice(error.message); } }; }
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function button(text, action, className) { const node = el('button', text, className); node.type = 'button'; node.addEventListener('click', handle(action)); return node; }
function field(text, input) { const node = el('label', text); input.setAttribute('aria-label', text); node.append(input); return node; }
function selectOptions(select, choices) {
  const previous = select.value;
  select.replaceChildren(...choices.map(([value, text]) => { const node = el('option', text); node.value = value; return node; }));
  if (choices.some(([value]) => String(value) === previous)) select.value = previous;
}
function trackName(track) {
  const names = { fr: t('Français', '프랑스어'), fra: t('Français', '프랑스어'), fre: t('Français', '프랑스어'), en: t('Anglais', '영어'), eng: t('Anglais', '영어'), ko: t('Coréen', '한국어'), kor: t('Coréen', '한국어') };
  return names[track.label] || track.label;
}
async function refresh() {
  session = await api('/api/session');
  $('logout').hidden = !session.authenticated; $('entry').hidden = !!player || (adminPage && session.admin);
  $('join-form').hidden = adminPage; $('login-form').hidden = !adminPage;
  $('library').hidden = !adminPage || !session.admin || !!player;
  $('choose-film').hidden = !session.admin;
  if (!session.admin) return;
  movies = await api('/api/movies');
  selectOptions($('room-movie'), movies.filter(movie => movie.status === 'ready').map(movie => [movie.id, movie.title]));
  if (player || !adminPage) return;
  $('movies').replaceChildren(...movies.map(movieCard));
  const rooms = await api('/api/rooms');
  $('rooms').replaceChildren(...rooms.map(room => {
    const card = el('div', undefined, 'card');
    card.append(el('p', `${movies.find(movie => movie.id === room.movieId)?.title ?? ''} · ${room.participants} ${t('personne(s)', '명')}`), el('code', room.code),
      button(t('Ouvrir', '열기'), () => enterRoom(room.id)), button(t('Copier le lien', '링크 복사'), async () => { await navigator.clipboard.writeText(room.link); notice(t('Lien copié.', '링크를 복사했습니다.')); }),
      button(t('Fermer la séance', '시청방 닫기'), async () => { await api(`/api/rooms/${room.id}`, { method: 'DELETE' }); await refresh(); }, 'danger'));
    return card;
  }));
  const uploads = await api('/api/uploads');
  $('pending-uploads').replaceChildren(...uploads.map(upload => {
    const card = el('div', undefined, 'card'); card.append(el('p', `${upload.name} · ${Math.round(upload.offset / upload.size * 100)} %`), el('p', t('Choisissez à nouveau le même fichier pour reprendre.', '같은 파일을 선택하면 이어서 업로드합니다.')),
      button(t('Supprimer cet envoi', '업로드 삭제'), async () => { await api(`/api/uploads/${upload.id}`, { method: 'DELETE' }); await refresh(); }, 'danger')); return card;
  }));
}
function movieCard(movie) {
  const card = el('article', undefined, 'card'); card.append(el('h2', movie.title));
  const states = { ready: t('Prêt à regarder', '시청 준비 완료'), uploaded: t('À préparer', '준비 필요'), processing: t('Préparation en cours…', '준비 중…'), probing: t('Vérification…', '확인 중…'), failed: t('Préparation échouée. Réessayez.', '준비에 실패했습니다. 다시 시도하세요.'), incompatible: t('Ce fichier ne peut pas être lu.', '이 파일은 재생할 수 없습니다.') };
  card.append(el('p', `${states[movie.status] || ''}${movie.progress ? ` ${movie.progress.percent} %` : ''}`));
  if (movie.error) card.append(el('p', movie.error, 'media-error'));
  if (movie.status === 'ready') card.append(button(t('Créer une séance', '시청방 만들기'), async () => {
    $('create-code').value = '';
    const code = await askDialog('create-dialog', 'create-code'); if (!code) return;
    const room = await api('/api/rooms', { method: 'POST', body: { movieId: movie.id, code } });
    notice(`${t('Invitation', '초대')}: ${room.link}`); await enterRoom(room.id);
  }));
  if (['processing', 'probing'].includes(movie.status)) return card;
  const details = el('details'); details.append(el('summary', t('Modifier le film', '영화 수정')));
  const title = el('input'); title.value = movie.title; title.maxLength = 150;
  details.append(field(t('Titre', '제목'), title), button(t('Enregistrer le titre', '제목 저장'), async () => { await api(`/api/movies/${movie.id}`, { method: 'PATCH', body: { title: title.value } }); await refresh(); }));
  const audio = [], subtitles = [];
  for (const [tracks, selected, name] of [[movie.probe?.audio ?? [], audio, t('Langues du film', '음성 언어')], [movie.probe?.subtitles ?? [], subtitles, t('Sous-titres', '자막')]]) {
    details.append(el('h3', name));
    for (const track of tracks) {
      const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = track.compatible; checkbox.disabled = !track.compatible;
      selected.push({ checkbox, index: track.index });
      const row = el('label'); row.append(checkbox, document.createTextNode(` ${trackName(track)}${track.compatible ? '' : t(' (indisponible)', ' (사용 불가)')}`)); details.append(row);
    }
  }
  details.append(el('h3', t('Ajouter une langue ou des sous-titres', '음성 또는 자막 추가')));
  const kind = el('select'); selectOptions(kind, [['subtitle', t('Sous-titres', '자막')], ['audio', t('Langue audio', '음성')]]);
  const file = el('input'); file.type = 'file'; file.accept = '.srt,.vtt';
  kind.addEventListener('change', () => { file.accept = kind.value === 'subtitle' ? '.srt,.vtt' : 'audio/*,.mka,.ac3,.eac3,.dts'; });
  const name = el('input'); name.maxLength = 100; name.placeholder = t('Ex. Français', '예: 한국어');
  const language = el('select'); selectOptions(language, [['fr', t('Français', '프랑스어')], ['ko', t('Coréen', '한국어')], ['en', t('Anglais', '영어')], ['und', t('Autre', '기타')]]);
  details.append(field(t('Type de fichier', '파일 종류'), kind), field(t('Fichier', '파일'), file), field(t('Langue', '언어'), language), field(t('Nom affiché', '표시 이름'), name),
    button(t('Ajouter le fichier', '파일 추가'), () => upload(file.files[0], { kind: kind.value, movieId: movie.id, label: name.value.trim() || language.selectedOptions[0].textContent, language: language.value })));
  for (const track of movie.externalTracks ?? []) details.append(el('p', `${t('Fichier ajouté', '추가된 파일')} : ${track.label}`));
  details.append(el('p', t('Après vos modifications, préparez le film pour pouvoir le regarder.', '변경 후 영화를 준비하면 시청할 수 있습니다.')));
  if (movie.probe?.compatible) details.append(button(t('Préparer le film', '영화 준비'), async () => {
    await api(`/api/movies/${movie.id}/prepare`, { method: 'POST', body: { audio: audio.filter(item => item.checkbox.checked).map(item => item.index), subtitles: subtitles.filter(item => item.checkbox.checked).map(item => item.index) } }); await refresh();
  }));
  else details.append(button(t('Vérifier le fichier', '파일 확인'), async () => { await api(`/api/movies/${movie.id}/probe`, { method: 'POST', body: {} }); await refresh(); }));
  details.append(button(t('Supprimer le film', '영화 삭제'), async () => {
    if (confirm(t(`Supprimer définitivement « ${movie.title} » ?`, `« ${movie.title} » 영화를 영구 삭제할까요?`))) { await api(`/api/movies/${movie.id}`, { method: 'DELETE' }); await refresh(); }
  }, 'danger')); card.append(details); return card;
}

async function enterRoom(id, name) {
  if (!name) {
    $('room-name').value = sessionStorage.getItem('nickname') || '';
    name = await askDialog('name-dialog', 'room-name');
    if (!name) return;
  }
  sessionStorage.setItem('nickname', name); showSettings(false);
  await api(`/api/rooms/${id}`); session = await api('/api/session');
  player?.dispose(); activeRoom = id; roomMessage = null;
  $('entry').hidden = true; $('library').hidden = true; $('watch').hidden = false; $('choose-film').hidden = !session.admin;
  history.replaceState(null, '', `${adminPage ? '/admin' : '/'}#room=${id}`);
  player = new SyncPlayer({ video: $('video'), roomId: id, name,
    onStatus: message => { $('playback-status').textContent = label(message); updatePlayback(player); },
    onActivation: () => updatePlayback(player),
    onTracks: (audio, subtitles) => {
      selectOptions($('audio'), audio.length ? audio.map(track => [track.index, trackName(track)]) : [[-1, t('Sans son', '음성 없음')]]); $('audio').disabled = audio.length < 2;
      selectOptions($('subtitles'), [[-1, t('Sans sous-titres', '자막 없음')], ...subtitles.map(track => [track.index, trackName(track)])]); $('subtitles').disabled = !subtitles.length;
      if (player) { $('audio').value = String(audio.length ? player.audioChoice : -1); $('subtitles').value = String(player.subtitleChoice); }
    },
    onState: (message, controller) => {
      $('movie-title').textContent = message.movie?.title ?? ''; $('room-movie').value = message.movie?.id ?? '';
      roomMessage = message; updatePlayback(controller);
      $('member-count').textContent = `(${message.members.length})`;
      $('participants').replaceChildren(...message.members.map(member => { const item = el('li'); item.dataset.ready = String(!member.waiting); item.append(el('strong', `${member.name}${member.id === controller.memberId ? t(' · vous', ' · 나') : ''}`), el('span', member.waiting ? t('Chargement…', '준비 중…') : t('Prêt', '준비 완료'))); return item; }));
    },
  });
  if (session.admin) { movies = await api('/api/movies'); selectOptions($('room-movie'), movies.filter(movie => movie.status === 'ready').map(movie => [movie.id, movie.title])); }
}
$('language').addEventListener('change', handle(async () => { sessionStorage.setItem('language', $('language').value); translate(); notice(); if (!player && !uploadBusy) await refresh(); }));
$('login-form').addEventListener('submit', handle(async event => { await api('/api/login', { method: 'POST', body: { password: new FormData(event.target).get('password') } }); event.target.reset(); notice(); await refresh(); }));
$('join-form').addEventListener('submit', handle(async event => {
  const data = new FormData(event.target);
  const room = await api('/api/join', { method: 'POST', body: { code: data.get('code') } }); notice(); await enterRoom(room.id);
}));
$('logout').addEventListener('click', handle(async () => { player?.dispose(); player = null; $('watch').hidden = true; history.replaceState(null, '', adminPage ? '/admin' : '/'); await api('/api/logout', { method: 'POST', body: {} }); await refresh(); }));
$('refresh').addEventListener('click', handle(refresh));
$('allow-sound').addEventListener('click', handle(() => player?.activate()));
$('upload-form').addEventListener('submit', handle(() => upload($('upload-file').files[0])));
$('audio').addEventListener('change', () => player?.changeTrack('audio', Number($('audio').value)));
$('subtitles').addEventListener('change', () => player?.changeTrack('subtitles', Number($('subtitles').value)));
$('leave').addEventListener('click', handle(async () => { player?.dispose(); player = null; activeRoom = null; $('watch').hidden = true; history.replaceState(null, '', adminPage ? '/admin' : '/'); await refresh(); }));
$('choose-film').addEventListener('submit', handle(() => api(`/api/rooms/${activeRoom}/movie`, { method: 'POST', body: { movieId: $('room-movie').value } })));
window.addEventListener('beforeunload', event => { if (uploadBusy) { event.preventDefault(); event.returnValue = ''; } });
setInterval(() => { if (!player && !uploadBusy && movies.some(movie => ['processing', 'probing'].includes(movie.status))) refresh().catch(error => notice(error.message)); }, 3000);
translate();
await handle(async () => {
  await refresh(); const params = new URLSearchParams(location.hash.slice(1));
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
        }, body: file.slice(offset, offset + 8 * 1024 ** 2) });
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
    $('upload-status').textContent = t('Fichier ajouté. Préparez le film pour l’utiliser.', '파일이 추가되었습니다. 영화를 준비하면 사용할 수 있습니다.');
    await refresh();
  } finally { uploadBusy = false; $('upload-button').disabled = false; }
}
