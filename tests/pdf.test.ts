import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { extractPdfPages, textItemsToPageText } from '../src/main/pdf'

/**
 * Builds a minimal valid PDF with one Helvetica text line per page, so the
 * extraction test runs against a REAL file through pdf.js (no mocks).
 */
function buildTestPdf(pageTexts: string[]): Buffer {
  const escape = (s: string): string =>
    s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  const objects: Record<number, string> = {}
  const pageObjNums: number[] = []
  let next = 4
  for (const _ of pageTexts) {
    pageObjNums.push(next)
    next += 2
  }
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] =
    `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] ` +
    `/Count ${pageTexts.length} >>`
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  pageTexts.forEach((text, i) => {
    const stream = `BT /F1 18 Tf 72 720 Td (${escape(text)}) Tj ET`
    const pageObj = pageObjNums[i]
    objects[pageObj] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageObj + 1} 0 R >>`
    objects[pageObj + 1] =
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  })
  const maxObj = 3 + pageTexts.length * 2
  let out = '%PDF-1.4\n'
  const offsets: Record<number, number> = {}
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = Buffer.byteLength(out)
    out += `${n} 0 obj\n${objects[n]}\nendobj\n`
  }
  const xrefPos = Buffer.byteLength(out)
  out += `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`
  for (let n = 1; n <= maxObj; n++) {
    out += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`
  }
  out += `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`
  return Buffer.from(out, 'latin1')
}

describe('textItemsToPageText', () => {
  it('joins same-line items with spaces and EOL items with newlines', () => {
    expect(
      textItemsToPageText([
        { str: '신경망', hasEOL: false },
        { str: '기초', hasEOL: true },
        { str: '다음 줄', hasEOL: false },
      ]),
    ).toBe('신경망 기초\n다음 줄')
  })

  it('trims and drops empty input', () => {
    expect(textItemsToPageText([])).toBe('')
    expect(textItemsToPageText([{ str: '  띄움  ', hasEOL: false }])).toBe('띄움')
  })

  it('does not double spaces when items already carry whitespace', () => {
    expect(
      textItemsToPageText([
        { str: 'Gradient ', hasEOL: false },
        { str: ' Descent ', hasEOL: false },
        { str: '& ', hasEOL: false },
        { str: ' Learning', hasEOL: false },
      ]),
    ).toBe('Gradient Descent & Learning')
  })

  it('keeps line breaks while collapsing space runs', () => {
    expect(
      textItemsToPageText([
        { str: '첫 줄  ', hasEOL: true },
        { str: '  둘째   줄', hasEOL: false },
      ]),
    ).toBe('첫 줄\n둘째 줄')
  })
})

describe('extractPdfPages (real pdf.js in Node)', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-pdf-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('extracts known text from each page of a real PDF', async () => {
    const file = path.join(dir, 'slides.pdf')
    fs.writeFileSync(file, buildTestPdf(['Hello Slide One', 'Second Page Content']))

    const pages = await extractPdfPages(file)

    expect(pages).toHaveLength(2)
    expect(pages[0]).toContain('Hello Slide One')
    expect(pages[1]).toContain('Second Page Content')
  })

  it('throws a Korean error for a missing or broken file', async () => {
    await expect(extractPdfPages(path.join(dir, 'missing.pdf'))).rejects.toThrow('PDF 파일')
    const broken = path.join(dir, 'broken.pdf')
    fs.writeFileSync(broken, 'this is not a pdf')
    await expect(extractPdfPages(broken)).rejects.toThrow('PDF')
  })
})
