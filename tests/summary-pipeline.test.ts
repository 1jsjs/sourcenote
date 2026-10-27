import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { BudgetExceededError } from '../src/main/budget'
import {
  createNote,
  createSource,
  getLatestSummary,
  insertSegments,
  openDb,
  updateSourceStatus,
} from '../src/main/db'
import type { ChatOptions, MetaApi } from '../src/main/meta-api'
import { runSummaryPipeline, type SummaryPipelineDeps } from '../src/main/summary-pipeline'
import type { SummaryProgressEvent } from '../src/shared/types'

/** Fake MetaApi serving canned chat payloads and recording every chat call. */
function fakeMetaApi(
  summaryPayload: unknown,
  verifyResponder: (callIndex: number) => unknown,
  chatImpl?: (opts: ChatOptions, callIndex: number) => Promise<unknown>,
): { api: MetaApi; chatCalls: ChatOptions[] } {
  const chatCalls: ChatOptions[] = []
  const api: MetaApi = {
    transcribeChunk: async () => {
      throw new Error('사용되지 않음')
    },
    chat: async (opts: ChatOptions) => {
      const callIndex = chatCalls.length
      chatCalls.push(opts)
      if (chatImpl) return chatImpl(opts, callIndex)
      return callIndex === 0 ? summaryPayload : verifyResponder(callIndex)
    },
  }
  return { api, chatCalls }
}

function seedNote(db: DatabaseSync, segmentCount: number): number {
  const note = createNote(db, '강의 노트')
  const source = createSource(db, {
    noteId: note.id,
    kind: 'audio',
    originalPath: '/tmp/lecture.wav',
    displayName: 'lecture.wav',
  })
  insertSegments(
    db,
    source.id,
    Array.from({ length: segmentCount }, (_, i) => ({
      idx: i,
      startMs: i * 1000,
      endMs: (i + 1) * 1000,
      text: `구간 내용 ${i}`,
      chunkIndex: 0,
    })),
  )
  updateSourceStatus(db, source.id, 'done')
  return note.id
}

function makeDeps(db: DatabaseSync, metaApi: MetaApi, events: SummaryProgressEvent[]): SummaryPipelineDeps {
  return { db, metaApi, onProgress: (e) => events.push(e) }
}

describe('runSummaryPipeline', () => {
  let dir: string
  let db: DatabaseSync

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-sumpipe-'))
    db = openDb(path.join(dir, 'test.sqlite'))
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('summarizes, stores citations, and verifies (zero-citation claims skip verification)', async () => {
    const noteId = seedNote(db, 2)
    const summaryPayload = {
      claims: [
        { text: '시작 주장', segment_ids: [1, 1, 99] },
        { text: '빈 인용 주장', segment_ids: [99] },
      ],
    }
    const { api, chatCalls } = fakeMetaApi(summaryPayload, () => ({
      results: [{ claim_index: 0, supported: true, reason: '인용 구간에 명시됨' }],
    }))
    const events: SummaryProgressEvent[] = []

    const summary = await runSummaryPipeline(makeDeps(db, api, events), noteId)

    // 1 summary call + 1 verification batch (the zero-citation claim is excluded).
    expect(chatCalls).toHaveLength(2)
    expect(chatCalls[0].responseFormat).toMatchObject({ name: 'lecture_summary' })
    expect(chatCalls[1].responseFormat).toMatchObject({ name: 'claim_verification' })
    // The verify call sees ONLY the cited segment text.
    const verifyUser = chatCalls[1].messages[1].content
    expect(verifyUser).toContain('구간 내용 0')
    expect(verifyUser).not.toContain('구간 내용 1')

    expect(summary.status).toBe('done')
    expect(summary.claims).toHaveLength(2)
    expect(summary.claims[0]).toMatchObject({ verdict: 'supported', reason: '인용 구간에 명시됨' })
    expect(summary.claims[0].citations).toHaveLength(1)
    expect(summary.claims[1].verdict).toBe('unsupported')
    expect(summary.claims[1].reason).toBe('인용한 구간이 자료에 없습니다')

    expect(events.map((e) => e.stage)).toEqual(['summarizing', 'verifying', 'done'])
  })

  it('marks claims omitted from results as unsupported', async () => {
    const noteId = seedNote(db, 1)
    const { api } = fakeMetaApi(
      { claims: [{ text: '주장', segment_ids: [1] }] },
      () => ({ results: [] }),
    )
    const summary = await runSummaryPipeline(makeDeps(db, api, []), noteId)
    expect(summary.claims[0].verdict).toBe('unsupported')
    expect(summary.claims[0].reason).toBe('검증 결과를 받지 못했습니다')
  })

  it('verifies 45 claims in 3 batches', async () => {
    const noteId = seedNote(db, 45)
    const summaryPayload = {
      claims: Array.from({ length: 45 }, (_, i) => ({ text: `주장 ${i}`, segment_ids: [i + 1] })),
    }
    const { api, chatCalls } = fakeMetaApi(summaryPayload, () => ({
      results: Array.from({ length: 45 }, (_, i) => ({
        claim_index: i,
        supported: true,
        reason: '확인됨',
      })),
    }))

    const summary = await runSummaryPipeline(makeDeps(db, api, []), noteId)
    expect(chatCalls).toHaveLength(4) // 1 summary + 3 verify batches
    expect(summary.claims).toHaveLength(45)
    expect(summary.claims.every((c) => c.verdict === 'supported')).toBe(true)
  })

  it('throws a Korean error when there is nothing to summarize', async () => {
    const note = createNote(db, '빈 노트')
    await expect(runSummaryPipeline(makeDeps(db, fakeMetaApi({}, () => ({})).api, []), note.id)).rejects.toThrow(
      '요약할 전사 구간이 없습니다',
    )
    expect(getLatestSummary(db, note.id)).toBeNull()
  })

  it('stores error status and rethrows on failure', async () => {
    const noteId = seedNote(db, 1)
    const failing: MetaApi = {
      transcribeChunk: async () => {
        throw new Error('사용되지 않음')
      },
      chat: async () => {
        throw new Error('요약 API 오류 (HTTP 500): boom')
      },
    }
    const events: SummaryProgressEvent[] = []
    await expect(runSummaryPipeline(makeDeps(db, failing, events), noteId)).rejects.toThrow(
      '요약 API 오류 (HTTP 500)',
    )
    const latest = getLatestSummary(db, noteId)
    expect(latest?.status).toBe('error')
    expect(latest?.error).toContain('HTTP 500')
    expect(events.map((e) => e.stage)).toEqual(['summarizing', 'error'])
  })

  it('propagates budget errors with their existing message', async () => {
    const noteId = seedNote(db, 1)
    const overBudget: MetaApi = {
      transcribeChunk: async () => {
        throw new Error('사용되지 않음')
      },
      chat: async () => {
        throw new BudgetExceededError(100, 1, 100)
      },
    }
    await expect(runSummaryPipeline(makeDeps(db, overBudget, [],), noteId)).rejects.toThrow(
      '예산 한도($100)에 도달해 호출을 막았습니다',
    )
    expect(getLatestSummary(db, noteId)?.status).toBe('error')
  })
})
