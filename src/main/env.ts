import { app } from 'electron'

/**
 * Pins the data directory to Electron's userData path before any other main
 * module runs. Imported first by index.ts; other modules only read
 * SOURCENOTE_DATA_DIR at call time, but setting it here keeps that true even
 * if module-level reads are added later.
 */
if (!process.env.SOURCENOTE_DATA_DIR || process.env.SOURCENOTE_DATA_DIR.trim().length === 0) {
  process.env.SOURCENOTE_DATA_DIR = app.getPath('userData')
}
