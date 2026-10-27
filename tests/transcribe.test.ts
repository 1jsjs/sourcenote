import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BudgetExceededError, LedgerStore, TRANSCRIBE_MODEL } from '../src/main/budget'
import { createMetaApi, type MetaApiDeps } from '../src/main/meta-api'
import { parseTranscribeResponse, turnsToSegments } from '../src/main/transcribe'

/** Real response example from the API docs. */
const EXAMPLE_RESPONSE = {
  sessionId: 'voyager/transcribe/abc123',
  transcript: '전체 텍스트입니다',
  audioDurationMs: 37280,
  turns: [{ turnId: 0, startMs: 0, endMs: 36780, transcript: '첫 번째 턴입니다' }],
}

describe('parseTranscribeResponse', () => {
  it('parses the real response example', () => {
    const result = parseTranscribeResponse(EXAMPLE_RESPONSE)
    expect(result.sessionId).toBe('voyager/transcribe/abc123')
    expect(result.transcript).toBe('전체 텍스트입니다')
    expect(result.audioDurationMs).toBe(37280)
    expect(result.turns).toEqual([
      { turnId: 0, startMs: 0, endMs: 36780, transcript: '첫 번째 턴입니다' },
    ])
  })

  it('handles empty turns with a transcript present', () => {
    const result = parseTranscribeResponse({
      transcript: '청크 전체 전사',
      audioDurationMs: 37280,
      turns: [],
    })
    expect(result.turns).toEqual([])
    expect(result.transcript).toBe('청크 전체 전사')
  })

  it('handles missing turns field', () => {
    const result = parseTranscribeResponse({ transcript: 't', audioDurationMs: 1000 })
    expect(result.turns).toEqual([])
    expect(result.audioDurationMs).toBe(1000)
  })

  it('handles missing audioDurationMs (billing falls back to chunk length)', () => {
    const result = parseTranscribeResponse({ transcript: 't', turns: [] })
    expect(result.audioDurationMs).toBeNull()
  })

  it('drops malformed turn entries but keeps valid ones', () => {
    const result = parseTranscribeResponse({
      transcript: '',
      turns: [
        { turnId: 0, startMs: 0, endMs: 100, transcript: 'ok' },
        { turnId: 1, startMs: 'bad', endMs: 200, transcript: 'dropped' },
        null,
      ],
    })
    expect(result.turns).toHaveLength(1)
    expect(result.turns[0].transcript).toBe('ok')
  })

  it('throws on a non-object body', () => {
    expect(() => parseTranscribeResponse('nope')).toThrow()
    expect(() => parseTranscribeResponse([1, 2])).toThrow()
    expect(() => parseTranscribeResponse(null)).toThrow()
  })
})

