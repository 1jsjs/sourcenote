import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { BudgetExceededError } from '../src/main/budget'
import {
  createNote,
  createSource,
  insertPages,
  listNotePageImages,
  openDb,
  setPageImagePath,
  setPageVisualText,
  updateSourceStatus,
} from '../src/main/db'
import { MetaApiError, type ChatOptions, type MetaApi } from '../src/main/meta-api'
import { pageImagesDirPath } from '../src/main/paths'
import {
  buildSlideVisualMessages,
  ensurePageImages,
  imagePartFromFile,
  parseSlideVisualPayload,
  readSlideVisuals,
  renderPdfPageImages,
  SLIDE_VISUAL_SCHEMA_NAME,
} from '../src/main/slide-vision'

/** The bundled 4-page demo slides (never written to; rendered into temp dirs). */
const DEMO_PDF = fileURLToPath(new URL('../samples/demo-slides.pdf', import.meta.url))

function fakeChatApi(
  handler: (opts: ChatOptions) => Promise<unknown>,
  calls: ChatOptions[],
): MetaApi {
  return {
    transcribeChunk: async () => {
      throw new Error('사용되지 않음')
    },
    chat: async (opts: ChatOptions) => {
      calls.push(opts)
      return handler(opts)
    },
  }
}

/** Writes a tiny fake JPEG (content is irrelevant for the fake API). */
function writeFakeJpeg(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))
}

