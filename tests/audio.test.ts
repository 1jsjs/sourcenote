import { describe, expect, it } from 'vitest'
import {
  buildChunkArgs,
  CHUNK_MS,
  chunkFileName,
  parseFfmpegDuration,
  planChunks,
} from '../src/main/audio'

describe('planChunks', () => {
  it('37 s lecture -> a single chunk', () => {
    const plans = planChunks(37_000)
    expect(plans).toEqual([{ index: 0, offsetMs: 0, durationMs: 37_000 }])
  })

  it('570 s (exactly one chunk) -> a single full chunk', () => {
    const plans = planChunks(570_000)
    expect(plans).toEqual([{ index: 0, offsetMs: 0, durationMs: CHUNK_MS }])
  })

  it('570 s + 1 ms -> tiny tail folded into one chunk', () => {
    expect(planChunks(570_001)).toEqual([{ index: 0, offsetMs: 0, durationMs: 570_001 }])
  })

  it('tail of 5 s or more stays a separate chunk', () => {
    const plans = planChunks(575_000)
    expect(plans).toHaveLength(2)
    expect(plans[1]).toEqual({ index: 1, offsetMs: 570_000, durationMs: 5_000 })
  })

  it('folded chunk stays under the 10 minute API limit', () => {
    for (const p of planChunks(570_000 * 3 + 4_999)) expect(p.durationMs).toBeLessThan(600_000)
  })

  it('1500 s -> three chunks (570 + 570 + 360)', () => {
    const plans = planChunks(1_500_000)
    expect(plans).toEqual([
      { index: 0, offsetMs: 0, durationMs: 570_000 },
      { index: 1, offsetMs: 570_000, durationMs: 570_000 },
      { index: 2, offsetMs: 1_140_000, durationMs: 360_000 },
    ])
  })

  it('chunks are consecutive and cover the input exactly', () => {
    const total = 2_345_678
    const plans = planChunks(total)
    let offset = 0
    for (const p of plans) {
      expect(p.offsetMs).toBe(offset)
      expect(p.durationMs).toBeLessThanOrEqual(CHUNK_MS)
      offset += p.durationMs
    }
    expect(offset).toBe(total)
    plans.forEach((p, i) => expect(p.index).toBe(i))
  })

  it('non-positive durations produce no chunks', () => {
    expect(planChunks(0)).toEqual([])
    expect(planChunks(-5)).toEqual([])
  })

  it('respects a custom chunk size', () => {
    expect(planChunks(25_000, 10_000)).toEqual([
      { index: 0, offsetMs: 0, durationMs: 10_000 },
      { index: 1, offsetMs: 10_000, durationMs: 10_000 },
      { index: 2, offsetMs: 20_000, durationMs: 5_000 },
    ])
  })
})

describe('parseFfmpegDuration', () => {
  it('parses the Duration line from ffmpeg stderr', () => {
    const stderr =
      'Input #0, wav, from \'lecture.wav\':\n  Duration: 00:00:37.28, bitrate: 1536 kb/s\n'
    expect(parseFfmpegDuration(stderr)).toBe(37_280)
  })

  it('handles hours', () => {
    expect(parseFfmpegDuration('Duration: 01:02:03.50,')).toBe(3_723_500)
  })

  it('returns null when no Duration line exists', () => {
    expect(parseFfmpegDuration('some other output')).toBeNull()
  })
})

describe('buildChunkArgs', () => {
  it('uses explicit -ss/-t before -i and 16 kHz mono s16 WAV output', () => {
    const args = buildChunkArgs('/in/lecture.wav', '/out/chunk_001.wav', 570_000, 360_000)
    const ssAt = args.indexOf('-ss')
    const tAt = args.indexOf('-t')
    const iAt = args.indexOf('-i')
    expect(ssAt).toBeGreaterThanOrEqual(0)
    expect(tAt).toBeGreaterThan(ssAt)
    expect(iAt).toBeGreaterThan(tAt)
    expect(args[ssAt + 1]).toBe('570.000')
    expect(args[tAt + 1]).toBe('360.000')
    expect(args[iAt + 1]).toBe('/in/lecture.wav')
    expect(args).toContain('-ar')
    expect(args[args.indexOf('-ar') + 1]).toBe('16000')
    expect(args[args.indexOf('-ac') + 1]).toBe('1')
    expect(args[args.indexOf('-sample_fmt') + 1]).toBe('s16')
    expect(args[args.length - 1]).toBe('/out/chunk_001.wav')
  })
})

describe('chunkFileName', () => {
  it('zero-pads the index', () => {
    expect(chunkFileName(0)).toBe('chunk_000.wav')
    expect(chunkFileName(7)).toBe('chunk_007.wav')
    expect(chunkFileName(123)).toBe('chunk_123.wav')
  })
})
