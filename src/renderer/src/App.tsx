import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from 'react'
import type {
  AppLanguage,
  Claim,
  Correction,
  CorrectionProgressEvent,
  Note,
  NotePage,
  ProgressEvent,
  SampleInfo,
  Segment,
  Source,
  SourceStatus,
  Summary,
  SummaryProgressEvent,
} from '../../shared/types'
import AudioPlayer from './AudioPlayer'
import SlidePanel from './SlidePanel'
import { sampleLanguageLabel, t, type MessageKey } from './i18n'

/** Small inline icons drawn for this app (no icon font, no remote assets). */
function WaveformIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="1.5" y="5" width="2" height="4" rx="1" fill="currentColor" />
      <rect x="4.5" y="2.5" width="2" height="9" rx="1" fill="currentColor" />
      <rect x="7.5" y="4" width="2" height="6" rx="1" fill="currentColor" />
      <rect x="10.5" y="5.5" width="2" height="3" rx="1" fill="currentColor" />
    </svg>
  )
}

function PageIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M3 1.5h5.5L11.5 4.5v8H3v-11z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M8.5 1.5v3h3" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M2.5 7.5l3.2 3.2L11.5 4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M3.5 3.5l7 7M10.5 3.5l-7 7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}

function ChevronIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M5 3l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Neutral citation chip with a hover/focus preview card. The card shows the
 * quoted source text already in the summary DTO; clicking jumps to it.
 */
function CiteChip({
  kind,
  label,
  cardTitle,
  cardRange,
  cardQuote,
  hint,
  onActivate,
}: {
  kind: 'time' | 'page'
  label: string
  cardTitle: string
  cardRange: string
  cardQuote: string
  hint: string
  onActivate: () => void
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const place = useCallback(() => {
    const rect = btnRef.current?.getBoundingClientRect()
    if (!rect) return
    const width = 320
    const height = 240
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
    let top = rect.bottom + 8
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 8)
    setPos({ top, left })
  }, [])

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )

  return (
    <span
      className="chip-wrap"
      onMouseEnter={() => {
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          place()
          setOpen(true)
        }, 250)
      }}
      onMouseLeave={() => {
        if (timer.current !== null) clearTimeout(timer.current)
        setOpen(false)
      }}
    >
      <button
        ref={btnRef}
        className={kind === 'time' ? 'cite-chip' : 'page-chip'}
        onFocus={() => {
          place()
          setOpen(true)
        }}
        onBlur={() => setOpen(false)}
        onClick={() => {
          setOpen(false)
          onActivate()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false)
        }}
      >
        <span className="chip-icon" aria-hidden="true">
          {kind === 'time' ? <WaveformIcon /> : <PageIcon />}
        </span>
        {label}
      </button>
      {open && (
        <span className="chip-card" role="tooltip" style={{ top: pos.top, left: pos.left }}>
          <p className="chip-card-title">{cardTitle}</p>
          <p className="chip-card-range">{cardRange}</p>
          <p className="chip-card-quote">{cardQuote}</p>
          <p className="chip-card-hint">{hint}</p>
        </span>
      )}
    </span>
  )
}

