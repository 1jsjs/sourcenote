import type { AppLanguage } from '../shared/types'

/**
 * Main-process user-facing messages: Korean is the default, English is
 * selected by the current app language. Only common messages shown in the
 * UI get variants; rarer internal errors stay Korean-only.
 */

/** Picks the message for the current language (ko default). */
export function langMsg(lang: AppLanguage, ko: string, en: string): string {
  return lang === 'en' ? en : ko
}
