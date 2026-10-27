import { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

// Side-effect import: sets SOURCENOTE_DATA_DIR to app.getPath('userData')
// before any module that depends on it is evaluated.
import './env'

import { budgetCapUsd, LedgerStore } from './budget'
import { runCheckPipeline } from './check-pipeline'
import {
  acceptAllCorrections,
  acceptCorrection,
  listCorrectionsDto,
  rejectCorrection,
  runCorrectionPipeline,
} from './correction'
import {
  createNote,
  createSource,
  deleteNote,
  deleteSourceSegments,
  getLatestCheck,
  getLatestSummary,
  getSource,
  listNotePages,
  listNotes,
  listSegments,
  listSources,
  openDb,
  removeNoteMedia,
  renameNote,
} from './db'
import { isFakeApiEnabled } from './fake-api'
import { langMsg } from './lang'
import { mediaContentTypeForPath, parseMediaSourceUrl, parseRangeHeader } from './media'
import { createMetaApi } from './meta-api'
import { ingestPdfSource } from './pdf'
import { AUDIO_EXTENSIONS, classifyPaths } from './source-paths'
import { runAudioPipeline } from './pipeline'
import { importSampleNote, listSampleNotes, resolveSamplesDir } from './sample'
import { loadSettings, parseSettings, saveSettings } from './settings'
import { runSummaryPipeline } from './summary-pipeline'
import { dbFilePath, ensureDataDir, ledgerFilePath, mediaDirPath, settingsFilePath } from './paths'
import type {
  AppLanguage,
  CheckProgressEvent,
  CorrectionProgressEvent,
  ProgressEvent,
  Source,
  SummaryProgressEvent,
} from '../shared/types'

// Must run before app ready so the scheme is treated as privileged.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'sourcenote-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
])

// electron-vite injects the CommonJS `__dirname` shim into ESM main builds.

const AUDIO_FILTERS = [{ name: '오디오', extensions: [...AUDIO_EXTENSIONS] }]

const PDF_FILTERS = [{ name: 'PDF', extensions: ['pdf'] }]

// The renderer page (file:// in production, http://localhost in dev) fetches
// slides from this scheme for pdf.js, which is a cross-origin request. The
// scheme only serves files registered as sources, so allowing any origin
// grants nothing beyond what the app's own window can already load.
const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' }

/**
 * Serves `sourcenote-media://source/<id>` from the source's stored file.
 * The id always goes through a DB lookup, so the renderer can never read
 * arbitrary files. Implements HTTP Range so Chromium audio can seek (206
 * partial content); unknown ids and missing files answer 404.
 */
