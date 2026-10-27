import { useEffect, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

// pdf.js renders pages on a worker; Vite serves the bundled worker file.
GlobalWorkerOptions.workerSrc = workerUrl

interface SlidePanelProps {
  sourceId: number
  pageNo: number
  displayName: string
  totalPages: number
  onNavigate: (pageNo: number) => void
  onClose: () => void
}

/** Right-side panel rendering one PDF slide page on a canvas. */
export default function SlidePanel({
  sourceId,
  pageNo,
  displayName,
  totalPages,
  onNavigate,
  onClose,
}: SlidePanelProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    getDocument(`sourcenote-media://source/${sourceId}`)
      .promise.then(async (doc) => {
        if (cancelled) return
        const page = await doc.getPage(pageNo)
        if (cancelled) return
        const canvas = canvasRef.current
        if (!canvas) return
        // Fit to the panel width.
        const width = 360
        const base = page.getViewport({ scale: 1 })
        const viewport = page.getViewport({ scale: width / base.width })
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          if (!cancelled) {
            setError('슬라이드를 그릴 수 없습니다.')
            setLoading(false)
          }
          return
        }
        await page.render({ canvasContext: ctx, viewport }).promise
        if (!cancelled) setLoading(false)
      })
      .catch(() => {
        if (!cancelled) {
          setError('슬라이드를 불러오지 못했습니다.')
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [sourceId, pageNo])

  return (
    <aside className="slide-panel" aria-label="슬라이드 보기">
      <header className="slide-header">
        <span className="slide-title">
          {displayName} p.{pageNo}/{totalPages}
        </span>
        <button onClick={onClose}>닫기</button>
      </header>
      {loading && <p className="empty">불러오는 중…</p>}
      {error !== null && <p className="source-error">{error}</p>}
      <canvas ref={canvasRef} className="slide-canvas" />
      <footer className="slide-nav">
        <button disabled={pageNo <= 1} onClick={() => onNavigate(pageNo - 1)}>
          이전
        </button>
        <button disabled={pageNo >= totalPages} onClick={() => onNavigate(pageNo + 1)}>
          다음
        </button>
      </footer>
    </aside>
  )
}
