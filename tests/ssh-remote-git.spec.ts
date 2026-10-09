/**
 * Remote git routing: the path-resolution helpers must ask the REMOTE
 * repository, never the local placeholder.
 *
 * These pin a real regression. The editor's diff pane sends a `repoRoot` with
 * every `git.diff` request; the host resolved that path with the LOCAL
 * `git.repoRoot`, which runs `git -C <placeholder>` on the DSH machine — where
 * the placeholder is an empty directory holding no repository. The fail
 * surfaced as "加载差异失败: not a git repository" for every changed file in a
 * remote workspace, while the status list above it rendered fine (that route
 * never resolves a repo root).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import {
  isRemoteAbsolute,
  localToRemote,
  resolveRemotePath,
  routeByCwd,
  type RemoteConn,
  type RemoteRoute,
} from '../src/ssh-remote.ts'
import * as gitRemote from '../src/git-remote.ts'

const PREV_ROOT = process.env.DSH_SSH_REMOTE_ROOT
const ROOT = process.platform === 'win32' ? 'C:\\dsh-remote-root' : '/tmp/dsh-remote-root'

afterEach(() => {
  if (PREV_ROOT === undefined) delete process.env.DSH_SSH_REMOTE_ROOT
  else process.env.DSH_SSH_REMOTE_ROOT = PREV_ROOT
})

/** A connection whose exec answers from a scripted table, recording every command. */
function scriptedConn(handlers: (cmd: string) => { code: number; stdout: string; stderr: string }): RemoteConn & { commands: string[] } {
  const commands: string[] = []
  const conn = {
    commands,
    exec: async (cmd: string) => {
      commands.push(cmd)
      return handlers(cmd)
    },
    fs: async () => ({
      stat: async () => ({ type: 'directory' as const }),
      listDir: async () => [],
      readBytes: async () => Buffer.alloc(0),
      writeFileAtomic: async () => {},
    }),
  } as unknown as RemoteConn & { commands: string[] }
  return conn
}

const REMOTE_CWD = '/home/dev/proj'

function routeFor(): RemoteRoute {
  process.env.DSH_SSH_REMOTE_ROOT = ROOT
  const placeholder = join(ROOT, 'a-host', Buffer.from(REMOTE_CWD, 'utf8').toString('base64url'))
  const route = routeByCwd(placeholder)
  if (route.kind !== 'remote') throw new Error('expected a remote route')
  return route
}

