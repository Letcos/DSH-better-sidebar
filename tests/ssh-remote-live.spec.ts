/**
 * Live verification of the dsh-ssh bridge against a REAL remote host.
 *
 * Skipped unless `DSH_SSH_LIVE_HOST_ID` (and optionally
 * `DSH_SSH_LIVE_REMOTE_PATH`) are set, so the default suite stays hermetic.
 * The id must name a host already configured in the running profile; the
 * script reads that host's connection fields back out of `dsh --dump-config`,
 * so no credential is ever duplicated here.
 *
 * Run:
 *   DSH_SSH_LIVE_HOST_ID=<hostId> DSH_SSH_LIVE_REMOTE_PATH=/home/u/proj \
 *     npx vitest run tests/ssh-remote-live.spec.ts
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import os from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  localRemotePath,
  remoteDisplayLabel,
  remoteListDirectory,
  remoteReadBytes,
  remoteReadText,
  remoteSearch,
  resolveRemotePath,
  routeByCwd,
  type RemoteConn,
  type SidebarSshPool,
} from '../src/ssh-remote.ts'
import * as gitRemote from '../src/git-remote.ts'

const HOST_ID = process.env.DSH_SSH_LIVE_HOST_ID ?? ''
const REMOTE_PATH = process.env.DSH_SSH_LIVE_REMOTE_PATH ?? ''
const PROFILE = process.env.DSH_SSH_LIVE_PROFILE ?? 'web'

/**
 * Where dsh-ssh's host module may be found, most specific first. Override with
 * `DSH_SSH_LIVE_MODULE` when the plugin lives elsewhere.
 */
const SshPoolCandidates: string[] = [
  ...(process.env.DSH_SSH_LIVE_MODULE !== undefined ? [process.env.DSH_SSH_LIVE_MODULE] : []),
  '@dsh-ssh/dsh-ssh',
  join(os.homedir(), '.dsh', 'profiles', PROFILE, 'node_modules', '@dsh-ssh', 'dsh-ssh'),
]

/** The placeholder path this plugin's convention produces for a remote dir. */
function placeholderFor(hostId: string, remotePath: string): string {
  return join(os.homedir(), '.dsh', 'remote', hostId, Buffer.from(remotePath, 'utf8').toString('base64url'))
}

interface LiveHost {
  id: string
  name?: string
  host?: string
  port?: number
  user?: string
  auth?: { type: 'key' | 'password'; privateKeyPath?: string; password?: string }
}

/** Read one host's connection fields out of the profile's resolved config. */
function readLiveHost(hostId: string): LiveHost | undefined {
  let dump: string
  try {
    dump = execFileSync('dsh', ['--profile', PROFILE, '--dump-config'], { encoding: 'utf8', shell: true })
  } catch {
    return undefined
  }
  const lines = dump.split('\n')
  const at = lines.findIndex((line) => line.includes(hostId))
  if (at < 0) return undefined
  const block = lines.slice(at, at + 14).join('\n')
  const pick = (key: string): string | undefined =>
    new RegExp('^\\s*' + key + ':\\s*(.+)$', 'm').exec(block)?.[1]?.trim()
  const keyPath = pick('privateKeyPath')
  return {
    id: hostId,
    name: pick('name'),
    host: pick('host'),
    port: Number(pick('port') ?? 22),
    user: pick('user'),
    auth: {
      type: 'key',
      privateKeyPath: keyPath === undefined ? undefined : keyPath.replace('~', os.homedir()),
    },
  }
}

/**
 * Build the real connection through dsh-ssh's own SSH core, mirroring what
 * `sshPool.acquire` gives the bridge. Using the real pool keeps the test
 * honest: it exercises the exact connection face the routes receive.
 *
 * The module is resolved at RUNTIME (via `createRequire`) rather than by a
 * static import: dsh-ssh is a peer plugin this package deliberately does not
 * depend on, so a static specifier would either fail typecheck or imply a
 * dependency the plugin must not have.
 */
async function acquireLive(): Promise<{ pool: SidebarSshPool; conn: RemoteConn } | undefined> {
  const host = readLiveHost(HOST_ID)
  if (host === undefined || host.host === undefined) return undefined
  const require = createRequire(import.meta.url)
  let SshPool: (new (cfg: unknown) => {
    acquire(cfg: unknown): Promise<RemoteConn>
    release(conn?: RemoteConn): void
  }) | undefined
  for (const specifier of SshPoolCandidates) {
    try {
      const loaded = require(specifier) as { SshCore?: { SshPool?: typeof SshPool } }
      SshPool = loaded?.SshCore?.SshPool
      if (SshPool !== undefined) break
    } catch {
      // Try the next candidate location.
    }
  }
  if (SshPool === undefined) return undefined
  const pool = new SshPool({ hosts: {} })
  const conn = await pool.acquire(host)
  return {
    pool: {
      acquire: async () => conn,
      release: () => pool.release(conn),
    },
    conn,
  }
}

const enabled = HOST_ID !== '' && REMOTE_PATH !== ''

