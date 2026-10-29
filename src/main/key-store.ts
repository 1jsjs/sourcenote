import fs from 'node:fs'
import path from 'node:path'

/**
 * The Meta API key the user typed into the app, kept encrypted on disk.
 * Encryption is injected (Electron's safeStorage in the app: the macOS
 * keychain or Windows DPAPI holds the encryption key) so this module stays
 * free of Electron imports and is unit-testable. The plain key is never
 * written, logged, or returned to the renderer.
 */

export interface KeyCipher {
  isAvailable(): Promise<boolean>
  encrypt(plain: string): Promise<Buffer>
  decrypt(encrypted: Buffer): Promise<string>
}

export class KeyStoreError extends Error {
  constructor(public readonly code: 'empty' | 'invalid' | 'unavailable') {
    super(code)
    this.name = 'KeyStoreError'
  }
}

/** Trims pasted whitespace; a key with inner whitespace or control chars is a bad paste. */
export function normalizeApiKey(raw: unknown): string {
  if (typeof raw !== 'string') throw new KeyStoreError('invalid')
  const key = raw.trim()
  if (key.length === 0) throw new KeyStoreError('empty')
  if (key.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(key)) throw new KeyStoreError('invalid')
  return key
}

/** Encrypts and saves the key atomically (temp file + rename). */
export async function saveApiKey(filePath: string, cipher: KeyCipher, raw: unknown): Promise<void> {
  const key = normalizeApiKey(raw)
  if (!(await cipher.isAvailable())) throw new KeyStoreError('unavailable')
  const encrypted = await cipher.encrypt(key)
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `api-key-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`)
  fs.writeFileSync(tmp, encrypted, { mode: 0o600 })
  fs.renameSync(tmp, filePath)
}

/** The saved key, or null when none is saved or it can no longer be decrypted. */
export async function loadApiKey(filePath: string, cipher: KeyCipher): Promise<string | null> {
  let encrypted: Buffer
  try {
    encrypted = fs.readFileSync(filePath)
  } catch {
    return null
  }
  if (encrypted.length === 0) return null
  try {
    if (!(await cipher.isAvailable())) return null
    const key = (await cipher.decrypt(encrypted)).trim()
    return key.length > 0 ? key : null
  } catch {
    return null
  }
}

export function clearApiKey(filePath: string): void {
  fs.rmSync(filePath, { force: true })
}
