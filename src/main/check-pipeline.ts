import type { DatabaseSync } from 'node:sqlite'
import type { AppLanguage, Summary } from '../shared/types'
import {
  createSummary,
  getLatestCheck,
  insertClaimsWithCitations,
  listNotePages,
  listNoteSegments,
  setClaimVerdict,
  setSummaryStatus,
  type NewClaim,
} from './db'
import { langMsg } from './lang'
import {
  applyVerifyResults,
  buildVerifyMessages,
  DEFAULT_SUMMARY_MODEL,
  formatSlideEvidence,
  formatTranscriptEvidence,
  idByNumberMap,
  mapSummaryClaims,
  numberPages,
  numberSegments,
  pageIdByNumberMap,
  splitBatches,
  stripClaimCitationMarkers,
  VERIFY_SCHEMA,
  VERIFY_SCHEMA_NAME,
  validateVerifyPayload,
  type VerifyItem,
} from './grounding'
import type { ChatMessage, MetaApi } from './meta-api'

/**
 * "Check my notes" pipeline (stage 4b): the student pastes their own notes
 * and the agent checks each sentence against the lecture evidence.
 * Step 1 locates the most relevant segments/pages per sentence; step 2
 * reuses the existing verification batches/prompt unchanged. Results are
 * stored as a `kind='check'` summary whose claims are the user's sentences.
 */

/** Maximum user sentences checked in one run. */
export const MAX_CHECK_SENTENCES = 30

/** Reason stored when no evidence cites a user sentence (Korean; use the getter). */
export const CHECK_ZERO_CITATION_REASON = '강의 자료에서 근거를 찾지 못했습니다'

/** Fixed reason stored when no evidence cites a user sentence, in the check language. */
export function checkZeroCitationReason(language: AppLanguage): string {
  return langMsg(language, CHECK_ZERO_CITATION_REASON, 'No supporting evidence found in the lecture materials')
}

export const CHECK_LOCATE_SYSTEM_PROMPT =
  'You are a lecture evidence finder. For each user sentence below, return the numbers ' +
  'of the transcript segments ([n]) and/or slide pages ([Pk]) that are most relevant ' +
  'to checking it. A sentence may have no relevant evidence: return empty arrays then. ' +
  'Keep the sentence index and exact text as given: do NOT rewrite the sentences. ' +
  'Do not write segment or slide numbers like [3] or [P2] inside any text. ' +
  'Reply in Korean.'

/** Locate system prompt in the requested output language. */
export function checkLocateSystemPrompt(language: AppLanguage): string {
  if (language === 'en') {
    return (
      'You are a lecture evidence finder. For each user sentence below, return the numbers ' +
      'of the transcript segments ([n]) and/or slide pages ([Pk]) that are most relevant ' +
      'to checking it. A sentence may have no relevant evidence: return empty arrays then. ' +
      'Keep the sentence index and exact text as given: do NOT rewrite the sentences. ' +
      'Do not write segment or slide numbers like [3] or [P2] inside any text. ' +
      'Reply in English.'
    )
  }
  return CHECK_LOCATE_SYSTEM_PROMPT
}

export const CHECK_LOCATE_SCHEMA_NAME = 'check_evidence_locate'

export const CHECK_LOCATE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sentence_index: { type: 'integer' },
          segment_ids: { type: 'array', items: { type: 'integer' } },
          page_ids: { type: 'array', items: { type: 'integer' } },
        },
        required: ['sentence_index', 'segment_ids', 'page_ids'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
} as const

/**
 * Splits user notes into sentences: split on newlines and on sentence-ending
 * `.`, `?`, `!` (which covers the Korean `다.` ending) boundaries; trim;
 * drop empties. Throws a Korean error when there is nothing or more than 30.
 * Pure and unit-tested.
 */
