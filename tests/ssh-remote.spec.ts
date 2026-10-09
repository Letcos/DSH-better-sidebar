/**
 * The dsh-ssh bridge: placeholder routing, path translation and the host
 * config / pool accessor paths.
 *
 * These tests pin the CONTRACT with `@dsh-ssh/dsh-ssh`, which this plugin
 * mirrors without importing (see src/ssh-remote.ts). The routing convention and
 * the pool face are the two things that break silently if dsh-ssh ever changes
 * them, so both are exercised directly here.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { Context } from '../src/context-types.ts'
import {
  acquireRemote,
  hostDisplayNameOf,
  isValidHostId,
  localToRemote,
  localRemotePath,
  mapLocalToRemote,
  mapRemoteToLocal,
  remoteDisplayLabel,
  remoteToLocal,
  resolveRemoteTarget,
  routeByCwd,
  sshPoolOf,
  withRemoteConn,
  type RemoteConn,
  type RemoteRoute,
} from '../src/ssh-remote.ts'

const PREV_ROOT = process.env.DSH_SSH_REMOTE_ROOT

/**
 * A placeholder root that survives `path.resolve` unchanged on the host
 * platform: `sshRemoteRoot` resolves the env value, so a POSIX literal on
 * Windows would come back drive-anchored and every expected path would have to
 * be written twice.
 */
const ROOT = process.platform === 'win32' ? 'C:\\dsh-remote-root' : '/tmp/dsh-remote-root'

afterEach(() => {
  if (PREV_ROOT === undefined) delete process.env.DSH_SSH_REMOTE_ROOT
  else process.env.DSH_SSH_REMOTE_ROOT = PREV_ROOT
})

/**
 * A context exposing a dsh-ssh-shaped `sshPool`. `hosts()`/`host()` are the
 * accessors the current dsh-ssh build provides; passing `legacy: true` omits
 * them to exercise the settings-namespace fallback.
 */
function poolCtx(
  hosts: Record<string, { name?: string; host?: string; user?: string }>,
  options: { legacy?: boolean; conn?: RemoteConn } = {},
): Context {
  const conn = options.conn ?? ({ exec: async () => ({ code: 0, signal: null, stdout: '', stderr: '' }) } as unknown as RemoteConn)
  // Hosts default to a connectable shape so `acquireRemote` passes its guard;
  // a test that cares about a MISSING host simply omits the id.
  const normalized: Record<string, Record<string, unknown>> = {}
  for (const [id, host] of Object.entries(hosts)) {
    normalized[id] = { host: '203.0.113.10', user: 'dev', ...host }
  }
  const pool: Record<string, unknown> = {
    acquire: async () => conn,
    release: () => {},
    invalidate: async () => undefined,
  }
  if (options.legacy !== true) {
    pool.hosts = () => normalized
    pool.host = (id: string) => normalized[id]
  }
  const settings = {
    get: (ns: string): unknown => (ns === 'dsh-ssh-hosts' ? { hosts: normalized } : undefined),
  }
  return {
    get: (name: string): unknown => {
      if (name === 'sshPool') return pool
      if (name === 'settings') return settings
      return undefined
    },
  } as unknown as Context
}

describe('placeholder routing', () => {
  it('round-trips a remote path through the local placeholder', () => {
    process.env.DSH_SSH_REMOTE_ROOT = ROOT
    const local = mapRemoteToLocal('a-host', '/srv/app')!
    // The placeholder is a LOCAL path, so it uses the platform separator; its
    // encoded segment is always the same base64url of the REMOTE path.
    expect(local).toBe(join(ROOT, 'a-host', Buffer.from('/srv/app').toString('base64url')))
    expect(mapLocalToRemote(local)).toEqual({ hostId: 'a-host', remotePath: '/srv/app' })
  })

  it('classifies a placeholder cwd as remote and a normal path as local', () => {
    process.env.DSH_SSH_REMOTE_ROOT = ROOT
    const route = routeByCwd(mapRemoteToLocal('a-host', '/srv/app')!)
    expect(route.kind).toBe('remote')
    // The placeholder ROOT itself (one segment) is not a workspace.
    expect(routeByCwd(join(ROOT, 'a-host'))).toEqual({ kind: 'local' })
    expect(routeByCwd('/Users/me/code')).toEqual({ kind: 'local' })
  })

  it('rejects a hostId that could escape the placeholder root', () => {
    expect(isValidHostId('a-host')).toBe(true)
    expect(isValidHostId('..')).toBe(false)
    expect(isValidHostId('.')).toBe(false)
    expect(isValidHostId('a/b')).toBe(false)
    expect(isValidHostId('')).toBe(false)
  })

  it('never mistakes an ordinary local tree for a placeholder', () => {
    process.env.DSH_SSH_REMOTE_ROOT = ROOT
    // Three segments under the root is not the two-segment placeholder shape.
    expect(mapLocalToRemote(join(ROOT, 'a-host', 'extra'))).toBeNull()
    // A segment that does not decode to an absolute path is not a placeholder.
    expect(mapLocalToRemote(join(ROOT, 'a-host', 'not-base64!!'))).toBeNull()
  })
})

