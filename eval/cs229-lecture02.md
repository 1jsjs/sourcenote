# Evaluation: Stanford CS229 Lecture 2 (real 76-minute lecture)

Source: *CS229 Machine Learning*, Lecture 2 (Andrew Ng), Stanford Engineering Everywhere,
https://see.stanford.edu/Course/CS229 — licensed CC BY-NC-SA 4.0. The lecture video, notes and
transcript are **not** included in this repository; download them from SEE to reproduce.

Measured on 2026-10-27 with `muse-voice-transcribe-1.0` and `muse-spark-1.3`.

## Transcription (Muse Voice Transcribe)

Input: lecture audio (1:16:15), split into 9 chunks of ≤ 9.5 min → 311 time-stamped segments.
Reference: the official human transcript published by SEE (`MachineLearning-Lecture02.html`).

| Comparison | Reference words | Transcript words | Edit distance | WER |
|---|---|---|---|---|
| As is | 9,078 | 10,375 | 2,791 | 30.7% |
| Fillers (um, uh) and immediate repeats removed from both | 9,061 | 9,561 | 2,032 | 22.4% |

The reference is an edited transcript (fillers and false starts removed), so the second row is
the fairer number. The recording is a 2008 classroom capture; student questions are often
inaudible. Reproduce: `npm run eval-wer -- <sourceId> MachineLearning-Lecture02.html`.

## Cited summary + verification

Evidence: the 311 transcript segments + `cs229-notes1.pdf` (30 pages of lecture notes).

- 13 claims, every claim cites transcript times; 10 also cite note pages.
- Verifier: 11 supported, **2 marked 자료에 없음** — both added a detail the cited evidence does not
  state (calling ALVINN's networks "parallel"; stating *why* trace notation was introduced).

## Check my notes (sentences written for this test)

| Sentence | Verdict | Cited evidence |
|---|---|---|
| Gradient descent repeatedly takes a step in the direction of steepest descent of J. | supported | 00:26:26, 00:30:05, notes p.4 |
| Stochastic gradient descent always converges exactly to the global minimum. | **not in sources** (evidence says it oscillates around the minimum) | 00:47:48, 00:48:09, notes p.7 |
| For linear regression the cost function J has no local optima other than the global optimum. | supported | 00:38:00, 00:39:21, notes p.5 |
| The housing price example was trained with the Adam optimizer. | **not in sources** (batch gradient descent; Adam never mentioned) | 00:38:00, 00:40:28, notes p.6 |
| If X transpose X is not invertible, you can use the pseudo-inverse. | supported | 01:15:07 |

5 / 5 sentences judged as intended.

## Cost

Transcription + summary + verification + note check for this lecture: about **$0.40**
(app ledger went from $0.19 to $0.59).