export function splitUserSentences(text: string, language: AppLanguage = 'ko'): string[] {
  const sentences: string[] = []
  for (const line of text.split('\n')) {
    // A '.' between digits (3.14, 0.5) is a decimal point, not a sentence end.
    const matches = line.match(/(?:\d\.\d|[^.?!])+(?:[.?!]+|$)/g)
    if (!matches) continue
    for (const m of matches) {
      const trimmed = m.trim()
      if (trimmed.length > 0) sentences.push(trimmed)
    }
  }
  if (sentences.length === 0) {
    throw new Error(langMsg(language, '검증할 문장이 없습니다.', 'No sentences to check'))
  }
  if (sentences.length > MAX_CHECK_SENTENCES) {
    throw new Error(
      langMsg(
        language,
        `한 번에 최대 ${MAX_CHECK_SENTENCES}문장까지 검증할 수 있습니다.`,
        `You can check up to ${MAX_CHECK_SENTENCES} sentences at a time.`,
      ),
    )
  }
  return sentences
}

/** One numbered user sentence as shown to the model. */
export function formatCheckSentenceLine(i: number, text: string): string {
  return `Sentence ${i}: ${text}`
}

/** Builds the locate chat messages from user sentences + evidence. */
export function buildCheckLocateMessages(
  sentences: string[],
  transcriptLines: string[],
  slideLines: string[] = [],
  language: AppLanguage = 'ko',
): ChatMessage[] {
  const parts = sentences.map((s, i) => formatCheckSentenceLine(i, s))
  parts.push('Transcript:')
  parts.push(...transcriptLines)
  if (slideLines.length > 0) {
    parts.push('Slides:')
    parts.push(...slideLines)
  }
  return [{ role: 'system', content: checkLocateSystemPrompt(language) }, { role: 'user', content: parts.join('\n') }]
}

export interface CheckLocateRaw {
  sentenceIndex: unknown
  segmentIds: unknown
  pageIds: unknown
}

/** Validates the parsed locate JSON shape. Throws a Korean error when invalid. */
export function validateCheckLocatePayload(raw: unknown): CheckLocateRaw[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('검증 API 응답 형식이 올바르지 않습니다.')
  }
  const items = (raw as Record<string, unknown>).items
  if (!Array.isArray(items)) {
    throw new Error('검증 API 응답 형식이 올바르지 않습니다.')
  }
  return items.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('검증 API 응답 형식이 올바르지 않습니다.')
    }
    const obj = item as Record<string, unknown>
    if (typeof obj.sentence_index !== 'number' || !Number.isInteger(obj.sentence_index)) {
      throw new Error('검증 API 응답 형식이 올바르지 않습니다.')
    }
    return {
      sentenceIndex: obj.sentence_index,
      segmentIds: Array.isArray(obj.segment_ids) ? obj.segment_ids : [],
      pageIds: Array.isArray(obj.page_ids) ? obj.page_ids : [],
    }
  })
}

export interface MappedCheckSentence {
  sentenceIdx: number
  text: string
  segmentDbIds: number[]
  pageDbIds: number[]
}

/**
 * Matches locate results back to the user's sentences by index: the claim
 * text is ALWAYS the user's exact sentence (stripped of embedded markers),
 * citations map exactly like the summary (invalid dropped). Sentences the
 * model omitted keep empty citations (unsupported). Pure and unit-tested.
 */
export function mapCheckLocate(
  sentences: string[],
  items: CheckLocateRaw[],
  idByNumber: Map<number, number>,
  pageIdByNumber: Map<number, number> = new Map(),
): MappedCheckSentence[] {
  const byIndex = new Map<number, CheckLocateRaw>()
  for (const item of items) {
    if (typeof item.sentenceIndex !== 'number') continue
    if (!byIndex.has(item.sentenceIndex)) byIndex.set(item.sentenceIndex, item)
  }
  return sentences.map((sentence, sentenceIdx) => {
    const found = byIndex.get(sentenceIdx)
    const raw = {
      text: sentence,
      segmentIds: (found?.segmentIds ?? []) as unknown[],
      pageIds: (found?.pageIds ?? []) as unknown[],
    }
    const [mapped] = mapSummaryClaims([raw], idByNumber, pageIdByNumber)
    return {
      sentenceIdx,
      text: stripClaimCitationMarkers(sentence),
      segmentDbIds: mapped?.segmentDbIds ?? [],
      pageDbIds: mapped?.pageDbIds ?? [],
    }
  })
}

