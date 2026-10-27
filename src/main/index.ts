import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

// Side-effect import: sets SOURCENOTE_DATA_DIR to app.getPath('userData')
// before any module that depends on it is evaluated.
import './env'

import { budgetCapUsd, LedgerStore } from './budget'
import {
  createNote,
  createSource,
  getLatestSummary,
  getSource,
  listNotePages,
  listNotes,
  listSegments,
  listSources,
  openDb,
} from './db'
import { mediaContentTypeForPath, parseMediaSourceUrl, parseRangeHeader } from './media'
import { createMetaApi } from './meta-api'
import { ingestPdfSource } from './pdf'
import { runAudioPipeline } from './pipeline'
import { runSummaryPipeline } from './summary-pipeline'
import { dbFilePath, ensureDataDir, ledgerFilePath, mediaDirPath } from './paths'
import type { ProgressEvent, SummaryProgressEvent } from '../shared/types'

// Must run before app ready so the scheme is treated as privileged.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'sourcenote-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

// electron-vite injects the CommonJS `__dirname` shim into ESM main builds.

const AUDIO_FILTERS = [
  { name: '오디오', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'webm', 'mp4', 'mov'] },
]

const PDF_FILTERS = [{ name: 'PDF', extensions: ['pdf'] }]

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
      },
    })
  }
  if (parsed === 'unsatisfiable') {
    return new Response('요청 범위를 만족할 수 없음', {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}` },
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
    },
  })
}

const dataDir = ensureDataDir()
const db = openDb(dbFilePath(dataDir))
const ledger = new LedgerStore(ledgerFilePath(dataDir))
const metaApi = createMetaApi({ ledger })

function sendProgress(win: BrowserWindow | null, event: ProgressEvent): void {
  win?.webContents.send('pipeline:progress', event)
}

function sendSummaryProgress(win: BrowserWindow | null, event: SummaryProgressEvent): void {
  win?.webContents.send('summary:progress', event)
}

function registerIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('notes:list', () => listNotes(db))

  ipcMain.handle('notes:create', (_e, title: unknown) => {
    const t = typeof title === 'string' && title.trim().length > 0 ? title.trim() : '새 노트'
    return createNote(db, t)
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

    const filePath = picked.filePaths[0]
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
        onProgress: (event) => sendSummaryProgress(getWindow(), event),
      },
      noteId,
    ).catch(() => {
      // Status/message already stored on the summary and sent via progress.
    })
  })

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

    const filePath = picked.filePaths[0]
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
  })
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    title: 'Sourcenote',
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
