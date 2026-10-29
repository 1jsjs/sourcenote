import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Data directory resolution. This module must stay free of Electron imports so
 * the same code works in the headless CLI. The Electron entry point sets
 * process.env.SOURCENOTE_DATA_DIR to app.getPath('userData') before any other
 * module reads it.
 */
export function getDataDir(): string {
  const env = process.env.SOURCENOTE_DATA_DIR
  if (env && env.trim().length > 0) return path.resolve(env)
  return path.join(os.homedir(), 'Library', 'Application Support', 'sourcenote')
}

export function ensureDataDir(dir: string = getDataDir()): string {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function dbFilePath(dataDir: string = getDataDir()): string {
  return path.join(dataDir, 'sourcenote.sqlite')
}

export function ledgerFilePath(dataDir: string = getDataDir()): string {
  return path.join(dataDir, 'usage-ledger.json')
}

export function mediaDirPath(dataDir: string = getDataDir()): string {
  return path.join(dataDir, 'media')
}

export function settingsFilePath(dataDir: string = getDataDir()): string {
  return path.join(dataDir, 'settings.json')
}

/** The Meta API key typed into the app, encrypted with safeStorage. */
export function apiKeyFilePath(dataDir: string = getDataDir()): string {
  return path.join(dataDir, 'api-key.bin')
}
