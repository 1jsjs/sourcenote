import { useCallback, useEffect, useState } from 'react'
import type { Note, ProgressEvent, Segment, Source, SourceStatus } from '../../shared/types'

const BUDGET_CAP = 140

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
  const [spend, setSpend] = useState(0)
  const [progressBySource, setProgressBySource] = useState<Record<number, ProgressEvent>>({})
  const [newTitle, setNewTitle] = useState('')
  const [error, setError] = useState<string | null>(null)

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

  useEffect(() => {
    if (selectedNoteId !== null) void refreshSources(selectedNoteId)
    else {
      setSources([])
      setSegmentsBySource({})
    }
  }, [selectedNoteId, refreshSources])

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

  return (
    <div className="app">
      <header className="header">
        <h1>Sourcenote</h1>
        <span className="spend">
          ${spend.toFixed(4)} / ${BUDGET_CAP}
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
              </div>
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
                          <li key={seg.id}>
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
