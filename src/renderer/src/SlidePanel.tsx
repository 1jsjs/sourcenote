import { useEffect, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { AppLanguage } from '../../shared/types'
import Button from './Button'
import { ChevronLeftIcon, ChevronRightIcon } from './icons'
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
}

/** Pane-filling viewer rendering one PDF slide page on a canvas. */
export default function SlidePanel({
  lang,
  sourceId,
  pageNo,
  displayName,
  totalPages,
  onNavigate,
}: SlidePanelProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [paneWidth, setPaneWidth] = useState(0)
  const [retryToken, setRetryToken] = useState(0)

  // Render at the pane width (times devicePixelRatio); re-render on resize.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    // Ignore small width changes: rendering the slide can toggle the pane's
    // scrollbar, which would otherwise trigger an endless re-render loop.
    const measure = (): void => {
      const w = el.clientWidth
      if (w > 0) setPaneWidth((prev) => (Math.abs(w - prev) < 24 ? prev : w))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Show the loading state only for a new page, not for resize re-renders.
  useEffect(() => {
    setLoading(true)
  }, [sourceId, pageNo, retryToken])

  useEffect(() => {
    if (paneWidth <= 0) return
    let cancelled = false
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
        const base = page.getViewport({ scale: 1 })
        // Render at device pixel ratio so slide text stays sharp on Retina.
        const dpr = window.devicePixelRatio || 1
        const viewport = page.getViewport({ scale: (paneWidth / base.width) * dpr })
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        canvas.style.width = `${paneWidth}px`
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
  }, [sourceId, pageNo, lang, paneWidth, retryToken])

  return (
    <div className="slide-view" aria-label={t(lang, 'slideRegion')}>
      <div className="slide-header">
        <span className="slide-title" title={displayName}>
          {displayName}
        </span>
        <span className="page-indicator">
          p.{pageNo} / {totalPages}
        </span>
      </div>
      <div ref={wrapRef}>
        {loading && (
          <>
            <div className="skeleton-page" aria-hidden="true" />
            <p className="empty">{t(lang, 'slideRetryHint')}</p>
          </>
        )}
        {error !== null && (
          <>
            <p className="empty">{error}</p>
            <Button size="sm" variant="ghost" onClick={() => setRetryToken((n) => n + 1)}>
              {t(lang, 'retry')}
            </Button>
          </>
        )}
        <canvas
          ref={canvasRef}
          className="slide-canvas"
          style={loading || error !== null ? { display: 'none' } : undefined}
        />
      </div>
      <footer className="slide-nav">
        <Button
          size="sm"
          variant="secondary"
          icon={<ChevronLeftIcon />}
          disabled={pageNo <= 1}
          onClick={() => onNavigate(pageNo - 1)}
          aria-label={t(lang, 'prev')}
          title={t(lang, 'prev')}
        >
          {t(lang, 'prev')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon={<ChevronRightIcon />}
          disabled={pageNo >= totalPages}
          onClick={() => onNavigate(pageNo + 1)}
          aria-label={t(lang, 'next')}
          title={t(lang, 'next')}
        >
          {t(lang, 'next')}
        </Button>
      </footer>
    </div>
  )
}
