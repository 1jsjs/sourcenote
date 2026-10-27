import { describe, expect, it } from 'vitest'
import {
  applyVerifyResults,
  buildSummaryMessages,
  buildVerifyMessages,
  idByNumberMap,
  mapSummaryClaims,
  MISSING_RESULT_REASON,
  numberSegments,
  splitBatches,
  stripClaimCitationMarkers,
  SUMMARY_SCHEMA,
  SUMMARY_SYSTEM_PROMPT,
  validateSummaryPayload,
  validateVerifyPayload,
  VERIFY_BATCH_SIZE,
  VERIFY_SCHEMA,
} from '../src/main/grounding'

const SEGMENTS = [
  { id: 101, startMs: 0, endMs: 5000, text: '오늘은 신경망 기초를 배웁니다' },
  { id: 102, startMs: 5000, endMs: 9000, text: '히든 레이어가 특징을 추출합니다' },
  { id: 103, startMs: 9000, endMs: 12000, text: '다음 시간에 뵙겠습니다' },
]

describe('numberSegments', () => {
  it('numbers segments 1..N in note order with timestamped lines', () => {
    const numbered = numberSegments(SEGMENTS)
    expect(numbered.map((s) => s.n)).toEqual([1, 2, 3])
    expect(numbered[0].line).toBe('[1] (00:00:00–00:00:05) 오늘은 신경망 기초를 배웁니다')
    expect(numbered[2].line).toBe('[3] (00:00:09–00:00:12) 다음 시간에 뵙겠습니다')
  })

  it('maps consecutive numbers back to segment DB ids', () => {
    const byNumber = idByNumberMap(numberSegments(SEGMENTS))
    expect(byNumber.get(1)).toBe(101)
    expect(byNumber.get(2)).toBe(102)
    expect(byNumber.get(3)).toBe(103)
    expect(byNumber.size).toBe(3)
  })

  it('the model only ever sees numbers, never DB ids', () => {
    const messages = buildSummaryMessages(numberSegments(SEGMENTS))
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('system')
    const user = messages[1].content
    expect(user).toContain('[1]')
    expect(user).not.toContain('101')
    expect(user).not.toContain('102')
    expect(user).not.toContain('103')
  })
})

describe('mapSummaryClaims', () => {
  it('deduplicates ids and discards out-of-range numbers', () => {
    const byNumber = idByNumberMap(numberSegments(SEGMENTS))
    const mapped = mapSummaryClaims(
      validateSummaryPayload({ claims: [{ text: '주장', segment_ids: [2, 2, 99, 0, -1] }] }),
      byNumber,
    )
    expect(mapped).toHaveLength(1)
    expect(mapped[0].segmentDbIds).toEqual([102])
  })

  it('drops non-integer ids', () => {
    const byNumber = idByNumberMap(numberSegments(SEGMENTS))
    const mapped = mapSummaryClaims(
      [{ text: '주장', segmentIds: [1.5, '2', null, 1] }],
      byNumber,
    )
    expect(mapped[0].segmentDbIds).toEqual([101])
  })

  it('a claim left with zero valid citations keeps an empty list for the pipeline', () => {
    const byNumber = idByNumberMap(numberSegments(SEGMENTS))
    const mapped = mapSummaryClaims(
      validateSummaryPayload({ claims: [{ text: '근거 없음', segment_ids: [42] }] }),
      byNumber,
    )
    expect(mapped[0].segmentDbIds).toEqual([])
  })

  it('keeps claim order via idx', () => {
    const byNumber = idByNumberMap(numberSegments(SEGMENTS))
    const mapped = mapSummaryClaims(
      validateSummaryPayload({
        claims: [
          { text: '첫째', segment_ids: [3] },
          { text: '둘째', segment_ids: [1] },
        ],
      }),
      byNumber,
    )
    expect(mapped.map((c) => [c.idx, c.text, c.segmentDbIds])).toEqual([
      [0, '첫째', [103]],
      [1, '둘째', [101]],
    ])
  })
})

