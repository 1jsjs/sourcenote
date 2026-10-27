import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import {
  CHECK_LOCATE_SCHEMA,
  CHECK_LOCATE_SCHEMA_NAME,
  CHECK_ZERO_CITATION_REASON,
  MAX_CHECK_SENTENCES,
  buildCheckLocateMessages,
  mapCheckLocate,
  runCheckPipeline,
  splitUserSentences,
  validateCheckLocatePayload,
} from '../src/main/check-pipeline'
import {
  createNote,
  createSource,
  createSummary,
  getLatestCheck,
  getLatestSummary,
  insertSegments,
  openDb,
  updateSourceStatus,
} from '../src/main/db'
import type { ChatOptions, MetaApi } from '../src/main/meta-api'

function fakeMetaApi(responder: (callIndex: number, opts: ChatOptions) => unknown): { api: MetaApi; calls: ChatOptions[] } {
  const calls: ChatOptions[] = []
  const api: MetaApi = {
    transcribeChunk: async () => {
      throw new Error('사용되지 않음')
    },
    chat: async (opts: ChatOptions) => {
      const callIndex = calls.length
      calls.push(opts)
      return responder(callIndex, opts)
    },
  }
  return { api, calls }
}

function seedNote(db: DatabaseSync, texts: string[]): number {
  const note = createNote(db, '강의 노트')
  const source = createSource(db, {
    noteId: note.id,
    kind: 'audio',
    originalPath: '/tmp/lecture.wav',
    displayName: 'lecture.wav',
  })
  insertSegments(
    db,
    source.id,
    texts.map((text, i) => ({ idx: i, startMs: i * 1000, endMs: (i + 1) * 1000, text, chunkIndex: 0 })),
  )
  updateSourceStatus(db, source.id, 'done')
  return note.id
}

describe('splitUserSentences', () => {
  it('does not split on decimal points', () => {
    expect(splitUserSentences('학습률은 0.001로 둔다. 너무 크면 발산한다!')).toEqual([
      '학습률은 0.001로 둔다.',
      '너무 크면 발산한다!',
    ])
  })

  it('splits on newlines and . ? ! boundaries', () => {
    expect(splitUserSentences('첫 문장입니다.\n두 번째 문장? 세 번째!')).toEqual([
      '첫 문장입니다.',
      '두 번째 문장?',
      '세 번째!',
    ])
  })

  it('splits on the Korean 다. ending, trims, and drops empties', () => {
    expect(splitUserSentences('  경사하강법을 배웠다. 다음 시간에 본다.\n\n')).toEqual([
      '경사하강법을 배웠다.',
      '다음 시간에 본다.',
    ])
  })

  it('throws a Korean error when empty', () => {
    expect(() => splitUserSentences('   \n  ')).toThrow('검증할 문장')
  })

  it('throws a Korean error past the 30-sentence cap', () => {
    const text = Array.from({ length: MAX_CHECK_SENTENCES + 1 }, (_, i) => `문장 ${i}.`).join('\n')
    expect(() => splitUserSentences(text)).toThrow('30')
    expect(splitUserSentences(Array.from({ length: MAX_CHECK_SENTENCES }, (_, i) => `문장 ${i}.`).join('\n'))).toHaveLength(
      MAX_CHECK_SENTENCES,
    )
  })
})

describe('validateCheckLocatePayload', () => {
  it('throws a Korean error on a bad shape', () => {
    expect(() => validateCheckLocatePayload(null)).toThrow('형식')
    expect(() => validateCheckLocatePayload({ items: 'nope' })).toThrow('형식')
    expect(() => validateCheckLocatePayload({ items: [{ sentence_index: 'x' }] })).toThrow('형식')
  })

  it('treats missing citation arrays as empty', () => {
    expect(validateCheckLocatePayload({ items: [{ sentence_index: 0 }] })).toEqual([
      { sentenceIndex: 0, segmentIds: [], pageIds: [] },
    ])
  })
})

describe('mapCheckLocate', () => {
  const idByNumber = new Map([
    [1, 101],
    [2, 102],
  ])

  it('keeps the exact user sentence and maps valid citations', () => {
    const mapped = mapCheckLocate(
      ['내가 적은 문장 [1]'],
      validateCheckLocatePayload({ items: [{ sentence_index: 0, segment_ids: [1, 99], page_ids: [] }] }),
      idByNumber,
    )
    expect(mapped).toHaveLength(1)
    expect(mapped[0].text).toBe('내가 적은 문장')
    expect(mapped[0].segmentDbIds).toEqual([101])
  })

  it('sentences the model omitted keep empty citations', () => {
    const mapped = mapCheckLocate(['첫째', '둘째'], [], idByNumber)
    expect(mapped.map((m) => m.segmentDbIds)).toEqual([[], []])
    expect(mapped.map((m) => m.text)).toEqual(['첫째', '둘째'])
  })
})

