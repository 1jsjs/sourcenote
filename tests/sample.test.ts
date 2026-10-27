import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createNote,
  createSource,
  createSummary,
  getLatestCheck,
  getLatestSummary,
  insertClaimsWithCitations,
  insertCorrections,
  insertPages,
  insertSegments,
  listCorrections,
  listNotes,
  listSources,
  openDb,
  setCorrectionStatus,
  setSourceDuration,
  setSummaryStatus,
  updateSourceStatus,
} from '../src/main/db'
import {
  importSampleNote,
  listSampleNotes,
  parseSampleNote,
  serializeSampleNote,
  type SampleNote,
} from '../src/main/sample'

describe('sample-note format', () => {
  let dir: string
  let db: DatabaseSync

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-sample-'))
    db = openDb(path.join(dir, 'test.sqlite'))
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** A note with audio + pdf sources, corrections, and auto + check summaries. */
  function seedRichNote(): number {
    const note = createNote(db, 'Gradient descent (sample)')
    const audio = createSource(db, {
      noteId: note.id,
      kind: 'audio',
      originalPath: path.join(dir, 'lecture.wav'),
      displayName: 'lecture.wav',
    })
    fs.writeFileSync(audio.original_path, Buffer.alloc(8))
    setSourceDuration(db, audio.id, 84_000)
    updateSourceStatus(db, audio.id, 'done')
    insertSegments(db, audio.id, [
      { idx: 0, startMs: 0, endMs: 1000, text: 'learning rate matters', chunkIndex: 0 },
      { idx: 1, startMs: 1000, endMs: 2000, text: 'loss may diverge', chunkIndex: 0 },
    ])
    db.prepare('UPDATE segments SET original_text = ? WHERE source_id = ? AND idx = 0').run(
      '러닝 레이트 matters',
      audio.id,
    )
    const pdf = createSource(db, {
      noteId: note.id,
      kind: 'pdf',
      originalPath: path.join(dir, 'slides.pdf'),
      displayName: 'slides.pdf',
    })
    fs.writeFileSync(pdf.original_path, Buffer.alloc(8))
    updateSourceStatus(db, pdf.id, 'done')
    insertPages(db, pdf.id, [
      { pageNo: 1, text: 'Gradient Descent' },
      { pageNo: 2, text: 'Learning Rate' },
    ])

    const audioSegs = db
      .prepare('SELECT id, idx FROM segments WHERE source_id = ? ORDER BY idx')
      .all(audio.id) as Array<{ id: number; idx: number }>
    const pageRows = db
      .prepare('SELECT id, page_no AS pageNo FROM pages WHERE source_id = ? ORDER BY page_no')
      .all(pdf.id) as Array<{ id: number; pageNo: number }>
    insertCorrections(db, note.id, [
      {
        segmentId: audioSegs[0].id,
        beforeText: '러닝 레이트',
        afterText: 'learning rate',
        reason: 'slide spelling',
        kind: 'term',
      },
    ])
    const pending = listCorrections(db, note.id)
    setCorrectionStatus(db, pending[0].id, 'accepted')

    const auto = createSummary(db, note.id, 'muse-spark-1.3', 'auto', 'en')
    insertClaimsWithCitations(db, auto.id, [
      {
        idx: 0,
        text: 'The learning rate matters.',
        verdict: 'supported',
        reason: 'Stated in the transcript.',
        segmentIds: [audioSegs[0].id],
        pageIds: [pageRows[1].id],
      },
      { idx: 1, text: 'Dropout helps.', verdict: 'unsupported', reason: 'Not in sources', segmentIds: [], pageIds: [] },
    ])
    setSummaryStatus(db, auto.id, 'done')
    const check = createSummary(db, note.id, 'muse-spark-1.3', 'check', 'en')
    insertClaimsWithCitations(db, check.id, [
      {
        idx: 0,
        text: 'Loss may diverge.',
        verdict: 'supported',
        reason: 'Matches segment 2.',
        segmentIds: [audioSegs[1].id],
        pageIds: [],
      },
    ])
    setSummaryStatus(db, check.id, 'done')
    return note.id
  }

  it('serializes without ids, paths, keys or costs and validates', () => {
    const noteId = seedRichNote()
    const sample = serializeSampleNote(db, noteId)
    expect(sample.format).toBe('sample-note/v1')
    expect(sample.title).toBe('Gradient descent (sample)')
    expect(sample.language).toBe('en')
    expect(sample.sources).toHaveLength(2)
    expect(sample.sources[0]).toMatchObject({
      kind: 'audio',
      file: 'lecture.wav',
      displayName: 'lecture.wav',
      durationMs: 84_000,
    })
    expect(sample.sources[0].segments[0]).toMatchObject({
      idx: 0,
      text: 'learning rate matters',
      originalText: '러닝 레이트 matters',
    })
    expect(sample.sources[1].pages).toEqual([
      { pageNo: 1, text: 'Gradient Descent' },
      { pageNo: 2, text: 'Learning Rate' },
    ])
    expect(sample.corrections).toEqual([
      {
        sourceIndex: 0,
        segmentIdx: 0,
        before: '러닝 레이트',
        after: 'learning rate',
        reason: 'slide spelling',
        kind: 'term',
        status: 'accepted',
      },
    ])
    expect(sample.summaries.map((s) => s.kind)).toEqual(['auto', 'check'])
    expect(sample.summaries[0].claims[0].citations).toEqual([{ sourceIndex: 0, segmentIdx: 0 }])
    expect(sample.summaries[0].claims[0].pageCitations).toEqual([{ sourceIndex: 1, pageNo: 2 }])

    // No leakage: the JSON must not contain absolute paths, ids or money.
    const json = JSON.stringify(sample)
    expect(json).not.toContain(dir)
    expect(json).not.toContain('usd')
    expect(json).not.toContain('api key')

    // JSON round-trip through the validator.
    const reparsed = parseSampleNote(JSON.parse(json) as unknown)
    expect(reparsed).toEqual(sample)
  })

  it('exports only the latest summary of each kind', () => {
    const noteId = seedRichNote()
    const newer = createSummary(db, noteId, 'muse-spark-1.3', 'auto', 'en')
    insertClaimsWithCitations(db, newer.id, [
      { idx: 0, text: 'Newer claim.', verdict: 'supported', reason: 'Fresh.', segmentIds: [], pageIds: [] },
    ])
    setSummaryStatus(db, newer.id, 'done')
    const sample = serializeSampleNote(db, noteId)
    const autos = sample.summaries.filter((s) => s.kind === 'auto')
    expect(autos).toHaveLength(1)
    expect(autos[0].claims).toHaveLength(1)
    expect(autos[0].claims[0].text).toBe('Newer claim.')
  })

  it('rejects malformed sample JSON', () => {
    expect(() => parseSampleNote(null)).toThrow('Invalid sample note')
    expect(() => parseSampleNote({ format: 'other', title: 't', language: 'ko', sources: [], corrections: [], summaries: [] })).toThrow(
      'Invalid sample note',
    )
    expect(() =>
      parseSampleNote({ format: 'sample-note/v1', title: 't', language: 'xx', sources: [], corrections: [], summaries: [] }),
    ).toThrow('Invalid sample note')
    expect(() =>
      parseSampleNote({
        format: 'sample-note/v1',
        title: 't',
        language: 'ko',
        sources: [{ kind: 'audio', file: '../evil.wav', displayName: 'x', durationMs: null, segments: [], pages: [] }],
        corrections: [],
        summaries: [],
      }),
    ).toThrow('Invalid sample note')
  })

  it('imports end to end with citations resolving to the new rows', () => {
    const noteId = seedRichNote()
    const sample = serializeSampleNote(db, noteId)

    // Lay out a sample folder the way the export script writes it.
    const sampleDir = path.join(dir, 'ko-gradient-descent')
    fs.mkdirSync(sampleDir, { recursive: true })
    fs.writeFileSync(path.join(sampleDir, 'note.json'), JSON.stringify(sample), 'utf8')
    for (const source of listSources(db, noteId)) {
      fs.copyFileSync(source.original_path, path.join(sampleDir, path.basename(source.original_path)))
    }

    // Import into a fresh DB + data dir.
    const importDbFile = path.join(dir, 'imported.sqlite')
    const importDb = openDb(importDbFile)
    try {
      const dataDir = path.join(dir, 'data')
      const note = importSampleNote(importDb, sampleDir, dataDir)
      expect(note.title).toBe('Gradient descent (sample)')

      const sources = listSources(importDb, note.id)
      expect(sources).toHaveLength(2)
      expect(sources[0].status).toBe('done')
      expect(sources[0].original_path).toBe(
        path.join(dataDir, 'samples', 'ko-gradient-descent', 'lecture.wav'),
      )
      expect(fs.existsSync(sources[0].original_path)).toBe(true)

      const imported: SampleNote = serializeSampleNote(importDb, note.id)
      // Re-exporting the import reproduces everything except file locations
      // (basenames are stable) — compare with file paths normalized.
      expect({ ...imported, title: sample.title }).toEqual(sample)
      expect(listNotes(importDb)).toHaveLength(1)

      // Citations resolve to the right texts.
      const auto = getLatestSummary(importDb, note.id)
      expect(auto?.language).toBe('en')
      expect(auto?.claims[0].citations[0].text).toBe('learning rate matters')
      expect(auto?.claims[0].pageCitations[0].text).toBe('Learning Rate')
      const check = getLatestCheck(importDb, note.id)
      expect(check?.claims[0].text).toBe('Loss may diverge.')

      // Importing twice creates a second copy.
      const again = importSampleNote(importDb, sampleDir, dataDir)
      expect(again.id).not.toBe(note.id)
      expect(listNotes(importDb)).toHaveLength(2)
    } finally {
      importDb.close()
    }
  })

  it('lists only folders with a valid note.json', () => {
    const samplesDir = path.join(dir, 'notes')
    fs.mkdirSync(path.join(samplesDir, 'good'), { recursive: true })
    fs.writeFileSync(
      path.join(samplesDir, 'good', 'note.json'),
      JSON.stringify({ format: 'sample-note/v1', title: 'Good (sample)', language: 'en', sources: [], corrections: [], summaries: [] }),
      'utf8',
    )
    fs.mkdirSync(path.join(samplesDir, 'empty'), { recursive: true })
    fs.mkdirSync(path.join(samplesDir, 'broken'), { recursive: true })
    fs.writeFileSync(path.join(samplesDir, 'broken', 'note.json'), '{oops', 'utf8')
    expect(listSampleNotes(samplesDir)).toEqual([{ name: 'good', title: 'Good (sample)', language: 'en' }])
    expect(listSampleNotes(path.join(dir, 'missing'))).toEqual([])
  })
})
