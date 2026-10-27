import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import {
  createNote,
  createSource,
  getLatestSummary,
  insertPages,
  insertSegments,
  openDb,
  updateSourceStatus,
} from '../src/main/db'
import type { ChatOptions, MetaApi } from '../src/main/meta-api'
import { runSummaryPipeline } from '../src/main/summary-pipeline'

/** Seeds a note with one done audio source (2 segments) and one done pdf (2 pages). */
function seedNoteWithBoth(db: DatabaseSync): number {
  const note = createNote(db, '강의 노트')
  const audio = createSource(db, {
    noteId: note.id,
    kind: 'audio',
    originalPath: '/tmp/lecture.wav',
    displayName: 'lecture.wav',
  })
  insertSegments(db, audio.id, [
    { idx: 0, startMs: 0, endMs: 1000, text: '구간 내용 0', chunkIndex: 0 },
    { idx: 1, startMs: 1000, endMs: 2000, text: '구간 내용 1', chunkIndex: 0 },
  ])
  updateSourceStatus(db, audio.id, 'done')
  const pdf = createSource(db, {
    noteId: note.id,
    kind: 'pdf',
    originalPath: '/tmp/slides.pdf',
    displayName: 'slides.pdf',
  })
  insertPages(db, pdf.id, [
    { pageNo: 1, text: '슬라이드 내용 1' },
    { pageNo: 2, text: '슬라이드 내용 2' },
  ])
  updateSourceStatus(db, pdf.id, 'done')
  return note.id
}

function fakeApi(
  summaryPayload: unknown,
  verifyPayload: unknown,
  chatCalls: ChatOptions[],
): MetaApi {
  return {
    transcribeChunk: async () => {
      throw new Error('사용되지 않음')
    },
    chat: async (opts: ChatOptions) => {
      chatCalls.push(opts)
      return chatCalls.length === 1 ? summaryPayload : verifyPayload
    },
  }
}

describe('runSummaryPipeline with slide pages', () => {
  let dir: string
  let db: DatabaseSync

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-sumpages-'))
    db = openDb(path.join(dir, 'test.sqlite'))
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('summarizes a note with both segments and pages, citing each kind', async () => {
    const noteId = seedNoteWithBoth(db)
    const chatCalls: ChatOptions[] = []
    const api = fakeApi(
      {
        claims: [
          { text: '말씀 주장', segment_ids: [1], page_ids: [] },
          { text: '슬라이드 주장', segment_ids: [], page_ids: [2] },
          { text: '근거 없음', segment_ids: [99], page_ids: [99] },
        ],
      },
      {
        results: [
          { claim_index: 0, supported: true, reason: '전사에 명시됨' },
          { claim_index: 1, supported: true, reason: '슬라이드에 명시됨' },
        ],
      },
      chatCalls,
    )

    const summary = await runSummaryPipeline({ db, metaApi: api }, noteId)

    // The summary prompt shows both the transcript and the Slides section.
    const summaryUser = chatCalls[0].messages[1].content
    expect(summaryUser).toContain('[1] (00:00:00–00:00:01) 구간 내용 0')
    expect(summaryUser).toContain('Slides:')
    expect(summaryUser).toContain('[P1] (slides.pdf p.1) 슬라이드 내용 1')
    // The verify call sees labelled evidence of each kind, only the cited lines.
    const verifyUser = chatCalls[1].messages[1].content
    expect(verifyUser).toContain('[transcript 00:00:00] 구간 내용 0')
    expect(verifyUser).toContain('[slide p.2] 슬라이드 내용 2')
    expect(verifyUser).not.toContain('구간 내용 1')
    expect(verifyUser).not.toContain('슬라이드 내용 1')

    expect(summary.claims).toHaveLength(3)
    expect(summary.claims[0]).toMatchObject({ verdict: 'supported' })
    expect(summary.claims[0].citations).toHaveLength(1)
    expect(summary.claims[0].pageCitations).toEqual([])
    expect(summary.claims[1]).toMatchObject({ verdict: 'supported' })
    expect(summary.claims[1].citations).toEqual([])
    expect(summary.claims[1].pageCitations).toHaveLength(1)
    expect(summary.claims[1].pageCitations[0]).toMatchObject({ pageNo: 2, text: '슬라이드 내용 2' })
    expect(summary.claims[2].verdict).toBe('unsupported')
    expect(summary.claims[2].reason).toBe('인용한 구간이 자료에 없습니다')
  })

  it('works for a PDF-only note with no audio at all', async () => {
    const note = createNote(db, '슬라이드 노트')
    const pdf = createSource(db, {
      noteId: note.id,
      kind: 'pdf',
      originalPath: '/tmp/only.pdf',
      displayName: 'only.pdf',
    })
    insertPages(db, pdf.id, [{ pageNo: 1, text: '유일한 근거' }])
    updateSourceStatus(db, pdf.id, 'done')

    const chatCalls: ChatOptions[] = []
    const api = fakeApi(
      { claims: [{ text: '슬라이드 주장', segment_ids: [], page_ids: [1] }] },
      { results: [{ claim_index: 0, supported: true, reason: '확인됨' }] },
      chatCalls,
    )

    const summary = await runSummaryPipeline({ db, metaApi: api }, note.id)
    expect(summary.claims).toHaveLength(1)
    expect(summary.claims[0].verdict).toBe('supported')
    expect(summary.claims[0].pageCitations[0].text).toBe('유일한 근거')
    expect(getLatestSummary(db, note.id)?.claims[0].pageCitations).toHaveLength(1)
  })
})