describe('turnsToSegments (offset mapping)', () => {
  it('maps turn times onto the absolute timeline: start = chunkOffset + turn.startMs', () => {
    const result = parseTranscribeResponse(EXAMPLE_RESPONSE)
    const segments = turnsToSegments(result, 570_000, 570_000, 1, 0)
    expect(segments).toEqual([
      {
        idx: 0,
        startMs: 570_000,
        endMs: 570_000 + 36_780,
        text: '첫 번째 턴입니다',
        chunkIndex: 1,
      },
    ])
  })

  it('assigns continuous idx across chunks', () => {
    const result = parseTranscribeResponse({
      transcript: '',
      audioDurationMs: 1000,
      turns: [
        { turnId: 0, startMs: 0, endMs: 400, transcript: 'a' },
        { turnId: 1, startMs: 400, endMs: 900, transcript: 'b' },
      ],
    })
    const segments = turnsToSegments(result, 0, 570_000, 0, 5)
    expect(segments.map((s) => s.idx)).toEqual([5, 6])
    expect(segments[1]).toMatchObject({ startMs: 400, endMs: 900, text: 'b', chunkIndex: 0 })
  })

  it('empty turns + transcript -> one segment spanning the chunk', () => {
    const result = parseTranscribeResponse({
      transcript: '전체 청크 전사',
      audioDurationMs: 37_280,
      turns: [],
    })
    const segments = turnsToSegments(result, 1_140_000, 360_000, 2, 3)
    expect(segments).toEqual([
      {
        idx: 3,
        startMs: 1_140_000,
        endMs: 1_140_000 + 37_280,
        text: '전체 청크 전사',
        chunkIndex: 2,
      },
    ])
  })

  it('falls back to chunk duration when audioDurationMs is missing', () => {
    const result = parseTranscribeResponse({ transcript: 'x', turns: [] })
    const segments = turnsToSegments(result, 0, 570_000, 0, 0)
    expect(segments[0].endMs).toBe(570_000)
  })

  it('no turns and blank transcript -> no segments', () => {
    const result = parseTranscribeResponse({ transcript: '   ', turns: [] })
    expect(turnsToSegments(result, 0, 570_000, 0, 0)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// meta-api: budget gate + multipart request + recording, with a mocked fetch
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string
  init: RequestInit
}

function makeDeps(
  dir: string,
  overrides: Partial<MetaApiDeps> = {},
): {
  deps: MetaApiDeps
  ledger: LedgerStore
  captured: CapturedRequest[]
} {
  const captured: CapturedRequest[] = []
  const ledger = new LedgerStore(path.join(dir, 'usage-ledger.json'))
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(EXAMPLE_RESPONSE), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return {
    deps: {
      ledger,
      getKey: async () => 'test-secret-key',
      fetchImpl,
      ...overrides,
    },
    ledger,
    captured,
  }
}

describe('meta-api transcribeChunk', () => {
  let chunkPath: string
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-meta-'))
    chunkPath = path.join(tmpDir, 'chunk_000.wav')
    fs.writeFileSync(chunkPath, Buffer.from('RIFF fake wav bytes'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('sends multipart with a JSON `request` part and an `audio` part, plus Authorization', async () => {
    const { deps, captured } = makeDeps(tmpDir)
    const api = createMetaApi(deps)
    await api.transcribeChunk({ chunkPath, chunkDurationMs: 570_000 })

    expect(captured).toHaveLength(1)
    const { url, init } = captured[0]
    expect(url).toBe('https://api.meta.ai/v1/asr/transcribe')
    expect(init.method).toBe('POST')

    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-secret-key')
    expect(headers.Accept).toBe('application/json')

    const form = init.body as FormData
    const requestPart = form.get('request') as Blob
    expect(requestPart).toBeTruthy()
    expect(requestPart.type).toBe('application/json')
    const requestJson = JSON.parse(await requestPart.text())
    expect(requestJson).toEqual({
      model: TRANSCRIBE_MODEL,
      audioEncoding: 'WAV',
      mode: 'ENDPOINTING',
      languageBias: ['Korean', 'English'],
    })

    const audioPart = form.get('audio') as File
    expect(audioPart).toBeTruthy()
    expect(audioPart.type).toBe('audio/wav')
    expect(audioPart.name).toBe('chunk_000.wav')
    expect(Buffer.from(await audioPart.arrayBuffer()).toString()).toBe('RIFF fake wav bytes')
  })

  it('checks budget BEFORE fetch and records AFTER a 200, billed on audioDurationMs', async () => {
    const { deps, captured, ledger } = makeDeps(tmpDir)
    const assertSpy = vi.spyOn(ledger, 'assertCanSpend')
    const recordSpy = vi.spyOn(ledger, 'record')

    const api = createMetaApi(deps)
    const result = await api.transcribeChunk({ chunkPath, chunkDurationMs: 570_000 })

    expect(assertSpy).toHaveBeenCalledTimes(1)
    expect(captured).toHaveLength(1)
    expect(recordSpy).toHaveBeenCalledTimes(1)
    // billed on the API's audioDurationMs (37280), not the chunk estimate
    const entry = recordSpy.mock.calls[0][0]
    expect(entry.kind).toBe('transcribe')
    expect(entry.audioMs).toBe(37280)
    expect(entry.usd).toBeCloseTo((37280 / 3_600_000) * 0.18, 12)
    // assert happened before fetch: order via invocationCallOrder
    expect(assertSpy.mock.invocationCallOrder[0]).toBeLessThan(recordSpy.mock.invocationCallOrder[0])
    expect(result.transcript).toBe('전체 텍스트입니다')
  })

  it('records nothing when the API returns a non-2xx status', async () => {
    const failingFetch = (async () =>
      new Response('internal error', { status: 500 })) as unknown as typeof fetch
    const { deps, ledger } = makeDeps(tmpDir, { fetchImpl: failingFetch })
    const recordSpy = vi.spyOn(ledger, 'record')

    const api = createMetaApi(deps)
    await expect(
      api.transcribeChunk({ chunkPath, chunkDurationMs: 570_000 }),
    ).rejects.toThrow('HTTP 500')
    expect(recordSpy).not.toHaveBeenCalled()
  })

  it('error messages never contain the API key', async () => {
    const leakyFetch = (async () =>
      new Response('bad key test-secret-key was rejected', { status: 401 })) as unknown as typeof fetch
    const { deps } = makeDeps(tmpDir, { fetchImpl: leakyFetch })
    const api = createMetaApi(deps)
    const err = await api
      .transcribeChunk({ chunkPath, chunkDurationMs: 570_000 })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toContain('test-secret-key')
    expect((err as Error).message).toContain('HTTP 401')
  })

  it('records nothing on network failure', async () => {
    const brokenFetch = (async () => {
      throw new Error('socket hang up')
    }) as unknown as typeof fetch
    const { deps, ledger } = makeDeps(tmpDir, { fetchImpl: brokenFetch })
    const recordSpy = vi.spyOn(ledger, 'record')
    const api = createMetaApi(deps)
    await expect(api.transcribeChunk({ chunkPath, chunkDurationMs: 570_000 })).rejects.toThrow(
      '전사 API 호출 실패',
    )
    expect(recordSpy).not.toHaveBeenCalled()
  })

  it('never calls fetch when the budget is already exhausted', async () => {
    const { deps, captured, ledger } = makeDeps(tmpDir)
    ledger.record({ kind: 'chat', model: 'm', usd: 1000 })
    const api = createMetaApi(deps)
    await expect(
      api.transcribeChunk({ chunkPath, chunkDurationMs: 570_000 }),
    ).rejects.toThrow(BudgetExceededError)
    expect(captured).toHaveLength(0)
  })
})
