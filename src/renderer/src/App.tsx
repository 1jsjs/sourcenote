import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Claim,
  Correction,
  CorrectionProgressEvent,
  Note,
  NotePage,
  ProgressEvent,
  Segment,
  Source,
  SourceStatus,
  Summary,
  SummaryProgressEvent,
} from '../../shared/types'
import AudioPlayer from './AudioPlayer'
import SlidePanel from './SlidePanel'

const CORRECTION_KIND_LABEL: Record<Correction['kind'], string> = {
  term: '용어',
  duplicate: '중복',
  typo: '오타',
}

function ClaimList({
  claims,
  onCiteSegment,
  onCitePage,
}: {
  claims: Claim[]
  onCiteSegment: (sourceId: number, segmentId: number, startMs: number) => void
  onCitePage: (sourceId: number, pageNo: number, displayName: string) => void
}) {
  return (
    <ul className="claims">
      {claims.map((claim) => (
        <li
          key={claim.id}
          className={claim.verdict === 'unsupported' ? 'claim claim-unsupported' : 'claim'}
        >
          <span className="claim-text">{claim.text}</span>{' '}
          {claim.verdict === 'unsupported' && <span className="badge-unsupported">자료에 없음</span>}{' '}
          {claim.citations.map((cite) => (
            <button
              key={cite.segmentId}
              className="cite-chip"
              title={cite.text}
              onClick={() => onCiteSegment(cite.sourceId, cite.segmentId, cite.startMs)}
            >
              {formatHms(cite.startMs)}
            </button>
          ))}
          {claim.pageCitations.map((cite) => (
            <button
              key={cite.pageId}
              className="page-chip"
              title={cite.text}
              onClick={() => onCitePage(cite.sourceId, cite.pageNo, cite.sourceDisplayName)}
            >
              p.{cite.pageNo}
            </button>
          ))}
          {claim.verdict === 'unsupported' && claim.reason !== null && (
            <div className="claim-reason">{claim.reason}</div>
          )}
        </li>
      ))}
    </ul>
  )
}

const STATUS_LABEL: Record<SourceStatus, string> = {
  pending: '대기',
  converting: '변환 중',
  transcribing: '전사 중',
  done: '완료',
  error: '오류',
}

