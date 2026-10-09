/**
 * dsh-better-sidebar — remote workspace bridge for `@dsh-ssh/dsh-ssh`.
 *
 * The sidebar's file explorer, editor, search, media/preview routes, upload and
 * git panel all operate on the *session cwd* as a local path. When dsh-ssh is
 * loaded, a remote workspace is a LOCAL placeholder directory:
 *
 *     <root>/<hostId>/<base64url(absolute remote path)>
 *     root  = $DSH_SSH_REMOTE_ROOT | $DSH_HOME/remote | ~/.dsh/remote
 *
 * This module mirrors that routing convention (source of truth: dsh-ssh's
 * `src/router.js`) WITHOUT importing dsh-ssh, so the sidebar stays a
 * dependency-free plugin. It activates only when `ctx.get('sshPool')` is
 * present (i.e. dsh-ssh's host plugin is loaded); a local cwd or a missing
 * pool leaves every call path on the existing local implementation.
 *
 * Every remote path is re-checked lexically against the remote workspace root
 * (the session cwd's remote twin), mirroring the local `ensureWorkspacePath`
 * containment boundary — a request can never escape the remote workspace.
 *
 * The pool face is resolved structurally: dsh-ssh's `sshPool` service exposes
 * `acquire(cfg)` / `release(conn)` / `invalidate(hostId)` plus the read-only
 * `hosts()` / `host(hostId)` accessors. `hosts()`/`host()` are preferred when
 * present (they read the plugin's own resolved config, including hosts edited
 * after this plugin mounted); the legacy settings-namespace read is kept as a
 * fallback for older dsh-ssh builds.
 */
import os from 'node:os'
import path from 'node:path'
import { posix } from 'node:path'
import type { Context } from './context-types.ts'
import { SidebarError } from './wire.ts'
import { type SidebarFsEntry, type SidebarFsListing, compareEntries } from './fs-tree.ts'
import { SKIP_DIR_NAMES } from './search-engines.ts'
import type { FsSearchResult } from './fs-search.ts'

// ── Placeholder routing (mirror of @dsh-ssh/dsh-ssh src/router.js) ─────────

/** The local directory under which dsh-ssh materializes remote workspaces. */
export function sshRemoteRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DSH_SSH_REMOTE_ROOT) return path.resolve(String(env.DSH_SSH_REMOTE_ROOT))
  const dshHome = env.DSH_HOME ? String(env.DSH_HOME) : path.join(os.homedir(), '.dsh')
  return path.join(dshHome, 'remote')
}

/** A hostId is a safe single-segment directory name. */
export function isValidHostId(hostId: string): boolean {
  if (typeof hostId !== 'string' || hostId.length === 0) return false
  if (hostId === '.' || hostId === '..') return false
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(hostId)
}

function encodeRemotePath(remotePath: string): string {
  return Buffer.from(String(remotePath), 'utf8').toString('base64url')
}

function decodeRemotePath(encoded: string): string | null {
  if (typeof encoded !== 'string' || encoded.length === 0) return null
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null
  let text: string
  try {
    text = Buffer.from(encoded, 'base64url').toString('utf8')
  } catch {
    return null
  }
  if (encodeRemotePath(text) !== encoded) return null
  return text
}

/** Remote absolute path → local placeholder path (caller ensures hostId validity). */
export function mapRemoteToLocal(hostId: string, remotePath: string, env?: NodeJS.ProcessEnv): string | null {
  if (!isValidHostId(hostId)) return null
  return path.join(sshRemoteRoot(env), hostId, encodeRemotePath(remotePath))
}

/** Local path → { hostId, remotePath } | null (exactly two segments under the root). */
export function mapLocalToRemote(localPath: string, env?: NodeJS.ProcessEnv): { hostId: string; remotePath: string } | null {
  if (typeof localPath !== 'string' || localPath.length === 0) return null
  const root = sshRemoteRoot(env)
  const rel = path.relative(root, localPath)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  const segments = rel.split(path.sep)
  if (segments.length !== 2) return null
  const hostId = segments[0]!
  const encoded = segments[1]!
  if (!isValidHostId(hostId)) return null
  const remotePath = decodeRemotePath(encoded)
  if (remotePath === null) return null
  if (!path.isAbsolute(remotePath) || !remotePath.startsWith('/')) return null
  return { hostId, remotePath }
}

