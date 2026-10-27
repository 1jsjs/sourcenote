import type { DatabaseSync } from 'node:sqlite'
import type { Correction, CorrectionProgressEvent } from '../shared/types'
import {
  deletePendingCorrections,
  getCorrection,
  insertCorrections,
  listCorrections,
  listNotePages,
  listNoteSegments,
  setCorrectionStatus,
  type NewCorrection,
} from './db'
import { DEFAULT_SUMMARY_MODEL, formatSegmentLine } from './grounding'
import type { ChatMessage, MetaApi } from './meta-api'

/**
 * ASR term-correction pipeline (stage 4a): the agent proposes minimal
 * fixes (phonetic English terms, duplicated words, typos) and the user
 * accepts or rejects each one. Accepted corrections edit `segments.text`,
 * so later summaries automatically use the corrected transcript.
 */

/** Maximum slide characters shown to the model as a term glossary. */
export const MAX_CORRECTION_SLIDES_CHARS = 30_000

export const CORRECTION_SYSTEM_PROMPT =
  'You are a transcription proofreader for Korean lecture transcripts. ' +
  'Fix ONLY speech-recognition errors:\n' +
  '(1) term: Korean phonetic spellings of English technical terms -> the original English term, ' +
  'preferring the exact spelling used on the slides when present ' +
  '(e.g. 러닝 레이트 -> learning rate). ' +
  'Keep Korean words that are normal Korean (e.g. 학습률, 손실 함수 stay).\n' +
  '(2) duplicate: accidental repeated words (e.g. 레이어로 레이어로 -> 레이어로).\n' +
  '(3) typo: obvious misrecognitions with a clear intended word (e.g. 손실 합수 -> 손실 함수).\n' +
  'Never paraphrase, never add or remove meaning, never change numbers. ' +
  '`before` must be copied exactly from the segment text and be as short as possible ' +
  '(just the wrong words); one item per occurrence. ' +
  'Write the reason in Korean. ' +
  'Reply in Korean.'

export const CORRECTION_SCHEMA_NAME = 'transcript_corrections'

export const CORRECTION_SCHEMA = {
  type: 'object',
  properties: {
    corrections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          segment_number: { type: 'integer' },
          before: { type: 'string' },
          after: { type: 'string' },
          kind: { type: 'string', enum: ['term', 'duplicate', 'typo'] },
          reason: { type: 'string' },
        },
        required: ['segment_number', 'before', 'after', 'kind', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['corrections'],
  additionalProperties: false,
} as const

export interface CorrectionItemRaw {
  segmentNumber: unknown
  before: unknown
  after: unknown
  kind: unknown
  reason: unknown
}

/** Validates the parsed correction JSON shape. Throws a Korean error when invalid. */
export function validateCorrectionPayload(raw: unknown): CorrectionItemRaw[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('교정 API 응답 형식이 올바르지 않습니다.')
  }
  const corrections = (raw as Record<string, unknown>).corrections
  if (!Array.isArray(corrections)) {
    throw new Error('교정 API 응답 형식이 올바르지 않습니다.')
  }
  return corrections.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('교정 API 응답 형식이 올바르지 않습니다.')
    }
    const obj = item as Record<string, unknown>
    return {
      segmentNumber: obj.segment_number,
      before: obj.before,
      after: obj.after,
      kind: obj.kind,
      reason: obj.reason,
    }
  })
}

export interface ValidCorrection extends NewCorrection {
  segmentNumber: number
}

/**
 * Builds the correction chat messages: numbered transcript lines (same
 * `[n] (time) text` numbering as the summary) plus, when the note has
 * slides, a `Slides:` glossary section truncated to 30,000 chars total.
 */
export function buildCorrectionMessages(
  numberedLines: string[],
  slideTexts: string[] = [],
): ChatMessage[] {
  const parts = [...numberedLines]
  if (slideTexts.length > 0) {
    let remaining = MAX_CORRECTION_SLIDES_CHARS
    const kept: string[] = []
    for (const text of slideTexts) {
      if (remaining <= 0) break
      kept.push(text.slice(0, remaining))
      remaining -= Math.min(text.length, remaining)
    }
    parts.push('Slides:')
    parts.push(kept.join('\n'))
  }
  return [{ role: 'system', content: CORRECTION_SYSTEM_PROMPT }, { role: 'user', content: parts.join('\n') }]
}

