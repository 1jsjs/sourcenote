import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import ffmpegStatic from 'ffmpeg-static'

const execFileAsync = promisify(execFile)

/**
 * Audio preparation for the transcribe API: probe duration, then convert to
 * 16 kHz mono s16 PCM WAV chunks of at most CHUNK_MS. Chunk boundaries are
 * planned by the pure planChunks() and each chunk is produced with explicit
 * -ss/-t so the API offsets map exactly onto the source timeline.
 */

/** 9m30s — safety margin under the API's 10 minute per-call limit. */
export const CHUNK_MS = 570_000

/** Tails shorter than this are merged into the previous chunk. */
export const MIN_TAIL_MS = 5_000

export interface ChunkPlan {
  index: number
  offsetMs: number
  durationMs: number
}

/** Pure chunk planning: consecutive non-overlapping chunks covering [0, durationMs). */
export function planChunks(durationMs: number, chunkMs: number = CHUNK_MS): ChunkPlan[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return []
  const plans: ChunkPlan[] = []
  let offset = 0
  let index = 0
  while (offset < durationMs) {
    let duration = Math.min(chunkMs, durationMs - offset)
    // Fold a tiny tail into this chunk instead of sending a near-empty one
    // (stays under the 10 minute limit: at most chunkMs + MIN_TAIL_MS).
    if (durationMs - offset - duration < MIN_TAIL_MS) duration = durationMs - offset
    plans.push({ index, offsetMs: offset, durationMs: duration })
    offset += duration
    index++
  }
  return plans
}

/**
 * ffmpeg-static binary, falling back to `ffmpeg` on PATH. In a packaged app the
 * module resolves inside app.asar, but the binary is unpacked next to it
 * (electron-builder `asarUnpack`), since a process cannot be spawned from asar.
 */
export function resolveFfmpegPath(): string {
  if (typeof ffmpegStatic === 'string' && ffmpegStatic.length > 0) {
    const unpacked = ffmpegStatic.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
    if (fs.existsSync(unpacked)) return unpacked
  }
  return 'ffmpeg'
}

/** Parses "Duration: HH:MM:SS.cc" from ffmpeg stderr. Returns ms or null. */
export function parseFfmpegDuration(stderr: string): number | null {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  if (!m) return null
  const hours = Number(m[1])
  const minutes = Number(m[2])
  const seconds = Number(m[3])
  return Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000)
}

/**
 * Duration of a media file in ms. `ffmpeg -i` exits non-zero without an
 * output file, so the Duration line is read from the failure's stderr too.
 */
export async function getAudioDurationMs(
  filePath: string,
  ffmpegPath: string = resolveFfmpegPath(),
): Promise<number> {
  let stderr = ''
  try {
    const res = await execFileAsync(ffmpegPath, ['-hide_banner', '-i', filePath], {
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    stderr = res.stderr
  } catch (err) {
    stderr = (err as { stderr?: string }).stderr ?? ''
  }
  const ms = parseFfmpegDuration(stderr)
  if (ms === null || ms <= 0) {
    throw new Error(`오디오 길이를 확인할 수 없습니다: ${path.basename(filePath)}`)
  }
  return ms
}

/** ffmpeg args for one chunk: explicit -ss/-t before -i, 16 kHz mono s16 WAV. */
export function buildChunkArgs(
  inputPath: string,
  outputPath: string,
  offsetMs: number,
  durationMs: number,
): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    (offsetMs / 1000).toFixed(3),
    '-t',
    (durationMs / 1000).toFixed(3),
    '-i',
    inputPath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-sample_fmt',
    's16',
    '-f',
    'wav',
    outputPath,
  ]
}

export function chunkFileName(index: number): string {
  return `chunk_${String(index).padStart(3, '0')}.wav`
}

/** Converts one chunk; returns the output path. */
export async function convertChunk(
  inputPath: string,
  outputPath: string,
  offsetMs: number,
  durationMs: number,
  ffmpegPath: string = resolveFfmpegPath(),
): Promise<string> {
  const args = buildChunkArgs(inputPath, outputPath, offsetMs, durationMs)
  try {
    await execFileAsync(ffmpegPath, args, { timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 })
  } catch (err) {
    const stderr = ((err as { stderr?: string }).stderr ?? '').slice(0, 500)
    throw new Error(`오디오 변환 실패 (${path.basename(outputPath)}): ${stderr || 'ffmpeg 오류'}`)
  }
  return outputPath
}

/** Converts all planned chunks into outDir; returns chunk paths in order. */
export async function convertToChunks(
  inputPath: string,
  outDir: string,
  plans: ChunkPlan[],
  ffmpegPath: string = resolveFfmpegPath(),
): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true })
  const outputs: string[] = []
  for (const plan of plans) {
    const out = path.join(outDir, chunkFileName(plan.index))
    await convertChunk(inputPath, out, plan.offsetMs, plan.durationMs, ffmpegPath)
    outputs.push(out)
  }
  return outputs
}