describe('path translation', () => {
  const remoteCwd = '/srv/app'
  const placeholderCwd = join(ROOT, 'a-host', Buffer.from(remoteCwd).toString('base64url'))
  const route: RemoteRoute = { kind: 'remote', hostId: 'a-host', remoteCwd, placeholderCwd }

  it('maps a placeholder-internal path onto the remote cwd', () => {
    const inside = join(placeholderCwd, 'src', 'index.ts')
    expect(localToRemote(inside, route)).toBe('/srv/app/src/index.ts')
  })

  it('maps the placeholder root itself onto the remote root', () => {
    expect(localToRemote(route.placeholderCwd, route)).toBe('/srv/app')
  })

  it('passes an unrelated absolute path through as a remote absolute', () => {
    // The local routes reach any host path (the workspace fence was removed
    // upstream), so the remote routes must reach any REMOTE path.
    expect(localToRemote('/etc/hosts', route)).toBe('/etc/hosts')
    expect(localToRemote('/srv/other/file.txt', route)).toBe('/srv/other/file.txt')
  })

  it('normalizes a remote absolute path lexically', () => {
    expect(localToRemote('/srv/other/../etc/hosts', route)).toBe('/srv/etc/hosts')
  })

  it('resolves a relative target against the placeholder cwd', () => {
    expect(resolveRemoteTarget(route.placeholderCwd, route, 'src/app.ts')).toBe('/srv/app/src/app.ts')
  })

  it('converts a remote path back to the placeholder the client understands', () => {
    expect(remoteToLocal('/srv/app/src/index.ts', route)).toBe(join(placeholderCwd, 'src', 'index.ts'))
    expect(remoteToLocal('/srv/app', route)).toBe(route.placeholderCwd)
  })

  it('localRemotePath is the identity translation route handlers rely on', () => {
    const inside = join(placeholderCwd, 'docs', 'a.md')
    expect(localRemotePath(inside, route)).toBe('/srv/app/docs/a.md')
  })
})

describe('host config access', () => {
  it('reads the host display name through the pool accessor', () => {
    process.env.DSH_SSH_REMOTE_ROOT = ROOT
    const ctx = poolCtx({ 'a-host': { name: '  my-box  ' } })
    expect(hostDisplayNameOf(ctx, 'a-host')).toBe('my-box')
    expect(hostDisplayNameOf(ctx, 'missing')).toBe('missing')
  })

  it('falls back to the settings namespace when the pool has no accessor', () => {
    process.env.DSH_SSH_REMOTE_ROOT = ROOT
    const ctx = poolCtx({ 'a-host': { name: 'legacy-box' } }, { legacy: true })
    expect(hostDisplayNameOf(ctx, 'a-host')).toBe('legacy-box')
  })

  it('derives "<host name> / <basename>" for a remote cwd', () => {
    process.env.DSH_SSH_REMOTE_ROOT = ROOT
    const placeholder = mapRemoteToLocal('soft-plat-id', '/home/dev/cursor_ws/softplat_workspace')!
    expect(remoteDisplayLabel(poolCtx({ 'soft-plat-id': { name: 'soft-plat' } }), placeholder))
      .toBe('soft-plat / softplat_workspace')
  })

  it('returns undefined for a local cwd', () => {
    process.env.DSH_SSH_REMOTE_ROOT = ROOT
    expect(remoteDisplayLabel(poolCtx({}), '/Users/me/code')).toBeUndefined()
  })

  it('is undefined when dsh-ssh is not loaded at all', () => {
    const ctx = { get: () => undefined } as unknown as Context
    expect(sshPoolOf(ctx)).toBeUndefined()
  })
})

describe('connection dispatch', () => {
  it('runs the remote branch only for a placeholder cwd', async () => {
    process.env.DSH_SSH_REMOTE_ROOT = ROOT
    const ctx = poolCtx({ 'a-host': { name: 'box', host: '203.0.113.10', user: 'dev' } })

    const remoteCalls: string[] = []
    const remoteResult = await withRemoteConn(ctx, mapRemoteToLocal('a-host', '/srv/app')!, async (_conn, route) => {
      remoteCalls.push(route.remoteCwd)
      return 'remote'
    })
    expect(remoteResult).toBe('remote')
    expect(remoteCalls).toEqual(['/srv/app'])

    // A local cwd yields null so the caller stays on the local implementation.
    const localResult = await withRemoteConn(ctx, '/Users/me/code', async () => 'remote')
    expect(localResult).toBeNull()
  })

  it('refuses a remote cwd whose pool is missing rather than degrading to local', async () => {
    process.env.DSH_SSH_REMOTE_ROOT = ROOT
    const ctx = { get: () => undefined } as unknown as Context
    await expect(acquireRemote(ctx, 'a-host')).rejects.toThrow(/sshPool service unavailable/)
  })

  it('reports a host that is not configured in dsh-ssh', async () => {
    process.env.DSH_SSH_REMOTE_ROOT = ROOT
    const ctx = poolCtx({})
    await expect(acquireRemote(ctx, 'ghost')).rejects.toThrow(/is not configured/)
  })
})