/** One resolved remote route for a session cwd. */
export interface RemoteRoute {
  kind: 'remote'
  hostId: string
  remoteCwd: string
  placeholderCwd: string
}

/** Session cwd → remote route, or local. Never throws. */
export function routeByCwd(cwd: string, env?: NodeJS.ProcessEnv): { kind: 'local' } | RemoteRoute {
  const mapped = mapLocalToRemote(cwd, env)
  if (mapped === null) return { kind: 'local' }
  return { kind: 'remote', hostId: mapped.hostId, remoteCwd: mapped.remotePath, placeholderCwd: cwd }
}

/**
 * Convert a client-supplied path to a remote absolute path. Accepts:
 *  - a local placeholder path (the tree/editor pass these back verbatim),
 *  - a raw POSIX absolute path (a remote path passed through),
 *  - a relative path (git status/diff report repo-root-relative names).
 *
 * NO containment: the sidebar's local routes reach any path the host user can
 * reach (the workspace fence was removed upstream in v0.23.0), so the remote
 * routes must reach any path the REMOTE user can reach — otherwise an absolute
 * path the user typed would be refused only in a remote workspace. Length is
 * lexical, mirroring the local `resolveTarget`.
 */
export function localToRemote(localPath: string, route: RemoteRoute): string {
  const rel = path.relative(route.placeholderCwd, localPath)
  if (rel === '') return route.remoteCwd
  // A path INSIDE the placeholder workspace is re-anchored onto the remote cwd.
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    return posix.join(route.remoteCwd, rel.split(path.sep).join('/'))
  }
  // Anything else is already a remote-side path: a POSIX absolute passes
  // through, and a bare relative name resolves against the remote cwd.
  if (posix.isAbsolute(localPath)) return posix.normalize(localPath)
  return posix.resolve(route.remoteCwd, localPath)
}

/** Convert a remote absolute path back to the local placeholder path the client understands. */
export function remoteToLocal(remotePath: string, route: RemoteRoute): string {
  const rel = posix.relative(route.remoteCwd, remotePath)
  if (rel === '') return route.placeholderCwd
  if (!rel.startsWith('..') && !posix.isAbsolute(rel)) {
    return path.join(route.placeholderCwd, rel.split('/').join(path.sep))
  }
  // Outside the workspace root: still express it as a local placeholder under the same host.
  return mapRemoteToLocal(route.hostId, remotePath) ?? remotePath
}

/** Whether a client-supplied string is already a REMOTE (POSIX) absolute path. */
export function isRemoteAbsolute(target: string): boolean {
  return posix.isAbsolute(target)
}

/**
 * Resolve one client-supplied target to a REMOTE absolute path.
 *
 * This is the remote counterpart of the local `resolveTarget`, and it exists
 * because that local primitive CANNOT be reused here: on Windows it drive-roots
 * a POSIX path (`win32.resolve('/home/u/p')` → `D:\home\u\p`), so a value that
 * was already remote came back mangled and every remote read failed with a
 * doubled path like
 * `/home/u/proj/D:\home\u\proj\docs\x.md`. Nothing here may touch a Windows
 * path API.
 *
 * Accepted inputs, in the order the routes produce them:
 *  - a remote absolute path (passed through, normalized);
 *  - a local placeholder path inside this session's workspace (re-anchored);
 *  - a repository-relative or session-relative name (joined onto the remote
 *    cwd).

 * @param target - the client-supplied path.
 * @param route - the session's resolved remote route.
 * @returns the remote absolute path.
 */
export function resolveRemotePath(target: string, route: RemoteRoute): string {
  if (isRemoteAbsolute(target)) return posix.normalize(target)
  // A placeholder-spelled path (Windows or POSIX) translates through the
  // shared local→remote mapping, which re-anchors it onto the remote cwd.
  const fromPlaceholder = localToRemote(target, route)
  if (isRemoteAbsolute(fromPlaceholder)) return fromPlaceholder
  // A bare relative name (git status reports repo-root-relative names).
  return posix.resolve(route.remoteCwd, target)
}

