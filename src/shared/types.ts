/**
 * Types shared between main, preload and renderer. This file must not import
 * anything from main/preload/renderer so it stays usable everywhere.
 */

export interface Note {
  id: number
  title: string
  created_at: string
}

export type SourceStatus = 'pending' | 'converting' | 'transcribing' | 'done' | 'error'

export interface Source {
  id: number
  note_id: number
  kind: string
  original_path: string
  display_name: string
  duration_ms: number | null
  status: SourceStatus
  error: string | null
  created_at: string
}

export interface Segment {
  id: number
  source_id: number
  idx: number
  start_ms: number
  end_ms: number
  text: string
  chunk_index: number
}

/** Sent over the `pipeline:progress` IPC channel. */
export interface ProgressEvent {
  sourceId: number
  stage: 'converting' | 'transcribing' | 'done' | 'error'
  chunk: number
  totalChunks: number
  message?: string
}

/** API exposed to the renderer as `window.sourcenote`. */
export interface SourcenoteApi {
  listNotes(): Promise<Note[]>
  createNote(title: string): Promise<Note>
  listSources(noteId: number): Promise<Source[]>
  /** Opens a file dialog, registers the source and starts the pipeline. */
  addAudioSource(noteId: number): Promise<Source | null>
  listSegments(sourceId: number): Promise<Segment[]>
  getSpend(): Promise<number>
  onProgress(cb: (event: ProgressEvent) => void): () => void
}
