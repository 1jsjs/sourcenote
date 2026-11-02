import type { DatabaseSync } from 'node:sqlite'
import type { AppLanguage, Summary, SummaryProgressEvent } from '../shared/types'
import { isNoteLanguage, resolveOutputLanguage } from '../shared/languages'
import {
  createSummary,
  getLatestSummary,
  getNote,
  listNotePages,
  listNoteSegments,
  setSummaryStatus,
} from './db'
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
import { ensurePageImages, readSlideVisuals } from './slide-vision'
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
  /** UI language for app-side fixed messages and errors. */
  language?: AppLanguage
  /** AI output language name; defaults to the note's note_language resolved. */
  outputLanguage?: string
  /** Data dir holding page-images/; defaults to the app data dir. */
  dataDir?: string
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
  const note = getNote(db, noteId)
  const outputLanguage =
    deps.outputLanguage ??
    resolveOutputLanguage(
      note && isNoteLanguage(note.note_language) ? note.note_language : 'app',
      language,
    )

  const segments = listNoteSegments(db, noteId)
  let pages = listNotePages(db, noteId)
  if (segments.length === 0 && pages.length === 0) {
    throw new Error(langMsg(language, '요약할 자료가 없습니다', 'No evidence to summarize'))
  }

  const summary = createSummary(db, noteId, model, 'auto', outputLanguage)
  const report = (stage: SummaryProgressEvent['stage'], message?: string): void => {
    onProgress?.({ noteId, summaryId: summary.id, stage, message })
  }

  try {
    // 1. Summarize with citations.
    report('summarizing')
    // Look at the slides first: render the page images locally, then read
    // them once with vision so figure/table content joins the text evidence.
    await ensurePageImages(db, noteId, deps.dataDir)
    await readSlideVisuals({ db, metaApi, model, outputLanguage, noteId })
    pages = listNotePages(db, noteId)
    const numbered = numberSegments(segments)
    const numberedPages = numberPages(pages)
    const byNumber = idByNumberMap(numbered)
    const pageByNumber = pageIdByNumberMap(numberedPages)
    const summaryRaw = await metaApi.chat({
      model,
      messages: buildSummaryMessages(numbered, numberedPages, outputLanguage),
      responseFormat: { name: SUMMARY_SCHEMA_NAME, schema: SUMMARY_SCHEMA },
    })
    const mapped = mapSummaryClaims(validateSummaryPayload(summaryRaw), byNumber, pageByNumber)

    // 2. Store, then verify each cited claim against ONLY its cited evidence.
    await storeAndVerifyClaims({
      db,
      metaApi,
      model,
      outputLanguage,
      summaryId: summary.id,
      claims: mapped,
      segments,
      pages,
      zeroCitationReason: zeroCitationReason(outputLanguage),
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
