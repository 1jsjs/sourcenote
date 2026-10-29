import { execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'
import type { ApiKeySource, AppLanguage } from '../shared/types'

const execFileAsync = promisify(execFile)

const KEYCHAIN_SERVICE = 'sourcenote-meta-api'

let cachedKeychainKey: string | null = null
let readStoredKey: () => Promise<string | null> = async () => null

/** The app wires this to the key saved from the settings dialog (key-store.ts). */
export function setStoredKeyReader(reader: () => Promise<string | null>): void {
  readStoredKey = reader
}

function envKey(): string | null {
  const key = process.env.SOURCENOTE_META_API_KEY?.trim()
  return key ? key : null
}

async function keychainKey(): Promise<string | null> {
  if (cachedKeychainKey) return cachedKeychainKey
  if (process.platform !== 'darwin') return null
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-a', os.userInfo().username, '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: 15000, maxBuffer: 64 * 1024 },
    )
    const key = stdout.trim()
    if (key.length === 0) return null
    cachedKeychainKey = key
    return key
  } catch {
    // Never surface the underlying error output; it must not leak key material.
    return null
  }
}

/**
 * Reads the Meta API key. Priority:
 *   1. SOURCENOTE_META_API_KEY env var (CI / developer override)
 *   2. the key saved in the app (encrypted with safeStorage)
 *   3. macOS keychain item sourcenote-meta-api (developer setup)
 *
 * The key is never logged, persisted in plain text, or sent anywhere except
 * the api.meta.ai Authorization header.
 */
export async function getMetaApiKey(lang: AppLanguage = 'ko'): Promise<string> {
  const key = envKey() ?? (await readStoredKey()) ?? (await keychainKey())
  if (key) return key
  throw new Error(
    lang === 'en'
      ? 'No Meta API key yet. Add one under "API key" at the top right.'
      : 'Meta API 키가 없습니다. 오른쪽 위 "API 키"에서 키를 넣어 주세요.',
  )
}

/** Where the key in use comes from, without exposing the key itself. */
export async function getApiKeySource(): Promise<ApiKeySource> {
  if (envKey()) return 'env'
  if (await readStoredKey()) return 'saved'
  if (await keychainKey()) return 'keychain'
  return 'none'
}

/** Test-only: clears the in-memory keychain cache. */
export function clearCachedApiKeyForTests(): void {
  cachedKeychainKey = null
}
