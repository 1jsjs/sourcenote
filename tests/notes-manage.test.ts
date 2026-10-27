import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import {
  createNote,
  createSource,
  createSummary,
  deleteNote,
  getLatestCheck,
  getLatestSummary,
  getNote,
  insertClaimsWithCitations,
  insertCorrections,
  insertPages,
  insertSegments,
  listSegments,
  listSources,
  openDb,
  removeNoteMedia,
  renameNote,
  setSummaryStatus,
  updateSourceStatus,
} from '../src/main/db'

describe('renameNote / deleteNote', () => {
  let dir: string
  let db: DatabaseSync

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-notes-'))
    db = openDb(path.join(dir, 'test.sqlite'))
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('renameNote trims and persists the new title', () => {
    const note = createNote(db, '원래 제목')
    const updated = renameNote(db, note.id, '  새 제목  ')
    expect(updated.title).toBe('새 제목')
    expect(getNote(db, note.id)?.title).toBe('새 제목')
  })

  it('renameNote rejects an empty title in both languages', () => {
    const note = createNote(db, 'n')
    expect(() => renameNote(db, note.id, '   ')).toThrow('노트 제목을 입력하세요')
    expect(() => renameNote(db, note.id, '   ', 'en')).toThrow('Enter a note title')
    expect(getNote(db, note.id)?.title).toBe('n')
  })

  it('renameNote rejects titles over 200 chars and unknown notes', () => {
    const note = createNote(db, 'n')
    expect(() => renameNote(db, note.id, '가'.repeat(201))).toThrow()
    expect(renameNote(db, note.id, '가'.repeat(200)).title.length).toBe(200)
    expect(() => renameNote(db, note.id + 999, 'x')).toThrow()
  })

  it('deleteNote on an unknown id is a no-op returning []', () => {
    expect(deleteNote(db, 4242)).toEqual([])
  })

  it('deleteNote removes every row of that note and nothing of another', () => {
    const first = seedFullNote(db, '첫 노트')
    const second = seedFullNote(db, '둘 노트')

    const sourceIds = deleteNote(db, first.noteId)
    expect(sourceIds.sort((a, b) => a - b)).toEqual(first.sourceIds.sort((a, b) => a - b))

    // The deleted note is fully gone.
    expect(getNote(db, first.noteId)).toBeNull()
    expect(listSources(db, first.noteId)).toHaveLength(0)
    expect(count(db, 'summaries', 'note_id', first.noteId)).toBe(0)
    expect(count(db, 'claims')).toBe(second.claimCount)
    expect(count(db, 'claim_citations')).toBe(second.citeCount)
    expect(count(db, 'claim_page_citations')).toBe(second.pageCiteCount)
    expect(count(db, 'corrections', 'note_id', first.noteId)).toBe(0)
    expect(count(db, 'segments')).toBe(second.segmentCount)
    expect(count(db, 'pages')).toBe(second.pageCount)
    expect(count(db, 'sources')).toBe(second.sourceIds.length)

    // The other note still reads back whole.
    const summary = getLatestSummary(db, second.noteId)
    expect(summary?.claims).toHaveLength(1)
    expect(summary?.claims[0].citations).toHaveLength(1)
    expect(summary?.claims[0].pageCitations).toHaveLength(1)
    const check = getLatestCheck(db, second.noteId)
    expect(check?.claims).toHaveLength(1)
    expect(listSources(db, second.noteId)).toHaveLength(second.sourceIds.length)
  })

  it('deleteNote refuses while ingest or summary work is in flight', () => {
    const busy = seedFullNote(db, '바쁜 노트')
    updateSourceStatus(db, busy.sourceIds[0], 'converting')
    expect(() => deleteNote(db, busy.noteId)).toThrow('처리 중인 노트는 삭제할 수 없습니다')
    expect(() => deleteNote(db, busy.noteId, 'en')).toThrow('This note is still being processed')
    expect(getNote(db, busy.noteId)).not.toBeNull()
    updateSourceStatus(db, busy.sourceIds[0], 'done')

    const summarizing = createSummary(db, busy.noteId, 'muse-spark')
    expect(() => deleteNote(db, busy.noteId)).toThrow('처리 중인 노트는 삭제할 수 없습니다')
    setSummaryStatus(db, summarizing.id, 'done')
    expect(deleteNote(db, busy.noteId).length).toBeGreaterThan(0)
  })

  it('deleteNote refuses while a check is verifying', () => {
    const note = createNote(db, 'n')
    const check = createSummary(db, note.id, 'muse-spark', 'check', 'ko')
    setSummaryStatus(db, check.id, 'verifying')
    expect(() => deleteNote(db, note.id)).toThrow('처리 중인 노트는 삭제할 수 없습니다')
  })

  it('media removal deletes only the source chunk dirs, never originals or samples', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-data-'))
    try {
      const note = createNote(db, '미디어 노트')
      // Original file lives outside the data dir (e.g. an external drive).
      const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-ext-'))
      const originalFile = path.join(externalDir, 'lecture.wav')
      fs.writeFileSync(originalFile, 'original-audio')
      const source = createSource(db, {
        noteId: note.id,
        kind: 'audio',
        originalPath: originalFile,
        displayName: 'lecture.wav',
      })
      const chunkDir = path.join(dataDir, 'media', String(source.id))
      fs.mkdirSync(chunkDir, { recursive: true })
      fs.writeFileSync(path.join(chunkDir, 'chunk0.bin'), 'converted')
      // A shared sample copy must survive.
      const sampleFile = path.join(dataDir, 'samples', 'demo', 'lecture.wav')
      fs.mkdirSync(path.dirname(sampleFile), { recursive: true })
      fs.writeFileSync(sampleFile, 'sample-copy')

      const sourceIds = deleteNote(db, note.id)
      expect(sourceIds).toEqual([source.id])
      removeNoteMedia(dataDir, sourceIds)

      expect(fs.existsSync(chunkDir)).toBe(false)
      expect(fs.existsSync(path.join(dataDir, 'media'))).toBe(true)
      expect(fs.readFileSync(originalFile, 'utf8')).toBe('original-audio')
      expect(fs.readFileSync(sampleFile, 'utf8')).toBe('sample-copy')
      fs.rmSync(externalDir, { recursive: true, force: true })
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('media removal stays inside <dataDir>/media', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-guard-'))
    try {
      const sentinel = path.join(dataDir, 'sentinel.txt')
      fs.writeFileSync(sentinel, 'keep')
      // Missing dirs are a no-op; the media root and its siblings survive.
      removeNoteMedia(dataDir, [1, 2, 3])
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('keep')
      expect(fs.existsSync(dataDir)).toBe(true)
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

/** Builds a note with audio + pdf sources, corrections, summary + check. */
function seedFullNote(db: DatabaseSync, title: string): {
  noteId: number
  sourceIds: number[]
  claimCount: number
  citeCount: number
  pageCiteCount: number
  segmentCount: number
  pageCount: number
} {
  const note = createNote(db, title)
  const audio = createSource(db, {
    noteId: note.id,
    kind: 'audio',
    originalPath: path.join(os.tmpdir(), `${title}-a.wav`),
    displayName: 'a.wav',
  })
  updateSourceStatus(db, audio.id, 'done')
  insertSegments(db, audio.id, [
    { idx: 0, startMs: 0, endMs: 1000, text: '첫 구간', chunkIndex: 0 },
    { idx: 1, startMs: 1000, endMs: 2000, text: '둘 구간', chunkIndex: 0 },
  ])
  const segmentIds = listSegments(db, audio.id).map((s) => s.id)

  const pdf = createSource(db, {
    noteId: note.id,
    kind: 'pdf',
    originalPath: path.join(os.tmpdir(), `${title}-s.pdf`),
    displayName: 's.pdf',
  })
  updateSourceStatus(db, pdf.id, 'done')
  const pageIds = insertPages(db, pdf.id, [{ pageNo: 1, text: '슬라이드 일' }])

  insertCorrections(db, note.id, [
    {
      segmentId: segmentIds[0],
      beforeText: '첫 구간',
      afterText: '첫 번째 구간',
      reason: '띄어쓰기',
      kind: 'typo',
    },
  ])

  const summary = createSummary(db, note.id, 'muse-spark')
  insertClaimsWithCitations(db, summary.id, [
    {
      idx: 0,
      text: '주장',
      verdict: 'supported',
      reason: '인용됨',
      segmentIds: [segmentIds[0]],
      pageIds: [pageIds[0]],
    },
  ])
  setSummaryStatus(db, summary.id, 'done')

  const check = createSummary(db, note.id, 'muse-spark', 'check', 'ko')
  insertClaimsWithCitations(db, check.id, [
    { idx: 0, text: '확인', verdict: 'supported', reason: null, segmentIds: [segmentIds[1]] },
  ])
  setSummaryStatus(db, check.id, 'done')

  return {
    noteId: note.id,
    sourceIds: [audio.id, pdf.id],
    claimCount: 2,
    citeCount: 2,
    pageCiteCount: 1,
    segmentCount: 2,
    pageCount: 1,
  }
}

function count(db: DatabaseSync, table: string, column?: string, value?: number): number {
  let row: { n: number }
  if (column !== undefined && value !== undefined) {
    row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(value) as {
      n: number
    }
  } else {
    row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  }
  return row.n
}
