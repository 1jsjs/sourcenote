import type { DatabaseSync } from 'node:sqlite'
import type { NotePage } from '../shared/types'
import { insertClaimsWithCitations, pageImagePathMap, setClaimVerdict, type NewClaim, type NoteSegment } from './db'
import {
  applyVerifyResults,
  buildVerifyMessages,
  formatSlideEvidence,
  formatTranscriptEvidence,
  MAX_VERIFY_IMAGES,
  pageEvidenceText,
  splitBatches,
  VERIFY_SCHEMA,
  VERIFY_SCHEMA_NAME,
  validateVerifyPayload,
  type VerifyImage,
  type VerifyItem,
} from './grounding'
import type { MetaApi } from './meta-api'
import { imagePartFromFile } from './slide-vision'

/**
 * Shared second half of every grounded pipeline (summary, notes check, Q&A):
 * store the cited claims, then verify each one against ONLY its cited
 * evidence, in batches. A claim with no citations is stored as unsupported
 * with `zeroCitationReason` and never sent for verification. When a cited
 * slide page has a rendered image on disk, the image itself is attached to
 * the verification call (at most MAX_VERIFY_IMAGES per call, first-cited
 * order) so the checker judges figures against the slide, not only text.
 */

export interface CitedClaim {
  idx: number
  text: string
  segmentDbIds: number[]
  pageDbIds: number[]
}

export interface StoreAndVerifyOptions {
  db: DatabaseSync
  metaApi: MetaApi
  model: string
  /** Resolved AI output language name (prompts and stored fixed reasons). */
  outputLanguage: string
  summaryId: number
  claims: CitedClaim[]
  segments: NoteSegment[]
  pages: NotePage[]
  zeroCitationReason: string
  /** Called once the claims are stored, right before the first verify call. */
  onVerifying?: () => void
}

export async function storeAndVerifyClaims(opts: StoreAndVerifyOptions): Promise<void> {
  const { db, metaApi, model, outputLanguage, claims } = opts
  const uncited = (c: CitedClaim): boolean => c.segmentDbIds.length + c.pageDbIds.length === 0
  const toInsert: NewClaim[] = claims.map((c) => ({
    idx: c.idx,
    text: c.text,
    verdict: uncited(c) ? 'unsupported' : 'pending',
    reason: uncited(c) ? opts.zeroCitationReason : null,
    segmentIds: c.segmentDbIds,
    pageIds: c.pageDbIds,
  }))
  const claimIds = insertClaimsWithCitations(db, opts.summaryId, toInsert)
  const claimIdByIdx = new Map(claims.map((c, i) => [c.idx, claimIds[i]]))
  const segmentByDbId = new Map(opts.segments.map((s) => [s.id, s]))
  const pageByDbId = new Map(opts.pages.map((p) => [p.id, p]))

  opts.onVerifying?.()
  for (const batch of splitBatches(claims.filter((c) => !uncited(c)))) {
    const items: VerifyItem[] = batch.map((c) => ({
      claimIdx: c.idx,
      text: c.text,
      citedTexts: [
        ...c.segmentDbIds.map((id) => {
          const s = segmentByDbId.get(id)
          return formatTranscriptEvidence(s?.startMs ?? 0, s?.text ?? '')
        }),
        ...c.pageDbIds.map((id) => {
          const p = pageByDbId.get(id)
          return formatSlideEvidence(p?.pageNo ?? 0, pageEvidenceText(p?.text ?? '', p?.visualText))
        }),
      ],
    }))
    const verifyRaw = await metaApi.chat({
      model,
      messages: buildVerifyMessages(items, outputLanguage, citedSlideImages(db, batch, pageByDbId)),
      responseFormat: { name: VERIFY_SCHEMA_NAME, schema: VERIFY_SCHEMA },
    })
    const resolved = applyVerifyResults(
      items.map((item) => item.claimIdx),
      validateVerifyPayload(verifyRaw),
      outputLanguage,
    )
    for (const r of resolved) {
      const claimId = claimIdByIdx.get(r.claimIdx)
      if (claimId === undefined) continue
      setClaimVerdict(db, claimId, r.supported ? 'supported' : 'unsupported', r.reason)
    }
  }
}

/**
 * Images of the distinct cited pages of one batch, in first-cited order,
 * capped at MAX_VERIFY_IMAGES. Pages without a readable image file keep
 * text-only evidence.
 */
function citedSlideImages(
  db: DatabaseSync,
  batch: CitedClaim[],
  pageByDbId: Map<number, NotePage>,
): VerifyImage[] {
  const citedPageIds: number[] = []
  const seen = new Set<number>()
  for (const claim of batch) {
    for (const pageId of claim.pageDbIds) {
      if (!seen.has(pageId)) {
        seen.add(pageId)
        citedPageIds.push(pageId)
      }
    }
  }
  const imagePathById = pageImagePathMap(db, citedPageIds)
  const images: VerifyImage[] = []
  for (const pageId of citedPageIds) {
    if (images.length >= MAX_VERIFY_IMAGES) break
    const imagePath = imagePathById.get(pageId)
    const page = pageByDbId.get(pageId)
    if (imagePath === undefined || page === undefined) continue
    try {
      images.push({ pageNo: page.pageNo, part: imagePartFromFile(imagePath) })
    } catch {
      // Unreadable image file: the page stays text-only evidence.
    }
  }
  return images
}
