// Subtitle format knowledge, shared isomorphically like track-names.js:
// the server validates and demuxes with it, the client filters uploads with it.
// Adding a format is one entry here, not four lists drifting apart.

// Accepted upload extensions, each mapped to the demuxers worth forcing with
// -f. .sub covers both MicroDVD and SubViewer; the conversion check decides.
export const SUBTITLE_FORMATS = { srt: ['srt'], vtt: ['webvtt'], smi: ['sami'], sami: ['sami'],
  ass: ['ass'], ssa: ['ass'], sub: ['microdvd', 'subviewer'], sbv: ['subviewer', 'subviewer1'], lrc: ['lrc'] };

export const SUBTITLE_EXT = new RegExp(`\\.(${Object.keys(SUBTITLE_FORMATS).join('|')})$`, 'i');
export const SUBTITLE_ACCEPT = Object.keys(SUBTITLE_FORMATS).map(ext => `.${ext}`).join(',');

// Text subtitle codecs ffmpeg can decode to WebVTT. Image codecs and
// decoder-less formats (aqtitle, mpsub, scc, ttml) stay out.
export const TEXT_SUBTITLE_CODECS = ['subrip', 'webvtt', 'mov_text', 'ass', 'ssa', 'sami', 'microdvd', 'mpl2',
  'jacosub', 'pjs', 'realtext', 'stl', 'subviewer', 'subviewer1', 'vplayer', 'eia_608'];
export const IMAGE_SUBTITLE_CODECS = ['dvd_subtitle', 'hdmv_pgs_subtitle', 'dvb_subtitle', 'xsub'];

// Codec to demuxer, for external tracks recorded before they stored their demuxer name.
export const SUBTITLE_DEMUXERS = { subrip: 'srt', webvtt: 'webvtt', ass: 'ass', ssa: 'ass', sami: 'sami',
  microdvd: 'microdvd', mpl2: 'mpl2', jacosub: 'jacosub', pjs: 'pjs', realtext: 'realtext', stl: 'stl',
  subviewer: 'subviewer', subviewer1: 'subviewer1', vplayer: 'vplayer' };
