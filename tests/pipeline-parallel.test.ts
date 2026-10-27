import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChunkPlan } from '../src/main/audio'
import { createNote, createSource, getSource, listSegments, openDb } from '../src/main/db'
import type { MetaApi } from '../src/main/meta-api'
import {
  resolveTranscribeConcurrency,
  runAudioPipeline,
  transcribeChunksConcurrently,
  type ChunkTranscribeJob,
} from '../src/main/pipeline'
import { MetaApiError } from '../src/main/meta-api'
import type { TranscribeResult } from '../src/main/transcribe'

function plan(index: number): ChunkPlan {
  return { index, offsetMs: index * 1000, durationMs: 1000 }
}

function job(index: number): ChunkTranscribeJob {
  return { plan: plan(index), chunkPath: `/tmp/chunk_${index}.wav` }
}

function result(text: string): TranscribeResult {
  return {
    sessionId: null,
    transcript: text,
    audioDurationMs: 1000,
    turns: [{ turnId: 0, startMs: 0, endMs: 1000, transcript: text }],
  }
}

describe('runAudioPipeline with parallel transcription', () => {
  let dir: string
  let db: DatabaseSync

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-pipe-'))
    db = openDb(path.join(dir, 'test.sqlite'))
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function fakeApi(byChunk: (index: number) => TranscribeResult | Promise<TranscribeResult>): MetaApi {
    return {
      transcribeChunk: async (opts) => {
        const m = /chunk_(\d+)/.exec(opts.fileName ?? '')
        return byChunk(m ? Number(m[1]) : 0)
      },
      chat: async () => {
        throw new Error('no chat in this test')
      },
    }
  }

  function seedSource(): number {
    const note = createNote(db, 'note')
    const source = createSource(db, {
      noteId: note.id,
      kind: 'audio',
      originalPath: '/tmp/lecture.wav',
      displayName: 'lecture.wav',
    })
    return source.id
  }

  it('stores segments in chunk order with continuous idx', async () => {
    const sourceId = seedSource()
    const events: Array<[number, number]> = []
    const segments = await runAudioPipeline(
      {
        db,
        metaApi: fakeApi((i) => result(`says ${i}`)),
        mediaDir: path.join(dir, 'media'),
        getDurationMs: async () => 1200000,
        convertChunks: async (_input, outDir, plans) =>
          plans.map((p) => path.join(outDir, `chunk_${p.index}.wav`)),
        transcribeConcurrency: 3,
        onProgress: (e) => {
          if (e.stage === 'transcribing') events.push([e.chunk, e.totalChunks])
        },
      },
      sourceId,
    )
    expect(segments.map((s) => s.text)).toEqual(['says 0', 'says 1', 'says 2'])
    expect(segments.map((s) => s.idx)).toEqual([0, 1, 2])
    expect(segments.map((s) => s.chunk_index)).toEqual([0, 1, 2])
    expect(getSource(db, sourceId)?.status).toBe('done')
    expect(events[events.length - 1]).toEqual([3, 3])
  })

  it('marks the source error with no partial segments when a chunk fails', async () => {
    const sourceId = seedSource()
    const metaApi = fakeApi((i) => {
      if (i === 1) throw new MetaApiError('bad chunk', 400)
      return result(`says ${i}`)
    })
    await expect(
      runAudioPipeline(
        {
          db,
          metaApi,
          mediaDir: path.join(dir, 'media'),
          getDurationMs: async () => 1200000,
          convertChunks: async (_input, outDir, plans) =>
            plans.map((p) => path.join(outDir, `chunk_${p.index}.wav`)),
          transcribeConcurrency: 2,
        },
        sourceId,
      ),
    ).rejects.toThrow('bad chunk')
    const source = getSource(db, sourceId)
    expect(source?.status).toBe('error')
    expect(source?.error).toContain('bad chunk')
    expect(listSegments(db, sourceId)).toEqual([])
  })
})

