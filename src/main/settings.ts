import fs from 'node:fs'
import path from 'node:path'
import { type AppSettings, isAppLanguage } from '../shared/types'

/**
 * App settings persisted as `settings.json` in the data dir. Pure
 * load/parse/save helpers (unit-tested); the Electron entry point wires
 * them to IPC. A missing or corrupt file falls back to defaults.
 */

export const DEFAULT_SETTINGS: AppSettings = { language: 'ko' }

/** Parses unknown JSON content into settings; anything invalid -> defaults. */
export function parseSettings(raw: unknown): AppSettings {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_SETTINGS }
  }
  const obj = raw as Record<string, unknown>
  return { language: isAppLanguage(obj.language) ? obj.language : 'ko' }
}

/** Loads settings from a file; missing/corrupt file -> defaults. */
export function loadSettings(filePath: string): AppSettings {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
  try {
    return parseSettings(JSON.parse(raw) as unknown)
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/** Saves settings atomically (temp file + rename), like the usage ledger. */
export function saveSettings(filePath: string, settings: AppSettings): AppSettings {
  const normalized = parseSettings(settings)
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(
    dir,
    `settings-${process.pid}-${Math.random().toString(36).slice(2)}.json.tmp`,
  )
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), 'utf8')
  fs.renameSync(tmp, filePath)
  return normalized
}
