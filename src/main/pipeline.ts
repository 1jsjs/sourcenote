import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ProgressEvent } from '../shared/types'
import {
  convertToChunks,
  getAudioDurationMs,
  planChunks,
  resolveFfmpegPath,
  type ChunkPlan,
} from './audio'
import {
  getSource,
  insertSegments,
  listSegments,
  setSourceDuration,
  updateSourceStatus,
  type NewSegment,
} from './db'
import { isRetryableApiError, type MetaApi } from './meta-api'
import { turnsToSegments, type TranscribeResult } from './transcribe'
import type { Segment } from '../shared/types'

/**
 * Stage-1 pipeline: source audio -> 16 kHz mono WAV chunks -> transcribe
 * chunks with a small worker pool -> store absolute-timeline segments in
 * SQLite. Source status moves pending -> converting -> transcribing ->
 * done|error.
 */

/** Default parallel transcriptions; override with SOURCENOTE_TRANSCRIBE_CONCURRENCY (1–6). */
export const TRANSCRIBE_CONCURRENCY = 3

/** Delay before the single retry of a transient chunk failure. */
export const TRANSIENT_RETRY_DELAY_MS = 2000

/** Resolves the worker-pool size: env override clamped to 1–6. Pure and unit-tested. */
export function resolveTranscribeConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SOURCENOTE_TRANSCRIBE_CONCURRENCY
  if (raw === undefined) return TRANSCRIBE_CONCURRENCY
  const n = Number(raw)
  if (!Number.isInteger(n)) return TRANSCRIBE_CONCURRENCY
  return Math.min(6, Math.max(1, n))
}

export interface PipelineDeps {
  db: DatabaseSync
  metaApi: MetaApi
  mediaDir: string
  ffmpegPath?: string
  onProgress?: (event: ProgressEvent) => void
  /** Overrides for the worker pool (tests); default is the env-resolved value. */
  transcribeConcurrency?: number
  /** Retry delay override (tests); default is TRANSIENT_RETRY_DELAY_MS. */
  retryDelayMs?: number
  /** Injectable timer (tests); defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>
  /** Injectable duration probe (tests); defaults to the real ffmpeg probe. */
  getDurationMs?: (originalPath: string, ffmpeg: string) => Promise<number>
  /** Injectable chunk conversion (tests); defaults to sequential ffmpeg conversion. */
  convertChunks?: (
    originalPath: string,
    outDir: string,
    plans: ChunkPlan[],
    ffmpeg: string,
  ) => Promise<string[]>
}

/** User-facing error text; the budget message is already localized. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface ChunkTranscribeJob {
  plan: ChunkPlan
  chunkPath: string
}

export interface TranscribePoolOptions {
  jobs: ChunkTranscribeJob[]
  transcribe: (job: ChunkTranscribeJob) => Promise<TranscribeResult>
  concurrency?: number
  retryDelayMs?: number
  sleep?: (ms: number) => Promise<void>
  /** Called with the finished-chunk count after each chunk completes. */
  onChunkDone?: (finished: number, total: number) => void
}

/**
 * Transcribes chunks with a worker pool of at most `concurrency` in-flight
 * calls. Each chunk is retried once on transient failures (network error,
 * HTTP 429, 5xx); other failures are not retried. When a chunk finally
 * fails, no new chunks are scheduled: in-flight ones finish, then the error
 * is rethrown. Results are returned in chunk order regardless of completion
 * order. Pure orchestration over the injected `transcribe` (unit-tested).
 */
