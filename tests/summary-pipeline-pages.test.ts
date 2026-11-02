import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import {
  createNote,
  createSource,
  getLatestSummary,
  insertPages,
  insertSegments,
  listNotePageImages,
  openDb,
  updateSourceStatus,
} from '../src/main/db'
import { SUMMARY_SCHEMA_NAME } from '../src/main/grounding'
import type { ChatOptions, MetaApi } from '../src/main/meta-api'
import { SLIDE_VISUAL_SCHEMA_NAME } from '../src/main/slide-vision'
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

  it('renders and reads real slide images, then verifies against the image itself', async () => {
    const demoPdf = fileURLToPath(new URL('../samples/demo-slides.pdf', import.meta.url))
    const note = createNote(db, '실제 PDF 노트')
    const pdf = createSource(db, {
      noteId: note.id,
      kind: 'pdf',
      originalPath: demoPdf,
      displayName: 'demo-slides.pdf',
    })
    insertPages(
      db,
      pdf.id,
      Array.from({ length: 4 }, (_, i) => ({ pageNo: i + 1, text: `슬라이드 본문 ${i + 1}` })),
    )
    updateSourceStatus(db, pdf.id, 'done')
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const chatCalls: ChatOptions[] = []
    const api: MetaApi = {
      transcribeChunk: async () => {
        throw new Error('사용되지 않음')
      },
      chat: async (opts: ChatOptions) => {
        chatCalls.push(opts)
        const name = opts.responseFormat?.name
        if (name === SLIDE_VISUAL_SCHEMA_NAME) return { visual: '막대그래프가 있습니다' }
        if (name === SUMMARY_SCHEMA_NAME) {
          return { claims: [{ text: '그래프 주장', segment_ids: [], page_ids: [1] }] }
        }
        return { results: [{ claim_index: 0, supported: true, reason: '이미지에서 확인됨' }] }
      },
    }

    const dataDir = path.join(dir, 'data')
    const summary = await runSummaryPipeline({ db, metaApi: api, dataDir }, note.id)

    // 4 vision reads + 1 summary + 1 verify.
    expect(chatCalls).toHaveLength(6)
    // The vision calls carry the rendered page image as a content part.
    const visionUser = chatCalls[0].messages[1].content
    if (!Array.isArray(visionUser)) throw new Error('vision call must be multipart')
    expect(visionUser[0]).toEqual({ type: 'text', text: 'Extracted slide text:\n슬라이드 본문 1' })
    expect(visionUser[1].type).toBe('image_url')

    // The images landed on disk and the descriptions in the DB.
    const pages = listNotePageImages(db, note.id)
    expect(pages.every((p) => p.visualText === '막대그래프가 있습니다')).toBe(true)
    for (const p of pages) {
      expect(p.imagePath).not.toBeNull()
      expect(fs.existsSync(p.imagePath as string)).toBe(true)
    }

    // The summary prompt saw the [figure] lines.
    const summaryUser = chatCalls[4].messages[1].content
    expect(summaryUser).toContain('[P1] (demo-slides.pdf p.1) 슬라이드 본문 1\n[figure] 막대그래프가 있습니다')

    // The verify call attaches the cited page image after the text block.
    const verifyUser = chatCalls[5].messages[1].content
    if (!Array.isArray(verifyUser)) throw new Error('verify call must be multipart')
    expect(verifyUser[0].type).toBe('text')
    expect(verifyUser[1]).toEqual({ type: 'text', text: 'Image of slide p.1:' })
    expect(verifyUser[2].type).toBe('image_url')
    expect(chatCalls[5].messages[0].content).toContain('authoritative evidence')

    expect(summary.claims[0].verdict).toBe('supported')
  })
})
