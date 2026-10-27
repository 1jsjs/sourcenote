import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ProgressEvent } from '../shared/types'
import {
  convertToChunks,
  getAudioDurationMs,
  planChunks,
  resolveFfmpegPath,
} from './audio'
import {
  getSource,
  insertSegments,
  listSegments,
  setSourceDuration,
  updateSourceStatus,
} from './db'
import type { MetaApi } from './meta-api'
import { turnsToSegments } from './transcribe'
import type { Segment } from '../shared/types'

/**
 * Stage-1 pipeline: source audio -> 16 kHz mono WAV chunks -> transcribe each
 * chunk sequentially -> store absolute-timeline segments in SQLite.
 * Source status moves pending -> converting -> transcribing -> done|error.
 */

export interface PipelineDeps {
  db: DatabaseSync
  metaApi: MetaApi
  mediaDir: string
  ffmpegPath?: string
  onProgress?: (event: ProgressEvent) => void
}

/** User-facing error text; the budget message is already in Korean. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
    const durationMs = await getAudioDurationMs(source.original_path, ffmpeg)
    setSourceDuration(db, sourceId, durationMs)

    const plans = planChunks(durationMs)
    const outDir = path.join(deps.mediaDir, String(sourceId))
    const chunkPaths = await convertToChunks(source.original_path, outDir, plans, ffmpeg)

    updateSourceStatus(db, sourceId, 'transcribing')
    let nextIdx = 0
    for (const [i, plan] of plans.entries()) {
      report({ stage: 'transcribing', chunk: plan.index + 1, totalChunks: plans.length })
      const result = await deps.metaApi.transcribeChunk({
        chunkPath: chunkPaths[i],
        chunkDurationMs: plan.durationMs,
        fileName: path.basename(chunkPaths[i]),
      })
      const drafts = turnsToSegments(result, plan.offsetMs, plan.durationMs, plan.index, nextIdx)
      nextIdx += drafts.length
      insertSegments(db, sourceId, drafts)
    }

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
