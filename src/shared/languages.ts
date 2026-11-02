import type { AppLanguage } from './types'

/**
 * Per-note language choices. The 25 supported languages are exactly the
 * names Muse Voice Transcribe accepts in `languageBias`; the same English
 * names are stored in the DB and sent to the API. Unknown names silently
 * degrade to auto-detection there, so validators below reject anything else.
 *
 * This file must stay usable from main, preload and renderer (like types.ts).
 */

export interface SupportedLanguage {
  /** English name: the stored value and the API value. */
  value: string
  ko: string
  en: string
}

/** The 25 languages supported by Muse Voice Transcribe `languageBias`. */
export const SUPPORTED_LANGUAGES = [
  { value: 'Arabic', ko: '아랍어', en: 'Arabic' },
  { value: 'Bengali', ko: '벵골어', en: 'Bengali' },
  { value: 'Dutch', ko: '네덜란드어', en: 'Dutch' },
  { value: 'English', ko: '영어', en: 'English' },
  { value: 'French', ko: '프랑스어', en: 'French' },
  { value: 'German', ko: '독일어', en: 'German' },
  { value: 'Hebrew', ko: '히브리어', en: 'Hebrew' },
  { value: 'Hindi', ko: '힌디어', en: 'Hindi' },
  { value: 'Indonesian', ko: '인도네시아어', en: 'Indonesian' },
  { value: 'Italian', ko: '이탈리아어', en: 'Italian' },
  { value: 'Japanese', ko: '일본어', en: 'Japanese' },
  { value: 'Kannada', ko: '칸나다어', en: 'Kannada' },
  { value: 'Korean', ko: '한국어', en: 'Korean' },
  { value: 'Malay', ko: '말레이어', en: 'Malay' },
  { value: 'Mandarin Chinese', ko: '중국어(보통화)', en: 'Mandarin Chinese' },
  { value: 'Marathi', ko: '마라티어', en: 'Marathi' },
  { value: 'Polish', ko: '폴란드어', en: 'Polish' },
  { value: 'Portuguese', ko: '포르투갈어', en: 'Portuguese' },
  { value: 'Spanish', ko: '스페인어', en: 'Spanish' },
  { value: 'Tagalog', ko: '타갈로그어', en: 'Tagalog' },
  { value: 'Tamil', ko: '타밀어', en: 'Tamil' },
  { value: 'Telugu', ko: '텔루구어', en: 'Telugu' },
  { value: 'Thai', ko: '태국어', en: 'Thai' },
  { value: 'Turkish', ko: '튀르키예어', en: 'Turkish' },
  { value: 'Vietnamese', ko: '베트남어', en: 'Vietnamese' },
] as const satisfies readonly SupportedLanguage[]

/** One of the 25 supported language names. */
export type LanguageValue = (typeof SUPPORTED_LANGUAGES)[number]['value']

/**
 * Per-note transcription language: 'default' = Korean+English bias,
 * 'auto' = no bias key (auto-detect), or one of the 25 names.
 */
export type LectureLanguage = 'default' | 'auto' | LanguageValue

/** Per-note AI output language: 'app' = follow the app language, or a name. */
export type NoteLanguage = 'app' | LanguageValue

const VALUE_SET: ReadonlySet<string> = new Set(SUPPORTED_LANGUAGES.map((l) => l.value))

export function isLanguageValue(value: unknown): value is LanguageValue {
  return typeof value === 'string' && VALUE_SET.has(value)
}

export function isLectureLanguage(value: unknown): value is LectureLanguage {
  return value === 'default' || value === 'auto' || isLanguageValue(value)
}

export function isNoteLanguage(value: unknown): value is NoteLanguage {
  return value === 'app' || isLanguageValue(value)
}

/** Display label of a supported language in the UI language ('베트남어' / 'Vietnamese'). */
export function languageLabel(value: string, uiLang: AppLanguage): string {
  const found = SUPPORTED_LANGUAGES.find((l) => l.value === value)
  if (!found) return value
  return uiLang === 'en' ? found.en : found.ko
}

/**
 * The `languageBias` list for a transcription request, or null to omit the
 * key entirely (auto-detect). A single non-English language keeps English as
 * a second bias because lectures often mix in English terms.
 */
export function lectureLanguageBias(lectureLanguage: LectureLanguage): string[] | null {
  if (lectureLanguage === 'auto') return null
  if (lectureLanguage === 'default') return ['Korean', 'English']
  if (lectureLanguage === 'English') return ['English']
  return [lectureLanguage, 'English']
}

/**
 * Resolved AI output language NAME ('Korean', 'English', 'Vietnamese', ...):
 * 'app' follows the UI language, anything else is used as stored.
 */
export function resolveOutputLanguage(noteLanguage: string, uiLang: AppLanguage): string {
  if (noteLanguage === 'app') return uiLang === 'en' ? 'English' : 'Korean'
  return noteLanguage
}

/**
 * Normalizes a prompt-language argument to a language name: legacy call sites
 * pass the AppLanguage ('ko'/'en'), new ones pass the resolved name.
 */
export function outputLanguageName(language: AppLanguage | string): string {
  if (language === 'ko') return 'Korean'
  if (language === 'en') return 'English'
  return language
}
