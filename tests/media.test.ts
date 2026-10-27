import { describe, expect, it } from 'vitest'
import {
  mediaContentTypeForPath,
  parseMediaSourceUrl,
  parseRangeHeader,
} from '../src/main/media'

describe('parseRangeHeader', () => {
  it('parses an open-ended range (bytes=0-)', () => {
    expect(parseRangeHeader('bytes=0-', 1000)).toEqual({ start: 0, end: 999 })
  })

  it('parses a closed range (bytes=100-199)', () => {
    expect(parseRangeHeader('bytes=100-199', 1000)).toEqual({ start: 100, end: 199 })
  })

  it('clamps the end past the file size', () => {
    expect(parseRangeHeader('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 })
  })

  it('parses a suffix range (bytes=-500)', () => {
    expect(parseRangeHeader('bytes=-500', 1000)).toEqual({ start: 500, end: 999 })
  })

  it('serves the whole file when the suffix covers it', () => {
    expect(parseRangeHeader('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 })
  })

  it('reports unsatisfiable when the start is past the file', () => {
    expect(parseRangeHeader('bytes=1000-', 1000)).toBe('unsatisfiable')
    expect(parseRangeHeader('bytes=5000-6000', 1000)).toBe('unsatisfiable')
  })

  it('returns null for malformed headers', () => {
    expect(parseRangeHeader('100-200', 1000)).toBeNull()
    expect(parseRangeHeader('items=0-100', 1000)).toBeNull()
    expect(parseRangeHeader('bytes=', 1000)).toBeNull()
    expect(parseRangeHeader('bytes=abc-def', 1000)).toBeNull()
    expect(parseRangeHeader('bytes=200-100', 1000)).toBeNull()
    expect(parseRangeHeader('bytes=0-10, 20-30', 1000)).toBeNull()
    expect(parseRangeHeader('bytes=-0', 1000)).toBeNull()
    expect(parseRangeHeader('bytes=-', 1000)).toBeNull()
  })
})

describe('mediaContentTypeForPath', () => {
  it('maps audio, video and pdf extensions', () => {
    expect(mediaContentTypeForPath('/a/lec.wav')).toBe('audio/wav')
    expect(mediaContentTypeForPath('/a/lec.mp3')).toBe('audio/mpeg')
    expect(mediaContentTypeForPath('/a/lec.m4a')).toBe('audio/mp4')
    expect(mediaContentTypeForPath('/a/lec.aac')).toBe('audio/aac')
    expect(mediaContentTypeForPath('/a/lec.flac')).toBe('audio/flac')
    expect(mediaContentTypeForPath('/a/lec.ogg')).toBe('audio/ogg')
    expect(mediaContentTypeForPath('/a/lec.webm')).toBe('audio/webm')
    expect(mediaContentTypeForPath('/a/lec.mp4')).toBe('video/mp4')
    expect(mediaContentTypeForPath('/a/lec.mov')).toBe('video/quicktime')
    expect(mediaContentTypeForPath('/a/slides.pdf')).toBe('application/pdf')
  })

  it('is case-insensitive and falls back to octet-stream', () => {
    expect(mediaContentTypeForPath('/a/LEC.MP3')).toBe('audio/mpeg')
    expect(mediaContentTypeForPath('/a/file.unknown')).toBe('application/octet-stream')
    expect(mediaContentTypeForPath('/a/noext')).toBe('application/octet-stream')
  })
})

describe('parseMediaSourceUrl', () => {
  it('extracts the source id from sourcenote-media URLs', () => {
    expect(parseMediaSourceUrl('sourcenote-media://source/3')).toBe(3)
  })

  it('rejects other shapes', () => {
    expect(parseMediaSourceUrl('sourcenote-media://source/')).toBeNull()
    expect(parseMediaSourceUrl('sourcenote-media://source/abc')).toBeNull()
    expect(parseMediaSourceUrl('sourcenote-media://other/3')).toBeNull()
    expect(parseMediaSourceUrl('https://example.com/3')).toBeNull()
    expect(parseMediaSourceUrl('not a url')).toBeNull()
  })
})
