/**
 * dsh-better-sidebar — remote Git backend for the source-control panel.
 *
 * Mirrors `git.ts` (the local backend) one-for-one, but runs every command
 * over the dsh-ssh connection instead of the local `git` binary. Remote
 * repositories are single-root: no child-repo discovery, no linked-worktree
 * selection — `git rev-parse --show-toplevel` yields the one repository root,
 * and every command runs with that root as the working directory.
 *
 * Parsing is reused verbatim from `git.ts` (parsePorcelainZ / parseLogLines),
 * so the wire shapes are byte-identical and the client needs no change.
 */
import {
  GitCommandError,
  parseLogLines,
  parsePorcelainZ,
  type GitLogEntry,
  type GitStatusResult,
  type GitWorktree,
} from './git.ts'
import type { RemoteConn } from './ssh-remote.ts'
import { posix } from 'node:path'

const GIT_STATUS_LIMIT = 2_000
const DISCOVERY_TIMEOUT_MS = 5_000

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/** Run one git command over SSH; non-zero exit throws the shared GitCommandError. */
async function runGitRemote(conn: RemoteConn, cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  const full = 'git --no-pager -c color.ui=false ' + args.map(shellQuote).join(' ')
  const result = await conn.exec(full, { cwd, timeoutMs })
  if (result.code !== 0) {
    throw new GitCommandError(result.stderr.trim() || `git exited with ${String(result.code)}`, 'git-error', args.join(' '))
  }
  return result.stdout
}

/** The repository top level containing `cwd`; throws 'not a git repository' otherwise. */
export async function remoteRepoRoot(conn: RemoteConn, cwd: string): Promise<string> {
  try {
    return (await runGitRemote(conn, cwd, ['rev-parse', '--show-toplevel'], DISCOVERY_TIMEOUT_MS)).trim()
  } catch (error) {
    if (error instanceof GitCommandError) throw error
    throw new GitCommandError('not a git repository', 'not-repo', 'rev-parse')
  }
}

