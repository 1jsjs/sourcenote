import type { DatabaseSync } from 'node:sqlite'
import type { AppLanguage, NotePage } from '../shared/types'
import { insertClaimsWithCitations, setClaimVerdict, type NewClaim, type NoteSegment } from './db'
import {
  applyVerifyResults,
  buildVerifyMessages,
  formatSlideEvidence,
  formatTranscriptEvidence,
  splitBatches,
  VERIFY_SCHEMA,
  VERIFY_SCHEMA_NAME,
  validateVerifyPayload,
  type VerifyItem,
} from './grounding'
import type { MetaApi } from './meta-api'

/**
 * Shared second half of every grounded pipeline (summary, notes check, Q&A):
 * store the cited claims, then verify each one against ONLY its cited
 * evidence, in batches. A claim with no citations is stored as unsupported
 * with `zeroCitationReason` and never sent for verification.
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
  language: AppLanguage
  summaryId: number
  claims: CitedClaim[]
  segments: NoteSegment[]
  pages: NotePage[]
  zeroCitationReason: string
  /** Called once the claims are stored, right before the first verify call. */
  onVerifying?: () => void
}

export async function storeAndVerifyClaims(opts: StoreAndVerifyOptions): Promise<void> {
  const { db, metaApi, model, language, claims } = opts
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
          return formatSlideEvidence(p?.pageNo ?? 0, p?.text ?? '')
        }),
      ],
    }))
    const verifyRaw = await metaApi.chat({
      model,
      messages: buildVerifyMessages(items, language),
      responseFormat: { name: VERIFY_SCHEMA_NAME, schema: VERIFY_SCHEMA },
    })
    const resolved = applyVerifyResults(
      items.map((item) => item.claimIdx),
      validateVerifyPayload(verifyRaw),
      language,
    )
    for (const r of resolved) {
      const claimId = claimIdByIdx.get(r.claimIdx)
      if (claimId === undefined) continue
      setClaimVerdict(db, claimId, r.supported ? 'supported' : 'unsupported', r.reason)
    }
  }
}
