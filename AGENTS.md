# AGENTS.md

Private movie-night app: admin uploads films, viewers join synced watch rooms.
Single Node process, no build step, no framework.

## Stack and layout

- `src/` Express 5 + ws server. `app.js` holds routes and the WebSocket room
  protocol, `media.js` runs ffprobe/ffmpeg, `storage.js` is the JSON file store
  under `data/movies`, `sync/room.js` is the shared-playback state machine.
- `public/` vanilla ES modules served as-is. `index.html` is one page for both
  `/` and `/admin`, `app.js` drives it, `sync-player.js` handles playback sync,
  `color-renderer.js` the WebGL HDR to sRGB render, `labels.js` the Korean
  translations of server error strings.
- `test/` node:test unit and integration tests, `e2e/` a single Playwright spec
  covering the whole flow, `docs/` French docs, `data/` gitignored media.

## Commits

- Conventional commits, entirely lowercase, in English: `type(scope): message`
  (e.g. `fix(media): keep original timestamps on subtitle remap`).
- Types seen in history: `feat`, `fix`, `docs`, `test`, `ci`, `perf`.
  Scopes: `ui`, `media`, `server`, `color`, `e2e`, `ci`, `deploy`, `streaming`.
- No `Co-Authored-By` or any AI/agent mention in commit messages.
- Commit at each major step of a task so progress is never lost.
- Never commit `data/`, `.env` or `test-results/`. Do not push unless asked.

## Coding conventions

- Prose (docs, comments, UI text) reads like a human wrote it: no emojis, no em
  or en dashes as punctuation, no semicolons. Comments are rare and explain why.
- UI is bilingual fr/ko. Static markup uses `data-fr`/`data-ko` attributes picked
  up by `translate()` and dynamic strings use `t(french, korean)` inline. Server
  errors stay in French and map to Korean in `public/labels.js`. Track display
  names are always English (`French`, `Subtitles 2`).
- Nothing loads from external domains. The CSP allows `'self'` plus `blob:`
  for media and the hls.js worker, so fonts and vendor libs (`hls.js`, `plyr`)
  are served from `public/` and `node_modules`.
- Compact code, small helpers (`el`, `button`, `field` in `app.js`), error
  handling at boundaries only (`handle()` wraps UI actions into `#notice`).
- The video stream is copied byte-exact into HLS/fMP4, never re-encoded. Only the
  container colour box is rewritten for transport and source colour metadata feeds
  the WebGL shader. Audio is copied when AAC-LC <= stereo 44.1/48 kHz, else
  converted once to AAC-LC stereo 48 kHz. Embedded + uploaded text subtitles
  (SRT, VTT, SMI, ASS/SSA, SUB, SBV, LRC) become WebVTT; uploads are normalized
  to UTF-8 with jschardet + TextDecoder and validated by a real ffmpeg conversion
  (`subtitleFileFormat`), since microdvd/lrc have no probe. Image subtitles are
  unsupported.
- Movie lifecycle: `uploaded` -> `processing` -> `ready` (plus `probing`,
  `failed`, `incompatible`). Each preparation writes a fresh UUID `generation`
  directory so a failed run never replaces a working one. Administrator-added
  subtitle files carry `external: true` and are copied forward on re-prepare.
- Uploads are resumable 8 MiB chunks through `/api/uploads`. Movies have a 20 GB
  cap and added subtitle files a 2 MB cap.

## Checks before committing

- `npm test` for `src/` and `test/` changes.
- `npm run test:e2e` for `public/` or API changes. WebKit is skipped on Windows
  (no HLS/MSE there), so run it on macOS/Linux when touching playback.
- `npm run test:colors` when touching the colour pipeline or shaders.
- FFmpeg and FFprobe must be installed. `npm run setup` finds them, also via
  Chocolatey on Windows.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `xelema/movie-together`, managed via the `gh`
CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map to identical label strings:
`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.
See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `CONTEXT.md` plus `docs/adr/` at the repo root.
See `docs/agents/domain.md`.
