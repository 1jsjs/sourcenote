# Sourcenote

**A lecture-notes agent that verifies its own citations.** Drop in a lecture
recording and the slides; Sourcenote transcribes the talk, writes a summary in
which every sentence must point at the moment in the audio or the slide page it
came from, and then checks each sentence again against *only* the evidence it
cites. Anything the sources do not support is labelled **자료에 없음** (not in
the sources) instead of being shown as fact.

What it does today:

- **Transcribe** audio with Muse Voice Transcribe (16 kHz WAV chunks, time-stamped segments).
- **Read slides**: PDF pages become a second kind of citable evidence.
- **Fix the transcript**: Muse Spark proposes corrections for ASR errors, such as English
  terms written in Korean phonetics (러닝 레이트 → learning rate, spelled as on the slides)
  or repeated words. You accept or reject each one, and the original is kept.
- **Summarize with citations**: Muse Spark returns claims under a strict JSON schema;
  each claim must cite numbered transcript segments and/or slide pages.
- **Verify**: a second Muse Spark call judges each claim against only its cited evidence.
- **Check my notes**: paste your own notes; each sentence is matched to evidence and verified.
- **Jump to the source**: click a time chip to play the lecture from that moment, or a
  page chip to open the slide.
- **Budget guard**: every API call is checked against a local spend cap.

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

More headless commands (all use the same main-process modules as the app):

```sh
npm run add-pdf -- <noteId> slides.pdf     # extract slide text (no API call)
npm run correct -- <noteId> [--accept-all] # propose transcript corrections
npm run summarize -- <noteId>              # cited summary + verification
npm run check -- <noteId> "문장1" "문장2"     # verify your own notes
```

Try it with the original sample lecture in [`samples/`](samples/README.md).

Other scripts: `npm test` (vitest), `npm run typecheck`, `npm run build`.

## How it was built

Built during the hackathon. The citation-enforced summary, verification, click-to-play,
PDF evidence, term correction and note checking were implemented with
**Muse Code** (`muse-spark-1.3`), and each change was reviewed before it was committed;
see the commit messages.

## Budget guard

Every call to `api.meta.ai` goes through a single module that checks a
conservative estimate against a **$100 cap** (override with `SOURCENOTE_BUDGET_CAP_USD`) before the request and records the
actual billed amount after it. Usage is persisted to `usage-ledger.json` in the
app data directory; once the cap is reached, calls are blocked locally. The
header shows current spend (`$x.xxxx / $100`).

## Data

Stored in Electron's `userData` directory (or `SOURCENOTE_DATA_DIR` when set):
`sourcenote.sqlite` (notes, sources, segments, slide pages, summaries, claims, citations, corrections), `usage-ledger.json`, `media/`
(converted 16 kHz mono WAV chunks).

## License

MIT — see [LICENSE](LICENSE).
