import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createNote,
  createSource,
  insertSegments,
  openDb,
  updateSourceStatus,
} from '../src/main/db'
import {
  applyVerifyResults,
  buildSummaryMessages,
  buildVerifyMessages,
  missingResultReason,
  numberSegments,
  SUMMARY_SYSTEM_PROMPT,
  summarySystemPrompt,
  VERIFY_SYSTEM_PROMPT,
  verifySystemPrompt,
  zeroCitationReason,
} from '../src/main/grounding'
import {
  buildCheckLocateMessages,
  CHECK_LOCATE_SYSTEM_PROMPT,
  checkLocateSystemPrompt,
  checkZeroCitationReason,
  runCheckPipeline,
  splitUserSentences,
} from '../src/main/check-pipeline'
import {
  buildCorrectionMessages,
  CORRECTION_SYSTEM_PROMPT,
  correctionSystemPrompt,
} from '../src/main/correction'
import type { ChatOptions, MetaApi } from '../src/main/meta-api'
import { runSummaryPipeline } from '../src/main/summary-pipeline'

describe('AI output language', () => {
  it('keeps the Korean prompts as defaults', () => {
    expect(summarySystemPrompt('ko')).toBe(SUMMARY_SYSTEM_PROMPT)
    expect(verifySystemPrompt('ko')).toBe(VERIFY_SYSTEM_PROMPT)
    expect(checkLocateSystemPrompt('ko')).toBe(CHECK_LOCATE_SYSTEM_PROMPT)
    expect(correctionSystemPrompt('ko')).toBe(CORRECTION_SYSTEM_PROMPT)
    expect(buildSummaryMessages([], [])[0].content).toBe(SUMMARY_SYSTEM_PROMPT)
    expect(buildVerifyMessages([])[0].content).toBe(VERIFY_SYSTEM_PROMPT)
    expect(buildCheckLocateMessages([], [])[0].content).toBe(CHECK_LOCATE_SYSTEM_PROMPT)
    expect(buildCorrectionMessages([], [])[0].content).toBe(CORRECTION_SYSTEM_PROMPT)
  })

  it('writes English prompts that name the output language', () => {
    const summary = summarySystemPrompt('en')
    expect(summary).toContain('Write the claims in English')
    expect(summary).toContain('Reply in English')
    const verify = verifySystemPrompt('en')
    expect(verify).toContain('Reason in English, one sentence')
    const locate = checkLocateSystemPrompt('en')
    expect(locate).toContain('do NOT rewrite the sentences')
    expect(locate).toContain('Reply in English')
    const correction = correctionSystemPrompt('en')
    expect(correction).toContain('Write the reason in English')
    // The Korean-specific rule survives, phrased generically.
    expect(correction).toContain('러닝 레이트 -> learning rate')
  })

  it('selects fixed stored reasons by language', () => {
    expect(zeroCitationReason('ko')).toBe('인용한 구간이 자료에 없습니다')
    expect(zeroCitationReason('en')).toBe('The cited evidence is not in the sources')
    expect(missingResultReason('ko')).toBe('검증 결과를 받지 못했습니다')
    expect(missingResultReason('en')).toBe('No verification result was returned')
    expect(checkZeroCitationReason('ko')).toBe('강의 자료에서 근거를 찾지 못했습니다')
    expect(checkZeroCitationReason('en')).toBe(
      'No supporting evidence found in the lecture materials',
    )
    expect(applyVerifyResults([0], [], 'en')).toEqual([
      { claimIdx: 0, supported: false, reason: 'No verification result was returned' },
    ])
  })

  it('reports check input errors in the current language', () => {
    expect(() => splitUserSentences('   \n  ', 'en')).toThrow('No sentences to check')
    expect(() => splitUserSentences(Array.from({ length: 31 }, () => 's.').join(' '), 'en')).toThrow(
      'up to 30',
    )
    expect(() => splitUserSentences('   \n  ')).toThrow('검증할 문장')
  })
})

describe('pipelines store the output language', () => {
  let dir: string
  let db: DatabaseSync

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-lang-'))
    db = openDb(path.join(dir, 'test.sqlite'))
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function seedNote(): number {
    const note = createNote(db, 'note')
    const source = createSource(db, {
      noteId: note.id,
      kind: 'audio',
      originalPath: '/tmp/lecture.wav',
      displayName: 'lecture.wav',
    })
    insertSegments(db, source.id, [
      { idx: 0, startMs: 0, endMs: 1000, text: 'content', chunkIndex: 0 },
    ])
    updateSourceStatus(db, source.id, 'done')
    return note.id
  }

  function fakeChat(responder: (callIndex: number, opts: ChatOptions) => unknown): {
    api: MetaApi
    chatCalls: ChatOptions[]
  } {
    const chatCalls: ChatOptions[] = []
    const api: MetaApi = {
      transcribeChunk: async () => {
        throw new Error('no transcribe in this test')
      },
      chat: async (opts: ChatOptions) => {
        const callIndex = chatCalls.length
        chatCalls.push(opts)
        return responder(callIndex, opts)
      },
    }
    return { api, chatCalls }
  }

  it('summary pipeline writes English prompts, reasons and the stored language', async () => {
    const noteId = seedNote()
    const { api, chatCalls } = fakeChat((callIndex) =>
      callIndex === 0
        ? { claims: [{ text: 'A claim.', segment_ids: [] }] }
        : { results: [] },
    )
    const summary = await runSummaryPipeline({ db, metaApi: api, language: 'en' }, noteId)
    expect(summary.language).toBe('en')
    expect(chatCalls[0].messages[0].content).toContain('Write the claims in English')
    expect(summary.claims[0].reason).toBe('The cited evidence is not in the sources')
  })

  it('check pipeline writes English reasons and stores the language', async () => {
    const noteId = seedNote()
    const { api, chatCalls } = fakeChat(() => ({ items: [] }))
    const summary = await runCheckPipeline({ db, metaApi: api, language: 'en' }, noteId, 'My sentence.')
    expect(summary.language).toBe('en')
    expect(chatCalls[0].messages[0].content).toContain('Reply in English')
    expect(summary.claims[0].text).toBe('My sentence.')
    expect(summary.claims[0].reason).toBe('No supporting evidence found in the lecture materials')
  })

  it('numbered-segment builders still work for the language tests', () => {
    expect(numberSegments([])).toEqual([])
  })
})