function formatHms(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

export default function App() {
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
  const [checkText, setCheckText] = useState('')
  const [checkResult, setCheckResult] = useState<Summary | null>(null)
  const [checkRunning, setCheckRunning] = useState(false)
  const [highlightedSegmentId, setHighlightedSegmentId] = useState<number | null>(null)
  const [pages, setPages] = useState<NotePage[]>([])
  const [playerSourceId, setPlayerSourceId] = useState<number | null>(null)
  const [playerStartMs, setPlayerStartMs] = useState(0)
  const [playToken, setPlayToken] = useState(0)
  const [activeSegmentId, setActiveSegmentId] = useState<number | null>(null)
  const [slideSel, setSlideSel] = useState<{
    sourceId: number
    pageNo: number
    displayName: string
  } | null>(null)
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refreshSpend = useCallback(async () => {
    setSpend(await window.sourcenote.getSpend())
  }, [])

  const refreshNotes = useCallback(async () => {
    setNotes(await window.sourcenote.listNotes())
  }, [])

  const refreshSources = useCallback(
    async (noteId: number) => {
      const list = await window.sourcenote.listSources(noteId)
      setSources(list)
      const done = list.filter((s) => s.status === 'done')
      const entries = await Promise.all(
        done.map(async (s) => [s.id, await window.sourcenote.listSegments(s.id)] as const),
      )
      setSegmentsBySource(Object.fromEntries(entries))
      setPages(await window.sourcenote.listPages(noteId))
    },
    [],
  )

  useEffect(() => {
    void refreshNotes()
    void refreshSpend()
  }, [refreshNotes, refreshSpend])

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
    }
    setSummaryRunning(false)
    setSummaryStage(null)
    setCorrectionsRunning(false)
    setCorrectionStage(null)
    setCheckRunning(false)
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
    },
    [],
  )

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
    try {
      const result = await window.sourcenote.runCheck(selectedNoteId, checkText)
      setCheckResult(result)
      await refreshSpend()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCheckRunning(false)
    }
  }

  const highlightSegment = (segmentId: number): void => {
    const element = document.getElementById(`segment-${segmentId}`)
    if (element) {
      element.scrollIntoView({ block: 'center' })
      setHighlightedSegmentId(segmentId)
      if (highlightTimer.current !== null) clearTimeout(highlightTimer.current)
      highlightTimer.current = setTimeout(() => setHighlightedSegmentId(null), 2000)
    }
  }

  /** Switches the player to the segment's source if needed, seeks and plays. */
  const playSegment = useCallback((sourceId: number, startMs: number): void => {
    setPlayerSourceId(sourceId)
    setPlayerStartMs(startMs)
    setPlayToken((t) => t + 1)
  }, [])

  /** Finds which source a segment belongs to (correction chips only carry segmentId). */
  const sourceIdOfSegment = (segmentId: number): number | null => {
    for (const [sourceId, segments] of Object.entries(segmentsBySource)) {
      if (segments.some((s) => s.id === segmentId)) return Number(sourceId)
    }
    return null
  }

  const handleCiteClick = (sourceId: number, segmentId: number, startMs: number): void => {
    playSegment(sourceId, startMs)
    highlightSegment(segmentId)
  }

  const handleTimestampClick = (sourceId: number, segmentId: number, startMs: number): void => {
    playSegment(sourceId, startMs)
    highlightSegment(segmentId)
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
  const playerSource =
    doneAudioSources.find((s) => s.id === playerSourceId) ?? doneAudioSources[0] ?? null
  const pageCountBySource = new Map<number, number>()
  for (const p of pages) {
    pageCountBySource.set(p.sourceId, (pageCountBySource.get(p.sourceId) ?? 0) + 1)
  }
  const shownSegmentId = highlightedSegmentId ?? activeSegmentId

  return (
    <div className="app">
      <header className="header">
        <h1>Sourcenote</h1>
        <span className="spend">
          ${spend.spentUsd.toFixed(4)} / ${spend.capUsd}
        </span>
      </header>

      {error !== null && (
        <div className="error-banner" role="alert">
          {error}
          <button className="error-close" onClick={() => setError(null)}>
            닫기
          </button>
        </div>
      )}

      <div className="body">
        <aside className="sidebar">
          <div className="new-note">
            <input
              value={newTitle}
              placeholder="노트 제목"
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreateNote()
              }}
            />
            <button onClick={() => void handleCreateNote()}>새 노트</button>
          </div>
          <ul className="note-list">
            {notes.map((note) => (
              <li key={note.id}>
                <button
                  className={note.id === selectedNoteId ? 'note-item selected' : 'note-item'}
                  onClick={() => setSelectedNoteId(note.id)}
                >
                  {note.title}
                </button>
              </li>
            ))}
            {notes.length === 0 && <li className="empty">노트가 없습니다</li>}
          </ul>
        </aside>

        <main className="content">
          {selectedNoteId === null ? (
            <p className="empty">왼쪽에서 노트를 선택하거나 새로 만드세요.</p>
          ) : (
            <>
              <div className="content-actions">
                <button onClick={() => void handleAddAudio()}>오디오 파일 추가</button>
                <button onClick={() => void handleAddPdf()}>PDF 추가</button>
                <button
                  onClick={() => void handleRunSummary()}
                  disabled={summaryRunning || !sources.some((s) => s.status === 'done')}
                >
                  근거 요약 만들기
                </button>
                <button
                  onClick={() => void handleRunCorrections()}
                  disabled={
                    correctionsRunning ||
                    !sources.some((s) => s.kind === 'audio' && s.status === 'done')
                  }
                  title="전사 오류(용어·중복·오타) 수정 제안"
                >
                  용어 교정 제안
                </button>
                {summaryRunning && (
                  <span className="summary-progress">
                    {summaryStage === 'verifying' ? '검증 중…' : '요약 중…'}
                  </span>
                )}
                {correctionsRunning && (
                  <span className="summary-progress">
                    {correctionStage === 'done' ? '완료' : '교정 제안 생성 중…'}
                  </span>
                )}
              </div>
              {summary !== null && summary.claims.length > 0 && (
                <section className="summary">
                  <div className="summary-counts">
                    검증됨{' '}
                    {summary.claims.filter((c) => c.verdict === 'supported').length} · 자료에
                    없음 {summary.claims.filter((c) => c.verdict === 'unsupported').length}
                  </div>
                  <ClaimList
                    claims={summary.claims}
                    onCiteSegment={handleCiteClick}
                    onCitePage={(sourceId, pageNo, displayName) =>
                      setSlideSel({ sourceId, pageNo, displayName })
                    }
                  />
                </section>
              )}
              {corrections.length > 0 && (
                <section className="summary corrections">
                  <div className="summary-counts">
                    교정 제안 {corrections.filter((c) => c.status === 'pending').length} · 수락됨{' '}
                    {corrections.filter((c) => c.status === 'accepted').length} · 거절됨{' '}
                    {corrections.filter((c) => c.status === 'rejected').length}{' '}
                    {corrections.some((c) => c.status === 'pending') && (
                      <button
                        className="accept-all"
                        onClick={() => void handleAcceptAllCorrections()}
                      >
                        모두 수락
                      </button>
                    )}
                  </div>
                  <ul className="claims">
                    {corrections
                      .filter((c) => c.status === 'pending')
                      .map((c) => (
                        <li key={c.id} className="claim">
                          <button
                            className="cite-chip"
                            title="이 위치부터 재생"
                            onClick={() => {
                              const sourceId = sourceIdOfSegment(c.segmentId)
                              if (sourceId !== null) {
                                playSegment(sourceId, c.startMs)
                                highlightSegment(c.segmentId)
                              }
                            }}
                          >
                            {formatHms(c.startMs)}
                          </button>{' '}
                          <span className="correction-before">{c.beforeText}</span>
                          {' → '}
                          <span className="correction-after">{c.afterText}</span>{' '}
                          <span className="correction-kind">
                            {CORRECTION_KIND_LABEL[c.kind]}
                          </span>{' '}
                          <span className="correction-reason">{c.reason}</span>{' '}
                          <button onClick={() => void handleAcceptCorrection(c.id)}>수락</button>{' '}
                          <button onClick={() => void handleRejectCorrection(c.id)}>거절</button>
                        </li>
                      ))}
                  </ul>
                </section>
              )}
              <section className="summary check-notes">
                <h3 className="section-title">내 필기 검증</h3>
                <textarea
                  className="check-input"
                  value={checkText}
                  placeholder="강의를 듣고 적은 내용을 붙여 넣으세요. 문장마다 강의 근거를 찾아 맞는지 확인합니다."
                  onChange={(e) => setCheckText(e.target.value)}
                  rows={4}
                />
                <div className="check-actions">
                  <button
                    onClick={() => void handleRunCheck()}
                    disabled={checkRunning || checkText.trim().length === 0}
                  >
                    {checkRunning ? '검증 중…' : '검증하기'}
                  </button>
                </div>
                {checkResult !== null && checkResult.claims.length > 0 && (
                  <>
                    <div className="summary-counts">
                      검증됨{' '}
                      {checkResult.claims.filter((c) => c.verdict === 'supported').length} ·
                      자료에 없음{' '}
                      {checkResult.claims.filter((c) => c.verdict === 'unsupported').length}
                    </div>
                    <ClaimList
                      claims={checkResult.claims}
                      onCiteSegment={handleCiteClick}
                      onCitePage={(sourceId, pageNo, displayName) =>
                        setSlideSel({ sourceId, pageNo, displayName })
                      }
                    />
                  </>
                )}
              </section>
              {sources.length === 0 && <p className="empty">추가된 자료가 없습니다.</p>}
              {sources.map((source) => {
                const progress = progressBySource[source.id]
                const segments = segmentsBySource[source.id] ?? []
                const pageCount = pageCountBySource.get(source.id) ?? 0
                return (
                  <section key={source.id} className="source">
                    <header className="source-header">
                      <span className="source-name">{source.display_name}</span>
                      <span className={`status status-${source.status}`}>
                        {STATUS_LABEL[source.status]}
                        {source.status === 'transcribing' && progress && progress.totalChunks > 0
                          ? ` (${progress.chunk}/${progress.totalChunks} 청크)`
                          : ''}
                      </span>
                    </header>
                    {source.duration_ms !== null && (
                      <div className="source-meta">길이 {formatHms(source.duration_ms)}</div>
                    )}
                    {source.kind === 'pdf' && source.status === 'done' && (
                      <div className="source-meta">슬라이드 {pageCount}페이지</div>
                    )}
                    {source.status === 'error' && source.error !== null && (
                      <div className="source-error">{source.error}</div>
                    )}
                    {segments.length > 0 && (
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
                              title="이 위치부터 재생"
                              onClick={() =>
                                handleTimestampClick(source.id, seg.id, seg.start_ms)
                              }
                            >
                              [{formatHms(seg.start_ms)}–{formatHms(seg.end_ms)}]
                            </button>{' '}
                            {seg.original_text !== null && (
                              <span className="corrected-mark" title={`원문: ${seg.original_text}`}>
                                교정됨
                              </span>
                            )}{' '}
                            {seg.text}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                )
              })}
              {playerSource !== null && (
                <AudioPlayer
                  sourceId={playerSource.id}
                  sourceName={playerSource.display_name}
                  startMs={playerStartMs}
                  playToken={playToken}
                  onTimeUpdate={handlePlayerTime}
                />
              )}
            </>
          )}
        </main>
        {slideSel !== null && (
          <SlidePanel
            sourceId={slideSel.sourceId}
            pageNo={slideSel.pageNo}
            displayName={slideSel.displayName}
            totalPages={pageCountBySource.get(slideSel.sourceId) ?? slideSel.pageNo}
            onNavigate={(pageNo) => setSlideSel((prev) => (prev ? { ...prev, pageNo } : prev))}
            onClose={() => setSlideSel(null)}
          />
        )}
      </div>
    </div>
  )
}
