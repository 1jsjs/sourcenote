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
  setNoteLanguages,
} from '../src/main/db'
import { createMetaApi } from '../src/main/meta-api'
import { runAudioPipeline } from '../src/main/pipeline'
import { dbFilePath, ensureDataDir, ledgerFilePath, mediaDirPath } from '../src/main/paths'
import { isLectureLanguage, isNoteLanguage } from '../src/shared/languages'
import type { AppLanguage } from '../src/shared/types'
import { parseLangArg, resolveCliLanguage } from './cli-lang'

function formatHms(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(Math.floor(totalSec / 3600))}:${pad(Math.floor((totalSec % 3600) / 60))}:${pad(
    totalSec % 60,
  )}`
}

function usage(): never {
  console.error(
    '사용법: npm run pipeline -- <오디오 파일> [--title "노트 제목"] [--lang ko|en] ' +
      '[--lecture-lang default|auto|언어명] [--note-lang app|언어명]',
  )
  console.error(
    'Usage: npm run pipeline -- <audio file> [--title "title"] [--lang ko|en] ' +
      '[--lecture-lang default|auto|Name] [--note-lang app|Name]',
  )
  process.exit(1)
}

function parseArgs(argv: string[]): {
  file: string
  title: string
  lectureLang: string | null
  noteLang: string | null
} {
  const positional: string[] = []
  let title = ''
  let lectureLang: string | null = null
  let noteLang: string | null = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--title') {
      title = argv[++i] ?? ''
    } else if (argv[i] === '--lecture-lang') {
      lectureLang = argv[++i] ?? ''
    } else if (argv[i] === '--note-lang') {
      noteLang = argv[++i] ?? ''
    } else {
      positional.push(argv[i])
    }
  }
  if (positional.length !== 1) usage()
  if (lectureLang !== null && !isLectureLanguage(lectureLang)) {
    console.error(`지원하지 않는 강의 언어입니다: ${lectureLang} (Unsupported lecture language)`)
    process.exit(1)
  }
  if (noteLang !== null && !isNoteLanguage(noteLang)) {
    console.error(`지원하지 않는 노트 언어입니다: ${noteLang} (Unsupported note language)`)
    process.exit(1)
  }
  const file = path.resolve(positional[0])
  if (!fs.existsSync(file)) {
    console.error(`파일을 찾을 수 없습니다: ${file}`)
    process.exit(1)
  }
  return { file, title: title || path.basename(file), lectureLang, noteLang }
}

async function main(): Promise<void> {
  const { lang: langFlag, rest } = parseLangArg(process.argv.slice(2))
  const { file, title, lectureLang, noteLang } = parseArgs(rest)

  const dataDir = ensureDataDir()
  const lang: AppLanguage = resolveCliLanguage(langFlag, dataDir)
  const db = openDb(dbFilePath(dataDir))
  const ledger = new LedgerStore(ledgerFilePath(dataDir))
  const metaApi = createMetaApi({ ledger })

  const note = createNote(db, title)
  if (lectureLang !== null || noteLang !== null) {
    setNoteLanguages(db, note.id, {
      ...(lectureLang !== null ? { lectureLanguage: lectureLang } : {}),
      ...(noteLang !== null ? { noteLanguage: noteLang } : {}),
    })
  }
  console.log(lang === 'en' ? `Note created: #${note.id} "${note.title}"` : `노트 생성: #${note.id} "${note.title}"`)

  const source = createSource(db, {
    noteId: note.id,
    kind: 'audio',
    originalPath: file,
    displayName: path.basename(file),
  })
  console.log(
    lang === 'en'
      ? `Source registered: #${source.id} ${source.display_name}`
      : `소스 등록: #${source.id} ${source.display_name}`,
  )

  await runAudioPipeline(
    {
      db,
      metaApi,
      mediaDir: mediaDirPath(dataDir),
      onProgress: (event) => {
        if (event.stage === 'transcribing') {
          console.log(
            lang === 'en'
              ? `Transcribing... chunk ${event.chunk}/${event.totalChunks}`
              : `전사 중... 청크 ${event.chunk}/${event.totalChunks}`,
          )
        } else {
          console.log(lang === 'en' ? `Stage: ${event.stage}` : `단계: ${event.stage}`)
        }
      },
    },
    source.id,
  )

  const segments = listSegments(db, source.id)
  console.log(lang === 'en' ? '\n===== Segments =====' : '\n===== 세그먼트 =====')
  for (const seg of segments) {
    console.log(`[${formatHms(seg.start_ms)}–${formatHms(seg.end_ms)}] ${seg.text}`)
  }
  console.log(lang === 'en' ? `\n${segments.length} segments total` : `\n총 ${segments.length}개 세그먼트`)
  console.log(
    lang === 'en'
      ? `Total spend: $${ledger.totalUsd.toFixed(4)} / $${budgetCapUsd()}`
      : `누적 사용액: $${ledger.totalUsd.toFixed(4)} / $${budgetCapUsd()}`,
  )
}

main().catch((err) => {
  console.error(`파이프라인 실패: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
