import { describe, expect, it } from 'vitest'
import {
  buildCheckLocateMessages,
  CHECK_LOCATE_SCHEMA,
  CHECK_LOCATE_SCHEMA_NAME,
  mapCheckLocate,
  validateCheckLocatePayload,
} from '../src/main/check-pipeline'
import {
  buildCorrectionMessages,
  CORRECTION_SCHEMA,
  CORRECTION_SCHEMA_NAME,
  filterValidCorrections,
  validateCorrectionPayload,
} from '../src/main/correction'
import {
  createFakeMetaApi,
  fakeDelayMs,
  isFakeApiEnabled,
  parseFakePages,
  parseFakeSegments,
} from '../src/main/fake-api'
import {
  applyVerifyResults,
  buildSummaryMessages,
  buildVerifyMessages,
  idByNumberMap,
  mapSummaryClaims,
  numberPages,
  numberSegments,
  pageIdByNumberMap,
  SUMMARY_SCHEMA,
  SUMMARY_SCHEMA_NAME,
  validateSummaryPayload,
  validateVerifyPayload,
  VERIFY_SCHEMA,
  VERIFY_SCHEMA_NAME,
  type VerifyItem,
} from '../src/main/grounding'
import { turnsToSegments } from '../src/main/transcribe'

const NO_WAIT = { SOURCENOTE_FAKE_DELAY_MS: '0' } as NodeJS.ProcessEnv

describe('fake api mode flag', () => {
  it('enables only on SOURCENOTE_FAKE_API=1', () => {
    expect(isFakeApiEnabled({} as NodeJS.ProcessEnv)).toBe(false)
    expect(isFakeApiEnabled({ SOURCENOTE_FAKE_API: '0' } as NodeJS.ProcessEnv)).toBe(false)
    expect(isFakeApiEnabled({ SOURCENOTE_FAKE_API: '1' } as NodeJS.ProcessEnv)).toBe(true)
  })

  it('defaults delays with override support', () => {
    expect(fakeDelayMs('transcribe', {} as NodeJS.ProcessEnv)).toBe(1500)
    expect(fakeDelayMs('chat', {} as NodeJS.ProcessEnv)).toBe(2000)
    expect(fakeDelayMs('transcribe', NO_WAIT)).toBe(0)
    expect(fakeDelayMs('chat', { SOURCENOTE_FAKE_DELAY_MS: '25' } as NodeJS.ProcessEnv)).toBe(25)
  })
})

describe('fake transcribe', () => {
  it('returns one turn per ~12s with placeholder text', async () => {
    const api = createFakeMetaApi(NO_WAIT)
    const result = await api.transcribeChunk({ chunkPath: '/tmp/c.wav', chunkDurationMs: 36000 })
    expect(result.audioDurationMs).toBe(36000)
    expect(result.turns).toHaveLength(3)
    expect(result.turns[0].transcript).toBe('[fake] segment 1')
    // The real segment mapper accepts the fake shape.
    const segments = turnsToSegments(result, 0, 36000, 0, 0)
    expect(segments).toHaveLength(3)
    expect(segments[0].startMs).toBe(0)
  })
})

function seedEvidence() {
  const segments = Array.from({ length: 8 }, (_, i) => ({
    id: 100 + i,
    startMs: i * 12000,
    endMs: (i + 1) * 12000,
    text: `강의 내용 ${i + 1}번째 구간입니다`,
  }))
  const pages = [{ id: 200, pageNo: 1, displayName: 'slides.pdf', text: '슬라이드 용어 정리' }]
  return { segments, pages }
}