/**
 * The remote path a route handler's already-resolved local target names.
 *
 * Route handlers resolve their target with the shared local resolver
 * (`ensureWorkspacePath`) before dispatching, so the value handed to the
 * remote branch is a local path — either inside the placeholder workspace or
 * an absolute local path outside it. Both translate back through
 * {@link localToRemote}, which re-anchors placeholder-internal paths onto the
 * remote cwd and passes other absolute paths through as remote absolutes.
 */
export function localRemotePath(localPath: string, route: RemoteRoute): string {
  return localToRemote(localPath, route)
}

/**
 * Convert one client-supplied tree path into a remote absolute path.
 *
 * The tree sends back the paths it was shown — local placeholder paths — plus
 * (for the editor's git-derived surfaces) repository-relative names. Joining
 * the placeholder cwd first keeps relative input anchored to this session, and
 * `localToRemote` then re-anchors the whole thing onto the remote workspace.
 */
export function resolveRemoteTarget(cwd: string, route: RemoteRoute, target: string): string {
  const abs = path.isAbsolute(target) ? target : path.join(cwd, target)
  return localToRemote(abs, route)
}

// ── Host config ────────────────────────────────────────────────────────────

/** One dsh-ssh host entry (structural mirror of its HostConfigSchema). */
export interface SshHostConfig {
  id?: string
  name?: string
  host: string
  port?: number
  user: string
  auth?: { type?: 'key' | 'password'; privateKeyPath?: string; password?: string }
  knownHostsPath?: string
  connectTimeoutMs?: number
  keepaliveIntervalMs?: number
}

/** Any non-null object is a candidate host record; callers narrow further. */
function isHostRecord(value: unknown): value is SshHostConfig {
  return value !== null && typeof value === 'object'
}

/**
 * A record complete enough to OPEN a connection.
 *
 * Reading a display name must not require this (a host row whose `host`/`user`
 * is momentarily blank still has a name worth showing), but handing such a
 * record to `acquire` would produce a confusing connection error instead of a
 * clear configuration one.
 */
function isConnectableHost(value: unknown): value is SshHostConfig {
  return isHostRecord(value)
    && typeof (value as { host?: unknown }).host === 'string'
    && typeof (value as { user?: unknown }).user === 'string'
}

/** Structural face of the dsh-ssh `sshPool` service. */
export interface SidebarSshPool {
  acquire(cfg: unknown): Promise<RemoteConn>
  release(conn?: RemoteConn): void
  invalidate?(hostId: string): Promise<unknown>
  /** Current hosts dict, read live from the plugin's resolved config. */
  hosts?(): Record<string, SshHostConfig>
  /** One stored host by id (unredacted, secrets included). */
  host?(hostId: string): SshHostConfig | undefined
}

/** Structural face of one dsh-ssh connection. */
export interface RemoteConn {
  exec(cmd: string, opts?: { cwd?: string; timeoutMs?: number; maxStdoutBytes?: number }): Promise<{ code: number; signal: string | null; stdout: string; stderr: string }>
  fs(): Promise<RemoteFs>
  shell?(opts?: { term?: string; cols?: number; rows?: number }): Promise<RemoteShellStream>
}

/** The sidebar-relevant file face of dsh-ssh's SftpWrapper / ExecFs. */
export interface RemoteFs {
  stat(p: string): Promise<{ type: 'file' | 'directory' | 'other'; size?: number; mtime?: number } | undefined>
  listDir(p: string): Promise<Array<{ name: string; type: 'dir' | 'file' | 'link' | 'other'; size: number; mtime?: number }>>
  readBytes(p: string): Promise<Buffer>
  writeFileAtomic(p: string, data: Buffer): Promise<void>
  unlink?(p: string): Promise<void>
  rmdir?(p: string): Promise<void>
  rename?(from: string, to: string): Promise<void>
}