describe('resolveTranscribeConcurrency', () => {
  it('defaults to 3 without the env override', () => {
    expect(resolveTranscribeConcurrency({})).toBe(3)
  })

  it('clamps the env override to 1–6', () => {
    expect(resolveTranscribeConcurrency({ SOURCENOTE_TRANSCRIBE_CONCURRENCY: '1' })).toBe(1)
    expect(resolveTranscribeConcurrency({ SOURCENOTE_TRANSCRIBE_CONCURRENCY: '6' })).toBe(6)
    expect(resolveTranscribeConcurrency({ SOURCENOTE_TRANSCRIBE_CONCURRENCY: '0' })).toBe(1)
    expect(resolveTranscribeConcurrency({ SOURCENOTE_TRANSCRIBE_CONCURRENCY: '99' })).toBe(6)
    expect(resolveTranscribeConcurrency({ SOURCENOTE_TRANSCRIBE_CONCURRENCY: 'abc' })).toBe(3)
  })
})

describe('transcribeChunksConcurrently', () => {
  it('returns results in chunk order when chunks finish out of order', async () => {
    const resolvers: Array<(r: TranscribeResult) => void> = []
    const gates = Array.from({ length: 5 }, () => {
      let resolve!: (r: TranscribeResult) => void
      const promise = new Promise<TranscribeResult>((res) => {
        resolve = res
      })
      resolvers.push(resolve)
      return promise
    })
    const done: Array<[number, number]> = []
    const pending = await Promise.all([
      (async () => {
        const results = await transcribeChunksConcurrently({
          jobs: [0, 1, 2, 3, 4].map(job),
          transcribe: (j) => gates[j.plan.index],
          concurrency: 3,
          onChunkDone: (finished, total) => {
            done.push([finished, total])
          },
        })
        return results
      })(),
      (async () => {
        // Let all workers pick up their first jobs, then finish in reverse.
        await new Promise((res) => setTimeout(res, 20))
        for (let i = 4; i >= 0; i--) resolvers[i](result(`chunk ${i}`))
      })(),
    ])
    const results = pending[0]
    expect(results.map((r) => r.transcript)).toEqual([
      'chunk 0',
      'chunk 1',
      'chunk 2',
      'chunk 3',
      'chunk 4',
    ])
    expect(done).toHaveLength(5)
    expect(done.map(([f]) => f).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  })

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const results = await transcribeChunksConcurrently({
      jobs: [0, 1, 2, 3, 4, 5].map(job),
      transcribe: async (j) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((res) => setTimeout(res, 5))
        inFlight -= 1
        return result(`chunk ${j.plan.index}`)
      },
      concurrency: 2,
    })
    expect(results).toHaveLength(6)
    expect(maxInFlight).toBeLessThanOrEqual(2)
    expect(maxInFlight).toBeGreaterThan(1)
  })

  it('retries once on 503 then succeeds', async () => {
    let calls = 0
    const sleep = vi.fn(async () => undefined)
    const results = await transcribeChunksConcurrently({
      jobs: [job(0)],
      transcribe: async () => {
        calls += 1
        if (calls === 1) throw new MetaApiError('transient', 503)
        return result('recovered')
      },
      concurrency: 2,
      retryDelayMs: 7,
      sleep,
    })
    expect(results[0].transcript).toBe('recovered')
    expect(calls).toBe(2)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(7)
  })

  it('does not retry a 400 error', async () => {
    let calls = 0
    const sleep = vi.fn(async () => undefined)
    await expect(
      transcribeChunksConcurrently({
        jobs: [job(0)],
        transcribe: async () => {
          calls += 1
          throw new MetaApiError('bad request', 400)
        },
        sleep,
      }),
    ).rejects.toThrow('bad request')
    expect(calls).toBe(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('stops scheduling new chunks after a final failure', async () => {
    const started: number[] = []
    let releaseSlow!: () => void
    const slowGate = new Promise<void>((res) => {
      releaseSlow = res
    })
    const outcome = transcribeChunksConcurrently({
      jobs: [0, 1, 2, 3, 4].map(job),
      transcribe: async (j) => {
        started.push(j.plan.index)
        if (j.plan.index === 0) throw new MetaApiError('boom', 400)
        // In-flight chunks finish even after another chunk failed.
        await slowGate
        return result(`chunk ${j.plan.index}`)
      },
      concurrency: 2,
    })
    // Wait until the in-flight chunk started, then let it finish.
    await vi.waitFor(() => expect(started).toContain(1))
    releaseSlow()
    await expect(outcome).rejects.toThrow('boom')
    // Jobs 0 and 1 started (pool of 2); nothing else was scheduled.
    expect(started.sort((a, b) => a - b)).toEqual([0, 1])
  })
})
