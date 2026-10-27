/**
 * Small pure renderer helpers (no React imports, so they stay unit-testable
 * under the node vitest setup).
 */

/** File name without directories or extension, for landing-created notes. */
export function noteTitleFromPath(filePath: string): string {
  const base = filePath.split(/[/\\]/).pop() ?? filePath
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  return stem.trim().length > 0 ? stem.trim() : base
}

/**
 * True for blocking errors (budget cap, missing API key): those keep the
 * blocking error banner. Everything else goes to an error toast.
 */
export function isBlockingError(message: string): boolean {
  return /예산|budget|cap|상한|API\s*키|api\s*key|keychain|키체인/i.test(message)
}

/**
 * Target scrollTop that places a child at the top (with a margin) or in the
 * center of its scroll container. Pure, so the scroll math is testable;
 * callers apply it with `container.scrollTo`, never `scrollIntoView` (which
 * also scrolls overflow-hidden ancestors and shifts the window chrome).
 */
export function scrollTopFor(
  container: { top: number; height: number; scrollTop: number },
  child: { top: number; height: number },
  align: 'start' | 'center',
  margin = 12,
): number {
  const offset = child.top - container.top + container.scrollTop
  const target =
    align === 'center' ? offset - (container.height - child.height) / 2 : offset - margin
  return Math.max(0, Math.round(target))
}
