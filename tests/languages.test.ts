import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isLectureLanguage,
  isLanguageValue,
  isNoteLanguage,
  languageLabel,
  lectureLanguageBias,
  outputLanguageName,
  resolveOutputLanguage,
  SUPPORTED_LANGUAGES,
} from '../src/shared/languages'
import { LedgerStore, TRANSCRIBE_MODEL } from '../src/main/budget'
import { checkLocateSystemPrompt, checkZeroCitationReason } from '../src/main/check-pipeline'
import { CORRECTION_SYSTEM_PROMPT, correctionSystemPrompt } from '../src/main/correction'
import {
  createNote,
  createSource,
  createSummary,
  getLatestSummary,
  getNote,
  insertPages,
  insertSegments,
  listNotePageImages,
  openDb,
  setNoteLanguages,
  setPageImagePath,
  setPageVisualText,
  updateSourceStatus,
} from '../src/main/db'
import {
  missingResultReason,
  SLIDE_TERMS_RULE,
  SUMMARY_SYSTEM_PROMPT,
  summarySystemPrompt,
  VERIFY_SYSTEM_PROMPT,
  verifySystemPrompt,
  zeroCitationReason,
} from '../src/main/grounding'
import { createMetaApi, type ChatOptions, type MetaApi, type MetaApiDeps, type TranscribeChunkOptions } from '../src/main/meta-api'
import { runAudioPipeline } from '../src/main/pipeline'
import { qaSystemPrompt } from '../src/main/qa-pipeline'
import { importSampleNote, parseSampleNote, serializeSampleNote } from '../src/main/sample'
import { readSlideVisuals, slideVisualSystemPrompt } from '../src/main/slide-vision'
import { runSummaryPipeline } from '../src/main/summary-pipeline'

/**
 * Per-note languages (migration 9): the shared language list, the DB columns
 * and setNoteLanguages, the transcription languageBias mapping, the prompt
 * builders for any output language, and the sample round-trip.
 */

describe('shared languages module', () => {
  it('lists exactly the 25 supported languages with value/ko/en labels', () => {
    expect(SUPPORTED_LANGUAGES).toHaveLength(25)
    for (const entry of SUPPORTED_LANGUAGES) {
      expect(entry.value.length).toBeGreaterThan(0)
      expect(entry.ko.length).toBeGreaterThan(0)
      expect(entry.en.length).toBeGreaterThan(0)
    }
    expect(SUPPORTED_LANGUAGES.find((l) => l.value === 'Korean')).toEqual({
      value: 'Korean',
      ko: '한국어',
      en: 'Korean',
    })
    expect(SUPPORTED_LANGUAGES.find((l) => l.value === 'Mandarin Chinese')?.ko).toBe(
      '중국어(보통화)',
    )
    expect(SUPPORTED_LANGUAGES.find((l) => l.value === 'Turkish')?.ko).toBe('튀르키예어')
  })

  it('validates lecture and note language values', () => {
    expect(isLectureLanguage('default')).toBe(true)
    expect(isLectureLanguage('auto')).toBe(true)
    expect(isLectureLanguage('Japanese')).toBe(true)
    expect(isLectureLanguage('app')).toBe(false)
    expect(isLectureLanguage('Klingon')).toBe(false)
    expect(isLectureLanguage('')).toBe(false)
    expect(isLectureLanguage(null)).toBe(false)
    expect(isNoteLanguage('app')).toBe(true)
    expect(isNoteLanguage('Vietnamese')).toBe(true)
    expect(isNoteLanguage('default')).toBe(false)
    expect(isNoteLanguage('auto')).toBe(false)
    expect(isLanguageValue('Mandarin Chinese')).toBe(true)
    expect(isLanguageValue('ko')).toBe(false)
  })

  it('labels languages in the UI language', () => {
    expect(languageLabel('Vietnamese', 'ko')).toBe('베트남어')
    expect(languageLabel('Vietnamese', 'en')).toBe('Vietnamese')
    expect(languageLabel('Japanese', 'ko')).toBe('일본어')
    expect(languageLabel('Unknown', 'ko')).toBe('Unknown')
  })

  it('maps the lecture language to a languageBias list (null = auto-detect)', () => {
    expect(lectureLanguageBias('default')).toEqual(['Korean', 'English'])
    expect(lectureLanguageBias('auto')).toBeNull()
    expect(lectureLanguageBias('English')).toEqual(['English'])
    expect(lectureLanguageBias('Japanese')).toEqual(['Japanese', 'English'])
    expect(lectureLanguageBias('Mandarin Chinese')).toEqual(['Mandarin Chinese', 'English'])
  })

  it('resolves the output language name from the note language', () => {
    expect(resolveOutputLanguage('app', 'ko')).toBe('Korean')
    expect(resolveOutputLanguage('app', 'en')).toBe('English')
    expect(resolveOutputLanguage('Vietnamese', 'ko')).toBe('Vietnamese')
    expect(outputLanguageName('ko')).toBe('Korean')
    expect(outputLanguageName('en')).toBe('English')
    expect(outputLanguageName('Thai')).toBe('Thai')
  })
})

