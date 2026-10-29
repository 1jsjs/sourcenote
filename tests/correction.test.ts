import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import {
  acceptAllCorrections,
  acceptCorrection,
  applyCorrectionText,
  buildCorrectionMessages,
  CORRECTION_SCHEMA,
  CORRECTION_SCHEMA_NAME,
  filterValidCorrections,
  listCorrectionsDto,
  rejectCorrection,
  runCorrectionPipeline,
  validateCorrectionPayload,
  type CorrectionItemRaw,
} from '../src/main/correction'
import {
  createNote,
  createSource,
  insertCorrections,
  insertSegments,
  listCorrections,
  listNoteSegments,
  openDb,
  updateSourceStatus,
} from '../src/main/db'
import type { ChatOptions, MetaApi } from '../src/main/meta-api'

function fakeChat(payload: unknown, calls: ChatOptions[]): MetaApi {
  return {
    transcribeChunk: async () => {
      throw new Error('사용되지 않음')
    },
    chat: async (opts: ChatOptions) => {
      calls.push(opts)
      return payload
    },
  }
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

function textMaps(db: DatabaseSync, noteId: number): { byNumber: Map<number, string>; idByNumber: Map<number, number> } {
  const segs = listNoteSegments(db, noteId)
  return {
    byNumber: new Map(segs.map((s, i) => [i + 1, s.text])),
    idByNumber: new Map(segs.map((s, i) => [i + 1, s.id])),
  }
}

describe('validateCorrectionPayload', () => {
  it('throws a Korean error on a bad shape', () => {
    expect(() => validateCorrectionPayload(null)).toThrow('형식')
    expect(() => validateCorrectionPayload({ corrections: 'nope' })).toThrow('형식')
    expect(() => validateCorrectionPayload({ corrections: [null] })).toThrow('형식')
  })

  it('passes raw items through', () => {
    const raw = {
      corrections: [
        { segment_number: 1, before: '히든 레이어', after: 'hidden layer', kind: 'term', reason: '슬라이드 표기' },
      ],
    }
    expect(validateCorrectionPayload(raw)).toHaveLength(1)
  })
})

describe('filterValidCorrections', () => {
  const byNumber = new Map([
    [1, '히든 레이어가 특징을 추출합니다'],
    [2, '레이어로 레이어로 구성됩니다'],
  ])
  const idByNumber = new Map([
    [1, 101],
    [2, 102],
  ])

  function raw(items: unknown[]): CorrectionItemRaw[] {
    return items as CorrectionItemRaw[]
  }

  it('keeps valid items', () => {
    const valid = filterValidCorrections(
      raw([{ segmentNumber: 1, before: '히든 레이어', after: 'hidden layer', kind: 'term', reason: '영어 원어' }]),
      byNumber,
      idByNumber,
    )
    expect(valid).toHaveLength(1)
    expect(valid[0]).toMatchObject({ segmentId: 101, beforeText: '히든 레이어', kind: 'term' })
  })

  it('drops out-of-range numbers, empty/unfound before, and before == after', () => {
    const valid = filterValidCorrections(
      raw([
        { segmentNumber: 9, before: '히든 레이어', after: 'hidden layer', kind: 'term', reason: 'r' },
        { segmentNumber: 1, before: '', after: 'x', kind: 'typo', reason: 'r' },
        { segmentNumber: 1, before: '없는 말', after: 'x', kind: 'typo', reason: 'r' },
        { segmentNumber: 1, before: '히든 레이어', after: '히든 레이어', kind: 'term', reason: 'r' },
        { segmentNumber: 1, before: '히든 레이어', after: 'hidden layer', kind: 'epoch', reason: 'r' },
      ]),
      byNumber,
      idByNumber,
    )
    expect(valid).toEqual([])
  })

  it('dedupes identical items but keeps distinct occurrences', () => {
    const item = { segmentNumber: 2, before: '레이어로', after: '레이어로 ', kind: 'duplicate', reason: 'r' }
    const valid = filterValidCorrections(raw([item, { ...item }, { ...item, after: '레이어' }]), byNumber, idByNumber)
    expect(valid).toHaveLength(2)
  })
})

describe('applyCorrectionText', () => {
  it('replaces only the first occurrence', () => {
    expect(applyCorrectionText('레이어로 레이어로 구성', '레이어로', '레이어')).toBe('레이어 레이어로 구성')
  })

  it('returns the text unchanged when before is missing', () => {
    expect(applyCorrectionText('안녕', '없는 말', 'x')).toBe('안녕')
  })
})

describe('accept/reject logic', () => {
  let dir: string
  let db: DatabaseSync
  let noteId: number

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-corr-'))
    db = openDb(path.join(dir, 'test.sqlite'))
    noteId = seedNote(db, ['히든 레이어가 특징을 추출합니다', '레이어로 레이어로 구성됩니다'])
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  async function runProposals(): Promise<void> {
    const { byNumber, idByNumber } = textMaps(db, noteId)
    const valid = filterValidCorrections(
      validateCorrectionPayload({
        corrections: [
          { segment_number: 1, before: '히든 레이어', after: 'hidden layer', kind: 'term', reason: '슬라이드 표기' },
        ],
      }),
      byNumber,
      idByNumber,
    )
    insertCorrections(db, noteId, valid)
  }

  it('accept replaces the first occurrence and saves original_text once', async () => {
    await runProposals()
    const [c] = listCorrections(db, noteId)
    expect(await acceptCorrection(db, c.id)).toEqual({ message: null })

    const row = db.prepare('SELECT text, original_text AS originalText FROM segments WHERE id = ?').get(
      c.segment_id,
    ) as unknown as { text: string; originalText: string | null }
    expect(row.text).toBe('hidden layer가 특징을 추출합니다')
    expect(row.originalText).toBe('히든 레이어가 특징을 추출합니다')
    expect(listCorrections(db, noteId)[0].status).toBe('accepted')
  })

  it('second accept on the same segment keeps the first original_text', async () => {
    await runProposals()
    const [c] = listCorrections(db, noteId)
    await acceptCorrection(db, c.id)
    // A new proposal on the already-corrected text still preserves the raw ASR text.
    insertCorrections(db, noteId, [
      { segmentId: c.segment_id, beforeText: '특징', afterText: 'feature', reason: '용어', kind: 'term' },
    ])
    // Pending corrections sort first, so the new proposal is at the front.
    const [second] = listCorrections(db, noteId)
    expect(second.status).toBe('pending')
    acceptCorrection(db, second.id)
    const row = db.prepare('SELECT text, original_text AS originalText FROM segments WHERE id = ?').get(
      c.segment_id,
    ) as unknown as { text: string; originalText: string | null }
    expect(row.text).toContain('feature')
    expect(row.originalText).toBe('히든 레이어가 특징을 추출합니다')
  })

  it('missing before marks the correction rejected with a Korean message', async () => {
    await runProposals()
    const [c] = listCorrections(db, noteId)
    // Change the segment text first so `before` no longer occurs.
    db.prepare('UPDATE segments SET text = ? WHERE id = ?').run('완전히 다른 문장입니다', c.segment_id)
    const result = await acceptCorrection(db, c.id)
    expect(result.message).toMatch('이미 바뀌어')
    expect(listCorrections(db, noteId)[0].status).toBe('rejected')
    const row = db.prepare('SELECT text FROM segments WHERE id = ?').get(c.segment_id) as unknown as {
      text: string
    }
    expect(row.text).toBe('완전히 다른 문장입니다')
  })

  it('reject only flips status; acceptAll processes pending in id order', () => {
    const segs = listNoteSegments(db, noteId)
    insertCorrections(db, noteId, [
      { segmentId: segs[0].id, beforeText: '히든 레이어', afterText: 'hidden layer', reason: '용어', kind: 'term' },
      { segmentId: segs[1].id, beforeText: '레이어로 레이어로', afterText: '레이어로', reason: '중복', kind: 'duplicate' },
    ])
    const [first, second] = listCorrections(db, noteId)
    rejectCorrection(db, first.id)
    expect(listCorrections(db, noteId).find((c) => c.id === first.id)?.status).toBe('rejected')

    const { accepted } = acceptAllCorrections(db, noteId)
    expect(accepted).toBe(1)
    expect(listCorrections(db, noteId).find((c) => c.id === second.id)?.status).toBe('accepted')
  })

  it('acceptAll removes duplicates before term fixes that overlap them', () => {
    const segs = listNoteSegments(db, noteId)
    db.prepare('UPDATE segments SET text = ? WHERE id = ?').run('작은 묶음 즉 미니 배치로 배치로 나눕니다', segs[0].id)
    insertCorrections(db, noteId, [
      { segmentId: segs[0].id, beforeText: '미니 배치', afterText: 'mini-batch', reason: '용어', kind: 'term' },
      { segmentId: segs[0].id, beforeText: '배치로 배치로', afterText: '배치로', reason: '중복', kind: 'duplicate' },
    ])
    expect(acceptAllCorrections(db, noteId)).toEqual({ accepted: 2 })
    const row = db.prepare('SELECT text FROM segments WHERE id = ?').get(segs[0].id) as unknown as {
      text: string
    }
    expect(row.text).toBe('작은 묶음 즉 mini-batch로 나눕니다')
  })

  it('accepting a non-pending or missing correction throws a Korean error', () => {
    expect(() => acceptCorrection(db, 9999)).toThrow('찾을 수 없습니다')
    runProposals()
    const [c] = listCorrections(db, noteId)
    rejectCorrection(db, c.id)
    expect(() => acceptCorrection(db, c.id)).toThrow('이미 처리')
    expect(() => rejectCorrection(db, c.id)).toThrow('이미 처리')
  })
})

describe('runCorrectionPipeline', () => {
  let dir: string
  let db: DatabaseSync

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-corrpipe-'))
    db = openDb(path.join(dir, 'test.sqlite'))
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('stores valid proposals as pending via metaApi.chat', async () => {
    const noteId = seedNote(db, ['손실 합수의 그레이디언트를 계산합니다'])
    const calls: ChatOptions[] = []
    const result = await runCorrectionPipeline(
      { db, metaApi: fakeChat({ corrections: [{ segment_number: 1, before: '합수', after: '함수', kind: 'typo', reason: '오인식' }] }, calls) },
      noteId,
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].responseFormat).toMatchObject({ name: CORRECTION_SCHEMA_NAME })
    expect(calls[0].responseFormat?.schema).toEqual(CORRECTION_SCHEMA)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ beforeText: '합수', afterText: '함수', status: 'pending' })
  })

  it('re-run replaces pending proposals but keeps accepted history', async () => {
    const noteId = seedNote(db, ['히든 레이어 설명', '액티베이션 펑션 설명'])
    const first = await runCorrectionPipeline(
      {
        db,
        metaApi: fakeChat(
          {
            corrections: [
              { segment_number: 1, before: '히든 레이어', after: 'hidden layer', kind: 'term', reason: '슬라이드' },
              { segment_number: 2, before: '액티베이션 펑션', after: 'activation function', kind: 'term', reason: '슬라이드' },
            ],
          },
          [],
        ),
      },
      noteId,
    )
    expect(first).toHaveLength(2)
    await acceptCorrection(db, first[0].id)

    const second = await runCorrectionPipeline(
      {
        db,
        metaApi: fakeChat(
          { corrections: [{ segment_number: 2, before: '펑션', after: 'function', kind: 'term', reason: '슬라이드' }] },
          [],
        ),
      },
      noteId,
    )
    // Accepted proposal survives; the other pending one was replaced.
    expect(second.map((c) => [c.beforeText, c.status])).toEqual([
      ['펑션', 'pending'],
      ['히든 레이어', 'accepted'],
    ])
  })

  it('throws a Korean error when there is nothing to correct', async () => {
    const note = createNote(db, '빈 노트')
    await expect(runCorrectionPipeline({ db, metaApi: fakeChat({}, []) }, note.id)).rejects.toThrow(
      '교정할 전사 구간이 없습니다',
    )
  })
})