describe('buildCheckLocateMessages', () => {
  it('carries sentences, transcript numbers, and the locate schema name', () => {
    const messages = buildCheckLocateMessages(['내 문장'], ['[1] (00:00:00–00:00:01) 내용'])
    expect(messages[0].role).toBe('system')
    expect(messages[1].content).toContain('Sentence 0: 내 문장')
    expect(messages[1].content).toContain('[1]')
    expect(CHECK_LOCATE_SCHEMA_NAME).toBe('check_evidence_locate')
    expect(CHECK_LOCATE_SCHEMA.required).toEqual(['items'])
  })
})

describe('runCheckPipeline', () => {
  let dir: string
  let db: DatabaseSync

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-check-'))
    db = openDb(path.join(dir, 'test.sqlite'))
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('locates then verifies: two calls, claims are the user sentences', async () => {
    const noteId = seedNote(db, ['신경망은 여러 레이어로 구성됩니다', '다음 시간에 뵙겠습니다'])
    const { api, calls } = fakeMetaApi((callIndex) =>
      callIndex === 0
        ? { items: [{ sentence_index: 0, segment_ids: [1], page_ids: [] }] }
        : { results: [{ claim_index: 0, supported: true, reason: '인용 구간에 명시됨' }] },
    )

    const summary = await runCheckPipeline({ db, metaApi: api }, noteId, '신경망은 여러 레이어로 구성됩니다.\n증거 없는 내 생각입니다.')

    expect(calls).toHaveLength(2)
    expect(calls[0].responseFormat).toMatchObject({ name: CHECK_LOCATE_SCHEMA_NAME })
    expect(calls[1].responseFormat).toMatchObject({ name: 'claim_verification' })
    expect(summary.kind).toBe('check')
    expect(summary.status).toBe('done')
    expect(summary.claims.map((c) => c.text)).toEqual([
      '신경망은 여러 레이어로 구성됩니다.',
      '증거 없는 내 생각입니다.',
    ])
    expect(summary.claims[0]).toMatchObject({ verdict: 'supported', reason: '인용 구간에 명시됨' })
    expect(summary.claims[0].citations).toHaveLength(1)
    // Zero citations -> unsupported with the fixed reason, skipping verification.
    expect(summary.claims[1].verdict).toBe('unsupported')
    expect(summary.claims[1].reason).toBe(CHECK_ZERO_CITATION_REASON)
    expect(summary.claims[1].reason).toBe('강의 자료에서 근거를 찾지 못했습니다')
  })

  it('separates auto summaries from checks', async () => {
    const noteId = seedNote(db, ['내용'])
    const auto = createSummary(db, noteId, 'muse-spark-1.3', 'auto')
    const { api } = fakeMetaApi((callIndex) =>
      callIndex === 0 ? { items: [] } : { results: [] },
    )
    await runCheckPipeline({ db, metaApi: api }, noteId, '내 문장입니다.')

    const latestAuto = getLatestSummary(db, noteId)
    const latestCheck = getLatestCheck(db, noteId)
    expect(latestAuto?.kind).toBe('auto')
    expect(latestAuto?.claims).toHaveLength(0)
    expect(latestCheck?.kind).toBe('check')
    expect(latestCheck?.claims).toHaveLength(1)
    // The auto summary is untouched by the check run.
    expect(latestAuto?.id).toBe(auto.id)
  })

  it('throws a Korean error with no lecture evidence', async () => {
    const note = createNote(db, '빈 노트')
    const { api } = fakeMetaApi(() => ({}))
    await expect(runCheckPipeline({ db, metaApi: api }, note.id, '내 문장입니다.')).rejects.toThrow('검증할 강의 자료')
  })

  it('stores error status when the locate call fails', async () => {
    const noteId = seedNote(db, ['내용'])
    const failing: MetaApi = {
      transcribeChunk: async () => {
        throw new Error('사용되지 않음')
      },
      chat: async () => {
        throw new Error('요약 API 오류 (HTTP 500): boom')
      },
    }
    await expect(runCheckPipeline({ db, metaApi: failing }, noteId, '내 문장입니다.')).rejects.toThrow('HTTP 500')
    expect(getLatestCheck(db, noteId)?.status).toBe('error')
  })
})
