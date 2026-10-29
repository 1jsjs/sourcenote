import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { AppLanguage, Note, SampleInfo, Summary, SummaryKind } from '../shared/types'
import {
  getLatestSummaryByKind,
  listQuestionAnswers,
  getNote,
  listCorrections,
  listSegments,
  listSourcePages,
  listSources,
} from './db'

/**
 * Built-in sample notes (stage 5): a note exported as `sample-note/v1`
 * JSON plus its media files, so judges can try the app without an API key.
 * The format carries no absolute paths, DB ids, API keys or costs.
 */

export const SAMPLE_FORMAT = 'sample-note/v1'

export interface SampleSegment {
  idx: number
  startMs: number
  endMs: number
  text: string
  originalText: string | null
  chunkIndex: number
}

export interface SamplePage {
  pageNo: number
  text: string
}

export interface SampleSource {
  kind: string
  /** File name inside the sample folder (no directories). */
  file: string
  displayName: string
  durationMs: number | null
  segments: SampleSegment[]
  pages: SamplePage[]
}

export interface SampleCorrection {
  sourceIndex: number
  segmentIdx: number
  before: string
  after: string
  reason: string
  kind: 'term' | 'duplicate' | 'typo'
  status: 'pending' | 'accepted' | 'rejected'
}

export interface SampleCitation {
  sourceIndex: number
  segmentIdx: number
}

export interface SamplePageCitation {
  sourceIndex: number
  pageNo: number
}

export interface SampleClaim {
  idx: number
  text: string
  verdict: 'pending' | 'supported' | 'unsupported'
  reason: string | null
  citations: SampleCitation[]
  pageCitations: SamplePageCitation[]
}

export interface SampleSummary {
  kind: SummaryKind
  /** The question a 'qa' summary answers; absent for other kinds. */
  question?: string
  language: AppLanguage
  model: string
  status: 'summarizing' | 'verifying' | 'done' | 'error'
  claims: SampleClaim[]
}

export interface SampleNote {
  format: typeof SAMPLE_FORMAT
  title: string
  language: AppLanguage
  sources: SampleSource[]
  corrections: SampleCorrection[]
  summaries: SampleSummary[]
}

// ---------------------------------------------------------------------------
// validation (pure, unit-tested)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalid(message: string): Error {
  return new Error(`Invalid sample note: ${message}`)
}

function asString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key]
  if (typeof value !== 'string') throw invalid(`"${key}" must be a string`)
  return value
}

function asNumberOrNull(obj: Record<string, unknown>, key: string): number | null {
  const value = obj[key]
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid(`"${key}" must be a number or null`)
  }
  return value
}

function asArray(obj: Record<string, unknown>, key: string): unknown[] {
  const value = obj[key]
  if (!Array.isArray(value)) throw invalid(`"${key}" must be an array`)
  return value
}

function parseLanguage(value: unknown): AppLanguage {
  if (value !== 'ko' && value !== 'en') throw invalid('"language" must be "ko" or "en"')
  return value
}

function parseFileName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw invalid('"file" must be a non-empty string')
  if (value.includes('/') || value.includes('\\') || value === '.' || value === '..') {
    throw invalid('"file" must be a plain file name')
  }
  return value
}

function parseSegment(raw: unknown): SampleSegment {
  if (!isRecord(raw)) throw invalid('segment must be an object')
  for (const key of ['idx', 'startMs', 'endMs', 'chunkIndex'] as const) {
    if (typeof raw[key] !== 'number' || !Number.isInteger(raw[key] as number)) {
      throw invalid(`segment "${key}" must be an integer`)
    }
  }
  const text = asString(raw, 'text')
  const originalText = raw.originalText === null ? null : asString(raw, 'originalText')
  return {
    idx: raw.idx as number,
    startMs: raw.startMs as number,
    endMs: raw.endMs as number,
    text,
    originalText,
    chunkIndex: raw.chunkIndex as number,
  }
}

