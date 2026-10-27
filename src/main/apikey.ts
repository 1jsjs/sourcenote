import { execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const KEYCHAIN_SERVICE = 'sourcenote-meta-api'

let cachedKey: string | null = null

/**
 * Reads the Meta API key. Priority:
 *   1. SOURCENOTE_META_API_KEY env var (CI / non-macOS override)
 *   2. macOS keychain: security find-generic-password -a <user> -s sourcenote-meta-api -w
 *
 * The key is cached in memory only and is never logged, persisted by us, or
 * sent anywhere except the api.meta.ai Authorization header.
 */
export async function getMetaApiKey(): Promise<string> {
  const envKey = process.env.SOURCENOTE_META_API_KEY
  if (envKey && envKey.trim().length > 0) return envKey.trim()

  if (cachedKey) return cachedKey

  if (process.platform !== 'darwin') {
    throw new Error(
      'Meta API 키를 찾을 수 없습니다. SOURCENOTE_META_API_KEY 환경 변수를 설정하세요.',
    )
  }

  const username = os.userInfo().username
  let stdout: string
  try {
    const result = await execFileAsync(
      'security',
      ['find-generic-password', '-a', username, '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: 15000, maxBuffer: 64 * 1024 },
    )
    stdout = result.stdout
  } catch {
    // Never include the underlying error output here; it must not leak key material.
    throw new Error(
      'macOS 키체인에서 Meta API 키를 찾을 수 없습니다. ' +
        'security add-generic-password -a "$USER" -s sourcenote-meta-api -w 로 등록하세요.',
    )
  }

  const key = stdout.trim()
  if (key.length === 0) {
    throw new Error('키체인의 Meta API 키 항목이 비어 있습니다. 키를 다시 등록하세요.')
  }
  cachedKey = key
  return key
}

/** Test-only: clears the in-memory cache. */
export function clearCachedApiKeyForTests(): void {
  cachedKey = null
}
