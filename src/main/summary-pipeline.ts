import type { DatabaseSync } from 'node:sqlite'
import type { AppLanguage, Summary, SummaryProgressEvent } from '../shared/types'
import {
  createSummary,
  getLatestSummary,
  insertClaimsWithCitations,
  listNotePages,
  listNoteSegments,
  setClaimVerdict,
  setSummaryStatus,
  type NewClaim,
} from './db'
import {
  applyVerifyResults,
  buildSummaryMessages,
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
  SUMMARY_SCHEMA,
  SUMMARY_SCHEMA_NAME,
  validateSummaryPayload,
  validateVerifyPayload,
  VERIFY_SCHEMA,
  VERIFY_SCHEMA_NAME,
  zeroCitationReason,
  type VerifyItem,
} from './grounding'
import { langMsg } from './lang'
import type { MetaApi } from './meta-api'

/**
 * Summary pipeline: note segments and slide pages -> cited summary claims ->
 * per-claim verification against ONLY the cited evidence. Unsupported
 * sentences are never shown as fact; they are stored with verdict
 * 'unsupported'.
 */

export interface SummaryPipelineDeps {
  db: DatabaseSync
  metaApi: MetaApi
  model?: string
  language?: AppLanguage
  onProgress?: (event: SummaryProgressEvent) => void
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function runSummaryPipeline(
  deps: SummaryPipelineDeps,
  noteId: number,
): Promise<Summary> {
  const { db, metaApi, onProgress } = deps
  const model = deps.model ?? DEFAULT_SUMMARY_MODEL
  const language: AppLanguage = deps.language ?? 'ko'

  const segments = listNoteSegments(db, noteId)
  const pages = listNotePages(db, noteId)
  if (segments.length === 0 && pages.length === 0) {
    throw new Error(langMsg(language, '요약할 자료가 없습니다', 'No evidence to summarize'))
  }

  const summary = createSummary(db, noteId, model, 'auto', language)
  const report = (stage: SummaryProgressEvent['stage'], message?: string): void => {
    onProgress?.({ noteId, summaryId: summary.id, stage, message })
  }

  try {
    // 1. Summarize with citations.
    report('summarizing')
    const numbered = numberSegments(segments)
    const numberedPages = numberPages(pages)
    const byNumber = idByNumberMap(numbered)
    const pageByNumber = pageIdByNumberMap(numberedPages)
    const summaryRaw = await metaApi.chat({
      model,
      messages: buildSummaryMessages(numbered, numberedPages, language),
      responseFormat: { name: SUMMARY_SCHEMA_NAME, schema: SUMMARY_SCHEMA },
    })
    const mapped = mapSummaryClaims(validateSummaryPayload(summaryRaw), byNumber, pageByNumber)

    // Zero-citation claims are stored as unsupported and skip verification.
    const toInsert: NewClaim[] = mapped.map((c) => ({
      idx: c.idx,
      text: c.text,
      verdict:
        c.segmentDbIds.length === 0 && c.pageDbIds.length === 0
          ? 'unsupported'
          : ('pending' as const),
      reason:
        c.segmentDbIds.length === 0 && c.pageDbIds.length === 0 ? zeroCitationReason(language) : null,
      segmentIds: c.segmentDbIds,
      pageIds: c.pageDbIds,
    }))
    const claimIds = insertClaimsWithCitations(db, summary.id, toInsert)
    const claimIdByIdx = new Map(mapped.map((c, i) => [c.idx, claimIds[i]]))
    const segmentByDbId = new Map(segments.map((s) => [s.id, s]))
    const pageByDbId = new Map(pages.map((p) => [p.id, p]))

    // 2. Verify each cited claim against ONLY its cited evidence, in batches.
    report('verifying')
    const verifiable = mapped.filter((c) => c.segmentDbIds.length + c.pageDbIds.length > 0)
    for (const batch of splitBatches(verifiable)) {
      const items: VerifyItem[] = batch.map((c) => ({
        claimIdx: c.idx,
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
    report('done')

    const done = getLatestSummary(db, noteId)
    if (!done) throw new Error('요약 결과를 찾을 수 없습니다.')
    return done
  } catch (err) {
    const message = errorMessage(err)
    setSummaryStatus(db, summary.id, 'error', message)
    report('error', message)
    throw err
  }
}