describe('fake chat against real validators', () => {
  it('summary shape validates and maps to 6 cited claims', async () => {
    const { segments, pages } = seedEvidence()
    const numbered = numberSegments(segments)
    const numberedPages = numberPages(pages)
    const api = createFakeMetaApi(NO_WAIT)
    const raw = await api.chat({
      messages: buildSummaryMessages(numbered, numberedPages, 'ko'),
      responseFormat: { name: SUMMARY_SCHEMA_NAME, schema: SUMMARY_SCHEMA },
    })
    const mapped = mapSummaryClaims(
      validateSummaryPayload(raw),
      idByNumberMap(numbered),
      pageIdByNumberMap(numberedPages),
    )
    expect(mapped).toHaveLength(6)
    for (const claim of mapped) {
      expect(claim.segmentDbIds.length).toBeGreaterThan(0)
      expect(claim.pageDbIds).toEqual([200])
    }
  })

  it('verify shape validates with the 2nd claim unsupported', async () => {
    const items: VerifyItem[] = [0, 1, 2].map((idx) => ({
      claimIdx: idx,
      text: `주장 ${idx}`,
      citedTexts: ['[transcript 00:00:00] 근거'],
    }))
    const api = createFakeMetaApi(NO_WAIT)
    const raw = await api.chat({
      messages: buildVerifyMessages(items, 'ko'),
      responseFormat: { name: VERIFY_SCHEMA_NAME, schema: VERIFY_SCHEMA },
    })
    const resolved = applyVerifyResults(
      items.map((i) => i.claimIdx),
      validateVerifyPayload(raw),
      'ko',
    )
    expect(resolved).toHaveLength(3)
    expect(resolved[0].supported).toBe(true)
    expect(resolved[1].supported).toBe(false)
    expect(resolved[1].reason).toBe('[fake] not stated in the cited evidence')
    expect(resolved[2].supported).toBe(true)
  })

  it('locate shape validates; dropout sentences get no evidence', async () => {
    const { segments, pages } = seedEvidence()
    const numbered = numberSegments(segments)
    const numberedPages = numberPages(pages)
    const sentences = ['학습률은 가중치 폭을 정합니다.', 'Dropout은 항상 정확도를 높입니다.']
    const api = createFakeMetaApi(NO_WAIT)
    const raw = await api.chat({
      messages: buildCheckLocateMessages(
        sentences,
        numbered.map((s) => s.line),
        numberedPages.map((p) => p.line),
        'ko',
      ),
      responseFormat: { name: CHECK_LOCATE_SCHEMA_NAME, schema: CHECK_LOCATE_SCHEMA },
    })
    const mapped = mapCheckLocate(
      sentences,
      validateCheckLocatePayload(raw),
      idByNumberMap(numbered),
      pageIdByNumberMap(numberedPages),
    )
    expect(mapped).toHaveLength(2)
    expect(mapped[0].segmentDbIds).toEqual([100])
    expect(mapped[1].segmentDbIds).toEqual([])
    expect(mapped[1].pageDbIds).toEqual([])
  })

  it('corrections shape validates: one duplicate fix when a word repeats', async () => {
    const lines = [
      '[1] (00:00:00–00:00:12) 레이어로 레이어로 값을 전달합니다',
      '[2] (00:00:12–00:00:24) 정상 문장입니다',
    ]
    const textByNumber = new Map([[1, lines[0]], [2, lines[1]]])
    const idByNumber = new Map([[1, 11], [2, 12]])
    const api = createFakeMetaApi(NO_WAIT)
    const raw = await api.chat({
      messages: buildCorrectionMessages(lines, [], 'ko'),
      responseFormat: { name: CORRECTION_SCHEMA_NAME, schema: CORRECTION_SCHEMA },
    })
    const valid = filterValidCorrections(validateCorrectionPayload(raw), textByNumber, idByNumber)
    expect(valid).toHaveLength(1)
    expect(valid[0].kind).toBe('duplicate')

    const clean = await api.chat({
      messages: buildCorrectionMessages(['[1] (00:00:00–00:00:12) 정상 문장입니다'], [], 'ko'),
      responseFormat: { name: CORRECTION_SCHEMA_NAME, schema: CORRECTION_SCHEMA },
    })
    expect(validateCorrectionPayload(clean)).toEqual([])
  })

  it('parses numbered evidence lines out of chat messages', () => {
    const content = '[1] (00:00:00–00:00:12) 첫 구간\n[P1] (slides.pdf p.1) 첫 슬라이드'
    expect(parseFakeSegments(content)).toHaveLength(1)
    expect(parseFakePages(content)).toHaveLength(1)
  })
})
