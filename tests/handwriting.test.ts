import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HANDWRITTEN_NOTES_SCHEMA_NAME,
  buildHandwrittenNotesMessages,
  noteFilePageImages,
  parseHandwrittenNotesPayload,
  prepareNoteImage,
  readNotesFile,
} from '../src/main/handwriting'
import type { ChatOptions, MetaApi } from '../src/main/meta-api'

const DEMO_PDF = fileURLToPath(new URL('../samples/demo-slides.pdf', import.meta.url))

/** A JPEG whose APP1 Exif segment carries the given orientation. */
function jpegWithOrientation(orientation: number, littleEndian: boolean): Buffer {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4)
  if (littleEndian) {
    tiff.write('II', 0, 'latin1')
    tiff.writeUInt16LE(42, 2)
    tiff.writeUInt32LE(8, 4)
    tiff.writeUInt16LE(1, 8)
    tiff.writeUInt16LE(0x0112, 10)
    tiff.writeUInt16LE(3, 12)
    tiff.writeUInt32LE(1, 14)
    tiff.writeUInt16LE(orientation, 18)
  } else {
    tiff.write('MM', 0, 'latin1')
    tiff.writeUInt16BE(42, 2)
    tiff.writeUInt32BE(8, 4)
    tiff.writeUInt16BE(1, 8)
    tiff.writeUInt16BE(0x0112, 10)
    tiff.writeUInt16BE(3, 12)
    tiff.writeUInt32BE(1, 14)
    tiff.writeUInt16BE(orientation, 18)
  }
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const app1 = Buffer.alloc(4)
  app1.writeUInt16BE(0xffe1, 0)
  app1.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, payload, Buffer.from([0xff, 0xda, 0, 2])])
}

function fakeMetaApi(lines: string[][]): { api: MetaApi; calls: ChatOptions[] } {
  const calls: ChatOptions[] = []
  const api: MetaApi = {
    transcribeChunk: async () => {
      throw new Error('unused')
    },
    chat: async (opts: ChatOptions) => {
      const i = calls.length
      calls.push(opts)
      return { lines: lines[i] ?? [] }
    },
  }
  return { api, calls }
}

describe('handwritten notes import', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-notes-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('scales a large photo down to the longest side as a JPEG', async () => {
    const canvas = createCanvas(4000, 3000)
    const png = await canvas.encode('png')
    const out = await prepareNoteImage(png, 2000)
    expect(out[0]).toBe(0xff)
    const img = await loadImage(out)
    expect([img.width, img.height]).toEqual([2000, 1500])
  })

  it('turns a sideways phone photo upright from its EXIF orientation', async () => {
    const jpeg = await createCanvas(400, 200).encode('jpeg', 80)
    const exif = jpegWithOrientation(6, false)
    // Splice the APP1 segment (between SOI and the fake SOS) in after the SOI.
    const app1 = exif.subarray(2, exif.length - 4)
    const rotated = Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)])
    const img = await loadImage(await prepareNoteImage(rotated, 2000))
    expect([img.width, img.height]).toEqual([200, 400])
  })

  it('keeps the trimmed non-empty lines and rejects a wrong shape', () => {
    expect(parseHandwrittenNotesPayload({ lines: ['  a  b ', '', 3, 'c'] })).toEqual(['a b', 'c'])
    expect(() => parseHandwrittenNotesPayload({ text: 'x' })).toThrow('필기 읽기 응답 형식이 올바르지 않습니다.')
  })

  it('sends one page image per call with the instructions', () => {
    const [system, user] = buildHandwrittenNotesMessages({
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,AAAA' },
    })
    expect(system.content).toContain("Copy the student's own words")
    expect(Array.isArray(user.content)).toBe(true)
    expect((user.content as Array<{ type: string }>)[1].type).toBe('image_url')
  })

  it('renders every page of a PDF', async () => {
    const pages = await noteFilePageImages(DEMO_PDF)
    expect(pages.length).toBeGreaterThan(1)
    expect(pages.every((b) => b[0] === 0xff && b[1] === 0xd8)).toBe(true)
  })

  it('rejects other file types with a localized message', async () => {
    const txt = path.join(dir, 'notes.txt')
    fs.writeFileSync(txt, 'x')
    await expect(noteFilePageImages(txt, 'en')).rejects.toThrow('Only a PDF or a photo')
  })

  it('joins the lines of all pages in page order', async () => {
    const photo = path.join(dir, 'notes.png')
    fs.writeFileSync(photo, await createCanvas(800, 600).encode('png'))
    const { api, calls } = fakeMetaApi([['First line.', 'Second line.']])
    const result = await readNotesFile({ metaApi: api, filePath: photo })
    expect(calls).toHaveLength(1)
    expect(calls[0].responseFormat).toMatchObject({ name: HANDWRITTEN_NOTES_SCHEMA_NAME })
    expect(result).toEqual({ text: 'First line.\nSecond line.', lines: 2, pages: 1, fileName: 'notes.png' })

    const pdfPages = (await noteFilePageImages(DEMO_PDF)).length
    const multi = fakeMetaApi(Array.from({ length: pdfPages }, (_, i) => [`page ${i + 1}`]))
    const fromPdf = await readNotesFile({ metaApi: multi.api, filePath: DEMO_PDF })
    expect(fromPdf.pages).toBe(pdfPages)
    expect(fromPdf.text.split('\n')).toEqual(
      Array.from({ length: pdfPages }, (_, i) => `page ${i + 1}`),
    )
  })

  it('fails clearly when nothing readable comes back', async () => {
    const photo = path.join(dir, 'blank.png')
    fs.writeFileSync(photo, await createCanvas(400, 300).encode('png'))
    const { api } = fakeMetaApi([[]])
    await expect(readNotesFile({ metaApi: api, filePath: photo, language: 'en' })).rejects.toThrow(
      'No readable notes were found',
    )
  })
})