function parsePage(raw: unknown): SamplePage {
  if (!isRecord(raw)) throw invalid('page must be an object')
  if (typeof raw.pageNo !== 'number' || !Number.isInteger(raw.pageNo)) {
    throw invalid('page "pageNo" must be an integer')
  }
  return { pageNo: raw.pageNo, text: asString(raw, 'text') }
}

function parseSource(raw: unknown): SampleSource {
  if (!isRecord(raw)) throw invalid('source must be an object')
  return {
    kind: asString(raw, 'kind'),
    file: parseFileName(raw.file),
    displayName: asString(raw, 'displayName'),
    durationMs: asNumberOrNull(raw, 'durationMs'),
    segments: asArray(raw, 'segments').map(parseSegment),
    pages: asArray(raw, 'pages').map(parsePage),
  }
}

function parseCorrection(raw: unknown): SampleCorrection {
  if (!isRecord(raw)) throw invalid('correction must be an object')
  for (const key of ['sourceIndex', 'segmentIdx'] as const) {
    if (typeof raw[key] !== 'number' || !Number.isInteger(raw[key] as number)) {
      throw invalid(`correction "${key}" must be an integer`)
    }
  }
  if (raw.kind !== 'term' && raw.kind !== 'duplicate' && raw.kind !== 'typo') {
    throw invalid('correction "kind" must be term, duplicate or typo')
  }
  if (raw.status !== 'pending' && raw.status !== 'accepted' && raw.status !== 'rejected') {
    throw invalid('correction "status" must be pending, accepted or rejected')
  }
  return {
    sourceIndex: raw.sourceIndex as number,
    segmentIdx: raw.segmentIdx as number,
    before: asString(raw, 'before'),
    after: asString(raw, 'after'),
    reason: asString(raw, 'reason'),
    kind: raw.kind,
    status: raw.status,
  }
}

function parseClaim(raw: unknown): SampleClaim {
  if (!isRecord(raw)) throw invalid('claim must be an object')
  if (typeof raw.idx !== 'number' || !Number.isInteger(raw.idx)) {
    throw invalid('claim "idx" must be an integer')
  }
  if (raw.verdict !== 'pending' && raw.verdict !== 'supported' && raw.verdict !== 'unsupported') {
    throw invalid('claim "verdict" must be pending, supported or unsupported')
  }
  const citations = asArray(raw, 'citations').map((item) => {
    if (!isRecord(item)) throw invalid('citation must be an object')
    if (typeof item.sourceIndex !== 'number' || typeof item.segmentIdx !== 'number') {
      throw invalid('citation needs sourceIndex and segmentIdx numbers')
    }
    return { sourceIndex: item.sourceIndex, segmentIdx: item.segmentIdx }
  })
  const pageCitations = asArray(raw, 'pageCitations').map((item) => {
    if (!isRecord(item)) throw invalid('page citation must be an object')
    if (typeof item.sourceIndex !== 'number' || typeof item.pageNo !== 'number') {
      throw invalid('page citation needs sourceIndex and pageNo numbers')
    }
    return { sourceIndex: item.sourceIndex, pageNo: item.pageNo }
  })
  const reason = raw.reason === null ? null : asString(raw, 'reason')
  return {
    idx: raw.idx,
    text: asString(raw, 'text'),
    verdict: raw.verdict,
    reason,
    citations,
    pageCitations,
  }
}

function parseSummary(raw: unknown): SampleSummary {
  if (!isRecord(raw)) throw invalid('summary must be an object')
  if (raw.kind !== 'auto' && raw.kind !== 'check' && raw.kind !== 'qa') {
    throw invalid('summary "kind" must be auto, check or qa')
  }
  if (raw.kind === 'qa' && typeof raw.question !== 'string') {
    throw invalid('a qa summary needs a "question" string')
  }
  const status = raw.status
  if (status !== 'summarizing' && status !== 'verifying' && status !== 'done' && status !== 'error') {
    throw invalid('summary "status" is not a known summary status')
  }
  return {
    kind: raw.kind,
    ...(raw.kind === 'qa' ? { question: raw.question as string } : {}),
    language: parseLanguage(raw.language),
    model: asString(raw, 'model'),
    status,
    claims: asArray(raw, 'claims').map(parseClaim),
  }
}