/** Structural face of the ssh2 shell channel (no ssh2 import — dependency-free). */
export interface RemoteShellStream {
  on(event: 'data', listener: (data: Buffer) => void): unknown
  on(event: 'close', listener: (code?: number, signal?: string) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  stderr: { on(event: 'data', listener: (data: Buffer) => void): unknown }
  write(data: string | Buffer): boolean
  setWindow(rows: number, cols: number, height: number, width: number): void
  close(): void
  end(): void
}

function readService(ctx: Context, name: string): unknown {
  const getter = (ctx as { get?: (name: string) => unknown }).get
  return typeof getter === 'function' ? getter.call(ctx, name) : undefined
}

/** The dsh-ssh pool, or undefined when that plugin is not loaded. */
export function sshPoolOf(ctx: Context): SidebarSshPool | undefined {
  const value = readService(ctx, 'sshPool')
  if (value === null || typeof value !== 'object') return undefined
  if (typeof (value as SidebarSshPool).acquire !== 'function') return undefined
  return value as SidebarSshPool
}

/**
 * Read the dsh-ssh host dict.
 *
 * Preferred path: the pool's own `hosts()` accessor (dsh-ssh reads through its
 * live resolved config, so a host edited in Settings after this plugin mounted
 * is visible without a reload). Fallback: the `dsh-ssh-hosts` settings
 * namespace, for builds that predate the accessor.
 */
function readHosts(ctx: Context, pool?: SidebarSshPool): Record<string, SshHostConfig> {
  const fromPool = pool?.hosts?.call(pool)
  if (fromPool !== undefined && fromPool !== null && typeof fromPool === 'object') {
    return fromPool as Record<string, SshHostConfig>
  }
  const settings = readService(ctx, 'settings')
  if (settings === null || typeof settings !== 'object') return {}
  const get = (settings as { get?: unknown }).get
  if (typeof get !== 'function') return {}
  // `get(ns)` reads `this.registrations`, so it must be invoked as a method
  // with `this` bound to the settings service (an unbound call throws).
  let doc: unknown
  try {
    doc = (get as (ns: string) => unknown).call(settings, 'dsh-ssh-hosts')
  } catch {
    return {}
  }
  if (doc === null || typeof doc !== 'object') return {}
  const hosts = (doc as { hosts?: unknown }).hosts
  if (hosts === null || typeof hosts !== 'object') return {}
  const out: Record<string, SshHostConfig> = {}
  for (const [id, value] of Object.entries(hosts as Record<string, unknown>)) {
    if (isHostRecord(value)) out[id] = value
  }
  return out
}

/** One stored host config by id, or throw a user-actionable error. */
function hostConfigOf(ctx: Context, hostId: string, pool?: SidebarSshPool): SshHostConfig {
  const direct = pool?.host?.call(pool, hostId)
  if (isConnectableHost(direct)) return { ...direct, id: hostId }
  const host = readHosts(ctx, pool)[hostId]
  if (!isConnectableHost(host)) {
    throw new SidebarError('fs-error', `remote host "${hostId}" is not configured in dsh-ssh-hosts — add it in Settings → SSH hosts`, 400)
  }
  return { ...host, id: hostId }
}

/** Human display name for a remote host: the configured `name`, else the hostId. */
export function hostDisplayNameOf(ctx: Context, hostId: string, pool?: SidebarSshPool): string {
  const resolved = pool ?? sshPoolOf(ctx)
  const direct = resolved?.host?.call(resolved, hostId)
  const host = isHostRecord(direct) ? direct : readHosts(ctx, resolved)[hostId]
  if (isHostRecord(host) && typeof host.name === 'string' && host.name.trim() !== '') {
    return host.name.trim()
  }
  return hostId
}

/**
 * The display label for a remote cwd: `<host display name> / <remote basename>`
 * (mirror of dsh-ssh's `placeholderWorkspaceTitle`), or undefined for a local
 * cwd. The local placeholder directory's own basename is an unreadable base64
 * segment and must never be shown to the user.
 */
export function remoteDisplayLabel(ctx: Context, cwd: string): string | undefined {
  const route = routeByCwd(cwd)
  if (route.kind !== 'remote') return undefined
  const base = posix.basename(route.remoteCwd)
  const label = base === '' ? route.remoteCwd : base
  return `${hostDisplayNameOf(ctx, route.hostId)} / ${label}`
}

/** Acquire one pooled connection for a hostId (release with `pool.release()`). */
export async function acquireRemote(ctx: Context, hostId: string): Promise<{ pool: SidebarSshPool; conn: RemoteConn }> {
  const pool = sshPoolOf(ctx)
  if (pool === undefined) {
    throw new SidebarError('internal', 'sshPool service unavailable — is the @dsh-ssh/dsh-ssh plugin loaded?', 503)
  }
  const conn = await pool.acquire(hostConfigOf(ctx, hostId, pool))
  return { pool, conn }
}

/**
 * Run `fn` against a remote connection when `cwd` is a remote placeholder;
 * return null when the cwd is local (the caller falls back to the local path).
 * A remote cwd whose pool/host is missing throws rather than silently
 * degrading to a local operation.
 */
export async function withRemoteConn<T>(
  ctx: Context,
  cwd: string,
  fn: (conn: RemoteConn, route: RemoteRoute) => Promise<T>,
): Promise<T | null> {
  const route = routeByCwd(cwd)
  if (route.kind !== 'remote') return null
  const { pool, conn } = await acquireRemote(ctx, route.hostId)
  try {
    return await fn(conn, route)
  } finally {
    pool.release()
  }
}

// ── Remote file operations (sidebar-shaped) ────────────────────────────────

/** POSIX single-quote escaping for a remote shell word. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `head -c`-based bounded, binary-safe read (GNU/BSD coreutils; base64 round-trip). */
async function readRemoteHead(conn: RemoteConn, remotePath: string, maxBytes: number): Promise<Buffer> {
  const cmd = `head -c ${maxBytes} ${shellQuote(remotePath)} 2>/dev/null | base64`
  const r = await conn.exec(cmd, { timeoutMs: 30_000 })
  if (r.code !== 0 && r.stdout.trim() === '') {
    throw new SidebarError('fs-error', `cannot read "${remotePath}": ${r.stderr || `exit ${r.code}`}`, 400)
  }
  return Buffer.from(r.stdout.replace(/\s+/g, ''), 'base64')
}

/**
 * List one remote directory level, returning local-placeholder entry paths.
 *
 * `compact` (the explorer's singleton-chain folding) is deliberately NOT
 * computed here: it would cost one extra remote listing per directory row, and
 * the client already folds on its own for remote roots. Rows stay complete for
 * every other field the tree reads.
 */
export async function remoteListDirectory(
  conn: RemoteConn,
  remotePath: string,
  route: RemoteRoute,
  maxEntries = 1000,
): Promise<SidebarFsListing> {
  const fs = await conn.fs()
  let entries: Array<{ name: string; type: 'dir' | 'file' | 'link' | 'other'; size: number; mtime?: number }>
  try {
    entries = await fs.listDir(remotePath)
  } catch (error) {
    throw new SidebarError('fs-error', `cannot list "${remotePath}": ${messageOf(error)}`, 400)
  }
  const rows: SidebarFsEntry[] = []
  let overflow = 0
  for (const entry of entries) {
    if (rows.length >= maxEntries) {
      overflow += 1
      continue
    }
    rows.push({
      name: entry.name,
      path: remoteToLocal(posix.join(remotePath, entry.name), route),
      isDir: entry.type === 'dir',
      isSymlink: entry.type === 'link',
      broken: false,
      hidden: entry.name.startsWith('.'),
    })
  }
  await probeRemoteSymlinks(conn, remotePath, rows)
  rows.sort(compareEntries)
  return { path: remoteToLocal(remotePath, route), entries: rows, truncated: overflow > 0 }
}

/** Resolve symlink rows to their target kind (bounded concurrency, like the local probe). */
async function probeRemoteSymlinks(
  conn: RemoteConn,
  remoteDir: string,
  rows: SidebarFsEntry[],
  concurrency = 8,
): Promise<void> {
  const links = rows.filter((row) => row.isSymlink)
  if (links.length === 0) return
  const fs = await conn.fs()
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, links.length) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= links.length) return
      const row = links[index]!
      const info = await fs.stat(posix.join(remoteDir, row.name)).catch(() => undefined)
      row.isDir = info !== undefined && info.type === 'directory'
      row.broken = info === undefined
    }
  })
  await Promise.all(workers)
}