describe('validateSummaryPayload', () => {
  it('throws a Korean error on a bad shape', () => {
    expect(() => validateSummaryPayload(null)).toThrow('형식')
    expect(() => validateSummaryPayload({ claims: 'nope' })).toThrow('형식')
    expect(() => validateSummaryPayload({ claims: [{ text: 42 }] })).toThrow('형식')
  })

  it('treats missing segment_ids/page_ids arrays as empty', () => {
    expect(validateSummaryPayload({ claims: [{ text: 't' }] })).toEqual([
      { text: 't', segmentIds: [], pageIds: [] },
    ])
  })
})

describe('verification batching and results', () => {
  it(`splits 45 claims into 3 calls (batch size ${VERIFY_BATCH_SIZE})`, () => {
    const items = Array.from({ length: 45 }, (_, i) => i)
    const batches = splitBatches(items)
    expect(batches).toHaveLength(3)
    expect(batches.map((b) => b.length)).toEqual([20, 20, 5])
  })

  it('verify messages carry ONLY the cited segment texts', () => {
    const messages = buildVerifyMessages([
      { claimIdx: 0, text: '히든 레이어 주장', citedTexts: [SEGMENTS[1].text] },
    ])
    const user = messages[1].content
    expect(user).toContain(SEGMENTS[1].text)
    expect(user).not.toContain(SEGMENTS[0].text)
    expect(user).not.toContain(SEGMENTS[2].text)
  })

  it('claims omitted from results become unsupported with a fixed reason', () => {
    const resolved = applyVerifyResults(
      [0, 1],
      [{ claimIndex: 0, supported: true, reason: '인용 구간에 명시됨' }],
    )
    expect(resolved[0]).toEqual({ claimIdx: 0, supported: true, reason: '인용 구간에 명시됨' })
    expect(resolved[1]).toEqual({ claimIdx: 1, supported: false, reason: MISSING_RESULT_REASON })
  })

  it('validateVerifyPayload throws on a bad top level but skips malformed entries', () => {
    expect(() => validateVerifyPayload(null)).toThrow('형식')
    expect(() => validateVerifyPayload({ results: 'nope' })).toThrow('형식')
    expect(
      validateVerifyPayload({
        results: [
          { claim_index: 0, supported: false, reason: '없음' },
          { claim_index: 'x', supported: true, reason: 'bad' },
          null,
        ],
      }),
    ).toEqual([{ claimIndex: 0, supported: false, reason: '없음' }])
  })
})

describe('stripClaimCitationMarkers', () => {
  it('strips embedded [n]/[Pn] markers and tidies leftover spaces', () => {
    expect(stripClaimCitationMarkers('오늘은 경사하강법(Gradient Descent)을 다룬다 [1][P1].')).toBe(
      '오늘은 경사하강법(Gradient Descent)을 다룬다.',
    )
    expect(stripClaimCitationMarkers('주장 [3] 중간 [P2] 끝')).toBe('주장 중간 끝')
    expect(stripClaimCitationMarkers('마커 없는 문장.')).toBe('마커 없는 문장.')
    expect(stripClaimCitationMarkers('[1]')).toBe('')
  })

  it('mapped claims never keep embedded markers', () => {
    const byNumber = idByNumberMap(numberSegments(SEGMENTS))
    const mapped = mapSummaryClaims(
      validateSummaryPayload({ claims: [{ text: '주장이다 [1][P1].', segment_ids: [1] }] }),
      byNumber,
    )
    expect(mapped[0].text).toBe('주장이다.')
  })

  it('the summary prompt forbids inline citation markers', () => {
    expect(SUMMARY_SYSTEM_PROMPT).toContain('Do not write segment or slide numbers')
  })
})

describe('schemas are strict', () => {
  it('every object forbids additional properties and requires all its fields', () => {
    const assertStrict = (node: unknown, path: string): void => {
      if (node === null || typeof node !== 'object') return
      const obj = node as Record<string, unknown>
      if (obj.type === 'object') {
        expect(obj.additionalProperties, `${path} additionalProperties`).toBe(false)
        const props = Object.keys((obj.properties ?? {}) as Record<string, unknown>)
        expect(obj.required, `${path} required`).toEqual(props)
        for (const key of props) {
          assertStrict((obj.properties as Record<string, unknown>)[key], `${path}.${key}`)
        }
      }
      if (obj.type === 'array') assertStrict(obj.items, `${path}[]`)
    }
    assertStrict(SUMMARY_SCHEMA, 'summary')
    assertStrict(VERIFY_SCHEMA, 'verify')
  })
})
