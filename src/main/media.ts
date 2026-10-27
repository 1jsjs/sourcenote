/**
 * Pure helpers for the `sourcenote-media` custom protocol that serves local
 * lecture files (audio, PDF) to the renderer. The renderer must never read
 * arbitrary files: it only gets `sourcenote-media://source/<id>` URLs, and
 * the main process resolves the id through a DB lookup.
 */

/** Inclusive byte range parsed from an HTTP Range header. */
export interface ByteRange {
  start: number
  end: number
}

/**
 * Parses a single-part `bytes=` Range header against a file size.
 * Returns the inclusive range, `'unsatisfiable'` when the range starts past
 * the end of the file (HTTP 416), or null when the header is malformed or
 * uses an unsupported form (the caller then serves the full file with 200).
 */
export function parseRangeHeader(
  header: string,
  fileSize: number,
): ByteRange | null | 'unsatisfiable' {
  const trimmed = header.trim()
  const eq = trimmed.indexOf('=')
  if (eq < 0) return null
  const unit = trimmed.slice(0, eq).trim().toLowerCase()
  const spec = trimmed.slice(eq + 1).trim()
  if (unit !== 'bytes' || spec.length === 0 || spec.includes(',')) return null

  if (spec.startsWith('-')) {
    // Suffix range: the last N bytes.
    const suffix = Number(spec.slice(1))
    if (!Number.isInteger(suffix) || suffix <= 0) return null
    if (fileSize <= 0) return 'unsatisfiable'
    if (suffix >= fileSize) return { start: 0, end: fileSize - 1 }
    return { start: fileSize - suffix, end: fileSize - 1 }
  }

  const dash = spec.indexOf('-')
  if (dash < 0) return null
  const startRaw = spec.slice(0, dash).trim()
  const endRaw = spec.slice(dash + 1).trim()
  const start = Number(startRaw)
  if (startRaw.length === 0 || !Number.isInteger(start) || start < 0) return null
  if (start >= fileSize) return 'unsatisfiable'
  if (endRaw.length === 0) return { start, end: fileSize - 1 }
  const end = Number(endRaw)
  if (!Number.isInteger(end) || end < start) return null
  return { start, end: Math.min(end, fileSize - 1) }
}

/** Content-Type for a served file, chosen from its extension. */
export function mediaContentTypeForPath(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  const ext = (dot < 0 ? '' : filePath.slice(dot + 1)).toLowerCase()
  switch (ext) {
    case 'wav':
      return 'audio/wav'
    case 'mp3':
      return 'audio/mpeg'
    case 'm4a':
      return 'audio/mp4'
    case 'aac':
      return 'audio/aac'
    case 'flac':
      return 'audio/flac'
    case 'ogg':
      return 'audio/ogg'
    case 'webm':
      return 'audio/webm'
    case 'mp4':
      return 'video/mp4'
    case 'mov':
      return 'video/quicktime'
    case 'pdf':
      return 'application/pdf'
    default:
      return 'application/octet-stream'
  }
}

/**
 * Extracts the numeric source id from a `sourcenote-media://source/<id>` URL.
 * Returns null for any other shape so the caller can answer 404.
 */
export function parseMediaSourceUrl(url: string): number | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'sourcenote-media:' || parsed.host !== 'source') return null
  const match = /^\/(\d+)$/.exec(parsed.pathname)
  if (!match) return null
  const id = Number(match[1])
  return Number.isInteger(id) && id > 0 ? id : null
}
