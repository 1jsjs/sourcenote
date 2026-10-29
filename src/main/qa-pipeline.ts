import type { DatabaseSync } from 'node:sqlite'
import type { AppLanguage, Summary } from '../shared/types'
import { createSummary, listNotePages, listNoteSegments, listQuestionAnswers, setSummaryStatus } from './db'
import {
  DEFAULT_SUMMARY_MODEL,
  idByNumberMap,
  mapSummaryClaims,
  numberPages,
  numberSegments,
  pageIdByNumberMap,
  SUMMARY_SCHEMA,
  validateSummaryPayload,
  zeroCitationReason,
  type NumberedPage,
  type NumberedSegment,
} from './grounding'
import { langMsg } from './lang'
import type { ChatMessage, MetaApi } from './meta-api'
import { storeAndVerifyClaims } from './verify-claims'

/**
 * "Ask the lecture" pipeline: answer one question from the note's
 * transcript and slides only. The answer is a short list of cited claims
 * (same shape as the summary), then each claim is verified against ONLY its
 * cited evidence. When the materials do not cover the question the model
 * returns no claims, and the UI says so instead of guessing.
 * Stored as a kind='qa' summary carrying the question.
 */

export const MAX_QUESTION_CHARS = 500

export const QA_SCHEMA_NAME = 'lecture_answer'

/** System prompt for answering in the requested language. */
export function qaSystemPrompt(language: AppLanguage): string {
  const lang = language === 'en' ? 'English' : 'Korean'
  return (
    `You answer a student's question about one lecture in ${lang}, using ONLY the ` +
    'transcript segments ([n]) and slide pages ([Pk]) below.\n' +
    'Answer in 1–5 short claims, the direct answer first.\n' +
    'Every claim MUST cite 1–5 transcript segments and/or slide pages that directly support it.\n' +
    'If the transcript and slides do not answer the question, return an empty claims list. ' +
    'Do not guess and do not use outside knowledge.\n' +
    'Do not write segment or slide numbers like [3] or [P2] inside the claim text.\n' +
    `Reply in ${lang}.`
  )
}

/** Trims the question; throws a localized error when it is empty or too long. */
export function normalizeQuestion(raw: unknown, language: AppLanguage = 'ko'): string {
  const question = typeof raw === 'string' ? raw.trim() : ''
  if (question.length === 0) {
    throw new Error(langMsg(language, '질문을 입력해 주세요.', 'Enter a question.'))
  }
  if (question.length > MAX_QUESTION_CHARS) {
    throw new Error(
      langMsg(
        language,
        `질문은 ${MAX_QUESTION_CHARS}자까지 쓸 수 있습니다.`,
        `Questions can be up to ${MAX_QUESTION_CHARS} characters.`,
      ),
    )
  }
  return question
}

export function buildQaMessages(
  question: string,
  numbered: NumberedSegment[],
  numberedPages: NumberedPage[] = [],
  language: AppLanguage = 'ko',
): ChatMessage[] {
  const parts = [`Question: ${question}`, 'Transcript:', ...numbered.map((s) => s.line)]
  if (numberedPages.length > 0) {
    parts.push('Slides:')
    for (const p of numberedPages) parts.push(p.line)
  }
  return [
    { role: 'system', content: qaSystemPrompt(language) },
    { role: 'user', content: parts.join('\n') },
  ]
}

export interface QaPipelineDeps {
  db: DatabaseSync
  metaApi: MetaApi
  model?: string
  language?: AppLanguage
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function runQaPipeline(
  deps: QaPipelineDeps,
  noteId: number,
  rawQuestion: unknown,
): Promise<Summary> {
  const { db, metaApi } = deps
  const model = deps.model ?? DEFAULT_SUMMARY_MODEL
  const language: AppLanguage = deps.language ?? 'ko'
  const question = normalizeQuestion(rawQuestion, language)

  const segments = listNoteSegments(db, noteId)
  const pages = listNotePages(db, noteId)
  if (segments.length === 0 && pages.length === 0) {
    throw new Error(
      langMsg(language, '질문에 답할 강의 자료가 없습니다', 'No lecture materials to answer from'),
    )
  }

  const summary = createSummary(db, noteId, model, 'qa', language, question)
  try {
    // 1. Answer with citations, from the materials only.
    const numbered = numberSegments(segments)
    const numberedPages = numberPages(pages)
    const answerRaw = await metaApi.chat({
      model,
      messages: buildQaMessages(question, numbered, numberedPages, language),
      responseFormat: { name: QA_SCHEMA_NAME, schema: SUMMARY_SCHEMA },
    })
    const mapped = mapSummaryClaims(
      validateSummaryPayload(answerRaw),
      idByNumberMap(numbered),
      pageIdByNumberMap(numberedPages),
    )

    // 2. Store, then verify each answer claim against ONLY its cited evidence.
    setSummaryStatus(db, summary.id, 'verifying')
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
    })

    setSummaryStatus(db, summary.id, 'done')
    const done = listQuestionAnswers(db, noteId).find((s) => s.id === summary.id)
    if (!done) throw new Error('답변 결과를 찾을 수 없습니다.')
    return done
  } catch (err) {
    setSummaryStatus(db, summary.id, 'error', errorMessage(err))
    throw err
  }
}
