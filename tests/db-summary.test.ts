import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import {
  createNote,
  createSource,
  createSummary,
  getLatestSummary,
  insertClaimsWithCitations,
  insertSegments,
  listNoteSegments,
  openDb,
  setClaimVerdict,
  setSummaryStatus,
  updateSourceStatus,
} from '../src/main/db'

describe('db v2 (summaries + claims)', () => {
  let dir: string
  let dbFile: string
  let db: DatabaseSync

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-db2-'))
    dbFile = path.join(dir, 'test.sqlite')
    db = openDb(dbFile)
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('opens at user_version 2', () => {
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(row.user_version).toBe(2)
  })

  it('migrates a v1 database file to v2 without losing data', () => {
    // Seed v1-shaped data, then roll the version back to simulate a v1 file.
    const note = createNote(db, '기존 노트')
    const source = createSource(db, {
      noteId: note.id,
      kind: 'audio',
      originalPath: '/tmp/a.wav',
      displayName: 'a.wav',
    })
    insertSegments(db, source.id, [
      { idx: 0, startMs: 0, endMs: 1000, text: '보존되어야 함', chunkIndex: 0 },
    ])
    db.exec('DROP TABLE claim_citations')
    db.exec('DROP TABLE claims')
    db.exec('DROP TABLE summaries')
    db.exec('PRAGMA user_version = 1')
    db.close()

    db = openDb(dbFile)
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(row.user_version).toBe(2)
    // v1 data survived the migration.
    expect(listNoteSegments(db, note.id)).toHaveLength(0) // source not done yet
    updateSourceStatus(db, source.id, 'done')
    const segments = listNoteSegments(db, note.id)
    expect(segments).toHaveLength(1)
    expect(segments[0].text).toBe('보존되어야 함')
    // v2 tables exist and accept writes.
    const summary = createSummary(db, note.id, 'muse-spark-1.3')
    expect(summary.id).toBeGreaterThan(0)
  })

  it('summary/claim round-trip with citations and verdicts', () => {
    const note = createNote(db, 'n')
    const source = createSource(db, {
      noteId: note.id,
      kind: 'audio',
      originalPath: '/tmp/a.wav',
      displayName: 'a.wav',
    })
    updateSourceStatus(db, source.id, 'done')
    insertSegments(db, source.id, [
      { idx: 0, startMs: 0, endMs: 1000, text: '첫 구간', chunkIndex: 0 },
      { idx: 1, startMs: 1000, endMs: 2000, text: '둘 구간', chunkIndex: 0 },
    ])
    const segIds = listNoteSegments(db, note.id).map((s) => s.id)

    const summary = createSummary(db, note.id, 'muse-spark-1.3')
    const [c1, c2] = insertClaimsWithCitations(db, summary.id, [
      { idx: 0, text: '주장 일', verdict: 'pending', reason: null, segmentIds: [segIds[0]] },
      { idx: 1, text: '주장 이', verdict: 'unsupported', reason: '인용한 구간이 자료에 없습니다', segmentIds: [] },
    ])
    expect(c1).toBeGreaterThan(0)
    expect(c2).toBeGreaterThan(c1)
    setClaimVerdict(db, c1, 'supported', '인용 구간에 명시됨')
    setSummaryStatus(db, summary.id, 'done')

    const latest = getLatestSummary(db, note.id)
    expect(latest).not.toBeNull()
    expect(latest?.status).toBe('done')
    expect(latest?.model).toBe('muse-spark-1.3')
    expect(latest?.claims).toHaveLength(2)
    expect(latest?.claims[0]).toMatchObject({
      text: '주장 일',
      verdict: 'supported',
      reason: '인용 구간에 명시됨',
    })
    expect(latest?.claims[0].citations).toHaveLength(1)
    expect(latest?.claims[0].citations[0]).toMatchObject({
      segmentId: segIds[0],
      startMs: 0,
      endMs: 1000,
      text: '첫 구간',
      sourceDisplayName: 'a.wav',
    })
    expect(latest?.claims[1].verdict).toBe('unsupported')
    expect(latest?.claims[1].citations).toEqual([])
  })

  it('returns null when the note has no summary', () => {
    const note = createNote(db, 'empty')
    expect(getLatestSummary(db, note.id)).toBeNull()
  })

  it('listNoteSegments orders by source then idx and skips non-done sources', () => {
    const note = createNote(db, 'n')
    const s1 = createSource(db, { noteId: note.id, kind: 'audio', originalPath: '/a', displayName: 'a.wav' })
    const s2 = createSource(db, { noteId: note.id, kind: 'audio', originalPath: '/b', displayName: 'b.wav' })
    const s3 = createSource(db, { noteId: note.id, kind: 'audio', originalPath: '/c', displayName: 'c.wav' })
    insertSegments(db, s2.id, [{ idx: 0, startMs: 0, endMs: 100, text: 's2-0', chunkIndex: 0 }])
    insertSegments(db, s1.id, [
      { idx: 1, startMs: 200, endMs: 300, text: 's1-1', chunkIndex: 0 },
      { idx: 0, startMs: 0, endMs: 200, text: 's1-0', chunkIndex: 0 },
    ])
    insertSegments(db, s3.id, [{ idx: 0, startMs: 0, endMs: 100, text: 's3-error', chunkIndex: 0 }])
    updateSourceStatus(db, s1.id, 'done')
    updateSourceStatus(db, s2.id, 'done')
    updateSourceStatus(db, s3.id, 'error', '실패')

    const segments = listNoteSegments(db, note.id)
    expect(segments.map((s) => s.text)).toEqual(['s1-0', 's1-1', 's2-0'])
    expect(segments[0].displayName).toBe('a.wav')
  })
})
