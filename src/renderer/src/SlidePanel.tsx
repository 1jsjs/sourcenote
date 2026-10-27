import { useEffect, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { AppLanguage } from '../../shared/types'
import { t } from './i18n'

// pdf.js renders pages on a worker; Vite serves the bundled worker file.
GlobalWorkerOptions.workerSrc = workerUrl

interface SlidePanelProps {
  lang: AppLanguage
  sourceId: number
  pageNo: number
  displayName: string
  totalPages: number
  onNavigate: (pageNo: number) => void
  onClose: () => void
}

/** Right-side panel rendering one PDF slide page on a canvas. */
export default function SlidePanel({
  lang,
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
    // pdf.js 6 only accepts { url | data | range }; fetch the bytes through the
    // media protocol ourselves so no custom-scheme loader is involved.
    fetch(`sourcenote-media://source/${sourceId}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.arrayBuffer()
      })
      .then((buf) => getDocument({ data: new Uint8Array(buf) }).promise)
      .then(async (doc) => {
        if (cancelled) return
        const page = await doc.getPage(pageNo)
        if (cancelled) return
        const canvas = canvasRef.current
        if (!canvas) return
        // Fit to the panel width.
        const width = 360
        const base = page.getViewport({ scale: 1 })
        // Render at device pixel ratio so slide text stays sharp on Retina.
        const dpr = window.devicePixelRatio || 1
        const viewport = page.getViewport({ scale: (width / base.width) * dpr })
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        canvas.style.width = `${width}px`
        canvas.style.height = `${Math.floor(viewport.height / dpr)}px`
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          if (!cancelled) {
            setError(t(lang, 'slideRenderError'))
            setLoading(false)
          }
          return
        }
        await page.render({ canvas, canvasContext: ctx, viewport }).promise
        if (!cancelled) setLoading(false)
      })
      .catch((err: unknown) => {
        console.error('slide load failed', err)
        if (!cancelled) {
          setError(t(lang, 'slideLoadError'))
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [sourceId, pageNo, lang])

  return (
    <aside className="slide-panel" aria-label={t(lang, 'slideRegion')}>
      <header className="slide-header">
        <span className="slide-title">
          {displayName} p.{pageNo}/{totalPages}
        </span>
        <button onClick={onClose}>{t(lang, 'close')}</button>
      </header>
      {loading && <p className="empty">{t(lang, 'slideLoading')}</p>}
      {error !== null && <p className="source-error">{error}</p>}
      <canvas ref={canvasRef} className="slide-canvas" />
      <footer className="slide-nav">
        <button disabled={pageNo <= 1} onClick={() => onNavigate(pageNo - 1)}>
          {t(lang, 'prev')}
        </button>
        <button disabled={pageNo >= totalPages} onClick={() => onNavigate(pageNo + 1)}>
          {t(lang, 'next')}
        </button>
      </footer>
    </aside>
  )
}
