/**
 * The root the explorer and the git panel should use for one session.
 *
 * The client session list carries the session HEADER cwd, captured once when
 * the session started. The HOST is the authority on where the session is
 * actually working, because it can follow the agent into a linked git worktree
 *  including one belonging to a different repository. Ask the host, prefer
 * its answer, and re-ask when the window regains focus, when a file refresh is
 * requested, and on a slow timer so a mid-session worktree move is picked up.
 *
 * Shared by both client surfaces: the plugin's own sidebar shell
 * (`Sidebar.tsx`) and the native DSH right-sidebar tab body
 * (`native/tab-adapter.tsx`). They used to disagree  the native body read the
 * frozen list summary directly, so a host-side worktree change never reached
 * the file list drawn in the host's own right Sidebar.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { Context } from '../context-types.ts'
import { api } from './api.ts'

/** How often the host is re-asked while the document is visible. */
const SESSION_ROOT_POLL_MS = 5_000

/**
 * Resolve the live workspace root for one session.
 * @param ctx - client plugin context (owns the session list feed + API).
 * @param sessionId - the session to resolve; `undefined` resolves to `undefined`.
 * @returns the host's active root, falling back to the list summary cwd.
 */
export function useSessionRoot(ctx: Context, sessionId: string | undefined): string | undefined {
  return useSessionRootInfo(ctx, sessionId).cwd
}

/**
 * Just the display label, and tolerant of a missing context.
 *
 * The explorer renders under hosts (and in tests) that supply no client
 * context; those callers get `undefined` and keep the plain basename title
 * rather than losing the tree.
 * @param ctx - client plugin context, or undefined.
 * @param sessionId - the session to resolve.
 * @returns the host's readable root label, or undefined.
 */
export function useSessionRootLabel(ctx: Context | undefined, sessionId: string | undefined): string | undefined {
  // Hooks must run unconditionally; the no-context case answers undefined
  // without touching the session feed.
  const info = useSessionRootInfo(ctx as Context, ctx === undefined ? undefined : sessionId)
  return ctx === undefined ? undefined : info.label
}

/** The host's root plus the label the tree should draw for it. */
export interface SessionRootInfo {
  cwd: string | undefined
  /**
   * Display label for the root, when the host supplies a better one than the
   * path's own basename. A dsh-ssh remote workspace's cwd is a local
   * placeholder whose basename is an unreadable base64 segment; the host
   * answers `<host name> / <remote basename>` for it. Absent for a local cwd,
   * where the client's own `baseName` is already correct.
   */
  label: string | undefined
}

/**
 * Resolve the live workspace root AND its display label for one session.
 *
 * Split from {@link useSessionRoot} so the explorer can draw the host's
 * readable root label without a second request: both fields come from the same
 * `session.cwd` answer.
 * @param ctx - client plugin context.
 * @param sessionId - the session to resolve.
 * @returns the host's active root and its optional display label.
 */
export function useSessionRootInfo(ctx: Context, sessionId: string | undefined): SessionRootInfo {
  // A caller without a context (a stripped-down host, a component test) has no
  // session feed to read; answer the empty result without subscribing.
  const hasCtx = ctx !== undefined && ctx !== null
  const summaryCwd = useSyncExternalStore(
    useMemo(
      () => hasCtx ? (listener: () => void) => ctx.sessions.list.subscribe(listener) : () => () => {},
      [ctx, hasCtx],
    ),
    () => (hasCtx && sessionId !== undefined ? ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd : undefined),
  )
  const [fetched, setFetched] = useState<{ sessionId: string; cwd: string; root: string } | undefined>(undefined)

  useEffect(() => {
    if (!hasCtx || sessionId === undefined) return
    let cancelled = false
    const load = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      api.sessionCwd({ sessionId })
        .then(result => {
          if (cancelled) return
          setFetched(previous => (
            previous !== undefined && previous.sessionId === sessionId && previous.cwd === result.cwd
              && previous.root === result.root
              ? previous
              : { sessionId, cwd: result.cwd, root: result.root }
          ))
        })
        .catch(() => { /* the explorer/git rows surface their own errors */ })
    }
    load()
    window.addEventListener('focus', load)
    window.addEventListener('dsh-sidebar:refresh-files', load)
    const timer = window.setInterval(load, SESSION_ROOT_POLL_MS)
    return () => {
      cancelled = true
      window.removeEventListener('focus', load)
      window.removeEventListener('dsh-sidebar:refresh-files', load)
      window.clearInterval(timer)
    }
  }, [ctx, hasCtx, sessionId])

  const live = fetched !== undefined && fetched.sessionId === sessionId ? fetched : undefined
  const cwd = live?.cwd ?? summaryCwd
  // Only forward a label the host actually computed for THIS cwd; a stale
  // fetch from a previous session must never title the current tree.
  const label = live !== undefined && live.cwd === cwd && live.root !== '' ? live.root : undefined
  return { cwd, label }
}
