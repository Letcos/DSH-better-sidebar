/**
 * dsh-better-sidebar — remote Git backend for the source-control panel.
 *
 * Mirrors `git.ts` (the local backend) function-for-function, but runs every
 * command over the dsh-ssh connection instead of the local `git` binary.
 * Remote repositories are single-root: no child-repo discovery, no linked
 * worktree selection — paths that the local backend resolves against a local
 * checkout resolve against the remote one here.
 *
 * Parsing is reused verbatim from `git.ts` (`parsePorcelainZ` /
 * `parseNumstat` / `parseWorktreeList` / `parseLogLines` /
 * `parseBlamePorcelain`), so the wire shapes are byte-identical and the client
 * needs no change.
 *
 * Command assembly mirrors `git.ts` exactly — same `--no-pager`,
 * `-c color.ui=false`, `-c core.quotePath=false` preamble and the same
 * `--end-of-options` / `--` operand guards — so a remote run cannot be
 * steered by a caller-supplied value any more than a local one can. The
 * preamble lives in {@link remoteGitArgs}; the arguments are shell-quoted
 * individually because `exec` runs them through the remote's shell.
 */
import { posix } from 'node:path'
import {
  GitCommandError,
  parseBlamePorcelain,
  parseLogLines,
  parseNumstat,
  parsePorcelainZ,
  parseWorktreeList,
  type GitBlameLine,
  type GitLineCounts,
  type GitLogEntry,
  type GitStatusEntry,
  type GitStatusResult,
  type GitWorktree,
  type GitWorktreeRecord,
} from './git.ts'
import { shellQuote, type RemoteConn, type RemoteRoute } from './ssh-remote.ts'
import { SidebarError } from './wire.ts'

const DISCOVERY_TIMEOUT_MS = 5_000
const DEFAULT_TIMEOUT_MS = 30_000
/** Upper bound on status rows shipped to the client (mirror of git.ts). */
const GIT_STATUS_LIMIT = 2_000

/**
 * Wrap one git invocation for a remote shell.
 *
 * `-C <dir>` makes every subsequent path relative to the repository, exactly
 * as in the local backend. Arguments are quoted one by one, so a path with a
 * space, quote or `$` reaches git as a single literal word.
 */
function remoteGitCommand(dir: string, args: string[]): string {
  const preamble = ['-C', dir, '--no-pager', '-c', 'color.ui=false', '-c', 'core.quotePath=false']
  return 'git ' + [...preamble, ...args].map(shellQuote).join(' ')
}

/** Run one git command on the remote; resolves with stdout, rejects with GitCommandError. */
async function runGlobalGit(
  conn: RemoteConn,
  dir: string,
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  // GIT_OPTIONAL_LOCKS=0 mirrors the local spawn's env: a status/diff read
  // must never take the index lock on a repository the user is also working in.
  const cmd = 'GIT_OPTIONAL_LOCKS=0 ' + remoteGitCommand(dir, args)
  let r: { code: number; stdout: string; stderr: string }
  try {
    r = await conn.exec(cmd, { timeoutMs })
  } catch (error) {
    throw new GitCommandError(`cannot run git: ${error instanceof Error ? error.message : String(error)}`, 'git-error', args.join(' '))
  }
  if (r.code === 0) return r.stdout
  throw new GitCommandError(r.stderr.trim() || `git exited with ${String(r.code)}`, 'git-error', args.join(' '))
}

/** A remote route is single-rooted: the repository containing `cwd`, or a discovery failure. */
export async function remoteRepoRoot(conn: RemoteConn, cwd: string): Promise<string> {
  try {
    const out = await runGlobalGit(conn, cwd, ['rev-parse', '--show-toplevel'], DISCOVERY_TIMEOUT_MS)
    return out.trim()
  } catch {
    throw new GitCommandError('not a git repository', 'not-repo', 'rev-parse')
  }
}

/** Whether `cwd` sits inside a remote work tree. */
export async function remoteIsGitRepo(conn: RemoteConn, cwd: string): Promise<boolean> {
  try {
    const out = await runGlobalGit(conn, cwd, ['rev-parse', '--is-inside-work-tree'], DISCOVERY_TIMEOUT_MS)
    return out.trim() === 'true'
  } catch {
    return false
  }
}

