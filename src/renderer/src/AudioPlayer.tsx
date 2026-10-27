import { useEffect, useRef, useState } from 'react'
import type { AppLanguage } from '../../shared/types'
import { t } from './i18n'

/** Short clock time: `12:34`, or `1:02:15` past an hour. */
export function formatHms(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

function PlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M3.5 2.2v7.6L10 6 3.5 2.2z" fill="currentColor" />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect x="3" y="2.2" width="2.2" height="7.6" rx="0.6" fill="currentColor" />
      <rect x="6.8" y="2.2" width="2.2" height="7.6" rx="0.6" fill="currentColor" />
    </svg>
  )
}

interface AudioPlayerProps {
  lang: AppLanguage
  sourceId: number
  sourceName: string
  /** Seek target in ms for the latest play request. */
  startMs: number
  /** Increment to trigger seek + play (so repeats of one position still fire). */
  playToken: number
  onTimeUpdate: (sourceId: number, currentMs: number) => void
}

/**
 * Single lecture-audio player bar. The file is served by the main process
 * over `sourcenote-media://source/<id>` (with HTTP Range, so seeking works).
 */
export default function AudioPlayer({
  lang,
  sourceId,
  sourceName,
  startMs,
  playToken,
  onTimeUpdate,
}: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [currentMs, setCurrentMs] = useState(0)
  const [durationMs, setDurationMs] = useState(0)
  const src = `sourcenote-media://source/${sourceId}`

  // A new source starts stopped at 0:00.
  useEffect(() => {
    setCurrentMs(0)
    setPlaying(false)
  }, [src])

  // Citation / timestamp clicks request seek + play from the parent.
  useEffect(() => {
    const el = audioRef.current
    if (!el || playToken === 0) return
    el.currentTime = Math.max(0, startMs / 1000)
    void el.play().catch(() => {
      // Autoplay policy or a torn-down element: the user can press play.
    })
  }, [playToken, startMs])

  const toggle = (): void => {
    const el = audioRef.current
    if (!el) return
    if (el.paused) {
      void el.play().catch(() => undefined)
    } else {
      el.pause()
    }
  }

  const seek = (seconds: number): void => {
    const el = audioRef.current
    if (!el) return
    el.currentTime = seconds
    setCurrentMs(seconds * 1000)
  }

  const maxSec = durationMs / 1000
  return (
    <div className="player" role="region" aria-label={t(lang, 'playerRegion')}>
      <button onClick={toggle} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {playing ? <PauseIcon /> : <PlayIcon />}
        {playing ? t(lang, 'pause') : t(lang, 'play')}
      </button>
      <span className="player-name" title={sourceName}>
        {sourceName}
      </span>
      <span className="player-time">
        {formatHms(currentMs)} / {formatHms(durationMs)}
      </span>
      <input
        className="player-progress"
        type="range"
        min={0}
        max={Number.isFinite(maxSec) ? maxSec : 0}
        step={0.1}
        value={maxSec > 0 ? Math.min(currentMs / 1000, maxSec) : 0}
        onChange={(e) => seek(Number(e.target.value))}
        aria-label={t(lang, 'seekLabel')}
      />
      <audio
        ref={audioRef}
        src={src}
        onTimeUpdate={(e) => {
          const el = e.currentTarget
          setCurrentMs(el.currentTime * 1000)
          onTimeUpdate(sourceId, el.currentTime * 1000)
        }}
        onLoadedMetadata={(e) => setDurationMs(e.currentTarget.duration * 1000)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
    </div>
  )
}
