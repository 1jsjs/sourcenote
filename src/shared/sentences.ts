/**
 * Pure sentence splitting shared by the main check pipeline and the
 * renderer (which needs the same count for skeleton rows). No validation
 * here: callers decide what empty/too-many means.
 */

/**
 * Splits user notes into sentences: split on newlines and on
 * sentence-ending `.`, `?`, `!` (which covers the Korean `다.` ending)
 * boundaries; trim; drop empties. A '.' between digits (3.14, 0.5) is a
 * decimal point, not a sentence end.
 */
export function splitSentences(text: string): string[] {
  const sentences: string[] = []
  for (const line of text.split('\n')) {
    const matches = line.match(/(?:\d\.\d|[^.?!])+(?:[.?!]+|$)/g)
    if (!matches) continue
    for (const m of matches) {
      const trimmed = m.trim()
      if (trimmed.length > 0) sentences.push(trimmed)
    }
  }
  return sentences
}
