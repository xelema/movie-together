import { SyncPlayer } from './sync-player.js';
import { label } from './labels.js';

const $ = id => document.getElementById(id);
let session = {}, movies = [], player = null, activeRoom = null, uploadBusy = false;
function notice(message = '') { $('notice').textContent = label(message); }
async function api(url, { body, method = 'GET', ...options } = {}) {
  const response = await fetch(url, { method, ...options,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    body: body !== undefined ? JSON.stringify(body) : options.body });
  const result = await response.json().catch(() => ({ error: `Erreur HTTP ${response.status}` }));
  if (!response.ok) throw new Error(result.error || `Erreur HTTP ${response.status}`);
  return result;
}
function handle(action) { return async event => { event?.preventDefault(); try { await action(event); } catch (error) { notice(error.message); } }; }
function element(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = label(text); if (className) node.className = className; return node; }
function button(text, action, className) { const node = element('button', text, className); node.type = 'button'; node.addEventListener('click', handle(action)); return node; }
function formatTime(seconds = 0) { const s = Math.floor(seconds); return `${Math.floor(s / 3600) ? `${Math.floor(s / 3600)}:` : ''}${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }
function fillSelect(select, choices) {
  const previous = select.value;
  select.replaceChildren(...choices.map(({ value, label }) => { const option = element('option'); option.textContent = label; option.value = value; return option; }));
  if (choices.some(choice => String(choice.value) === previous)) select.value = previous;
}
async function refresh() {
  session = await api('/api/session');
  $('logout').hidden = !session.authenticated;
  $('entry').hidden = session.authenticated || !!player;
  $('library').hidden = !session.authenticated || !!player;
  $('upload-form').hidden = !session.admin;
  $('rooms-section').hidden = !session.admin;
  if (!session.authenticated) return;
  movies = await api('/api/movies');
  $('movies').replaceChildren(...movies.map(movieCard));
  fillSelect($('room-movie'), movies.filter(movie => movie.status === 'ready').map(movie => ({ value: movie.id, label: movie.title })));
  if (session.admin) {
    const rooms = await api('/api/rooms');
    $('rooms').replaceChildren(...rooms.map(room => {
      const card = element('div', undefined, 'card');
      card.append(element('p', `${movies.find(movie => movie.id === room.movieId)?.title ?? 'Séance'} · ${room.participants} participant(s)`), element('code', room.code));
      card.append(button('Ouvrir', () => enterRoom(room.id)), button('Copier le lien', async () => {
        await navigator.clipboard.writeText(room.link); notice('Lien copié. Invitation valable 12 heures.');
      }, 'secondary'), button('Fermer la room', async () => {
        await api(`/api/rooms/${room.id}`, { method: 'DELETE' }); await refresh();
      }, 'danger')); return card;
    }));
    const uploads = await api('/api/uploads');
    $('pending-uploads').replaceChildren(...uploads.map(upload => {
      const card = element('div', undefined, 'card');
      card.append(element('p', `Upload en attente : ${upload.name} — ${Math.round(upload.offset / upload.size * 100)} %. Resélectionnez le même fichier pour reprendre.`));
      card.append(button('Supprimer cet upload', async () => { await api(`/api/uploads/${upload.id}`, { method: 'DELETE' }); await refresh(); }, 'danger'));
      return card;
    }));
  }
}
function movieCard(movie) {
  const card = element('article', undefined, 'card');
  const heading = element('h2'); heading.textContent = movie.title; card.append(heading);
  const statuses = { ready: 'Prêt', uploaded: 'À préparer', processing: 'Préparation en cours…', probing: 'Analyse…', failed: 'Échec', incompatible: 'Format incompatible' };
  card.append(element('p', `${label(statuses[movie.status] ?? movie.status)}${movie.duration ? ` · ${formatTime(movie.duration)}` : ''}`));
  if (movie.error) card.append(element('p', movie.error));
  if (movie.progress) card.append(element('p', `${movie.progress.percent} % · Préparation / 준비 중`));
  if (movie.renditions?.length && movie.status === 'ready') card.append(element('p', movie.renditions.map(version =>
    `${version.id === 'original' ? 'Original / 원본' : 'Compatible SDR / 호환 SDR'} · ${version.width} × ${version.height}${version.hdr ? ' · HDR' : ''}`).join(' — ')));
  if (movie.status === 'incompatible') card.append(element('p', 'Aucune vidéo exploitable. Réanalysez le fichier. / 영상을 분석할 수 없습니다. 다시 분석하세요.'));
  if (movie.maxSegmentSeconds > 8) card.append(element('p', `Segments jusqu’à ${movie.maxSegmentSeconds.toFixed(1)} s : préparation du lecteur potentiellement plus longue.`));
  if (!session.admin) return card;
  if (movie.status === 'ready') card.append(button('Créer une room', async () => {
    const room = await api('/api/rooms', { method: 'POST', body: { movieId: movie.id } });
    notice(`Invitation : ${room.link}\nCode : ${room.code}`); await enterRoom(room.id);
  }));
  if (['processing', 'probing'].includes(movie.status)) return card;
  const details = element('details'); details.append(element('summary', 'Gérer le film et les pistes'));
  const titleLabel = element('label', 'Titre'); const title = element('input'); title.value = movie.title; title.maxLength = 150; titleLabel.append(title);
  details.append(titleLabel, button('Enregistrer le titre', async () => { await api(`/api/movies/${movie.id}`, { method: 'PATCH', body: { title: title.value } }); await refresh(); }));
  if (movie.status === 'incompatible' || (movie.status === 'failed' && !movie.probe)) details.append(button('Réanalyser le fichier', async () => {
    await api(`/api/movies/${movie.id}/probe`, { method: 'POST', body: {} }); await refresh();
  }));
  if (movie.probe) {
    details.append(element('p', `Vidéo / 영상 : ${movie.probe.video?.codec ?? 'absente'} · ${movie.probe.video?.width ?? '?'} × ${movie.probe.video?.height ?? '?'}${movie.probe.video?.hdr ? ' · HDR' : ''}${movie.probe.video?.dolbyVision ? ` · Dolby Vision ${movie.probe.video.dolbyVision.dv_profile}` : ''}`));
    const audio = [], subtitles = [];
    for (const [tracks, selected, heading] of [[movie.probe.audio, audio, 'Pistes audio à conserver'], [movie.probe.subtitles, subtitles, 'Sous-titres à extraire']]) {
      details.append(element('h3', heading));
      for (const track of tracks) {
        const label = element('label'), checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.disabled = !track.compatible;
        checkbox.checked = track.compatible; selected.push({ checkbox, index: track.index });
        label.append(checkbox, document.createTextNode(` ${track.label} (${track.codec}${track.channels ? `, ${track.channels} canaux` : ''})${!track.compatible ? ' — incompatible / 지원 불가' : selected === audio && track.copy === false ? ' → AAC stéréo / 스테레오' : ''}`)); details.append(label);
      }
    }
    const compatibleLabel = element('label'), compatible = element('input'); compatible.type = 'checkbox'; compatible.checked = true;
    compatibleLabel.append(compatible, document.createTextNode(' Copie compatible SDR si nécessaire / 필요 시 SDR 호환 버전 생성'));
    details.append(compatibleLabel, element('p', 'Préparation avant lecture. La conversion vidéo peut être longue. / 재생 전에 준비합니다. 영상 변환에는 시간이 걸릴 수 있습니다.'));
    if (movie.probe.compatible) details.append(button('Préparer les pistes sélectionnées', async () => {
      await api(`/api/movies/${movie.id}/prepare`, { method: 'POST', body: {
        audio: audio.filter(item => item.checkbox.checked).map(item => item.index),
        subtitles: subtitles.filter(item => item.checkbox.checked).map(item => item.index),
        compatible: compatible.checked,
      } }); notice('Préparation lancée. La bibliothèque se mettra à jour automatiquement.'); await refresh();
    }));
  }
  if (movie.status === 'ready') {
    details.append(element('h3', 'Ajouter des sous-titres SRT ou VTT'));
    const fileLabel = element('label', 'Fichier'), file = element('input'); file.type = 'file'; file.accept = '.srt,.vtt'; fileLabel.append(file);
    const langLabel = element('label', 'Langue (fr, en…)'), lang = element('input'); lang.value = 'fr'; lang.maxLength = 10; langLabel.append(lang);
    const nameLabel = element('label', 'Nom affiché'), name = element('input'); name.value = 'Français'; name.maxLength = 100; nameLabel.append(name);
    details.append(fileLabel, langLabel, nameLabel, button('Ajouter les sous-titres', async () => {
      if (!file.files[0]) throw new Error('Choisir un fichier de sous-titres.');
      if (file.files[0].size > 2 * 1024 ** 2) throw new Error('Sous-titres limités à 2 Mo.');
      const response = await fetch(`/api/movies/${movie.id}/subtitles?${new URLSearchParams({ label: name.value, language: lang.value })}`,
        { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: file.files[0] });
      const result = await response.json(); if (!response.ok) throw new Error(result.error); await refresh();
    }));
    for (const track of movie.subtitles) details.append(button(`Retirer / 삭제 « ${track.label} »`, async () => {
      await api(`/api/movies/${movie.id}/subtitles/${track.id}`, { method: 'DELETE' }); await refresh();
    }, 'secondary'));
  }
  details.append(button('Supprimer le film', async () => {
    if (window.confirm(`Supprimer définitivement « ${movie.title} », son original et ses pistes ?`)) {
      await api(`/api/movies/${movie.id}`, { method: 'DELETE' }); await refresh();
    }
  }, 'danger')); card.append(details); return card;
}

async function upload(file) {
  if (uploadBusy) return;
  uploadBusy = true; $('upload-button').disabled = true;
  try {
    const pending = await api('/api/uploads');
    // Check both ends plus metadata before resuming; never confuse two same-size filenames.
    const sample = new Blob([file.slice(0, 1024 ** 2), file.slice(Math.max(0, file.size - 1024 ** 2)), `${file.name}:${file.size}:${file.lastModified}`]);
    const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await sample.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
    let info = pending.find(item => item.name === file.name && item.size === file.size && item.fingerprint === fingerprint);
    if (!info) info = await api('/api/uploads', { method: 'POST', body: { name: file.name, size: file.size, fingerprint } });
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
        $('upload-status').textContent = `Connexion interrompue, tentative ${retries}/5…`;
        await new Promise(resolve => setTimeout(resolve, retries * 1000));
        offset = (await api(`/api/uploads/${info.id}`)).offset;
      }
    }
    $('upload-status').textContent = label('Analyse du fichier…');
    await api(`/api/uploads/${info.id}/complete`, { method: 'POST', body: {} });
    $('upload-status').textContent = label('Envoi terminé. Choisissez les pistes.');
    await refresh();
  } finally { uploadBusy = false; $('upload-button').disabled = false; }
}

async function enterRoom(id) {
  await api(`/api/rooms/${id}`);
  player?.dispose(); activeRoom = id;
  $('entry').hidden = true; $('library').hidden = true; $('watch').hidden = false;
  history.replaceState(null, '', `/#room=${id}`);
  player = new SyncPlayer({ video: $('video'), roomId: id,
    onStatus: message => { $('playback-status').textContent = label(message); },
    onActivation: active => { $('activate').hidden = active; },
    onRendition: (versions, selected) => {
      fillSelect($('quality'), versions.map(version => ({ value: version.id,
        label: `${version.id === 'original' ? 'Original / 원본' : 'Compatible SDR / 호환 SDR'}${version.hdr ? ' · HDR' : ''}` })));
      $('quality').value = selected; $('quality').disabled = versions.length < 2;
    },
    onTracks: (audio, subtitles) => {
      fillSelect($('audio'), audio.map(track => ({ value: track.index, label: track.label })));
      fillSelect($('subtitles'), [{ value: -1, label: label('Désactivés') }, ...subtitles.map(track => ({ value: track.index, label: track.label }))]);
    },
    onState: (message, controller) => {
      $('movie-title').textContent = message.movie?.title ?? 'Séance';
      $('room-movie').value = message.movie?.id ?? '';
      const phase = message.state.phase;
      $('playback-status').textContent = label(controller.failure || (!controller.activated ? 'Activez votre lecteur, puis lancez la séance.' :
        !controller.clock.ready ? 'Mesure de la connexion…' : phase === 'buffering' ? 'Préparation commune : attente du buffer de chaque participant…' :
          phase === 'playing' ? controller.serverTime() < message.state.startsAt ? 'Départ synchronisé…' : 'Lecture synchronisée' : 'En pause'));
      const position = controller.target();
      if (document.activeElement !== $('seek')) $('seek').value = position;
      $('seek').max = message.state.duration || 1;
      $('time').textContent = `${formatTime(position)} / ${formatTime(message.state.duration)}`;
      $('diagnostics').textContent = `Écart / 시간차 : ${Math.round((controller.position() - position) * 1000)} ms · Réseau / 네트워크 : ${Math.round(controller.clock.best?.rtt ?? 0)} ms`;
      $('participants').replaceChildren(...message.members.map((member, index) => element('li',
        `${member.id === controller.memberId ? 'Vous / 나' : `Participant / 참가자 ${index + 1}`} : ${member.ready ? 'prêt / 준비 완료' : 'en attente / 대기 중'} · Buffer / 버퍼 ${member.buffer.toFixed(1)} s`)));
    },
  });
  movies = await api('/api/movies');
  fillSelect($('room-movie'), movies.filter(movie => movie.status === 'ready').map(movie => ({ value: movie.id, label: movie.title })));
}
$('login-form').addEventListener('submit', handle(async event => {
  await api('/api/login', { method: 'POST', body: { password: new FormData(event.target).get('password') } }); event.target.reset(); notice(); await refresh();
}));
$('join-form').addEventListener('submit', handle(async event => {
  const room = await api('/api/join', { method: 'POST', body: { code: new FormData(event.target).get('code') } }); notice(); await enterRoom(room.id);
}));
$('logout').addEventListener('click', handle(async () => {
  player?.dispose(); player = null; $('watch').hidden = true; history.replaceState(null, '', '/');
  await api('/api/logout', { method: 'POST', body: {} }); await refresh();
}));
$('refresh').addEventListener('click', handle(refresh));
$('upload-form').addEventListener('submit', handle(() => upload($('upload-file').files[0])));
$('activate').addEventListener('click', handle(() => player?.activate()));
$('play').addEventListener('click', () => player?.command('play'));
$('pause').addEventListener('click', () => player?.command('pause'));
$('seek').addEventListener('change', () => player?.command('seek', Number($('seek').value)));
$('audio').addEventListener('change', () => player?.changeTrack('audio', Number($('audio').value)));
$('quality').addEventListener('change', () => player?.changeRendition($('quality').value));
$('subtitles').addEventListener('change', () => player?.changeTrack('subtitles', Number($('subtitles').value)));
$('volume').addEventListener('input', () => { $('video').volume = Number($('volume').value); });
$('fullscreen').addEventListener('click', handle(async () => {
  if ($('screen').requestFullscreen) await $('screen').requestFullscreen();
  else if ($('video').webkitEnterFullscreen) $('video').webkitEnterFullscreen();
}));
$('leave').addEventListener('click', handle(async () => {
  player?.dispose(); player = null; activeRoom = null; $('watch').hidden = true;
  history.replaceState(null, '', '/'); await refresh();
}));
$('choose-film').addEventListener('submit', handle(async () => {
  await api(`/api/rooms/${activeRoom}/movie`, { method: 'POST', body: { movieId: $('room-movie').value } });
}));
window.addEventListener('beforeunload', event => { if (uploadBusy) { event.preventDefault(); event.returnValue = ''; } });
setInterval(() => { if (!player && !uploadBusy && movies.some(movie => ['processing', 'probing'].includes(movie.status))) refresh().catch(error => notice(error.message)); }, 3000);
await handle(async () => {
  await refresh(); const params = new URLSearchParams(location.hash.slice(1));
  if (params.has('invite')) {
    const room = await api('/api/join', { method: 'POST', body: { code: params.get('invite') } }); await enterRoom(room.id);
  } else if (params.has('room')) await enterRoom(params.get('room'));
})();
