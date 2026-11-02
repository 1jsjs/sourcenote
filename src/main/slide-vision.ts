import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { createCanvas } from '@napi-rs/canvas'
// Same externalized legacy build as pdf.ts. Rendering needs the embedded
// fonts, so unlike extractPdfPages this getDocument call must NOT pass
// disableFontFace/useSystemFonts (Korean slide text renders correctly then).
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { AppLanguage } from '../shared/types'
import { BudgetExceededError } from './budget'
import {
  listNotePageImages,
  setPageImagePath,
  setPageVisualText,
  type NotePageImage,
} from './db'
import { MAX_PAGE_CHARS } from './grounding'
import type { ChatContentPart, ChatMessage, MetaApi } from './meta-api'
import { getDataDir, pageImagesDirPath } from './paths'

/**
 * Slide vision: renders each PDF slide page to a JPEG (locally, no API) and
 * lets Muse Spark read the image once, so charts, diagrams, equations and
 * tables — invisible in the extracted text — become citable evidence stored
 * as `pages.visual_text`. Verification also attaches the page image itself
 * (see verify-claims.ts).
 *
 * meta-api is a TYPE-ONLY import here: a value import would close the
 * meta-api -> fake-api -> pipeline -> verify-claims -> slide-vision cycle.
 */

/** Slide pages are rendered at this width for the vision calls. */
export const PAGE_IMAGE_WIDTH = 1280

/** At most this many slide-reading calls are in flight at once. */
export const SLIDE_VISUAL_CONCURRENCY = 3

export const SLIDE_VISUAL_SCHEMA_NAME = 'slide_visual'

export const SLIDE_VISUAL_SCHEMA = {
  type: 'object',
  properties: {
    visual: { type: 'string' },
  },
  required: ['visual'],
  additionalProperties: false,
} as const

/** Builds an image content part from a rendered slide JPEG on disk. */
export function imagePartFromFile(filePath: string): ChatContentPart {
  const data = fs.readFileSync(filePath)
  return {
    type: 'image_url',
    image_url: { url: `data:image/jpeg;base64,${data.toString('base64')}` },
  }
}

/** Minimal pdf.js page shape used for rendering (pdf.ts has the text side). */
interface RenderablePage {
  getViewport(opts: { scale: number }): { width: number; height: number }
  render(opts: {
    canvas: unknown
    canvasContext: unknown
    viewport: unknown
  }): { promise: Promise<void> }
}

/**
 * Renders the given 1-based pages of a PDF to JPEG buffers (~30–60 KB each).
 * The document is opened once for the whole batch.
 */
export async function renderPdfPageImages(
  filePath: string,
  pageNos: number[],
  width = PAGE_IMAGE_WIDTH,
): Promise<Map<number, Buffer>> {
  const buf = fs.readFileSync(filePath)
  const doc = (await getDocument({ data: new Uint8Array(buf) }).promise) as {
    getPage(n: number): Promise<unknown>
  }
  const images = new Map<number, Buffer>()
  for (const pageNo of pageNos) {
    const page = (await doc.getPage(pageNo)) as RenderablePage
    const base = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: width / base.width })
    const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height))
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise
    images.set(pageNo, await canvas.encode('jpeg', 85))
  }
  return images
}

/**
 * Renders the JPEG of every PDF page of the note whose image is missing
 * (`image_path` NULL or the file is gone), opening each source PDF once.
 * Rendering failures are non-fatal: they are logged and the page stays
 * text-only evidence (retried on the next run). Never throws.
 */
export async function ensurePageImages(
  db: DatabaseSync,
  noteId: number,
  dataDir: string = getDataDir(),
): Promise<void> {
  try {
    const missing = listNotePageImages(db, noteId).filter(
      (p) => p.imagePath === null || !fs.existsSync(p.imagePath),
    )
    if (missing.length === 0) return
    // Group by source so each PDF is opened once.
    const bySource = new Map<number, NotePageImage[]>()
    for (const page of missing) {
      const list = bySource.get(page.sourceId) ?? []
      list.push(page)
      bySource.set(page.sourceId, list)
    }
    const dir = pageImagesDirPath(dataDir)
    for (const [sourceId, pages] of bySource) {
      const originalPath = pages[0].originalPath
      if (!fs.existsSync(originalPath)) {
        // The source file is gone: nothing to render, pages stay text-only.
        continue
      }
      let rendered: Map<number, Buffer>
      try {
        rendered = await renderPdfPageImages(
          originalPath,
          pages.map((p) => p.pageNo),
        )
      } catch (err) {
        console.warn(`슬라이드 이미지 렌더링 실패 (source ${sourceId}):`, err)
        continue
      }
      fs.mkdirSync(dir, { recursive: true })
      for (const page of pages) {
        const image = rendered.get(page.pageNo)
        if (image === undefined) continue
        const filePath = path.join(dir, `${page.pageId}.jpg`)
        try {
          fs.writeFileSync(filePath, image)
          setPageImagePath(db, page.pageId, filePath)
        } catch (err) {
          console.warn(`슬라이드 이미지 저장 실패 (page ${page.pageId}):`, err)
        }
      }
    }
  } catch (err) {
    console.warn('슬라이드 이미지 준비 실패:', err)
  }
}

