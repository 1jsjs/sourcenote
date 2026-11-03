import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { AppLanguage, ImportedNotes } from '../shared/types'
import { DEFAULT_SUMMARY_MODEL } from './grounding'
import { langMsg } from './lang'
import type { ChatContentPart, ChatMessage, MetaApi } from './meta-api'
import { renderPdfPageImages } from './slide-vision'

/**
 * Notes from a photo or PDF: a student photographs paper notes (or exports
 * handwritten notes as a PDF) and Muse Spark copies the written lines into
 * the "Check my notes" box, word for word, so the usual check can run on
 * them. Images are prepared locally (size, HEIC on macOS);
 * nothing is stored.
 *
 * meta-api is a TYPE-ONLY import (see slide-vision.ts for the cycle).
 */

/** File extensions the import dialog offers. */
export const NOTE_FILE_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']

/** Longest side of a photo sent to the model (phone photos are ~4000 px). */
export const NOTE_IMAGE_MAX_SIDE = 2000

/** PDF pages are rendered at this width: handwriting needs more than slides. */
export const NOTE_PDF_PAGE_WIDTH = 1600

/** At most this many pages are read from one file. */
export const MAX_NOTE_PAGES = 10

/** At most this many page-reading calls are in flight at once. */
export const NOTE_READ_CONCURRENCY = 3

export const HANDWRITTEN_NOTES_SCHEMA_NAME = 'handwritten_notes'

export const HANDWRITTEN_NOTES_SCHEMA = {
  type: 'object',
  properties: {
    lines: { type: 'array', items: { type: 'string' } },
  },
  required: ['lines'],
  additionalProperties: false,
} as const

export const HANDWRITTEN_NOTES_SYSTEM_PROMPT =
  "You transcribe a student's lecture notes from a photo or scan of one page. The notes may be " +
  'handwritten or typed. Return the notes as lines in reading order, one statement per line. ' +
  "Copy the student's own words and language exactly, including mistakes, abbreviations and " +
  'wrong facts: do not correct, complete, translate, summarize or add anything. Join a statement ' +
  'that wraps onto the next line. Skip page headers, dates, page numbers, crossed-out text and ' +
  'doodles, and do not describe drawn charts or diagrams. If the page has no readable notes, ' +
  'return no lines.'

/** Builds the reading messages for one page image. */
export function buildHandwrittenNotesMessages(image: ChatContentPart): ChatMessage[] {
  return [
    { role: 'system', content: HANDWRITTEN_NOTES_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [{ type: 'text', text: 'Transcribe the notes on this page.' }, image],
    },
  ]
}

/** Validates the parsed JSON and returns the non-empty, trimmed lines. */
export function parseHandwrittenNotesPayload(raw: unknown): string[] {
  const lines =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).lines
      : undefined
  if (!Array.isArray(lines)) throw new Error('필기 읽기 응답 형식이 올바르지 않습니다.')
  return lines
    .filter((line): line is string => typeof line === 'string')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
}

/**
 * Scales an image so its longest side is at most `maxSide` and re-encodes it
 * as JPEG. The loader already turns phone photos upright from their EXIF
 * orientation, so width and height here are the upright ones.
 */
export async function prepareNoteImage(
  buf: Buffer,
  maxSide = NOTE_IMAGE_MAX_SIDE,
): Promise<Buffer> {
  const image = await loadImage(buf)
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height))
  const w = Math.max(1, Math.round(image.width * scale))
  const h = Math.max(1, Math.round(image.height * scale))
  const canvas = createCanvas(w, h)
  canvas.getContext('2d').drawImage(image, 0, 0, w, h)
  return canvas.encode('jpeg', 85)
}

/** HEIC/HEIF photos are converted to JPEG with macOS `sips` (keeps EXIF). */
function heicToJpeg(filePath: string, language: AppLanguage): Buffer {
  if (process.platform !== 'darwin') {
    throw new Error(
      langMsg(
        language,
        'HEIC 사진은 맥에서만 읽을 수 있어요. JPG로 내보내 다시 시도하세요.',
        'HEIC photos can only be read on a Mac. Export the photo as JPG and try again.',
      ),
    )
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-heic-'))
  const out = path.join(dir, 'page.jpg')
  try {
    execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', filePath, '--out', out], {
      stdio: 'ignore',
    })
    return fs.readFileSync(out)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** JPEG page images of a notes file, in page order (PDF pages capped). */
export async function noteFilePageImages(
  filePath: string,
  language: AppLanguage = 'ko',
): Promise<Buffer[]> {
  const ext = path.extname(filePath).slice(1).toLowerCase()
  if (!NOTE_FILE_EXTENSIONS.includes(ext)) {
    throw new Error(
      langMsg(
        language,
        'PDF나 사진(JPG·PNG·HEIC)만 가져올 수 있어요.',
        'Only a PDF or a photo (JPG, PNG, HEIC) can be imported.',
      ),
    )
  }
  if (ext === 'pdf') {
    const doc = (await getDocument({ data: new Uint8Array(fs.readFileSync(filePath)) }).promise) as {
      numPages: number
    }
    const pageNos = Array.from({ length: Math.min(doc.numPages, MAX_NOTE_PAGES) }, (_, i) => i + 1)
    const rendered = await renderPdfPageImages(filePath, pageNos, NOTE_PDF_PAGE_WIDTH)
    return pageNos.map((n) => rendered.get(n)).filter((b): b is Buffer => b !== undefined)
  }
  const raw = ext === 'heic' || ext === 'heif' ? heicToJpeg(filePath, language) : fs.readFileSync(filePath)
  return [await prepareNoteImage(raw)]
}

/**
 * Reads the notes in a photo or PDF with Muse Spark (one call per page,
 * pages in parallel) and returns them as one line per statement.
 */
export async function readNotesFile(opts: {
  metaApi: MetaApi
  filePath: string
  model?: string
  language?: AppLanguage
}): Promise<ImportedNotes> {
  const language = opts.language ?? 'ko'
  const model = opts.model ?? DEFAULT_SUMMARY_MODEL
  const images = await noteFilePageImages(opts.filePath, language)
  const linesByPage: string[][] = images.map(() => [])
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < images.length) {
      const i = next++
      const raw = await opts.metaApi.chat({
        model,
        messages: buildHandwrittenNotesMessages({
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${images[i].toString('base64')}` },
        }),
        responseFormat: { name: HANDWRITTEN_NOTES_SCHEMA_NAME, schema: HANDWRITTEN_NOTES_SCHEMA },
      })
      linesByPage[i] = parseHandwrittenNotesPayload(raw)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(NOTE_READ_CONCURRENCY, images.length) }, () => worker()),
  )
  const lines = linesByPage.flat()
  if (lines.length === 0) {
    throw new Error(
      langMsg(language, '파일에서 읽을 수 있는 필기를 찾지 못했어요.', 'No readable notes were found in the file.'),
    )
  }
  return {
    text: lines.join('\n'),
    lines: lines.length,
    pages: images.length,
    fileName: path.basename(opts.filePath),
  }
}
