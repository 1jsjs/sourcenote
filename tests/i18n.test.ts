import { describe, expect, it } from 'vitest'
import { messages, sampleLanguageLabel, t, type MessageKey } from '../src/renderer/src/i18n'

describe('renderer i18n', () => {
  it('ko and en have identical key sets', () => {
    expect(Object.keys(messages.ko).sort()).toEqual(Object.keys(messages.en).sort())
  })

  it('every key is a non-empty string in both languages', () => {
    for (const key of Object.keys(messages.ko) as MessageKey[]) {
      expect(messages.ko[key].length).toBeGreaterThan(0)
      expect(messages.en[key].length).toBeGreaterThan(0)
    }
  })

  it('fills placeholders', () => {
    expect(t('ko', 'transcribingProgress', { done: 3, total: 9 })).toBe('전사 중 3/9')
    expect(t('en', 'transcribingProgress', { done: 3, total: 9 })).toBe('Transcribing 3/9')
    expect(t('en', 'notInSources')).toBe('Not in sources')
  })

  it('labels sample languages in the UI language', () => {
    expect(sampleLanguageLabel('ko', 'ko')).toBe('한국어')
    expect(sampleLanguageLabel('en', 'ko')).toBe('Korean')
    expect(sampleLanguageLabel('en', 'en')).toBe('English')
  })
})
