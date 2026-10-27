import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import {
  createNote,
  createSource,
  insertSegments,
  listNotes,
  listSegments,
  listSources,
  openDb,
  setSourceDuration,
  updateSourceStatus,
} from '../src/main/db'

describe('db (node:sqlite)', () => {
  let dir: string
  let dbFile: string
  let db: DatabaseSync

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-db-'))
    dbFile = path.join(dir, 'test.sqlite')
    db = openDb(dbFile)
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('creates schema and reports user_version 2', () => {
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(row.user_version).toBe(2)
  })

  it('reopening the same file is idempotent (no duplicate schema errors)', () => {
    db.close()
    expect(() => {
      db = openDb(dbFile)
    }).not.toThrow()
  })

  it('note/source/segment round-trip with status transitions', () => {
    const note = createNote(db, '테스트 노트')
    expect(listNotes(db)).toHaveLength(1)
    expect(listNotes(db)[0].title).toBe('테스트 노트')

    const source = createSource(db, {
      noteId: note.id,
      kind: 'audio',
      originalPath: '/tmp/a.wav',
      displayName: 'a.wav',
    })
    expect(source.status).toBe('pending')

    updateSourceStatus(db, source.id, 'transcribing')
    setSourceDuration(db, source.id, 37_280)
    insertSegments(db, source.id, [
      { idx: 0, startMs: 0, endMs: 36_780, text: '안녕하세요', chunkIndex: 0 },
      { idx: 1, startMs: 36_780, endMs: 37_280, text: '끝', chunkIndex: 0 },
    ])
    updateSourceStatus(db, source.id, 'done')

    const sources = listSources(db, note.id)
    expect(sources).toHaveLength(1)
    expect(sources[0].status).toBe('done')
    expect(sources[0].duration_ms).toBe(37_280)

    const segments = listSegments(db, source.id)
    expect(segments).toHaveLength(2)
    expect(segments[0].text).toBe('안녕하세요')
    expect(segments[1].idx).toBe(1)
  })

  it('records error status with a message', () => {
    const note = createNote(db, 'n')
    const source = createSource(db, {
      noteId: note.id,
      kind: 'audio',
      originalPath: '/tmp/x.wav',
      displayName: 'x.wav',
    })
    updateSourceStatus(db, source.id, 'error', '전사 API 오류 (HTTP 500)')
    const reloaded = listSources(db, note.id)[0]
    expect(reloaded.status).toBe('error')
    expect(reloaded.error).toContain('HTTP 500')
  })
})
