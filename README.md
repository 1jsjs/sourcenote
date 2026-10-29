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
- **Ask the lecture**: ask a question and get a short answer built only from the
  recording and slides; every answer sentence cites its evidence and is verified the
  same way. When the materials do not cover the question, Sourcenote says so instead
  of answering from outside knowledge.
- **Jump to the source**: click a time chip to play the lecture from that moment, or a
  page chip to open the slide.
- **Budget guard**: every API call is checked against a local spend cap.
- **Korean / English**: the `한국어 | English` toggle in the header switches the
  whole UI and the AI output language together (claims, reasons, prompts).
  The choice is stored in `settings.json` next to the database; existing
  summaries keep the language they were written in.
- **Parallel transcription**: lecture chunks are transcribed 3 at a time
  (override with `SOURCENOTE_TRANSCRIBE_CONCURRENCY=1..6`); progress reads
  `Transcribing 3/9`.
- **Sample notes**: no API key? Click **Open sample note** in the sidebar
  (or pick one from the empty-state card) to import a bundled lecture with
  transcript, slides, corrections, a verified summary and answered questions — everything works
  offline except calls that need the API.

Built during the Meta Global AI Developer Hackathon (Oct 27 – Nov 5, 2026).

## Requirements

- macOS on Apple Silicon (signed, notarized DMG) or Windows x64 (unsigned installer built in CI)
- Node 24+
- Audio decoding: the system `afconvert` on macOS (WAV, MP3, M4A, AAC, FLAC, OGG,
  MP4, MOV); a bundled ffmpeg on Windows (also WebM)
- A Meta AI API key with access to `muse-voice-transcribe-1.0`

## API key

Click **Add API key** at the top right and paste the key. The app encrypts it
with Electron `safeStorage` (the macOS keychain or Windows DPAPI holds the
encryption key) and stores only the encrypted bytes in the app data folder.
The renderer never receives the key back; it only learns where the key in use
comes from.

The app looks for a key in this order:

1. `SOURCENOTE_META_API_KEY` environment variable (useful for CI)
2. the key saved in the app
3. macOS keychain item `sourcenote-meta-api` (developer setup; run it
   interactively and type the key at the prompt, never in files or history):

   ```sh
   security add-generic-password -a "$USER" -s sourcenote-meta-api -w
   ```

The key is never logged, written in plain text, or sent anywhere except the
`Authorization` header of Meta API requests.

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

All four `pipeline` / `summarize` / `correct` / `check` commands accept
`--lang ko|en` (default: the saved app setting, else Korean) to switch the
AI output language and CLI labels.

Export a note as a shareable sample (writes `<outDir>/note.json` plus the
source files; only the latest summary of each kind is included):

```sh
npm run export-sample -- <noteId> <outDir>
```

Try it with the original sample lecture in [`samples/`](samples/README.md).

Other scripts: `npm test` (vitest), `npm run typecheck`, `npm run build`.

## Build the app

```sh
npm run dist:mac   # release/Sourcenote-<version>-mac-arm64.dmg (Apple silicon)
npm run dist:win   # release/Sourcenote-<version>-win-x64-setup.exe
```

The sample notes are bundled, so a fresh install can open them without an API key.
A Mac build is signed when a "Developer ID Application" certificate is in the keychain;
`CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac` builds an unsigned copy for local testing.
To notarize, store a notarytool profile once, then build and notarize the DMG:

```sh
xcrun notarytool store-credentials sourcenote-notary --apple-id <apple-id> --team-id <team-id>
APPLE_KEYCHAIN_PROFILE=sourcenote-notary npm run dist:mac
npm run notarize:dmg
```

The Windows installer is built on every push to `main` by GitHub Actions
(`.github/workflows/build.yml`, a `windows-latest` runner that also runs the
typecheck and tests). Download it from the run's **Sourcenote-win-x64** artifact.
It is not code-signed, so SmartScreen asks for confirmation on first launch
(**More info** → **Run anyway**).

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
`sourcenote.sqlite` (notes, sources, segments, slide pages, summaries, claims, citations, corrections), `usage-ledger.json`, `settings.json`
(app language), `media/` (converted 16 kHz mono WAV chunks), `samples/`
(imported sample-note copies).

## License

Sourcenote's own code is MIT — see [LICENSE](LICENSE).

### Third-party: FFmpeg (Windows build only)

The Windows installer bundles an FFmpeg 6.1 executable (from the
[`ffmpeg-static` b6.1.1 release](https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1),
a gyan.dev build configured with `--enable-gpl --enable-version3`), so that
executable is licensed under the **GNU GPL v3**. Sourcenote runs it as a
separate process and does not link to it. Its license text ships inside the
app at `resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe.LICENSE`,
and the FFmpeg source code is available at <https://ffmpeg.org/download.html>.

The macOS build bundles no FFmpeg: the `ffmpeg-static` macOS binary is built
with `--enable-nonfree` and may not be redistributed, so macOS uses the
system `afconvert` instead.