function ClaimList({
  lang,
  claims,
  reveal,
  pulsedId,
  onCiteSegment,
  onCitePage,
}: {
  lang: AppLanguage
  claims: Claim[]
  /** True only right after a verification run finished (progress event). */
  reveal: boolean
  /** Claim id currently pulsing from the evidence-bar stepper, if any. */
  pulsedId: number | null
  onCiteSegment: (sourceId: number, segmentId: number, startMs: number) => void
  onCitePage: (sourceId: number, pageNo: number, displayName: string) => void
}) {
  return (
    <ul className={reveal ? 'claims reveal' : 'claims'}>
      {claims.map((claim, idx) => {
        const unsupported = claim.verdict === 'unsupported'
        const pending = claim.verdict === 'pending'
        return (
          <li
            key={claim.id}
            id={`claim-${claim.id}`}
            className={pulsedId === claim.id ? 'claim pulse' : 'claim'}
            style={{ '--i': idx } as CSSProperties}
          >
            <span className="gutter" aria-hidden="true">
              {!pending &&
                (unsupported ? (
                  <span className="mark-no">
                    <XIcon />
                  </span>
                ) : (
                  <span className="mark-ok">
                    <CheckIcon />
                  </span>
                ))}
            </span>
            <span className="margin-line" aria-hidden="true" />
            <div className="claim-body">
              <span
                className={
                  unsupported
                    ? 'claim-text claim-text-unsupported'
                    : pending
                      ? 'claim-text claim-pending'
                      : 'claim-text'
                }
              >
                {claim.text}
              </span>
              {unsupported && (
                <span className="claim-label">{t(lang, 'notInSources')}</span>
              )}
              {(claim.citations.length > 0 || claim.pageCitations.length > 0) && (
                <div className="chips">
                  {claim.citations.map((cite) => (
                    <CiteChip
                      key={cite.segmentId}
                      kind="time"
                      label={formatShort(cite.startMs)}
                      cardTitle={cite.sourceDisplayName}
                      cardRange={`${formatShort(cite.startMs)}–${formatShort(cite.endMs)}`}
                      cardQuote={cite.text}
                      hint={t(lang, 'chipPlayHint')}
                      onActivate={() => onCiteSegment(cite.sourceId, cite.segmentId, cite.startMs)}
                    />
                  ))}
                  {claim.pageCitations.map((cite) => (
                    <CiteChip
                      key={cite.pageId}
                      kind="page"
                      label={`p.${cite.pageNo}`}
                      cardTitle={cite.sourceDisplayName}
                      cardRange={`p.${cite.pageNo}`}
                      cardQuote={cite.text.slice(0, 280)}
                      hint={t(lang, 'chipSlideHint')}
                      onActivate={() => onCitePage(cite.sourceId, cite.pageNo, cite.sourceDisplayName)}
                    />
                  ))}
                </div>
              )}
              {unsupported && claim.reason !== null && (
                <div className="claim-reason">{claim.reason}</div>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * "13 sentences · 11 cited and verified · 2 not in sources". The red count
 * is a button that steps through the flagged sentences.
 */
function EvidenceBar({
  lang,
  claims,
  onStepFlag,
}: {
  lang: AppLanguage
  claims: Claim[]
  onStepFlag: (claimId: number) => void
}) {
  const flaggedIds = claims.filter((c) => c.verdict === 'unsupported').map((c) => c.id)
  const supported = claims.filter((c) => c.verdict === 'supported').length
  const cursor = useRef(0)
  return (
    <p className="evidence-bar">
      <span>{t(lang, 'evidenceSentences', { count: claims.length })}</span>
      <span className="evidence-sep" aria-hidden="true">
        ·
      </span>
      <span>{t(lang, 'evidenceCited', { count: supported })}</span>
      <span className="evidence-sep" aria-hidden="true">
        ·
      </span>
      {flaggedIds.length > 0 ? (
        <button
          className="evidence-flag"
          onClick={() => {
            const next = flaggedIds[cursor.current % flaggedIds.length]
            cursor.current += 1
            onStepFlag(next)
          }}
        >
          {t(lang, 'evidenceFlagged', { count: flaggedIds.length })}
        </button>
      ) : (
        <span>{t(lang, 'evidenceFlagged', { count: 0 })}</span>
      )}
    </p>
  )
}

/** Running-progress text with a CSS-only animated ellipsis. */
function ProgressText({ text }: { text: string }) {
  const stripped = text.replace(/…+$/u, '').replace(/\s*\.+$/, '')
  if (stripped === text) return <>{text}</>
  return (
    <>
      {stripped}
      <span className="ellipsis" aria-hidden="true" />
    </>
  )
}

const STATUS_KEY: Record<SourceStatus, MessageKey> = {
  pending: 'statusPending',
  converting: 'statusConverting',
  transcribing: 'statusTranscribing',
  done: 'statusDone',
  error: 'statusError',
}

/**
 * Short clock time for chips and stamps: `12:34`, or `1:02:15` past an hour.
 */
function formatShort(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

const IS_MAC =
  typeof navigator !== 'undefined' &&
  (/Mac/.test(navigator.platform) || /Macintosh/.test(navigator.userAgent))

export default function App() {
  const [lang, setLang] = useState<AppLanguage>('ko')
  const [notes, setNotes] = useState<Note[]>([])
  const [selectedNoteId, setSelectedNoteId] = useState<number | null>(null)
  const [sources, setSources] = useState<Source[]>([])
  const [segmentsBySource, setSegmentsBySource] = useState<Record<number, Segment[]>>({})
  const [spend, setSpend] = useState({ spentUsd: 0, capUsd: 100 })
  const [progressBySource, setProgressBySource] = useState<Record<number, ProgressEvent>>({})
  const [newTitle, setNewTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [summaryRunning, setSummaryRunning] = useState(false)
  const [summaryStage, setSummaryStage] = useState<SummaryProgressEvent['stage'] | null>(null)
  const [corrections, setCorrections] = useState<Correction[]>([])
  const [correctionsRunning, setCorrectionsRunning] = useState(false)
  const [correctionStage, setCorrectionStage] = useState<CorrectionProgressEvent['stage'] | null>(null)
  const [correctionsOpen, setCorrectionsOpen] = useState(true)
  const [checkText, setCheckText] = useState('')
  const [checkResult, setCheckResult] = useState<Summary | null>(null)
  const [checkRunning, setCheckRunning] = useState(false)
  const [highlightedSegmentId, setHighlightedSegmentId] = useState<number | null>(null)
  const [pages, setPages] = useState<NotePage[]>([])
  const [playerSourceId, setPlayerSourceId] = useState<number | null>(null)
  const [playerStartMs, setPlayerStartMs] = useState(0)
  const [playToken, setPlayToken] = useState(0)
  const [activeSegmentId, setActiveSegmentId] = useState<number | null>(null)
  const [samples, setSamples] = useState<SampleInfo[]>([])
  const [showSamples, setShowSamples] = useState(false)
  const [importingSample, setImportingSample] = useState(false)
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null)
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameText, setRenameText] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Note | null>(null)
  const renameDone = useRef(false)
  const [rightTab, setRightTab] = useState<'transcript' | 'slides'>('transcript')
  const [slideSel, setSlideSel] = useState<{
    sourceId: number
    pageNo: number
    displayName: string
  } | null>(null)
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Summary id whose verification just finished live (drives the reveal). */
  const [revealedSummaryId, setRevealedSummaryId] = useState<number | null>(null)
  /** True right after a notes check finished live (drives the reveal). */
  const [checkReveal, setCheckReveal] = useState(false)
  /** Claim id briefly pulsing from the evidence-bar stepper, if any. */
  const [pulsedClaimId, setPulsedClaimId] = useState<number | null>(null)
  /** True while files are dragged over the note view. */
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)

  const refreshSpend = useCallback(async () => {
    setSpend(await window.sourcenote.getSpend())
  }, [])

  const refreshNotes = useCallback(async () => {
    setNotes(await window.sourcenote.listNotes())
  }, [])

  const refreshSamples = useCallback(async () => {
    setSamples(await window.sourcenote.listSamples())
  }, [])

  const refreshSources = useCallback(async (noteId: number) => {
    const list = await window.sourcenote.listSources(noteId)
    setSources(list)
    const done = list.filter((s) => s.status === 'done')
    const entries = await Promise.all(
      done.map(async (s) => [s.id, await window.sourcenote.listSegments(s.id)] as const),
    )
    setSegmentsBySource(Object.fromEntries(entries))
    setPages(await window.sourcenote.listPages(noteId))
  }, [])

  useEffect(() => {
    void window.sourcenote.getSettings().then((s) => setLang(s.language))
    void refreshNotes()
    void refreshSpend()
    void refreshSamples()
  }, [refreshNotes, refreshSpend, refreshSamples])

  const handleSwitchLanguage = async (next: AppLanguage): Promise<void> => {
    if (next === lang) return
    setLang(next)
    try {
      const saved = await window.sourcenote.setSettings({ language: next })
      setLang(saved.language)
    } catch (err) {
      setLang(lang)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleImportSample = async (name: string): Promise<void> => {
    setError(null)
    setImportingSample(true)
    try {
      const note = await window.sourcenote.importSample(name)
      await refreshNotes()
      setSelectedNoteId(note.id)
      setShowSamples(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setImportingSample(false)
    }
  }

  const refreshSummary = useCallback(async (noteId: number) => {
    setSummary(await window.sourcenote.getLatestSummary(noteId))
  }, [])

  const refreshCorrections = useCallback(async (noteId: number) => {
    setCorrections(await window.sourcenote.listCorrections(noteId))
  }, [])

  const refreshCheck = useCallback(async (noteId: number) => {
    setCheckResult(await window.sourcenote.getLatestCheck(noteId))
  }, [])

  useEffect(() => {
    if (selectedNoteId !== null) {
      void refreshSources(selectedNoteId)
      void refreshSummary(selectedNoteId)
      void refreshCorrections(selectedNoteId)
      void refreshCheck(selectedNoteId)
    } else {
      setSources([])
      setSegmentsBySource({})
      setSummary(null)
      setCorrections([])
      setCheckResult(null)
      setCheckText('')
      setPages([])
      setPlayerSourceId(null)
      setActiveSegmentId(null)
      setSlideSel(null)
      setRightTab('transcript')
    }
    setSummaryRunning(false)
    setSummaryStage(null)
    setCorrectionsRunning(false)
    setCorrectionStage(null)
    setCheckRunning(false)
    // Opening a note is static: never replay the verification reveal.
    setRevealedSummaryId(null)
    setCheckReveal(false)
    setPulsedClaimId(null)
    setDragging(false)
    dragDepth.current = 0
  }, [selectedNoteId, refreshSources, refreshSummary, refreshCorrections, refreshCheck])

  useEffect(() => {
    const unsubscribe = window.sourcenote.onProgress((event) => {
      setProgressBySource((prev) => ({ ...prev, [event.sourceId]: event }))
      if (event.stage === 'done' || event.stage === 'error') {
        if (event.stage === 'error' && event.message) setError(event.message)
        if (selectedNoteId !== null) void refreshSources(selectedNoteId)
        void refreshSpend()
      }
    })
    return unsubscribe
  }, [selectedNoteId, refreshSources, refreshSpend])

  useEffect(() => {
    const unsubscribe = window.sourcenote.onSummaryProgress((event) => {
      if (event.noteId !== selectedNoteId) return
      setSummaryStage(event.stage)
      if (event.stage === 'done' || event.stage === 'error') {
        setSummaryRunning(false)
        if (event.stage === 'error' && event.message) setError(event.message)
        // A live finish animates the reveal once; opening a note stays static.
        if (event.stage === 'done' && event.summaryId !== null) {
          setRevealedSummaryId(event.summaryId)
        }
        void refreshSummary(event.noteId)
        void refreshSpend()
      }
    })
    return unsubscribe
  }, [selectedNoteId, refreshSummary, refreshSpend])

  useEffect(() => {
    const unsubscribe = window.sourcenote.onCorrectionProgress((event) => {
      if (event.noteId !== selectedNoteId) return
      setCorrectionStage(event.stage)
      if (event.stage === 'done' || event.stage === 'error') {
        setCorrectionsRunning(false)
        if (event.stage === 'error' && event.message) setError(event.message)
        void refreshCorrections(event.noteId)
        void refreshSpend()
      }
    })
    return unsubscribe
  }, [selectedNoteId, refreshCorrections, refreshSpend])

  useEffect(
    () => () => {
      if (highlightTimer.current !== null) clearTimeout(highlightTimer.current)
      if (pulseTimer.current !== null) clearTimeout(pulseTimer.current)
    },
    [],
  )

  const handleRenameStart = (note: Note): void => {
    renameDone.current = false
    setRenameText(note.title)
    setRenamingId(note.id)
    setMenuOpenId(null)
  }

  const handleRenameCancel = (): void => {
    renameDone.current = true
    setRenamingId(null)
  }

  const handleRenameSave = async (id: number): Promise<void> => {
    // Enter and blur can fire for the same edit; save only once.
    if (renameDone.current) return
    renameDone.current = true
    setRenamingId(null)
    setError(null)
    try {
      const updated = await window.sourcenote.renameNote(id, renameText)
      setNotes((prev) => prev.map((n) => (n.id === id ? updated : n)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleDeleteConfirm = async (): Promise<void> => {
    if (deleteTarget === null) return
    const id = deleteTarget.id
    setError(null)
    try {
      await window.sourcenote.deleteNote(id)
      const idx = notes.findIndex((n) => n.id === id)
      setNotes(notes.filter((n) => n.id !== id))
      if (selectedNoteId === id) {
        // Select the next note, or none (empty state) when it was the last.
        const next = notes[idx + 1] ?? notes[idx - 1] ?? null
        setSelectedNoteId(next ? next.id : null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleteTarget(null)
    }
  }

  const handleCreateNote = async (): Promise<void> => {
    const title = newTitle.trim()
    if (title.length === 0) return
    setError(null)
    try {
      const note = await window.sourcenote.createNote(title)
      setNewTitle('')
      await refreshNotes()
      setSelectedNoteId(note.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleAddAudio = async (): Promise<void> => {
    if (selectedNoteId === null) return
    setError(null)
    try {
      const source = await window.sourcenote.addAudioSource(selectedNoteId)
      if (source) await refreshSources(selectedNoteId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleAddPdf = async (): Promise<void> => {
    if (selectedNoteId === null) return
    setError(null)
    try {
      const source = await window.sourcenote.addPdfSource(selectedNoteId)
      if (source) await refreshSources(selectedNoteId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleRunSummary = async (): Promise<void> => {
    if (selectedNoteId === null) return
    setError(null)
    setSummaryRunning(true)
    setSummaryStage('summarizing')
    try {
      await window.sourcenote.runSummary(selectedNoteId)
    } catch (err) {
      setSummaryRunning(false)
      setSummaryStage(null)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleRunCorrections = async (): Promise<void> => {
    if (selectedNoteId === null) return
    setError(null)
    setCorrectionsRunning(true)
    setCorrectionStage('correcting')
    try {
      await window.sourcenote.runCorrections(selectedNoteId)
    } catch (err) {
      setCorrectionsRunning(false)
      setCorrectionStage(null)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const refreshAfterCorrectionChange = async (noteId: number): Promise<void> => {
    await refreshCorrections(noteId)
    await refreshSources(noteId)
  }

  const handleAcceptCorrection = async (id: number): Promise<void> => {
    if (selectedNoteId === null) return
    setError(null)
    try {
      const { message } = await window.sourcenote.acceptCorrection(id)
      if (message !== null) setError(message)
      await refreshAfterCorrectionChange(selectedNoteId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleRejectCorrection = async (id: number): Promise<void> => {
    if (selectedNoteId === null) return
    setError(null)
    try {
      await window.sourcenote.rejectCorrection(id)
      await refreshCorrections(selectedNoteId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleAcceptAllCorrections = async (): Promise<void> => {
    if (selectedNoteId === null) return
    setError(null)
    try {
      await window.sourcenote.acceptAllCorrections(selectedNoteId)
      await refreshAfterCorrectionChange(selectedNoteId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleRunCheck = async (): Promise<void> => {
    if (selectedNoteId === null || checkText.trim().length === 0) return
    setError(null)
    setCheckRunning(true)
    setCheckReveal(false)
    try {
      const result = await window.sourcenote.runCheck(selectedNoteId, checkText)
      setCheckResult(result)
      // A live finish animates the reveal once.
      setCheckReveal(true)
      await refreshSpend()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCheckRunning(false)
    }
  }

  const highlightSegment = (segmentId: number): void => {
    // The transcript lives in the right pane; scroll the row to the center.
    requestAnimationFrame(() => {
      const element = document.getElementById(`segment-${segmentId}`)
      if (element) {
        element.scrollIntoView({ block: 'center', behavior: 'smooth' })
        setHighlightedSegmentId(segmentId)
        if (highlightTimer.current !== null) clearTimeout(highlightTimer.current)
        highlightTimer.current = setTimeout(() => setHighlightedSegmentId(null), 2000)
      }
    })
  }

  /** Evidence-bar stepper: scroll to a flagged sentence and briefly pulse it. */
  const stepToClaim = (claimId: number): void => {
    requestAnimationFrame(() => {
      document
        .getElementById(`claim-${claimId}`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      setPulsedClaimId(claimId)
      if (pulseTimer.current !== null) clearTimeout(pulseTimer.current)
      pulseTimer.current = setTimeout(() => setPulsedClaimId(null), 1200)
    })
  }

  /** Registers files dropped onto the note view via the preload path resolver. */
  const handleDropFiles = async (noteId: number, files: File[]): Promise<void> => {
    const paths = files
      .map((file) => window.sourcenote.getPathForFile(file))
      .filter((p) => p.length > 0)
    if (paths.length === 0) return
    setError(null)
    try {
      const { ignored } = await window.sourcenote.addPaths(noteId, paths)
      await refreshSources(noteId)
      if (ignored.length > 0) {
        setError(t(lang, 'dropIgnored', { names: ignored.join(', ') }))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      await refreshSources(noteId)
    }
  }

  const handleDragEnter = (e: DragEvent<HTMLElement>): void => {
    if (selectedNoteId === null || !e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }

  const handleDragLeave = (e: DragEvent<HTMLElement>): void => {
    if (selectedNoteId === null) return
    e.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }

  const handleDragOver = (e: DragEvent<HTMLElement>): void => {
    if (selectedNoteId === null || !e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
  }

  const handleDrop = (e: DragEvent<HTMLElement>): void => {
    if (selectedNoteId === null) return
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    if (!e.dataTransfer.types.includes('Files')) return
    void handleDropFiles(selectedNoteId, Array.from(e.dataTransfer.files))
  }

  /** Switches the player to the segment's source if needed, seeks and plays. */
  const playSegment = useCallback((sourceId: number, startMs: number): void => {
    setPlayerSourceId(sourceId)
    setPlayerStartMs(startMs)
    setPlayToken((tok) => tok + 1)
  }, [])

  /** Finds which source a segment belongs to (correction chips only carry segmentId). */
  const sourceIdOfSegment = (segmentId: number): number | null => {
    for (const [sourceId, segments] of Object.entries(segmentsBySource)) {
      if (segments.some((s) => s.id === segmentId)) return Number(sourceId)
    }
    return null
  }

  const handleCiteClick = (sourceId: number, segmentId: number, startMs: number): void => {
    setRightTab('transcript')
    playSegment(sourceId, startMs)
    highlightSegment(segmentId)
  }

  const handleTimestampClick = (sourceId: number, segmentId: number, startMs: number): void => {
    playSegment(sourceId, startMs)
    highlightSegment(segmentId)
  }

  const handlePageCiteClick = (sourceId: number, pageNo: number, displayName: string): void => {
    setSlideSel({ sourceId, pageNo, displayName })
    setRightTab('slides')
  }

  const handlePlayerTime = useCallback(
    (sourceId: number, currentMs: number): void => {
      const segments = segmentsBySource[sourceId] ?? []
      const active = segments.find((s) => s.start_ms <= currentMs && currentMs < s.end_ms)
      setActiveSegmentId(active?.id ?? null)
    },
    [segmentsBySource],
  )

  const doneAudioSources = sources.filter((s) => s.kind === 'audio' && s.status === 'done')
  const audioSources = sources.filter((s) => s.kind === 'audio')
  const pdfDoneSources = sources.filter((s) => s.kind === 'pdf' && s.status === 'done')
  const playerSource =
    doneAudioSources.find((s) => s.id === playerSourceId) ?? doneAudioSources[0] ?? null
  const pageCountBySource = new Map<number, number>()
  for (const p of pages) {
    pageCountBySource.set(p.sourceId, (pageCountBySource.get(p.sourceId) ?? 0) + 1)
  }
  const shownSegmentId = highlightedSegmentId ?? activeSegmentId
  const correctionKindLabel: Record<Correction['kind'], string> = {
    term: t(lang, 'kindTerm'),
    duplicate: t(lang, 'kindDuplicate'),
    typo: t(lang, 'kindTypo'),
  }
  const selectedNote = notes.find((n) => n.id === selectedNoteId) ?? null
  const transcriptRowCount = audioSources.reduce(
    (n, s) => n + (segmentsBySource[s.id]?.length ?? 0),
    0,
  )
  const effectiveSlide =
    slideSel !== null && pdfDoneSources.some((s) => s.id === slideSel.sourceId)
      ? slideSel
      : pdfDoneSources.length > 0
        ? {
            sourceId: pdfDoneSources[0].id,
            pageNo: 1,
            displayName: pdfDoneSources[0].display_name,
          }
        : null

  const sampleList = (
    <ul className="sample-list">
      {samples.map((sample) => (
        <li key={sample.name}>
          <button disabled={importingSample} onClick={() => void handleImportSample(sample.name)}>
            {sample.title} ({sampleLanguageLabel(lang, sample.language)})
          </button>
        </li>
      ))}
      {samples.length === 0 && <li className="empty">{t(lang, 'noSamples')}</li>}
    </ul>
  )

  const sourcePill = (source: Source): ReactNode => {
    const progress = progressBySource[source.id]
    const isAudio = source.kind === 'audio'
    const meta =
      isAudio && source.duration_ms !== null
        ? formatShort(source.duration_ms)
        : !isAudio && source.status === 'done'
          ? t(lang, 'slidesLabel', { count: pageCountBySource.get(source.id) ?? 0 })
          : null
    const active = source.status === 'transcribing' || source.status === 'converting'
    const showProgress = active && progress !== undefined && progress.totalChunks > 0
    const pct =
      progress !== undefined && progress.totalChunks > 0
        ? Math.min(100, (progress.chunk / progress.totalChunks) * 100)
        : 0
    return (
      <span
        key={source.id}
        className="source-pill"
        title={
          source.status === 'error' && source.error !== null
            ? source.error
            : source.display_name
        }
      >
        <span
          className="source-icon"
          role="img"
          aria-label={isAudio ? t(lang, 'audioLabel') : t(lang, 'pdfLabel')}
        >
          {isAudio ? <WaveformIcon /> : <PageIcon />}
        </span>
        <span className="pill-name">{source.display_name}</span>
        {meta !== null && <span className="pill-meta">{meta}</span>}
        <span
          className={
            source.status === 'done'
              ? 'pill-status done'
              : source.status === 'error'
                ? 'pill-status error'
                : 'pill-status busy'
          }
        >
          {showProgress && progress !== undefined
            ? t(lang, 'transcribingProgress', {
                done: progress.chunk,
                total: progress.totalChunks,
              })
            : t(lang, STATUS_KEY[source.status])}
        </span>
        {showProgress && (
          <span className="source-progress" aria-hidden="true">
            <span style={{ width: `${pct}%` }} />
          </span>
        )}
      </span>
    )
  }

  const transcriptView = (
    <>
      {audioSources.length === 0 || transcriptRowCount === 0 ? (
        <p className="empty">{t(lang, 'noTranscript')}</p>
      ) : (
        audioSources.map((source) => {
          const segments = segmentsBySource[source.id] ?? []
          if (segments.length === 0) return null
          return (
            <div key={source.id}>
              {audioSources.length > 1 && (
                <p className="seg-group-label">{source.display_name}</p>
              )}
              <ul className="segments">
                {segments.map((seg) => (
                  <li
                    key={seg.id}
                    id={`segment-${seg.id}`}
                    data-segment-id={seg.id}
                    className={seg.id === shownSegmentId ? 'highlight' : undefined}
                  >
                    <button
                      className="seg-time"
                      title={t(lang, 'playFromHere')}
                      onClick={() => handleTimestampClick(source.id, seg.id, seg.start_ms)}
                    >
                      {formatShort(seg.start_ms)}–{formatShort(seg.end_ms)}
                    </button>{' '}
                    {seg.original_text !== null && (
                      <span
                        className="corrected-mark"
                        title={t(lang, 'correctedTitle', { text: seg.original_text })}
                      >
                        {t(lang, 'correctedMark')}
                      </span>
                    )}{' '}
                    {seg.text}
                  </li>
                ))}
              </ul>
            </div>
          )
        })
      )}
    </>
  )

  const slidesView = (
    <>
      {effectiveSlide === null ? (
        <p className="empty">{t(lang, 'noSlides')}</p>
      ) : (
        <>
          {pdfDoneSources.length > 1 && (
            <div className="pdf-select-row">
              <select
                aria-label={t(lang, 'selectPdf')}
                value={effectiveSlide.sourceId}
                onChange={(e) => {
                  const id = Number(e.target.value)
                  const found = pdfDoneSources.find((s) => s.id === id)
                  if (found) {
                    setSlideSel({ sourceId: found.id, pageNo: 1, displayName: found.display_name })
                  }
                }}
              >
                {pdfDoneSources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.display_name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <SlidePanel
            lang={lang}
            sourceId={effectiveSlide.sourceId}
            pageNo={effectiveSlide.pageNo}
            displayName={effectiveSlide.displayName}
            totalPages={pageCountBySource.get(effectiveSlide.sourceId) ?? effectiveSlide.pageNo}
            onNavigate={(pageNo) =>
              setSlideSel({
                sourceId: effectiveSlide.sourceId,
                pageNo,
                displayName: effectiveSlide.displayName,
              })
            }
          />
        </>
      )}
    </>
  )

  return (
    <div className="app">
      <header className={IS_MAC ? 'header mac' : 'header'}>
        <h1 className="wordmark">{t(lang, 'appTitle')}</h1>
        <span className="tagline">{t(lang, 'tagline')}</span>
        <span className="header-spacer" />
        <span className="spend">
          ${spend.spentUsd.toFixed(4)} / ${spend.capUsd}
        </span>
        <div className="lang-toggle" role="group" aria-label="Language / 언어">
          <button
            className={lang === 'ko' ? 'lang-option selected' : 'lang-option'}
            onClick={() => void handleSwitchLanguage('ko')}
          >
            한국어
          </button>
          <button
            className={lang === 'en' ? 'lang-option selected' : 'lang-option'}
            onClick={() => void handleSwitchLanguage('en')}
          >
            English
          </button>
        </div>
      </header>

      {error !== null && (
        <div className="error-banner" role="alert">
          {error}
          <button className="error-close" onClick={() => setError(null)}>
            {t(lang, 'close')}
          </button>
        </div>
      )}

      <div className="body">
        <aside className="sidebar">
          <div className="new-note">
            <input
              value={newTitle}
              placeholder={t(lang, 'noteTitlePlaceholder')}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreateNote()
              }}
            />
            <button onClick={() => void handleCreateNote()}>{t(lang, 'newNote')}</button>
          </div>
          <p className="notes-label">{t(lang, 'notesHeading')}</p>
          <ul className="note-list">
            {notes.map((note) => {
              const selected = note.id === selectedNoteId
              return (
                <li key={note.id} className={selected ? 'note-row selected' : 'note-row'}>
                  {renamingId === note.id && selectedNoteId !== note.id ? (
                    <input
                      className="note-rename"
                      value={renameText}
                      autoFocus
                      onChange={(e) => setRenameText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleRenameSave(note.id)
                        else if (e.key === 'Escape') handleRenameCancel()
                      }}
                      onBlur={() => void handleRenameSave(note.id)}
                    />
                  ) : (
                    <button
                      className={selected ? 'note-item selected' : 'note-item'}
                      onClick={() => {
                        setSelectedNoteId(note.id)
                        setMenuOpenId(null)
                      }}
                    >
                      {note.title}
                    </button>
                  )}
                  {renamingId !== note.id && (
                    <button
                      className="note-menu-btn"
                      aria-label={t(lang, 'noteMenu')}
                      aria-haspopup="menu"
                      onClick={() =>
                        setMenuOpenId((prev) => (prev === note.id ? null : note.id))
                      }
                    >
                      ⋯
                    </button>
                  )}
                  {menuOpenId === note.id && (
                    <div className="note-menu" role="menu">
                      <button role="menuitem" onClick={() => handleRenameStart(note)}>
                        {t(lang, 'rename')}
                      </button>
                      <button
                        role="menuitem"
                        className="danger"
                        onClick={() => {
                          setDeleteTarget(note)
                          setMenuOpenId(null)
                        }}
                      >
                        {t(lang, 'delete')}
                      </button>
                    </div>
                  )}
                </li>
              )
            })}
            {notes.length === 0 && <li className="empty">{t(lang, 'noNotes')}</li>}
          </ul>
          <div className="samples">
            <button onClick={() => setShowSamples((v) => !v)}>{t(lang, 'openSample')}</button>
            {showSamples && sampleList}
          </div>
        </aside>

        <main
          className={dragging ? 'content dragging' : 'content'}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          {selectedNoteId === null || selectedNote === null ? (
            <div className="empty-state">
              <p className="wordmark-large">{t(lang, 'appTitle')}</p>
              <p className="empty-mantra">{t(lang, 'emptyMantra')}</p>
              {notes.length === 0 ? (
                <>
                  {importingSample && <p className="empty-hint">{t(lang, 'importing')}</p>}
                  {sampleList}
                </>
              ) : (
                <p className="empty-hint">{t(lang, 'selectNote')}</p>
              )}
            </div>
          ) : (
            <>
              <div className="note-head">
                {renamingId === selectedNote.id ? (
                  <input
                    className="note-title-input"
                    value={renameText}
                    autoFocus
                    onChange={(e) => setRenameText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleRenameSave(selectedNote.id)
                      else if (e.key === 'Escape') handleRenameCancel()
                    }}
                    onBlur={() => void handleRenameSave(selectedNote.id)}
                  />
                ) : (
                  <h2
                    className="note-title"
                    title={t(lang, 'renameHint')}
                    onDoubleClick={() => handleRenameStart(selectedNote)}
                  >
                    {selectedNote.title}
                  </h2>
                )}
              </div>

              {sources.length === 0 ? (
                <div className="dropzone">
                  <svg
                    className="dropzone-icon"
                    width="28"
                    height="28"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 15V4" />
                    <path d="M7.5 8.5 12 4l4.5 4.5" />
                    <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
                  </svg>
                  <p className="dropzone-title">{t(lang, 'dropTitle')}</p>
                  <div className="drop-actions">
                    <button onClick={() => void handleAddAudio()}>{t(lang, 'addAudio')}</button>
                    <button onClick={() => void handleAddPdf()}>{t(lang, 'addPdf')}</button>
                  </div>
                  <ul className="steps">
                    <li className="step">
                      <span className="step-num" aria-hidden="true">
                        1
                      </span>
                      {t(lang, 'stepTranscribe')}
                    </li>
                    <li className="step-arrow" aria-hidden="true">
                      <ChevronIcon />
                    </li>
                    <li className="step">
                      <span className="step-num" aria-hidden="true">
                        2
                      </span>
                      {t(lang, 'stepSummarize')}
                    </li>
                    <li className="step-arrow" aria-hidden="true">
                      <ChevronIcon />
                    </li>
                    <li className="step">
                      <span className="step-num" aria-hidden="true">
                        3
                      </span>
                      {t(lang, 'stepVerify')}
                    </li>
                  </ul>
                </div>
              ) : (
                <>
              <div className="sources-row">
                <span className="sources-label">{t(lang, 'sourcesHeading')}</span>
                {sources.map(sourcePill)}
              </div>

              <div className="content-actions">
                <button
                  className="btn-primary"
                  onClick={() => void handleRunSummary()}
                  disabled={summaryRunning || !sources.some((s) => s.status === 'done')}
                >
                  {t(lang, 'makeSummary')}
                </button>
                <button
                  onClick={() => void handleRunCorrections()}
                  disabled={
                    correctionsRunning ||
                    !sources.some((s) => s.kind === 'audio' && s.status === 'done')
                  }
                  title={t(lang, 'suggestCorrectionsTitle')}
                >
                  {t(lang, 'suggestCorrections')}
                </button>
                <button onClick={() => void handleAddAudio()}>{t(lang, 'addAudio')}</button>
                <button onClick={() => void handleAddPdf()}>{t(lang, 'addPdf')}</button>
                {summaryRunning && (
                  <span className="summary-progress">
                    <ProgressText
                      text={
                        summaryStage === 'verifying' ? t(lang, 'verifying') : t(lang, 'summarizing')
                      }
                    />
                  </span>
                )}
                {correctionsRunning && (
                  <span className="summary-progress">
                    <ProgressText
                      text={
                        correctionStage === 'done'
                          ? t(lang, 'doneLabel')
                          : t(lang, 'generatingCorrections')
                      }
                    />
                  </span>
                )}
              </div>

              <div className="panes">
                <section className="pane pane-left">
                  {summary !== null && summary.claims.length > 0 && (
                    <div className="summary-block">
                      <div className="section-head">
                        <h3 className="section-title">{t(lang, 'citedSummary')}</h3>
                      </div>
                      <div className="summary-col">
                      <EvidenceBar
                        lang={lang}
                        claims={summary.claims}
                        onStepFlag={stepToClaim}
                      />
                      <ClaimList
                        lang={lang}
                        claims={summary.claims}
                        reveal={summary.id === revealedSummaryId}
                        pulsedId={pulsedClaimId}
                        onCiteSegment={handleCiteClick}
                        onCitePage={handlePageCiteClick}
                      />
                      </div>
                    </div>
                  )}
                  {corrections.length > 0 && (
                    <div className="summary-block">
                      <div className="collapsible-head">
                        <h3 className="section-title">{t(lang, 'suggestedFixes')}</h3>
                        <button
                          className="collapse-btn"
                          aria-expanded={correctionsOpen}
                          onClick={() => setCorrectionsOpen((v) => !v)}
                        >
                          {correctionsOpen ? t(lang, 'collapse') : t(lang, 'expand')}
                        </button>
                      </div>
                      <p className="counts-line">
                        {t(lang, 'suggestedFixes')}{' '}
                        {corrections.filter((c) => c.status === 'pending').length} ·{' '}
                        {t(lang, 'acceptedCount')}{' '}
                        {corrections.filter((c) => c.status === 'accepted').length} ·{' '}
                        {t(lang, 'rejectedCount')}{' '}
                        {corrections.filter((c) => c.status === 'rejected').length}{' '}
                        {corrections.some((c) => c.status === 'pending') && (
                          <button
                            className="accept-all"
                            onClick={() => void handleAcceptAllCorrections()}
                          >
                            {t(lang, 'acceptAll')}
                          </button>
                        )}
                      </p>
                      {correctionsOpen && (
                        <ul className="claims">
                          {corrections
                            .filter((c) => c.status === 'pending')
                            .map((c) => (
                              <li key={c.id} className="claim term-row">
                                <span className="gutter" aria-hidden="true" />
                                <div className="claim-body">
                                  <button
                                    className="cite-chip"
                                    title={t(lang, 'playFromHere')}
                                    onClick={() => {
                                      const sourceId = sourceIdOfSegment(c.segmentId)
                                      if (sourceId !== null) {
                                        playSegment(sourceId, c.startMs)
                                        highlightSegment(c.segmentId)
                                      }
                                    }}
                                  >
                                    <span className="chip-icon" aria-hidden="true">
                                      <WaveformIcon />
                                    </span>
                                    {formatShort(c.startMs)}
                                  </button>{' '}
                                  <span className="correction-before">{c.beforeText}</span>
                                  {' → '}
                                  <span className="correction-after">{c.afterText}</span>{' '}
                                  <span className="correction-kind">
                                    {correctionKindLabel[c.kind]}
                                  </span>{' '}
                                  <span className="correction-reason">{c.reason}</span>
                                  <div className="term-actions">
                                    <button onClick={() => void handleAcceptCorrection(c.id)}>
                                      {t(lang, 'accept')}
                                    </button>
                                    <button onClick={() => void handleRejectCorrection(c.id)}>
                                      {t(lang, 'reject')}
                                    </button>
                                  </div>
                                </div>
                              </li>
                            ))}
                        </ul>
                      )}
                    </div>
                  )}
                  <div className="summary-block">
                    <div className="section-head">
                      <h3 className="section-title">{t(lang, 'checkNotesTitle')}</h3>
                    </div>
                    <textarea
                      className="check-input"
                      value={checkText}
                      placeholder={t(lang, 'checkPlaceholder')}
                      onChange={(e) => setCheckText(e.target.value)}
                      rows={4}
                    />
                    <div className="check-actions">
                      <button
                        onClick={() => void handleRunCheck()}
                        disabled={checkRunning || checkText.trim().length === 0}
                      >
                        {checkRunning ? t(lang, 'checking') : t(lang, 'checkButton')}
                      </button>
                    </div>
                    {checkResult !== null && checkResult.claims.length > 0 && (
                      <div className="summary-col">
                        <EvidenceBar
                          lang={lang}
                          claims={checkResult.claims}
                          onStepFlag={stepToClaim}
                        />
                        <ClaimList
                          lang={lang}
                          claims={checkResult.claims}
                          reveal={checkReveal}
                          pulsedId={pulsedClaimId}
                          onCiteSegment={handleCiteClick}
                          onCitePage={handlePageCiteClick}
                        />
                      </div>
                    )}
                  </div>
                </section>

                <section className="pane pane-right">
                  <div className="tabs" role="tablist">
                    <button
                      role="tab"
                      aria-selected={rightTab === 'transcript'}
                      className={rightTab === 'transcript' ? 'tab active' : 'tab'}
                      onClick={() => setRightTab('transcript')}
                    >
                      {t(lang, 'transcriptTab')}
                    </button>
                    <button
                      role="tab"
                      aria-selected={rightTab === 'slides'}
                      className={rightTab === 'slides' ? 'tab active' : 'tab'}
                      onClick={() => setRightTab('slides')}
                    >
                      {t(lang, 'slidesTab')}
                    </button>
                  </div>
                  <div className="tab-body">
                    {rightTab === 'transcript' ? transcriptView : slidesView}
                  </div>
                  {playerSource !== null && (
                    <div className="player-dock">
                      <AudioPlayer
                        lang={lang}
                        sourceId={playerSource.id}
                        sourceName={playerSource.display_name}
                        startMs={playerStartMs}
                        playToken={playToken}
                        onTimeUpdate={handlePlayerTime}
                      />
                    </div>
                  )}
                </section>
              </div>
                </>
              )}
            </>
          )}
        </main>
      </div>
      {deleteTarget !== null && (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true">
            <p className="modal-text">
              {t(lang, 'deleteConfirm', { title: deleteTarget.title })}
            </p>
            <div className="modal-actions">
              <button onClick={() => setDeleteTarget(null)}>{t(lang, 'cancel')}</button>
              <button onClick={() => void handleDeleteConfirm()}>
                {t(lang, 'delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
