import fs from 'node:fs'
import path from 'node:path'
import type { AppLanguage } from '../shared/types'
import { getMetaApiKey } from './apikey'
import { createFakeMetaApi, isFakeApiEnabled } from './fake-api'
import {
  chatCostUsd,
  estimateChatCostUsd,
  estimateTranscribeCostUsd,
  TRANSCRIBE_MODEL,
  transcribeCostUsd,
  type LedgerStore,
} from './budget'
import { langMsg } from './lang'
import { parseTranscribeResponse, type TranscribeResult } from './transcribe'

/**
 * THE ONLY module that talks to api.meta.ai. Every call goes:
 *   ledger.assertCanSpend(estimate) -> fetch -> ledger.record(actual)
 * Nothing else in the codebase may fetch api.meta.ai.
 *
 * Budget rules:
 *  - A call that fails before/without a usage-bearing HTTP 200 records nothing.
 *  - A transcribe HTTP 200 ALWAYS records, billed on audioDurationMs
 *    (fallback: the chunk duration).
 *  - The API key is never logged and never appears in error messages.
 */

const API_BASE = 'https://api.meta.ai'
const TRANSCRIBE_TIMEOUT_MS = 10 * 60 * 1000
const CHAT_TIMEOUT_MS = 5 * 60 * 1000

/** Default chat model for summarization and verification. */
export const CHAT_MODEL = 'muse-spark-1.3'

export interface MetaApiDeps {
  ledger: LedgerStore
  /** Injectable for tests; defaults to keychain/env lookup. */
  getKey?: (lang: AppLanguage) => Promise<string>
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Current app language for user-facing error text; defaults to 'ko'. */
  getLanguage?: () => AppLanguage
}

/**
 * Error thrown for failed Meta API calls. `status` is the HTTP status, or
 * null for network/timeout failures. The pipeline uses `status` (not the
 * message text) to decide retries, so this stays stable across languages.
 */
export class MetaApiError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null) {
    super(message)
    this.name = 'MetaApiError'
    this.status = status
  }
}

/**
 * True for failures worth retrying once per chunk: network errors, HTTP
 * 429 and 5xx. Other 4xx errors are not retried. Pure and unit-tested.
 */
export function isRetryableApiError(err: unknown): boolean {
  if (err instanceof MetaApiError) {
    return err.status === null || err.status === 429 || err.status >= 500
  }
  return false
}

export interface TranscribeChunkOptions {
  chunkPath: string
  /** Planned chunk length, used for the pre-call estimate and as billing fallback. */
  chunkDurationMs: number
  fileName?: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  messages: ChatMessage[]
  model?: string
  /** When set, sent as a strict json_schema response_format; reply is parsed as JSON. */
  responseFormat?: { name: string; schema: unknown }
}

export interface MetaApi {
  transcribeChunk(opts: TranscribeChunkOptions): Promise<TranscribeResult>
  /**
   * Chat completion. With responseFormat the reply content is parsed as JSON
   * (throws a Korean error when it is not valid JSON); otherwise the raw
   * content string is returned.
   */
  chat(opts: ChatOptions): Promise<unknown>
}

/** 401/403 means the key itself was refused: point the user at the key dialog. */
function keyRefusedMessage(language: AppLanguage, status: number): string | null {
  if (status !== 401 && status !== 403) return null
  return langMsg(
    language,
    `Meta API가 키를 거부했습니다 (HTTP ${status}). 오른쪽 위 "API 키"에서 키를 확인해 주세요.`,
    `Meta API refused the key (HTTP ${status}). Check it under "API key" at the top right.`,
  )
}

/** Removes the API key from any text so it can never leak via errors. */
function redact(text: string, key: string): string {
  return key.length > 0 ? text.split(key).join('***') : text
}

