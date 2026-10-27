import { contextBridge, ipcRenderer } from 'electron'
import type {
  NotePage,
  ProgressEvent,
  Source,
  SourcenoteApi,
  SummaryProgressEvent,
} from '../shared/types'

const api: SourcenoteApi = {
  listNotes: () => ipcRenderer.invoke('notes:list'),
  createNote: (title) => ipcRenderer.invoke('notes:create', title),
  listSources: (noteId) => ipcRenderer.invoke('sources:list', noteId),
  addAudioSource: (noteId) => ipcRenderer.invoke('sources:addAudio', noteId),
  addPdfSource: (noteId): Promise<Source | null> => ipcRenderer.invoke('sources:addPdf', noteId),
  listSegments: (sourceId) => ipcRenderer.invoke('segments:list', sourceId),
  listPages: (noteId): Promise<NotePage[]> => ipcRenderer.invoke('pages:list', noteId),
  getSpend: () => ipcRenderer.invoke('budget:getSpend'),
  onProgress: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ProgressEvent): void => {
      cb(payload)
    }
    ipcRenderer.on('pipeline:progress', listener)
    return () => {
      ipcRenderer.removeListener('pipeline:progress', listener)
    }
  },
  runSummary: (noteId) => ipcRenderer.invoke('summary:run', noteId),
  getLatestSummary: (noteId) => ipcRenderer.invoke('summary:getLatest', noteId),
  onSummaryProgress: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: SummaryProgressEvent): void => {
      cb(payload)
    }
    ipcRenderer.on('summary:progress', listener)
    return () => {
      ipcRenderer.removeListener('summary:progress', listener)
    }
  },
}

contextBridge.exposeInMainWorld('sourcenote', api)
