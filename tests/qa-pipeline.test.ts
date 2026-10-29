import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createNote,
  createSource,
  insertSegments,
  listQuestionAnswers,
  openDb,
  updateSourceStatus,
} from '../src/main/db'
import type { ChatOptions, MetaApi } from '../src/main/meta-api'
import {
  buildQaMessages,
  MAX_QUESTION_CHARS,
  normalizeQuestion,
  QA_SCHEMA_NAME,
  runQaPipeline,
} from '../src/main/qa-pipeline'
import { numberSegments } from '../src/main/grounding'

function fakeMetaApi(responder: (callIndex: number, opts: ChatOptions) => unknown): {
  api: MetaApi
  calls: ChatOptions[]
} {
  const calls: ChatOptions[] = []
  const api: MetaApi = {
    transcribeChunk: async () => {
      throw new Error('unused')
    },
    chat: async (opts) => {
      const i = calls.length
      calls.push(opts)
      return responder(i, opts)
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

let dir: string
let db: DatabaseSync

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-qa-'))
  db = openDb(path.join(dir, 'test.sqlite'))
})

afterEach(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('normalizeQuestion', () => {
  it('trims and rejects empty or overly long questions', () => {
    expect(normalizeQuestion('  학습률이 뭐야?  ')).toBe('학습률이 뭐야?')
    expect(() => normalizeQuestion('   ')).toThrow('질문을 입력')
    expect(() => normalizeQuestion('가'.repeat(MAX_QUESTION_CHARS + 1), 'en')).toThrow('up to')
  })
})

describe('buildQaMessages', () => {
  it('puts the question before the numbered transcript and forbids outside knowledge', () => {
    const numbered = numberSegments([{ id: 7, startMs: 0, endMs: 1000, text: '학습률은 보폭입니다' }])
    const [system, user] = buildQaMessages('학습률이 뭐야?', numbered, [], 'ko')
    expect(system.content).toContain('ONLY')
    expect(system.content).toContain('empty claims list')
    expect(user.content.startsWith('Question: 학습률이 뭐야?\nTranscript:\n[1]')).toBe(true)
  })
})

describe('runQaPipeline', () => {
  it('stores the question with cited, verified answer claims', async () => {
    const noteId = seedNote(db, ['학습률은 한 번에 움직이는 보폭입니다', '드롭아웃은 다음 시간에 다룹니다'])
    const { api, calls } = fakeMetaApi((i) =>
      i === 0
        ? {
            claims: [
              { text: '학습률은 한 번에 움직이는 보폭입니다 [1]', segment_ids: [1], page_ids: [] },
              { text: '학습률은 항상 0.01이 좋습니다', segment_ids: [], page_ids: [] },
            ],
          }
        : { results: [{ claim_index: 0, supported: true, reason: '1번 구간에 명시됨' }] },
    )
    const result = await runQaPipeline({ db, metaApi: api }, noteId, ' 학습률이 뭐야? ')

    expect(calls[0].responseFormat?.name).toBe(QA_SCHEMA_NAME)
    expect(calls).toHaveLength(2)
    expect(result.kind).toBe('qa')
    expect(result.question).toBe('학습률이 뭐야?')
    expect(result.status).toBe('done')
    expect(result.claims.map((c) => [c.text, c.verdict])).toEqual([
      ['학습률은 한 번에 움직이는 보폭입니다', 'supported'],
      ['학습률은 항상 0.01이 좋습니다', 'unsupported'],
    ])
    expect(result.claims[0].citations[0].startMs).toBe(0)
  })

  it('keeps an empty answer when the materials do not cover the question', async () => {
    const noteId = seedNote(db, ['경사하강법을 설명합니다'])
    const { api, calls } = fakeMetaApi(() => ({ claims: [] }))
    const result = await runQaPipeline({ db, metaApi: api }, noteId, '트랜스포머는 뭐야?')
    expect(calls).toHaveLength(1)
    expect(result.status).toBe('done')
    expect(result.claims).toEqual([])
  })

  it('lists every question oldest first and records failures', async () => {
    const noteId = seedNote(db, ['경사하강법을 설명합니다'])
    const ok = fakeMetaApi(() => ({ claims: [] }))
    await runQaPipeline({ db, metaApi: ok.api }, noteId, '첫 질문')
    const failing = fakeMetaApi(() => {
      throw new Error('API down')
    })
    await expect(runQaPipeline({ db, metaApi: failing.api }, noteId, '둘째 질문')).rejects.toThrow('API down')
    const list = listQuestionAnswers(db, noteId)
    expect(list.map((q) => [q.question, q.status, q.error])).toEqual([
      ['첫 질문', 'done', null],
      ['둘째 질문', 'error', 'API down'],
    ])
  })

  it('refuses a note with no lecture materials', async () => {
    const note = createNote(db, '빈 노트')
    const { api } = fakeMetaApi(() => ({ claims: [] }))
    await expect(runQaPipeline({ db, metaApi: api }, note.id, '질문')).rejects.toThrow('강의 자료가 없습니다')
  })
})
