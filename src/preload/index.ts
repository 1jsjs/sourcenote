import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppInfo,
  AppSettings,
  CheckProgressEvent,
  CorrectionProgressEvent,
  Note,
  NotePage,
  ProgressEvent,
  SampleInfo,
  Source,
  SourcenoteApi,
  SummaryProgressEvent,
} from '../shared/types'

const api: SourcenoteApi = {
  listNotes: () => ipcRenderer.invoke('notes:list'),
  createNote: (title) => ipcRenderer.invoke('notes:create', title),
  renameNote: (id, title) => ipcRenderer.invoke('notes:rename', id, title),
  deleteNote: (id) => ipcRenderer.invoke('notes:delete', id),
  listSources: (noteId) => ipcRenderer.invoke('sources:list', noteId),
  addAudioSource: (noteId) => ipcRenderer.invoke('sources:addAudio', noteId),
  addPdfSource: (noteId): Promise<Source | null> => ipcRenderer.invoke('sources:addPdf', noteId),
  addPaths: (noteId, paths): Promise<{ added: Source[]; ignored: string[] }> =>
    ipcRenderer.invoke('sources:addPaths', noteId, paths),
  // The dropped File keeps its native path across the bridge, so
  // webUtils can resolve it here in the preload.
  getPathForFile: (file: unknown): string => webUtils.getPathForFile(file as never),
  listSegments: (sourceId) => ipcRenderer.invoke('segments:list', sourceId),
  retrySource: (sourceId): Promise<Source> => ipcRenderer.invoke('sources:retry', sourceId),
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
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
  runCorrections: (noteId) => ipcRenderer.invoke('corrections:run', noteId),
  listCorrections: (noteId) => ipcRenderer.invoke('corrections:list', noteId),
  acceptCorrection: (id) => ipcRenderer.invoke('corrections:accept', id),
  rejectCorrection: (id) => ipcRenderer.invoke('corrections:reject', id),
  acceptAllCorrections: (noteId) => ipcRenderer.invoke('corrections:acceptAll', noteId),
  onCorrectionProgress: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: CorrectionProgressEvent): void => {
      cb(payload)
    }
    ipcRenderer.on('correction:progress', listener)
    return () => {
      ipcRenderer.removeListener('correction:progress', listener)
    }
  },
  runCheck: (noteId, text) => ipcRenderer.invoke('check:run', noteId, text),
  getLatestCheck: (noteId) => ipcRenderer.invoke('check:getLatest', noteId),
  onCheckProgress: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: CheckProgressEvent): void => {
      cb(payload)
    }
    ipcRenderer.on('check:progress', listener)
    return () => {
      ipcRenderer.removeListener('check:progress', listener)
    }
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch): Promise<AppSettings> => ipcRenderer.invoke('settings:set', patch),
  listSamples: (): Promise<SampleInfo[]> => ipcRenderer.invoke('samples:list'),
  importSample: (name): Promise<Note> => ipcRenderer.invoke('samples:import', name),
}

contextBridge.exposeInMainWorld('sourcenote', api)