/** Validates unknown JSON into a SampleNote. Throws on any shape mismatch. */
export function parseSampleNote(raw: unknown): SampleNote {
  if (!isRecord(raw)) throw invalid('root must be an object')
  if (raw.format !== SAMPLE_FORMAT) throw invalid(`"format" must be "${SAMPLE_FORMAT}"`)
  return {
    format: SAMPLE_FORMAT,
    title: asString(raw, 'title'),
    language: parseLanguage(raw.language),
    sources: asArray(raw, 'sources').map(parseSource),
    corrections: asArray(raw, 'corrections').map(parseCorrection),
    summaries: asArray(raw, 'summaries').map(parseSummary),
  }
}

// ---------------------------------------------------------------------------
// export: DB -> SampleNote (pure over the DB, no file IO except via caller)
// ---------------------------------------------------------------------------

/**
 * Serializes a note: sources with segments/pages, all corrections, and only
 * the latest summary of each kind. References use (sourceIndex, idx/pageNo)
 * pairs so no DB ids leak into the file.
 */
export function serializeSampleNote(db: DatabaseSync, noteId: number): SampleNote {
  const note = getNote(db, noteId)
  if (!note) throw new Error(`Note not found (id=${noteId})`)
  const sources = listSources(db, noteId)

  const segmentKeyById = new Map<number, { sourceIndex: number; segmentIdx: number }>()
  const sampleSources: SampleSource[] = sources.map((source, sourceIndex) => {
    const segments = listSegments(db, source.id).map((seg) => {
      segmentKeyById.set(seg.id, { sourceIndex, segmentIdx: seg.idx })
      return {
        idx: seg.idx,
        startMs: seg.start_ms,
        endMs: seg.end_ms,
        text: seg.text,
        originalText: seg.original_text,
        chunkIndex: seg.chunk_index,
      }
    })
    const pages = listSourcePages(db, source.id).map((p) => ({ pageNo: p.pageNo, text: p.text }))
    return {
      kind: source.kind,
      file: path.basename(source.original_path),
      displayName: source.display_name,
      durationMs: source.duration_ms,
      segments,
      pages,
    }
  })

  const corrections: SampleCorrection[] = listCorrections(db, noteId).map((c) => {
    const key = segmentKeyById.get(c.segment_id)
    if (!key) throw new Error(`Correction references an unknown segment (id=${c.segment_id})`)
    if (c.kind !== 'term' && c.kind !== 'duplicate' && c.kind !== 'typo') {
      throw new Error(`Unknown correction kind: ${c.kind}`)
    }
    if (c.status !== 'pending' && c.status !== 'accepted' && c.status !== 'rejected') {
      throw new Error(`Unknown correction status: ${c.status}`)
    }
    return {
      sourceIndex: key.sourceIndex,
      segmentIdx: key.segmentIdx,
      before: c.before_text,
      after: c.after_text,
      reason: c.reason,
      kind: c.kind,
      status: c.status,
    }
  })

  // The latest summary and check, then every answered question in order.
  const exported: Summary[] = []
  for (const kind of ['auto', 'check'] as const) {
    const summary = getLatestSummaryByKind(db, noteId, kind)
    if (summary) exported.push(summary)
  }
  exported.push(...listQuestionAnswers(db, noteId).filter((q) => q.status === 'done'))

  const summaries: SampleSummary[] = []
  for (const summary of exported) {
    summaries.push({
      kind: summary.kind,
      ...(summary.kind === 'qa' && summary.question !== null ? { question: summary.question } : {}),
      language: summary.language,
      model: summary.model,
      status: summary.status,
      claims: summary.claims.map((claim) => ({
        idx: claim.idx,
        text: claim.text,
        verdict: claim.verdict,
        reason: claim.reason,
        citations: claim.citations.map((cite) => {
          const key = segmentKeyById.get(cite.segmentId)
          if (!key) throw new Error(`Claim cites an unknown segment (id=${cite.segmentId})`)
          return { sourceIndex: key.sourceIndex, segmentIdx: key.segmentIdx }
        }),
        pageCitations: claim.pageCitations.map((cite) => ({
          // The source index is resolved from the page's source at import.
          sourceIndex: sources.findIndex((s) => s.id === cite.sourceId),
          pageNo: cite.pageNo,
        })),
      })),
    })
  }

  // The newest summary language is a good default for the note language.
  const language: AppLanguage =
    summaries.length > 0 ? summaries[summaries.length - 1].language : 'ko'
  return { format: SAMPLE_FORMAT, title: note.title, language, sources: sampleSources, corrections, summaries }
}