/** How many leading bytes a binary read returns for client-side detect sniffing. */
const READ_HEAD_LIMIT = 4096

/** Read the first `readLimit` bytes of a remote text file (mirror of the local `readText`). */
export async function remoteReadText(
  conn: RemoteConn,
  remotePath: string,
  readLimit: number,
): Promise<{ content: string; truncated: boolean; binary: boolean; size: number; mtimeMs?: number; head?: string }> {
  const fs = await conn.fs()
  const st = await fs.stat(remotePath)
  if (st === undefined) {
    throw new SidebarError('fs-error', `cannot read "${remotePath}": not found`, 400)
  }
  if (st.type === 'directory') {
    throw new SidebarError('fs-error', `"${remotePath}" is a directory`, 400)
  }
  if (st.type !== 'file') {
    throw new SidebarError('fs-error', `cannot read "${remotePath}": not a regular file`, 400)
  }
  const size = st.size ?? 0
  const truncated = size > readLimit
  const slice = size <= readLimit ? await fs.readBytes(remotePath) : await readRemoteHead(conn, remotePath, readLimit)
  const binary = slice.includes(0)
  const head = binary ? slice.subarray(0, Math.min(slice.length, READ_HEAD_LIMIT)).toString('base64') : undefined
  // SFTP mtime is SECONDS since the epoch; the sidebar's optimistic-concurrency
  // gate compares milliseconds (the local `stat` face).
  const mtimeMs = typeof st.mtime === 'number' ? st.mtime * 1000 : undefined
  return { content: binary ? '' : slice.toString('utf8'), truncated, binary, size, ...(mtimeMs !== undefined ? { mtimeMs } : {}), head }
}

