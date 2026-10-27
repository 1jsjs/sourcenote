/**
 * Headless pipeline runner: `npm run pipeline -- <audio file> [--title "..."]`
 *
 * Uses the exact same main-process modules as the Electron app (no Electron
 * imports), so behavior and budget accounting are identical. Requires the API
 * key via the macOS keychain or SOURCENOTE_META_API_KEY.
 */
import fs from 'node:fs'
import path from 'node:path'
import { budgetCapUsd, LedgerStore } from '../src/main/budget'
import {
  createNote,
  createSource,
  listSegments,
  openDb,
} from '../src/main/db'
import { createMetaApi } from '../src/main/meta-api'
import { runAudioPipeline } from '../src/main/pipeline'
import { dbFilePath, ensureDataDir, ledgerFilePath, mediaDirPath } from '../src/main/paths'

function formatHms(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(Math.floor(totalSec / 3600))}:${pad(Math.floor((totalSec % 3600) / 60))}:${pad(
    totalSec % 60,
  )}`
}

function parseArgs(argv: string[]): { file: string; title: string } {
  const positional: string[] = []
  let title = ''
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--title') {
      title = argv[++i] ?? ''
    } else {
      positional.push(argv[i])
    }
  }
  if (positional.length !== 1) {
    console.error('사용법: npm run pipeline -- <오디오 파일> [--title "노트 제목"]')
    process.exit(1)
  }
  const file = path.resolve(positional[0])
  if (!fs.existsSync(file)) {
    console.error(`파일을 찾을 수 없습니다: ${file}`)
    process.exit(1)
  }
  return { file, title: title || path.basename(file) }
}

async function main(): Promise<void> {
  const { file, title } = parseArgs(process.argv.slice(2))

  const dataDir = ensureDataDir()
  const db = openDb(dbFilePath(dataDir))
  const ledger = new LedgerStore(ledgerFilePath(dataDir))
  const metaApi = createMetaApi({ ledger })

  const note = createNote(db, title)
  console.log(`노트 생성: #${note.id} "${note.title}"`)

  const source = createSource(db, {
    noteId: note.id,
    kind: 'audio',
    originalPath: file,
    displayName: path.basename(file),
  })
  console.log(`소스 등록: #${source.id} ${source.display_name}`)

  await runAudioPipeline(
    {
      db,
      metaApi,
      mediaDir: mediaDirPath(dataDir),
      onProgress: (event) => {
        if (event.stage === 'transcribing') {
          console.log(`전사 중... 청크 ${event.chunk}/${event.totalChunks}`)
        } else {
          console.log(`단계: ${event.stage}`)
        }
      },
    },
    source.id,
  )

  const segments = listSegments(db, source.id)
  console.log('\n===== 세그먼트 =====')
  for (const seg of segments) {
    console.log(`[${formatHms(seg.start_ms)}–${formatHms(seg.end_ms)}] ${seg.text}`)
  }
  console.log(`\n총 ${segments.length}개 세그먼트`)
  console.log(`누적 사용액: $${ledger.totalUsd.toFixed(4)} / $${budgetCapUsd()}`)
}

main().catch((err) => {
  console.error(`파이프라인 실패: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
