import fs from 'node:fs'
import path from 'node:path'
import { getMetaApiKey } from './apikey'
import {
  estimateTranscribeCostUsd,
  TRANSCRIBE_MODEL,
  transcribeCostUsd,
  type LedgerStore,
} from './budget'
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

export interface MetaApiDeps {
  ledger: LedgerStore
  /** Injectable for tests; defaults to keychain/env lookup. */
  getKey?: () => Promise<string>
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
}

export interface TranscribeChunkOptions {
  chunkPath: string
  /** Planned chunk length, used for the pre-call estimate and as billing fallback. */
  chunkDurationMs: number
  fileName?: string
}

export interface MetaApi {
  transcribeChunk(opts: TranscribeChunkOptions): Promise<TranscribeResult>
}

/** Removes the API key from any text so it can never leak via errors. */
function redact(text: string, key: string): string {
  return key.length > 0 ? text.split(key).join('***') : text
}

export function createMetaApi(deps: MetaApiDeps): MetaApi {
  const getKey = deps.getKey ?? getMetaApiKey
  const fetchImpl = deps.fetchImpl ?? fetch

  async function transcribeChunk(opts: TranscribeChunkOptions): Promise<TranscribeResult> {
    // 1. Budget gate: conservative estimate BEFORE any network traffic.
    deps.ledger.assertCanSpend(estimateTranscribeCostUsd(opts.chunkDurationMs))

    const key = await getKey()
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
      throw new Error(`전사 API 호출 실패: ${redact(msg, key)}`)
    }

    if (!res.ok) {
      // No successful transcription happened: nothing is recorded.
      const body = await res.text().catch(() => '')
      const snippet = redact(body.slice(0, 500), key)
      throw new Error(`전사 API 오류 (HTTP ${res.status}): ${snippet}`)
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
  }

  return { transcribeChunk }
}
