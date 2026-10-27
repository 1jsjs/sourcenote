import type { AppLanguage } from '../src/shared/types'
import { loadSettings } from '../src/main/settings'
import { settingsFilePath } from '../src/main/paths'

/**
 * Shared `--lang ko|en` handling for the headless CLIs. An explicit flag
 * wins; otherwise the saved app setting applies, else Korean.
 */

/** Splits `--lang <ko|en>` out of argv; exits on an invalid value. */
export function parseLangArg(argv: string[]): { lang: AppLanguage | null; rest: string[] } {
  let lang: AppLanguage | null = null
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--lang') {
      const value = argv[++i]
      if (value !== 'ko' && value !== 'en') {
        console.error('사용법: --lang ko|en (Usage: --lang ko|en)')
        process.exit(1)
      }
      lang = value
    } else {
      rest.push(argv[i])
    }
  }
  return { lang, rest }
}

/** Explicit flag, else the saved setting, else Korean. */
export function resolveCliLanguage(explicit: AppLanguage | null, dataDir: string): AppLanguage {
  if (explicit !== null) return explicit
  return loadSettings(settingsFilePath(dataDir)).language
}
