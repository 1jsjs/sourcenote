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
  getLatestSummary,
  insertClaimsWithCitations,
  insertPages,
  insertSegments,
  listNotePageImages,
  listNotePages,
  listSourcePages,
  openDb,
  pageImagePathMap,
  setPageImagePath,
  setPageVisualText,
  setSummaryStatus,
  updateSourceStatus,
} from '../src/main/db'

describe('db v3 (slide pages)', () => {
  let dir: string
  let dbFile: string
  let db: DatabaseSync

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-db3-'))
    dbFile = path.join(dir, 'test.sqlite')
    db = openDb(dbFile)
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('opens at user_version 10', () => {
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(row.user_version).toBe(10)
  })

  it('migrates a v2 database file to v10 without losing data', () => {
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
    const summary = createSummary(db, note.id, 'muse-spark-1.3')
    insertClaimsWithCitations(db, summary.id, [
      { idx: 0, text: '주장', verdict: 'pending', reason: null, segmentIds: [] },
    ])
    // Roll back to the v2 shape to simulate a v2 file.
    db.exec('DROP TABLE claim_page_citations')
    db.exec('DROP TABLE pages')
    // A real v2 file also lacks the stage-4 columns/tables.
    db.exec('DROP TABLE corrections')
    db.exec('ALTER TABLE segments DROP COLUMN original_text')
    db.exec('ALTER TABLE summaries DROP COLUMN kind')
    db.exec('ALTER TABLE summaries DROP COLUMN language')
    db.exec('ALTER TABLE summaries DROP COLUMN question')
    db.exec('ALTER TABLE summaries DROP COLUMN coverage')
    // ...and the per-note language columns (v9).
    db.exec('ALTER TABLE notes DROP COLUMN lecture_language')
    db.exec('ALTER TABLE notes DROP COLUMN note_language')
    db.exec('PRAGMA user_version = 2')
    db.close()

    db = openDb(dbFile)
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(row.user_version).toBe(10)
    // v2 data survived the migration.
    const latest = getLatestSummary(db, note.id)
    expect(latest?.claims).toHaveLength(1)
    expect(latest?.claims[0].text).toBe('주장')
    expect(latest?.claims[0].pageCitations).toEqual([])
    // v3 tables accept writes.
    updateSourceStatus(db, source.id, 'done')
    expect(insertPages(db, source.id, [{ pageNo: 1, text: '새 페이지' }])).toHaveLength(1)
  })

  it('lists a note pages in order, only from done pdf sources', () => {
    const note = createNote(db, 'n')
    const pdf1 = createSource(db, {
      noteId: note.id,
      kind: 'pdf',
      originalPath: '/s1.pdf',
      displayName: 's1.pdf',
    })
    const pdf2 = createSource(db, {
      noteId: note.id,
      kind: 'pdf',
      originalPath: '/s2.pdf',
      displayName: 's2.pdf',
    })
    const audio = createSource(db, {
      noteId: note.id,
      kind: 'audio',
      originalPath: '/a.wav',
      displayName: 'a.wav',
    })
    insertPages(db, pdf2.id, [
      { pageNo: 2, text: 'p2-2' },
      { pageNo: 1, text: 'p2-1' },
    ])
    insertPages(db, pdf1.id, [{ pageNo: 1, text: 'p1-1' }])
    insertPages(db, audio.id, [{ pageNo: 1, text: '오디오에는 페이지 없음' }])
    updateSourceStatus(db, pdf1.id, 'done')
    updateSourceStatus(db, pdf2.id, 'done')
    // audio source stays pending, so its pages stay invisible.

    const pages = listNotePages(db, note.id)
    expect(pages.map((p) => p.text)).toEqual(['p1-1', 'p2-1', 'p2-2'])
    expect(pages[0].displayName).toBe('s1.pdf')
    expect(pages[0].pageNo).toBe(1)
  })

  it('page citations round-trip in the summary DTO', () => {
    const note = createNote(db, 'n')
    const pdf = createSource(db, {
      noteId: note.id,
      kind: 'pdf',
      originalPath: '/s.pdf',
      displayName: 'slides.pdf',
    })
    updateSourceStatus(db, pdf.id, 'done')
    const [p1, p2] = insertPages(db, pdf.id, [
      { pageNo: 1, text: '첫 장' },
      { pageNo: 2, text: '둘 장' },
    ])

    const summary = createSummary(db, note.id, 'muse-spark-1.3')
    insertClaimsWithCitations(db, summary.id, [
      { idx: 0, text: '슬라이드 주장', verdict: 'pending', reason: null, segmentIds: [], pageIds: [p2, p1, p2] },
    ])
    setSummaryStatus(db, summary.id, 'done')

    const latest = getLatestSummary(db, note.id)
    expect(latest?.claims).toHaveLength(1)
    expect(latest?.claims[0].citations).toEqual([])
    expect(latest?.claims[0].pageCitations).toHaveLength(2)
    expect(latest?.claims[0].pageCitations[0]).toMatchObject({
      pageId: p1,
      pageNo: 1,
      text: '첫 장',
      sourceId: pdf.id,
      sourceDisplayName: 'slides.pdf',
    })
  })
})

