import fs from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Pricing (USD). Keep in sync with Meta API pricing.
// ---------------------------------------------------------------------------

export const BUDGET_CAP_USD = 140

export interface ChatPrices {
  inputPer1M: number
  outputPer1M: number
}

export const CHAT_PRICES: Record<string, ChatPrices> = {
  'muse-spark-1.3': { inputPer1M: 1.25, outputPer1M: 4.25 },
  'muse-spark-1.3-contributor': { inputPer1M: 0.1, outputPer1M: 0.2 },
}

/** Unknown chat models are billed at muse-spark-1.3 prices (conservative). */
export const DEFAULT_CHAT_PRICES: ChatPrices = CHAT_PRICES['muse-spark-1.3']

export const TRANSCRIBE_MODEL = 'muse-voice-transcribe-1.0'
export const TRANSCRIBE_USD_PER_HOUR = 0.18

// ---------------------------------------------------------------------------
// Pure cost math
// ---------------------------------------------------------------------------

/**
 * Cost of a chat call. In the Meta API usage object `completion_tokens`
 * ALREADY INCLUDES reasoning tokens, so reasoning is never added on top.
 * Defensive case: if a response ever reports completion < reasoning, bill
 * reasoning + completion so nothing is under-counted.
 */
export function chatCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  reasoningTokens = 0,
): number {
  const prices = CHAT_PRICES[model] ?? DEFAULT_CHAT_PRICES
  const billedCompletion =
    completionTokens < reasoningTokens ? completionTokens + reasoningTokens : completionTokens
  return (promptTokens * prices.inputPer1M + billedCompletion * prices.outputPer1M) / 1_000_000
}

/** Cost of one transcribe call, billed per hour of audio. */
export function transcribeCostUsd(audioMs: number): number {
  return (audioMs / 3_600_000) * TRANSCRIBE_USD_PER_HOUR
}

/**
 * Conservative chat estimate made BEFORE the call: promptChars/2 input tokens
 * plus max_tokens (default 8000) output tokens.
 */
export function estimateChatCostUsd(model: string, promptChars: number, maxTokens?: number): number {
  const promptTokens = Math.ceil(promptChars / 2)
  const outputTokens = maxTokens ?? 8000
  return chatCostUsd(model, promptTokens, outputTokens)
}

/** Transcribe estimate made BEFORE the call, from the chunk duration. */
export function estimateTranscribeCostUsd(chunkDurationMs: number): number {
  return transcribeCostUsd(chunkDurationMs)
}

// ---------------------------------------------------------------------------
// Budget guard
// ---------------------------------------------------------------------------

export class BudgetExceededError extends Error {
  readonly totalUsd: number
  readonly attemptedUsd: number

  constructor(totalUsd: number, attemptedUsd: number) {
    super(
      `예산 한도($${BUDGET_CAP_USD})에 도달해 호출을 막았습니다 ` +
        `(현재 사용 $${totalUsd.toFixed(4)}, 예상 $${attemptedUsd.toFixed(4)})`,
    )
    this.name = 'BudgetExceededError'
    this.totalUsd = totalUsd
    this.attemptedUsd = attemptedUsd
  }
}

/** Pure cap check. Throws BudgetExceededError at or over the cap. */
export function assertCanSpend(totalUsd: number, estimatedUsd: number): void {
  if (totalUsd >= BUDGET_CAP_USD || totalUsd + estimatedUsd > BUDGET_CAP_USD) {
    throw new BudgetExceededError(totalUsd, estimatedUsd)
  }
}

// ---------------------------------------------------------------------------
// Ledger (file IO separated from the pure logic above)
// ---------------------------------------------------------------------------

export interface LedgerEntry {
  ts: string
  kind: 'chat' | 'transcribe'
  model: string
  promptTokens?: number
  completionTokens?: number
  reasoningTokens?: number
  audioMs?: number
  usd: number
}

export interface Ledger {
  totalUsd: number
  entries: LedgerEntry[]
}

export function emptyLedger(): Ledger {
  return { totalUsd: 0, entries: [] }
}

export function parseLedger(raw: string): Ledger {
  const parsed = JSON.parse(raw) as Partial<Ledger>
  const entries = Array.isArray(parsed.entries) ? (parsed.entries as LedgerEntry[]) : []
  const totalUsd = typeof parsed.totalUsd === 'number' ? parsed.totalUsd : 0
  return { totalUsd, entries }
}

export function serializeLedger(ledger: Ledger): string {
  return JSON.stringify(ledger, null, 2)
}

/**
 * JSON-file ledger with atomic writes (temp file + rename). Survives restarts.
 * Always re-reads the file (no in-memory cache) so the app and the CLI, which
 * share one ledger, never miss each other's spend.
 */
export class LedgerStore {
  private readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  load(): Ledger {
    let raw: string
    try {
      raw = fs.readFileSync(this.filePath, 'utf8')
    } catch {
      // Missing file starts a fresh ledger.
      return emptyLedger()
    }
    // A corrupt ledger must not silently reset spend to $0: fail closed.
    return parseLedger(raw)
  }

  get totalUsd(): number {
    return this.load().totalUsd
  }

  assertCanSpend(estimatedUsd: number): void {
    assertCanSpend(this.totalUsd, estimatedUsd)
  }

  record(entry: Omit<LedgerEntry, 'ts'>): LedgerEntry {
    const ledger = this.load()
    const full: LedgerEntry = { ...entry, ts: new Date().toISOString() }
    ledger.entries.push(full)
    ledger.totalUsd += full.usd
    this.saveAtomic(ledger)
    return full
  }

  /** Write to a temp file in the same directory, then rename over the target. */
  private saveAtomic(ledger: Ledger): void {
    const dir = path.dirname(this.filePath)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = path.join(
      dir,
      `usage-ledger-${process.pid}-${Math.random().toString(36).slice(2)}.json.tmp`,
    )
    fs.writeFileSync(tmp, serializeLedger(ledger), 'utf8')
    fs.renameSync(tmp, this.filePath)
  }
}