async function handleMediaRequest(req: Request): Promise<Response> {
  const sourceId = parseMediaSourceUrl(req.url)
  if (sourceId === null) {
    return new Response('찾을 수 없음', { status: 404 })
  }
  const source = getSource(db, sourceId)
  if (!source) {
    return new Response('찾을 수 없음', { status: 404 })
  }
  let size: number
  try {
    const stat = fs.statSync(source.original_path)
    if (!stat.isFile()) throw new Error('not a file')
    size = stat.size
  } catch {
    return new Response('찾을 수 없음', { status: 404 })
  }
  const contentType = mediaContentTypeForPath(source.original_path)
  const rangeHeader = req.headers.get('range')
  if (!rangeHeader) {
    const stream = fs.createReadStream(source.original_path)
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
        ...CORS_HEADERS,
      },
    })
  }
  const parsed = parseRangeHeader(rangeHeader, size)
  if (parsed === null) {
    // Malformed range: serve the full file.
    const stream = fs.createReadStream(source.original_path)
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
        ...CORS_HEADERS,
      },
    })
  }
  if (parsed === 'unsatisfiable') {
    return new Response('요청 범위를 만족할 수 없음', {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}`, ...CORS_HEADERS },
    })
  }
  const stream = fs.createReadStream(source.original_path, {
    start: parsed.start,
    end: parsed.end,
  })
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 206,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(parsed.end - parsed.start + 1),
      'Content-Range': `bytes ${parsed.start}-${parsed.end}/${size}`,
      'Accept-Ranges': 'bytes',
        ...CORS_HEADERS,
    },
  })
}

const dataDir = ensureDataDir()
const db = openDb(dbFilePath(dataDir))
const ledger = new LedgerStore(ledgerFilePath(dataDir))
const settingsPath = settingsFilePath(dataDir)
/** Current app language; read live so a toggle applies to the next call. */
const currentLanguage = (): AppLanguage => loadSettings(settingsPath).language
const metaApi = createMetaApi({ ledger, getLanguage: currentLanguage })
const samplesDir = resolveSamplesDir({
  appPath: app.getAppPath(),
  resourcesPath: process.resourcesPath,
  packaged: app.isPackaged,
})

function sendProgress(win: BrowserWindow | null, event: ProgressEvent): void {
  win?.webContents.send('pipeline:progress', event)
}

function sendSummaryProgress(win: BrowserWindow | null, event: SummaryProgressEvent): void {
  win?.webContents.send('summary:progress', event)
}

function sendCorrectionProgress(win: BrowserWindow | null, event: CorrectionProgressEvent): void {
  win?.webContents.send('correction:progress', event)
}

function sendCheckProgress(win: BrowserWindow | null, event: CheckProgressEvent): void {
  win?.webContents.send('check:progress', event)
}

function registerIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('app:info', () => ({ fakeApi: isFakeApiEnabled(), version: app.getVersion() }))

  ipcMain.handle('notes:list', () => listNotes(db))

  ipcMain.handle('settings:get', () => loadSettings(settingsPath))

  ipcMain.handle('settings:set', (_e, patch: unknown) => {
    const current = loadSettings(settingsPath)
    const extra =
      patch !== null && typeof patch === 'object' && !Array.isArray(patch)
        ? (patch as Record<string, unknown>)
        : {}
    return saveSettings(settingsPath, parseSettings({ ...current, ...extra }))
  })

  ipcMain.handle('samples:list', () => listSampleNotes(samplesDir))

  ipcMain.handle('samples:import', (_e, name: unknown) => {
    if (typeof name !== 'string' || !listSampleNotes(samplesDir).some((s) => s.name === name)) {
      throw new Error(
        langMsg(currentLanguage(), '샘플 노트를 찾을 수 없습니다.', 'Sample note not found.'),
      )
    }
    const note = importSampleNote(db, path.join(samplesDir, name), dataDir)
    return note
  })

  ipcMain.handle('notes:create', (_e, title: unknown) => {
    const fallback = langMsg(currentLanguage(), '새 노트', 'New note')
    const t = typeof title === 'string' && title.trim().length > 0 ? title.trim() : fallback
    return createNote(db, t)
  })

  ipcMain.handle('notes:rename', (_e, id: unknown, title: unknown) => {
    if (typeof id !== 'number') {
      throw new Error(langMsg(currentLanguage(), '노트를 찾을 수 없습니다.', 'Note not found.'))
    }
    if (typeof title !== 'string') {
      throw new Error(langMsg(currentLanguage(), '노트 제목을 입력하세요', 'Enter a note title'))
    }
    return renameNote(db, id, title, currentLanguage())
  })

  ipcMain.handle('notes:delete', (_e, id: unknown) => {
    if (typeof id !== 'number') {
      throw new Error(langMsg(currentLanguage(), '노트를 찾을 수 없습니다.', 'Note not found.'))
    }
    // DB rows go first in one transaction; converted chunk dirs afterwards.
    // Original files (`sources.original_path`) are never touched.
    const sourceIds = deleteNote(db, id, currentLanguage())
    removeNoteMedia(dataDir, sourceIds)
    return sourceIds
  })

  ipcMain.handle('sources:list', (_e, noteId: unknown) =>
    typeof noteId === 'number' ? listSources(db, noteId) : [],
  )

  ipcMain.handle('segments:list', (_e, sourceId: unknown) =>
    typeof sourceId === 'number' ? listSegments(db, sourceId) : [],
  )

  ipcMain.handle('pages:list', (_e, noteId: unknown) =>
    typeof noteId === 'number' ? listNotePages(db, noteId) : [],
  )

  /** Registers an audio file and starts transcription in the background. */
  const registerAudioPath = (noteId: number, filePath: string): Source => {
    const source = createSource(db, {
      noteId,
      kind: 'audio',
      originalPath: filePath,
      displayName: path.basename(filePath),
    })

    // Long-running: start in background; progress arrives via pipeline:progress.
    void runAudioPipeline(
      {
        db,
        metaApi,
        mediaDir: mediaDirPath(dataDir),
        onProgress: (event) => sendProgress(getWindow(), event),
      },
      source.id,
    ).catch(() => {
      // Status/message already stored on the source and sent via progress.
    })

    return source
  }

  /** Registers a PDF file and starts text extraction in the background. */
  const registerPdfPath = (noteId: number, filePath: string): Source => {
    const source = createSource(db, {
      noteId,
      kind: 'pdf',
      originalPath: filePath,
      displayName: path.basename(filePath),
    })

    // Text extraction runs in the background; the renderer refreshes when
    // the source row flips to done/error (it re-lists on progress events).
    // Reuse the audio progress channel with sourceId so the UI updates.
    void ingestPdfSource(db, source.id)
      .then(() => {
        sendProgress(getWindow(), { sourceId: source.id, stage: 'done', chunk: 1, totalChunks: 1 })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        sendProgress(getWindow(), {
          sourceId: source.id,
          stage: 'error',
          chunk: 0,
          totalChunks: 0,
          message,
        })
      })

    return source
  }

  ipcMain.handle('sources:addPdf', async (_e, noteId: unknown) => {
    if (typeof noteId !== 'number') return null
    const win = getWindow()
    const options = {
      title: 'PDF 파일 선택',
      properties: ['openFile' as const],
      filters: PDF_FILTERS,
    }
    const picked = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (picked.canceled || picked.filePaths.length === 0) return null

    return registerPdfPath(noteId, picked.filePaths[0])
  })

  /**
   * Registers dropped files: audio extensions start transcription, PDFs
   * start slide extraction, anything else is reported back (by file name)
   * so the renderer can show a localized error listing them.
   */
  ipcMain.handle('sources:addPaths', (_e, noteId: unknown, paths: unknown) => {
    if (typeof noteId !== 'number') {
      throw new Error(langMsg(currentLanguage(), '노트를 찾을 수 없습니다.', 'Note not found.'))
    }
    const files = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : []
    const { audio, pdf, ignored } = classifyPaths(files)
    const added: Source[] = [
      ...audio.map((filePath) => registerAudioPath(noteId, filePath)),
      ...pdf.map((filePath) => registerPdfPath(noteId, filePath)),
    ]
    if (added.length === 0) {
      const names = ignored.map((filePath) => path.basename(filePath)).join(', ')
      throw new Error(
        langMsg(
          currentLanguage(),
          `지원하지 않는 파일입니다: ${names}`,
          `Unsupported files: ${names}`,
        ),
      )
    }
    return { added, ignored: ignored.map((filePath) => path.basename(filePath)) }
  })

  /**
   * Re-runs the pipeline for one errored (or stale) source. Refuses while
   * that source is still converting/transcribing.
   */
  ipcMain.handle('sources:retry', (_e, sourceId: unknown) => {
    if (typeof sourceId !== 'number') {
      throw new Error(langMsg(currentLanguage(), '소스를 찾을 수 없습니다.', 'Source not found.'))
    }
    const source = getSource(db, sourceId)
    if (!source) {
      throw new Error(langMsg(currentLanguage(), '소스를 찾을 수 없습니다.', 'Source not found.'))
    }
    if (source.status === 'converting' || source.status === 'transcribing') {
      throw new Error(
        langMsg(
          currentLanguage(),
          '진행 중인 작업이 끝나면 다시 누를 수 있어요.',
          'Available when the current run finishes.',
        ),
      )
    }
    if (source.kind === 'pdf') {
      void ingestPdfSource(db, source.id)
        .then(() => {
          sendProgress(getWindow(), { sourceId: source.id, stage: 'done', chunk: 1, totalChunks: 1 })
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          sendProgress(getWindow(), {
            sourceId: source.id,
            stage: 'error',
            chunk: 0,
            totalChunks: 0,
            message,
          })
        })
    } else {
      // A retry must not duplicate transcript rows.
      deleteSourceSegments(db, source.id)
      void runAudioPipeline(
        {
          db,
          metaApi,
          mediaDir: mediaDirPath(dataDir),
          onProgress: (event) => sendProgress(getWindow(), event),
        },
        source.id,
      ).catch(() => {
        // Status/message already stored on the source and sent via progress.
      })
    }
    const updated = getSource(db, source.id)
    if (!updated) throw new Error(langMsg(currentLanguage(), '소스를 찾을 수 없습니다.', 'Source not found.'))
    return updated
  })

  ipcMain.handle('budget:getSpend', () => ({ spentUsd: ledger.totalUsd, capUsd: budgetCapUsd() }))

  ipcMain.handle('summary:getLatest', (_e, noteId: unknown) =>
    typeof noteId === 'number' ? getLatestSummary(db, noteId) : null,
  )

  ipcMain.handle('summary:run', (_e, noteId: unknown) => {
    if (typeof noteId !== 'number') return
    // Long-running: start in background; progress arrives via summary:progress.
    void runSummaryPipeline(
      {
        db,
        metaApi,
        language: currentLanguage(),
        onProgress: (event) => sendSummaryProgress(getWindow(), event),
      },
      noteId,
    ).catch(() => {
      // Status/message already stored on the summary and sent via progress.
    })
  })

  ipcMain.handle('corrections:run', (_e, noteId: unknown) => {
    if (typeof noteId !== 'number') return
    // Long-running: start in background; progress arrives via correction:progress.
    void runCorrectionPipeline(
      {
        db,
        metaApi,
        language: currentLanguage(),
        onProgress: (event) => sendCorrectionProgress(getWindow(), event),
      },
      noteId,
    ).catch(() => {
      // Failure is reported via the error progress event.
    })
  })

  ipcMain.handle('corrections:list', (_e, noteId: unknown) =>
    typeof noteId === 'number' ? listCorrectionsDto(db, noteId) : [],
  )

  ipcMain.handle('corrections:accept', (_e, id: unknown) => {
    if (typeof id !== 'number') throw new Error('교정 제안을 찾을 수 없습니다.')
    return acceptCorrection(db, id, currentLanguage())
  })

  ipcMain.handle('corrections:reject', (_e, id: unknown) => {
    if (typeof id !== 'number') throw new Error('교정 제안을 찾을 수 없습니다.')
    rejectCorrection(db, id)
  })

  ipcMain.handle('corrections:acceptAll', (_e, noteId: unknown) => {
    if (typeof noteId !== 'number') throw new Error('노트를 찾을 수 없습니다.')
    return acceptAllCorrections(db, noteId)
  })

  ipcMain.handle('check:run', (_e, noteId: unknown, text: unknown) => {
    if (typeof noteId !== 'number') throw new Error('노트를 찾을 수 없습니다.')
    if (typeof text !== 'string') throw new Error('검증할 문장이 없습니다.')
    return runCheckPipeline(
      {
        db,
        metaApi,
        language: currentLanguage(),
        onProgress: (event) => sendCheckProgress(getWindow(), event),
      },
      noteId,
      text,
    )
  })

  ipcMain.handle('check:getLatest', (_e, noteId: unknown) =>
    typeof noteId === 'number' ? getLatestCheck(db, noteId) : null,
  )

  ipcMain.handle('sources:addAudio', async (_e, noteId: unknown) => {
    if (typeof noteId !== 'number') return null
    const win = getWindow()
    const options = {
      title: '오디오 파일 선택',
      properties: ['openFile' as const],
      filters: AUDIO_FILTERS,
    }
    const picked = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (picked.canceled || picked.filePaths.length === 0) return null

    return registerAudioPath(noteId, picked.filePaths[0])
  })
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1080,
    minHeight: 680,
    // Page background so the first paint never flashes white.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1C1F26' : '#FCFCFA',
    title: 'Sourcenote',
    // macOS: the app header is the drag region (traffic lights float over it).
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  return win
}

let mainWindow: BrowserWindow | null = null

void app.whenReady().then(() => {
  protocol.handle('sourcenote-media', (req) => handleMediaRequest(req))
  registerIpc(() => mainWindow)
  mainWindow = createWindow()
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
