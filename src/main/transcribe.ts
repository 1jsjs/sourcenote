import type { NewSegment } from './db'

/**
 * Parsing for the Muse Voice Transcribe API and mapping of API turns onto
 * absolute source-timeline segments. All pure functions (unit-tested).
 *
 * Real response shape:
 *   {"sessionId":"voyager/transcribe/...","transcript":"전체...",
 *    "audioDurationMs":37280,
 *    "turns":[{"turnId":0,"startMs":0,"endMs":36780,"transcript":"..."}]}
 */

export interface TranscribeTurn {
  turnId: number
  startMs: number
  endMs: number
  transcript: string
}

export interface TranscribeResult {
  sessionId: string | null
  transcript: string
  /** Billed audio length; null when the API omits it (fall back to chunk length). */
  audioDurationMs: number | null
  turns: TranscribeTurn[]
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Defensive parse of the API JSON body. Throws only on a non-object body. */
export function parseTranscribeResponse(raw: unknown): TranscribeResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('전사 API 응답이 JSON 객체가 아닙니다.')
  }
  const obj = raw as Record<string, unknown>
  const turns: TranscribeTurn[] = []
  if (Array.isArray(obj.turns)) {
    for (const item of obj.turns) {
      if (item === null || typeof item !== 'object') continue
      const t = item as Record<string, unknown>
      const startMs = asNumber(t.startMs)
      const endMs = asNumber(t.endMs)
      const transcript = asString(t.transcript)
      if (startMs === null || endMs === null || transcript === null) continue
      turns.push({ turnId: asNumber(t.turnId) ?? turns.length, startMs, endMs, transcript })
    }
  }
  return {
    sessionId: asString(obj.sessionId),
    transcript: asString(obj.transcript) ?? '',
    audioDurationMs: asNumber(obj.audioDurationMs),
    turns,
  }
}

export type SegmentDraft = NewSegment

/**
 * Maps one chunk's API result to absolute-timeline segments:
 *   start_ms = chunkOffsetMs + turn.startMs  (same for end).
 * Empty/missing turns with a transcript present produce one segment spanning
 * the whole chunk. No turns and no transcript produce no segments.
 *
 * `idxStart` is the next global segment index (segments keep a continuous
 * `idx` across chunks of one source).
 */
export function turnsToSegments(
  result: TranscribeResult,
  chunkOffsetMs: number,
  chunkDurationMs: number,
  chunkIndex: number,
  idxStart: number,
): SegmentDraft[] {
  if (result.turns.length > 0) {
    return result.turns.map((turn, i) => ({
      idx: idxStart + i,
      startMs: chunkOffsetMs + turn.startMs,
      endMs: chunkOffsetMs + turn.endMs,
      text: turn.transcript,
      chunkIndex,
    }))
  }
  const text = result.transcript.trim()
  if (text.length === 0) return []
  return [
    {
      idx: idxStart,
      startMs: chunkOffsetMs,
      endMs: chunkOffsetMs + (result.audioDurationMs ?? chunkDurationMs),
      text,
      chunkIndex,
    },
  ]
}