describe('migration 9 + setNoteLanguages', () => {
  let dir: string
  let db: DatabaseSync

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-langdb-'))
    db = openDb(path.join(dir, 'test.sqlite'))
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('defaults new notes to lecture default / note app and pages to NULL visual_language', () => {
    const note = createNote(db, '노트')
    expect(note.lecture_language).toBe('default')
    expect(note.note_language).toBe('app')
    const stored = getNote(db, note.id)
    expect(stored?.lecture_language).toBe('default')
    expect(stored?.note_language).toBe('app')

    const source = createSource(db, {
      noteId: note.id,
      kind: 'pdf',
      originalPath: '/tmp/s.pdf',
      displayName: 's.pdf',
    })
    insertPages(db, source.id, [{ pageNo: 1, text: 'p1' }])
    const row = db.prepare('SELECT visual_language AS vl FROM pages').get() as { vl: string | null }
    expect(row.vl).toBeNull()
  })

  it('updates one or both languages and returns the updated note', () => {
    const note = createNote(db, 'n')
    const lectureOnly = setNoteLanguages(db, note.id, { lectureLanguage: 'Japanese' })
    expect(lectureOnly.lecture_language).toBe('Japanese')
    expect(lectureOnly.note_language).toBe('app')
    const both = setNoteLanguages(db, note.id, {
      lectureLanguage: 'auto',
      noteLanguage: 'Vietnamese',
    })
    expect(both.lecture_language).toBe('auto')
    expect(both.note_language).toBe('Vietnamese')
    const stored = getNote(db, note.id)
    expect(stored?.lecture_language).toBe('auto')
    expect(stored?.note_language).toBe('Vietnamese')
  })

  it('rejects invalid values with a localized error and writes nothing', () => {
    const note = createNote(db, 'n')
    expect(() => setNoteLanguages(db, note.id, { lectureLanguage: 'Klingon' })).toThrow(
      '지원하지 않는 강의 언어입니다.',
    )
    expect(() => setNoteLanguages(db, note.id, { noteLanguage: 'auto' })).toThrow(
      '지원하지 않는 노트 언어입니다.',
    )
    expect(() => setNoteLanguages(db, note.id, { noteLanguage: 'xx' }, 'en')).toThrow(
      'Unsupported note language.',
    )
    expect(getNote(db, note.id)?.lecture_language).toBe('default')
    expect(() => setNoteLanguages(db, 9999, { noteLanguage: 'Thai' })).toThrow(
      '노트를 찾을 수 없습니다.',
    )
  })
})

// ---------------------------------------------------------------------------
// transcription languageBias (injectable fetch, same style as transcribe.test)
// ---------------------------------------------------------------------------

