# Sample lecture

A short original lecture ("Gradient Descent & Learning Rate", Korean) made for this project.
Everything here was written for Sourcenote during the hackathon and may be reused freely.

| File | What it is |
|---|---|
| `lecture-script.txt` | The lecture script, one paragraph per line |
| `demo-lecture.m4a` | macOS text-to-speech (voice: Yuna) of the script, 1.6 s pause between paragraphs (84 s) |
| `demo-slides.pdf` | 4 slides with the English terms; slide 4 adds *Warmup*, which the lecture never says |
| `demo-slides.html` | Source of the slides (printed to PDF with headless Chrome) |
| `lecture-script-en.txt`, `demo-slides-en.html` | English version (voice: Samantha, 71 s) |
| `notes/ko-gradient-descent/`, `notes/en-gradient-descent/` | Ready-made sample notes (`sample-note/v1`): transcript, slides, accepted corrections, cited summary and a notes check, produced by the real pipeline with Muse Voice Transcribe and Muse Spark. The app opens them without an API key (**Open sample note**). |

## Try it from the command line

```bash
npm run pipeline -- samples/demo-lecture.m4a --title "Gradient descent (demo)"
npm run add-pdf -- <noteId> samples/demo-slides.pdf
npm run correct -- <noteId> --accept-all
npm run summarize -- <noteId>
npm run check -- <noteId> "학습률이 너무 크면 손실이 발산할 수 있다." "드롭아웃은 추론할 때도 같은 비율로 뉴런을 끈다."
```

The last command should mark the dropout sentence as **자료에 없음** (not in the sources):
the lecture never mentions dropout.