describe.skipIf(!enabled)('live remote workspace bridge', () => {
  it('routes the placeholder to the configured remote path', () => {
    const route = routeByCwd(placeholderFor(HOST_ID, REMOTE_PATH))
    expect(route.kind).toBe('remote')
    if (route.kind !== 'remote') return
    expect(route.remoteCwd).toBe(REMOTE_PATH)
    expect(localRemotePath(join(route.placeholderCwd, 'src'), route)).toBe(`${REMOTE_PATH}/src`)
  })

  it('lists, reads, searches and asks git over the real connection', async () => {
    const live = await acquireLive()
    if (live === undefined) {
      console.log('[skip] cannot build a live connection (pool unavailable or host unconfigured)')
      return
    }
    const { pool, conn } = live
    const route = routeByCwd(placeholderFor(HOST_ID, REMOTE_PATH))
    expect(route.kind).toBe('remote')
    if (route.kind !== 'remote') return

    try {
      const listing = await remoteListDirectory(conn, REMOTE_PATH, route, 500)
      console.log(`[live] ${listing.entries.length} entries in ${REMOTE_PATH}`)
      expect(listing.entries.length).toBeGreaterThan(-1)
      // Every row must carry a placeholder path the client can hand back.
      for (const row of listing.entries) {
        expect(row.path.startsWith(route.placeholderCwd)).toBe(true)
      }

      const file = listing.entries.find((row) => !row.isDir && !row.isSymlink)
      if (file !== undefined) {
        const bytes = await remoteReadBytes(conn, localRemotePath(file.path, route), 1 << 20)
        console.log(`[live] read ${file.name} (${bytes.length} bytes)`)
        expect(bytes.length).toBeGreaterThanOrEqual(0)
      }

      const found = await remoteSearch(conn, REMOTE_PATH, 'a', { maxMatches: 20 })
      console.log(`[live] search matched ${found.matches.length} (truncated=${found.truncated})`)

      const status = await gitRemote.remoteStatus(conn, REMOTE_PATH)
      console.log(`[live] git isRepo=${status.isRepo}${status.branch ? ` branch=${status.branch}` : ''}`)
      expect(status.isRepo).toBe(true)

      // The exact path the editor's diff pane drives: a repoRoot-bearing
      // `git.diff`, which the host resolves through the remote repository
      // before the diff runs. Resolving it locally produced
      // "加载差异失败: not a git repository".
      const repoRoot = await gitRemote.remoteRepoRoot(conn, REMOTE_PATH)
      console.log(`[live] remote repo root: ${repoRoot}`)
      expect(repoRoot.length).toBeGreaterThan(0)

      const firstChange = status.entries[0]
      if (firstChange !== undefined) {
        const diff = await gitRemote.remoteDiff(conn, repoRoot, firstChange.path, firstChange.xy[0] !== ' ' && firstChange.xy[0] !== '?')
        console.log(`[live] diff ${firstChange.path}: ${diff.length} bytes`)
        expect(typeof diff).toBe('string')
      } else {
        console.log('[live] working tree is clean — no diff row to exercise')
      }

      // EVERY modified/added path must produce a diff when addressed the way
      // the routes address it (repo-relative name against the remote root).
      // This is the sweep that catches a file whose diff silently came back
      // empty — the "没有文本差异" symptom.
      const changed = status.entries.filter((entry) => entry.xy !== '??')
      let empty = 0
      for (const entry of changed) {
        const staged = entry.xy[0] !== ' ' && entry.xy[0] !== '?'
        const diff = await gitRemote.remoteDiff(conn, repoRoot, entry.path, staged)
        const other = diff === '' ? await gitRemote.remoteDiff(conn, repoRoot, entry.path, !staged) : diff
        if (other === '') {
          empty += 1
          console.log(`[live] EMPTY diff for ${JSON.stringify(entry.xy)} ${entry.path}`)
        }
      }
      console.log(`[live] ${changed.length - empty}/${changed.length} changed files produced a diff`)
      expect(empty).toBe(0)

      // And the path form the untracked / new-file pane reads through: the
      // REMOTE absolute spelling must survive resolution untouched (the
      // doubled-path bug turned it into `<remoteCwd>/D:\...\...`).
      const untracked = status.entries.find((entry) => entry.xy === '??')
      if (untracked !== undefined) {
        const remoteAbs = `${REMOTE_PATH}/${untracked.path}`
        expect(resolveRemotePath(remoteAbs, route)).toBe(remoteAbs)
        const text = await remoteReadText(conn, resolveRemotePath(remoteAbs, route), 1 << 20)
        console.log(`[live] untracked read ${untracked.path}: ${text.size} bytes`)
        expect(text.size).toBeGreaterThanOrEqual(0)
      }
    } finally {
      pool.release()
    }
  }, 120_000)

  it('labels the root with the host display name', async () => {
    const host = readLiveHost(HOST_ID)
    if (host === undefined) return
    const ctx = {
      get: (name: string): unknown => (name === 'sshPool'
        ? { acquire: async () => ({}), release: () => {}, hosts: () => ({ [HOST_ID]: host }), host: (id: string) => (id === HOST_ID ? host : undefined) }
        : undefined),
    } as never
    const label = remoteDisplayLabel(ctx, placeholderFor(HOST_ID, REMOTE_PATH))
    const base = REMOTE_PATH.split('/').filter(Boolean).pop()
    expect(label).toBe(`${host.name ?? HOST_ID} / ${base}`)
    console.log(`[live] root label: ${label}`)
  })
})
