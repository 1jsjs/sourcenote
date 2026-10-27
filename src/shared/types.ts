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

export type SummaryStatus = 'summarizing' | 'verifying' | 'done' | 'error'

export type ClaimVerdict = 'pending' | 'supported' | 'unsupported'

/** One cited transcript segment attached to a claim. */
export interface ClaimCitation {
  segmentId: number
  sourceId: number
  startMs: number
  endMs: number
  text: string
  sourceDisplayName: string
}

/** One cited PDF slide page attached to a claim. */
export interface ClaimPageCitation {
  pageId: number
  pageNo: number
  text: string
  sourceId: number
  sourceDisplayName: string
}

export interface Claim {
  id: number
  idx: number
  text: string
  verdict: ClaimVerdict
  reason: string | null
  citations: ClaimCitation[]
  pageCitations: ClaimPageCitation[]
}

/** One extracted PDF slide page of a note, in page order. */
export interface NotePage {
  id: number
  sourceId: number
  pageNo: number
  text: string
  displayName: string
}

export interface Summary {
  id: number
  noteId: number
  model: string
  status: SummaryStatus
  error: string | null
  createdAt: string
  claims: Claim[]
}

/** Sent over the `summary:progress` IPC channel. */
export interface SummaryProgressEvent {
  noteId: number
  summaryId: number | null
  stage: SummaryStatus
  message?: string
}

/** API exposed to the renderer as `window.sourcenote`. */
export interface SourcenoteApi {
  listNotes(): Promise<Note[]>
  createNote(title: string): Promise<Note>
  listSources(noteId: number): Promise<Source[]>
  /** Opens a file dialog, registers the source and starts the pipeline. */
  addAudioSource(noteId: number): Promise<Source | null>
  /** Opens a PDF dialog, registers the source and extracts per-page text. */
  addPdfSource(noteId: number): Promise<Source | null>
  listSegments(sourceId: number): Promise<Segment[]>
  /** All extracted PDF pages of a note in order (for page counts). */
  listPages(noteId: number): Promise<NotePage[]>
  getSpend(): Promise<{ spentUsd: number; capUsd: number }>
  onProgress(cb: (event: ProgressEvent) => void): () => void
  /** Starts the citation-enforced summary pipeline in the background. */
  runSummary(noteId: number): Promise<void>
  getLatestSummary(noteId: number): Promise<Summary | null>
  onSummaryProgress(cb: (event: SummaryProgressEvent) => void): () => void
}
