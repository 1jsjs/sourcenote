import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import ffmpegStatic from 'ffmpeg-static'

const execFileAsync = promisify(execFile)

/**
 * Audio preparation for the transcribe API: probe duration, then convert to
 * 16 kHz mono s16 PCM WAV chunks of at most CHUNK_MS. Chunk boundaries are
 * planned by the pure planChunks().
 *
 * Windows/Linux use the bundled ffmpeg with explicit -ss/-t per chunk. macOS
 * uses the system afconvert instead (the macOS ffmpeg-static build includes
 * non-free parts and may not be redistributed): the whole file is decoded to
 * one WAV once, its exact length is the duration, and chunks are byte slices.
 */

/** macOS decodes with the system afconvert instead of a bundled ffmpeg. */
export const USE_AFCONVERT = process.platform === 'darwin'

const AFCONVERT = '/usr/bin/afconvert'

/** 16 kHz mono s16: 32 bytes of PCM per millisecond. */
const PCM_BYTES_PER_MS = 32

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
  if (USE_AFCONVERT) {
    const wav = await decodeWholeFile(filePath)
    return pcmBytesToMs(readWavData(wav).dataBytes)
  }
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
  if (USE_AFCONVERT) {
    const wav = await decodeWholeFile(inputPath)
    try {
      return splitWav(wav, outDir, plans)
    } finally {
      fs.rmSync(wav, { force: true })
      decodedWavs.delete(inputPath)
    }
  }
  const outputs: string[] = []
  for (const plan of plans) {
    const out = path.join(outDir, chunkFileName(plan.index))
    await convertChunk(inputPath, out, plan.offsetMs, plan.durationMs, ffmpegPath)
    outputs.push(out)
  }
  return outputs
}

// ---- macOS: afconvert decode + WAV slicing ----

/** Decoded WAV per input path, shared by the duration probe and the split. */
const decodedWavs = new Map<string, string>()

function pcmBytesToMs(bytes: number): number {
  return Math.round(bytes / PCM_BYTES_PER_MS)
}

function msToPcmBytes(ms: number): number {
  // Whole 16-bit samples only.
  return Math.round(ms * 16) * 2
}

/** Decodes the whole input to one 16 kHz mono s16 WAV in the temp dir (cached). */
async function decodeWholeFile(inputPath: string): Promise<string> {
  const cached = decodedWavs.get(inputPath)
  if (cached && fs.existsSync(cached)) return cached
  const out = path.join(
    os.tmpdir(),
    `sourcenote-decode-${process.pid}-${Math.random().toString(36).slice(2)}.wav`,
  )
  try {
    await execFileAsync(AFCONVERT, ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', inputPath, out], {
      timeout: 30 * 60 * 1000,
      maxBuffer: 4 * 1024 * 1024,
    })
  } catch {
    fs.rmSync(out, { force: true })
    throw new Error(
      `오디오를 읽지 못했습니다 (${path.basename(inputPath)}). m4a·mp3·wav 파일로 바꿔 넣어 주세요.`,
    )
  }
  decodedWavs.set(inputPath, out)
  return out
}

/** Byte offset and length of the PCM `data` chunk, walking the RIFF chunks. */
export function findWavData(
  head: Buffer,
  fileSize: number,
): { dataOffset: number; dataBytes: number } | null {
  if (head.length < 12 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
    return null
  }
  let pos = 12
  while (pos + 8 <= head.length) {
    const id = head.toString('ascii', pos, pos + 4)
    const size = head.readUInt32LE(pos + 4)
    if (id === 'data') {
      const dataOffset = pos + 8
      return { dataOffset, dataBytes: Math.min(size, fileSize - dataOffset) }
    }
    pos += 8 + size + (size % 2)
  }
  return null
}

function readWavData(wavPath: string): { dataOffset: number; dataBytes: number } {
  const fd = fs.openSync(wavPath, 'r')
  try {
    const head = Buffer.alloc(64 * 1024)
    const read = fs.readSync(fd, head, 0, head.length, 0)
    const found = findWavData(head.subarray(0, read), fs.fstatSync(fd).size)
    if (!found) throw new Error(`변환된 오디오를 읽지 못했습니다: ${path.basename(wavPath)}`)
    return found
  } finally {
    fs.closeSync(fd)
  }
}

/** 44-byte header for 16 kHz mono s16 PCM. */
export function pcmWavHeader(dataBytes: number): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + dataBytes, 4)
  h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(1, 22) // mono
  h.writeUInt32LE(16000, 24)
  h.writeUInt32LE(16000 * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(dataBytes, 40)
  return h
}

/** Writes each planned chunk as a byte slice of the decoded WAV. */
export function splitWav(wavPath: string, outDir: string, plans: ChunkPlan[]): string[] {
  const { dataOffset, dataBytes } = readWavData(wavPath)
  const fd = fs.openSync(wavPath, 'r')
  try {
    return plans.map((plan) => {
      const start = Math.min(msToPcmBytes(plan.offsetMs), dataBytes)
      const end = Math.min(msToPcmBytes(plan.offsetMs + plan.durationMs), dataBytes)
      const pcm = Buffer.alloc(end - start)
      fs.readSync(fd, pcm, 0, pcm.length, dataOffset + start)
      const out = path.join(outDir, chunkFileName(plan.index))
      fs.writeFileSync(out, Buffer.concat([pcmWavHeader(pcm.length), pcm]))
      return out
    })
  } finally {
    fs.closeSync(fd)
  }
}