export function createMetaApi(deps: MetaApiDeps): MetaApi {
  // Dev-only fake mode for previewing states: no fetch, no key, no ledger.
  // The real path below is untouched.
  if (isFakeApiEnabled()) return createFakeMetaApi()
  const getKey = deps.getKey ?? getMetaApiKey
  const fetchImpl = deps.fetchImpl ?? fetch
  const lang = (): AppLanguage => deps.getLanguage?.() ?? 'ko'

  // Sum of pre-call estimates for calls currently in flight. The pre-call
  // check becomes assertCanSpend(estimate + reservedInFlight) so concurrent
  // chunk transcriptions cannot jointly overshoot the cap.
  let reservedInFlightUsd = 0

  function reserve(estimate: number): void {
    deps.ledger.assertCanSpend(estimate + reservedInFlightUsd, lang())
    reservedInFlightUsd += estimate
  }

  function release(estimate: number): void {
    reservedInFlightUsd = Math.max(0, reservedInFlightUsd - estimate)
  }

  async function transcribeChunk(opts: TranscribeChunkOptions): Promise<TranscribeResult> {
    const language = lang()
    // 1. Budget gate: conservative estimate BEFORE any network traffic.
    const estimate = estimateTranscribeCostUsd(opts.chunkDurationMs)
    reserve(estimate)

    try {
      const key = await getKey(language)
      const bytes = fs.readFileSync(opts.chunkPath)

      const requestJson = JSON.stringify({
        model: TRANSCRIBE_MODEL,
        audioEncoding: 'WAV',
        mode: 'ENDPOINTING',
        languageBias: ['Korean', 'English'],
      })
      const form = new FormData()
      form.append('request', new Blob([requestJson], { type: 'application/json' }))
      form.append(
        'audio',
        new Blob([bytes], { type: 'audio/wav' }),
        opts.fileName ?? path.basename(opts.chunkPath),
      )

      let res: Response
      try {
        res = await fetchImpl(`${API_BASE}/v1/asr/transcribe`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: 'application/json',
            // Content-Type (multipart boundary) is set by fetch from FormData.
          },
          body: form,
          signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
        })
      } catch (err) {
        // Network/timeout failure: nothing is recorded.
        const msg = err instanceof Error ? err.message : String(err)
        throw new MetaApiError(
          langMsg(language, `전사 API 호출 실패: ${redact(msg, key)}`, `Transcription API call failed: ${redact(msg, key)}`),
          null,
        )
      }

      if (!res.ok) {
        // No successful transcription happened: nothing is recorded.
        const body = await res.text().catch(() => '')
        const snippet = redact(body.slice(0, 500), key)
        throw new MetaApiError(
          keyRefusedMessage(language, res.status) ??
          langMsg(
            language,
            `전사 API 오류 (HTTP ${res.status}): ${snippet}`,
            `Transcription API error (HTTP ${res.status}): ${snippet}`,
          ),
          res.status,
        )
      }

      // 3. HTTP 200: parse, then ALWAYS record actual billed duration.
      const parsed = parseTranscribeResponse(await res.json())
      const billedMs = parsed.audioDurationMs ?? opts.chunkDurationMs
      deps.ledger.record({
        kind: 'transcribe',
        model: TRANSCRIBE_MODEL,
        audioMs: billedMs,
        usd: transcribeCostUsd(billedMs),
      })
      return parsed
    } finally {
      release(estimate)
    }
  }

  async function chat(opts: ChatOptions): Promise<unknown> {
    const language = lang()
    const model = opts.model ?? CHAT_MODEL
    // 1. Budget gate: conservative estimate BEFORE any network traffic.
    const promptChars = opts.messages.reduce((sum, m) => sum + m.content.length, 0)
    const estimate = estimateChatCostUsd(model, promptChars)
    reserve(estimate)

    try {
      const key = await getKey(language)

      const body: Record<string, unknown> = { model, messages: opts.messages }
      if (opts.responseFormat) {
        body.response_format = {
          type: 'json_schema',
          json_schema: { name: opts.responseFormat.name, schema: opts.responseFormat.schema, strict: true },
        }
      }

      let res: Response
      try {
        res = await fetchImpl(`${API_BASE}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
        })
      } catch (err) {
        // Network/timeout failure: nothing is recorded.
        const msg = err instanceof Error ? err.message : String(err)
        throw new MetaApiError(
          langMsg(language, `요약 API 호출 실패: ${redact(msg, key)}`, `Summary API call failed: ${redact(msg, key)}`),
          null,
        )
      }

      if (!res.ok) {
        // No successful completion happened: nothing is recorded.
        const text = await res.text().catch(() => '')
        const snippet = redact(text.slice(0, 500), key)
        throw new MetaApiError(
          keyRefusedMessage(language, res.status) ??
          langMsg(
            language,
            `요약 API 오류 (HTTP ${res.status}): ${snippet}`,
            `Summary API error (HTTP ${res.status}): ${snippet}`,
          ),
          res.status,
        )
      }

      // 3. HTTP 200: parse the reply, then record actual token usage.
      const parsed = (await res.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>
        usage?: {
          prompt_tokens?: unknown
          completion_tokens?: unknown
          completion_tokens_details?: { reasoning_tokens?: unknown }
        }
      }
      const content = parsed.choices?.[0]?.message?.content
      if (typeof content !== 'string') {
        throw new Error(
          langMsg(language, '요약 API 응답에 내용이 없습니다.', 'Summary API response has no content.'),
        )
      }

      recordChatUsage(deps.ledger, model, parsed.usage, estimate)

      if (opts.responseFormat) {
        try {
          return JSON.parse(content) as unknown
        } catch {
          throw new Error(
            langMsg(language, '요약 API 응답이 JSON 형식이 아닙니다.', 'Summary API response is not valid JSON.'),
          )
        }
      }
      return content
    } finally {
      release(estimate)
    }
  }

  return { transcribeChunk, chat }
}

interface ChatUsage {
  prompt_tokens?: unknown
  completion_tokens?: unknown
  completion_tokens_details?: { reasoning_tokens?: unknown }
}

/** Records a successful chat call; falls back to the estimate when usage is missing. */
function recordChatUsage(
  ledger: LedgerStore,
  model: string,
  usage: ChatUsage | undefined,
  estimate: number,
): void {
  const promptTokens = asNonNegativeInt(usage?.prompt_tokens)
  const completionTokens = asNonNegativeInt(usage?.completion_tokens)
  const reasoningTokens = asNonNegativeInt(usage?.completion_tokens_details?.reasoning_tokens) ?? 0
  if (promptTokens === null || completionTokens === null) {
    // Fail safe: a successful call must never be recorded as $0.
    ledger.record({ kind: 'chat', model, usd: estimate })
    return
  }
  ledger.record({
    kind: 'chat',
    model,
    promptTokens,
    completionTokens,
    reasoningTokens,
    usd: chatCostUsd(model, promptTokens, completionTokens, reasoningTokens),
  })
}

function asNonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}
