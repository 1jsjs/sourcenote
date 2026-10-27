/**
 * Sample-note exporter: `npm run export-sample -- <noteId> <outDir>`
 *
 * Writes `<outDir>/note.json` (format `sample-note/v1`: only the latest
 * summary of each kind, no DB ids or absolute paths) and copies each
 * source's original file into `<outDir>` using its basename. The lead
 * generates the bundled `samples/notes/*` folders with this script.
 */
import fs from 'node:fs'
import path from 'node:path'
import { listSources, openDb } from '../src/main/db'
import { dbFilePath, ensureDataDir } from '../src/main/paths'
import { serializeSampleNote } from '../src/main/sample'

function parseArgs(argv: string[]): { noteId: number; outDir: string } {
  if (argv.length !== 2 || !/^\d+$/.test(argv[0])) {
    console.error('사용법: npm run export-sample -- <noteId> <outDir>')
    process.exit(1)
  }
  return { noteId: Number(argv[0]), outDir: path.resolve(argv[1]) }
}

function main(): void {
  const { noteId, outDir } = parseArgs(process.argv.slice(2))

  const dataDir = ensureDataDir()
  const db = openDb(dbFilePath(dataDir))
  try {
    const sample = serializeSampleNote(db, noteId)
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'note.json'), JSON.stringify(sample, null, 2), 'utf8')
    for (const source of listSources(db, noteId)) {
      const from = source.original_path
      const to = path.join(outDir, path.basename(from))
      fs.copyFileSync(from, to)
      console.log(`복사: ${from} -> ${to}`)
    }
    console.log(`샘플 저장: ${path.join(outDir, 'note.json')}`)
  } finally {
    db.close()
  }
}

main()
