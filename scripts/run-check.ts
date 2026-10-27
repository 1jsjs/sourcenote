/**
 * Headless notes-check runner: `npm run check -- <noteId> "문장1" "문장2" ...`
 *
 * Uses the exact same main-process modules as the Electron app (no Electron
 * imports), so behavior and budget accounting are identical. Requires the API
 * key via the macOS keychain or SOURCENOTE_META_API_KEY.
 */
import { budgetCapUsd, LedgerStore } from '../src/main/budget'
import { runCheckPipeline } from '../src/main/check-pipeline'
import { openDb } from '../src/main/db'
import { createMetaApi } from '../src/main/meta-api'
import { dbFilePath, ensureDataDir, ledgerFilePath } from '../src/main/paths'
import type { AppLanguage, Claim } from '../src/shared/types'
import { parseLangArg, resolveCliLanguage } from './cli-lang'

function formatHms(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(Math.floor(totalSec / 3600))}:${pad(Math.floor((totalSec % 3600) / 60))}:${pad(
    totalSec % 60,
  )}`
}

function printClaim(lang: AppLanguage, claim: Claim): void {
  const mark = claim.verdict === 'supported' ? '✓' : lang === 'en' ? '✗ Not in sources' : '✗ 자료에 없음'
  const times = claim.citations.map((c) => formatHms(c.startMs)).join(', ')
  const pages = claim.pageCitations
    .map((p) => `[p.${p.pageNo} ${p.sourceDisplayName}]`)
    .join(' ')
  const suffix = [times ? `[${times}]` : '', pages].filter((s) => s.length > 0).join(' ')
  console.log(`${mark} ${claim.text}${suffix ? ` ${suffix}` : ''}`)
  if (claim.verdict === 'unsupported' && claim.reason) {
    console.log(lang === 'en' ? `  Reason: ${claim.reason}` : `  사유: ${claim.reason}`)
  }
}

function parseArgs(argv: string[]): { noteId: number; text: string } {
  if (argv.length < 2 || !/^\d+$/.test(argv[0])) {
    console.error('사용법: npm run check -- <noteId> "문장1" "문장2" ... [--lang ko|en]')
    console.error('Usage: npm run check -- <noteId> "sentence1" "sentence2" ... [--lang ko|en]')
    process.exit(1)
  }
  return { noteId: Number(argv[0]), text: argv.slice(1).join('\n') }
}

async function main(): Promise<void> {
  const { lang: langFlag, rest } = parseLangArg(process.argv.slice(2))
  const { noteId, text } = parseArgs(rest)

  const dataDir = ensureDataDir()
  const lang = resolveCliLanguage(langFlag, dataDir)
  const db = openDb(dbFilePath(dataDir))
  const ledger = new LedgerStore(ledgerFilePath(dataDir))
  const metaApi = createMetaApi({ ledger })

  const summary = await runCheckPipeline({ db, metaApi, language: lang }, noteId, text)

  const supported = summary.claims.filter((c) => c.verdict === 'supported').length
  const unsupported = summary.claims.filter((c) => c.verdict === 'unsupported').length
  console.log(
    lang === 'en' ? `\n===== Notes check #${summary.id} =====` : `\n===== 내 필기 검증 #${summary.id} =====`,
  )
  for (const claim of summary.claims) {
    printClaim(lang, claim)
  }
  console.log(
    lang === 'en'
      ? `\nVerified ${supported} · Not in sources ${unsupported}`
      : `\n검증됨 ${supported} · 자료에 없음 ${unsupported}`,
  )
  console.log(
    lang === 'en'
      ? `Total spend: $${ledger.totalUsd.toFixed(4)} / $${budgetCapUsd()}`
      : `누적 사용액: $${ledger.totalUsd.toFixed(4)} / $${budgetCapUsd()}`,
  )
}

main().catch((err) => {
  console.error(`검증 실패: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