describe('db v8 (page images + vision text)', () => {
  let dir: string
  let dbFile: string
  let db: DatabaseSync

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-db8-'))
    dbFile = path.join(dir, 'test.sqlite')
    db = openDb(dbFile)
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** A note with one done pdf source and two pages; returns their ids. */
  function seedPages(): { noteId: number; pageIds: number[] } {
    const note = createNote(db, 'n')
    const pdf = createSource(db, {
      noteId: note.id,
      kind: 'pdf',
      originalPath: path.join(dir, 'slides.pdf'),
      displayName: 'slides.pdf',
    })
    updateSourceStatus(db, pdf.id, 'done')
    const pageIds = insertPages(db, pdf.id, [
      { pageNo: 1, text: '첫 장' },
      { pageNo: 2, text: '둘 장' },
    ])
    return { noteId: note.id, pageIds }
  }

  it('migration v8 adds image_path and visual_text columns, both NULL by default', () => {
    const columns = db.prepare('PRAGMA table_info(pages)').all() as unknown as Array<{
      name: string
    }>
    expect(columns.map((c) => c.name)).toEqual(
      expect.arrayContaining(['image_path', 'visual_text']),
    )
    const { noteId, pageIds } = seedPages()
    const pages = listNotePages(db, noteId)
    expect(pages.map((p) => p.visualText)).toEqual([null, null])
    expect(pageImagePathMap(db, pageIds)).toEqual(new Map())
  })

  it('image path and visual text round-trip through the page helpers', () => {
    const { noteId, pageIds } = seedPages()
    const imagePath = path.join(dir, 'page-images', `${pageIds[0]}.jpg`)
    fs.mkdirSync(path.dirname(imagePath), { recursive: true })
    fs.writeFileSync(imagePath, Buffer.from([0xff, 0xd8]))
    setPageImagePath(db, pageIds[0], imagePath)
    setPageVisualText(db, pageIds[0], '막대그래프 하나')

    // The renderer-facing lists carry visualText but never image paths.
    const pages = listNotePages(db, noteId)
    expect(pages[0].visualText).toBe('막대그래프 하나')
    expect(pages[1].visualText).toBeNull()
    expect('imagePath' in pages[0]).toBe(false)
    expect(listSourcePages(db, pages[0].sourceId)[0].visualText).toBe('막대그래프 하나')

    // The main-only helper exposes paths for the vision step.
    const images = listNotePageImages(db, noteId)
    expect(images).toHaveLength(2)
    expect(images[0]).toMatchObject({
      pageId: pageIds[0],
      pageNo: 1,
      imagePath,
      visualText: '막대그래프 하나',
      originalPath: path.join(dir, 'slides.pdf'),
    })
    expect(images[1].imagePath).toBeNull()
    expect(pageImagePathMap(db, pageIds)).toEqual(new Map([[pageIds[0], imagePath]]))
  })

  it('deleteNote removes the note page image files from disk', () => {
    const { noteId, pageIds } = seedPages()
    const other = createNote(db, 'other')
    const imagePath = path.join(dir, 'page-images', `${pageIds[0]}.jpg`)
    fs.mkdirSync(path.dirname(imagePath), { recursive: true })
    fs.writeFileSync(imagePath, Buffer.from([0xff, 0xd8]))
    setPageImagePath(db, pageIds[0], imagePath)

    expect(fs.existsSync(imagePath)).toBe(true)
    deleteNote(db, noteId)
    expect(fs.existsSync(imagePath)).toBe(false)
    expect(listNotePageImages(db, noteId)).toEqual([])
    expect(listNotePageImages(db, other.id)).toEqual([])
  })
})