const TRANSCRIBE_RESPONSE = {
  sessionId: 's',
  transcript: 't',
  audioDurationMs: 1000,
  turns: [{ turnId: 0, startMs: 0, endMs: 1000, transcript: 't' }],
}

describe('transcribeChunk languageBias', () => {
  let dir: string
  let chunkPath: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-bias-'))
    chunkPath = path.join(dir, 'chunk_000.wav')
    fs.writeFileSync(chunkPath, Buffer.from('RIFF fake wav bytes'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  async function transcribeRequestJson(
    languageBias: TranscribeChunkOptions['languageBias'] | undefined,
    passOption: boolean,
  ): Promise<Record<string, unknown>> {
    const captured: RequestInit[] = []
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      captured.push(init ?? {})
      return new Response(JSON.stringify(TRANSCRIBE_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const deps: MetaApiDeps = {
      ledger: new LedgerStore(path.join(dir, `ledger-${Math.random()}.json`)),
      getKey: async () => 'test-secret-key',
      fetchImpl,
    }
    const api = createMetaApi(deps)
    const opts: TranscribeChunkOptions = { chunkPath, chunkDurationMs: 60_000 }
    if (passOption) opts.languageBias = languageBias
    await api.transcribeChunk(opts)
    const form = captured[0].body as FormData
    const requestPart = form.get('request') as Blob
    return JSON.parse(await requestPart.text()) as Record<string, unknown>
  }

  it('sends the Korean+English bias when the option is not passed (today\'s request)', async () => {
    const json = await transcribeRequestJson(undefined, false)
    expect(json).toEqual({
      model: TRANSCRIBE_MODEL,
      audioEncoding: 'WAV',
      mode: 'ENDPOINTING',
      languageBias: ['Korean', 'English'],
    })
  })

  it('sends the explicit bias for the default mapping and single languages', async () => {
    expect(await transcribeRequestJson(['Korean', 'English'], true)).toEqual({
      model: TRANSCRIBE_MODEL,
      audioEncoding: 'WAV',
      mode: 'ENDPOINTING',
      languageBias: ['Korean', 'English'],
    })
    expect((await transcribeRequestJson(['English'], true)).languageBias).toEqual(['English'])
    expect((await transcribeRequestJson(['Japanese', 'English'], true)).languageBias).toEqual([
      'Japanese',
      'English',
    ])
  })

  it('omits the languageBias key entirely for auto-detect (null)', async () => {
    const json = await transcribeRequestJson(null, true)
    expect(json).toEqual({ model: TRANSCRIBE_MODEL, audioEncoding: 'WAV', mode: 'ENDPOINTING' })
    expect('languageBias' in json).toBe(false)
  })
})

describe('audio pipeline reads the note lecture language', () => {
  let dir: string
  let db: DatabaseSync

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-lectlang-'))
    db = openDb(path.join(dir, 'test.sqlite'))
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** Seeds a one-chunk audio note and captures the transcribeChunk options. */
  async function captureBias(lectureLanguage: string | undefined): Promise<TranscribeChunkOptions[]> {
    const note = createNote(db, 'n')
    if (lectureLanguage !== undefined) {
      setNoteLanguages(db, note.id, { lectureLanguage })
    }
    const source = createSource(db, {
      noteId: note.id,
      kind: 'audio',
      originalPath: '/tmp/a.wav',
      displayName: 'a.wav',
    })
    const calls: TranscribeChunkOptions[] = []
    const api: MetaApi = {
      transcribeChunk: async (opts) => {
        calls.push(opts)
        return {
          sessionId: 's',
          transcript: 't',
          audioDurationMs: 60_000,
          turns: [{ turnId: 0, startMs: 0, endMs: 60_000, transcript: 't' }],
        }
      },
      chat: async () => {
        throw new Error('no chat in this test')
      },
    }
    await runAudioPipeline(
      {
        db,
        metaApi: api,
        mediaDir: path.join(dir, 'media'),
        getDurationMs: async () => 60_000,
        convertChunks: async (_orig, outDir) => {
          fs.mkdirSync(outDir, { recursive: true })
          const chunk = path.join(outDir, 'chunk_000.wav')
          fs.writeFileSync(chunk, 'wav')
          return [chunk]
        },
      },
      source.id,
    )
    return calls
  }

  it('uses the Korean+English bias for the default lecture language', async () => {
    const calls = await captureBias(undefined)
    expect(calls).toHaveLength(1)
    expect(calls[0].languageBias).toEqual(['Korean', 'English'])
  })

  it('omits the bias (null) for auto-detect and pairs other languages with English', async () => {
    expect((await captureBias('auto'))[0].languageBias).toBeNull()
    expect((await captureBias('English'))[0].languageBias).toEqual(['English'])
    expect((await captureBias('Japanese'))[0].languageBias).toEqual(['Japanese', 'English'])
  })
})

// ---------------------------------------------------------------------------
// prompt builders by output language
// ---------------------------------------------------------------------------

/** Today's Korean/English prompts, captured so byte-identity is locked. */
const SUMMARY_KO =
  'You are a lecture-note assistant. Summarize the lecture below in Korean.\n' +
  'Write 5–15 concise claims that cover the main points in lecture order.\n' +
  'Every claim MUST cite 1–5 transcript segments ([n]) and/or slide pages ([Pk]) that directly support it.\n' +
  'Prefer the transcript for what the lecturer said; use slides for terms, definitions, and figures shown on slides.\n' +
  'Use only information stated in the transcript or slides. Do not use outside knowledge.\n' +
  'Do not merge unrelated points into a single claim.\n' +
  'Do not write segment or slide numbers like [3] or [P2] inside the claim text.\n' +
  'Reply in Korean.'

const SUMMARY_EN =
  'You are a lecture-note assistant. Summarize the lecture below in English.\n' +
  'Write 5–15 concise claims that cover the main points in lecture order.\n' +
  'Write the claims in English.\n' +
  'Every claim MUST cite 1–5 transcript segments ([n]) and/or slide pages ([Pk]) that directly support it.\n' +
  'Prefer the transcript for what the lecturer said; use slides for terms, definitions, and figures shown on slides.\n' +
  'Use only information stated in the transcript or slides. Do not use outside knowledge.\n' +
  'Do not merge unrelated points into a single claim.\n' +
  'Do not write segment or slide numbers like [3] or [P2] inside the claim text.\n' +
  'Reply in English.'

const VERIFY_KO =
  'You are a strict fact checker. For each claim, decide if it is fully supported by ONLY its cited evidence (transcript segments and/or slide pages).\n' +
  'Be strict: any added fact, number, causal link, or generalization not stated in the cited evidence means supported=false.\n' +
  'Transcripts are speech-recognition output: English technical terms may be spelled in Korean phonetics (e.g. 히든 레이어 = hidden layer, 백프로퍼게이션 = backpropagation). Treat these as the same term, not as a mismatch.\n' +
  'When an image of a cited slide is attached, it is the authoritative evidence for that slide; a [figure] description is only a helper and may be wrong, so check claims about figures against the image itself.\n' +
  'Reason in Korean, one sentence per claim.'

const VERIFY_EN =
  'You are a strict fact checker. For each claim, decide if it is fully supported by ONLY its cited evidence (transcript segments and/or slide pages).\n' +
  'Be strict: any added fact, number, causal link, or generalization not stated in the cited evidence means supported=false.\n' +
  'Transcripts are speech-recognition output: technical terms may be misheard (e.g. Korean phonetic spellings of English terms like 히든 레이어 = hidden layer). Treat these as the same term, not as a mismatch.\n' +
  'When an image of a cited slide is attached, it is the authoritative evidence for that slide; a [figure] description is only a helper and may be wrong, so check claims about figures against the image itself.\n' +
  'Reason in English, one sentence per claim.'

const QA_KO =
  `You answer a student's question about one lecture in Korean, using ONLY the ` +
  'transcript segments ([n]) and slide pages ([Pk]) below.\n' +
  'Answer in 1–5 short claims, the direct answer first.\n' +
  'Every claim MUST cite 1–5 transcript segments and/or slide pages that directly support it.\n' +
  'If the transcript and slides do not answer the question, return an empty claims list. ' +
  'Do not guess and do not use outside knowledge.\n' +
  'Do not write segment or slide numbers like [3] or [P2] inside the claim text.\n' +
  'Reply in Korean.'

const SLIDE_VISUAL_KO =
  'You read one lecture slide image. Describe ONLY visual content that the extracted slide text does not already convey: ' +
  'charts and plots (axis labels and ranges, each series/legend label, the trend of each series, notable values, where curves cross, rise, fall or diverge), ' +
  'diagrams (boxes, arrows and what connects to what), equations (write them in plain text), tables (headers and cell values), and photos or illustrations. ' +
  'Do not repeat bullet text that is already in the extracted text. ' +
  'Describe only what is visible; do not explain, interpret beyond the image, or add outside knowledge. ' +
  'Use at most 120 words. If the slide has no visual content beyond its text, return an empty string. ' +
  'Write in Korean.'

describe('prompt builders by output language', () => {
  it('keeps the Korean prompts byte-identical to today', () => {
    expect(SUMMARY_SYSTEM_PROMPT).toBe(SUMMARY_KO)
    expect(summarySystemPrompt('Korean')).toBe(SUMMARY_KO)
    expect(summarySystemPrompt('ko')).toBe(SUMMARY_KO)
    expect(VERIFY_SYSTEM_PROMPT).toBe(VERIFY_KO)
    expect(verifySystemPrompt('Korean')).toBe(VERIFY_KO)
    expect(qaSystemPrompt('Korean')).toBe(QA_KO)
    expect(slideVisualSystemPrompt('Korean')).toBe(SLIDE_VISUAL_KO)
    expect(slideVisualSystemPrompt('ko')).toBe(SLIDE_VISUAL_KO)
    expect(checkLocateSystemPrompt('Korean')).toContain('Reply in Korean.')
    expect(correctionSystemPrompt('Korean')).toBe(CORRECTION_SYSTEM_PROMPT)
  })

  it('keeps the English prompts byte-identical to today', () => {
    expect(summarySystemPrompt('English')).toBe(SUMMARY_EN)
    expect(summarySystemPrompt('en')).toBe(SUMMARY_EN)
    expect(verifySystemPrompt('English')).toBe(VERIFY_EN)
    expect(verifySystemPrompt('en')).toBe(VERIFY_EN)
    expect(qaSystemPrompt('English')).toBe(QA_KO.split('in Korean').join('in English'))
    expect(slideVisualSystemPrompt('English')).toBe(
      SLIDE_VISUAL_KO.slice(0, -'Write in Korean.'.length) + 'Write in English.',
    )
    expect(checkLocateSystemPrompt('English')).toContain('Reply in English.')
    expect(correctionSystemPrompt('English')).toContain('Reply in English.')
  })

  it('re-points the English variants at any other language, without "in English" left', () => {
    const summary = summarySystemPrompt('Vietnamese')
    expect(summary).toContain('Summarize the lecture below in Vietnamese.')
    expect(summary).toContain('Write the claims in Vietnamese.')
    expect(summary).toContain('Reply in Vietnamese.')
    expect(summary).not.toContain('in English')
    expect(summary).toContain(SLIDE_TERMS_RULE)

    const verify = verifySystemPrompt('Vietnamese')
    expect(verify).toContain('Reason in Vietnamese, one sentence per claim.')
    expect(verify).not.toContain('in English')
    expect(verify).toContain(SLIDE_TERMS_RULE)

    const locate = checkLocateSystemPrompt('Japanese')
    expect(locate).toContain('Reply in Japanese.')
    expect(locate).not.toContain('in English')

    const qa = qaSystemPrompt('Vietnamese')
    expect(qa).toContain('one lecture in Vietnamese')
    expect(qa).toContain('Reply in Vietnamese.')
    expect(qa).toContain(SLIDE_TERMS_RULE)

    const visual = slideVisualSystemPrompt('Vietnamese')
    expect(visual).toContain('Write in Vietnamese.')
    expect(visual).not.toContain('in English')
    expect(visual).toContain(SLIDE_TERMS_RULE)

    const correction = correctionSystemPrompt('Vietnamese')
    expect(correction).toContain('Write the reason in Vietnamese.')
    expect(correction).toContain('Reply in Vietnamese.')
    expect(correction).not.toContain('in English')
  })

  it('uses the Korean correction variant only for Korean lectures with Korean output', () => {
    expect(correctionSystemPrompt('Korean', 'default')).toBe(CORRECTION_SYSTEM_PROMPT)
    expect(correctionSystemPrompt('Korean', 'Korean')).toBe(CORRECTION_SYSTEM_PROMPT)
    // A Japanese lecture with Korean output: the generic variant, in Korean.
    const jaKo = correctionSystemPrompt('Korean', 'Japanese')
    expect(jaKo).not.toContain('for Korean lecture transcripts')
    expect(jaKo).toContain('Write the reason in Korean.')
    expect(jaKo).toContain('Reply in Korean.')
    // A Korean lecture with Vietnamese output: the generic variant, in Vietnamese.
    expect(correctionSystemPrompt('Vietnamese', 'Korean')).toContain('Reply in Vietnamese.')
    // auto lecture language is not the Korean-specific variant either.
    expect(correctionSystemPrompt('Korean', 'auto')).not.toContain('for Korean lecture transcripts')
  })

  it('selects fixed stored reasons by output language', () => {
    expect(zeroCitationReason('Korean')).toBe('인용한 구간이 자료에 없습니다')
    expect(zeroCitationReason('Vietnamese')).toBe('The cited evidence is not in the sources')
    expect(missingResultReason('ko')).toBe('검증 결과를 받지 못했습니다')
    expect(missingResultReason('Japanese')).toBe('No verification result was returned')
    expect(checkZeroCitationReason('Korean')).toBe('강의 자료에서 근거를 찾지 못했습니다')
    expect(checkZeroCitationReason('Thai')).toBe(
      'No supporting evidence found in the lecture materials',
    )
  })
})

// ---------------------------------------------------------------------------
// summaries.language storage + slide re-read + sample round-trip
// ---------------------------------------------------------------------------

describe('per-note output language behavior', () => {
  let dir: string
  let db: DatabaseSync

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-outlang-'))
    db = openDb(path.join(dir, 'test.sqlite'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function seedAudioNote(): number {
    const note = createNote(db, 'note')
    const source = createSource(db, {
      noteId: note.id,
      kind: 'audio',
      originalPath: '/tmp/lecture.wav',
      displayName: 'lecture.wav',
    })
    insertSegments(db, source.id, [
      { idx: 0, startMs: 0, endMs: 1000, text: 'content', chunkIndex: 0 },
    ])
    updateSourceStatus(db, source.id, 'done')
    return note.id
  }

  it('reads legacy ko/en summary rows and new language-name rows the same way', () => {
    const noteId = seedAudioNote()
    const legacyKo = createSummary(db, noteId, 'm', 'auto', 'ko')
    expect(getLatestSummary(db, noteId)?.language).toBe('ko')
    createSummary(db, noteId, 'm', 'auto', 'en')
    expect(getLatestSummary(db, noteId)?.language).toBe('en')
    createSummary(db, noteId, 'm', 'auto', 'Vietnamese')
    expect(getLatestSummary(db, noteId)?.language).toBe('Vietnamese')
    expect(legacyKo.id).toBeGreaterThan(0)
  })

  it('stores the resolved output language and writes prompts/reasons in it', async () => {
    const noteId = seedAudioNote()
    setNoteLanguages(db, noteId, { noteLanguage: 'Vietnamese' })
    const chatCalls: ChatOptions[] = []
    const api: MetaApi = {
      transcribeChunk: async () => {
        throw new Error('no transcribe in this test')
      },
      chat: async (opts: ChatOptions) => {
        chatCalls.push(opts)
        return chatCalls.length === 1 ? { claims: [{ text: 'Một câu.', segment_ids: [] }] } : { results: [] }
      },
    }
    const summary = await runSummaryPipeline({ db, metaApi: api, language: 'ko' }, noteId)
    expect(summary.language).toBe('Vietnamese')
    expect(chatCalls[0].messages[0].content).toContain('Reply in Vietnamese.')
    // Non-Korean outputs store the fixed reasons in English.
    expect(summary.claims[0].reason).toBe('The cited evidence is not in the sources')
  })

  it('respects an explicit outputLanguage override over the note row', async () => {
    const noteId = seedAudioNote()
    setNoteLanguages(db, noteId, { noteLanguage: 'Vietnamese' })
    const chatCalls: ChatOptions[] = []
    const api: MetaApi = {
      transcribeChunk: async () => {
        throw new Error('no transcribe in this test')
      },
      chat: async (opts: ChatOptions) => {
        chatCalls.push(opts)
        return { claims: [] }
      },
    }
    const summary = await runSummaryPipeline(
      { db, metaApi: api, language: 'ko', outputLanguage: 'Thai' },
      noteId,
    )
    expect(summary.language).toBe('Thai')
    expect(chatCalls[0].messages[0].content).toContain('Reply in Thai.')
  })
})

describe('slide visual re-read by output language', () => {
  let dir: string
  let db: DatabaseSync

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-rev-'))
    db = openDb(path.join(dir, 'test.sqlite'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function seedReadPage(): { noteId: number; pageId: number } {
    const note = createNote(db, '슬라이드')
    const pdf = createSource(db, {
      noteId: note.id,
      kind: 'pdf',
      originalPath: '/tmp/s.pdf',
      displayName: 's.pdf',
    })
    const [pageId] = insertPages(db, pdf.id, [{ pageNo: 1, text: '본문' }])
    updateSourceStatus(db, pdf.id, 'done')
    const imagePath = path.join(dir, `${pageId}.jpg`)
    fs.writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))
    setPageImagePath(db, pageId, imagePath)
    return { noteId: note.id, pageId }
  }

  function fakeVision(calls: ChatOptions[]): MetaApi {
    return {
      transcribeChunk: async () => {
        throw new Error('no transcribe in this test')
      },
      chat: async (opts: ChatOptions) => {
        calls.push(opts)
        return { visual: 'a chart' }
      },
    }
  }

  it('re-reads a page when visual_language differs, skips NULL and matching rows', async () => {
    const { noteId, pageId } = seedReadPage()
    // Read before visual_language existed: NULL matches any output language.
    setPageVisualText(db, pageId, '한국어 설명')
    const calls1: ChatOptions[] = []
    await readSlideVisuals({ db, metaApi: fakeVision(calls1), model: 'm', outputLanguage: 'Vietnamese', noteId })
    expect(calls1).toHaveLength(0)

    // Read in Korean: a Vietnamese run re-reads the page once...
    setPageVisualText(db, pageId, '한국어 설명', 'Korean')
    const calls2: ChatOptions[] = []
    await readSlideVisuals({ db, metaApi: fakeVision(calls2), model: 'm', outputLanguage: 'Vietnamese', noteId })
    expect(calls2).toHaveLength(1)
    const page = listNotePageImages(db, noteId)[0]
    expect(page.visualText).toBe('a chart')
    expect(page.visualLanguage).toBe('Vietnamese')

    // ...and a second Vietnamese run sees the matching language and skips.
    const calls3: ChatOptions[] = []
    await readSlideVisuals({ db, metaApi: fakeVision(calls3), model: 'm', outputLanguage: 'Vietnamese', noteId })
    expect(calls3).toHaveLength(0)
  })
})

describe('sample note languages round-trip', () => {
  let dir: string
  let db: DatabaseSync

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcenote-samplang-'))
    db = openDb(path.join(dir, 'test.sqlite'))
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function seedNote(): number {
    const note = createNote(db, 'lang sample')
    const audio = createSource(db, {
      noteId: note.id,
      kind: 'audio',
      originalPath: path.join(dir, 'a.wav'),
      displayName: 'a.wav',
    })
    fs.writeFileSync(audio.original_path, Buffer.alloc(4))
    updateSourceStatus(db, audio.id, 'done')
    insertSegments(db, audio.id, [
      { idx: 0, startMs: 0, endMs: 1000, text: 'hello', chunkIndex: 0 },
    ])
    return note.id
  }

  function writeSampleFolder(name: string, sample: unknown): string {
    const sampleDir = path.join(dir, name)
    fs.mkdirSync(sampleDir, { recursive: true })
    fs.writeFileSync(path.join(sampleDir, 'a.wav'), 'wav')
    fs.writeFileSync(path.join(sampleDir, 'note.json'), JSON.stringify(sample), 'utf8')
    return sampleDir
  }

  it('exports and re-imports the per-note languages', () => {
    const noteId = seedNote()
    setNoteLanguages(db, noteId, { lectureLanguage: 'Japanese', noteLanguage: 'Vietnamese' })
    const sample = serializeSampleNote(db, noteId)
    expect(sample.lectureLanguage).toBe('Japanese')
    expect(sample.noteLanguage).toBe('Vietnamese')

    const parsed = parseSampleNote(JSON.parse(JSON.stringify(sample)))
    expect(parsed.lectureLanguage).toBe('Japanese')
    expect(parsed.noteLanguage).toBe('Vietnamese')

    const importDb = openDb(path.join(dir, 'imported.sqlite'))
    try {
      const imported = importSampleNote(importDb, writeSampleFolder('with-langs', sample), dir)
      const note = getNote(importDb, imported.id)
      expect(note?.lecture_language).toBe('Japanese')
      expect(note?.note_language).toBe('Vietnamese')
      // Re-export reproduces the same note.json fields.
      const again = serializeSampleNote(importDb, imported.id)
      expect(again.lectureLanguage).toBe('Japanese')
      expect(again.noteLanguage).toBe('Vietnamese')
    } finally {
      importDb.close()
    }
  })

  it('imports old files without the fields using the defaults', () => {
    const noteId = seedNote()
    const sample = serializeSampleNote(db, noteId) as unknown as Record<string, unknown>
    delete sample.lectureLanguage
    delete sample.noteLanguage
    const parsed = parseSampleNote(sample)
    expect(parsed.lectureLanguage).toBeUndefined()
    expect(parsed.noteLanguage).toBeUndefined()

    const importDb = openDb(path.join(dir, 'old-imported.sqlite'))
    try {
      const imported = importSampleNote(importDb, writeSampleFolder('without-langs', sample), dir)
      const note = getNote(importDb, imported.id)
      expect(note?.lecture_language).toBe('default')
      expect(note?.note_language).toBe('app')
    } finally {
      importDb.close()
    }
  })

  it('rejects unsupported language values in note.json', () => {
    const noteId = seedNote()
    const sample = JSON.parse(JSON.stringify(serializeSampleNote(db, noteId))) as Record<string, unknown>
    expect(() => parseSampleNote({ ...sample, lectureLanguage: 'Klingon' })).toThrow(
      'Invalid sample note',
    )
    expect(() => parseSampleNote({ ...sample, noteLanguage: 'auto' })).toThrow(
      'Invalid sample note',
    )
    // Summary languages accept legacy ko/en and supported names, nothing else.
    expect(() => parseSampleNote({ ...sample, language: 'Vietnamese' })).not.toThrow()
    expect(() => parseSampleNote({ ...sample, language: 'xx' })).toThrow('Invalid sample note')
  })
})
