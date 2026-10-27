import { describe, expect, it } from 'vitest'
import { isBlockingError, noteTitleFromPath, scrollTopFor } from '../src/renderer/src/utils'

describe('renderer utils', () => {
  it('derives a note title from a file path', () => {
    expect(noteTitleFromPath('/Users/me/강의 1주차.m4a')).toBe('강의 1주차')
    expect(noteTitleFromPath('C:\\Users\\me\\slides.pdf')).toBe('slides')
    expect(noteTitleFromPath('noext')).toBe('noext')
    expect(noteTitleFromPath('/tmp/.hidden')).toBe('.hidden')
  })

  it('routes only budget/key errors to the blocking banner', () => {
    expect(isBlockingError('예산이 부족합니다')).toBe(true)
    expect(isBlockingError('Budget cap exceeded')).toBe(true)
    expect(isBlockingError('API 키가 없습니다')).toBe(true)
    expect(isBlockingError('전사 API 오류 (HTTP 500)')).toBe(false)
    expect(isBlockingError('지원하지 않는 파일입니다')).toBe(false)
  })
})

describe('scrollTopFor', () => {
  it('aligns a child to the top of the container with a margin', () => {
    expect(
      scrollTopFor({ top: 100, height: 500, scrollTop: 200 }, { top: 400, height: 40 }, 'start'),
    ).toBe(488)
  })

  it('centers a child in the container', () => {
    expect(
      scrollTopFor({ top: 100, height: 500, scrollTop: 0 }, { top: 700, height: 40 }, 'center'),
    ).toBe(370)
  })

  it('never returns a negative scrollTop', () => {
    expect(scrollTopFor({ top: 0, height: 500, scrollTop: 0 }, { top: 10, height: 20 }, 'center')).toBe(0)
  })
})
