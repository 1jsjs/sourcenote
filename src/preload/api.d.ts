import type { SourcenoteApi } from '../shared/types'

declare global {
  interface Window {
    sourcenote: SourcenoteApi
  }
}

export {}
