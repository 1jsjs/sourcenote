import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearCachedApiKeyForTests, getApiKeySource, getMetaApiKey, setStoredKeyReader } from '../src/main/apikey'
import {
  clearApiKey,
  type KeyCipher,
  KeyStoreError,
  loadApiKey,
  normalizeApiKey,
  saveApiKey,
} from '../src/main/key-store'

// Reversible stand-in for safeStorage: enough to prove the file never holds the plain key.
const cipher: KeyCipher = {
  isAvailable: async () => true,
  encrypt: async (plain) => Buffer.from(plain, 'utf8').map((b) => b ^ 0x5a) as Buffer,
  decrypt: async (enc) => Buffer.from(enc.map((b) => b ^ 0x5a)).toString('utf8'),
}

let dir: string
let file: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-key-'))
  file = path.join(dir, 'api-key.bin')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('key store', () => {
  it('round-trips a key without writing it in plain text', async () => {
    await saveApiKey(file, cipher, '  test-key-123  ')
    expect(fs.readFileSync(file).includes(Buffer.from('test-key-123'))).toBe(false)
    expect(await loadApiKey(file, cipher)).toBe('test-key-123')
    clearApiKey(file)
    expect(await loadApiKey(file, cipher)).toBeNull()
  })

  it('rejects empty and multi-line pastes', () => {
    expect(() => normalizeApiKey('   ')).toThrow(KeyStoreError)
    expect(() => normalizeApiKey('abc\ndef')).toThrow(KeyStoreError)
    expect(() => normalizeApiKey('abc def')).toThrow(KeyStoreError)
    expect(() => normalizeApiKey(42)).toThrow(KeyStoreError)
  })

  it('refuses to save when encryption is unavailable', async () => {
    const off: KeyCipher = { ...cipher, isAvailable: async () => false }
    await expect(saveApiKey(file, off, 'k')).rejects.toThrow(KeyStoreError)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('treats an undecryptable file as no key', async () => {
    fs.writeFileSync(file, Buffer.from('garbage'))
    const broken: KeyCipher = {
      ...cipher,
      decrypt: async () => {
        throw new Error('bad')
      },
    }
    expect(await loadApiKey(file, broken)).toBeNull()
  })
})

describe('api key priority', () => {
  const savedEnv = process.env.SOURCENOTE_META_API_KEY
  const savedPlatform = process.platform

  beforeEach(() => {
    delete process.env.SOURCENOTE_META_API_KEY
    clearCachedApiKeyForTests()
    // Keep the real keychain out of the test.
    Object.defineProperty(process, 'platform', { value: 'linux' })
  })

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.SOURCENOTE_META_API_KEY
    else process.env.SOURCENOTE_META_API_KEY = savedEnv
    Object.defineProperty(process, 'platform', { value: savedPlatform })
    setStoredKeyReader(async () => null)
  })

  it('uses the saved key, and the env var over it', async () => {
    setStoredKeyReader(async () => 'saved-key')
    expect(await getMetaApiKey()).toBe('saved-key')
    expect(await getApiKeySource()).toBe('saved')
    process.env.SOURCENOTE_META_API_KEY = 'env-key'
    expect(await getMetaApiKey()).toBe('env-key')
    expect(await getApiKeySource()).toBe('env')
  })

  it('points to the API key dialog when no key exists', async () => {
    expect(await getApiKeySource()).toBe('none')
    await expect(getMetaApiKey('ko')).rejects.toThrow('API 키')
    await expect(getMetaApiKey('en')).rejects.toThrow('API key')
  })
})