describe('remote git path resolution', () => {
  it('resolves the repository root on the REMOTE host, not locally', async () => {
    const route = routeFor()
    const conn = scriptedConn((cmd) => {
      // The remote repo root answers the rev-parse; the placeholder never does.
      if (cmd.includes('rev-parse') && cmd.includes('--show-toplevel')) {
        return { code: 0, stdout: `${REMOTE_CWD}\n`, stderr: '' }
      }
      return { code: 1, stdout: '', stderr: 'fatal: not a git repository' }
    })

    const root = await gitRemote.remoteRepoRoot(conn, REMOTE_CWD)
    expect(root).toBe(REMOTE_CWD)
    // The lookup ran against the REMOTE path.
    expect(conn.commands.some((cmd) => cmd.includes(REMOTE_CWD))).toBe(true)
  })

  it('fails loudly when the remote path is not a repository', async () => {
    const route = routeFor()
    void route
    const conn = scriptedConn(() => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' }))
    await expect(gitRemote.remoteRepoRoot(conn, REMOTE_CWD)).rejects.toThrow(/not a git repository/)
  })

  it('remoteStatus never shells into the local placeholder', async () => {
    const route = routeFor()
    const seen: string[] = []
    const conn = scriptedConn((cmd) => {
      seen.push(cmd)
      if (cmd.includes('--is-inside-work-tree')) return { code: 0, stdout: 'true\n', stderr: '' }
      if (cmd.includes('--show-toplevel')) return { code: 0, stdout: `${REMOTE_CWD}\n`, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    await gitRemote.remoteStatus(conn, REMOTE_CWD)
    // Every command carries the REMOTE path; none mentions the placeholder root.
    expect(seen.length).toBeGreaterThan(0)
    for (const cmd of seen) {
      expect(cmd).toContain(REMOTE_CWD)
      expect(cmd).not.toContain(ROOT)
    }
    void route
  })

  it('translates a remote repo root back onto the placeholder for the client', () => {
    const route = routeFor()
    // What the git routes compose: the placeholder a route holds ↔ the remote
    // path a remote git command must receive.
    expect(localToRemote(route.placeholderCwd, route)).toBe(REMOTE_CWD)
    expect(route.remoteCwd).toBe(REMOTE_CWD)
  })
})

/**
 * A remote absolute path must never be routed through a LOCAL path primitive.
 *
 * Pins the doubled-path failure: `win32.resolve('/home/u/proj/docs/x.md')`
 * yields `D:\home\u\proj\docs\x.md`, and feeding THAT back through the
 * local→remote translation produced
 * `/home/u/proj/D:\home\u\proj\docs\x.md` — the "not found" the user saw when
 * opening a file (the changes pane and the untracked-file read both hit it).
 */
describe('remote path resolution never drive-roots', () => {
  it('passes a remote absolute path through unchanged', () => {
    const route = routeFor()
    const remoteFile = `${REMOTE_CWD}/docs/implementation/IMPL-65.md`
    expect(isRemoteAbsolute(remoteFile)).toBe(true)
    expect(resolveRemotePath(remoteFile, route)).toBe(remoteFile)
  })

  it('never produces a doubled path containing a Windows drive letter', () => {
    const route = routeFor()
    const remoteFile = `${REMOTE_CWD}/docs/implementation/IMPL-65.md`
    const resolved = resolveRemotePath(remoteFile, route)
    expect(resolved).not.toContain(':\\')
    expect(resolved).not.toContain('\\')
    // The exact corruption shape reported: remote cwd + a drive-rooted copy.
    expect(resolved).not.toBe(`${REMOTE_CWD}/D:${remoteFile.replace(/\//g, '\\')}`)
  })

  it('re-anchors a placeholder-spelled path onto the remote cwd', () => {
    const route = routeFor()
    // The client hands back the placeholder path it was shown.
    const placeholderFile = join(route.placeholderCwd, 'src', 'app.ts')
    expect(resolveRemotePath(placeholderFile, route)).toBe(`${REMOTE_CWD}/src/app.ts`)
  })

  it('joins a repository-relative name onto the remote cwd', () => {
    const route = routeFor()
    expect(resolveRemotePath('config/components.toml', route)).toBe(`${REMOTE_CWD}/config/components.toml`)
  })

  it('normalizes a remote path lexically without a Windows primitive', () => {
    const route = routeFor()
    expect(resolveRemotePath(`${REMOTE_CWD}/a/../b.txt`, route)).toBe(`${REMOTE_CWD}/b.txt`)
  })

  it('keeps a remote path OUTSIDE the workspace untouched', () => {
    const route = routeFor()
    expect(resolveRemotePath('/etc/hosts', route)).toBe('/etc/hosts')
  })
})

describe('remote diff argument flow', () => {
  it('passes the repository-relative path through to the remote git command', async () => {
    const route = routeFor()
    const conn = scriptedConn((cmd) => {
      if (cmd.includes('--show-toplevel')) return { code: 0, stdout: `${REMOTE_CWD}\n`, stderr: '' }
      if (cmd.includes(`'diff'`)) return { code: 0, stdout: 'diff --git a/x b/x\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const diff = await gitRemote.remoteDiff(conn, REMOTE_CWD, 'src/app.ts', false)
    expect(diff).toContain('diff --git')
    const diffCmd = conn.commands.find((cmd) => cmd.includes(`'diff'`))
    expect(diffCmd).toBeDefined()
    expect(diffCmd).toContain('src/app.ts')
    expect(diffCmd).toContain(REMOTE_CWD)
    void route
  })

  it('reports a git failure with git stderr rather than a generic error', async () => {
    const route = routeFor()
    void route
    const conn = scriptedConn((cmd) => {
      if (cmd.includes('--show-toplevel')) return { code: 0, stdout: `${REMOTE_CWD}\n`, stderr: '' }
      return { code: 128, stdout: '', stderr: 'fatal: bad revision' }
    })
    await expect(gitRemote.remoteDiff(conn, REMOTE_CWD, undefined, false)).rejects.toThrow(/bad revision/)
  })
})
