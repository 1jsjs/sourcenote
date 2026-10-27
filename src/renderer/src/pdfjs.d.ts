/**
 * Minimal declarations for the pdf.js browser build used by the slide panel.
 * pdfjs-dist ships no sibling .d.ts for these subpaths, so the renderer
 * declares the small surface it uses.
 */
declare module 'pdfjs-dist/build/pdf.mjs' {
  export interface PdfViewport {
    width: number
    height: number
  }
  export interface PdfPage {
    getViewport(params: { scale: number }): PdfViewport
    render(params: {
      canvas: HTMLCanvasElement
      canvasContext: CanvasRenderingContext2D
      viewport: PdfViewport
    }): {
      promise: Promise<void>
    }
  }
  export interface PdfDocument {
    numPages: number
    getPage(pageNo: number): Promise<PdfPage>
  }
  export const GlobalWorkerOptions: { workerSrc: string }
  export function getDocument(src: { data: Uint8Array }): { promise: Promise<PdfDocument> }
}

declare module 'pdfjs-dist/build/pdf.worker.min.mjs?url' {
  const url: string
  export default url
}
