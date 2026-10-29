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
  ApiKeySource,
  AppInfo,
  AppLanguage,
  CheckProgressEvent,
  Claim,
  Correction,
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
import { splitSentences } from '../../shared/sentences'
import ApiKeyDialog from './ApiKeyDialog'
import AudioPlayer from './AudioPlayer'
import Button, { Spinner } from './Button'
import {
  CheckButtonIcon,
  ChevronRightIcon,
  CloseIcon,
  FileIcon,
  ListCheckIcon,
  MoreIcon,
  PenIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
  WaveformButtonIcon,
} from './icons'
import SlidePanel from './SlidePanel'
import { sampleLanguageLabel, t, type MessageKey } from './i18n'
import { isBlockingError, noteTitleFromPath, scrollTopFor } from './utils'

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
      <Button
        ref={btnRef}
        variant="ghost"
        size="sm"
        className={kind === 'time' ? 'cite-chip' : 'page-chip'}
        icon={kind === 'time' ? <WaveformIcon /> : <PageIcon />}
        onFocus={(e) => {
          // Keyboard focus only: a mouse click also focuses the chip, and the
          // card should close once the chip has been activated.
          if (!e.currentTarget.matches(':focus-visible')) return
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
        {label}
      </Button>
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
  checking,
  pulsedId,
  onCiteSegment,
  onCitePage,
}: {
  lang: AppLanguage
  claims: Claim[]
  /** True only right after a verification run finished (progress event). */
  reveal: boolean
  /** True while a verification run is still going (pending claims show a spinner). */
  checking?: boolean
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
              {pending ? (
                checking === true && (
                  <span className="mark-checking">
                    <Spinner />
                  </span>
                )
              ) : unsupported ? (
                <span className="mark-no">
                  <XIcon />
                </span>
              ) : (
                <span className="mark-ok">
                  <CheckIcon />
                </span>
              )}
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
              {pending && checking === true && (
                <span className="claim-label" style={{ color: 'var(--ink-faint)', borderColor: 'var(--chip-line)' }}>
                  {t(lang, 'checkingMark')}
                </span>
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
 * One square per sentence (red = not in sources) plus "11 of 13 sentences
 * cited and verified". Squares jump to their sentence; the red count is a
 * button that steps through the flagged sentences.
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
    <div className="evidence-bar">
      <ol className="evidence-strip" aria-hidden="true">
        {claims.map((c, i) => (
          <li
            key={c.id}
            className={`evidence-cell evidence-cell-${c.verdict ?? 'pending'}`}
            title={`${i + 1}. ${t(
              lang,
              c.verdict === 'supported'
                ? 'verifiedCount'
                : c.verdict === 'unsupported'
                  ? 'notInSources'
                  : 'checkingMark',
            )}`}
            onClick={() => onStepFlag(c.id)}
          />
        ))}
      </ol>
      <span>{t(lang, 'evidenceOf', { count: supported, total: claims.length })}</span>
      {flaggedIds.length > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          className="evidence-flag"
          onClick={() => {
            const next = flaggedIds[cursor.current % flaggedIds.length]
            cursor.current += 1
            onStepFlag(next)
          }}
        >
          {t(lang, 'evidenceFlagged', { count: flaggedIds.length })}
        </Button>
      ) : (
        <span className="evidence-none">{t(lang, 'evidenceFlagged', { count: 0 })}</span>
      )}
    </div>
  )
}

/** Scrolls only the nearest scrollable ancestor so the element is visible. */
function scrollWithinPane(element: HTMLElement, align: 'start' | 'center'): void {
  let pane: HTMLElement | null = element.parentElement
  while (pane !== null) {
    const overflowY = getComputedStyle(pane).overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll') && pane.scrollHeight > pane.clientHeight) break
    pane = pane.parentElement
  }
  if (pane === null) return
  const c = pane.getBoundingClientRect()
  const r = element.getBoundingClientRect()
  pane.scrollTo({
    top: scrollTopFor(
      { top: c.top, height: c.height, scrollTop: pane.scrollTop },
      { top: r.top, height: r.height },
      align,
    ),
    behavior: 'smooth',
  })
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

/** Elapsed wall-clock as `0:42` from a start timestamp + now. */
function formatElapsed(startedAt: number, now: number): string {
  return formatShort(Math.max(0, now - startedAt))
}

const IS_MAC =
  typeof navigator !== 'undefined' &&
  (/Mac/.test(navigator.platform) || /Macintosh/.test(navigator.userAgent))

interface Toast {
  id: number
  kind: 'info' | 'error'
  text: string
}

function ToastStack({
  lang,
  toasts,
  onDismiss,
}: {
  lang: AppLanguage
  toasts: Toast[]
  onDismiss: (id: number) => void
}) {
  // The live region stays mounted so screen readers announce toasts added to it.
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={toast.kind === 'error' ? 'toast toast-error' : 'toast'}
          role={toast.kind === 'error' ? 'alert' : 'status'}
        >
          <span>{toast.text}</span>
          {toast.kind === 'error' && (
            <Button
              variant="ghost"
              size="sm"
              className="toast-close"
              icon={<CloseIcon />}
              onClick={() => onDismiss(toast.id)}
              aria-label={t(lang, 'dismissToast')}
              title={t(lang, 'dismissToast')}
            >
              {''}
            </Button>
          )}
        </div>
      ))}
    </div>
  )
}

/** Shimmering `--chip` bars for transcript rows not yet transcribed. */
function SkeletonRows({ widths }: { widths: number[] }) {
  return (
    <ul className="skeleton-rows" aria-hidden="true">
      {widths.map((w, i) => (
        <li key={i} className="skeleton-bar" style={{ width: `${w}%` }} />
      ))}
    </ul>
  )
}

/** Five skeleton claim blocks shown while the summary has no claims yet. */
function SkeletonClaims() {
  const widths = [92, 78, 85, 70, 88]
  return (
    <div aria-hidden="true">
      {widths.map((w, i) => (
        <div key={i} className="skeleton-claim">
          <span className="skeleton-dot" />
          <span className="margin-line" aria-hidden="true" />
          <span className="skeleton-lines">
            <span className="skeleton-bar" style={{ width: `${w}%` }} />
            <span className="skeleton-bar" style={{ width: `${Math.max(40, w - 25)}%` }} />
            <span className="skeleton-pills">
              <span className="skeleton-bar" />
              <span className="skeleton-bar" />
            </span>
          </span>
        </div>
      ))}
    </div>
  )
}

/** Three skeleton rows for the term-fix panel. */
function SkeletonTerms() {
  return (
    <ul className="skeleton-rows" aria-hidden="true">
      {[88, 72, 80].map((w, i) => (
        <li key={i} className="skeleton-bar" style={{ width: `${w}%` }} />
      ))}
    </ul>
  )
}

/** Four skeleton rows for the sidebar while the app boots. */
function SkeletonNotes() {
  return (
    <ul className="skeleton-rows" aria-hidden="true">
      {[82, 64, 74, 58].map((w, i) => (
        <li key={i} className="skeleton-bar" style={{ width: `${w}%` }} />
      ))}
    </ul>
  )
}

/**
 * Two-step strip above the summary: write the cited summary, then check
 * every sentence. The active step shows a spinner and elapsed seconds.
 */
function SummaryProgressStrip({
  lang,
  stage,
  elapsed,
}: {
  lang: AppLanguage
  stage: SummaryProgressEvent['stage']
  elapsed: string
}) {
  const step1Done = stage === 'verifying' || stage === 'done'
  const step2Active = stage === 'verifying'
  return (
    <div className="progress-strip" role="status">
      <span className={step1Done ? 'progress-step done' : 'progress-step active'}>
        <span className="step-state" aria-hidden="true">
          {step1Done ? <CheckButtonIcon /> : <Spinner />}
        </span>
        {`① ${t(lang, 'summaryStep1')}`}
      </span>
      <span className="progress-arrow" aria-hidden="true">
        <ChevronRightIcon />
      </span>
      <span
        className={
          step2Active ? 'progress-step active' : stage === 'done' ? 'progress-step done' : 'progress-step'
        }
      >
        <span className="step-state" aria-hidden="true">
          {stage === 'done' ? <CheckButtonIcon /> : step2Active ? <Spinner /> : null}
          {stage !== 'done' && !step2Active && <span className="step-num">2</span>}
        </span>
        {`② ${t(lang, 'summaryStep2')}`}
      </span>
      <span className="progress-elapsed">{elapsed}</span>
    </div>
  )
}