/** Read a whole remote file as bytes, size-guarded (media / html preview routes). */
export async function remoteReadBytes(conn: RemoteConn, remotePath: string, maxBytes: number): Promise<Buffer> {
  const fs = await conn.fs()
  const st = await fs.stat(remotePath)
  if (st === undefined) {
    throw new SidebarError('fs-error', `cannot read "${remotePath}": not found`, 404)
  }
  if (st.type !== 'file' || (st.size ?? 0) > maxBytes) {
    throw new SidebarError('fs-error', 'not a file or too large', 400)
  }
  return fs.readBytes(remotePath)
}

/** Remote stat in the local `Stats` subset the media/html routes read. */
export async function remoteStat(conn: RemoteConn, remotePath: string): Promise<{ type: string; size?: number; mtimeMs?: number } | undefined> {
  const fs = await conn.fs()
  const st = await fs.stat(remotePath)
  if (st === undefined) return undefined
  return { type: st.type, ...(st.size !== undefined ? { size: st.size } : {}), ...(st.mtime !== undefined ? { mtimeMs: st.mtime * 1000 } : {}) }
}

/** Create a remote directory (and parents). */
export async function remoteMkdirp(conn: RemoteConn, remoteDir: string): Promise<void> {
  const r = await conn.exec(`mkdir -p ${shellQuote(remoteDir)}`, { timeoutMs: 30_000 })
  if (r.code !== 0) {
    throw new SidebarError('fs-error', `cannot create directory "${remoteDir}": ${r.stderr}`, 400)
  }
}

/** Write bytes to a remote file (parent dirs created on demand, atomic publish). */
export async function remoteWriteFile(conn: RemoteConn, remotePath: string, data: Buffer): Promise<void> {
  const fs = await conn.fs()
  await remoteMkdirp(conn, posix.dirname(remotePath))
  try {
    await fs.writeFileAtomic(remotePath, data)
  } catch (error) {
    throw new SidebarError('fs-error', `cannot write "${remotePath}": ${messageOf(error)}`, 400)
  }
}

