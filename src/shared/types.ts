/**
 * Types shared between main, preload and renderer. This file must not import
 * anything from main/preload/renderer so it stays usable everywhere.
 */

/** App-wide language: UI strings and AI output language together. */
export type AppLanguage = 'ko' | 'en'

export function isAppLanguage(value: unknown): value is AppLanguage {
  return value === 'ko' || value === 'en'
}

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
  /** Raw ASR text before the first accepted correction; null until then. */
  original_text: string | null
}

export type CorrectionKind = 'term' | 'duplicate' | 'typo'

export type CorrectionStatus = 'pending' | 'accepted' | 'rejected'

export interface Correction {
  id: number
  noteId: number
  segmentId: number
  beforeText: string
  afterText: string
  reason: string
  kind: CorrectionKind
  status: CorrectionStatus
  createdAt: string
  /** Denormalized for the UI: segment start time and current text. */
  startMs: number
  segmentText: string
  originalText: string | null
}

/** Sent over the `correction:progress` IPC channel. */
export interface CorrectionProgressEvent {
  noteId: number
  stage: 'correcting' | 'done' | 'error'
  message?: string
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
  /** 'auto' = generated summary, 'check' = user-notes check. */
  kind: 'auto' | 'check'
  /** Language the claims/reasons were written in. Older rows read as 'ko'. */
  language: AppLanguage
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
  /** Renames a note (title is trimmed, max 200 chars). */
  renameNote(id: number, title: string): Promise<Note>
  /** Deletes a note with all its data; returns the deleted source ids. */
  deleteNote(id: number): Promise<number[]>
  listSources(noteId: number): Promise<Source[]>
  /** Opens a file dialog, registers the source and starts the pipeline. */
  addAudioSource(noteId: number): Promise<Source | null>
  /** Opens a PDF dialog, registers the source and extracts per-page text. */
  addPdfSource(noteId: number): Promise<Source | null>
  /**
   * Registers dropped file paths: audio starts transcription, PDFs start
   * slide extraction. Returns what was added plus the ignored file names
   * (anything else); throws when nothing could be added.
   */
  addPaths(noteId: number, paths: string[]): Promise<{ added: Source[]; ignored: string[] }>
  /**
   * Resolves a renderer-side dropped File to its filesystem path
   * (Electron `webUtils.getPathForFile`). Synchronous; empty when unknown.
   */
  getPathForFile(file: unknown): string
  listSegments(sourceId: number): Promise<Segment[]>
  /** All extracted PDF pages of a note in order (for page counts). */
  listPages(noteId: number): Promise<NotePage[]>
  getSpend(): Promise<{ spentUsd: number; capUsd: number }>
  onProgress(cb: (event: ProgressEvent) => void): () => void
  /** Starts the citation-enforced summary pipeline in the background. */
  runSummary(noteId: number): Promise<void>
  getLatestSummary(noteId: number): Promise<Summary | null>
  onSummaryProgress(cb: (event: SummaryProgressEvent) => void): () => void
  /** Starts term-correction proposals in the background. */
  runCorrections(noteId: number): Promise<void>
  listCorrections(noteId: number): Promise<Correction[]>
  acceptCorrection(id: number): Promise<{ message: string | null }>
  rejectCorrection(id: number): Promise<void>
  acceptAllCorrections(noteId: number): Promise<{ accepted: number }>
  onCorrectionProgress(cb: (event: CorrectionProgressEvent) => void): () => void
  /** Checks the user's own notes sentences against the lecture evidence. */
  runCheck(noteId: number, text: string): Promise<Summary>
  getLatestCheck(noteId: number): Promise<Summary | null>
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  /** Folders under the bundled samples dir that contain a valid note.json. */
  listSamples(): Promise<SampleInfo[]>
  /** Imports a bundled sample as a new note (a second import makes a copy). */
  importSample(name: string): Promise<Note>
}

/** Persisted app settings (settings.json in the data dir). */
export interface AppSettings {
  language: AppLanguage
}

/** One bundled sample note available for offline import. */
export interface SampleInfo {
  name: string
  title: string
  language: AppLanguage
}
