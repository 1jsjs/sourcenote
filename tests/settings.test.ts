import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadSettings, parseSettings, saveSettings } from '../src/main/settings'

describe('settings', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-settings-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('defaults to Korean', () => {
    expect(parseSettings(undefined)).toEqual({ language: 'ko' })
    expect(parseSettings(null)).toEqual({ language: 'ko' })
    expect(parseSettings({})).toEqual({ language: 'ko' })
    expect(parseSettings({ language: 'fr' })).toEqual({ language: 'ko' })
  })

  it('parses a valid language', () => {
    expect(parseSettings({ language: 'en' })).toEqual({ language: 'en' })
    expect(parseSettings({ language: 'ko', extra: true })).toEqual({ language: 'ko' })
  })

  it('loads defaults for a missing or corrupt file', () => {
    expect(loadSettings(path.join(dir, 'settings.json'))).toEqual({ language: 'ko' })
    const corrupt = path.join(dir, 'corrupt.json')
    fs.writeFileSync(corrupt, '{not json', 'utf8')
    expect(loadSettings(corrupt)).toEqual({ language: 'ko' })
    const wrongShape = path.join(dir, 'shape.json')
    fs.writeFileSync(wrongShape, '[1,2]', 'utf8')
    expect(loadSettings(wrongShape)).toEqual({ language: 'ko' })
  })

  it('round-trips through save and load', () => {
    const file = path.join(dir, 'settings.json')
    expect(saveSettings(file, { language: 'en' })).toEqual({ language: 'en' })
    expect(loadSettings(file)).toEqual({ language: 'en' })
    expect(saveSettings(file, { language: 'ko' })).toEqual({ language: 'ko' })
    expect(loadSettings(file)).toEqual({ language: 'ko' })
  })
})