/** Remove one remote entry (recursive for directories, like the local route). */
export async function remoteRemove(conn: RemoteConn, remotePath: string): Promise<void> {
  const r = await conn.exec(`rm -rf -- ${shellQuote(remotePath)}`, { timeoutMs: 60_000 })
  if (r.code !== 0) {
    throw new SidebarError('fs-error', `cannot remove "${remotePath}": ${r.stderr || `exit ${r.code}`}`, 400)
  }
}

/** Move one remote entry (single-segment rename inside its own directory). */
export async function remoteRename(conn: RemoteConn, from: string, to: string): Promise<void> {
  const r = await conn.exec(`mv -f -- ${shellQuote(from)} ${shellQuote(to)}`, { timeoutMs: 60_000 })
  if (r.code !== 0) {
    throw new SidebarError('fs-error', `cannot rename "${from}": ${r.stderr || `exit ${r.code}`}`, 400)
  }
}

/** Test one remote path's kind (`file` / `dir` / absent) without a full stat parse. */
export async function remoteEntryKind(conn: RemoteConn, remotePath: string): Promise<'file' | 'dir' | 'missing'> {
  const cmd = `if [ -d ${shellQuote(remotePath)} ]; then echo dir; elif [ -e ${shellQuote(remotePath)} ]; then echo file; else echo missing; fi`
  const r = await conn.exec(cmd, { timeoutMs: 15_000 })
  const out = r.stdout.trim()
  if (out === 'dir') return 'dir'
  if (out === 'file') return 'file'
  return 'missing'
}

/** Stream a request body into a remote file (upload route). */
export async function remoteUpload(
  conn: RemoteConn,
  route: RemoteRoute,
  dir: string,
  relativePath: string,
  chunks: AsyncIterable<string | Uint8Array>,
  limit: number,
): Promise<{ path: string; size: number }> {
  if (relativePath === '' || relativePath.startsWith('/') || relativePath.startsWith('\\')) {
    throw new SidebarError('bad-request', 'relativePath must stay below the upload directory', 400)
  }
  const segments = relativePath.split(/[\\/]/)
  if (segments.some((part) => part === '' || part === '.' || part === '..')) {
    throw new SidebarError('bad-request', 'relativePath must stay below the upload directory', 400)
  }
  const targetDirRemote = localToRemote(dir, route)
  const buffers: Buffer[] = []
  let size = 0
  for await (const chunk of chunks) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new SidebarError('too-large', `upload exceeds the ${limit} byte limit`, 413)
    buffers.push(buffer)
  }
  const target = posix.join(targetDirRemote, ...segments)
  await remoteWriteFile(conn, target, Buffer.concat(buffers))
  return { path: remoteToLocal(target, route), size }
}

/** Recursive file-name search over a remote tree (find + local substring filter). */
export async function remoteSearch(
  conn: RemoteConn,
  remoteRoot: string,
  query: string,
  opts: { maxMatches?: number; maxVisited?: number } = {},
): Promise<FsSearchResult> {
  const needle = query.trim().toLowerCase()
  if (needle === '') return { matches: [], dirs: [], truncated: false }
  const maxMatches = opts.maxMatches ?? 200
  const maxVisited = opts.maxVisited ?? 100_000
  // Directory pruning matches the local walk's skip set (search-engines.ts
  // SKIP_DIR_NAMES), so a remote search visits the same shape of tree.
  const pruneExpr = SKIP_DIR_NAMES.map((name) => `-iname ${shellQuote(name)}`).join(' -o ')
  const cmd = 'find ' + shellQuote(remoteRoot)
    + ' -mindepth 1 \\( -type d \\( ' + pruneExpr + ' \\) -prune \\) -o -printf \'%P\\t%y\\n\''
    + ' | head -n ' + (maxVisited + 1)
  const r = await conn.exec(cmd, { timeoutMs: 30_000, maxStdoutBytes: 8 * 1024 * 1024 })
  if (r.code !== 0) {
    throw new SidebarError('fs-error', `cannot search "${remoteRoot}": ${r.stderr || `exit ${r.code}`}`, 400)
  }
  const matches: string[] = []
  const dirs: string[] = []
  let visited = 0
  let truncated = false
  for (const line of r.stdout.split('\n')) {
    if (line === '') continue
    visited += 1
    const idx = line.lastIndexOf('\t')
    if (idx < 0) continue
    const relPath = line.slice(0, idx)
    const kind = line.slice(idx + 1)
    const name = relPath.includes('/') ? relPath.slice(relPath.lastIndexOf('/') + 1) : relPath
    if (name.toLowerCase().includes(needle)) {
      matches.push(relPath)
      if (kind === 'd') dirs.push(relPath)
      if (matches.length >= maxMatches) {
        truncated = true
        break
      }
    }
    if (visited >= maxVisited) {
      truncated = true
      break
    }
  }
  matches.sort()
  dirs.sort()
  return { matches, dirs, truncated }
}

