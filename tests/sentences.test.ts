import { describe, expect, it } from 'vitest'
import { splitSentences } from '../src/shared/sentences'
import { splitUserSentences } from '../src/main/check-pipeline'

describe('shared splitSentences', () => {
  it('splits on sentence boundaries and newlines', () => {
    expect(splitSentences('첫 문장입니다. 두 번째예요? 세 번째!')).toEqual([
      '첫 문장입니다.',
      '두 번째예요?',
      '세 번째!',
    ])
    expect(splitSentences('line one\nline two')).toEqual(['line one', 'line two'])
  })

  it('drops empties and keeps decimal points intact', () => {
    expect(splitSentences('  \n  ')).toEqual([])
    expect(splitSentences('값은 3.14이다. 끝.')).toEqual(['값은 3.14이다.', '끝.'])
  })

  it('matches the check pipeline splitter exactly (renderer skeleton parity)', () => {
    const samples = [
      '강의를 듣고 정리했다. 드롭아웃은 정규화 기법이다!\n질문이 있나요? 3.14는 원주율이다.',
      '',
      '한 문장만',
      'a. b? c!\nd. e.',
    ]
    for (const text of samples) {
      let viaPipeline: string[]
      try {
        viaPipeline = splitUserSentences(text)
      } catch {
        viaPipeline = []
      }
      expect(splitSentences(text)).toEqual(viaPipeline)
    }
  })
})
