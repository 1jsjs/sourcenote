/**
 * Word error rate of a source's transcript against a reference transcript:
 * `npm run eval-wer -- <sourceId> <reference.txt|.html>`
 *
 * Used to measure Muse Voice Transcribe on lectures that publish a human
 * transcript (e.g. Stanford SEE CS229). No API calls. Speaker labels,
 * bracketed notes like [inaudible] and punctuation are ignored; numbers and
 * words are compared lowercased.
 */
import fs from 'node:fs'
import { listSegments, openDb } from '../src/main/db'
import { dbFilePath, ensureDataDir } from '../src/main/paths'

/** Filler words a cleaned human transcript usually omits. */
const FILLERS = new Set(['um', 'uh', 'umm', 'uhm', 'er', 'ah', 'hmm', 'mm'])

/** Drops fillers and immediate word/bigram repeats ("the the", "get started get started"). */
export function cleanVerbatim(words: string[]): string[] {
  const out: string[] = []
  for (const w of words) {
    if (FILLERS.has(w)) continue
    out.push(w)
    const n = out.length
    if (n >= 2 && out[n - 1] === out[n - 2]) out.pop()
    else if (n >= 4 && out[n - 1] === out[n - 3] && out[n - 2] === out[n - 4]) out.splice(n - 2, 2)
  }
  return out
}

export function normalizeWords(text: string): string[] {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\b(?:Instructor|Student)\s*(?:\([^)]*\))?\s*:/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
}

/** Word-level Levenshtein distance with two rolling rows. */
export function editDistance(ref: string[], hyp: string[]): number {
  let prev = new Int32Array(hyp.length + 1)
  let cur = new Int32Array(hyp.length + 1)
  for (let j = 0; j <= hyp.length; j++) prev[j] = j
  for (let i = 1; i <= ref.length; i++) {
    cur[0] = i
    for (let j = 1; j <= hyp.length; j++) {
      const sub = prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)
      cur[j] = Math.min(sub, prev[j] + 1, cur[j - 1] + 1)
    }
    ;[prev, cur] = [cur, prev]
  }
  return prev[hyp.length]
}

function main(): void {
  const [sourceArg, refPath, ...rest] = process.argv.slice(2)
  const sourceId = Number(sourceArg)
  if (!Number.isInteger(sourceId) || !refPath || rest.length > 0) {
    console.error('사용법: npm run eval-wer -- <소스 번호> <정답 자막 파일>')
    process.exit(1)
  }
  const db = openDb(dbFilePath(ensureDataDir()))
  const segments = listSegments(db, sourceId)
  if (segments.length === 0) {
    console.error(`소스 #${sourceId}에 전사 구간이 없습니다.`)
    process.exit(1)
  }
  // Compare the raw ASR output: corrections are a separate, user-approved step.
  const hypText = segments
    .map((s) => s.original_text ?? s.text)
    .join(' ')
  const ref = normalizeWords(fs.readFileSync(refPath, 'utf8'))
  const hyp = normalizeWords(hypText)
  const report = (label: string, r: string[], h: string[]): void => {
    const dist = editDistance(r, h)
    console.log(`${label}: 정답 ${r.length}단어 · 전사 ${h.length}단어 · 편집 거리 ${dist} · WER ${((dist / r.length) * 100).toFixed(1)}%`)
  }
  report('그대로', ref, hyp)
  // The reference is a cleaned transcript; apply the same cleaning to both.
  report('간투사·반복 제거', cleanVerbatim(ref), cleanVerbatim(hyp))
}

// Run only as a script, so tests can import the pure helpers.
if (process.argv[1]?.endsWith('eval-wer.ts')) main()
