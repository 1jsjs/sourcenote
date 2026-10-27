import { contextBridge, ipcRenderer } from 'electron'
import type { ProgressEvent, SourcenoteApi } from '../shared/types'

const api: SourcenoteApi = {
  listNotes: () => ipcRenderer.invoke('notes:list'),
  createNote: (title) => ipcRenderer.invoke('notes:create', title),
  listSources: (noteId) => ipcRenderer.invoke('sources:list', noteId),
  addAudioSource: (noteId) => ipcRenderer.invoke('sources:addAudio', noteId),
  listSegments: (sourceId) => ipcRenderer.invoke('segments:list', sourceId),
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
}

contextBridge.exposeInMainWorld('sourcenote', api)
