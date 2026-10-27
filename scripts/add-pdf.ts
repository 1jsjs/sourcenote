/**
 * Headless PDF runner: `npm run add-pdf -- <noteId> <file.pdf>`
 *
 * Registers the PDF as a `kind='pdf'` source of an existing note and extracts
 * per-page text with the same main-process modules as the Electron app.
 * No API call is made.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createSource, getNote, listNotePages, openDb } from '../src/main/db'
import { dbFilePath, ensureDataDir } from '../src/main/paths'
import { ingestPdfSource } from '../src/main/pdf'

function parseArgs(argv: string[]): { noteId: number; file: string } {
  if (argv.length !== 2 || !/^\d+$/.test(argv[0])) {
    console.error('사용법: npm run add-pdf -- <noteId> <file.pdf>')
    process.exit(1)
  }
  const file = path.resolve(argv[1])
  if (!fs.existsSync(file)) {
    console.error(`파일을 찾을 수 없습니다: ${file}`)
    process.exit(1)
  }
  return { noteId: Number(argv[0]), file }
}

async function main(): Promise<void> {
  const { noteId, file } = parseArgs(process.argv.slice(2))

  const dataDir = ensureDataDir()
  const db = openDb(dbFilePath(dataDir))

  const note = getNote(db, noteId)
  if (!note) {
    console.error(`노트를 찾을 수 없습니다 (id=${noteId})`)
    process.exit(1)
  }

  const source = createSource(db, {
    noteId,
    kind: 'pdf',
    originalPath: file,
    displayName: path.basename(file),
  })
  console.log(`소스 등록: #${source.id} ${source.display_name}`)

  const pageCount = await ingestPdfSource(db, source.id)
  console.log(`추출 완료: ${pageCount}페이지`)

  const pages = listNotePages(db, noteId).filter((p) => p.sourceId === source.id)
  for (const page of pages) {
    const preview = page.text.slice(0, 80).replace(/\s+/g, ' ')
    console.log(`p.${page.pageNo}: ${preview}`)
  }
}

main().catch((err) => {
  console.error(`PDF 추가 실패: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
