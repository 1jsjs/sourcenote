import { DatabaseSync } from 'node:sqlite'
import type { Note, Segment, Source, SourceStatus } from '../shared/types'

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
