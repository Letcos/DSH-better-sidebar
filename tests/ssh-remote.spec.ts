import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '../src/context-types.ts'
import { hostDisplayNameOf, mapRemoteToLocal, remoteDisplayLabel } from '../src/ssh-remote.ts'

const PREV_ROOT = process.env.DSH_SSH_REMOTE_ROOT

afterEach(() => {
  if (PREV_ROOT === undefined) delete process.env.DSH_SSH_REMOTE_ROOT
  else process.env.DSH_SSH_REMOTE_ROOT = PREV_ROOT
})

/** A context whose only reachable service is `settings` (readable as a hosts dict). */
function settingsCtx(hosts: Record<string, { name?: string }>): Context {
  const settings = {
    get: (ns: string): unknown => (ns === 'dsh-ssh-hosts' ? { hosts } : undefined),
  }
  return { get: (name: string): unknown => (name === 'settings' ? settings : undefined) } as unknown as Context
}

describe('ssh-remote display labels', () => {
  it('derives "<host name> / <basename>" for a remote cwd', () => {
    process.env.DSH_SSH_REMOTE_ROOT = '/tmp/dsh-remote-root'
    const placeholder = mapRemoteToLocal('soft-plat-id', '/home/r20035/cursor_ws/softplat_workspace')!
    expect(remoteDisplayLabel(settingsCtx({ 'soft-plat-id': { name: 'soft-plat' } }), placeholder))
      .toBe('soft-plat / softplat_workspace')
  })

  it('falls back to the hostId when the host has no configured name', () => {
    process.env.DSH_SSH_REMOTE_ROOT = '/tmp/dsh-remote-root'
    const placeholder = mapRemoteToLocal('a-host', '/srv/app')!
    expect(remoteDisplayLabel(settingsCtx({}), placeholder)).toBe('a-host / app')
  })

  it('returns undefined for a local cwd', () => {
    process.env.DSH_SSH_REMOTE_ROOT = '/tmp/dsh-remote-root'
    expect(remoteDisplayLabel(settingsCtx({}), '/Users/me/code')).toBeUndefined()
  })

  it('hostDisplayNameOf prefers the configured name and trims it', () => {
    const ctx = settingsCtx({ h1: { name: '  my-box  ' } })
    expect(hostDisplayNameOf(ctx, 'h1')).toBe('my-box')
    expect(hostDisplayNameOf(ctx, 'missing')).toBe('missing')
  })
})