/** The remote current branch name ('HEAD' when detached). */
async function remoteCurrentBranch(conn: RemoteConn, root: string): Promise<string> {
  const out = await runGlobalGit(conn, root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return out.trim()
}

/**
 * Remote working-tree status. Unlike the local backend there is no
 * child-repository discovery: the remote workspace resolves to ONE repository
 * (a container of several repos is reported as not-a-repo, which the panel
 * renders as its empty state).
 */
export async function remoteStatus(conn: RemoteConn, cwd: string): Promise<GitStatusResult> {
  if (!await remoteIsGitRepo(conn, cwd)) {
    return { isRepo: false, entries: [], repositories: [] }
  }
  const root = await remoteRepoRoot(conn, cwd)
  const [branch, raw, unstagedNumstat, stagedNumstat] = await Promise.all([
    remoteCurrentBranch(conn, root).catch(() => 'HEAD'),
    runGlobalGit(conn, root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    runGlobalGit(conn, root, ['diff', '--numstat', '-z']).catch(() => ''),
    runGlobalGit(conn, root, ['diff', '--cached', '--numstat', '-z']).catch(() => ''),
  ])
  const parsed = parsePorcelainZ(raw)
  const lineCounts = new Map<string, GitLineCounts>()
  for (const side of [parseNumstat(stagedNumstat), parseNumstat(unstagedNumstat)]) {
    for (const [path, counts] of side) {
      const previous = lineCounts.get(path)
      if (previous === undefined) lineCounts.set(path, counts)
      else if (!('additions' in previous) || !('additions' in counts)) lineCounts.set(path, { binary: true })
      else lineCounts.set(path, {
        additions: previous.additions + counts.additions,
        deletions: previous.deletions + counts.deletions,
      })
    }
  }
  const truncated = parsed.length > GIT_STATUS_LIMIT
  const bounded = truncated ? parsed.slice(0, GIT_STATUS_LIMIT) : parsed
  return {
    isRepo: true,
    branch,
    entries: bounded.map((entry): GitStatusEntry => {
      const counts = lineCounts.get(entry.path)
      return counts === undefined ? entry : { ...entry, counts }
    }),
    truncated,
    root,
    repositories: [root],
  }
}

/** Remote linked checkouts of the repository containing `cwd`. */
export async function remoteWorktrees(conn: RemoteConn, cwd: string): Promise<GitWorktree[]> {
  if (!await remoteIsGitRepo(conn, cwd)) return []
  const currentRoot = await remoteRepoRoot(conn, cwd)
  let raw: string
  try {
    raw = await runGlobalGit(conn, currentRoot, ['worktree', 'list', '--porcelain', '-z'])
  } catch {
    raw = await runGlobalGit(conn, currentRoot, ['worktree', 'list', '--porcelain'])
  }
  const listed = parseWorktreeList(raw).filter((entry: GitWorktreeRecord) => !entry.prunable)
  const rows = await Promise.all(listed.map(async (entry): Promise<GitWorktree> => ({
    path: entry.path,
    branch: entry.branch,
    current: entry.path === currentRoot,
    changes: await remoteStatus(conn, entry.path).then(result => result.entries.length, () => 0),
  })))
  return rows.sort((left, right) => Number(right.current) - Number(left.current))
}

/** Resolve an optional client-selected remote linked checkout. */
export async function remoteResolveWorktree(conn: RemoteConn, cwd: string, requested?: string): Promise<string> {
  if (requested === undefined || requested === '') return cwd
  const match = (await remoteWorktrees(conn, cwd)).find(entry => entry.path === requested)
  if (match === undefined) {
    throw new GitCommandError(`unknown linked worktree: ${requested}`, 'git-worktree', 'worktree list')
  }
  return match.path
}

/** Remote diff text of the worktree (unstaged) or the index (staged). */
export async function remoteDiff(conn: RemoteConn, cwd: string, path: string | undefined, staged: boolean): Promise<string> {
  const root = await remoteRepoRoot(conn, cwd)
  const args = ['diff', '--no-ext-diff', '--no-color', '-U3']
  if (staged) args.push('--cached')
  if (path !== undefined) args.push('--', path)
  return runGlobalGit(conn, root, args)
}

/** Remote diff of one file against HEAD (staged + unstaged in one patch). */
export async function remoteDiffHead(conn: RemoteConn, cwd: string, path: string | undefined): Promise<string> {
  const root = await remoteRepoRoot(conn, cwd)
  const tail = path !== undefined ? ['--', path] : []
  try {
    return await runGlobalGit(conn, root, ['diff', '--no-ext-diff', '--no-color', '-U3', 'HEAD', ...tail])
  } catch {
    return runGlobalGit(conn, root, ['diff', '--no-ext-diff', '--no-color', '-U3', '--cached', ...tail])
  }
}

/** Remote stage (all when path is undefined). */
export async function remoteStage(conn: RemoteConn, cwd: string, path: string | undefined): Promise<void> {
  const root = await remoteRepoRoot(conn, cwd)
  await runGlobalGit(conn, root, ['add', '-A', ...(path !== undefined ? ['--', path] : [])])
}

/** Remote unstage (all when path is undefined). */
export async function remoteUnstage(conn: RemoteConn, cwd: string, path: string | undefined): Promise<void> {
  const root = await remoteRepoRoot(conn, cwd)
  await runGlobalGit(conn, root, ['reset', '-q', ...(path !== undefined ? ['--', path] : [])])
}

/** Remote commit of the staged changes (user's global identity untouched). */
export async function remoteCommit(conn: RemoteConn, cwd: string, message: string): Promise<void> {
  const root = await remoteRepoRoot(conn, cwd)
  await runGlobalGit(conn, root, ['commit', '-m', message])
}

/** Remote branch names (current first). */
export async function remoteBranches(conn: RemoteConn, cwd: string): Promise<{ current: string; names: string[] }> {
  const root = await remoteRepoRoot(conn, cwd)
  const [current, raw] = await Promise.all([
    remoteCurrentBranch(conn, root).catch(() => 'HEAD'),
    runGlobalGit(conn, root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
  ])
  const names = raw.split('\n').filter(line => line !== '')
  return { current, names: names.includes(current) ? names : [current, ...names] }
}

/** Remote branch switch (same `--end-of-options` operand guard as git.ts). */
export async function remoteCheckout(conn: RemoteConn, cwd: string, branch: string): Promise<void> {
  const root = await remoteRepoRoot(conn, cwd)
  await runGlobalGit(conn, root, ['checkout', '--end-of-options', branch])
}

/** Remote commit history (newest first), lazily pageable via skip/count. */
export async function remoteLog(conn: RemoteConn, cwd: string, count = 30, skip = 0): Promise<GitLogEntry[]> {
  const root = await remoteRepoRoot(conn, cwd)
  const raw = await runGlobalGit(conn, root, [
    'log', '-n', String(count), '--skip', String(skip), '--decorate=short',
    '--pretty=format:%h%x1f%s%x1f%an%x1f%ai%x1f%H%x1f%D',
  ])
  return parseLogLines(raw)
}

/** Remote file content at a revision, or null when that revision has no such path. */
export async function remoteShow(conn: RemoteConn, cwd: string, rev: string, path: string): Promise<string | null> {
  try {
    const root = await remoteRepoRoot(conn, cwd)
    return await runGlobalGit(conn, root, ['show', '--end-of-options', `${rev}:${path}`])
  } catch {
    return null
  }
}

/** Remote full patch text of one commit. */
export async function remoteCommitDiff(conn: RemoteConn, cwd: string, hash: string): Promise<string> {
  const root = await remoteRepoRoot(conn, cwd)
  return runGlobalGit(conn, root, ['show', '--no-ext-diff', '--no-color', '--format=', '-m', '--first-parent', '--end-of-options', hash])
}

/** Remote discard of one path's worktree changes (index untouched). */
export async function remoteDiscard(conn: RemoteConn, cwd: string, path: string): Promise<void> {
  const root = await remoteRepoRoot(conn, cwd)
  await runGlobalGit(conn, root, ['checkout', '--', path])
}

/** Remote revert of one commit onto the current branch. */
export async function remoteRevert(conn: RemoteConn, cwd: string, hash: string): Promise<void> {
  const root = await remoteRepoRoot(conn, cwd)
  await runGlobalGit(conn, root, ['revert', '--no-edit', '--end-of-options', hash])
}

/** Remote cherry-pick of one commit onto the current branch. */
export async function remoteCherryPick(conn: RemoteConn, cwd: string, hash: string): Promise<void> {
  const root = await remoteRepoRoot(conn, cwd)
  await runGlobalGit(conn, root, ['cherry-pick', '--end-of-options', hash])
}

/** Remote push of the current branch to its upstream. */
export async function remotePush(conn: RemoteConn, cwd: string): Promise<void> {
  const root = await remoteRepoRoot(conn, cwd)
  await runGlobalGit(conn, root, ['push'], 120_000)
}

/** Remote fast-forward-only pull. */
export async function remotePull(conn: RemoteConn, cwd: string): Promise<void> {
  const root = await remoteRepoRoot(conn, cwd)
  await runGlobalGit(conn, root, ['pull', '--ff-only'], 120_000)
}

/**
 * Remote blame of one line range. Every failure mode resolves to an EMPTY
 * result (mirror of git.ts): the editor's hover tooltip shows nothing rather
 * than breaking the editing surface.
 */
export async function remoteBlame(
  conn: RemoteConn,
  cwd: string,
  path: string,
  startLine: number,
  endLine: number,
): Promise<GitBlameLine[]> {
  try {
    const root = await remoteRepoRoot(conn, cwd)
    const output = await runGlobalGit(conn, root, [
      'blame', '--porcelain', '-L', `${String(startLine)},${String(endLine)}`, '--', path,
    ])
    return parseBlamePorcelain(output)
  } catch {
    return []
  }
}

/**
 * Run `fn` with a remote git connection when `cwd` is a remote placeholder
 * path; null when local (the caller runs the local backend).
 */
export async function withRemoteGit<T>(
  conn: RemoteConn,
  route: RemoteRoute,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof SidebarError || error instanceof GitCommandError) throw error
    throw new GitCommandError(
      `remote git failed in ${route.remoteCwd}: ${error instanceof Error ? error.message : String(error)}`,
      'git-error',
      'remote',
    )
  }
}

/** Join a remote directory with one client-supplied name (single segment). */
export function remoteJoin(dir: string, name: string): string {
  return posix.join(dir, name)
}
