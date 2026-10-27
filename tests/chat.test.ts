import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BudgetExceededError,
  chatCostUsd,
  estimateChatCostUsd,
  LedgerStore,
} from '../src/main/budget'
import { CHAT_MODEL, createMetaApi, type MetaApiDeps } from '../src/main/meta-api'

/** Real usage example shape from the API: completion already includes reasoning. */
const EXAMPLE_USAGE = {
  completion_tokens: 1263,
  prompt_tokens: 300,
  total_tokens: 1563,
  completion_tokens_details: { reasoning_tokens: 1047 },
}

function chatBody(content: unknown, usage: unknown = EXAMPLE_USAGE): unknown {
  return {
    choices: [{ message: { content } }],
    usage,
  }
}

function makeDeps(
  dir: string,
  responder: (url: string, init: RequestInit) => Response,
  overrides: Partial<MetaApiDeps> = {},
): { deps: MetaApiDeps; ledger: LedgerStore; captured: Array<{ url: string; init: RequestInit }> } {
  const captured: Array<{ url: string; init: RequestInit }> = []
  const ledger = new LedgerStore(path.join(dir, 'usage-ledger.json'))
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const req = init ?? {}
    captured.push({ url: String(url), init: req })
    return responder(String(url), req)
  }) as unknown as typeof fetch
  return {
    deps: { ledger, getKey: async () => 'test-secret-key', fetchImpl, ...overrides },
    ledger,
    captured,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('meta-api chat', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-chat-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const messages = [{ role: 'system' as const, content: 'test prompt' }]

  it('POSTs model/messages/strict response_format without max_tokens', async () => {
    const { deps, captured } = makeDeps(tmpDir, () => jsonResponse(chatBody('{"a":1}')))
    const api = createMetaApi(deps)
    const schema = { type: 'object' }
    const result = await api.chat({
      messages,
      responseFormat: { name: 'test_schema', schema },
    })

    expect(result).toEqual({ a: 1 })
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe('https://api.meta.ai/v1/chat/completions')
    const init = captured[0].init
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-secret-key')
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.model).toBe(CHAT_MODEL)
    expect(body.messages).toEqual(messages)
    expect('max_tokens' in body).toBe(false)
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'test_schema', schema, strict: true },
    })
  })

  it('checks budget BEFORE fetch and records usage AFTER a 200 (no double-count of reasoning)', async () => {
    const { deps, captured, ledger } = makeDeps(tmpDir, () => jsonResponse(chatBody('{"ok":true}')))
    const assertSpy = vi.spyOn(ledger, 'assertCanSpend')
    const recordSpy = vi.spyOn(ledger, 'record')

    const api = createMetaApi(deps)
    await api.chat({ messages, responseFormat: { name: 's', schema: {} } })

    expect(assertSpy).toHaveBeenCalledTimes(1)
    expect(captured).toHaveLength(1)
    expect(recordSpy).toHaveBeenCalledTimes(1)
    const entry = recordSpy.mock.calls[0][0]
    expect(entry.kind).toBe('chat')
    expect(entry.model).toBe('muse-spark-1.3')
    expect(entry.promptTokens).toBe(300)
    expect(entry.completionTokens).toBe(1263)
    expect(entry.reasoningTokens).toBe(1047)
    // completion already includes reasoning: billed once, not twice
    expect(entry.usd).toBeCloseTo(chatCostUsd('muse-spark-1.3', 300, 1263, 1047), 12)
    expect(assertSpy.mock.invocationCallOrder[0]).toBeLessThan(
      recordSpy.mock.invocationCallOrder[0],
    )
  })

  it('records the estimate (never $0) when a 200 has no usage', async () => {
    const noUsage = { choices: [{ message: { content: '{"ok":true}' } }] }
    const { deps, ledger } = makeDeps(tmpDir, () => jsonResponse(noUsage))
    const recordSpy = vi.spyOn(ledger, 'record')

    const api = createMetaApi(deps)
    await api.chat({ messages, responseFormat: { name: 's', schema: {} } })

    expect(recordSpy).toHaveBeenCalledTimes(1)
    const entry = recordSpy.mock.calls[0][0]
    expect(entry.usd).toBeCloseTo(estimateChatCostUsd('muse-spark-1.3', 'test prompt'.length), 12)
    expect(entry.usd).toBeGreaterThan(0)
  })

  it('records nothing on non-2xx and throws a Korean redacted error', async () => {
    const failing = (): Response => new Response('bad key test-secret-key rejected', { status: 500 })
    const { deps, ledger } = makeDeps(tmpDir, failing)
    const recordSpy = vi.spyOn(ledger, 'record')

    const api = createMetaApi(deps)
    const err = await api
      .chat({ messages, responseFormat: { name: 's', schema: {} } })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('요약 API 오류 (HTTP 500)')
    expect((err as Error).message).not.toContain('test-secret-key')
    expect(recordSpy).not.toHaveBeenCalled()
  })

  it('throws a Korean error when schema content is not valid JSON', async () => {
    const { deps, ledger } = makeDeps(tmpDir, () => jsonResponse(chatBody('not json{{')))
    const recordSpy = vi.spyOn(ledger, 'record')

    const api = createMetaApi(deps)
    await expect(
      api.chat({ messages, responseFormat: { name: 's', schema: {} } }),
    ).rejects.toThrow('JSON')
    // The call succeeded, so usage is still recorded.
    expect(recordSpy).toHaveBeenCalledTimes(1)
  })

  it('returns the raw string when no responseFormat is set', async () => {
    const { deps } = makeDeps(tmpDir, () => jsonResponse(chatBody('plain text')))
    const api = createMetaApi(deps)
    await expect(api.chat({ messages })).resolves.toBe('plain text')
  })

  it('records nothing on network failure', async () => {
    const broken = (async () => {
      throw new Error('socket hang up')
    }) as unknown as typeof fetch
    const { deps, ledger } = makeDeps(tmpDir, () => {
      throw new Error('unreachable')
    }, { fetchImpl: broken })
    const recordSpy = vi.spyOn(ledger, 'record')

    const api = createMetaApi(deps)
    await expect(api.chat({ messages })).rejects.toThrow('요약 API 호출 실패')
    expect(recordSpy).not.toHaveBeenCalled()
  })

  it('never calls fetch when the budget is already exhausted', async () => {
    const { deps, captured, ledger } = makeDeps(tmpDir, () => jsonResponse(chatBody('{}')))
    ledger.record({ kind: 'chat', model: 'm', usd: 1000 })
    const api = createMetaApi(deps)
    await expect(api.chat({ messages })).rejects.toThrow(BudgetExceededError)
    expect(captured).toHaveLength(0)
  })
})