// ── Remote interactive shell ───────────────────────────────────────────────

/** A node-pty-compatible shell handle. */
export interface SidebarShell {
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void }
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

/**
 * Create a remote shell for a remote cwd; null for a local cwd.
 *
 * `shell()` is a long-lived channel owned by the caller (unlike the pooled
 * `exec`/`fs` calls): the connection is acquired WITHOUT returning it to the
 * pool, and released exactly once when the shell exits or is killed.
 */
export async function createRemoteShell(
  ctx: Context,
  cwd: string,
  opts: { cols: number; rows: number },
): Promise<SidebarShell | null> {
  const route = routeByCwd(cwd)
  if (route.kind !== 'remote') return null
  const { pool, conn } = await acquireRemote(ctx, route.hostId)
  if (typeof conn.shell !== 'function') {
    pool.release()
    throw new SidebarError('internal', 'the @dsh-ssh/dsh-ssh build does not expose an interactive shell channel', 500)
  }
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    pool.release()
  }
  try {
    const stream = await conn.shell({ term: 'xterm-256color', cols: Math.max(2, Math.floor(opts.cols)), rows: Math.max(2, Math.floor(opts.rows)) })
    return new RemoteShell(stream, release)
  } catch (error) {
    release()
    throw error
  }
}

/** Wraps an ssh2 shell channel with node-pty's onData/onExit/write/resize/kill face. */
class RemoteShell implements SidebarShell {
  private stream: RemoteShellStream
  private release: () => void
  private dataListeners = new Set<(data: string) => void>()
  private exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>()
  exited = false
  exitCode = -1

  constructor(stream: RemoteShellStream, release: () => void) {
    this.stream = stream
    this.release = release
    const onChunk = (data: Buffer): void => {
      const text = data.toString('utf8')
      for (const listener of this.dataListeners) listener(text)
    }
    stream.on('data', onChunk)
    stream.stderr.on('data', onChunk)
    stream.on('close', (code?: number) => {
      this.exited = true
      this.exitCode = code ?? -1
      for (const listener of this.exitListeners) listener({ exitCode: this.exitCode })
      this.release()
    })
    stream.on('error', () => {
      this.exited = true
      for (const listener of this.exitListeners) listener({ exitCode: -1 })
      this.release()
    })
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener)
    return { dispose: () => { this.dataListeners.delete(listener) } }
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exitListeners.add(listener)
    return { dispose: () => { this.exitListeners.delete(listener) } }
  }

  write(data: string): void {
    if (!this.exited) this.stream.write(data)
  }

  resize(cols: number, rows: number): void {
    // ssh2 setWindow signature is (rows, cols, height, width); node-pty resize is (cols, rows).
    this.stream.setWindow(Math.max(2, Math.floor(rows)), Math.max(2, Math.floor(cols)), 0, 0)
  }

  kill(): void {
    this.exited = true
    try { this.stream.end() } catch { /* noop */ }
    try { this.stream.close() } catch { /* noop */ }
    this.release()
  }
}