describe('buildCorrectionMessages', () => {
  it('includes numbered lines and a truncated Slides glossary', () => {
    const messages = buildCorrectionMessages(['[1] (00:00:00–00:00:01) 히든 레이어'], ['a'.repeat(40_000)])
    expect(messages).toHaveLength(2)
    const user = messages[1].content
    expect(user).toContain('[1]')
    expect(user).toContain('Slides:')
    const slidesPart = user.slice(user.indexOf('Slides:\n') + 'Slides:\n'.length)
    expect(slidesPart.length).toBeLessThanOrEqual(30_000)
  })

  it('omits the Slides section when there are no pages', () => {
    const messages = buildCorrectionMessages(['[1] (00:00:00–00:00:01) 내용'])
    expect(messages[1].content).not.toContain('Slides:')
  })
})

describe('correction DTO + migration', () => {
  let dir: string
  let dbFile: string
  let db: DatabaseSync

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-corrmig-'))
    dbFile = path.join(dir, 'test.sqlite')
    db = openDb(dbFile)
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('listCorrectionsDto carries segment time and original text', () => {
    const noteId = seedNote(db, ['히든 레이어 설명'])
    const [seg] = listNoteSegments(db, noteId)
    insertCorrections(db, noteId, [
      { segmentId: seg.id, beforeText: '히든 레이어', afterText: 'hidden layer', reason: '슬라이드', kind: 'term' },
    ])
    const dto = listCorrectionsDto(db, noteId)
    expect(dto[0]).toMatchObject({ beforeText: '히든 레이어', startMs: 0, originalText: null })
  })

  it('migration preserves transcript data and exposes original_text', () => {
    seedNote(db, ['보존되어야 함'])
    db.close()
    db = openDb(dbFile)
    expect(listNoteSegments(db, 1)[0].text).toBe('보존되어야 함')
    const cols = db.prepare('PRAGMA table_info(segments)').all() as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain('original_text')
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    expect(tables.map((t) => t.name)).toContain('corrections')
  })
})
