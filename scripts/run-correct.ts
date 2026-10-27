/**
 * Headless term-correction runner: `npm run correct -- <noteId> [--accept-all]`
 *
 * Uses the exact same main-process modules as the Electron app (no Electron
 * imports), so behavior and budget accounting are identical. Requires the API
 * key via the macOS keychain or SOURCENOTE_META_API_KEY.
 */
import { budgetCapUsd, LedgerStore } from '../src/main/budget'
import { acceptAllCorrections, listCorrectionsDto, runCorrectionPipeline } from '../src/main/correction'
import { openDb } from '../src/main/db'
import { createMetaApi } from '../src/main/meta-api'
import { dbFilePath, ensureDataDir, ledgerFilePath } from '../src/main/paths'

const KIND_LABEL: Record<string, string> = {
  term: '용어',
  duplicate: '중복',
  typo: '오타',
}

function formatHms(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(Math.floor(totalSec / 3600))}:${pad(Math.floor((totalSec % 3600) / 60))}:${pad(
    totalSec % 60,
  )}`
}

function parseArgs(argv: string[]): { noteId: number; acceptAll: boolean } {
  const acceptAll = argv.includes('--accept-all')
  const positional = argv.filter((a) => a !== '--accept-all')
  if (positional.length !== 1 || !/^\d+$/.test(positional[0])) {
    console.error('사용법: npm run correct -- <noteId> [--accept-all]')
    process.exit(1)
  }
  return { noteId: Number(positional[0]), acceptAll }
}

async function main(): Promise<void> {
  const { noteId, acceptAll } = parseArgs(process.argv.slice(2))

  const dataDir = ensureDataDir()
  const db = openDb(dbFilePath(dataDir))
  const ledger = new LedgerStore(ledgerFilePath(dataDir))
  const metaApi = createMetaApi({ ledger })

  await runCorrectionPipeline({
    db,
    metaApi,
    onProgress: (event) => {
      if (event.stage === 'correcting') console.log('교정 제안 생성 중...')
    },
  }, noteId)

  if (acceptAll) {
    const { accepted } = acceptAllCorrections(db, noteId)
    console.log(`모두 수락: ${accepted}건`)
  }

  const corrections = listCorrectionsDto(db, noteId)
  if (corrections.length === 0) {
    console.log('교정 제안이 없습니다.')
  }
  for (const c of corrections) {
    const label = KIND_LABEL[c.kind] ?? c.kind
    console.log(
      `[${formatHms(c.startMs)}] ${c.beforeText} → ${c.afterText} (${label}) ${c.reason} [${c.status}]`,
    )
  }
  console.log(`누적 사용액: $${ledger.totalUsd.toFixed(4)} / $${budgetCapUsd()}`)
}

main().catch((err) => {
  console.error(`교정 실패: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
