import { CHECK_LOCATE_SCHEMA_NAME } from './check-pipeline'
import { CORRECTION_SCHEMA_NAME } from './correction'
import { SUMMARY_SCHEMA_NAME, VERIFY_SCHEMA_NAME } from './grounding'
import type { ChatMessage, ChatOptions, MetaApi, TranscribeChunkOptions } from './meta-api'
import type { TranscribeResult } from './transcribe'

/**
 * Dev-only fake Meta API for previewing every loading/progress state without
 * real API calls. Enabled with `SOURCENOTE_FAKE_API=1`; the real path in
 * `meta-api.ts` is untouched, and the budget ledger is never written here.
 *
 * Contract (mirrors the task spec):
 *  - transcribe: waits 1.5 s per chunk (`SOURCENOTE_FAKE_DELAY_MS` override),
 *    one turn per ~12 s of the chunk with placeholder text "[fake] segment N".
 *  - chat: waits 2 s. Summary schema -> 6 claims from the first segments'
 *    text (cite segments 1..6, page 1 when pages exist). Verify -> every
 *    claim supported except the 2nd (false, "[fake] not stated in the cited
 *    evidence"). Check-notes locate -> first segment for each sentence, none
 *    for sentences containing "dropout". Corrections -> one duplicate fix
 *    when a repeated word exists, else none.
 */

/** True when the dev-only fake API is enabled. Pure and unit-tested. */
export function isFakeApiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SOURCENOTE_FAKE_API === '1'
}

/** Artificial latency in ms; override with SOURCENOTE_FAKE_DELAY_MS. */
export function fakeDelayMs(kind: 'transcribe' | 'chat', env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SOURCENOTE_FAKE_DELAY_MS
  if (raw !== undefined) {
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return kind === 'transcribe' ? 1500 : 2000
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Numbered transcript lines `[n] (time) text` in a chat user message. */
export function parseFakeSegments(userContent: string): Array<{ n: number; text: string }> {
  const out: Array<{ n: number; text: string }> = []
  for (const line of userContent.split('\n')) {
    const m = line.match(/^\[(\d+)\]\s*(?:\([^)]*\)\s*)?(.*)$/)
    if (m) out.push({ n: Number(m[1]), text: m[2].trim() })
  }
  return out
}

/** Numbered slide lines `[Pk] (file p.N) text` in a chat user message. */
export function parseFakePages(userContent: string): Array<{ k: number; text: string }> {
  const out: Array<{ k: number; text: string }> = []
  for (const line of userContent.split('\n')) {
    const m = line.match(/^\[P(\d+)\]\s*(?:\([^)]*\)\s*)?(.*)$/)
    if (m) out.push({ k: Number(m[1]), text: m[2].trim() })
  }
  return out
}

function userContentOf(messages: ChatMessage[]): string {
  return messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n')
}

function buildFakeSummaryPayload(userContent: string): unknown {
  const segments = parseFakeSegments(userContent)
  const pages = parseFakePages(userContent)
  const count = 6
  const claims = Array.from({ length: count }, (_, i) => {
    const seg = segments.length > 0 ? segments[i % segments.length] : null
    const text = seg && seg.text.length > 0 ? seg.text.slice(0, 200) : `[fake] claim ${i + 1}`
    return {
      text,
      segment_ids: seg ? [seg.n] : [],
      page_ids: pages.length > 0 ? [pages[0].k] : [],
    }
  })
  return { claims }
}

function buildFakeVerifyPayload(userContent: string): unknown {
  const idxs: number[] = []
  for (const line of userContent.split('\n')) {
    const m = line.match(/^Claim (\d+):/)
    if (m) idxs.push(Number(m[1]))
  }
  return {
    results: idxs.map((claimIdx, position) => ({
      claim_index: claimIdx,
      supported: position !== 1,
      reason:
        position !== 1
          ? '[fake] supported by the cited evidence'
          : '[fake] not stated in the cited evidence',
    })),
  }
}

function buildFakeLocatePayload(userContent: string): unknown {
  const items: Array<{ sentence_index: number; segment_ids: number[]; page_ids: number[] }> = []
  for (const line of userContent.split('\n')) {
    const m = line.match(/^Sentence (\d+):\s*(.*)$/)
    if (!m) continue
    const text = m[2]
    items.push({
      sentence_index: Number(m[1]),
      segment_ids: /dropout/i.test(text) ? [] : [1],
      page_ids: [],
    })
  }
  return { items }
}

function buildFakeCorrectionPayload(userContent: string): unknown {
  for (const line of userContent.split('\n')) {
    const num = line.match(/^\[(\d+)\]/)
    if (!num) continue
    const m = line.match(/(\S{2,})\s+\1/)
    if (m) {
      const word = m[1]
      return {
        corrections: [
          {
            segment_number: Number(num[1]),
            before: `${word} ${word}`,
            after: word,
            kind: 'duplicate',
            reason: '[fake] repeated word',
          },
        ],
      }
    }
  }
  return { corrections: [] }
}

export function createFakeMetaApi(env: NodeJS.ProcessEnv = process.env): MetaApi {
  async function transcribeChunk(opts: TranscribeChunkOptions): Promise<TranscribeResult> {
    await sleep(fakeDelayMs('transcribe', env))
    const chunkMs = Math.max(1, opts.chunkDurationMs)
    const turnCount = Math.max(1, Math.round(chunkMs / 12000))
    const turnMs = chunkMs / turnCount
    const turns = Array.from({ length: turnCount }, (_, i) => ({
      turnId: i,
      startMs: Math.floor(i * turnMs),
      endMs: Math.floor((i + 1) * turnMs),
      transcript: `[fake] segment ${i + 1}`,
    }))
    return {
      sessionId: 'fake-session',
      transcript: turns.map((t) => t.transcript).join(' '),
      audioDurationMs: opts.chunkDurationMs,
      turns,
    }
  }

  async function chat(opts: ChatOptions): Promise<unknown> {
    await sleep(fakeDelayMs('chat', env))
    const name = opts.responseFormat?.name
    const content = userContentOf(opts.messages)
    if (name === SUMMARY_SCHEMA_NAME) return buildFakeSummaryPayload(content)
    if (name === VERIFY_SCHEMA_NAME) return buildFakeVerifyPayload(content)
    if (name === CHECK_LOCATE_SCHEMA_NAME) return buildFakeLocatePayload(content)
    if (name === CORRECTION_SCHEMA_NAME) return buildFakeCorrectionPayload(content)
    return '[fake] reply'
  }

  return { transcribeChunk, chat }
}
