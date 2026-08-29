/**
 * dsh-better-sidebar — remote workspace bridge for `@dsh-ssh/dsh-ssh`.
 *
 * The sidebar's file explorer, editor, search, media/preview routes, upload,
 * git panel and terminal all operate on the *session cwd* as a local path.
 * When dsh-ssh is loaded, a remote workspace is a LOCAL placeholder directory:
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
 * Every remote path is re-checked lexically against the remote workspace
 * root (the session cwd's remote twin), mirroring the local `ensureWorkspacePath`
 * containment boundary — a request can never escape the remote workspace.
 */
import os from 'node:os'
import path from 'node:path'
import { posix } from 'node:path'
import type { Context } from './context-types.ts'
import { SidebarError } from './wire.ts'
import { type SidebarFsEntry, type SidebarFsListing, compareEntries } from './fs-tree.ts'
import { SEARCH_SKIP_DIRS, type FsSearchResult } from './fs-search.ts'

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

/** Reject a resolved remote path that escapes the remote workspace (lexical containment). */
function assertRemoteContained(remotePath: string, remoteCwd: string): string {
  const rel = posix.relative(remoteCwd, remotePath)
  if (rel === '' || (!rel.startsWith('..') && !posix.isAbsolute(rel))) return remotePath
  throw new SidebarError('forbidden', `path "${remotePath}" is outside workspace`, 403)
}

/**
 * Convert a client-supplied path to a remote absolute path. Accepts:
 *  - a local placeholder path (the tree/editor pass these back verbatim),
 *  - a raw POSIX absolute path (a remote path passed through),
 *  - a relative path (git status/diff report repo-root-relative names).
 * All results are contained to the remote workspace root.
 */
export function localToRemote(localPath: string, route: RemoteRoute): string {
  let candidate: string
  const rel = path.relative(route.placeholderCwd, localPath)
  if (rel === '') candidate = route.remoteCwd
  else if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    candidate = posix.join(route.remoteCwd, rel.split(path.sep).join('/'))
  } else if (posix.isAbsolute(localPath)) {
    candidate = posix.normalize(localPath)
  } else {
    candidate = posix.resolve(route.remoteCwd, localPath)
  }
  return assertRemoteContained(candidate, route.remoteCwd)
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

// ── Host config (mirror of dsh-ssh src/settings.js readHostsDoc) ───────────

export interface SshHostConfig {
  id?: string
  name?: string
  host: string
  port?: number
  user: string
  auth?: { type: 'key' | 'password'; privateKeyPath?: string; password?: string }
  knownHostsPath?: string
  connectTimeoutMs?: number
  keepaliveIntervalMs?: number
}

function hostsOf(doc: unknown): Record<string, SshHostConfig> {
  if (doc === null || typeof doc !== 'object') return {}
  const hosts = (doc as { hosts?: unknown }).hosts
  return hosts !== null && typeof hosts === 'object' ? hosts as Record<string, SshHostConfig> : {}
}

function safeGet(get: (ns: string) => unknown, ns: string): unknown {
  try {
    return get(ns)
  } catch {
    return undefined
  }
}

/** Read the dsh-ssh host dict (dsh-ssh-hosts, falling back to the legacy dssh-hosts). */
export function readSshHosts(get: (ns: string) => unknown): { hosts: Record<string, SshHostConfig> } {
  const newHosts = hostsOf(safeGet(get, 'dsh-ssh-hosts'))
  if (Object.keys(newHosts).length > 0) return { hosts: newHosts }
  const legacyHosts = hostsOf(safeGet(get, 'dssh-hosts'))
  if (Object.keys(legacyHosts).length > 0) return { hosts: legacyHosts }
  return { hosts: newHosts }
}

// ── Connection ─────────────────────────────────────────────────────────────

/** Structural face of the dsh-ssh `sshPool` service. */
export interface SidebarSshPool {
  acquire(cfg: unknown): Promise<RemoteConn>
  release(conn?: RemoteConn): void
  invalidate(hostId: string): Promise<unknown>
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

function sshPoolOf(ctx: Context): SidebarSshPool | undefined {
  const value = readService(ctx, 'sshPool')
  if (value === null || typeof value !== 'object') return undefined
  if (typeof (value as SidebarSshPool).acquire !== 'function') return undefined
  return value as SidebarSshPool
}

function hostConfigOf(ctx: Context, hostId: string): SshHostConfig {
  const settings = readService(ctx, 'settings')
  let hosts: Record<string, SshHostConfig> = {}
  if (settings !== null && typeof settings === 'object') {
    const get = (settings as { get?: unknown }).get
    if (typeof get === 'function') {
      hosts = readSshHosts((ns: string) => (get as (ns: string) => unknown)(ns)).hosts
    }
  }
  const host = hosts[hostId]
  if (host === undefined || typeof host !== 'object') {
    throw new SidebarError('fs-error', `remote host "${hostId}" is not configured in dsh-ssh-hosts — add it in Settings → SSH hosts`, 400)
  }
  return { ...host, id: hostId }
}

/** Acquire one pooled connection for a hostId (release with `pool.release()`). */
export async function acquireRemote(ctx: Context, hostId: string): Promise<{ pool: SidebarSshPool; conn: RemoteConn }> {
  const pool = sshPoolOf(ctx)
  if (pool === undefined) {
    throw new SidebarError('internal', 'sshPool service unavailable — is the @dsh-ssh/dsh-ssh plugin loaded?', 503)
  }
  const conn = await pool.acquire(hostConfigOf(ctx, hostId))
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

function shellQuote(value: string): string {
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

/** List one remote directory level, returning local-placeholder entry paths. */
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
): Promise<{ content: string; truncated: boolean; binary: boolean; size: number; head?: string }> {
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
  return { content: binary ? '' : slice.toString('utf8'), truncated, binary, size, head }
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
  if (needle === '') return { matches: [], truncated: false }
  const maxMatches = opts.maxMatches ?? 200
  const maxVisited = opts.maxVisited ?? 100_000
  const pruneExpr = [...SEARCH_SKIP_DIRS].map((name) => `-name ${shellQuote(name)}`).join(' -o ')
  const cmd = 'find ' + shellQuote(remoteRoot)
    + ' -mindepth 1 \\( -type d \\( ' + pruneExpr + ' \\) -prune \\) -o -printf \'%P\\t%y\\n\''
    + ' | head -n ' + (maxVisited + 1)
  const r = await conn.exec(cmd, { timeoutMs: 30_000, maxStdoutBytes: 8 * 1024 * 1024 })
  if (r.code !== 0) {
    throw new SidebarError('fs-error', `cannot search "${remoteRoot}": ${r.stderr || `exit ${r.code}`}`, 400)
  }
  const matches: string[] = []
  let visited = 0
  let truncated = false
  for (const line of r.stdout.split('\n')) {
    if (line === '') continue
    visited += 1
    const idx = line.lastIndexOf('\t')
    if (idx < 0) continue
    const relPath = line.slice(0, idx)
    const name = relPath.includes('/') ? relPath.slice(relPath.lastIndexOf('/') + 1) : relPath
    if (name.toLowerCase().includes(needle)) {
      matches.push(relPath)
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
  return { matches: matches.sort(), truncated }
}

// ── Remote interactive shell (terminal) ────────────────────────────────────

/** An IPty-compatible shell handle (node-pty and the SSH shell share this face). */
export interface SidebarShell {
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void }
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

/** Create a remote shell for a remote cwd; null for a local cwd. */
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
    throw new SidebarError('pty-error', 'the @dsh-ssh/dsh-ssh build does not expose an interactive shell channel', 500)
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