describe('slide vision', () => {
  let dir: string
  let db: DatabaseSync

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-vision-'))
    db = openDb(path.join(dir, 'test.sqlite'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** A note with a done pdf source; page texts are placeholders. */
  function seedPdfNote(originalPath: string, pageCount: number): { noteId: number; pageIds: number[] } {
    const note = createNote(db, '슬라이드 노트')
    const pdf = createSource(db, {
      noteId: note.id,
      kind: 'pdf',
      originalPath,
      displayName: path.basename(originalPath),
    })
    const pageIds = insertPages(
      db,
      pdf.id,
      Array.from({ length: pageCount }, (_, i) => ({ pageNo: i + 1, text: `슬라이드 ${i + 1}` })),
    )
    updateSourceStatus(db, pdf.id, 'done')
    return { noteId: note.id, pageIds }
  }

  describe('ensurePageImages', () => {
    it('renders the bundled demo slides into <dataDir>/page-images as JPEGs', async () => {
      const { noteId, pageIds } = seedPdfNote(DEMO_PDF, 4)
      const dataDir = path.join(dir, 'data')

      await ensurePageImages(db, noteId, dataDir)

      const pages = listNotePageImages(db, noteId)
      expect(pages).toHaveLength(4)
      for (const [i, pageId] of pageIds.entries()) {
        const imagePath = path.join(pageImagesDirPath(dataDir), `${pageId}.jpg`)
        expect(pages[i].imagePath).toBe(imagePath)
        const bytes = fs.readFileSync(imagePath)
        expect(bytes[0]).toBe(0xff)
        expect(bytes[1]).toBe(0xd8)
        expect(bytes.length).toBeGreaterThan(1000)
      }
    })

    it('re-renders only pages whose image file disappeared', async () => {
      const { noteId, pageIds } = seedPdfNote(DEMO_PDF, 4)
      const dataDir = path.join(dir, 'data')
      await ensurePageImages(db, noteId, dataDir)
      const removed = path.join(pageImagesDirPath(dataDir), `${pageIds[1]}.jpg`)
      fs.rmSync(removed)

      await ensurePageImages(db, noteId, dataDir)

      expect(fs.existsSync(removed)).toBe(true)
      for (const page of listNotePageImages(db, noteId)) {
        expect(page.imagePath).not.toBeNull()
        expect(fs.existsSync(page.imagePath as string)).toBe(true)
      }
    })

    it('is a no-op for notes without pdf pages and never touches the fs', async () => {
      const note = createNote(db, '오디오만')
      const dataDir = path.join(dir, 'data')
      await ensurePageImages(db, note.id, dataDir)
      expect(fs.existsSync(pageImagesDirPath(dataDir))).toBe(false)
    })

    it('never throws when the source file is missing or broken', async () => {
      const missing = seedPdfNote(path.join(dir, 'gone.pdf'), 2)
      await ensurePageImages(db, missing.noteId, path.join(dir, 'data'))
      expect(listNotePageImages(db, missing.noteId).map((p) => p.imagePath)).toEqual([null, null])

      const brokenPath = path.join(dir, 'broken.pdf')
      fs.writeFileSync(brokenPath, 'not a pdf')
      const broken = seedPdfNote(brokenPath, 2)
      await ensurePageImages(db, broken.noteId, path.join(dir, 'data'))
      expect(console.warn).toHaveBeenCalled()
      expect(listNotePageImages(db, broken.noteId).map((p) => p.imagePath)).toEqual([null, null])
    })
  })

  describe('renderPdfPageImages', () => {
    it('renders the requested 1-based pages only', async () => {
      const images = await renderPdfPageImages(DEMO_PDF, [1, 3])
      expect([...images.keys()]).toEqual([1, 3])
      for (const buf of images.values()) {
        expect(buf[0]).toBe(0xff)
        expect(buf[1]).toBe(0xd8)
      }
    })
  })

  describe('readSlideVisuals', () => {
    it('makes zero calls when the note has no pages', async () => {
      const note = createNote(db, '빈 노트')
      const calls: ChatOptions[] = []
      await readSlideVisuals({
        db,
        metaApi: fakeChatApi(async () => ({ visual: 'x' }), calls),
        model: 'muse-spark-1.3',
        language: 'ko',
        noteId: note.id,
      })
      expect(calls).toHaveLength(0)
    })

    it('reads pages with an image, skips pages without one and pages already read', async () => {
      const { noteId, pageIds } = seedPdfNote(DEMO_PDF, 4)
      const imgDir = path.join(dir, 'page-images')
      // page 1: image, unread -> read. page 2: no image -> skipped.
      // page 3: image + already read -> skipped. page 4: image, unread -> read.
      writeFakeJpeg(path.join(imgDir, `${pageIds[0]}.jpg`))
      setPageImagePath(db, pageIds[0], path.join(imgDir, `${pageIds[0]}.jpg`))
      writeFakeJpeg(path.join(imgDir, `${pageIds[2]}.jpg`))
      setPageImagePath(db, pageIds[2], path.join(imgDir, `${pageIds[2]}.jpg`))
      setPageVisualText(db, pageIds[2], '')
      writeFakeJpeg(path.join(imgDir, `${pageIds[3]}.jpg`))
      setPageImagePath(db, pageIds[3], path.join(imgDir, `${pageIds[3]}.jpg`))

      const calls: ChatOptions[] = []
      await readSlideVisuals({
        db,
        metaApi: fakeChatApi(async () => ({ visual: '그래프 설명' }), calls),
        model: 'muse-spark-1.3',
        language: 'ko',
        noteId,
      })

      expect(calls).toHaveLength(2)
      expect(calls[0].responseFormat?.name).toBe(SLIDE_VISUAL_SCHEMA_NAME)
      const pages = listNotePageImages(db, noteId)
      expect(pages.map((p) => p.visualText)).toEqual(['그래프 설명', null, '', '그래프 설명'])
    })

    it('keeps a failed page unread and continues with the others', async () => {
      const { noteId, pageIds } = seedPdfNote(DEMO_PDF, 3)
      const imgDir = path.join(dir, 'page-images')
      for (const pageId of pageIds) {
        writeFakeJpeg(path.join(imgDir, `${pageId}.jpg`))
        setPageImagePath(db, pageId, path.join(imgDir, `${pageId}.jpg`))
      }
      let callCount = 0
      const calls: ChatOptions[] = []
      await readSlideVisuals({
        db,
        metaApi: fakeChatApi(async () => {
          callCount += 1
          if (callCount === 2) throw new Error('일시적 오류')
          return { visual: `설명 ${callCount}` }
        }, calls),
        model: 'muse-spark-1.3',
        language: 'ko',
        noteId,
      })

      expect(calls).toHaveLength(3)
      expect(console.warn).toHaveBeenCalled()
      const visuals = listNotePageImages(db, noteId).map((p) => p.visualText)
      // Exactly one page stayed unread; the other two stored their description.
      expect(visuals.filter((v) => v === null)).toHaveLength(1)
      expect(visuals.filter((v) => typeof v === 'string' && v.startsWith('설명'))).toHaveLength(2)
    })

    it('rethrows budget-cap errors so the pipeline reports them', async () => {
      const { noteId, pageIds } = seedPdfNote(DEMO_PDF, 2)
      const imgDir = path.join(dir, 'page-images')
      writeFakeJpeg(path.join(imgDir, `${pageIds[0]}.jpg`))
      setPageImagePath(db, pageIds[0], path.join(imgDir, `${pageIds[0]}.jpg`))
      const calls: ChatOptions[] = []
      await expect(
        readSlideVisuals({
          db,
          metaApi: fakeChatApi(async () => {
            throw new BudgetExceededError(100, 1, 100)
          }, calls),
          model: 'muse-spark-1.3',
          language: 'ko',
          noteId,
        }),
      ).rejects.toBeInstanceOf(BudgetExceededError)
    })

    it('rethrows HTTP 401/403 key refusals', async () => {
      const { noteId, pageIds } = seedPdfNote(DEMO_PDF, 1)
      const imgDir = path.join(dir, 'page-images')
      writeFakeJpeg(path.join(imgDir, `${pageIds[0]}.jpg`))
      setPageImagePath(db, pageIds[0], path.join(imgDir, `${pageIds[0]}.jpg`))
      const calls: ChatOptions[] = []
      await expect(
        readSlideVisuals({
          db,
          metaApi: fakeChatApi(async () => {
            throw new MetaApiError('거부됨', 401)
          }, calls),
          model: 'muse-spark-1.3',
          language: 'ko',
          noteId,
        }),
      ).rejects.toBeInstanceOf(MetaApiError)
    })
  })

  describe('slide visual message building', () => {
    it('builds system + multipart user message with text context and the image', () => {
      const file = path.join(dir, 'p1.jpg')
      writeFakeJpeg(file)
      const part = imagePartFromFile(file)
      expect(part.type).toBe('image_url')
      if (part.type !== 'image_url') return
      expect(part.image_url.url.startsWith('data:image/jpeg;base64,')).toBe(true)

      const messages = buildSlideVisualMessages('슬라이드 본문', part, 'ko')
      expect(messages[0].content).toContain('Write in Korean.')
      const user = messages[1].content
      if (!Array.isArray(user)) throw new Error('expected content parts')
      expect(user[0]).toEqual({ type: 'text', text: 'Extracted slide text:\n슬라이드 본문' })
      expect(user[1]).toEqual(part)

      const en = buildSlideVisualMessages('', part, 'en')
      expect(en[0].content).toContain('Write in English.')
      const enUser = en[1].content
      if (!Array.isArray(enUser)) throw new Error('expected content parts')
      expect(enUser[0]).toEqual({ type: 'text', text: 'Extracted slide text:\n(none)' })
    })

    it('validates the slide_visual payload', () => {
      expect(parseSlideVisualPayload({ visual: '그래프' })).toBe('그래프')
      expect(parseSlideVisualPayload({ visual: '  ' })).toBe('')
      expect(() => parseSlideVisualPayload(null)).toThrow('형식')
      expect(() => parseSlideVisualPayload({ visual: 3 })).toThrow('형식')
    })
  })
})
