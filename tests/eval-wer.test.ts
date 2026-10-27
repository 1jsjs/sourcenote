import { describe, expect, it } from 'vitest'
import { cleanVerbatim, editDistance, normalizeWords } from '../scripts/eval-wer'

describe('normalizeWords', () => {
  it('drops speaker labels, bracketed notes and punctuation', () => {
    expect(
      normalizeWords('Instructor (Andrew Ng) :All right, good morning. Student: [inaudible] Don’t stop.'),
    ).toEqual(['all', 'right', 'good', 'morning', 'dont', 'stop'])
  })
})

describe('editDistance', () => {
  it('counts substitutions, insertions and deletions', () => {
    expect(editDistance(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(0)
    expect(editDistance(['a', 'b', 'c'], ['a', 'x', 'c'])).toBe(1)
    expect(editDistance(['a', 'b', 'c'], ['a', 'c'])).toBe(1)
    expect(editDistance(['a', 'b'], ['a', 'b', 'c', 'd'])).toBe(2)
  })
})

describe('cleanVerbatim', () => {
  it('drops fillers and immediate repeats', () => {
    expect(cleanVerbatim('so um the the get started get started now'.split(' '))).toEqual([
      'so',
      'the',
      'get',
      'started',
      'now',
    ])
  })
})
