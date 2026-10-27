import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertCanSpend,
  BUDGET_CAP_USD,
  BudgetExceededError,
  chatCostUsd,
  estimateChatCostUsd,
  estimateTranscribeCostUsd,
  LedgerStore,
  parseLedger,
  serializeLedger,
  transcribeCostUsd,
} from '../src/main/budget'

describe('chatCostUsd', () => {
  it('bills prompt + completion at muse-spark-1.3 prices', () => {
    // 1M prompt tokens + 1M completion tokens = $1.25 + $4.25
    expect(chatCostUsd('muse-spark-1.3', 1_000_000, 1_000_000)).toBeCloseTo(1.25 + 4.25, 10)
  })

  it('does NOT double count reasoning tokens (completion already includes them)', () => {
    const withReasoning = chatCostUsd('muse-spark-1.3', 1000, 500, 400)
    const withoutReasoning = chatCostUsd('muse-spark-1.3', 1000, 500)
    expect(withReasoning).toBe(withoutReasoning)
  })

  it('defensive case: completion < reasoning bills both so nothing is under-counted', () => {
    const cost = chatCostUsd('muse-spark-1.3', 0, 100, 300)
    expect(cost).toBeCloseTo((400 * 4.25) / 1_000_000, 12)
  })

  it('uses contributor prices for muse-spark-1.3-contributor', () => {
    expect(chatCostUsd('muse-spark-1.3-contributor', 1_000_000, 1_000_000)).toBeCloseTo(0.3, 10)
  })

  it('falls back to muse-spark-1.3 prices for unknown models', () => {
    expect(chatCostUsd('some-future-model', 1_000_000, 1_000_000)).toBeCloseTo(5.5, 10)
  })
})

describe('transcribeCostUsd', () => {
  it('bills $0.18 per hour of audio', () => {
    expect(transcribeCostUsd(3_600_000)).toBeCloseTo(0.18, 12)
  })

  it('scales linearly from milliseconds', () => {
    expect(transcribeCostUsd(37_280)).toBeCloseTo((37_280 / 3_600_000) * 0.18, 12)
  })

  it('estimate matches actual for the same duration', () => {
    expect(estimateTranscribeCostUsd(570_000)).toBe(transcribeCostUsd(570_000))
  })
})

describe('assertCanSpend (cap $140)', () => {
  it('allows spend below the cap', () => {
    expect(() => assertCanSpend(10, 5)).not.toThrow()
  })

  it('blocks when the total is AT the cap', () => {
    expect(() => assertCanSpend(BUDGET_CAP_USD, 0.001)).toThrow(BudgetExceededError)
  })

  it('blocks when the total is OVER the cap', () => {
    expect(() => assertCanSpend(145, 0.001)).toThrow(BudgetExceededError)
  })

  it('blocks an estimate that would cross the cap', () => {
    expect(() => assertCanSpend(139.999, 0.002)).toThrow(BudgetExceededError)
  })

  it('allows an estimate that lands exactly under the cap', () => {
    expect(() => assertCanSpend(139.998, 0.002)).not.toThrow()
  })

  it('error carries Korean message and amounts', () => {
    try {
      assertCanSpend(140, 1)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError)
      const e = err as BudgetExceededError
      expect(e.message).toContain('예산 한도($140)에 도달해 호출을 막았습니다')
      expect(e.totalUsd).toBe(140)
      expect(e.attemptedUsd).toBe(1)
    }
  })
})

describe('estimateChatCostUsd', () => {
  it('estimates promptChars/2 input tokens plus maxTokens output', () => {
    const est = estimateChatCostUsd('muse-spark-1.3', 2000, 1000)
    expect(est).toBeCloseTo(chatCostUsd('muse-spark-1.3', 1000, 1000), 12)
  })

  it('defaults to 8000 output tokens', () => {
    expect(estimateChatCostUsd('muse-spark-1.3', 0)).toBeCloseTo(
      chatCostUsd('muse-spark-1.3', 0, 8000),
      12,
    )
  })
})

describe('LedgerStore', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-ledger-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('starts empty when the file does not exist', () => {
    const store = new LedgerStore(path.join(dir, 'usage-ledger.json'))
    expect(store.totalUsd).toBe(0)
    expect(store.load().entries).toEqual([])
  })

  it('persists across instances (round-trip)', () => {
    const file = path.join(dir, 'usage-ledger.json')
    const a = new LedgerStore(file)
    a.record({ kind: 'transcribe', model: 'muse-voice-transcribe-1.0', audioMs: 37_280, usd: 0.001864 })
    a.record({ kind: 'chat', model: 'muse-spark-1.3', promptTokens: 100, completionTokens: 50, usd: 0.0003375 })

    const b = new LedgerStore(file)
    expect(b.totalUsd).toBeCloseTo(0.001864 + 0.0003375, 12)
    expect(b.load().entries).toHaveLength(2)
    expect(b.load().entries[0].kind).toBe('transcribe')
    expect(b.load().entries[1].model).toBe('muse-spark-1.3')
    expect(b.load().entries[0].ts).toBeTruthy()
  })

  it('writes valid JSON via temp file + rename (no leftover tmp files)', () => {
    const file = path.join(dir, 'usage-ledger.json')
    const store = new LedgerStore(file)
    store.record({ kind: 'transcribe', model: 'm', audioMs: 1000, usd: 0.00005 })

    const raw = fs.readFileSync(file, 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    const parsed = parseLedger(raw)
    expect(parsed.totalUsd).toBeCloseTo(0.00005, 12)

    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('serializeLedger/parseLedger round-trip', () => {
    const ledger = parseLedger(
      serializeLedger({
        totalUsd: 1.5,
        entries: [{ ts: 't', kind: 'chat', model: 'm', usd: 1.5 }],
      }),
    )
    expect(ledger.totalUsd).toBe(1.5)
    expect(ledger.entries).toHaveLength(1)
  })

  it('parseLedger tolerates malformed shapes', () => {
    expect(parseLedger('{}')).toEqual({ totalUsd: 0, entries: [] })
  })

  it('sees spend recorded by another instance (app + CLI share one file)', () => {
    const file = path.join(dir, 'usage-ledger.json')
    const app = new LedgerStore(file)
    expect(app.totalUsd).toBe(0)
    new LedgerStore(file).record({ kind: 'chat', model: 'm', usd: 1 })
    expect(app.totalUsd).toBe(1)
    app.record({ kind: 'chat', model: 'm', usd: 2 })
    expect(new LedgerStore(file).load().entries).toHaveLength(2)
    expect(new LedgerStore(file).totalUsd).toBe(3)
  })

  it('fails closed on a corrupt ledger instead of resetting spend to 0', () => {
    const file = path.join(dir, 'usage-ledger.json')
    fs.writeFileSync(file, '{not json', 'utf8')
    expect(() => new LedgerStore(file).assertCanSpend(0.01)).toThrow()
  })

  it('enforces the cap through assertCanSpend', () => {
    const file = path.join(dir, 'usage-ledger.json')
    const store = new LedgerStore(file)
    store.record({ kind: 'chat', model: 'm', usd: BUDGET_CAP_USD })
    expect(() => store.assertCanSpend(0.001)).toThrow(BudgetExceededError)
  })
})