// ---------------------------------------------------------------------------
// import: sample folder -> fresh DB rows (all in one transaction)
// ---------------------------------------------------------------------------

/**
 * Imports a sample folder (containing note.json + media files) as a new
 * note. Media files are copied to `<dataDir>/samples/<folderName>/` so
 * `original_path` points at a stable copy. The JSON title is used as is.
 * Importing twice creates a second copy.
 */
export function importSampleNote(db: DatabaseSync, sampleDir: string, dataDir: string): Note {
  const raw = JSON.parse(fs.readFileSync(path.join(sampleDir, 'note.json'), 'utf8')) as unknown
  const sample = parseSampleNote(raw)
  const folderName = path.basename(path.resolve(sampleDir))
  const destDir = path.join(dataDir, 'samples', folderName)
  fs.mkdirSync(destDir, { recursive: true })

  // Copy media files first (outside the DB transaction).
  const copiedPaths = sample.sources.map((source) => {
    const from = path.join(sampleDir, source.file)
    const to = path.join(destDir, path.basename(source.file))
    fs.copyFileSync(from, to)
    return to
  })

  // One transaction for all rows: the db helpers manage their own
  // transactions, so the statements are inlined here instead of reusing them.
  const now = new Date().toISOString()
  db.exec('BEGIN')
  try {
    const noteRes = db
      .prepare('INSERT INTO notes (title, created_at) VALUES (?, ?)')
      .run(sample.title, now)
    const noteId = Number(noteRes.lastInsertRowid)

    // Fresh ids; citations resolve through these per-source maps.
    const segmentIdByKey = new Map<string, number>()
    const pageIdByKey = new Map<string, number>()
    const sourceStmt = db.prepare(
      'INSERT INTO sources (note_id, kind, original_path, display_name, duration_ms, status, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    const segmentStmt = db.prepare(
      'INSERT INTO segments (source_id, idx, start_ms, end_ms, text, original_text, chunk_index) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    const pageStmt = db.prepare('INSERT INTO pages (source_id, page_no, text) VALUES (?, ?, ?)')
    sample.sources.forEach((source, sourceIndex) => {
      const sourceRes = sourceStmt.run(
        noteId,
        source.kind,
        copiedPaths[sourceIndex],
        source.displayName,
        source.durationMs,
        'done',
        now,
      )
      const sourceId = Number(sourceRes.lastInsertRowid)
      for (const s of source.segments) {
        const segRes = segmentStmt.run(
          sourceId,
          s.idx,
          s.startMs,
          s.endMs,
          s.text,
          s.originalText,
          s.chunkIndex,
        )
        segmentIdByKey.set(`${sourceIndex}:${s.idx}`, Number(segRes.lastInsertRowid))
      }
      for (const p of source.pages) {
        const pageRes = pageStmt.run(sourceId, p.pageNo, p.text)
        pageIdByKey.set(`${sourceIndex}:${p.pageNo}`, Number(pageRes.lastInsertRowid))
      }
    })

    const correctionStmt = db.prepare(
      'INSERT INTO corrections (note_id, segment_id, before_text, after_text, reason, kind, status, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const c of sample.corrections) {
      const segmentId = segmentIdByKey.get(`${c.sourceIndex}:${c.segmentIdx}`)
      if (segmentId === undefined) {
        throw new Error(`Sample correction references unknown segment ${c.sourceIndex}:${c.segmentIdx}`)
      }
      correctionStmt.run(noteId, segmentId, c.before, c.after, c.reason, c.kind, c.status, now)
    }

    const summaryStmt = db.prepare(
      'INSERT INTO summaries (note_id, model, status, error, created_at, kind, language, question) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    const claimStmt = db.prepare(
      'INSERT INTO claims (summary_id, idx, text, verdict, reason) VALUES (?, ?, ?, ?, ?)',
    )
    const citeStmt = db.prepare(
      'INSERT OR IGNORE INTO claim_citations (claim_id, segment_id) VALUES (?, ?)',
    )
    const pageCiteStmt = db.prepare(
      'INSERT OR IGNORE INTO claim_page_citations (claim_id, page_id) VALUES (?, ?)',
    )
    for (const sampleSummary of sample.summaries) {
      const summaryRes = summaryStmt.run(
        noteId,
        sampleSummary.model,
        sampleSummary.status,
        null,
        now,
        sampleSummary.kind,
        sampleSummary.language,
        sampleSummary.question ?? null,
      )
      const summaryId = Number(summaryRes.lastInsertRowid)
      for (const claim of sampleSummary.claims) {
        const claimRes = claimStmt.run(summaryId, claim.idx, claim.text, claim.verdict, claim.reason)
        const claimId = Number(claimRes.lastInsertRowid)
        for (const cite of claim.citations) {
          const id = segmentIdByKey.get(`${cite.sourceIndex}:${cite.segmentIdx}`)
          if (id === undefined) {
            throw new Error(`Sample claim cites unknown segment ${cite.sourceIndex}:${cite.segmentIdx}`)
          }
          citeStmt.run(claimId, id)
        }
        for (const cite of claim.pageCitations) {
          const id = pageIdByKey.get(`${cite.sourceIndex}:${cite.pageNo}`)
          if (id === undefined) {
            throw new Error(`Sample claim cites unknown page ${cite.sourceIndex}:${cite.pageNo}`)
          }
          pageCiteStmt.run(claimId, id)
        }
      }
    }

    db.exec('COMMIT')
    const created = getNote(db, noteId)
    if (!created) throw new Error('Sample import failed: note missing after commit')
    return created
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // Already rolled back; fall through to the original error.
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

/**
 * Resolves the bundled-samples directory. In dev it lives next to the repo
 * (`<appPath>/samples/notes`); a packaged build can later point at
 * `process.resourcesPath` via the `packaged` flag.
 */
export function resolveSamplesDir(opts: {
  appPath: string
  resourcesPath?: string
  packaged?: boolean
}): string {
  if (opts.packaged && opts.resourcesPath) {
    return path.join(opts.resourcesPath, 'samples', 'notes')
  }
  return path.join(opts.appPath, 'samples', 'notes')
}

/** Lists sample folders that contain a valid note.json (title + language). */
export function listSampleNotes(samplesDir: string): SampleInfo[] {
  let entries: string[]
  try {
    entries = fs.readdirSync(samplesDir)
  } catch {
    return []
  }
  const found: SampleInfo[] = []
  for (const name of entries.sort()) {
    const noteFile = path.join(samplesDir, name, 'note.json')
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(noteFile, 'utf8')) as unknown
    } catch {
      continue
    }
    try {
      const sample = parseSampleNote(raw)
      found.push({ name, title: sample.title, language: sample.language })
    } catch {
      // Folders without a valid note.json are not samples.
    }
  }
  return found
}