/**
 * Filters raw model items against the note's current segment texts:
 * drops out-of-range segment numbers, empty or unfound `before`, and
 * before == after; dedupes identical items. Pure and unit-tested.
 */
export function filterValidCorrections(
  items: CorrectionItemRaw[],
  segmentTextByNumber: Map<number, string>,
  segmentIdByNumber: Map<number, number>,
): ValidCorrection[] {
  const seen = new Set<string>()
  const valid: ValidCorrection[] = []
  for (const item of items) {
    if (
      typeof item.segmentNumber !== 'number' ||
      !Number.isInteger(item.segmentNumber) ||
      typeof item.before !== 'string' ||
      typeof item.after !== 'string' ||
      typeof item.reason !== 'string' ||
      (item.kind !== 'term' && item.kind !== 'duplicate' && item.kind !== 'typo')
    ) {
      continue
    }
    const current = segmentTextByNumber.get(item.segmentNumber)
    const segmentId = segmentIdByNumber.get(item.segmentNumber)
    if (current === undefined || segmentId === undefined) continue
    if (item.before.length === 0) continue
    if (item.before === item.after) continue
    if (!current.includes(item.before)) continue
    const key = `${item.segmentNumber}\u0000${item.before}\u0000${item.after}\u0000${item.kind}`
    if (seen.has(key)) continue
    seen.add(key)
    valid.push({
      segmentNumber: item.segmentNumber,
      segmentId,
      beforeText: item.before,
      afterText: item.after,
      reason: item.reason,
      kind: item.kind,
    })
  }
  return valid
}

/** Replaces the first occurrence of `before` with `after`. Pure and unit-tested. */
export function applyCorrectionText(currentText: string, before: string, after: string): string {
  const at = currentText.indexOf(before)
  if (at === -1) return currentText
  return currentText.slice(0, at) + after + currentText.slice(at + before.length)
}

