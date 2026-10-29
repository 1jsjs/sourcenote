import type { DatabaseSync } from 'node:sqlite'
import type { AppLanguage, Summary, SummaryProgressEvent } from '../shared/types'
import { createSummary, getLatestSummary, listNotePages, listNoteSegments, setSummaryStatus } from './db'
import {
  buildSummaryMessages,
  DEFAULT_SUMMARY_MODEL,
  idByNumberMap,
  mapSummaryClaims,
  numberPages,
  numberSegments,
  pageIdByNumberMap,
  SUMMARY_SCHEMA,
  SUMMARY_SCHEMA_NAME,
  validateSummaryPayload,
  zeroCitationReason,
} from './grounding'
import { langMsg } from './lang'
import type { MetaApi } from './meta-api'
import { storeAndVerifyClaims } from './verify-claims'

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

    // 2. Store, then verify each cited claim against ONLY its cited evidence.
    await storeAndVerifyClaims({
      db,
      metaApi,
      model,
      language,
      summaryId: summary.id,
      claims: mapped,
      segments,
      pages,
      zeroCitationReason: zeroCitationReason(language),
      onVerifying: () => report('verifying'),
    })

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