/** What the home feed shows for one note, gathered from its sources and latest summary. */
interface NoteDigest {
  audioMs: number
  pages: number
  processing: boolean
  claims: Claim[] | null
}

async function loadDigest(noteId: number): Promise<NoteDigest> {
  const [sources, summary, pages] = await Promise.all([
    window.sourcenote.listSources(noteId),
    window.sourcenote.getLatestSummary(noteId),
    window.sourcenote.listPages(noteId),
  ])
  return {
    audioMs: sources
      .filter((s) => s.kind !== 'pdf')
      .reduce((sum, s) => sum + (s.duration_ms ?? 0), 0),
    pages: pages.length,
    processing: sources.some((s) => s.status !== 'done' && s.status !== 'error'),
    claims: summary && summary.status === 'done' ? summary.claims : null,
  }
}

/**
 * Home view once notes exist: one entry per note, newest first, with what it
 * holds (recording length, slide pages) and how much of its summary the
 * sources back, drawn as the same squares the note itself shows.
 */
function NoteFeed({
  lang,
  notes,
  onOpen,
  onNew,
}: {
  lang: AppLanguage
  notes: Note[]
  onOpen: (noteId: number) => void
  onNew: () => void
}) {
  const [digests, setDigests] = useState<Record<number, NoteDigest>>({})
  useEffect(() => {
    let alive = true
    for (const note of notes) {
      loadDigest(note.id)
        .then((d) => alive && setDigests((prev) => ({ ...prev, [note.id]: d })))
        .catch(() => {})
    }
    return () => {
      alive = false
    }
  }, [notes])

  const locale = lang === 'ko' ? 'ko-KR' : 'en-US'
  const day = new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' })
  const clock = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' })

  return (
    <section className="feed" aria-labelledby="feed-title">
      <header className="feed-head">
        <h2 id="feed-title" className="feed-title">
          {t(lang, 'feedTitle')}
        </h2>
        <span className="feed-count">{t(lang, 'feedCount', { count: notes.length })}</span>
        <Button variant="secondary" size="md" className="feed-new" onClick={onNew}>
          {t(lang, 'landingNewNote')}
        </Button>
      </header>
      <ol className="feed-list">
        {notes.map((note, i) => {
          const d = digests[note.id]
          const created = new Date(note.created_at)
          // Like a notebook index, a day is written once; later entries keep only the time.
          const sameDay =
            i > 0 && day.format(new Date(notes[i - 1].created_at)) === day.format(created)
          const supported = d?.claims?.filter((c) => c.verdict === 'supported').length ?? 0
          const flagged = d?.claims?.filter((c) => c.verdict === 'unsupported').length ?? 0
          return (
            <li key={note.id}>
              <button type="button" className="feed-entry" onClick={() => onOpen(note.id)}>
                <span className="feed-meta">
                  {!sameDay && <time dateTime={note.created_at}>{day.format(created)}</time>}
                  <span>{clock.format(created)}</span>
                </span>
                <span className="feed-body">
                <span className="feed-name">{note.title}</span>
                {d === undefined ? (
                  <span className="feed-line feed-pending">{t(lang, 'feedLoading')}</span>
                ) : d.claims && d.claims.length > 0 ? (
                  <span className="feed-line">
                    <span className="feed-strip" aria-hidden="true">
                      {d.claims.map((c) => (
                        <span
                          key={c.id}
                          className={`evidence-cell evidence-cell-${c.verdict ?? 'pending'}`}
                        />
                      ))}
                    </span>
                    <span>
                      {t(lang, 'evidenceOf', { count: supported, total: d.claims.length })}
                    </span>
                    {flagged > 0 && (
                      <span className="feed-flag">
                        {t(lang, 'evidenceFlagged', { count: flagged })}
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="feed-line feed-pending">
                    {t(lang, d.processing ? 'feedProcessing' : 'feedNoSummary')}
                  </span>
                )}
                {d !== undefined && (d.audioMs > 0 || d.pages > 0) && (
                  <span className="feed-materials">
                    {d.audioMs > 0 && (
                      <span>{t(lang, 'feedAudio', { time: formatShort(d.audioMs) })}</span>
                    )}
                    {d.pages > 0 && <span>{t(lang, 'feedPages', { count: d.pages })}</span>}
                  </span>
                )}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
      <p className="feed-drop">{t(lang, 'landingDrop')}</p>
    </section>
  )
}

/**
 * Static, non-interactive preview card for the landing screen, built with
 * real components: one verified claim with time + page chips, one
 * "Not in sources" claim with the red highlighter and reason.
 */
function LandingPreview({ lang }: { lang: AppLanguage }) {
  return (
    <div className="landing-preview" aria-hidden="true">
      <ul className="claims">
        <li className="claim">
          <span className="gutter">
            <span className="mark-ok">
              <CheckIcon />
            </span>
          </span>
          <span className="margin-line" />
          <div className="claim-body">
            <span className="claim-text">{t(lang, 'landingPreviewClaim1')}</span>
            <div className="chips">
              <span className="chip-wrap">
                <span className="cite-chip">
                  <span className="chip-icon">
                    <WaveformIcon />
                  </span>
                  0:21
                </span>
              </span>
              <span className="chip-wrap">
                <span className="page-chip">
                  <span className="chip-icon">
                    <PageIcon />
                  </span>
                  p.2
                </span>
              </span>
            </div>
          </div>
        </li>
        <li className="claim">
          <span className="gutter">
            <span className="mark-no">
              <XIcon />
            </span>
          </span>
          <span className="margin-line" />
          <div className="claim-body">
            <span className="claim-text claim-text-unsupported">
              {t(lang, 'landingPreviewClaim2')}
            </span>
            <span className="claim-label">{t(lang, 'notInSources')}</span>
            <div className="claim-reason">{t(lang, 'landingPreviewReason')}</div>
          </div>
        </li>
      </ul>
    </div>
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export default function App() {
  const [lang, setLang] = useState<AppLanguage>('ko')
  // Screen readers pick their voice from the document language.
  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])
  const [booted, setBooted] = useState(false)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [selectedNoteId, setSelectedNoteId] = useState<number | null>(null)
  const [sources, setSources] = useState<Source[]>([])
  const [segmentsBySource, setSegmentsBySource] = useState<Record<number, Segment[]>>({})
  const [spend, setSpend] = useState({ spentUsd: 0, capUsd: 100 })
  const [progressBySource, setProgressBySource] = useState<Record<number, ProgressEvent>>({})
  const [sourceStartedAt, setSourceStartedAt] = useState<Record<number, number>>({})
  const [now, setNow] = useState(() => Date.now())
  const [newTitle, setNewTitle] = useState('')
  const newTitleRef = useRef<HTMLInputElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastId = useRef(0)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [summaryRunning, setSummaryRunning] = useState(false)
  const [summaryStage, setSummaryStage] = useState<SummaryProgressEvent['stage'] | null>(null)
  const [summaryStartedAt, setSummaryStartedAt] = useState<number | null>(null)
  const [corrections, setCorrections] = useState<Correction[]>([])
  const [correctionsRunning, setCorrectionsRunning] = useState(false)
  const [correctionsOpen, setCorrectionsOpen] = useState(true)
  const [correctionsTried, setCorrectionsTried] = useState(false)
  const [correctionBusyId, setCorrectionBusyId] = useState<number | 'all' | null>(null)
  const [collapsingId, setCollapsingId] = useState<number | null>(null)
  const [flashSegmentId, setFlashSegmentId] = useState<number | null>(null)
  const [checkText, setCheckText] = useState('')
  const [questions, setQuestions] = useState<Summary[]>([])
  const [qaDraft, setQaDraft] = useState('')
  /** The question being answered right now (shown above its skeleton). */
  const [qaPending, setQaPending] = useState<string | null>(null)
  /** Note whose question is in flight; a late answer for another note is dropped. */
  const qaNoteRef = useRef<number | null>(null)
  /** Id of the answer that just arrived (plays the claim reveal once). */
  const [qaRevealId, setQaRevealId] = useState<number | null>(null)
  const [checkResult, setCheckResult] = useState<Summary | null>(null)
  const [checkRunning, setCheckRunning] = useState(false)
  const leftPaneRef = useRef<HTMLElement | null>(null)
  const checkSectionRef = useRef<HTMLDivElement | null>(null)
  const [checkStage, setCheckStage] = useState<CheckProgressEvent['stage'] | null>(null)
  const [checkStartedAt, setCheckStartedAt] = useState<number | null>(null)
  const [highlightedSegmentId, setHighlightedSegmentId] = useState<number | null>(null)
  const [pages, setPages] = useState<NotePage[]>([])
  const [playerSourceId, setPlayerSourceId] = useState<number | null>(null)
  const [playerStartMs, setPlayerStartMs] = useState(0)
  const [playToken, setPlayToken] = useState(0)
  const [activeSegmentId, setActiveSegmentId] = useState<number | null>(null)
  const [samples, setSamples] = useState<SampleInfo[]>([])
  const [showSamples, setShowSamples] = useState(false)
  const [sampleBusy, setSampleBusy] = useState<string | null>(null)
  const [showLandingSamples, setShowLandingSamples] = useState(false)
  const [langSaving, setLangSaving] = useState(false)
  const [keySource, setKeySource] = useState<ApiKeySource | null>(null)
  const [keyDialogOpen, setKeyDialogOpen] = useState(false)
  const [menuOpenId, setMenuOpenId] = useState<number | null>(null)
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameText, setRenameText] = useState('')
  const [renameSaving, setRenameSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Note | null>(null)
  const [deleteSaving, setDeleteSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [retryingId, setRetryingId] = useState<number | null>(null)
  const [landingDragging, setLandingDragging] = useState(false)
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

  const pushToast = useCallback((kind: Toast['kind'], text: string) => {
    const id = (toastId.current += 1)
    setToasts((prev) => [...prev.slice(-2), { id, kind, text }])
    const ms = kind === 'error' ? 8000 : 4000
    setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id))
    }, ms)
  }, [])

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id))
  }, [])

  const reportError = useCallback(
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      if (isBlockingError(message)) setError(message)
      else pushToast('error', message)
    },
    [pushToast],
  )

  const refreshSpend = useCallback(async () => {
    setSpend(await window.sourcenote.getSpend())
  }, [])

  const refreshNotes = useCallback(async () => {
    setNotes(await window.sourcenote.listNotes())
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
    let cancelled = false
    void (async () => {
      try {
        const [settings, noteList, sampleList, info, source] = await Promise.all([
          window.sourcenote.getSettings(),
          window.sourcenote.listNotes(),
          window.sourcenote.listSamples(),
          window.sourcenote.getAppInfo(),
          window.sourcenote.getApiKeySource(),
        ])
        if (cancelled) return
        setLang(settings.language)
        setKeySource(source)
        setNotes(noteList)
        setSamples(sampleList)
        setAppInfo(info)
        setSpend(await window.sourcenote.getSpend())
      } catch (err) {
        if (!cancelled) reportError(err)
      } finally {
        if (!cancelled) setBooted(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reportError])

  // Ticking clock only while something is visibly running.
  const somethingRunning =
    summaryRunning ||
    checkRunning ||
    correctionsRunning ||
    sampleBusy !== null ||
    Object.values(progressBySource).some(
      (p) => p.stage === 'converting' || p.stage === 'transcribing',
    ) ||
    sources.some((s) => s.status === 'converting' || s.status === 'transcribing')
  useEffect(() => {
    if (!somethingRunning) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [somethingRunning])

  const handleSwitchLanguage = async (next: AppLanguage): Promise<void> => {
    if (next === lang || langSaving) return
    const prev = lang
    setLang(next)
    setLangSaving(true)
    try {
      const saved = await window.sourcenote.setSettings({ language: next })
      setLang(saved.language)
    } catch (err) {
      setLang(prev)
      reportError(err)
    } finally {
      setLangSaving(false)
    }
  }

  const handleImportSample = async (name: string): Promise<void> => {
    if (sampleBusy !== null) return
    setError(null)
    setSampleBusy(name)
    try {
      const note = await window.sourcenote.importSample(name)
      await refreshNotes()
      setSelectedNoteId(note.id)
      setShowSamples(false)
      setShowLandingSamples(false)
      pushToast('info', t(lang, 'toastSampleOpened'))
    } catch (err) {
      reportError(err)
    } finally {
      setSampleBusy(null)
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

  const refreshQuestions = useCallback(async (noteId: number) => {
    setQuestions(await window.sourcenote.listQuestions(noteId))
  }, [])

  useEffect(() => {
    if (selectedNoteId !== null) {
      void refreshSources(selectedNoteId)
      void refreshSummary(selectedNoteId)
      void refreshCorrections(selectedNoteId)
      void refreshCheck(selectedNoteId)
      void refreshQuestions(selectedNoteId)
    } else {
      setSources([])
      setSegmentsBySource({})
      setSummary(null)
      setCorrections([])
      setCheckResult(null)
      setQuestions([])
      setPages([])
      setPlayerSourceId(null)
      setActiveSegmentId(null)
      setSlideSel(null)
      setRightTab('transcript')
    }
    // Each note starts clean: no leftover draft text, panes scrolled to the top.
    setCheckText('')
    setQaDraft('')
    setQaPending(null)
    setQaRevealId(null)
    qaNoteRef.current = null
    leftPaneRef.current?.scrollTo({ top: 0 })
    setSummaryRunning(false)
    setSummaryStage(null)
    setSummaryStartedAt(null)
    setCorrectionsRunning(false)
    setCheckRunning(false)
    setCheckStage(null)
    setCheckStartedAt(null)
    setCorrectionsTried(false)
    setCorrectionBusyId(null)
    setCollapsingId(null)
    setFlashSegmentId(null)
    setProgressBySource({})
    setSourceStartedAt({})
    // Opening a note is static: never replay the verification reveal.
    setRevealedSummaryId(null)
    setCheckReveal(false)
    setPulsedClaimId(null)
    setDragging(false)
    dragDepth.current = 0
  }, [selectedNoteId, refreshSources, refreshSummary, refreshCorrections, refreshCheck, refreshQuestions])

  useEffect(() => {
    const unsubscribe = window.sourcenote.onProgress((event) => {
      setProgressBySource((prev) => ({ ...prev, [event.sourceId]: event }))
      if (event.stage === 'converting' || event.stage === 'transcribing') {
        setSourceStartedAt((prev) =>
          prev[event.sourceId] === undefined ? { ...prev, [event.sourceId]: Date.now() } : prev,
        )
      }
      if (event.stage === 'done' || event.stage === 'error') {
        if (event.stage === 'error' && event.message) reportError(new Error(event.message))
        if (event.stage === 'done') {
          // Transcription of an audio source finished: toast with its length.
          void window.sourcenote
            .listSegments(event.sourceId)
            .then((segments) => {
              if (segments.length === 0) return
              const total = segments[segments.length - 1]?.end_ms ?? 0
              pushToast('info', t(lang, 'toastTranscriptDone', { hms: formatShort(total) }))
            })
            .catch(() => undefined)
        }
        if (selectedNoteId !== null) void refreshSources(selectedNoteId)
        void refreshSpend()
        if (event.stage === 'done') {
          setSourceStartedAt((prev) => {
            const next = { ...prev }
            delete next[event.sourceId]
            return next
          })
        }
      }
    })
    return unsubscribe
  }, [selectedNoteId, refreshSources, refreshSpend, reportError, pushToast, lang])

  useEffect(() => {
    const unsubscribe = window.sourcenote.onSummaryProgress((event) => {
      if (event.noteId !== selectedNoteId) return
      setSummaryStage(event.stage)
      if (event.stage === 'verifying') {
        // Claims are already stored as pending: show them with a Checking mark.
        void refreshSummary(event.noteId)
      }
      if (event.stage === 'done' || event.stage === 'error') {
        setSummaryRunning(false)
        if (event.stage === 'error' && event.message) reportError(new Error(event.message))
        // A live finish animates the reveal once; opening a note stays static.
        if (event.stage === 'done' && event.summaryId !== null) {
          setRevealedSummaryId(event.summaryId)
          void refreshSummary(event.noteId).then(() => {
            void window.sourcenote.getLatestSummary(event.noteId).then((latest) => {
              if (latest) {
                const flagged = latest.claims.filter((c) => c.verdict === 'unsupported').length
                pushToast(
                  'info',
                  t(lang, 'toastSummaryDone', {
                    sentences: latest.claims.length,
                    flagged,
                  }),
                )
              }
            })
          })
        } else {
          void refreshSummary(event.noteId)
        }
        void refreshSpend()
      }
    })
    return unsubscribe
  }, [selectedNoteId, refreshSummary, refreshSpend, reportError, pushToast, lang])

  useEffect(() => {
    const unsubscribe = window.sourcenote.onCorrectionProgress((event) => {
      if (event.noteId !== selectedNoteId) return
      if (event.stage === 'done' || event.stage === 'error') {
        setCorrectionsRunning(false)
        if (event.stage === 'error' && event.message) reportError(new Error(event.message))
        void refreshCorrections(event.noteId).then(() => {
          if (event.stage === 'done') {
            void window.sourcenote.listCorrections(event.noteId).then((list) => {
              const pending = list.filter((c) => c.status === 'pending').length
              pushToast(
                'info',
                pending === 0 ? t(lang, 'noFixes') : t(lang, 'toastFixesFound', { count: pending }),
              )
            })
          }
        })
        void refreshSpend()
      }
    })
    return unsubscribe
  }, [selectedNoteId, refreshCorrections, refreshSpend, reportError, pushToast, lang])

  useEffect(() => {
    const unsubscribe = window.sourcenote.onCheckProgress((event) => {
      if (event.noteId !== selectedNoteId) return
      setCheckStage(event.stage)
      if (event.stage === 'error' && event.message) reportError(new Error(event.message))
    })
    return unsubscribe
  }, [selectedNoteId, reportError])

  useEffect(
    () => () => {
      if (highlightTimer.current !== null) clearTimeout(highlightTimer.current)
      if (pulseTimer.current !== null) clearTimeout(pulseTimer.current)
    },
    [],
  )

  // Esc closes menus and dialogs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      setMenuOpenId(null)
      if (!deleteSaving) setDeleteTarget(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [deleteSaving])

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
    if (renameDone.current || renameSaving) return
    renameDone.current = true
    setRenameSaving(true)
    setError(null)
    try {
      const updated = await window.sourcenote.renameNote(id, renameText)
      setNotes((prev) => prev.map((n) => (n.id === id ? updated : n)))
      setRenamingId(null)
    } catch (err) {
      reportError(err)
    } finally {
      setRenameSaving(false)
    }
  }

  const handleDeleteConfirm = async (): Promise<void> => {
    if (deleteTarget === null || deleteSaving) return
    const id = deleteTarget.id
    setError(null)
    setDeleteSaving(true)
    setDeletingId(id)
    try {
      await window.sourcenote.deleteNote(id)
      // Let the row fade out before it leaves the list.
      await sleep(250)
      const idx = notes.findIndex((n) => n.id === id)
      setNotes(notes.filter((n) => n.id !== id))
      if (selectedNoteId === id) {
        // Select the next note, or none (empty state) when it was the last.
        const next = notes[idx + 1] ?? notes[idx - 1] ?? null
        setSelectedNoteId(next ? next.id : null)
      }
      pushToast('info', t(lang, 'toastNoteDeleted'))
    } catch (err) {
      reportError(err)
    } finally {
      setDeleteSaving(false)
      setDeletingId(null)
      setDeleteTarget(null)
    }
  }

  const handleCreateNote = async (): Promise<void> => {
    const title = newTitle.trim().length > 0 ? newTitle.trim() : t(lang, 'untitledNote')
    setError(null)
    try {
      const note = await window.sourcenote.createNote(title)
      setNewTitle('')
      await refreshNotes()
      setSelectedNoteId(note.id)
    } catch (err) {
      reportError(err)
    }
  }

  const handleAddAudio = async (): Promise<void> => {
    if (selectedNoteId === null) return
    setError(null)
    try {
      const source = await window.sourcenote.addAudioSource(selectedNoteId)
      // The pill appears immediately; progress events drive it from here.
      if (source) {
        setSources((prev) => [...prev, source])
        setSourceStartedAt((prev) => ({ ...prev, [source.id]: Date.now() }))
        await refreshSources(selectedNoteId)
      }
    } catch (err) {
      reportError(err)
    }
  }

  const handleAddPdf = async (): Promise<void> => {
    if (selectedNoteId === null) return
    setError(null)
    try {
      const source = await window.sourcenote.addPdfSource(selectedNoteId)
      if (source) {
        setSources((prev) => [...prev, source])
        setSourceStartedAt((prev) => ({ ...prev, [source.id]: Date.now() }))
        await refreshSources(selectedNoteId)
      }
    } catch (err) {
      reportError(err)
    }
  }

  const handleRetrySource = async (sourceId: number): Promise<void> => {
    if (retryingId !== null) return
    setRetryingId(sourceId)
    setError(null)
    try {
      const updated = await window.sourcenote.retrySource(sourceId)
      setSources((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
      setSourceStartedAt((prev) => ({ ...prev, [updated.id]: Date.now() }))
    } catch (err) {
      reportError(err)
    } finally {
      setRetryingId(null)
    }
  }

  const handleRunSummary = async (): Promise<void> => {
    if (selectedNoteId === null || summaryRunning) return
    setError(null)
    setSummaryRunning(true)
    setSummaryStage('summarizing')
    setSummaryStartedAt(Date.now())
    leftPaneRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    try {
      await window.sourcenote.runSummary(selectedNoteId)
    } catch (err) {
      setSummaryRunning(false)
      setSummaryStage(null)
      setSummaryStartedAt(null)
      reportError(err)
    }
  }

  const handleRunCorrections = async (): Promise<void> => {
    if (selectedNoteId === null || correctionsRunning) return
    setError(null)
    setCorrectionsRunning(true)
    setCorrectionsTried(true)
    try {
      await window.sourcenote.runCorrections(selectedNoteId)
    } catch (err) {
      setCorrectionsRunning(false)
      reportError(err)
    }
  }

  const refreshAfterCorrectionChange = async (noteId: number): Promise<void> => {
    await refreshCorrections(noteId)
    await refreshSources(noteId)
  }

  const flashTranscriptRow = (segmentId: number): void => {
    setFlashSegmentId(segmentId)
    setTimeout(() => {
      setFlashSegmentId((prev) => (prev === segmentId ? null : prev))
    }, 1300)
  }

  const handleAcceptCorrection = async (id: number): Promise<void> => {
    if (selectedNoteId === null || correctionBusyId !== null) return
    const target = corrections.find((c) => c.id === id) ?? null
    setError(null)
    setCorrectionBusyId(id)
    setCollapsingId(id)
    // The row collapses out before the list refreshes.
    await sleep(200)
    try {
      const { message } = await window.sourcenote.acceptCorrection(id)
      if (message !== null) reportError(new Error(message))
      await refreshAfterCorrectionChange(selectedNoteId)
      if (target !== null) flashTranscriptRow(target.segmentId)
    } catch (err) {
      reportError(err)
    } finally {
      setCorrectionBusyId(null)
      setCollapsingId(null)
    }
  }

  const handleRejectCorrection = async (id: number): Promise<void> => {
    if (selectedNoteId === null || correctionBusyId !== null) return
    setError(null)
    setCorrectionBusyId(id)
    setCollapsingId(id)
    await sleep(200)
    try {
      await window.sourcenote.rejectCorrection(id)
      await refreshCorrections(selectedNoteId)
    } catch (err) {
      reportError(err)
    } finally {
      setCorrectionBusyId(null)
      setCollapsingId(null)
    }
  }

  const handleAcceptAllCorrections = async (): Promise<void> => {
    if (selectedNoteId === null || correctionBusyId !== null) return
    setError(null)
    setCorrectionBusyId('all')
    try {
      await window.sourcenote.acceptAllCorrections(selectedNoteId)
      await refreshAfterCorrectionChange(selectedNoteId)
    } catch (err) {
      reportError(err)
    } finally {
      setCorrectionBusyId(null)
    }
  }

  const handleAsk = async (): Promise<void> => {
    const question = qaDraft.trim()
    if (selectedNoteId === null || question.length === 0 || qaPending !== null) return
    const noteId = selectedNoteId
    setError(null)
    qaNoteRef.current = noteId
    setQaPending(question)
    setQaDraft('')
    try {
      const answer = await window.sourcenote.askQuestion(noteId, question)
      if (qaNoteRef.current !== noteId) return
      setQaRevealId(answer.id)
      await refreshQuestions(noteId)
      await refreshSpend()
    } catch (err) {
      if (qaNoteRef.current !== noteId) return
      // Give the question back so it can be retried after fixing the cause.
      setQaDraft(question)
      reportError(err)
    } finally {
      if (qaNoteRef.current === noteId) {
        qaNoteRef.current = null
        setQaPending(null)
      }
    }
  }

  const handleRunCheck = async (): Promise<void> => {
    if (selectedNoteId === null || checkText.trim().length === 0 || checkRunning) return
    setError(null)
    setCheckRunning(true)
    setCheckStage('locating')
    setCheckStartedAt(Date.now())
    // Bring the progress and results into view by scrolling the left pane
    // only (scrollIntoView would also shift the window chrome).
    requestAnimationFrame(() => {
      if (checkSectionRef.current !== null) scrollWithinPane(checkSectionRef.current, 'start')
    })
    setCheckReveal(false)
    try {
      const result = await window.sourcenote.runCheck(selectedNoteId, checkText)
      setCheckResult(result)
      setCheckStage('done')
      // A live finish animates the reveal once.
      setCheckReveal(true)
      const flagged = result.claims.filter((c) => c.verdict === 'unsupported').length
      pushToast(
        'info',
        t(lang, 'toastCheckDone', { sentences: result.claims.length, flagged }),
      )
      await refreshSpend()
    } catch (err) {
      setCheckStage(null)
      reportError(err)
    } finally {
      setCheckRunning(false)
    }
  }

  const highlightSegment = (segmentId: number): void => {
    // The transcript lives in the right pane; scroll the row to the center.
    requestAnimationFrame(() => {
      const element = document.getElementById(`segment-${segmentId}`)
      if (element) {
        scrollWithinPane(element, 'center')
        setHighlightedSegmentId(segmentId)
        if (highlightTimer.current !== null) clearTimeout(highlightTimer.current)
        highlightTimer.current = setTimeout(() => setHighlightedSegmentId(null), 2000)
      }
    })
  }

  /** Evidence-bar stepper: scroll to a flagged sentence and briefly pulse it. */
  const stepToClaim = (claimId: number): void => {
    requestAnimationFrame(() => {
      const element = document.getElementById(`claim-${claimId}`)
      if (element) scrollWithinPane(element, 'center')
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
      const { added, ignored } = await window.sourcenote.addPaths(noteId, paths)
      // Pills for the new sources appear immediately.
      if (added.length > 0) {
        const started: Record<number, number> = {}
        for (const s of added) started[s.id] = Date.now()
        setSources((prev) => [...prev, ...added])
        setSourceStartedAt((prev) => ({ ...prev, ...started }))
      }
      await refreshSources(noteId)
      if (ignored.length > 0) {
        reportError(new Error(t(lang, 'dropIgnored', { names: ignored.join(', ') })))
      }
    } catch (err) {
      reportError(err)
      await refreshSources(noteId)
    }
  }

  /** Dropping on the landing screen starts a new note from the first file. */
  const handleLandingDropFiles = async (files: File[]): Promise<void> => {
    const paths = files
      .map((file) => window.sourcenote.getPathForFile(file))
      .filter((p) => p.length > 0)
    if (paths.length === 0) return
    setError(null)
    try {
      const note = await window.sourcenote.createNote(noteTitleFromPath(paths[0]))
      await refreshNotes()
      setSelectedNoteId(note.id)
      await handleDropFiles(note.id, files)
    } catch (err) {
      reportError(err)
    }
  }

  const handleDragEnter = (e: DragEvent<HTMLElement>): void => {
    if (notes.length === 0 || !e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }

  const handleDragLeave = (e: DragEvent<HTMLElement>): void => {
    if (notes.length === 0) return
    e.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }

  const handleDragOver = (e: DragEvent<HTMLElement>): void => {
    if (notes.length === 0 || !e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
  }

  const handleDrop = (e: DragEvent<HTMLElement>): void => {
    if (notes.length === 0) return
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    if (!e.dataTransfer.types.includes('Files')) return
    // On the home feed a drop starts a new note, like the first-run screen.
    if (selectedNoteId === null) void handleLandingDropFiles(Array.from(e.dataTransfer.files))
    else void handleDropFiles(selectedNoteId, Array.from(e.dataTransfer.files))
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
  const pdfSources = sources.filter((s) => s.kind === 'pdf')
  const pdfDoneSources = sources.filter((s) => s.kind === 'pdf' && s.status === 'done')
  const pdfActive = pdfSources.some((s) => s.status === 'converting' || s.status === 'transcribing')
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
  const transcriptLoading =
    audioSources.length > 0 &&
    transcriptRowCount === 0 &&
    audioSources.some((s) => s.status === 'converting' || s.status === 'transcribing')
  const activeAudioProgress = audioSources
    .map((s) => progressBySource[s.id])
    .find((p) => p !== undefined && (p.stage === 'converting' || p.stage === 'transcribing'))
  const hasFinishedSource = sources.some((s) => s.status === 'done')
  const hasAudioDone = sources.some((s) => s.kind === 'audio' && s.status === 'done')
  const spendRatio = spend.capUsd > 0 ? spend.spentUsd / spend.capUsd : 0
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
          <Button
            className="sample-item"
            loading={sampleBusy === sample.name}
            loadingLabel={t(lang, 'openingSample')}
            disabled={sampleBusy !== null}
            disabledReason={sampleBusy !== null && sampleBusy !== sample.name ? t(lang, 'runInProgress') : undefined}
            onClick={() => void handleImportSample(sample.name)}
          >
            {sample.title} ({sampleLanguageLabel(lang, sample.language)})
          </Button>
        </li>
      ))}
      {samples.length === 0 && <li className="empty">{t(lang, 'noSamples')}</li>}
    </ul>
  )

  const sourcePill = (source: Source): ReactNode => {
    const progress = progressBySource[source.id]
    const isAudio = source.kind === 'audio'
    const active = source.status === 'converting' || source.status === 'transcribing'
    const determinate = active && progress !== undefined && progress.totalChunks > 0
    const pct =
      progress !== undefined && progress.totalChunks > 0
        ? Math.min(100, (progress.chunk / progress.totalChunks) * 100)
        : 0
    const startedAt = sourceStartedAt[source.id]
    const meta =
      isAudio && source.duration_ms !== null
        ? formatShort(source.duration_ms)
        : !isAudio && source.status === 'done'
          ? t(lang, 'slidesLabel', { count: pageCountBySource.get(source.id) ?? 0 })
          : null
    const statusText =
      !isAudio && active
        ? t(lang, 'readingSlides')
        : determinate && progress !== undefined
          ? t(lang, 'transcribingProgress', {
              done: progress.chunk,
              total: progress.totalChunks,
            })
          : t(lang, STATUS_KEY[source.status])
    return (
      <span
        key={source.id}
        className={source.status === 'error' ? 'source-pill is-error' : 'source-pill'}
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
          {statusText}
        </span>
        {active && startedAt !== undefined && (
          <span className="pill-elapsed">{formatElapsed(startedAt, now)}</span>
        )}
        {active &&
          (determinate ? (
            <span className="source-progress" aria-hidden="true">
              <span style={{ width: `${pct}%` }} />
            </span>
          ) : (
            <span className="source-progress indeterminate" aria-hidden="true">
              <span />
            </span>
          ))}
        {source.status === 'error' && (
          <Button
            size="sm"
            variant="ghost"
            className="retry-ghost"
            loading={retryingId === source.id}
            loadingLabel={t(lang, 'retry')}
            onClick={() => void handleRetrySource(source.id)}
          >
            {t(lang, 'retry')}
          </Button>
        )}
      </span>
    )
  }

  const transcriptView = (
    <>
      {transcriptLoading ? (
        <>
          <p className="skeleton-caption">
            {activeAudioProgress !== undefined && activeAudioProgress.totalChunks > 0
              ? t(lang, 'transcribingCaption', {
                  done: activeAudioProgress.chunk,
                  total: activeAudioProgress.totalChunks,
                })
              : t(lang, 'statusConverting')}
          </p>
          <SkeletonRows widths={[88, 64, 92, 74, 82, 68]} />
        </>
      ) : audioSources.length === 0 || transcriptRowCount === 0 ? (
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
                    className={
                      seg.id === flashSegmentId
                        ? 'flash-corrected'
                        : seg.id === shownSegmentId
                          ? 'highlight'
                          : undefined
                    }
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      className="seg-time"
                      title={`${t(lang, 'playFromHere')} (${formatShort(seg.start_ms)} ~ ${formatShort(seg.end_ms)})`}
                      aria-label={`${t(lang, 'playFromHere')} ${formatShort(seg.start_ms)}`}
                      onClick={() => handleTimestampClick(source.id, seg.id, seg.start_ms)}
                    >
                      {formatShort(seg.start_ms)}
                    </Button>{' '}
                    {seg.original_text !== null && (
                      <span
                        className="corrected-mark"
                        role="img"
                        aria-label={t(lang, 'correctedMark')}
                        title={t(lang, 'correctedTitle', { text: seg.original_text })}
                      >
                        <PenIcon />
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
        pdfActive ? (
          <>
            <div className="skeleton-page" aria-hidden="true" />
            <p className="empty">{t(lang, 'slideRetryHint')}</p>
          </>
        ) : (
          <p className="empty">{t(lang, 'noSlides')}</p>
        )
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

  const summaryButtonDisabled = summaryRunning || !hasFinishedSource
  const summaryDisabledReason = summaryRunning
    ? t(lang, 'runInProgress')
    : !hasFinishedSource
      ? t(lang, 'needSourceFirst')
      : undefined
  const correctionsButtonDisabled = correctionsRunning || !hasAudioDone
  const correctionsDisabledReason = correctionsRunning
    ? t(lang, 'runInProgress')
    : !hasAudioDone
      ? t(lang, 'needSourceFirst')
      : undefined
  const answeredQuestions = questions.filter((q) => q.status === 'done')
  const qaButtonDisabled = qaPending !== null || !hasFinishedSource || qaDraft.trim().length === 0
  const qaDisabledReason =
    qaPending !== null
      ? t(lang, 'runInProgress')
      : !hasFinishedSource
        ? t(lang, 'needSourceFirst')
        : qaDraft.trim().length === 0
          ? t(lang, 'enterQuestion')
          : undefined
  const checkButtonDisabled = checkRunning || checkText.trim().length === 0
  const checkDisabledReason = checkRunning
    ? t(lang, 'runInProgress')
    : checkText.trim().length === 0
      ? t(lang, 'enterSentences')
      : undefined
  const checkSkeletonCount = Math.max(1, splitSentences(checkText).length)
  const pendingCorrections = corrections.filter((c) => c.status === 'pending')

  return (
    <div className="app">
      <header className={IS_MAC ? 'header mac' : 'header'}>
        <h1 className="wordmark">{t(lang, 'appTitle')}</h1>
        <span className="tagline">{t(lang, 'tagline')}</span>
        <span className="header-spacer" />
        {appInfo?.fakeApi === true && <span className="fake-badge">{t(lang, 'fakeBadge')}</span>}
        <span
          className={spendRatio >= 0.8 ? 'spend over-cap' : 'spend'}
          title={spendRatio >= 0.8 ? t(lang, 'budgetNearCap') : undefined}
        >
          ${spend.spentUsd.toFixed(4)} / ${spend.capUsd}
        </span>
        {keySource !== null && appInfo?.fakeApi !== true && (
          <Button
            variant="secondary"
            size="sm"
            className={keySource === 'none' ? 'key-button missing' : 'key-button'}
            aria-haspopup="dialog"
            onClick={() => setKeyDialogOpen(true)}
          >
            {t(lang, keySource === 'none' ? 'apiKeyButtonMissing' : 'apiKeyButton')}
          </Button>
        )}
        <div className="lang-toggle" role="group" aria-label="Language / 언어">
          <Button
            variant="secondary"
            size="sm"
            className={lang === 'ko' ? 'lang-option selected' : 'lang-option'}
            aria-pressed={lang === 'ko'}
            disabled={langSaving}
            onClick={() => void handleSwitchLanguage('ko')}
          >
            한국어
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className={lang === 'en' ? 'lang-option selected' : 'lang-option'}
            aria-pressed={lang === 'en'}
            disabled={langSaving}
            onClick={() => void handleSwitchLanguage('en')}
          >
            English
          </Button>
        </div>
      </header>

      {error !== null && (
        <div className="error-banner" role="alert">
          <span className="error-text">{error}</span>
          {/API\s*키|API key/i.test(error) && appInfo?.fakeApi !== true && (
            <Button variant="secondary" size="sm" onClick={() => setKeyDialogOpen(true)}>
              {t(lang, keySource === 'none' ? 'apiKeyButtonMissing' : 'apiKeyButton')}
            </Button>
          )}
          <Button variant="ghost" size="sm" className="error-close" onClick={() => setError(null)}>
            {t(lang, 'close')}
          </Button>
        </div>
      )}

      <div className="body">
        <aside className="sidebar">
          <div className="new-note">
            <input
              ref={newTitleRef}
              value={newTitle}
              placeholder={t(lang, 'noteTitlePlaceholder')}
              aria-label={t(lang, 'noteTitlePlaceholder')}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreateNote()
              }}
            />
            <Button
              variant="secondary"
              size="md"
              icon={<PlusIcon />}
              onClick={() => void handleCreateNote()}
              aria-label={t(lang, 'newNote')}
              title={t(lang, 'newNote')}
            >
              {''}
            </Button>
          </div>
          <p className="notes-label">{t(lang, 'notesHeading')}</p>
          {!booted ? (
            <SkeletonNotes />
          ) : (
            <ul className="note-list">
              {notes.map((note) => {
                const selected = note.id === selectedNoteId
                return (
                  <li
                    key={note.id}
                    className={
                      selected
                        ? 'note-row selected'
                        : deletingId === note.id
                          ? 'note-row deleting'
                          : 'note-row'
                    }
                  >
                    {renamingId === note.id ? (
                      <span className="rename-wrap">
                        <input
                          className="note-rename"
                          value={renameText}
                          autoFocus
                          disabled={renameSaving}
                          onChange={(e) => setRenameText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleRenameSave(note.id)
                            else if (e.key === 'Escape') handleRenameCancel()
                          }}
                          onBlur={() => void handleRenameSave(note.id)}
                        />
                        {renameSaving && (
                          <span className="rename-spinner" aria-hidden="true">
                            <Spinner />
                          </span>
                        )}
                      </span>
                    ) : (
                      <Button
                        variant="ghost"
                        className={selected ? 'note-item selected' : 'note-item'}
                        onClick={() => {
                          setSelectedNoteId(note.id)
                          setMenuOpenId(null)
                        }}
                      >
                        {note.title}
                      </Button>
                    )}
                    {renamingId !== note.id && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="note-menu-btn"
                        icon={<MoreIcon />}
                        aria-label={t(lang, 'noteMenu')}
                        title={t(lang, 'noteMenu')}
                        aria-haspopup="menu"
                        onClick={() =>
                          setMenuOpenId((prev) => (prev === note.id ? null : note.id))
                        }
                      >
                        {''}
                      </Button>
                    )}
                    {menuOpenId === note.id && (
                      <div className="note-menu" role="menu">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="menu-item"
                          role="menuitem"
                          icon={<PencilIcon />}
                          onClick={() => handleRenameStart(note)}
                        >
                          {t(lang, 'rename')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="menu-danger"
                          role="menuitem"
                          icon={<TrashIcon />}
                          onClick={() => {
                            setDeleteTarget(note)
                            setMenuOpenId(null)
                          }}
                        >
                          {t(lang, 'delete')}
                        </Button>
                      </div>
                    )}
                  </li>
                )
              })}
              {notes.length === 0 && <li className="empty">{t(lang, 'noNotes')}</li>}
            </ul>
          )}
          <div className="samples">
            <Button
              variant="secondary"
              size="md"
              loading={sampleBusy !== null && !showLandingSamples}
              loadingLabel={t(lang, 'importing')}
              onClick={() => setShowSamples((v) => !v)}
            >
              {t(lang, 'openSample')}
            </Button>
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
            notes.length === 0 ? (
              <div
                className={landingDragging ? 'landing dragging' : 'landing'}
                onDragEnter={(e) => {
                  if (!e.dataTransfer.types.includes('Files')) return
                  e.preventDefault()
                  e.stopPropagation()
                  setLandingDragging(true)
                }}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes('Files')) return
                  e.preventDefault()
                  e.stopPropagation()
                }}
                onDragLeave={(e) => {
                  e.preventDefault()
                  setLandingDragging(false)
                }}
                onDrop={(e) => {
                  if (!e.dataTransfer.types.includes('Files')) return
                  e.preventDefault()
                  e.stopPropagation()
                  setLandingDragging(false)
                  void handleLandingDropFiles(Array.from(e.dataTransfer.files))
                }}
              >
                <p className="landing-wordmark">{t(lang, 'appTitle')}</p>
                <h2 className="landing-headline">{t(lang, 'landingHeadline')}</h2>
                <p className="landing-sub">{t(lang, 'landingSub')}</p>
                <LandingPreview lang={lang} />
                <div className="landing-actions">
                  <Button
                    variant="primary"
                    size="lg"
                    loading={sampleBusy !== null && showLandingSamples}
                    loadingLabel={t(lang, 'openingSample')}
                    onClick={() => setShowLandingSamples((v) => !v)}
                  >
                    {t(lang, 'openSample')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="lg"
                    onClick={() => newTitleRef.current?.focus()}
                  >
                    {t(lang, 'landingNewNote')}
                  </Button>
                </div>
                {showLandingSamples && (
                  <ul className="landing-samples">
                    {samples.map((sample) => (
                      <li key={sample.name}>
                        <Button
                          variant="secondary"
                          size="md"
                          loading={sampleBusy === sample.name}
                          loadingLabel={t(lang, 'openingSample')}
                          disabled={sampleBusy !== null}
                          disabledReason={
                            sampleBusy !== null && sampleBusy !== sample.name
                              ? t(lang, 'runInProgress')
                              : undefined
                          }
                          onClick={() => void handleImportSample(sample.name)}
                        >
                          {sample.title} ({sampleLanguageLabel(lang, sample.language)})
                        </Button>
                      </li>
                    ))}
                    {samples.length === 0 && <li className="empty">{t(lang, 'noSamples')}</li>}
                  </ul>
                )}
                <div className="landing-drop">{t(lang, 'landingDrop')}</div>
                <p className="landing-footer">{t(lang, 'landingFooter')}</p>
              </div>
            ) : (
              <NoteFeed
                lang={lang}
                notes={notes}
                onOpen={(id) => {
                  setSelectedNoteId(id)
                  setMenuOpenId(null)
                }}
                onNew={() => newTitleRef.current?.focus()}
              />
            )
          ) : (
            <>
              <div className="note-head">
                {renamingId === selectedNote.id ? (
                  <div className="note-title-wrap">
                    <input
                      className="note-title-input"
                      value={renameText}
                      autoFocus
                      disabled={renameSaving}
                      onChange={(e) => setRenameText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleRenameSave(selectedNote.id)
                        else if (e.key === 'Escape') handleRenameCancel()
                      }}
                      onBlur={() => void handleRenameSave(selectedNote.id)}
                    />
                    {renameSaving && (
                      <span className="rename-spinner" aria-hidden="true">
                        <Spinner />
                      </span>
                    )}
                  </div>
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
                    <Button variant="secondary" size="md" onClick={() => void handleAddAudio()}>
                      {t(lang, 'addAudio')}
                    </Button>
                    <Button variant="secondary" size="md" onClick={() => void handleAddPdf()}>
                      {t(lang, 'addPdf')}
                    </Button>
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
                <Button
                  variant="primary"
                  size="md"
                  icon={<ListCheckIcon />}
                  loading={summaryRunning}
                  loadingLabel={
                    summaryStage === 'verifying' ? t(lang, 'verifying') : t(lang, 'summarizing')
                  }
                  disabled={summaryButtonDisabled}
                  disabledReason={summaryDisabledReason}
                  onClick={() => void handleRunSummary()}
                >
                  {t(lang, 'makeSummary')}
                </Button>
                <Button
                  variant="secondary"
                  size="md"
                  icon={<PenIcon />}
                  loading={correctionsRunning}
                  loadingLabel={t(lang, 'findingFixes')}
                  disabled={correctionsButtonDisabled}
                  disabledReason={correctionsDisabledReason}
                  title={t(lang, 'suggestCorrectionsTitle')}
                  onClick={() => void handleRunCorrections()}
                >
                  {t(lang, 'suggestCorrections')}
                </Button>
                <span className="toolbar-divider" aria-hidden="true" />
                <Button
                  variant="ghost"
                  size="md"
                  icon={<WaveformButtonIcon />}
                  onClick={() => void handleAddAudio()}
                >
                  {t(lang, 'addAudio')}
                </Button>
                <Button
                  variant="ghost"
                  size="md"
                  icon={<FileIcon />}
                  onClick={() => void handleAddPdf()}
                >
                  {t(lang, 'addPdf')}
                </Button>
              </div>

              <div className="panes">
                <section className="pane pane-left" ref={leftPaneRef}>
                  {summaryRunning && summaryStage !== null && (
                    <SummaryProgressStrip
                      lang={lang}
                      stage={summaryStage}
                      elapsed={
                        summaryStartedAt !== null ? formatElapsed(summaryStartedAt, now) : ''
                      }
                    />
                  )}
                  {(summary !== null || summaryRunning) && (
                    <div className="summary-block">
                      <div className="section-head">
                        <h3 className="section-title">{t(lang, 'citedSummary')}</h3>
                      </div>
                      <div className={summaryRunning && summary !== null ? 'summary-col summary-dimmed' : 'summary-col'}>
                      {summary !== null && summary.claims.length > 0 && (
                        <>
                          <EvidenceBar
                            lang={lang}
                            claims={summary.claims}
                            onStepFlag={stepToClaim}
                          />
                          <ClaimList
                            lang={lang}
                            claims={summary.claims}
                            reveal={summary.id === revealedSummaryId}
                            checking={summaryRunning && summaryStage === 'verifying'}
                            pulsedId={pulsedClaimId}
                            onCiteSegment={handleCiteClick}
                            onCitePage={handlePageCiteClick}
                          />
                        </>
                      )}
                      {summaryRunning && (summary === null || summary.claims.length === 0) && (
                        <SkeletonClaims />
                      )}
                      </div>
                    </div>
                  )}
                  {(corrections.length > 0 || correctionsRunning || correctionsTried) && (
                    <div className="summary-block">
                      <div className="collapsible-head">
                        <h3 className="section-title">{t(lang, 'suggestedFixes')}</h3>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="collapse-btn"
                          aria-expanded={correctionsOpen}
                          onClick={() => setCorrectionsOpen((v) => !v)}
                        >
                          {correctionsOpen ? t(lang, 'collapse') : t(lang, 'expand')}
                        </Button>
                      </div>
                      {correctionsRunning && pendingCorrections.length === 0 ? (
                        <SkeletonTerms />
                      ) : correctionsTried && !correctionsRunning && corrections.length === 0 ? (
                        <p className="empty">{t(lang, 'noFixes')}</p>
                      ) : (
                        corrections.length > 0 && (
                          <>
                            <p className="counts-line">
                              <span>
                                {t(lang, 'suggestedFixes')} {pendingCorrections.length}
                              </span>
                              <span>
                                {t(lang, 'acceptedCount')}{' '}
                                {corrections.filter((c) => c.status === 'accepted').length}
                              </span>
                              <span>
                                {t(lang, 'rejectedCount')}{' '}
                                {corrections.filter((c) => c.status === 'rejected').length}
                              </span>
                              {pendingCorrections.length > 0 && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="accept-all"
                                  loading={correctionBusyId === 'all'}
                                  loadingLabel={t(lang, 'acceptAll')}
                                  disabled={correctionBusyId !== null}
                                  disabledReason={
                                    correctionBusyId !== null && correctionBusyId !== 'all'
                                      ? t(lang, 'runInProgress')
                                      : undefined
                                  }
                                  onClick={() => void handleAcceptAllCorrections()}
                                >
                                  {t(lang, 'acceptAll')}
                                </Button>
                              )}
                            </p>
                            {correctionsOpen && (
                              <ul className="claims">
                                {pendingCorrections.map((c) => (
                                  <li
                                    key={c.id}
                                    className={
                                      collapsingId === c.id
                                        ? 'claim term-row collapsing leaving'
                                        : 'claim term-row'
                                    }
                                  >
                                    <span className="gutter" aria-hidden="true" />
                                    <div className="claim-body">
                                      <Button
                                        variant="ghost"
                                        size="sm"
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
                                      </Button>{' '}
                                      <span className="correction-before">{c.beforeText}</span>
                                      {' → '}
                                      <span className="correction-after">{c.afterText}</span>{' '}
                                      <span className="correction-kind">
                                        {correctionKindLabel[c.kind]}
                                      </span>{' '}
                                      <span className="correction-reason">{c.reason}</span>
                                      <div className="term-actions">
                                        <Button
                                          variant="secondary"
                                          size="sm"
                                          className="term-action"
                                          loading={correctionBusyId === c.id}
                                          loadingLabel={t(lang, 'accept')}
                                          disabled={correctionBusyId !== null}
                                          disabledReason={
                                            correctionBusyId !== null &&
                                            correctionBusyId !== c.id
                                              ? t(lang, 'runInProgress')
                                              : undefined
                                          }
                                          onClick={() => void handleAcceptCorrection(c.id)}
                                        >
                                          {t(lang, 'accept')}
                                        </Button>
                                        <Button
                                          variant="secondary"
                                          size="sm"
                                          className="term-action"
                                          loading={correctionBusyId === c.id}
                                          loadingLabel={t(lang, 'reject')}
                                          disabled={correctionBusyId !== null}
                                          disabledReason={
                                            correctionBusyId !== null &&
                                            correctionBusyId !== c.id
                                              ? t(lang, 'runInProgress')
                                              : undefined
                                          }
                                          onClick={() => void handleRejectCorrection(c.id)}
                                        >
                                          {t(lang, 'reject')}
                                        </Button>
                                      </div>
                                    </div>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </>
                        )
                      )}
                    </div>
                  )}
                  <div className="summary-block qa-block">
                    <div className="section-head">
                      <h3 id="qa-title" className="section-title">
                        {t(lang, 'qaTitle')}
                      </h3>
                    </div>
                    <p className="qa-hint">{t(lang, 'qaHint')}</p>
                    {(answeredQuestions.length > 0 || qaPending !== null) && (
                      <ol className="qa-thread">
                        {answeredQuestions.map((qa) => (
                          <li key={qa.id} className="qa-turn">
                            <p className="qa-question">
                              <span className="qa-question-label">{t(lang, 'qaYou')}</span>
                              {qa.question}
                            </p>
                            {qa.claims.length === 0 ? (
                              <p className="qa-empty">{t(lang, 'qaNoAnswer')}</p>
                            ) : (
                              <ClaimList
                                lang={lang}
                                claims={qa.claims}
                                reveal={qaRevealId === qa.id}
                                pulsedId={pulsedClaimId}
                                onCiteSegment={handleCiteClick}
                                onCitePage={handlePageCiteClick}
                              />
                            )}
                          </li>
                        ))}
                        {qaPending !== null && (
                          <li className="qa-turn" aria-busy="true">
                            <p className="qa-question">
                              <span className="qa-question-label">{t(lang, 'qaYou')}</span>
                              {qaPending}
                            </p>
                            <SkeletonRows widths={[86, 64]} />
                          </li>
                        )}
                      </ol>
                    )}
                    <form
                      className="qa-form"
                      onSubmit={(e) => {
                        e.preventDefault()
                        void handleAsk()
                      }}
                    >
                      <input
                        type="text"
                        className="qa-input"
                        aria-labelledby="qa-title"
                        value={qaDraft}
                        maxLength={500}
                        placeholder={t(lang, 'qaPlaceholder')}
                        onChange={(e) => setQaDraft(e.target.value)}
                      />
                      <Button
                        type="submit"
                        variant="secondary"
                        size="md"
                        loading={qaPending !== null}
                        loadingLabel={t(lang, 'qaAnswering')}
                        disabled={qaButtonDisabled}
                        disabledReason={qaDisabledReason}
                      >
                        {t(lang, 'qaButton')}
                      </Button>
                    </form>
                  </div>
                  <div
                    className="summary-block"
                    ref={(el) => {
                      checkSectionRef.current = el
                    }}
                  >
                    <div className="section-head">
                      <h3 id="check-notes-title" className="section-title">
                        {t(lang, 'checkNotesTitle')}
                      </h3>
                    </div>
                    <textarea
                      spellCheck={false}
                      className="check-input"
                      aria-labelledby="check-notes-title"
                      value={checkText}
                      placeholder={t(lang, 'checkPlaceholder')}
                      onChange={(e) => setCheckText(e.target.value)}
                      rows={4}
                    />
                    <div className="check-actions">
                      <Button
                        variant="secondary"
                        size="md"
                        icon={<CheckButtonIcon />}
                        loading={checkRunning}
                        loadingLabel={
                          checkStage === 'verifying'
                            ? t(lang, 'verifying')
                            : t(lang, 'findingEvidence')
                        }
                        disabled={checkButtonDisabled}
                        disabledReason={checkDisabledReason}
                        onClick={() => void handleRunCheck()}
                      >
                        {t(lang, 'checkButton')}
                      </Button>
                      {checkRunning && checkStartedAt !== null && (
                        <span className="summary-progress">{formatElapsed(checkStartedAt, now)}</span>
                      )}
                    </div>
                    {checkRunning && (
                      <SkeletonRows
                        widths={Array.from({ length: checkSkeletonCount }, (_, i) =>
                          i % 2 === 0 ? 88 : 70,
                        )}
                      />
                    )}
                    {checkResult !== null && checkResult.claims.length > 0 && (
                      <div className={checkRunning ? 'summary-col summary-dimmed' : 'summary-col'}>
                        <EvidenceBar
                          lang={lang}
                          claims={checkResult.claims}
                          onStepFlag={stepToClaim}
                        />
                        <ClaimList
                          lang={lang}
                          claims={checkResult.claims}
                          reveal={checkReveal}
                          checking={checkRunning && checkStage === 'verifying'}
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
                    <Button
                      variant="ghost"
                      size="sm"
                      role="tab"
                      aria-selected={rightTab === 'transcript'}
                      className={rightTab === 'transcript' ? 'tab active' : 'tab'}
                      onClick={() => setRightTab('transcript')}
                    >
                      {t(lang, 'transcriptTab')}
                      <span className="tab-count">{transcriptRowCount}</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      role="tab"
                      aria-selected={rightTab === 'slides'}
                      className={rightTab === 'slides' ? 'tab active' : 'tab'}
                      onClick={() => setRightTab('slides')}
                    >
                      {t(lang, 'slidesTab')}
                      <span className="tab-count">{pages.length}</span>
                    </Button>
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
              <Button
                variant="secondary"
                size="md"
                disabled={deleteSaving}
                onClick={() => setDeleteTarget(null)}
              >
                {t(lang, 'cancel')}
              </Button>
              <Button
                variant="danger"
                size="md"
                loading={deleteSaving}
                loadingLabel={t(lang, 'deleting')}
                onClick={() => void handleDeleteConfirm()}
              >
                {t(lang, 'delete')}
              </Button>
            </div>
          </div>
        </div>
      )}
      {keyDialogOpen && keySource !== null && (
        <ApiKeyDialog
          lang={lang}
          source={keySource}
          onClose={() => setKeyDialogOpen(false)}
          onChanged={(next, message) => {
            setKeySource(next)
            setKeyDialogOpen(false)
            if (next !== 'none') setError((prev) => (prev !== null && /API\s*키|API key/i.test(prev) ? null : prev))
            pushToast('info', message)
          }}
        />
      )}
      <ToastStack lang={lang} toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}