/** English instructions; the description itself comes back in the summary language. */
export function slideVisualSystemPrompt(language: AppLanguage): string {
  return (
    'You read one lecture slide image. Describe ONLY visual content that the extracted slide text does not already convey: ' +
    'charts and plots (axis labels and ranges, each series/legend label, the trend of each series, notable values, where curves cross, rise, fall or diverge), ' +
    'diagrams (boxes, arrows and what connects to what), equations (write them in plain text), tables (headers and cell values), and photos or illustrations. ' +
    'Do not repeat bullet text that is already in the extracted text. ' +
    'Describe only what is visible; do not explain, interpret beyond the image, or add outside knowledge. ' +
    'Use at most 120 words. If the slide has no visual content beyond its text, return an empty string. ' +
    (language === 'en' ? 'Write in English.' : 'Write in Korean.')
  )
}

/** Builds the slide-reading messages: the extracted text for context, then the page image. */
export function buildSlideVisualMessages(
  pageText: string,
  image: ChatContentPart,
  language: AppLanguage = 'ko',
): ChatMessage[] {
  const clipped = pageText.length > MAX_PAGE_CHARS ? pageText.slice(0, MAX_PAGE_CHARS) : pageText
  return [
    { role: 'system', content: slideVisualSystemPrompt(language) },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Extracted slide text:\n${clipped.trim().length > 0 ? clipped : '(none)'}`,
        },
        image,
      ],
    },
  ]
}

/** Validates the parsed slide_visual JSON shape. Throws a Korean error when invalid. */
export function parseSlideVisualPayload(raw: unknown): string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('슬라이드 읽기 응답 형식이 올바르지 않습니다.')
  }
  const visual = (raw as Record<string, unknown>).visual
  if (typeof visual !== 'string') {
    throw new Error('슬라이드 읽기 응답 형식이 올바르지 않습니다.')
  }
  return visual.trim()
}

/**
 * Budget-cap and key-refusal (HTTP 401/403) failures must abort the whole run
 * so the pipeline reports them like other API errors; anything else skips one
 * page. MetaApiError carries the status; the check is structural because
 * meta-api is a type-only import here (see the module comment).
 */
function isFatalReadError(err: unknown): boolean {
  if (err instanceof BudgetExceededError) return true
  const status = (err as { status?: unknown } | null)?.status
  return status === 401 || status === 403
}

export interface ReadSlideVisualsOptions {
  db: DatabaseSync
  metaApi: MetaApi
  model: string
  language: AppLanguage
  noteId: number
  /** Called with (finished, total) after each page is processed. */
  onProgress?: (finished: number, total: number) => void
}

/**
 * Reads each rendered slide page once with Muse Spark vision and stores the
 * description as `pages.visual_text`. Pages without an image file or already
 * read (visual_text NOT NULL) are skipped. At most SLIDE_VISUAL_CONCURRENCY
 * calls are in flight (same worker-pool style as the transcription pipeline).
 * Per-page failures are logged and skipped (visual_text stays NULL so the
 * next run retries); budget-cap and HTTP 401/403 errors abort by rethrowing.
 */
export async function readSlideVisuals(opts: ReadSlideVisualsOptions): Promise<void> {
  const { db, metaApi, model, language, noteId } = opts
  const todo = listNotePageImages(db, noteId).filter(
    (p): p is NotePageImage & { imagePath: string } =>
      p.visualText === null && p.imagePath !== null && fs.existsSync(p.imagePath),
  )
  if (todo.length === 0) return

  let next = 0
  let finished = 0
  let failed: unknown = null
  let hasFailed = false

  async function readOne(page: NotePageImage & { imagePath: string }): Promise<void> {
    const raw = await metaApi.chat({
      model,
      messages: buildSlideVisualMessages(page.text, imagePartFromFile(page.imagePath), language),
      responseFormat: { name: SLIDE_VISUAL_SCHEMA_NAME, schema: SLIDE_VISUAL_SCHEMA },
    })
    setPageVisualText(db, page.pageId, parseSlideVisualPayload(raw))
  }

  async function worker(): Promise<void> {
    for (;;) {
      if (hasFailed) return
      const i = next
      next += 1
      if (i >= todo.length) return
      const page = todo[i]
      try {
        await readOne(page)
      } catch (err) {
        if (isFatalReadError(err)) {
          if (!hasFailed) {
            hasFailed = true
            failed = err
          }
          return
        }
        console.warn(`슬라이드 읽기 실패 (page ${page.pageId}):`, err)
      }
      finished += 1
      opts.onProgress?.(finished, todo.length)
    }
  }

  const workerCount = Math.min(SLIDE_VISUAL_CONCURRENCY, todo.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  if (hasFailed) throw failed
}
