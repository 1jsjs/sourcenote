import path from 'node:path'

const ALL_AUDIO_EXTENSIONS = ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'webm', 'mp4', 'mov'] as const

/**
 * Audio extensions the converter can read on a platform. macOS decodes with
 * the system afconvert (no bundled ffmpeg), which cannot open WebM.
 */
export function audioExtensionsFor(platform: NodeJS.Platform): readonly string[] {
  return platform === 'darwin'
    ? ALL_AUDIO_EXTENSIONS.filter((ext) => ext !== 'webm')
    : ALL_AUDIO_EXTENSIONS
}

/** Audio extensions accepted by the add-audio dialog filter. */
export const AUDIO_EXTENSIONS: readonly string[] = audioExtensionsFor(process.platform)

export const PDF_EXTENSIONS: readonly string[] = ['pdf']

export interface ClassifiedPaths {
  audio: string[]
  pdf: string[]
  /** Paths that are neither audio nor PDF (dropped files we cannot use). */
  ignored: string[]
}

/**
 * Pure classifier for dropped / picked file paths: audio extensions go to
 * the transcription pipeline, `.pdf` to slide extraction, everything else
 * (including extensionless paths) is ignored. Matching is case-insensitive.
 */
export function classifyPaths(
  paths: string[],
  audioExtensions: readonly string[] = AUDIO_EXTENSIONS,
): ClassifiedPaths {
  const audio: string[] = []
  const pdf: string[] = []
  const ignored: string[] = []
  for (const p of paths) {
    const ext = path.extname(p).toLowerCase().replace(/^\./, '')
    if (audioExtensions.includes(ext)) audio.push(p)
    else if ((PDF_EXTENSIONS as readonly string[]).includes(ext)) pdf.push(p)
    else ignored.push(p)
  }
  return { audio, pdf, ignored }
}
