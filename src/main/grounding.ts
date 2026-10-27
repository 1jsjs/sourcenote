import type { ChatMessage } from './meta-api'

/**
 * Prompt building and other pure logic for the citation-enforced summary.
 * The model only ever sees consecutive segment numbers (1..N); the n ->
 * segment DB id map stays on this side. All functions are unit-tested.
 */

/** Default model for the summary and verification chat calls. */
export const DEFAULT_SUMMARY_MODEL = 'muse-spark-1.3'

/** Maximum claims checked in a single verification call. */
export const VERIFY_BATCH_SIZE = 20

/** Reason stored when a claim cites no valid segment. */
export const ZERO_CITATION_REASON = '인용한 구간이 자료에 없습니다'

/** Reason stored when the model omits a claim from verification results. */
export const MISSING_RESULT_REASON = '검증 결과를 받지 못했습니다'

/** Minimal segment shape needed for numbering (NoteSegment satisfies this). */
export interface NumberedInput {
  id: number
  startMs: number
  endMs: number
  text: string
}

export interface NumberedSegment {
  n: number
  segmentId: number
  startMs: number
  endMs: number
  text: string
  line: string
}

// ---------------------------------------------------------------------------
// numbering
// ---------------------------------------------------------------------------

function formatHms(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(Math.floor(totalSec / 3600))}:${pad(Math.floor((totalSec % 3600) / 60))}:${pad(
    totalSec % 60,
  )}`
}

/** One numbered line as shown to the model: `[n] (hh:mm:ss–hh:mm:ss) text`. */
export function formatSegmentLine(n: number, startMs: number, endMs: number, text: string): string {
  return `[${n}] (${formatHms(startMs)}–${formatHms(endMs)}) ${text}`
}

/** Numbers segments 1..N in note order. */
export function numberSegments(segments: NumberedInput[]): NumberedSegment[] {
  return segments.map((s, i) => {
    const n = i + 1
    return {
      n,
      segmentId: s.id,
      startMs: s.startMs,
      endMs: s.endMs,
      text: s.text,
      line: formatSegmentLine(n, s.startMs, s.endMs, s.text),
    }
  })
}

/** Consecutive-number -> segment DB id map for translating model citations back. */
export function idByNumberMap(numbered: NumberedSegment[]): Map<number, number> {
  return new Map(numbered.map((s) => [s.n, s.segmentId]))
}

// ---------------------------------------------------------------------------
// slide pages (stage 3)
// ---------------------------------------------------------------------------

/** Maximum slide page characters shown to the model per page. */
export const MAX_PAGE_CHARS = 3000

/** Minimal page shape needed for numbering (NotePage satisfies this). */
export interface PageInput {
  id: number
  pageNo: number
  displayName: string
  text: string
}

export interface NumberedPage {
  k: number
  pageId: number
  pageNo: number
  displayName: string
  text: string
  line: string
}

/** One numbered slide line as shown to the model: `[Pk] (file p.N) text`. */
export function formatPageLine(
  k: number,
  displayName: string,
  pageNo: number,
  text: string,
): string {
  const clipped = text.length > MAX_PAGE_CHARS ? text.slice(0, MAX_PAGE_CHARS) : text
  return `[P${k}] (${displayName} p.${pageNo}) ${clipped}`
}

/** Numbers non-empty pages 1..M in note order; empty pages are omitted. */
export function numberPages(pages: PageInput[]): NumberedPage[] {
  const nonEmpty = pages.filter((p) => p.text.trim().length > 0)
  return nonEmpty.map((p, i) => {
    const k = i + 1
    return {
      k,
      pageId: p.id,
      pageNo: p.pageNo,
      displayName: p.displayName,
      text: p.text,
      line: formatPageLine(k, p.displayName, p.pageNo, p.text),
    }
  })
}

/** Consecutive-number -> page DB id map for translating model citations back. */
export function pageIdByNumberMap(numbered: NumberedPage[]): Map<number, number> {
  return new Map(numbered.map((p) => [p.k, p.pageId]))
}

// ---------------------------------------------------------------------------
// summary prompt + schema
// ---------------------------------------------------------------------------

/** English instructions; the claims themselves come back in Korean. */
export const SUMMARY_SYSTEM_PROMPT =
  'You are a lecture-note assistant. Summarize the lecture below in Korean.\n' +
  'Write 5–15 concise claims that cover the main points in lecture order.\n' +
  'Every claim MUST cite 1–5 transcript segments ([n]) and/or slide pages ([Pk]) ' +
  'that directly support it.\n' +
  'Prefer the transcript for what the lecturer said; use slides for terms, ' +
  'definitions, and figures shown on slides.\n' +
  'Use only information stated in the transcript or slides. Do not use outside knowledge.\n' +
  'Do not merge unrelated points into a single claim.\n' +
  'Reply in Korean.'

export const SUMMARY_SCHEMA_NAME = 'lecture_summary'

export const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          segment_ids: { type: 'array', items: { type: 'integer' } },
          page_ids: { type: 'array', items: { type: 'integer' } },
        },
        required: ['text', 'segment_ids', 'page_ids'],
        additionalProperties: false,
      },
    },
  },
  required: ['claims'],
  additionalProperties: false,
} as const

/**
 * Builds the summary chat messages from numbered transcript lines plus, when
 * the note has slides, a second `Slides:` section with numbered page lines.
 */
export function buildSummaryMessages(
  numbered: NumberedSegment[],
  numberedPages: NumberedPage[] = [],
): ChatMessage[] {
  const parts = numbered.map((s) => s.line)
  if (numberedPages.length > 0) {
    parts.push('Slides:')
    for (const p of numberedPages) parts.push(p.line)
  }
  return [
    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
    { role: 'user', content: parts.join('\n') },
  ]
}

// ---------------------------------------------------------------------------
// summary response mapping
// ---------------------------------------------------------------------------

export interface SummaryClaimRaw {
  text: string
  segmentIds: unknown[]
  /** Optional so callers built before slide citations keep compiling. */
  pageIds?: unknown[]
}

/** Validates the parsed summary JSON shape. Throws a Korean error when invalid. */
export function validateSummaryPayload(raw: unknown): SummaryClaimRaw[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('요약 API 응답 형식이 올바르지 않습니다.')
  }
  const claims = (raw as Record<string, unknown>).claims
  if (!Array.isArray(claims)) {
    throw new Error('요약 API 응답 형식이 올바르지 않습니다.')
  }
  return claims.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('요약 API 응답 형식이 올바르지 않습니다.')
    }
    const obj = item as Record<string, unknown>
    if (typeof obj.text !== 'string') {
      throw new Error('요약 API 응답 형식이 올바르지 않습니다.')
    }
    const segmentIds = Array.isArray(obj.segment_ids) ? obj.segment_ids : []
    const pageIds = Array.isArray(obj.page_ids) ? obj.page_ids : []
    return { text: obj.text, segmentIds, pageIds }
  })
}

export interface MappedClaim {
  idx: number
  text: string
  /** Deduplicated segment DB ids in first-cited order. Empty when nothing valid was cited. */
  segmentDbIds: number[]
  /** Deduplicated page DB ids in first-cited order. Empty when nothing valid was cited. */
  pageDbIds: number[]
}

/**
 * Translates model segment/page numbers back to DB ids: drops duplicates,
 * discards numbers outside 1..N (1..M for pages), and leaves zero-citation
 * claims empty (the pipeline stores those as unsupported without sending them
 * to verification).
 */
export function mapSummaryClaims(
  claims: SummaryClaimRaw[],
  idByNumber: Map<number, number>,
  pageIdByNumber: Map<number, number> = new Map(),
): MappedClaim[] {
  return claims.map((claim, idx) => {
    const seenSegments = new Set<number>()
    const segmentDbIds: number[] = []
    for (const rawId of claim.segmentIds) {
      if (typeof rawId !== 'number' || !Number.isInteger(rawId)) continue
      const dbId = idByNumber.get(rawId)
      if (dbId === undefined || seenSegments.has(dbId)) continue
      seenSegments.add(dbId)
      segmentDbIds.push(dbId)
    }
    const seenPages = new Set<number>()
    const pageDbIds: number[] = []
    for (const rawId of claim.pageIds ?? []) {
      if (typeof rawId !== 'number' || !Number.isInteger(rawId)) continue
      const dbId = pageIdByNumber.get(rawId)
      if (dbId === undefined || seenPages.has(dbId)) continue
      seenPages.add(dbId)
      pageDbIds.push(dbId)
    }
    return { idx, text: claim.text, segmentDbIds, pageDbIds }
  })
}

// ---------------------------------------------------------------------------
// verification prompt + schema
// ---------------------------------------------------------------------------

export const VERIFY_SYSTEM_PROMPT =
  'You are a strict fact checker. For each claim, decide if it is fully supported by ONLY its cited evidence (transcript segments and/or slide pages).\n' +
  'Be strict: any added fact, number, causal link, or generalization not stated in the cited evidence means supported=false.\n' +
  'Transcripts are speech-recognition output: English technical terms may be spelled in Korean phonetics ' +
  '(e.g. 히든 레이어 = hidden layer, 백프로퍼게이션 = backpropagation). ' +
  'Treat these as the same term, not as a mismatch.\n' +
  'Reason in Korean, one sentence per claim.'

export const VERIFY_SCHEMA_NAME = 'claim_verification'

export const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim_index: { type: 'integer' },
          supported: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: ['claim_index', 'supported', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} as const

/**
 * Labels one cited transcript segment for the verification prompt so the
 * checker can tell evidence kinds apart.
 */
export function formatTranscriptEvidence(startMs: number, text: string): string {
  return `[transcript ${formatHms(startMs)}] ${text}`
}

/** Labels one cited slide page for the verification prompt. */
export function formatSlideEvidence(pageNo: number, text: string): string {
  return `[slide p.${pageNo}] ${text}`
}

/** One claim sent to verification, with ONLY its cited evidence lines. */
export interface VerifyItem {
  claimIdx: number
  text: string
  citedTexts: string[]
}

/** Builds the verification chat messages for one batch of claims. */
export function buildVerifyMessages(batch: VerifyItem[]): ChatMessage[] {
  const lines: string[] = []
  for (const item of batch) {
    lines.push(`Claim ${item.claimIdx}: ${item.text}`)
    lines.push('Cited evidence:')
    for (const text of item.citedTexts) {
      lines.push(`- ${text}`)
    }
    lines.push('')
  }
  return [
    { role: 'system', content: VERIFY_SYSTEM_PROMPT },
    { role: 'user', content: lines.join('\n').trimEnd() },
  ]
}

// ---------------------------------------------------------------------------
// verification response mapping
// ---------------------------------------------------------------------------

export interface VerifyResultRaw {
  claimIndex: number
  supported: boolean
  reason: string
}

/** Validates the parsed verification JSON shape. Throws a Korean error when invalid. */
export function validateVerifyPayload(raw: unknown): VerifyResultRaw[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('검증 API 응답 형식이 올바르지 않습니다.')
  }
  const results = (raw as Record<string, unknown>).results
  if (!Array.isArray(results)) {
    throw new Error('검증 API 응답 형식이 올바르지 않습니다.')
  }
  const parsed: VerifyResultRaw[] = []
  for (const item of results) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const obj = item as Record<string, unknown>
    if (typeof obj.claim_index !== 'number' || !Number.isInteger(obj.claim_index)) continue
    if (typeof obj.supported !== 'boolean') continue
    parsed.push({
      claimIndex: obj.claim_index,
      supported: obj.supported,
      reason: typeof obj.reason === 'string' ? obj.reason : '',
    })
  }
  return parsed
}

export interface ResolvedVerdict {
  claimIdx: number
  supported: boolean
  reason: string
}

/**
 * Matches results back to the batch by claim index. Claims the model omitted
 * become unsupported with a fixed Korean reason.
 */
export function applyVerifyResults(
  claimIdxs: number[],
  results: VerifyResultRaw[],
): ResolvedVerdict[] {
  const byIndex = new Map<number, VerifyResultRaw>()
  for (const r of results) {
    if (!byIndex.has(r.claimIndex)) byIndex.set(r.claimIndex, r)
  }
  return claimIdxs.map((claimIdx) => {
    const found = byIndex.get(claimIdx)
    if (!found) {
      return { claimIdx, supported: false, reason: MISSING_RESULT_REASON }
    }
    return { claimIdx, supported: found.supported, reason: found.reason }
  })
}

/** Splits items into batches of at most `size` (verification calls). */
export function splitBatches<T>(items: T[], size: number = VERIFY_BATCH_SIZE): T[][] {
  if (size <= 0) throw new Error('배치 크기는 1 이상이어야 합니다.')
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size))
  }
  return batches
}
