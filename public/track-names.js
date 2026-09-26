// Shared by the page and the server so the name shown in the preparation form
// is the one written into the manifest when the field is left untouched.
const LANGUAGE_NAMES = { fr: 'French', fra: 'French', fre: 'French', en: 'English', eng: 'English',
  ko: 'Korean', kor: 'Korean', es: 'Spanish', spa: 'Spanish', de: 'German', deu: 'German', ger: 'German',
  it: 'Italian', ita: 'Italian', pt: 'Portuguese', por: 'Portuguese', ja: 'Japanese', jpn: 'Japanese',
  zh: 'Chinese', zho: 'Chinese', chi: 'Chinese', nl: 'Dutch', nld: 'Dutch', dut: 'Dutch',
  ru: 'Russian', rus: 'Russian', ar: 'Arabic', ara: 'Arabic', tr: 'Turkish', tur: 'Turkish',
  pl: 'Polish', pol: 'Polish', vi: 'Vietnamese', vie: 'Vietnamese', und: 'Other' };
export const languageName = code => LANGUAGE_NAMES[code] || code;
export const trackName = track => languageName(track.label);

// The probe stores the container title in label, with its own fallback when
// there is none: those fallbacks are not informative titles.
export const sourceTitle = track =>
  track.label && track.label.toLowerCase() !== (track.language ?? '').toLowerCase() &&
  !/^(audio|subtitles) \d+$/i.test(track.label) ? track.label : '';

export const trackLayout = track => {
  const layout = (track.channelLayout ?? '').replace(/\(.*\)/, '');
  if (layout && layout !== 'unknown') return layout;
  return { 1: 'mono', 2: 'stereo', 6: '5.1', 7: '6.1', 8: '7.1' }[track.channels] ??
    (track.channels ? `${track.channels}ch` : '');
};

// Default display name per track index. Language alone when it already
// distinguishes the track, otherwise a qualifier is added: flags first, then
// the original title or the audio layout, then a number.
export function defaultTrackNames(tracks, kind) {
  const named = tracks.map((track, position) => {
    const base = track.language && track.language !== 'und' ? languageName(track.language)
      : kind === 'audio' ? `Track ${position + 1}` : `Subtitles ${position + 1}`;
    const title = sourceTitle(track);
    const flags = [];
    if (track.forced || /\bforced\b/i.test(title)) flags.push('forced');
    if (track.commentary || /\bcommentary\b/i.test(title)) flags.push('commentary');
    if (track.hearingImpaired) flags.push('SDH');
    if (track.visualImpaired) flags.push('descriptive');
    return { name: flags.length ? `${base} (${flags.join(', ')})` : base, title, track };
  });
  const result = new Map(tracks.map((track, index) => [track.index, named[index].name]));
  const collisions = new Map();
  named.forEach((entry, index) => {
    if (!entry.track.compatible) return;
    collisions.set(entry.name, [...collisions.get(entry.name) ?? [], index]);
  });
  for (const group of collisions.values()) {
    if (group.length < 2) continue;
    const titles = group.map(index => named[index].title);
    if (titles.every((title, i) => title && title !== named[group[i]].name) && new Set(titles).size === group.length) {
      for (const index of group) result.set(tracks[index].index, `${named[index].name} (${named[index].title})`);
      continue;
    }
    const layouts = group.map(index => trackLayout(tracks[index]));
    if (kind === 'audio' && layouts.every(Boolean) && new Set(layouts).size === group.length) {
      for (const [i, index] of group.entries()) result.set(tracks[index].index, `${named[index].name} (${layouts[i]})`);
      continue;
    }
    group.forEach((index, n) => { if (n) result.set(tracks[index].index, `${named[index].name} ${n + 1}`); });
  }
  return result;
}
