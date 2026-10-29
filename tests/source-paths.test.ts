import { describe, expect, it } from 'vitest'
import { audioExtensionsFor, classifyPaths } from '../src/main/source-paths'

describe('classifyPaths', () => {
  it('routes audio extensions to audio', () => {
    const paths = ['/a/lecture.wav', '/a/talk.MP3', '/a/vid.m4a', '/a/x.webm']
    const result = classifyPaths(paths, audioExtensionsFor('win32'))
    expect(result.audio).toEqual(paths)
    expect(result.pdf).toEqual([])
    expect(result.ignored).toEqual([])
  })

  it('ignores WebM on macOS, where afconvert cannot read it', () => {
    const result = classifyPaths(['/a/x.webm', '/a/y.m4a'], audioExtensionsFor('darwin'))
    expect(result.audio).toEqual(['/a/y.m4a'])
    expect(result.ignored).toEqual(['/a/x.webm'])
  })

  it('routes pdf (any case) to pdf', () => {
    const result = classifyPaths(['/a/slides.pdf', '/a/DECK.PDF'])
    expect(result.pdf).toEqual(['/a/slides.pdf', '/a/DECK.PDF'])
    expect(result.audio).toEqual([])
    expect(result.ignored).toEqual([])
  })

  it('ignores anything else, including extensionless paths', () => {
    const result = classifyPaths(['/a/notes.txt', '/a/photo.png', '/a/Makefile', '/a/archive.zip'])
    expect(result.audio).toEqual([])
    expect(result.pdf).toEqual([])
    expect(result.ignored).toEqual(['/a/notes.txt', '/a/photo.png', '/a/Makefile', '/a/archive.zip'])
  })

  it('splits a mixed drop preserving order within each group', () => {
    const result = classifyPaths(['/a/b.doc', '/a/l.mp3', '/a/s.pdf', '/a/m.mov'])
    expect(result.audio).toEqual(['/a/l.mp3', '/a/m.mov'])
    expect(result.pdf).toEqual(['/a/s.pdf'])
    expect(result.ignored).toEqual(['/a/b.doc'])
  })

  it('handles an empty list', () => {
    expect(classifyPaths([])).toEqual({ audio: [], pdf: [], ignored: [] })
  })
})