export interface CheckPipelineDeps {
  db: DatabaseSync
  metaApi: MetaApi
  model?: string
  language?: AppLanguage
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function runCheckPipeline(
  deps: CheckPipelineDeps,
  noteId: number,
  notesText: string,
): Promise<Summary> {
  const { db, metaApi } = deps
  const model = deps.model ?? DEFAULT_SUMMARY_MODEL
  const language: AppLanguage = deps.language ?? 'ko'

  const sentences = splitUserSentences(notesText, language)
  const segments = listNoteSegments(db, noteId)
  const pages = listNotePages(db, noteId)
  if (segments.length === 0 && pages.length === 0) {
    throw new Error(langMsg(language, '검증할 강의 자료가 없습니다', 'No lecture evidence to check against'))
  }

  const summary = createSummary(db, noteId, model, 'check', language)
  try {
    // 1. Locate the most relevant evidence per user sentence.
    const numbered = numberSegments(segments)
    const numberedPages = numberPages(pages)
    const locateRaw = await metaApi.chat({
      model,
      messages: buildCheckLocateMessages(
        sentences,
        numbered.map((s) => s.line),
        numberedPages.map((p) => p.line),
        language,
      ),
      responseFormat: { name: CHECK_LOCATE_SCHEMA_NAME, schema: CHECK_LOCATE_SCHEMA },
    })
    const mapped = mapCheckLocate(
      sentences,
      validateCheckLocatePayload(locateRaw),
      idByNumberMap(numbered),
      pageIdByNumberMap(numberedPages),
    )

    // Zero-citation sentences are stored as unsupported and skip verification.
    const toInsert: NewClaim[] = mapped.map((c) => ({
      idx: c.sentenceIdx,
      text: c.text,
      verdict:
        c.segmentDbIds.length === 0 && c.pageDbIds.length === 0
          ? 'unsupported'
          : ('pending' as const),
      reason:
        c.segmentDbIds.length === 0 && c.pageDbIds.length === 0
          ? checkZeroCitationReason(language)
          : null,
      segmentIds: c.segmentDbIds,
      pageIds: c.pageDbIds,
    }))
    const claimIds = insertClaimsWithCitations(db, summary.id, toInsert)
    const claimIdByIdx = new Map(mapped.map((c, i) => [c.sentenceIdx, claimIds[i]]))
    const segmentByDbId = new Map(segments.map((s) => [s.id, s]))
    const pageByDbId = new Map(pages.map((p) => [p.id, p]))

    // 2. Verify each cited sentence against ONLY its cited evidence, in batches.
    const verifiable = mapped.filter((c) => c.segmentDbIds.length + c.pageDbIds.length > 0)
    for (const batch of splitBatches(verifiable)) {
      const items: VerifyItem[] = batch.map((c) => ({
        claimIdx: c.sentenceIdx,
        text: c.text,
        citedTexts: [
          ...c.segmentDbIds.map((id) => {
            const s = segmentByDbId.get(id)
            return formatTranscriptEvidence(s?.startMs ?? 0, s?.text ?? '')
          }),
          ...c.pageDbIds.map((id) => {
            const p = pageByDbId.get(id)
            return formatSlideEvidence(p?.pageNo ?? 0, p?.text ?? '')
          }),
        ],
      }))
      const verifyRaw = await metaApi.chat({
        model,
        messages: buildVerifyMessages(items, language),
        responseFormat: { name: VERIFY_SCHEMA_NAME, schema: VERIFY_SCHEMA },
      })
      const resolved = applyVerifyResults(
        items.map((item) => item.claimIdx),
        validateVerifyPayload(verifyRaw),
        language,
      )
      for (const r of resolved) {
        const claimId = claimIdByIdx.get(r.claimIdx)
        if (claimId === undefined) continue
        setClaimVerdict(db, claimId, r.supported ? 'supported' : 'unsupported', r.reason)
      }
    }

    setSummaryStatus(db, summary.id, 'done')
    const done = getLatestCheck(db, noteId)
    if (!done) throw new Error('검증 결과를 찾을 수 없습니다.')
    return done
  } catch (err) {
    const message = errorMessage(err)
    setSummaryStatus(db, summary.id, 'error', message)
    throw err
  }
}
