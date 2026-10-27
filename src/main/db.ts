import { DatabaseSync } from 'node:sqlite'
import type {
  Claim,
  ClaimCitation,
  ClaimPageCitation,
  ClaimVerdict,
  Note,
  NotePage,
  Segment,
  Source,
  SourceStatus,
  Summary,
  SummaryStatus,
} from '../shared/types'

/**
 * SQLite layer backed by Node's built-in `node:sqlite` (DatabaseSync).
 * Verified to work both in local Node v24 (vitest / CLI) and inside
 * Electron 45 (embedded Node 24.x), so no native rebuild is needed.
 *
 * Schema is versioned with `PRAGMA user_version`; add migrations by
 * appending to MIGRATIONS (index = target version - 1). Later stages will
 * add claim/verification tables as version 2+.
 */

const MIGRATIONS: string[] = [
  // version 1
  `
  CREATE TABLE notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER NOT NULL REFERENCES notes(id),
    kind TEXT NOT NULL,
    original_path TEXT NOT NULL,
    display_name TEXT NOT NULL,
    duration_ms INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_sources_note ON sources(note_id);
  CREATE TABLE segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES sources(id),
    idx INTEGER NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    text TEXT NOT NULL,
    chunk_index INTEGER NOT NULL
  );
  CREATE INDEX idx_segments_source ON segments(source_id, idx);
  `,
  // version 2: citation-enforced summaries (stage 2)
  `
  CREATE TABLE summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER NOT NULL REFERENCES notes(id),
    model TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_summaries_note ON summaries(note_id);
  CREATE TABLE claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    summary_id INTEGER NOT NULL REFERENCES summaries(id),
    idx INTEGER NOT NULL,
    text TEXT NOT NULL,
    verdict TEXT NOT NULL,
    reason TEXT
  );
  CREATE INDEX idx_claims_summary ON claims(summary_id);
  CREATE TABLE claim_citations (
    claim_id INTEGER NOT NULL REFERENCES claims(id),
    segment_id INTEGER NOT NULL REFERENCES segments(id),
    PRIMARY KEY (claim_id, segment_id)
  );
  `,
  // version 3: PDF slides as a second evidence type (stage 3)
  `
  CREATE TABLE pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES sources(id),
    page_no INTEGER NOT NULL,
    text TEXT NOT NULL
  );
  CREATE INDEX idx_pages_source ON pages(source_id, page_no);
  CREATE TABLE claim_page_citations (
    claim_id INTEGER NOT NULL REFERENCES claims(id),
    page_id INTEGER NOT NULL REFERENCES pages(id),
    PRIMARY KEY (claim_id, page_id)
  );
  `,
  // version 4: ASR term correction proposals (stage 4a)
  `
  ALTER TABLE segments ADD COLUMN original_text TEXT;
  CREATE TABLE corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER NOT NULL REFERENCES notes(id),
    segment_id INTEGER NOT NULL REFERENCES segments(id),
    before_text TEXT NOT NULL,
    after_text TEXT NOT NULL,
    reason TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_corrections_note ON corrections(note_id, status);
  `,
  // version 5: user-notes check stored as kind='check' summaries (stage 4b)
  `
  ALTER TABLE summaries ADD COLUMN kind TEXT NOT NULL DEFAULT 'auto';
  `,
]

