import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import path from 'node:path'

// Side-effect import: sets SOURCENOTE_DATA_DIR to app.getPath('userData')
// before any module that depends on it is evaluated.
import './env'

import { budgetCapUsd, LedgerStore } from './budget'
import {
  createNote,
  createSource,
  listNotes,
  listSegments,
  listSources,
  openDb,
} from './db'
import { createMetaApi } from './meta-api'
import { runAudioPipeline } from './pipeline'
import { dbFilePath, ensureDataDir, ledgerFilePath, mediaDirPath } from './paths'
import type { ProgressEvent } from '../shared/types'

// electron-vite injects the CommonJS `__dirname` shim into ESM main builds.

const AUDIO_FILTERS = [
  { name: '오디오', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'webm', 'mp4', 'mov'] },
]

const dataDir = ensureDataDir()
const db = openDb(dbFilePath(dataDir))
const ledger = new LedgerStore(ledgerFilePath(dataDir))
const metaApi = createMetaApi({ ledger })

function sendProgress(win: BrowserWindow | null, event: ProgressEvent): void {
  win?.webContents.send('pipeline:progress', event)
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

  ipcMain.handle('budget:getSpend', () => ({ spentUsd: ledger.totalUsd, capUsd: budgetCapUsd() }))

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
