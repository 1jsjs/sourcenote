import fs from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { getSource, insertPages, updateSourceStatus } from './db'
// Static import: pdfjs-dist is an externalized dependency, so this resolves
// from node_modules both in the Electron main build and under tsx/vitest.
// The legacy build runs on the main thread in Node (no worker needed).
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

/**
 * PDF slide ingestion: file -> per-page text rows in SQLite.
 * Pages are the second citable evidence type next to transcript segments.
 */

/** Minimal pdf.js text-item shape used for page text assembly. */
export interface PdfTextItem {
  str: string
  hasEOL?: boolean
}

/**
 * Turns one page's text items into plain text. Items on the same visual line
 * are joined with spaces; `hasEOL` starts a new line. Pure and unit-tested.
 */
export function textItemsToPageText(items: PdfTextItem[]): string {
  let out = ''
  for (const item of items) {
    out += item.str
    out += item.hasEOL ? '\n' : ' '
  }
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Extracts plain text per page (1-based order) from a PDF file. */
export async function extractPdfPages(filePath: string): Promise<string[]> {
  let buf: Buffer
  try {
    buf = fs.readFileSync(filePath)
  } catch {
    throw new Error(`PDF 파일을 읽을 수 없습니다: ${filePath}`)
  }
  let doc: { numPages: number; getPage(n: number): Promise<unknown> }
  try {
    doc = (await getDocument({
      data: new Uint8Array(buf),
      useSystemFonts: false,
      disableFontFace: true,
    }).promise) as typeof doc
  } catch {
    throw new Error('PDF 파일을 해석할 수 없습니다. 파일이 손상되었을 수 있습니다.')
  }
  const pages: string[] = []
  for (let n = 1; n <= doc.numPages; n++) {
    const page = (await doc.getPage(n)) as {
      getTextContent(): Promise<{ items: unknown[] }>
    }
    const content = await page.getTextContent()
    pages.push(textItemsToPageText(content.items as PdfTextItem[]))
  }
  return pages
}

/**
 * Ingests a registered `kind='pdf'` source: extracts per-page text, stores
 * page rows, and flips status converting -> done (or error with a Korean
 * message). Shared by the Electron IPC handler and the `add-pdf` CLI.
 */
export async function ingestPdfSource(db: DatabaseSync, sourceId: number): Promise<number> {
  const source = getSource(db, sourceId)
  if (!source) throw new Error(`소스를 찾을 수 없습니다 (id=${sourceId})`)
  updateSourceStatus(db, sourceId, 'converting')
  try {
    const texts = await extractPdfPages(source.original_path)
    insertPages(
      db,
      sourceId,
      texts.map((text, i) => ({ pageNo: i + 1, text })),
    )
    updateSourceStatus(db, sourceId, 'done')
    return texts.length
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    updateSourceStatus(db, sourceId, 'error', message)
    throw err instanceof Error ? err : new Error(message)
  }
}
