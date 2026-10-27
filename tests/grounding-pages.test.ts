import { describe, expect, it } from 'vitest'
import {
  buildSummaryMessages,
  buildVerifyMessages,
  formatPageLine,
  formatSlideEvidence,
  formatTranscriptEvidence,
  idByNumberMap,
  mapSummaryClaims,
  MAX_PAGE_CHARS,
  numberPages,
  numberSegments,
  pageIdByNumberMap,
  SUMMARY_SCHEMA,
  validateSummaryPayload,
} from '../src/main/grounding'

const SEGMENTS = [{ id: 11, startMs: 0, endMs: 4000, text: '교수님 말씀' }]
const PAGES = [
  { id: 21, pageNo: 1, displayName: 'slides.pdf', text: '은닉층 정의' },
  { id: 22, pageNo: 2, displayName: 'slides.pdf', text: '   ' },
  { id: 23, pageNo: 3, displayName: 'slides.pdf', text: '역전파 그림' },
]

describe('numberPages', () => {
  it('numbers non-empty pages 1..M and maps k back to page DB ids', () => {
    const numbered = numberPages(PAGES)
    expect(numbered.map((p) => p.k)).toEqual([1, 2])
    expect(numbered[0].line).toBe('[P1] (slides.pdf p.1) 은닉층 정의')
    expect(numbered[1].pageId).toBe(23)
    const byNumber = pageIdByNumberMap(numbered)
    expect(byNumber.get(1)).toBe(21)
    expect(byNumber.get(2)).toBe(23)
    expect(byNumber.size).toBe(2)
  })

  it('truncates page text to 3000 chars', () => {
    const line = formatPageLine(1, 's.pdf', 5, '가'.repeat(MAX_PAGE_CHARS + 100))
    expect(line).toBe(`[P1] (s.pdf p.5) ${'가'.repeat(MAX_PAGE_CHARS)}`)
  })
})

describe('buildSummaryMessages with slides', () => {
  it('has no Slides section without pages', () => {
    const user = buildSummaryMessages(numberSegments(SEGMENTS))[1].content
    expect(user).not.toContain('Slides:')
  })

  it('appends a Slides section with [Pk] lines when pages exist', () => {
    const user = buildSummaryMessages(numberSegments(SEGMENTS), numberPages(PAGES))[1].content
    expect(user).toContain('[1] (00:00:00–00:00:04) 교수님 말씀')
    expect(user).toContain('Slides:')
    expect(user).toContain('[P1] (slides.pdf p.1)')
    expect(user).toContain('[P2] (slides.pdf p.3)')
    expect(user.indexOf('Slides:')).toBeGreaterThan(user.indexOf('[1]'))
  })
})

describe('page id mapping', () => {
  it('maps page_ids with dedupe and drops invalid numbers', () => {
    const byNumber = pageIdByNumberMap(numberPages(PAGES))
    const mapped = mapSummaryClaims(
      validateSummaryPayload({ claims: [{ text: '주장', segment_ids: [], page_ids: [2, 2, 99, 0] }] }),
      new Map(),
      byNumber,
    )
    expect(mapped[0].pageDbIds).toEqual([23])
    expect(mapped[0].segmentDbIds).toEqual([])
  })

  it('keeps mixed segment and page citations on one claim', () => {
    const mapped = mapSummaryClaims(
      validateSummaryPayload({ claims: [{ text: '주장', segment_ids: [1], page_ids: [1] }] }),
      idByNumberMap(numberSegments(SEGMENTS)),
      pageIdByNumberMap(numberPages(PAGES)),
    )
    expect(mapped[0].segmentDbIds).toEqual([11])
    expect(mapped[0].pageDbIds).toEqual([21])
  })

  it('a claim with only page citations is verifiable (non-empty)', () => {
    const mapped = mapSummaryClaims(
      [{ text: '슬라이드 주장', segmentIds: [], pageIds: [1] }],
      idByNumberMap(numberSegments(SEGMENTS)),
      pageIdByNumberMap(numberPages(PAGES)),
    )
    expect(mapped[0].segmentDbIds).toEqual([])
    expect(mapped[0].pageDbIds).toEqual([21])
  })

  it('the strict schema requires page_ids on every claim', () => {
    const claims = (SUMMARY_SCHEMA.properties.claims as { items: unknown }).items as Record<
      string,
      unknown
    >
    expect(claims.required).toEqual(['text', 'segment_ids', 'page_ids'])
  })
})

describe('verify evidence labels', () => {
  it('labels transcript and slide evidence by kind', () => {
    expect(formatTranscriptEvidence(5000, '말씀')).toBe('[transcript 00:00:05] 말씀')
    expect(formatSlideEvidence(3, '그림')).toBe('[slide p.3] 그림')
  })

  it('verify messages carry the labelled evidence lines', () => {
    const messages = buildVerifyMessages([
      {
        claimIdx: 0,
        text: '주장',
        citedTexts: [formatTranscriptEvidence(0, '교수님 말씀'), formatSlideEvidence(1, '은닉층 정의')],
      },
    ])
    const user = messages[1].content
    expect(user).toContain('Cited evidence:')
    expect(user).toContain('- [transcript 00:00:00] 교수님 말씀')
    expect(user).toContain('- [slide p.1] 은닉층 정의')
  })
})
