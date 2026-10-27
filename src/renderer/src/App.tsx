import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Note,
  ProgressEvent,
  Segment,
  Source,
  SourceStatus,
  Summary,
  SummaryProgressEvent,
} from '../../shared/types'

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
  const [highlightedSegmentId, setHighlightedSegmentId] = useState<number | null>(null)
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

  useEffect(() => {
    if (selectedNoteId !== null) {
      void refreshSources(selectedNoteId)
      void refreshSummary(selectedNoteId)
    } else {
      setSources([])
      setSegmentsBySource({})
      setSummary(null)
    }
    setSummaryRunning(false)
    setSummaryStage(null)
  }, [selectedNoteId, refreshSources, refreshSummary])

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

  const handleCiteClick = (segmentId: number): void => {
    const element = document.getElementById(`segment-${segmentId}`)
    if (element) {
      element.scrollIntoView({ block: 'center' })
      setHighlightedSegmentId(segmentId)
      if (highlightTimer.current !== null) clearTimeout(highlightTimer.current)
      highlightTimer.current = setTimeout(() => setHighlightedSegmentId(null), 2000)
    }
  }

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
                <button
                  onClick={() => void handleRunSummary()}
                  disabled={summaryRunning || !sources.some((s) => s.status === 'done')}
                >
                  근거 요약 만들기
                </button>
                {summaryRunning && (
                  <span className="summary-progress">
                    {summaryStage === 'verifying' ? '검증 중…' : '요약 중…'}
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
                  <ul className="claims">
                    {summary.claims.map((claim) => (
                      <li
                        key={claim.id}
                        className={
                          claim.verdict === 'unsupported' ? 'claim claim-unsupported' : 'claim'
                        }
                      >
                        <span className="claim-text">{claim.text}</span>{' '}
                        {claim.verdict === 'unsupported' && (
                          <span className="badge-unsupported">자료에 없음</span>
                        )}{' '}
                        {claim.citations.map((cite) => (
                          <button
                            key={cite.segmentId}
                            className="cite-chip"
                            title={cite.text}
                            onClick={() => handleCiteClick(cite.segmentId)}
                          >
                            {formatHms(cite.startMs)}
                          </button>
                        ))}
                        {claim.verdict === 'unsupported' && claim.reason !== null && (
                          <div className="claim-reason">{claim.reason}</div>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {sources.length === 0 && <p className="empty">추가된 오디오가 없습니다.</p>}
              {sources.map((source) => {
                const progress = progressBySource[source.id]
                const segments = segmentsBySource[source.id] ?? []
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
                            className={seg.id === highlightedSegmentId ? 'highlight' : undefined}
                          >
                            <span className="seg-time">
                              [{formatHms(seg.start_ms)}–{formatHms(seg.end_ms)}]
                            </span>{' '}
                            {seg.text}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                )
              })}
            </>
          )}
        </main>
      </div>
    </div>
  )
}
