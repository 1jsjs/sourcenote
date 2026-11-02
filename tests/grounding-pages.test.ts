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
  MAX_VERIFY_IMAGES,
  numberPages,
  numberSegments,
  pageEvidenceText,
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
    const user = buildSummaryMessages(numberSegments(SEGMENTS), numberPages(PAGES))[1]
      .content as string
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

describe('pageEvidenceText', () => {
  it('returns the plain text when there is no visual description', () => {
    expect(pageEvidenceText('본문', null)).toBe('본문')
    expect(pageEvidenceText('본문', undefined)).toBe('본문')
    expect(pageEvidenceText('본문', '')).toBe('본문')
    expect(pageEvidenceText('본문', '   ')).toBe('본문')
  })

  it('appends the visual description as a [figure] line', () => {
    expect(pageEvidenceText('본문', '막대그래프')).toBe('본문\n[figure] 막대그래프')
  })

  it('keeps a visual-only page as just the [figure] line', () => {
    expect(pageEvidenceText('', '막대그래프')).toBe('[figure] 막대그래프')
    expect(pageEvidenceText('  ', '막대그래프')).toBe('[figure] 막대그래프')
  })
})

describe('numberPages with visual text', () => {
  it('keeps a page that has only visualText and shows the [figure] line', () => {
    const numbered = numberPages([
      { id: 31, pageNo: 1, displayName: 's.pdf', text: '', visualText: '축 범위가 있는 그래프' },
      { id: 32, pageNo: 2, displayName: 's.pdf', text: '', visualText: '' },
      { id: 33, pageNo: 3, displayName: 's.pdf', text: '', visualText: null },
    ])
    expect(numbered).toHaveLength(1)
    expect(numbered[0].pageId).toBe(31)
    expect(numbered[0].text).toBe('[figure] 축 범위가 있는 그래프')
    expect(numbered[0].line).toBe('[P1] (s.pdf p.1) [figure] 축 범위가 있는 그래프')
  })

  it('combines text and visualText in text and line', () => {
    const numbered = numberPages([
      { id: 34, pageNo: 1, displayName: 's.pdf', text: '제목', visualText: '화살표 도식' },
    ])
    expect(numbered[0].text).toBe('제목\n[figure] 화살표 도식')
    expect(numbered[0].line).toContain('제목\n[figure] 화살표 도식')
  })
})

describe('buildVerifyMessages with slide images', () => {
  const BATCH = [
    {
      claimIdx: 0,
      text: '그래프 주장',
      citedTexts: [formatSlideEvidence(2, pageEvidenceText('본문', '막대그래프'))],
    },
  ]
  const IMAGE_PART = {
    type: 'image_url' as const,
    image_url: { url: 'data:image/jpeg;base64,AAAA' },
  }

  it('without images the user content stays the exact plain text block', () => {
    const messages = buildVerifyMessages(BATCH, 'ko')
    expect(typeof messages[1].content).toBe('string')
    expect(messages[1].content).toBe(
      'Claim 0: 그래프 주장\nCited evidence:\n- [slide p.2] 본문\n[figure] 막대그래프',
    )
    // Same as passing an empty image list.
    expect(buildVerifyMessages(BATCH, 'ko', [])).toEqual(messages)
  })

  it('with images the text block is followed by labelled image parts', () => {
    const messages = buildVerifyMessages(BATCH, 'ko', [{ pageNo: 2, part: IMAGE_PART }])
    expect(messages[0].content).toContain('authoritative evidence')
    const content = messages[1].content
    expect(Array.isArray(content)).toBe(true)
    if (!Array.isArray(content)) return
    expect(content[0]).toEqual({
      type: 'text',
      text: 'Claim 0: 그래프 주장\nCited evidence:\n- [slide p.2] 본문\n[figure] 막대그래프',
    })
    expect(content[1]).toEqual({ type: 'text', text: 'Image of slide p.2:' })
    expect(content[2]).toEqual(IMAGE_PART)
  })

  it('caps attachments at MAX_VERIFY_IMAGES worth of images per call', () => {
    // The cap is enforced by the caller; the builder simply appends what it gets.
    const images = Array.from({ length: MAX_VERIFY_IMAGES }, (_, i) => ({
      pageNo: i + 1,
      part: IMAGE_PART,
    }))
    const content = buildVerifyMessages(BATCH, 'ko', images)[1].content
    if (!Array.isArray(content)) throw new Error('expected content parts')
    expect(content).toHaveLength(1 + MAX_VERIFY_IMAGES * 2)
  })
})