export interface CorrectionPipelineDeps {
  db: DatabaseSync
  metaApi: MetaApi
  model?: string
  onProgress?: (event: CorrectionProgressEvent) => void
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function runCorrectionPipeline(
  deps: CorrectionPipelineDeps,
  noteId: number,
): Promise<Correction[]> {
  const { db, metaApi, onProgress } = deps
  const model = deps.model ?? DEFAULT_SUMMARY_MODEL
  const report = (stage: CorrectionProgressEvent['stage'], message?: string): void => {
    onProgress?.({ noteId, stage, message })
  }

  const segments = listNoteSegments(db, noteId)
  if (segments.length === 0) {
    throw new Error('교정할 전사 구간이 없습니다')
  }
  const pages = listNotePages(db, noteId)

  report('correcting')
  try {
    const numbered = segments.map((s, i) => ({ n: i + 1, segmentId: s.id, text: s.text }))
    const lines = segments.map((s, i) => formatSegmentLine(i + 1, s.startMs, s.endMs, s.text))
    const raw = await metaApi.chat({
      model,
      messages: buildCorrectionMessages(
        lines,
        pages.map((p) => p.text),
      ),
      responseFormat: { name: CORRECTION_SCHEMA_NAME, schema: CORRECTION_SCHEMA },
    })
    const textByNumber = new Map(numbered.map((s) => [s.n, s.text]))
    const idByNumber = new Map(numbered.map((s) => [s.n, s.segmentId]))
    const valid = filterValidCorrections(validateCorrectionPayload(raw), textByNumber, idByNumber)

    // Re-run replaces older pending proposals; accepted/rejected history stays.
    deletePendingCorrections(db, noteId)
    insertCorrections(db, noteId, valid)
    report('done')
    return listCorrectionsDto(db, noteId)
  } catch (err) {
    const message = errorMessage(err)
    report('error', message)
    throw err
  }
}

/** All corrections of a note as renderer DTOs (with segment time/text). */
export function listCorrectionsDto(db: DatabaseSync, noteId: number): Correction[] {
  const segById = new Map<number, { startMs: number; text: string; originalText: string | null }>()
  for (const row of db
    .prepare(
      'SELECT seg.id AS id, seg.start_ms AS startMs, seg.text AS text, ' +
        'seg.original_text AS originalText, src.id AS sourceId, src.note_id AS noteId ' +
        'FROM segments seg JOIN sources src ON src.id = seg.source_id ' +
        'WHERE src.note_id = ?',
    )
    .all(noteId) as unknown as Array<{
    id: number
    startMs: number
    text: string
    originalText: string | null
  }>) {
    segById.set(row.id, { startMs: row.startMs, text: row.text, originalText: row.originalText })
  }
  return listCorrections(db, noteId).map((c) => {
    const seg = segById.get(c.segment_id)
    return {
      id: c.id,
      noteId: c.note_id,
      segmentId: c.segment_id,
      beforeText: c.before_text,
      afterText: c.after_text,
      reason: c.reason,
      kind: (c.kind === 'duplicate' || c.kind === 'typo' ? c.kind : 'term') as Correction['kind'],
      status: (c.status === 'accepted' || c.status === 'rejected' ? c.status : 'pending') as Correction['status'],
      createdAt: c.created_at,
      startMs: seg?.startMs ?? 0,
      segmentText: seg?.text ?? '',
      originalText: seg?.originalText ?? null,
    }
  })
}

/**
 * Accepts one pending correction: replaces the first occurrence of
 * `before_text` in the segment's CURRENT text. When it no longer occurs
 * the correction is marked rejected and a Korean message is returned.
 */
export function acceptCorrection(
  db: DatabaseSync,
  correctionId: number,
): { message: string | null } {
  const correction = getCorrection(db, correctionId)
  if (!correction) throw new Error('교정 제안을 찾을 수 없습니다.')
  if (correction.status !== 'pending') throw new Error('이미 처리된 교정 제안입니다.')

  db.exec('BEGIN')
  try {
    const seg = db
      .prepare('SELECT id, text, original_text AS originalText FROM segments WHERE id = ?')
      .get(correction.segment_id) as unknown as { id: number; text: string; originalText: string | null } | null
    if (!seg) throw new Error('전사 구간을 찾을 수 없습니다.')
    if (!seg.text.includes(correction.before_text)) {
      db.prepare('UPDATE corrections SET status = ? WHERE id = ?').run('rejected', correctionId)
      db.exec('COMMIT')
      return { message: '원문이 이미 바뀌어 적용할 수 없습니다.' }
    }
    const next = applyCorrectionText(seg.text, correction.before_text, correction.after_text)
    if (seg.originalText === null) {
      db.prepare('UPDATE segments SET text = ?, original_text = ? WHERE id = ?').run(
        next,
        seg.text,
        seg.id,
      )
    } else {
      db.prepare('UPDATE segments SET text = ? WHERE id = ?').run(next, seg.id)
    }
    db.prepare('UPDATE corrections SET status = ? WHERE id = ?').run('accepted', correctionId)
    db.exec('COMMIT')
    return { message: null }
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // Already rolled back; fall through to the original error.
    }
    throw err
  }
}

/** Marks one pending correction as rejected (no text change). */
export function rejectCorrection(db: DatabaseSync, correctionId: number): void {
  const correction = getCorrection(db, correctionId)
  if (!correction) throw new Error('교정 제안을 찾을 수 없습니다.')
  if (correction.status !== 'pending') throw new Error('이미 처리된 교정 제안입니다.')
  setCorrectionStatus(db, correctionId, 'rejected')
}

/** Accepts all pending corrections of a note in id order. Returns the accepted count. */
export function acceptAllCorrections(db: DatabaseSync, noteId: number): { accepted: number } {
  const pending = listCorrections(db, noteId).filter((c) => c.status === 'pending')
  let accepted = 0
  for (const c of pending) {
    const result = acceptCorrection(db, c.id)
    if (result.message === null) accepted++
  }
  return { accepted }
}
