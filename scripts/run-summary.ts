/**
 * Headless summary runner: `npm run summarize -- <noteId>`
 *
 * Uses the exact same main-process modules as the Electron app (no Electron
 * imports), so behavior and budget accounting are identical. Requires the API
 * key via the macOS keychain or SOURCENOTE_META_API_KEY.
 */
import { budgetCapUsd, LedgerStore } from '../src/main/budget'
import { getLatestSummary, openDb } from '../src/main/db'
import { createMetaApi } from '../src/main/meta-api'
import { runSummaryPipeline } from '../src/main/summary-pipeline'
import { dbFilePath, ensureDataDir, ledgerFilePath } from '../src/main/paths'
import type { Claim } from '../src/shared/types'

function formatHms(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(Math.floor(totalSec / 3600))}:${pad(Math.floor((totalSec % 3600) / 60))}:${pad(
    totalSec % 60,
  )}`
}

function printClaim(claim: Claim): void {
  const mark = claim.verdict === 'supported' ? '✓' : '✗ 자료에 없음'
  const times = claim.citations.map((c) => formatHms(c.startMs)).join(', ')
  const pages = claim.pageCitations
    .map((p) => `[p.${p.pageNo} ${p.sourceDisplayName}]`)
    .join(' ')
  const suffix = [times ? `[${times}]` : '', pages].filter((s) => s.length > 0).join(' ')
  console.log(`${mark} ${claim.text}${suffix ? ` ${suffix}` : ''}`)
  if (claim.verdict === 'unsupported' && claim.reason) {
    console.log(`  사유: ${claim.reason}`)
  }
}

function parseArgs(argv: string[]): number {
  if (argv.length !== 1 || !/^\d+$/.test(argv[0])) {
    console.error('사용법: npm run summarize -- <noteId>')
    process.exit(1)
  }
  return Number(argv[0])
}

async function main(): Promise<void> {
  const noteId = parseArgs(process.argv.slice(2))

  const dataDir = ensureDataDir()
  const db = openDb(dbFilePath(dataDir))
  const ledger = new LedgerStore(ledgerFilePath(dataDir))
  const metaApi = createMetaApi({ ledger })

  await runSummaryPipeline({
    db,
    metaApi,
    onProgress: (event) => {
      if (event.stage === 'summarizing') console.log('요약 중...')
      else if (event.stage === 'verifying') console.log('검증 중...')
    },
  }, noteId)

  const summary = getLatestSummary(db, noteId)
  if (!summary) {
    console.error('요약 결과를 찾을 수 없습니다.')
    process.exit(1)
  }
  const supported = summary.claims.filter((c) => c.verdict === 'supported').length
  const unsupported = summary.claims.filter((c) => c.verdict === 'unsupported').length
  console.log(`\n===== 근거 요약 #${summary.id} =====`)
  for (const claim of summary.claims) {
    printClaim(claim)
  }
  console.log(`\n검증됨 ${supported} · 자료에 없음 ${unsupported}`)
  console.log(`누적 사용액: $${ledger.totalUsd.toFixed(4)} / $${budgetCapUsd()}`)
}

main().catch((err) => {
  console.error(`요약 실패: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