export function openDb(filePath: string): DatabaseSync {
  const db = new DatabaseSync(filePath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  let version = Number(row.user_version)
  while (version < MIGRATIONS.length) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[version])
      db.exec(`PRAGMA user_version = ${version + 1}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    version++
  }
}

// ---------------------------------------------------------------------------
// notes
// ---------------------------------------------------------------------------

export function createNote(db: DatabaseSync, title: string): Note {
  const created = new Date().toISOString()
  const res = db.prepare('INSERT INTO notes (title, created_at) VALUES (?, ?)').run(title, created)
  return { id: Number(res.lastInsertRowid), title, created_at: created }
}

export function listNotes(db: DatabaseSync): Note[] {
  return db.prepare('SELECT * FROM notes ORDER BY id DESC').all() as unknown as Note[]
}

export function getNote(db: DatabaseSync, id: number): Note | null {
  const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(id)
  return (row as unknown as Note) ?? null
}

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------

export function createSource(
  db: DatabaseSync,
  fields: { noteId: number; kind: string; originalPath: string; displayName: string },
): Source {
  const created = new Date().toISOString()
  const res = db
    .prepare(
      'INSERT INTO sources (note_id, kind, original_path, display_name, status, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(fields.noteId, fields.kind, fields.originalPath, fields.displayName, 'pending', created)
  return {
    id: Number(res.lastInsertRowid),
    note_id: fields.noteId,
    kind: fields.kind,
    original_path: fields.originalPath,
    display_name: fields.displayName,
    duration_ms: null,
    status: 'pending',
    error: null,
    created_at: created,
  }
}

export function getSource(db: DatabaseSync, id: number): Source | null {
  const row = db.prepare('SELECT * FROM sources WHERE id = ?').get(id)
  return (row as unknown as Source) ?? null
}

export function listSources(db: DatabaseSync, noteId: number): Source[] {
  return db
    .prepare('SELECT * FROM sources WHERE note_id = ? ORDER BY id')
    .all(noteId) as unknown as Source[]
}

export function updateSourceStatus(
  db: DatabaseSync,
  id: number,
  status: SourceStatus,
  error: string | null = null,
): void {
  db.prepare('UPDATE sources SET status = ?, error = ? WHERE id = ?').run(status, error, id)
}

export function setSourceDuration(db: DatabaseSync, id: number, durationMs: number): void {
  db.prepare('UPDATE sources SET duration_ms = ? WHERE id = ?').run(durationMs, id)
}

// ---------------------------------------------------------------------------
// segments
// ---------------------------------------------------------------------------

export interface NewSegment {
  idx: number
  startMs: number
  endMs: number
  text: string
  chunkIndex: number
}

export function insertSegments(db: DatabaseSync, sourceId: number, segments: NewSegment[]): void {
  const stmt = db.prepare(
    'INSERT INTO segments (source_id, idx, start_ms, end_ms, text, chunk_index) ' +
      'VALUES (?, ?, ?, ?, ?, ?)',
  )
  db.exec('BEGIN')
  try {
    for (const s of segments) {
      stmt.run(sourceId, s.idx, s.startMs, s.endMs, s.text, s.chunkIndex)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function listSegments(db: DatabaseSync, sourceId: number): Segment[] {
  return db
    .prepare('SELECT * FROM segments WHERE source_id = ? ORDER BY idx')
    .all(sourceId) as unknown as Segment[]
}

// ---------------------------------------------------------------------------
// summaries + claims (stage 2)
// ---------------------------------------------------------------------------

export interface SummaryRow {
  id: number
  note_id: number
  model: string
  status: SummaryStatus
  error: string | null
  created_at: string
  kind: string
}

export function createSummary(
  db: DatabaseSync,
  noteId: number,
  model: string,
  kind: 'auto' | 'check' = 'auto',
): SummaryRow {
  const created = new Date().toISOString()
  const res = db
    .prepare(
      'INSERT INTO summaries (note_id, model, status, error, created_at, kind) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(noteId, model, 'summarizing', null, created, kind)
  return {
    id: Number(res.lastInsertRowid),
    note_id: noteId,
    model,
    status: 'summarizing',
    error: null,
    created_at: created,
    kind,
  }
}

export function setSummaryStatus(
  db: DatabaseSync,
  id: number,
  status: SummaryStatus,
  error: string | null = null,
): void {
  db.prepare('UPDATE summaries SET status = ?, error = ? WHERE id = ?').run(status, error, id)
}

export interface NewClaim {
  idx: number
  text: string
  verdict: ClaimVerdict
  reason: string | null
  segmentIds: number[]
  /** Cited slide page DB ids (stage 3). Optional so stage-2 callers keep working. */
  pageIds?: number[]
}

/** Inserts claims with their citations in one transaction. Returns claim ids in order. */
export function insertClaimsWithCitations(
  db: DatabaseSync,
  summaryId: number,
  claims: NewClaim[],
): number[] {
  const claimStmt = db.prepare(
    'INSERT INTO claims (summary_id, idx, text, verdict, reason) VALUES (?, ?, ?, ?, ?)',
  )
  const citeStmt = db.prepare(
    'INSERT OR IGNORE INTO claim_citations (claim_id, segment_id) VALUES (?, ?)',
  )
  const pageCiteStmt = db.prepare(
    'INSERT OR IGNORE INTO claim_page_citations (claim_id, page_id) VALUES (?, ?)',
  )
  const ids: number[] = []
  db.exec('BEGIN')
  try {
    for (const c of claims) {
      const res = claimStmt.run(summaryId, c.idx, c.text, c.verdict, c.reason)
      const claimId = Number(res.lastInsertRowid)
      ids.push(claimId)
      for (const segmentId of c.segmentIds) {
        citeStmt.run(claimId, segmentId)
      }
      for (const pageId of c.pageIds ?? []) {
        pageCiteStmt.run(claimId, pageId)
      }
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return ids
}

export function setClaimVerdict(
  db: DatabaseSync,
  claimId: number,
  verdict: ClaimVerdict,
  reason: string | null,
): void {
  db.prepare('UPDATE claims SET verdict = ?, reason = ? WHERE id = ?').run(verdict, reason, claimId)
}

/** A note segment in note order, with its source display name for citations. */
export interface NoteSegment {
  id: number
  sourceId: number
  idx: number
  startMs: number
  endMs: number
  text: string
  displayName: string
}

/**
 * All segments of a note in order (sources by id, then segment idx).
 * Only sources with status 'done' are included.
 */
export function listNoteSegments(db: DatabaseSync, noteId: number): NoteSegment[] {
  const rows = db
    .prepare(
      'SELECT seg.id AS id, seg.source_id AS sourceId, seg.idx AS idx, ' +
        'seg.start_ms AS startMs, seg.end_ms AS endMs, seg.text AS text, ' +
        'src.display_name AS displayName ' +
        'FROM segments seg JOIN sources src ON src.id = seg.source_id ' +
        "WHERE src.note_id = ? AND src.status = 'done' " +
        'ORDER BY src.id, seg.idx',
    )
    .all(noteId) as unknown as NoteSegment[]
  return rows
}

// ---------------------------------------------------------------------------
// pages (stage 3: PDF slides as evidence)
// ---------------------------------------------------------------------------

export interface NewPage {
  pageNo: number
  text: string
}

/** Inserts page rows for a source in one transaction. Returns page ids in order. */
export function insertPages(db: DatabaseSync, sourceId: number, pages: NewPage[]): number[] {
  const stmt = db.prepare(
    'INSERT INTO pages (source_id, page_no, text) VALUES (?, ?, ?)',
  )
  const ids: number[] = []
  db.exec('BEGIN')
  try {
    for (const p of pages) {
      const res = stmt.run(sourceId, p.pageNo, p.text)
      ids.push(Number(res.lastInsertRowid))
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return ids
}

/**
 * All extracted pages of a note in order (PDF sources by id, then page_no).
 * Only sources with status 'done' are included.
 */
export function listNotePages(db: DatabaseSync, noteId: number): NotePage[] {
  const rows = db
    .prepare(
      'SELECT pg.id AS id, pg.source_id AS sourceId, pg.page_no AS pageNo, ' +
        'pg.text AS text, src.display_name AS displayName ' +
        'FROM pages pg JOIN sources src ON src.id = pg.source_id ' +
        "WHERE src.note_id = ? AND src.kind = 'pdf' AND src.status = 'done' " +
        'ORDER BY src.id, pg.page_no',
    )
    .all(noteId) as unknown as NotePage[]
  return rows
}

/**
 * Latest summary of a note with claims and their cited segments, or null.
 * `kind` selects 'auto' (generated summary) or 'check' (user-notes check).
 */
export function getLatestSummaryByKind(
  db: DatabaseSync,
  noteId: number,
  kind: 'auto' | 'check',
): Summary | null {
  const summary = db
    .prepare('SELECT * FROM summaries WHERE note_id = ? AND kind = ? ORDER BY id DESC LIMIT 1')
    .get(noteId, kind) as unknown as SummaryRow | null
  if (!summary) return null

  const claimRows = db
    .prepare('SELECT * FROM claims WHERE summary_id = ? ORDER BY idx')
    .all(summary.id) as unknown as Array<{
    id: number
    idx: number
    text: string
    verdict: ClaimVerdict
    reason: string | null
  }>

  const citeStmt = db.prepare(
    'SELECT seg.id AS segmentId, seg.source_id AS sourceId, seg.start_ms AS startMs, ' +
      'seg.end_ms AS endMs, seg.text AS text, src.display_name AS sourceDisplayName ' +
      'FROM claim_citations cc ' +
      'JOIN segments seg ON seg.id = cc.segment_id ' +
      'JOIN sources src ON src.id = seg.source_id ' +
      'WHERE cc.claim_id = ? ORDER BY seg.id',
  )
  const pageCiteStmt = db.prepare(
    'SELECT pg.id AS pageId, pg.page_no AS pageNo, pg.text AS text, ' +
      'src.id AS sourceId, src.display_name AS sourceDisplayName ' +
      'FROM claim_page_citations cc ' +
      'JOIN pages pg ON pg.id = cc.page_id ' +
      'JOIN sources src ON src.id = pg.source_id ' +
      'WHERE cc.claim_id = ? ORDER BY pg.id',
  )
  const claims: Claim[] = claimRows.map((c) => ({
    id: c.id,
    idx: c.idx,
    text: c.text,
    verdict: c.verdict,
    reason: c.reason,
    citations: citeStmt.all(c.id) as unknown as ClaimCitation[],
    pageCitations: pageCiteStmt.all(c.id) as unknown as ClaimPageCitation[],
  }))

  return {
    id: summary.id,
    noteId: summary.note_id,
    model: summary.model,
    status: summary.status,
    error: summary.error,
    createdAt: summary.created_at,
    kind: (summary.kind === 'check' ? 'check' : 'auto') as 'auto' | 'check',
    claims,
  }
}

/** Latest generated ('auto') summary of a note, or null. */
export function getLatestSummary(db: DatabaseSync, noteId: number): Summary | null {
  return getLatestSummaryByKind(db, noteId, 'auto')
}

/** Latest user-notes check ('check') of a note, or null. */
export function getLatestCheck(db: DatabaseSync, noteId: number): Summary | null {
  return getLatestSummaryByKind(db, noteId, 'check')
}

// ---------------------------------------------------------------------------
// corrections (stage 4a: ASR term-correction proposals)
// ---------------------------------------------------------------------------

export interface CorrectionRow {
  id: number
  note_id: number
  segment_id: number
  before_text: string
  after_text: string
  reason: string
  kind: string
  status: string
  created_at: string
}

export interface NewCorrection {
  segmentId: number
  beforeText: string
  afterText: string
  reason: string
  kind: 'term' | 'duplicate' | 'typo'
}

/** Deletes pending corrections of a note (re-run replaces proposals, keeps history). */
export function deletePendingCorrections(db: DatabaseSync, noteId: number): void {
  db.prepare("DELETE FROM corrections WHERE note_id = ? AND status = 'pending'").run(noteId)
}

/** Inserts validated corrections as `pending` in one transaction. Returns ids in order. */
export function insertCorrections(
  db: DatabaseSync,
  noteId: number,
  corrections: NewCorrection[],
): number[] {
  const stmt = db.prepare(
    'INSERT INTO corrections (note_id, segment_id, before_text, after_text, reason, kind, status, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const ids: number[] = []
  db.exec('BEGIN')
  try {
    for (const c of corrections) {
      const res = stmt.run(
        noteId,
        c.segmentId,
        c.beforeText,
        c.afterText,
        c.reason,
        c.kind,
        'pending',
        new Date().toISOString(),
      )
      ids.push(Number(res.lastInsertRowid))
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return ids
}

/** All corrections of a note in id order (pending first, then the rest). */
export function listCorrections(db: DatabaseSync, noteId: number): CorrectionRow[] {
  return db
    .prepare(
      "SELECT * FROM corrections WHERE note_id = ? ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, id",
    )
    .all(noteId) as unknown as CorrectionRow[]
}

export function getCorrection(db: DatabaseSync, id: number): CorrectionRow | null {
  const row = db.prepare('SELECT * FROM corrections WHERE id = ?').get(id)
  return (row as unknown as CorrectionRow) ?? null
}

export function setCorrectionStatus(
  db: DatabaseSync,
  id: number,
  status: 'accepted' | 'rejected',
): void {
  db.prepare('UPDATE corrections SET status = ? WHERE id = ?').run(status, id)
}