export async function transcribeChunksConcurrently(
  opts: TranscribePoolOptions,
): Promise<TranscribeResult[]> {
  const { jobs, transcribe } = opts
  const rawConcurrency = opts.concurrency ?? TRANSCRIBE_CONCURRENCY
  const concurrency = Math.min(6, Math.max(1, Math.floor(rawConcurrency) || TRANSCRIBE_CONCURRENCY))
  const retryDelayMs = opts.retryDelayMs ?? TRANSIENT_RETRY_DELAY_MS
  const sleep = opts.sleep ?? defaultSleep

  const results: TranscribeResult[] = new Array(jobs.length)
  let next = 0
  let finished = 0
  let failed: unknown = null
  let hasFailed = false

  async function transcribeWithRetry(job: ChunkTranscribeJob): Promise<TranscribeResult> {
    try {
      return await transcribe(job)
    } catch (err) {
      if (!isRetryableApiError(err)) throw err
      await sleep(retryDelayMs)
      // Exactly one retry; its result (or error) is final.
      return transcribe(job)
    }
  }

  async function worker(): Promise<void> {
    for (;;) {
      if (hasFailed) return
      const i = next
      next += 1
      if (i >= jobs.length) return
      let result: TranscribeResult
      try {
        result = await transcribeWithRetry(jobs[i])
      } catch (err) {
        if (!hasFailed) {
          hasFailed = true
          failed = err
        }
        return
      }
      results[i] = result
      finished += 1
      opts.onChunkDone?.(finished, jobs.length)
    }
  }

  const workerCount = Math.min(concurrency, jobs.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  if (hasFailed) throw failed
  return results
}

export async function runAudioPipeline(deps: PipelineDeps, sourceId: number): Promise<Segment[]> {
  const { db, onProgress } = deps
  const source = getSource(db, sourceId)
  if (!source) throw new Error(`소스를 찾을 수 없습니다 (id=${sourceId})`)

  const report = (event: Omit<ProgressEvent, 'sourceId'>): void => {
    onProgress?.({ sourceId, ...event })
  }

  try {
    updateSourceStatus(db, sourceId, 'converting')
    report({ stage: 'converting', chunk: 0, totalChunks: 0 })

    const ffmpeg = deps.ffmpegPath ?? resolveFfmpegPath()
    const getDurationMs = deps.getDurationMs ?? getAudioDurationMs
    const convertFn = deps.convertChunks ?? convertToChunks
    const durationMs = await getDurationMs(source.original_path, ffmpeg)
    setSourceDuration(db, sourceId, durationMs)

    const plans = planChunks(durationMs)
    const outDir = path.join(deps.mediaDir, String(sourceId))
    const chunkPaths = await convertFn(source.original_path, outDir, plans, ffmpeg)

    updateSourceStatus(db, sourceId, 'transcribing')
    const jobs: ChunkTranscribeJob[] = plans.map((plan, i) => ({ plan, chunkPath: chunkPaths[i] }))
    const results = await transcribeChunksConcurrently({
      jobs,
      transcribe: (job) =>
        deps.metaApi.transcribeChunk({
          chunkPath: job.chunkPath,
          chunkDurationMs: job.plan.durationMs,
          fileName: path.basename(job.chunkPath),
        }),
      concurrency: deps.transcribeConcurrency ?? resolveTranscribeConcurrency(),
      retryDelayMs: deps.retryDelayMs,
      sleep: deps.sleep,
      // `chunk` is the finished-chunk count ("전사 중 3/9").
      onChunkDone: (finished, total) =>
        report({ stage: 'transcribing', chunk: finished, totalChunks: total }),
    })

    // All chunks succeeded: map to segments in chunk order with a continuous
    // idx, then store everything in one transaction. An errored source keeps
    // no partial segments.
    const drafts: NewSegment[] = []
    let nextIdx = 0
    for (const [i, plan] of plans.entries()) {
      const segs = turnsToSegments(results[i], plan.offsetMs, plan.durationMs, plan.index, nextIdx)
      nextIdx += segs.length
      drafts.push(...segs)
    }
    insertSegments(db, sourceId, drafts)

    updateSourceStatus(db, sourceId, 'done')
    report({ stage: 'done', chunk: plans.length, totalChunks: plans.length })
    return listSegments(db, sourceId)
  } catch (err) {
    const message = errorMessage(err)
    updateSourceStatus(db, sourceId, 'error', message)
    report({ stage: 'error', chunk: 0, totalChunks: 0, message })
    throw err
  }
}
