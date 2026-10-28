# Sourcenote design

Sourcenote checks its own notes. The screen should feel like a student's lecture pad that a
careful teacher has marked: plain paper, blue-black ink, faint ruled lines, and a red pen used
for exactly one thing: **a sentence the sources do not support**.

Everything else stays quiet so that one mark is impossible to miss, including in a compressed
demo video.

## Principles

1. **Red means "Not in sources". Nothing else is red.** Errors use the same red only because
   they also mean "this did not hold up".
2. **Color goes to evidence state, not decoration.** Citation chips are neutral. A sentence's
   status is shown by its mark and highlight, not by chip colors.
3. **One orchestrated motion.** When verification finishes, the result sweeps down the summary
   once. No other large animation.
4. **Every sentence leads back to the source in one click.** Hover a chip to preview the quote;
   click to play the lecture from that moment or open the slide page.
5. **Readable first.** Body text 16 px, line length about 65–75 characters, sentence-case labels,
   no ALL-CAPS eyebrows, no cards inside cards.

## Color tokens

| Token | Light | Dark | Why |
|---|---|---|---|
| `--desk` | `#ECEEEA` | `#15171C` | The desk under the pad: app chrome and sidebar, a tinted gray so the page reads as a sheet. |
| `--page` | `#FCFCFA` | `#1C1F26` | The sheet itself. Nearly white (not cream) so the ink and the red pen carry the color. |
| `--rule` | `#D8E1EC` | `#2C3443` | Faint blue ruled lines of a lecture pad. Used for hairlines and separators only. |
| `--margin` | `#EBC3BD` | `#4A2D2E` | The pale margin line of the pad. Structure, deliberately much paler than the red pen. |
| `--ink` | `#1E2433` | `#E6E9EF` | Blue-black fountain-pen ink: all body text. |
| `--ink-muted` | `#5C6475` | `#A3AAB8` | Secondary text, quoted source text, metadata (tinted, never pure gray). |
| `--ink-faint` | `#8D94A3` | `#6E7686` | Placeholders, disabled states. |
| `--pen` | `#2D4F8A` | `#8FB0E8` | Ink-blue for links, focus rings, the playing transcript line, the primary button. |
| `--red` | `#C8372D` | `#F07167` | The teacher's red pen: "Not in sources" mark, squiggle, label, reason. |
| `--red-wash` | `#FBE3DF` | `#3A2024` | Red highlighter behind an unsupported sentence. |
| `--chip` | `#EEF1F5` | `#262B35` | Neutral citation chip background. |
| `--chip-ink` | `#2B3446` | `#D3D9E3` | Chip text and icon. |
| `--chip-line` | `#D6DCE5` | `#343B48` | Chip border. |

Supported sentences get no color of their own: a small check in `--ink-muted` in the margin.

## Type

- Two families only. **Body and UI:** system sans (`-apple-system`, `SF Pro Text`,
  `Apple SD Gothic Neo`, `Segoe UI`). **Display:** `ui-serif` (New York on macOS), used for
  exactly two sizes: the note title (28 px) and section titles (20 px).
- Body 16 px / 1.6. UI controls 13–14 px. Timestamps use `tabular-nums` in the sans face (no
  monospace for decoration).
- Labels in sentence case ("Not in sources", "자료에 없음"), never uppercase eyebrows.
- Summary text column max width 680 px.

## Shape and depth

- Radius: 8 px for panes and dialogs, 6 px for buttons and inputs, 999 px for chips.
- Hairlines (`--rule`) separate sections; panes are the only cards. No colored side borders
  thicker than 1 px.
- Shadow only on floating layers (menus, hover cards, dialogs): `0 8px 24px rgb(30 36 51 / .14)`.

## Components

- **Citation chip:** pill, height 24 px, 13 px tabular numbers, 14 px icon: a waveform for a
  lecture moment (`12:34`), a page for a slide (`p.7`). Neutral colors. Hover: a 320 px card with
  the quoted source text in `--ink-muted` and where it is from. Click: the right pane scrolls to
  the line (or opens the slide) and highlights it for 2 s; a time chip also starts playback there.
- **Claim:** margin column (40 px) holds the status mark left of the pale margin line; text to the
  right. Unsupported: `--red-wash` highlighter behind the text, red wavy underline, a "Not in
  sources" label, and the reason below in `--red` at 14 px (indented, no border).
- **Evidence bar** above the summary: one 10 px square per sentence (muted ink, red for "Not in
  sources", outlined while pending), then "11 of 13 sentences cited and verified" and the red
  count. A square jumps to its sentence; the red count steps through the flagged sentences. No
  middle-dot meta strings, no em dashes in UI copy, and no side-stripe accents (the selected note
  is a filled row only), per the anti-slop checklists (Impeccable, Hallmark, frontend-design).
- **Verification reveal:** when a verification run finishes, marks appear top to bottom (40 ms
  stagger) and the red highlighter sweeps in left to right (600 ms, `cubic-bezier(.16,1,.3,1)`).
  Respects `prefers-reduced-motion`.
- **Empty note:** a drop zone ("Drop a lecture recording and slides here") with a three-step
  strip: Transcribe → Summarize with sources → Check every sentence.

## States to check before recording

Empty app, empty note, transcribing (with progress), summary with 0 and with several flagged
sentences, long note titles, a two-hour lecture transcript, error banner, Korean and English,
light and dark.
