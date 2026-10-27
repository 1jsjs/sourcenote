# Sourcenote

A desktop lecture-notes agent that will verify its own citations. Stage 1 (this
repo): ingest lecture audio, transcribe it with Meta's Muse Voice Transcribe
API into time-stamped segments, and guard API spend with a hard budget cap.
Summarization with per-sentence citations and citation verification (Muse
Spark) land in later stages.

Built during the Meta Global AI Developer Hackathon (Oct 27 – Nov 5, 2026).

## Requirements

- macOS (the API key is read from the macOS keychain)
- Node 24+
- ffmpeg: bundled via `ffmpeg-static`, falling back to `ffmpeg` on PATH
- A Meta AI API key with access to `muse-voice-transcribe-1.0`

## API key setup (macOS keychain)

Run interactively and type the key at the prompt — never paste it into files,
docs, or shell history:

```sh
security add-generic-password -a "$USER" -s sourcenote-meta-api -w
```

Alternatively set `SOURCENOTE_META_API_KEY` (takes precedence; useful for CI).
The key is held in memory only and is never logged, persisted by the app, or
sent to the renderer process.

## Run

```sh
npm install
npm run dev        # opens the Electron window
```

Headless pipeline (creates a note, converts, transcribes, prints segments and
spend; uses real API credit):

```sh
npm run pipeline -- /path/to/lecture.wav --title "강의 1"
```

Other scripts: `npm test` (vitest), `npm run typecheck`, `npm run build`.

## Budget guard

Every call to `api.meta.ai` goes through a single module that checks a
conservative estimate against a **$140 cap** before the request and records the
actual billed amount after it. Usage is persisted to `usage-ledger.json` in the
app data directory; once the cap is reached, calls are blocked locally. The
header shows current spend (`$x.xxxx / $140`).

## Data

Stored in Electron's `userData` directory (or `SOURCENOTE_DATA_DIR` when set):
`sourcenote.sqlite` (notes, sources, segments), `usage-ledger.json`, `media/`
(converted 16 kHz mono WAV chunks).

## License

MIT — see [LICENSE](LICENSE).
