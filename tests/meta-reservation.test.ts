import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BudgetExceededError, LedgerStore } from '../src/main/budget'
import {
  createMetaApi,
  isRetryableApiError,
  MetaApiError,
} from '../src/main/meta-api'

function transcribeBody(): unknown {
  return { transcript: 'hello', audioDurationMs: 570_000, turns: [] }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('isRetryableApiError', () => {
  it('retries network errors, 429 and 5xx but not other 4xx', () => {
    expect(isRetryableApiError(new MetaApiError('down', null))).toBe(true)
    expect(isRetryableApiError(new MetaApiError('slow down', 429))).toBe(true)
    expect(isRetryableApiError(new MetaApiError('nope', 500))).toBe(true)
    expect(isRetryableApiError(new MetaApiError('nope', 503))).toBe(true)
    expect(isRetryableApiError(new MetaApiError('bad', 400))).toBe(false)
    expect(isRetryableApiError(new MetaApiError('denied', 401))).toBe(false)
    expect(isRetryableApiError(new Error('plain'))).toBe(false)
    expect(isRetryableApiError(null)).toBe(false)
  })
})

describe('meta-api budget reservation', () => {
  let dir: string
  let chunkPath: string
  const oldCap = process.env.SOURCENOTE_BUDGET_CAP_USD

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-reserve-'))
    chunkPath = path.join(dir, 'chunk.wav')
    fs.writeFileSync(chunkPath, Buffer.alloc(16))
    // A 570 s chunk estimates $0.0285, so two concurrent calls ($0.057)
    // exceed this cap while one ($0.0285) fits.
    process.env.SOURCENOTE_BUDGET_CAP_USD = '0.05'
  })

  afterEach(() => {
    if (oldCap === undefined) delete process.env.SOURCENOTE_BUDGET_CAP_USD
    else process.env.SOURCENOTE_BUDGET_CAP_USD = oldCap
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('blocks a second in-flight call that would jointly exceed the cap', async () => {
    const ledger = new LedgerStore(path.join(dir, 'usage-ledger.json'))
    let resolveFirst!: (res: Response) => void
    const gate = new Promise<Response>((res) => {
      resolveFirst = res
    })
    const api = createMetaApi({
      ledger,
      getKey: async () => 'test-key',
      fetchImpl: (async () => gate) as unknown as typeof fetch,
    })

    const first = api.transcribeChunk({ chunkPath, chunkDurationMs: 570_000 })
    await new Promise((res) => setTimeout(res, 10))
    await expect(api.transcribeChunk({ chunkPath, chunkDurationMs: 570_000 })).rejects.toThrow(
      BudgetExceededError,
    )

    resolveFirst(jsonResponse(transcribeBody()))
    const parsed = await first
    expect(parsed.transcript).toBe('hello')

    // The finished call released its reservation: a small chunk still fits.
    const api2 = createMetaApi({
      ledger,
      getKey: async () => 'test-key',
      fetchImpl: (async () => jsonResponse(transcribeBody())) as unknown as typeof fetch,
    })
    const small = await api2.transcribeChunk({ chunkPath, chunkDurationMs: 60_000 })
    expect(small.transcript).toBe('hello')
  })

  it('reports HTTP errors in the current language with a stable status', async () => {
    const ledger = new LedgerStore(path.join(dir, 'usage-ledger.json'))
    const failing = (async () => jsonResponse({ error: 'x' }, 500)) as unknown as typeof fetch
    const ko = createMetaApi({ ledger, getKey: async () => 'k', fetchImpl: failing })
    const koErr = await ko
      .transcribeChunk({ chunkPath, chunkDurationMs: 1000 })
      .catch((err: unknown) => err)
    expect((koErr as Error).message).toContain('전사 API 오류 (HTTP 500)')
    expect((koErr as MetaApiError).status).toBe(500)

    const en = createMetaApi({
      ledger,
      getKey: async () => 'k',
      fetchImpl: failing,
      getLanguage: () => 'en',
    })
    const enErr = await en
      .transcribeChunk({ chunkPath, chunkDurationMs: 1000 })
      .catch((err: unknown) => err)
    expect((enErr as Error).message).toContain('Transcription API error (HTTP 500)')
    expect((enErr as MetaApiError).status).toBe(500)
  })
})