/** Working-tree status (untracked included), single-root. */
export async function remoteStatus(conn: RemoteConn, cwd: string): Promise<GitStatusResult> {
  let root: string
  try {
    root = await remoteRepoRoot(conn, cwd)
  } catch {
    return { isRepo: false, entries: [], repositories: [] }
  }
  const [branch, raw] = await Promise.all([
    runGitRemote(conn, root, ['rev-parse', '--abbrev-ref', 'HEAD']).then((out) => out.trim()).catch(() => 'HEAD'),
    runGitRemote(conn, root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  ])
  const parsed = parsePorcelainZ(raw)
  const truncated = parsed.length > GIT_STATUS_LIMIT
  return {
    isRepo: true,
    branch,
    entries: truncated ? parsed.slice(0, GIT_STATUS_LIMIT) : parsed,
    truncated,
    root,
    repositories: [root],
  }
}

/** Diff text of the worktree (unstaged) or the index (staged). */
export async function remoteDiff(conn: RemoteConn, cwd: string, path: string | undefined, staged: boolean): Promise<string> {
  const root = await remoteRepoRoot(conn, cwd)
  const args = ['diff', '--no-ext-diff', '--no-color', '-U3']
  if (staged) args.push('--cached')
  if (path !== undefined) args.push('--', path)
  return runGitRemote(conn, root, args)
}

/** Stage paths (all when path is undefined). */
export async function remoteStage(conn: RemoteConn, cwd: string, path: string | undefined): Promise<void> {
  await runGitRemote(conn, await remoteRepoRoot(conn, cwd), ['add', '-A', ...(path !== undefined ? ['--', path] : [])])
}

/** Unstage paths (all when path is undefined). */
export async function remoteUnstage(conn: RemoteConn, cwd: string, path: string | undefined): Promise<void> {
  await runGitRemote(conn, await remoteRepoRoot(conn, cwd), ['reset', '-q', ...(path !== undefined ? ['--', path] : [])])
}

/** Commit staged changes with a message. */
export async function remoteCommit(conn: RemoteConn, cwd: string, message: string): Promise<void> {
  await runGitRemote(conn, await remoteRepoRoot(conn, cwd), ['commit', '-m', message])
}

/** Branch names (current first). */
export async function remoteBranches(conn: RemoteConn, cwd: string): Promise<{ current: string; names: string[] }> {
  const root = await remoteRepoRoot(conn, cwd)
  const [current, raw] = await Promise.all([
    runGitRemote(conn, root, ['rev-parse', '--abbrev-ref', 'HEAD']).then((out) => out.trim()).catch(() => 'HEAD'),
    runGitRemote(conn, root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
  ])
  const names = raw.split('\n').filter((line) => line !== '')
  return { current, names: names.includes(current) ? names : [current, ...names] }
}

/** Switch to an existing branch. */
export async function remoteCheckout(conn: RemoteConn, cwd: string, branch: string): Promise<void> {
  await runGitRemote(conn, await remoteRepoRoot(conn, cwd), ['checkout', branch])
}

/** Recent commit history, lazily pageable. */
export async function remoteLog(conn: RemoteConn, cwd: string, count = 30, skip = 0): Promise<GitLogEntry[]> {
  const raw = await runGitRemote(conn, await remoteRepoRoot(conn, cwd), [
    'log', '-n', String(count), '--skip', String(skip), '--decorate=short',
    '--pretty=format:%h%x1f%s%x1f%an%x1f%ai%x1f%H%x1f%D',
  ])
  return parseLogLines(raw)
}

/** Content of a file at a revision, or null when the revision lacks the path. */
export async function remoteShow(conn: RemoteConn, cwd: string, rev: string, path: string): Promise<string | null> {
  try {
    // `git show <rev>:<path>` takes a REPO-ROOT-RELATIVE path (absolute paths
    // are rejected with "fatal: path ... does not exist in 'HEAD'"), so strip
    // the repository root from the absolute remote path before quoting.
    const root = await remoteRepoRoot(conn, cwd)
    const rel = posix.relative(root, path)
    if (rel === '' || rel.startsWith('..') || posix.isAbsolute(rel)) return null
    return await runGitRemote(conn, root, ['show', `${rev}:${rel}`])
  } catch {
    return null
  }
}

/** Full patch text of one commit. */
export async function remoteCommitDiff(conn: RemoteConn, cwd: string, hash: string): Promise<string> {
  return runGitRemote(conn, await remoteRepoRoot(conn, cwd), ['show', '--no-ext-diff', '--no-color', '--format=', '-m', '--first-parent', hash])
}

/** Discard worktree changes of one path. */
export async function remoteDiscard(conn: RemoteConn, cwd: string, path: string): Promise<void> {
  await runGitRemote(conn, await remoteRepoRoot(conn, cwd), ['checkout', '--', path])
}

/** Revert one commit with an auto-generated message. */
export async function remoteRevert(conn: RemoteConn, cwd: string, hash: string): Promise<void> {
  await runGitRemote(conn, await remoteRepoRoot(conn, cwd), ['revert', '--no-edit', hash])
}

/** Cherry-pick one commit. */
export async function remoteCherryPick(conn: RemoteConn, cwd: string, hash: string): Promise<void> {
  await runGitRemote(conn, await remoteRepoRoot(conn, cwd), ['cherry-pick', hash])
}

/** Linked checkouts of the repository containing `cwd`. Remote is single-root:
 *  the one current checkout is returned (or empty when not a repo). */
export async function remoteWorktrees(conn: RemoteConn, cwd: string): Promise<GitWorktree[]> {
  try {
    const root = await remoteRepoRoot(conn, cwd)
    const branch = (await runGitRemote(conn, root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD')).trim()
    const result = await remoteStatus(conn, root)
    return [{ path: root, branch, current: true, changes: result.entries.length }]
  } catch {
    return []
  }
}
