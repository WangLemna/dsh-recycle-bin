/**
 * Host half of `dsh-session-recycle-bin`.
 *
 * DSH ships no delete API: `@deepseek-ai/dsh-session-persistence-jsonl` states
 * the seam carries no removal, `dsh-workspace` only archives, and the
 * projection cache exposes no eviction. This plugin therefore performs the
 * out-of-band removal itself, but never destructively in one step:
 *
 *     session directory → $DSH_HOME/session-recycle-bin/<entry>/session
 *     projcache record  → $DSH_HOME/session-recycle-bin/<entry>/projcache.json
 *
 * and only clears the workspace accounting entry (workspace membership,
 * archive, pin) once the bytes are safely inside the bin. Restoring is the same
 * moves in reverse; purging is the only step that destroys anything.
 *
 * The service is defined once and consumed by both the HTTP route the Client
 * half posts to and the `delete_session` model tool, so the UI and the model
 * share one implementation and one set of refusals.
 *
 * Deletion admission is DSH's own archive admission: the Workspace registry
 * asks every composed `workspace/session-activity` provider what still runs,
 * and only an idle session is archived (hidden, gated) and then moved. A live
 * Agent alone is not a refusal — every opened session keeps one until Host
 * teardown — so the plugin checks the Agent's running status and pending inbox
 * instead of its mere existence.
 *
 * @module dsh-session-recycle-bin
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { encodeSegment, isSafeSegment, NO_CWD_DIR, projectKey } from './lib/session-paths.js'

export const name = 'session-recycle-bin'

/** Services this plugin cannot work without. */
export const inject = ['sessionPersistence', 'workspaceRegistry', 'sessions']

/** Route the Client half posts JSON to. */
const ROUTE = '/dsh-session-recycle-bin/api'

/** Manifest file name inside one bin entry. */
const MANIFEST = 'entry.json'

/**
 * Manifest schema this build writes.
 *
 * Schema 2 records the whole subagent tree inside one entry (`children[]`);
 * schema 1 held a single session. Reads stay tolerant: an entry without
 * `children` is simply a tree with no descendants, and every `entry.json`
 * written by 1.3.x remains restorable and purgeable.
 */
const SCHEMA = 2

/** Directory holding the subagent sessions of one entry's tree. */
const CHILDREN = 'children'

/**
 * Upper bound on one batch request. A batch is a UI convenience, not a bulk
 * migration tool: unbounded input would hold the HTTP request open for an
 * arbitrarily long sequence of directory moves.
 *
 * Exported for the bundle's offline test, which pins it against
 * {@link MAX_BODY_BYTES} so the largest legal batch always fits the body cap.
 */
export const BATCH_LIMIT = 200

/**
 * Resolve the harness home the way `dsh-home-paths` does — a non-blank
 * `$DSH_HOME`, else `~/.dsh` — without importing that package, so this bundle
 * installs with no dependency on a shipped one.
 * @returns {string} absolute harness home.
 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

/** Sessions root, matching the `session-persistence-jsonl` base configuration. */
function sessionsRoot() {
  return join(dshHome(), 'sessions')
}

/** Projection-cache record directory, matching `storage-json` `root: storages`. */
function projectionRoot() {
  return join(dshHome(), 'storages', 'session_projcache', 'sessions')
}

/** Recycle-bin root. */
function binRoot() {
  return join(dshHome(), 'session-recycle-bin')
}

/**
 * The directory the jsonl backend owns for one session.
 * @param {string} sessionId - stored session id.
 * @param {string|undefined} cwd - the session header's project directory.
 * @returns {string} absolute session directory path.
 */
function sessionDirectory(sessionId, cwd) {
  const project = typeof cwd === 'string' && cwd.length > 0 ? projectKey(cwd) : NO_CWD_DIR
  return join(sessionsRoot(), project, encodeSegment(sessionId))
}

/** Read one JSON file, or `undefined` when it is absent or unparseable. */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  }
  catch {
    return undefined
  }
}

/**
 * Read the display title out of a projection-cache record.
 *
 * The `session_projcache` record nests as
 * `{ version, record: { identity, rows: { <key>: { ver, seq, val } } } }`; a
 * plain `{ values: { title } }` shape is also accepted so a future flattening
 * of the record keeps working.
 * @param {any} record - parsed projection record, or undefined.
 * @returns {string|null} the title, or null when the record carries none.
 */
function titleOf(record) {
  const rows = record?.record?.rows ?? record?.values
  const row = rows?.title
  if (typeof row === 'string') return row
  const value = row?.val
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * The sessions one bin entry carries: the root first, then its subagent tree.
 *
 * Schema 2 stores the tree in `children[]`; a schema 1 entry (written by
 * 1.3.x) has no children and is simply a tree of one. Reads normalize here so
 * restore, purge and the hidden-set rebuild all handle both layouts without
 * repeating the compatibility branch.
 *
 * @param {object} manifest - parsed `entry.json`.
 * @returns {object[]} normalized nodes (`root` marks the entry's own session).
 */
function entryNodes(manifest) {
  const root = {
    sessionId: String(manifest.sessionId),
    root: true,
    cwd: manifest.cwd ?? null,
    projectDir: manifest.projectDir,
    title: manifest.title ?? null,
    createdAt: manifest.createdAt ?? null,
    workspaceIds: Array.isArray(manifest.workspaceIds) ? manifest.workspaceIds : [],
    archived: manifest.archived === true,
    pinned: manifest.pinned === true,
    hadDirectory: manifest.hadDirectory === true,
    hadProjectionRecord: manifest.hadProjectionRecord === true,
  }
  const children = Array.isArray(manifest.children) ? manifest.children : []
  return [root, ...children.map(child => ({
    sessionId: String(child.sessionId),
    root: false,
    cwd: child.cwd ?? null,
    projectDir: child.projectDir,
    title: child.title ?? null,
    createdAt: child.createdAt ?? null,
    workspaceIds: Array.isArray(child.workspaceIds) ? child.workspaceIds : [],
    archived: child.archived === true,
    pinned: child.pinned === true,
    hadDirectory: child.hadDirectory === true,
    hadProjectionRecord: child.hadProjectionRecord === true,
  }))]
}

/**
 * Where one node's artifacts live inside its bin entry.
 *
 * The root keeps the schema 1 names (`session/`, `projcache.json`) so entries
 * written by 1.3.x stay restorable; descendants live one directory deeper,
 * named by their encoded id, so two nodes can never collide.
 *
 * @param {string} entryDir - the entry's directory.
 * @param {object} node - normalized entry node.
 * @returns {{dir: string, record: string}} repository paths inside the entry.
 */
function entryArtifacts(entryDir, node) {
  if (node.root) {
    return { dir: join(entryDir, 'session'), record: join(entryDir, 'projcache.json') }
  }
  const owned = join(entryDir, CHILDREN, encodeSegment(String(node.sessionId)))
  return { dir: join(owned, 'session'), record: join(owned, 'projcache.json') }
}

/**
 * Locate the directory the jsonl backend owns for one session.
 *
 * `projectKey(header.cwd)` is the fast path, but a header may carry no `cwd`
 * (the `_no-cwd` bucket) or a cwd whose spelling drifted from the directory it
 * was written under. The directory name is authoritative instead: it is
 * `encodeSegment(id)` under exactly one project directory, so a bounded scan
 * of the sessions root finds it in every case and never guesses.
 *
 * @param {string} sessionId - stored session id.
 * @param {string|undefined} cwd - the session header's project directory, if any.
 * @returns {Promise<string>} the session directory path, existing or preferred.
 */
async function locateSessionDirectory(sessionId, cwd) {
  const segment = encodeSegment(sessionId)
  const root = sessionsRoot()
  const preferred = sessionDirectory(sessionId, cwd)
  if (await exists(preferred)) return preferred
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  }
  catch {
    return preferred
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = join(root, project.name, segment)
    if (await exists(candidate)) return candidate
  }
  return preferred
}

/** Whether a path exists (file or directory). */
async function exists(path) {
  try {
    await stat(path)
    return true
  }
  catch {
    return false
  }
}

/**
 * A refusal with a stable machine code the Client maps to localized copy.
 */
class BinError extends Error {
  /**
   * @param {string} code - stable code, e.g. `session-open`.
   * @param {string} message - English reason, for logs and the model.
   * @param {object} [details] - extra fields for the caller.
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'BinError'
    this.code = code
    this.details = details
  }
}

/** A timestamp fragment that is legal on every filesystem. */
function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

/** Move a directory, copying across volumes when `rename` reports `EXDEV`. */
async function moveDirectory(from, to) {
  try {
    await rename(from, to)
  }
  catch (error) {
    // A cross-volume move is the documented `EXDEV`; anything else is a real
    // failure (a lock, a permission denial) and must not be turned into a copy
    // that could leave two live copies of one session.
    if (error.code !== 'EXDEV') throw error
    await copyTree(from, to)
    await rm(from, { recursive: true, force: true })
  }
}

/** Move a file, copying across volumes when `rename` reports `EXDEV`. */
async function moveFile(from, to) {
  try {
    await rename(from, to)
  }
  catch (error) {
    if (error.code !== 'EXDEV') throw error
    await writeFile(to, await readFile(from))
    await rm(from, { force: true })
  }
}

/** Recursively copy a directory tree. */
async function copyTree(from, to) {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) await copyTree(source, target)
    else await writeFile(target, await readFile(source))
  }
}

/** Serialize one JSON reply. */
function sendJson(response, status, payload) {
  response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

/**
 * Maximum accepted request body.
 *
 * A batch of `BATCH_LIMIT` session ids is roughly 200 × 48 bytes plus JSON
 * syntax — about 10 KiB — so the previous 8 KiB bound would reject the largest
 * legal batch before `normalizeBatch()` ever saw it. The bound still exists to
 * keep one request from buffering an unbounded body.
 *
 * Exported so the offline test can prove the largest legal batch fits.
 */
export const MAX_BODY_BYTES = 64 * 1024

/**
 * Read a small JSON request body; an empty body reads as `{}`.
 * @param {import('node:http').IncomingMessage} request - the request stream.
 * @param {number} [maxBytes] - accepted body size.
 * @returns {Promise<any>} the parsed body.
 */
async function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new BinError('body-too-large', `request body exceeds ${Math.round(maxBytes / 1024)} KiB`)
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  catch {
    throw new BinError('body-invalid', 'request body is not valid JSON')
  }
}

/**
 * HTTP status for a stable refusal code.
 * @param {string} code - the refusal code.
 * @returns {number} status.
 */
function statusFor(code) {
  switch (code) {
    case 'session-invalid':
    case 'bin-invalid':
    case 'action-invalid':
    case 'body-invalid':
    case 'body-too-large':
    case 'batch-invalid':
      return 400
    case 'session-unknown':
    case 'bin-unknown':
      return 404
    case 'session-open':
    case 'session-child':
    case 'restore-conflict':
      return 409
    default:
      return 500
  }
}

/**
 * Hide deleted-but-still-live sessions from the unified session corpus.
 *
 * Moving a session's files does not remove its live Session object: the session
 * controller background-activates every opened session and its Agent keeps the
 * Session in `ctx.sessions` until Host teardown, while
 * `sessionQuery.listSessions()` merges live sessions over persisted ones. A
 * deleted session would therefore reappear on the next list refresh as the
 * sidebar's synthetic "Ungrouped" group (it no longer belongs to any
 * Workspace). This wrapper filters exactly the ids the service is hiding and is
 * restored on plugin unload.
 *
 * Exported for the bundle's offline test; the Loader only uses `apply`.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context (needs `sessionQuery`).
 * @param {Set<string>} hidden - session ids to omit from the corpus list.
 * @returns {() => void} disposer restoring the original method.
 */
export function installHiddenSessionFilter(ctx, hidden) {
  const query = ctx.get('sessionQuery')
  const proto = query === undefined ? undefined : Object.getPrototypeOf(query)
  const original = proto?.listSessions
  if (typeof original !== 'function') {
    ctx.logger?.warn?.('session-recycle-bin: sessionQuery.listSessions is unavailable; deleted live sessions may reappear as Ungrouped')
    return () => {}
  }
  const wrapper = async function listSessionsWithoutDeleted(...args) {
    const records = await original.apply(this, args)
    if (hidden.size === 0) return records
    return records.filter(record => !hidden.has(String(record?.header?.id ?? record?.header)))
  }
  proto.listSessions = wrapper
  return () => {
    if (proto.listSessions === wrapper) proto.listSessions = original
  }
}

/**
 * Recycle-bin service over session directories plus workspace accounting.
 *
 * Exported so the bundle's own offline test can drive the real code against a
 * throwaway `$DSH_HOME`; the Loader only ever uses `apply`.
 */
export class SessionRecycleBin {
  /** @param {import('@deepseek-ai/cordis').Context} ctx - plugin context. */
  constructor(ctx) {
    this.ctx = ctx
    // Live sessions whose files are in the bin; filtered out of the corpus
    // list until their Agent goes away or the session is restored.
    this.hidden = new Set()
  }

  /** @returns {Promise<readonly object[]>} persistence snapshots. */
  async snapshots() {
    return await this.ctx.sessionPersistence.list()
  }

  /**
   * Resolve one stored session to its header.
   * @param {unknown} sessionId - id supplied by the UI or the model.
   * @param {readonly object[]} [snapshots] - a listing the caller already took.
   * @returns {Promise<{header: object}>} the stored header.
   * @throws {BinError} `session-invalid` | `session-unknown`.
   */
  async inspect(sessionId, snapshots) {
    if (!isSafeSegment(sessionId) || sessionId.length > 120) {
      throw new BinError('session-invalid', `"${String(sessionId)}" is not a plausible session id`)
    }
    const id = String(sessionId)
    const listed = snapshots ?? await this.snapshots()
    const snapshot = listed.find(entry => String(entry.header.id) === id)
    if (snapshot === undefined) {
      throw new BinError('session-unknown', `no stored session has id "${id}"`, { sessionId: id })
    }
    return { header: snapshot.header }
  }

  /**
   * The live Agent that currently holds one session, if this Host has one.
   * @param {string} sessionId - session identity.
   * @returns {object|undefined} the live Agent.
   */
  liveAgent(sessionId) {
    return this.ctx.get('agents')?.get(String(sessionId))
  }

  /**
   * Index every stored header by the session that parents it.
   *
   * A subagent child is the only session kind that records lineage, so the
   * `origin: 'subagent'` + `parentSession` pair is the whole definition of the
   * tree: a fork carries `parentSession` too but stays an independent
   * conversation, and must never be dragged along with its source.
   *
   * @param {readonly object[]} [snapshots] - a listing the caller already took.
   * @returns {Promise<Map<string, object[]>>} parent id → direct child headers.
   */
  async childIndex(snapshots) {
    const index = new Map()
    for (const snapshot of snapshots ?? await this.snapshots()) {
      const header = snapshot?.header
      if (header?.origin !== 'subagent' || typeof header.parentSession !== 'string') continue
      const siblings = index.get(header.parentSession) ?? []
      siblings.push(header)
      index.set(header.parentSession, siblings)
    }
    return index
  }

  /**
   * Every subagent descendant of one session, at any depth, in discovery order.
   *
   * The tree is read from persistence (headers), not from the sidebar: child
   * sessions never render as rows, so this is the only complete source of
   * "what follows this conversation". A damaged lineage that loops is visited
   * once, and a child whose log is unreadable is simply absent from the
   * listing — it cannot be moved, and refusing the whole delete would strand
   * the parent's own bytes.
   *
   * @param {string} sessionId - root session id.
   * @param {Map<string, object[]>} [index] - pre-built child index, for batches.
   * @returns {Promise<object[]>} descendant headers.
   */
  async descendants(sessionId, index) {
    const childrenOf = index ?? await this.childIndex()
    const descendants = []
    const seen = new Set([String(sessionId)])
    const pending = [String(sessionId)]
    while (pending.length > 0) {
      const parentId = pending.shift()
      for (const header of childrenOf.get(parentId) ?? []) {
        const id = String(header.id)
        if (seen.has(id)) continue
        seen.add(id)
        descendants.push(header)
        pending.push(id)
      }
    }
    return descendants
  }

  /**
   * Resolve one session header plus every artifact the bin has to move for it.
   *
   * Each node names the directory actually found on disk (a header's `cwd` may
   * be absent or spell the directory differently), the projection-cache record,
   * and whether either existed — so a subtree that was never materialized is
   * still restorable as "nothing to put back".
   *
   * @param {object} header - stored session header.
   * @param {boolean} root - whether this is the entry's own session.
   * @returns {Promise<object>} the move plan for that session.
   */
  async plan(header, root) {
    const id = String(header.id)
    const source = await locateSessionDirectory(id, header.cwd)
    const recordPath = join(projectionRoot(), `${id}.json`)
    const record = await readJson(recordPath)
    return {
      sessionId: id,
      root,
      header,
      cwd: typeof header.cwd === 'string' ? header.cwd : null,
      projectDir: basename(dirname(source)),
      title: titleOf(record),
      source,
      recordPath,
      hadDirectory: await exists(source),
      hadProjectionRecord: record !== undefined,
    }
  }

  /**
   * Where one planned session has to go back to on restore.
   *
   * The recorded project directory is authoritative: it is where the log was
   * actually found, which is more reliable than re-deriving it from a header
   * whose `cwd` may have drifted.
   *
   * @param {object} node - manifest node (`sessionId`, `projectDir`, `cwd`).
   * @returns {string} absolute session directory path.
   */
  targetOf(node) {
    const id = String(node.sessionId)
    return typeof node.projectDir === 'string' && isSafeSegment(node.projectDir)
      ? join(sessionsRoot(), node.projectDir, encodeSegment(id))
      : sessionDirectory(id, node.cwd ?? undefined)
  }

  /**
   * Hide one trashed session from the corpus list while its Agent is still live
   * in this Host process (see {@link installHiddenSessionFilter}).
   * @param {string} sessionId - trashed session.
   */
  hideWhileLive(sessionId) {
    if (this.liveAgent(sessionId) !== undefined) this.hidden.add(String(sessionId))
  }

  /**
   * Rebuild the hidden set from the bin. A plugin reload loses the in-memory
   * set while the live Agents (and their Sessions) survive, so an entry that
   * was trashed earlier in this Host process must be hidden again — including
   * every subagent in its tree, whose Agent may be parked but still live.
   * @returns {Promise<void>} after every bin entry was inspected.
   */
  async repopulateHidden() {
    for (const row of await this.list()) {
      for (const node of entryNodes(row)) this.hideWhileLive(String(node.sessionId))
    }
  }

  /**
   * Whether a live Agent is running or holds accepted work it has not claimed
   * yet. An opened-but-idle session keeps a live Agent in this Host — the
   * session controller background-activates every opened session and keeps
   * that Agent until Host teardown — and that alone is *not* work, so it must
   * not block deletion.
   * @param {object|undefined} agent - live Agent, if any.
   * @returns {boolean} true while the Agent has work.
   */
  isBusy(agent) {
    if (agent === undefined) return false
    if (agent.status === 'running') return true
    const pending = value => (Array.isArray(value) ? value.length : 0)
    return pending(agent.inbox?.nextTurn) + pending(agent.inbox?.nextStep) > 0
  }

  /**
   * Refusal for a session that still has real work. It keeps the stable
   * `session-open` code the UI already localizes.
   * @param {string} sessionId - refused session.
   * @param {string} reason - what was observed.
   * @param {object|undefined} agent - live Agent that carried the work.
   * @returns {BinError} refusal.
   */
  activeRefusal(sessionId, reason, agent) {
    return new BinError('session-open', `the session still has work in this Harness process: ${reason}`, {
      sessionId,
      agentStatus: typeof agent?.status === 'string' ? agent.status : null,
    })
  }

  /**
   * Take the official deletion admission: archive the session through the
   * Workspace registry. It asks the composed `workspace/session-activity`
   * providers what still runs for the session (its turn, jobs, subagents,
   * reminders) and refuses while anything does, before any registry write. A
   * successful archive hides the row at once and installs the archived gate,
   * which blocks a model step for a wake-up that races that activity answer.
   * @param {string} sessionId - session about to be deleted.
   * @throws {BinError} `session-open` for a still-active session.
   */
  async admit(sessionId) {
    try {
      await this.ctx.workspaceRegistry.archiveSession(sessionId)
    }
    catch (error) {
      if (error?.name === 'WorkspaceActiveSessionError') {
        const activity = Array.isArray(error.activity) ? error.activity : []
        const kinds = [...new Set(activity.map(entry => String(entry?.kind ?? 'work')))]
        throw new BinError('session-open', `the session is still active (${kinds.join(', ') || 'running work'}); wait for it to finish before deleting`, {
          sessionId,
          activity,
        })
      }
      if (error?.name === 'WorkspaceUnknownSessionError') {
        throw new BinError('session-unknown', `no stored session has id "${sessionId}"`, { sessionId })
      }
      throw error
    }
  }

  /**
   * Undo the accounting side effects of an admission whose move then failed:
   * archiving hid the row and dropped a pin, so put both back.
   * @param {string} sessionId - failed target.
   * @param {{archived: boolean, pinned: boolean}} owners - registry view taken before admission.
   */
  async restoreAccounting(sessionId, owners) {
    const registry = this.ctx.workspaceRegistry
    if (!owners.archived) {
      await registry.unarchiveSession(sessionId).catch(error => this.ctx.logger.warn(`session-recycle-bin: archive rollback failed: ${String(error)}`))
    }
    if (owners.pinned && !owners.archived) {
      await registry.pinSession(sessionId).catch(error => this.ctx.logger.warn(`session-recycle-bin: pin rollback failed: ${String(error)}`))
    }
  }

  /**
   * Move one session — and every subagent session under it — into the recycle
   * bin as ONE entry, then clear every registry trace.
   *
   * A subagent child is an owned descendant, not a peer: its header carries
   * `origin: 'subagent'` + `parentSession`, it never gets a Workspace accounting
   * slot (so it never has a sidebar row), and the shipped browser draws it only
   * inside its parent's catalog. Leaving children behind when their parent is
   * deleted would strand their bytes with a `parentSession` nobody can navigate
   * to, so the tree travels as a unit: one entry, one restore, one purge.
   *
   * A live Agent is not a refusal by itself: the session controller
   * background-activates every opened session and keeps that Agent until Host
   * teardown, so refusing on `ctx.agents.get()` alone would make any recently
   * opened session — even one where the user typed nothing — undeletable.
   * What must be protected is *running work*; archive admission reports it
   * from every activity provider before anything is hidden or moved, and each
   * descendant is checked the same way before a byte moves.
   *
   * The log's write handle stays valid across a directory rename (POSIX and
   * Windows both follow the file object, not the path), so moving an idle
   * session's directory does not disturb its Agent; restoring moves the same
   * bytes back under that handle. The session list only reads persisted
   * records, so a moved session stops appearing even while its Agent lives.
   *
   * @param {unknown} sessionId - target session.
   * @returns {Promise<object>} the bin entry descriptor.
   */
  async trash(sessionId) {
    // One listing answers the whole tree: the root header, whether the parent
    // still exists (for the standalone-delete guard), and every child header.
    const snapshots = await this.snapshots()
    const { header } = await this.inspect(sessionId, snapshots)
    const id = String(sessionId)
    // Guard the standalone-delete escape hatch: a subagent may only be deleted
    // directly once its parent is gone (an orphan left by an older build), not
    // while the parent still exists — deleting the parent is what removes it.
    const parentId = typeof header.parentSession === 'string' ? header.parentSession : undefined
    const parentStored = parentId !== undefined && snapshots.some(snapshot => String(snapshot?.header?.id) === parentId)
    if (header.origin === 'subagent' && parentId !== undefined && parentStored) {
      throw new BinError('session-child', `"${id}" is a subagent session of "${parentId}"; delete the parent session instead — subagents follow their parent`, { sessionId: id, parentSessionId: parentId })
    }
    const childIndex = await this.childIndex(snapshots)
    const nodes = []
    for (const candidate of [header, ...await this.descendants(id, childIndex)]) {
      nodes.push(await this.plan(candidate, String(candidate.id) === id))
    }
    const owners = await this.owners(id)
    this.assertTreeIdle(nodes, 'the Agent is running or has queued input')

    const entryId = `${stamp()}-${encodeSegment(id)}`
    const entryDir = join(binRoot(), entryId)
    const manifest = {
      schema: SCHEMA,
      sessionId: id,
      cwd: nodes[0].cwd,
      // The project directory actually found on disk. A header may carry no
      // `cwd`, and restore must return the log to the exact directory it left,
      // not to whatever the header would derive.
      projectDir: nodes[0].projectDir,
      title: nodes[0].title,
      createdAt: nodes[0].createdAt,
      deletedAt: new Date().toISOString(),
      workspaceIds: owners.workspaces,
      archived: owners.archived,
      pinned: owners.pinned,
      hadDirectory: nodes[0].hadDirectory,
      hadProjectionRecord: nodes[0].hadProjectionRecord,
      childCount: nodes.length - 1,
      children: nodes.slice(1).map(node => ({
        sessionId: node.sessionId,
        cwd: node.cwd,
        projectDir: node.projectDir,
        title: node.title,
        createdAt: node.createdAt,
        workspaceIds: node.workspaceIds,
        archived: node.archived,
        pinned: node.pinned,
        hadDirectory: node.hadDirectory,
        hadProjectionRecord: node.hadProjectionRecord,
      })),
    }

    await this.admit(id)

    try {
      // Admission is not atomic with the move: a wake-up may have started work
      // between the activity answer and now. Refuse that race instead of
      // dragging a writing log into the bin. The admission's subagent family
      // already covers running descendants, but a parked child with queued
      // input is caught here too.
      this.assertTreeIdle(nodes, 'the Agent started work while the session was being admitted')
      await mkdir(entryDir, { recursive: true })
      for (const node of nodes) {
        const artifacts = entryArtifacts(entryDir, node)
        if (node.hadDirectory) {
          await mkdir(dirname(artifacts.dir), { recursive: true })
          await moveDirectory(node.source, artifacts.dir)
        }
        if (node.hadProjectionRecord) {
          await mkdir(dirname(artifacts.record), { recursive: true })
          await moveFile(node.recordPath, artifacts.record)
        }
      }
      await writeFile(join(entryDir, MANIFEST), JSON.stringify(manifest, null, 2), 'utf8')
    }
    catch (error) {
      // A failure must never lose bytes: put back whatever already moved, then
      // un-hide the session.
      await this.rollback(entryDir, nodes)
      await this.restoreAccounting(id, owners)
      throw error
    }

    // The bytes are safe inside the bin; hide every still-live session in the
    // tree (a parked child Agent survives its parent's teardown), then make
    // every read model forget the whole tree.
    for (const node of nodes) this.hideWhileLive(node.sessionId)
    for (const node of nodes) await this.forget(node.sessionId)
    for (const node of nodes) this.ctx.emit('api-session/removed', node.sessionId)
    return { ...manifest, binId: entryId, action: 'trash' }
  }

  /**
   * Refuse the whole tree while any member still has work.
   * @param {object[]} nodes - planned tree nodes.
   * @param {string} reason - what the check observed.
   */
  assertTreeIdle(nodes, reason) {
    for (const node of nodes) {
      const agent = this.liveAgent(node.sessionId)
      if (this.isBusy(agent)) throw this.activeRefusal(node.sessionId, reason, agent)
    }
  }

  /** Undo the moves of a half-finished `trash`, every node back to its origin. */
  async rollback(entryDir, nodes) {
    for (const node of [...nodes].reverse()) {
      const artifacts = entryArtifacts(entryDir, node)
      if (await exists(artifacts.dir)) {
        await mkdir(dirname(node.source), { recursive: true })
        await moveDirectory(artifacts.dir, node.source)
      }
      if (await exists(artifacts.record)) {
        await mkdir(dirname(node.recordPath), { recursive: true })
        await moveFile(artifacts.record, node.recordPath)
      }
    }
    await rm(entryDir, { recursive: true, force: true }).catch(() => {})
  }

  /**
   * Drop one session id from every registry set that could resurrect the row:
   * the archive set, the pin set and each workspace's membership.
   * @param {string} sessionId - the removed session.
   */
  async forget(sessionId) {
    const registry = this.ctx.workspaceRegistry
    await registry.unarchiveSession(sessionId).catch(error => this.ctx.logger.warn(`session-recycle-bin: unarchive cleanup failed: ${String(error)}`))
    await registry.unpinSession(sessionId).catch(error => this.ctx.logger.warn(`session-recycle-bin: unpin cleanup failed: ${String(error)}`))
    for (const entity of registry.list()) {
      await entity.detachSession(sessionId).catch(error => this.ctx.logger.warn(`session-recycle-bin: detach cleanup failed: ${String(error)}`))
    }
  }

  /**
   * Which workspaces account a session, and whether it is archived or pinned.
   * @param {string} sessionId - the session.
   * @returns {Promise<{workspaces: string[], archived: boolean, pinned: boolean}>} current registry view.
   */
  async owners(sessionId) {
    const registry = this.ctx.workspaceRegistry
    const workspaces = []
    for (const entity of registry.list()) {
      if (entity.sessionIds.includes(sessionId)) workspaces.push(String(entity.id))
    }
    return {
      workspaces,
      archived: registry.archivedSessionIds.includes(sessionId),
      pinned: registry.pinnedSessionIds.includes(sessionId),
    }
  }

  /**
   * List recycle-bin entries, newest first.
   *
   * `childCount` is projected next to each manifest so both channels (the
   * dialog copy and the tool's summary) can state how many subagent sessions
   * an entry carries without walking the manifest themselves.
   *
   * @returns {Promise<object[]>} manifests carrying their bin id.
   */
  async list() {
    let entries
    try {
      entries = await readdir(binRoot(), { withFileTypes: true })
    }
    catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    const rows = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const manifest = await readJson(join(binRoot(), entry.name, MANIFEST))
      if (manifest === undefined) continue
      rows.push({ ...manifest, binId: entry.name, childCount: Array.isArray(manifest.children) ? manifest.children.length : 0 })
    }
    rows.sort((left, right) => String(right.deletedAt).localeCompare(String(left.deletedAt)))
    return rows
  }

  /**
   * Move one bin entry — its session and every subagent under it — back into
   * the live session tree and try to re-account each.
   *
   * A session deleted while only an idle Agent held it still has that Agent, and
   * the agent's open log handle follows the file object across the two renames,
   * so restoring does not require the Agent to be gone. Its in-memory history is
   * exactly the moved log, so a subsequent prompt continues normally.
   *
   * Every target is checked before any byte moves: a tree half-restored would
   * split one conversation between the bin and the sessions tree, so a single
   * occupied target refuses the whole entry and leaves it intact.
   *
   * @param {unknown} binId - entry id, or the session id the entry holds.
   * @returns {Promise<object>} the restored descriptor.
   */
  async restore(binId) {
    const entryDir = await this.resolveEntry(binId)
    const manifest = await readJson(join(entryDir, MANIFEST))
    if (manifest === undefined) throw new BinError('bin-unknown', `recycle-bin entry "${String(binId)}" has no readable manifest`, { binId: String(binId) })
    const nodes = entryNodes(manifest)
    const wasHidden = []
    for (const node of nodes) if (this.hidden.delete(node.sessionId)) wasHidden.push(node.sessionId)
    const moved = []
    try {
      // Restore to the exact project directory each log came from; fall back to
      // the header-derived path only for a manifest written without one.
      for (const node of nodes) {
        if (!node.hadDirectory) continue
        const target = this.targetOf(node)
        if (await exists(target)) {
          throw new BinError('restore-conflict', 'a session directory already exists at the restore target', { sessionId: node.sessionId, path: target })
        }
      }
      for (const node of nodes) {
        const artifacts = entryArtifacts(entryDir, node)
        if (await exists(artifacts.dir)) {
          const target = this.targetOf(node)
          await mkdir(dirname(target), { recursive: true })
          await moveDirectory(artifacts.dir, target)
          moved.push({ from: target, to: artifacts.dir, kind: 'dir' })
        }
        if (await exists(artifacts.record)) {
          const recordPath = join(projectionRoot(), `${node.sessionId}.json`)
          await mkdir(dirname(recordPath), { recursive: true })
          // A record that reappeared while the entry sat in the bin is newer
          // than the cached copy; keep it and drop the stale one.
          if (await exists(recordPath)) await rm(artifacts.record, { force: true })
          else {
            await moveFile(artifacts.record, recordPath)
            moved.push({ from: recordPath, to: artifacts.record, kind: 'file' })
          }
        }
      }
      for (const node of nodes) await this.reattach(node)
      await rm(entryDir, { recursive: true, force: true })
      for (const node of nodes) this.ctx.emit('api-session/removed', node.sessionId)
      return { ...manifest, binId: basename(entryDir), action: 'restore' }
    }
    catch (error) {
      // Put the restored bytes back inside the entry so it stays restorable,
      // then restore the corpus-hiding facts this attempt cleared.
      for (const move of [...moved].reverse()) {
        if (!await exists(move.from)) continue
        await mkdir(dirname(move.to), { recursive: true })
        await (move.kind === 'dir' ? moveDirectory(move.from, move.to) : moveFile(move.from, move.to))
          .catch(rollbackError => this.ctx.logger.warn(`session-recycle-bin: restore rollback failed: ${String(rollbackError)}`))
      }
      for (const sessionId of wasHidden) this.hidden.add(sessionId)
      throw error
    }
  }

  /**
   * Best-effort return of a restored session to the workspace and sets it held.
   * A failure here only leaves the session under "Ungrouped".
   * @param {object} node - normalized entry node.
   */
  async reattach(node) {
    const registry = this.ctx.workspaceRegistry
    const id = String(node.sessionId)
    for (const workspaceId of node.workspaceIds ?? []) {
      const entity = registry.get(workspaceId)
      if (entity === undefined) continue
      await entity.attachSession(id).catch(error => this.ctx.logger.warn(`session-recycle-bin: reattach to workspace "${workspaceId}" failed: ${String(error)}`))
    }
    if (node.archived === true) {
      await registry.archiveSession(id, { stopActivity: true }).catch(error => this.ctx.logger.warn(`session-recycle-bin: re-archive failed: ${String(error)}`))
    }
    if (node.pinned === true) {
      await registry.pinSession(id).catch(error => this.ctx.logger.warn(`session-recycle-bin: re-pin failed: ${String(error)}`))
    }
  }

  /**
   * Permanently delete one bin entry — the session and every subagent in it.
   * The only destructive operation here.
   * @param {unknown} binId - entry id, or the session id the entry holds.
   * @returns {Promise<object>} the purged descriptor.
   */
  async purge(binId) {
    const entryDir = await this.resolveEntry(binId)
    const manifest = await readJson(join(entryDir, MANIFEST))
    if (manifest === undefined) throw new BinError('bin-unknown', `recycle-bin entry "${String(binId)}" has no readable manifest`, { binId: String(binId) })
    const nodes = entryNodes(manifest)
    await rm(entryDir, { recursive: true, force: true })
    // The bytes are gone, but a live Agent may still carry the Session object;
    // keep every id in the tree out of the corpus list so none can reappear as
    // Ungrouped.
    for (const node of nodes) this.hideWhileLive(node.sessionId)
    return { ...manifest, binId: basename(entryDir), action: 'purge' }
  }

  /**
   * Empty the whole bin.
   * @returns {Promise<{purged: number, childCount: number}>} how many entries and subagent sessions were destroyed.
   */
  async purgeAll() {
    const rows = await this.list()
    let childCount = 0
    for (const row of rows) {
      childCount += Number(row.childCount ?? 0)
      await this.purge(row.binId)
    }
    return { purged: rows.length, childCount }
  }

  /**
   * Describe what deleting these sessions would move, without moving anything.
   *
   * The confirmation dialogs ask this so they can state, before the click,
   * how many subagent sessions travel with the sessions the user picked. The
   * answer is advisory: `trash()` re-resolves the tree itself, so a stale
   * preview can only mis-state a count, never move the wrong thing. Unknown
   * ids are reported as `missing` instead of refusing — the dialog still lets
   * the user confirm, and the delete itself reports the real refusal code.
   *
   * @param {unknown} sessionIds - sessions the caller is about to delete.
   * @returns {Promise<{sessions: object[], childCount: number, missing: string[]}>} per-session tree counts and their total.
   */
  async preview(sessionIds) {
    const ids = this.normalizeBatch(sessionIds)
    const snapshots = await this.snapshots()
    const headers = new Map()
    for (const snapshot of snapshots) {
      const header = snapshot?.header
      if (header !== undefined) headers.set(String(header.id), header)
    }
    const childIndex = await this.childIndex(snapshots)
    const requested = new Set(ids)
    const descendantIds = new Set()
    const sessions = []
    for (const id of ids) {
      const header = headers.get(id)
      const descendants = header === undefined ? [] : await this.descendants(id, childIndex)
      for (const child of descendants) descendantIds.add(String(child.id))
      const children = []
      for (const child of descendants) {
        const childId = String(child.id)
        // A selected session that is itself a descendant is already counted as
        // its own preview row; do not count it twice in the total.
        if (requested.has(childId)) continue
        children.push({ sessionId: childId, title: await this.titleOfStored(childId) })
      }
      sessions.push({
        sessionId: id,
        title: header === undefined ? null : await this.titleOfStored(id),
        known: header !== undefined,
        children,
        childCount: children.length,
      })
    }
    return {
      sessions,
      childCount: [...descendantIds].filter(id => !requested.has(id)).length,
      missing: sessions.filter(session => !session.known).map(session => session.sessionId),
    }
  }

  /**
   * Read one stored session's display title from its projection-cache record.
   * @param {string} sessionId - stored session id.
   * @returns {Promise<string|null>} the cached title, or null.
   */
  async titleOfStored(sessionId) {
    return titleOf(await readJson(join(projectionRoot(), `${sessionId}.json`)))
  }

  /**
   * Normalize a list of bin entry ids: a non-empty, bounded array of distinct
   * ids. Mirrors {@link normalizeBatch} but validates bin ids instead of
   * session ids, so a traversal-shaped value is refused before any filesystem
   * path is built.
   * @param {unknown} binIds - caller-supplied entry ids.
   * @returns {string[]} the same ids, de-duplicated, in caller order.
   * @throws {BinError} `batch-invalid` for anything that is not such a list.
   */
  normalizeBinIds(binIds) {
    if (!Array.isArray(binIds) || binIds.length === 0) {
      throw new BinError('batch-invalid', 'a bulk bin action needs a non-empty "binIds" array', { limit: BATCH_LIMIT })
    }
    if (binIds.length > BATCH_LIMIT) {
      throw new BinError('batch-invalid', `at most ${BATCH_LIMIT} recycle-bin entries may be handled at once`, { limit: BATCH_LIMIT, size: binIds.length })
    }
    const ids = []
    for (const value of binIds) {
      if (!isSafeSegment(value)) throw new BinError('bin-invalid', `"${String(value)}" is not a plausible recycle-bin id`)
      const id = String(value)
      if (!ids.includes(id)) ids.push(id)
    }
    return ids
  }

  /**
   * Restore several bin entries.
   *
   * Each id runs the full {@link restore} path, so a restored session keeps its
   * exact project directory, its archive/pin accounting and its workspace
   * membership; the outcome is reported as a split rather than failing the
   * whole request, because one conflicted entry (a live directory with the same
   * id appeared meanwhile) must not strand the others in the bin.
   *
   * @param {unknown} binIds - entries to restore.
   * @returns {Promise<{restored: object[], failed: object[]}>} the outcome split.
   */
  async restoreMany(binIds) {
    const ids = this.normalizeBinIds(binIds)
    const restored = []
    const failed = []
    for (const binId of ids) {
      try {
        const result = await this.restore(binId)
        restored.push({ binId: String(result.binId), sessionId: String(result.sessionId) })
      }
      catch (error) {
        failed.push({ binId, code: typeof error?.code === 'string' ? error.code : 'internal', message: error?.message ?? String(error) })
      }
    }
    return { restored, failed }
  }

  /**
   * Permanently delete several bin entries. The same per-entry path as
   * {@link purge}; the only destructive bulk action the plugin offers, and the
   * UI puts a confirmation in front of it.
   * @param {unknown} binIds - entries to destroy.
   * @returns {Promise<{purged: object[], failed: object[]}>} the outcome split.
   */
  async purgeMany(binIds) {
    const ids = this.normalizeBinIds(binIds)
    const purged = []
    const failed = []
    for (const binId of ids) {
      try {
        const result = await this.purge(binId)
        purged.push({ binId: String(result.binId), sessionId: String(result.sessionId) })
      }
      catch (error) {
        failed.push({ binId, code: typeof error?.code === 'string' ? error.code : 'internal', message: error?.message ?? String(error) })
      }
    }
    return { purged, failed }
  }

  /**
   * Normalize a batch request: a non-empty, bounded array of distinct ids.
   *
   * A batch is a UI convenience on top of the one-session operations, so it
   * validates once and then runs the exact same per-session code — including
   * every refusal and every rollback. An over-long list is refused rather than
   * truncated: silently dropping the tail would report success for work the
   * caller asked for and did not get.
   *
   * @param {unknown} sessionIds - caller-supplied ids.
   * @returns {string[]} the same ids, de-duplicated, in caller order.
   * @throws {BinError} `batch-invalid` for anything that is not such a list.
   */
  normalizeBatch(sessionIds) {
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new BinError('batch-invalid', 'a batch needs a non-empty "sessionIds" array', { limit: BATCH_LIMIT })
    }
    if (sessionIds.length > BATCH_LIMIT) {
      throw new BinError('batch-invalid', `at most ${BATCH_LIMIT} sessions may be handled in one batch`, { limit: BATCH_LIMIT, size: sessionIds.length })
    }
    const ids = []
    for (const value of sessionIds) {
      if (!isSafeSegment(value) || String(value).length > 120) {
        throw new BinError('session-invalid', `"${String(value)}" is not a plausible session id`)
      }
      const id = String(value)
      if (!ids.includes(id)) ids.push(id)
    }
    return ids
  }

  /**
   * Archive a batch through the registry.
   *
   * This is DSH's own archive, not the recycle bin: an archived session keeps
   * every byte, leaves the default sidebar list, and comes back through the
   * shipped "show archived" filter or `unarchiveSession`. The batch is
   * best-effort by design — a session that still has running work is refused by
   * the same `workspace/session-activity` admission every shipped archive call
   * goes through — so the answer reports both halves instead of failing the
   * whole request.
   *
   * @param {unknown} sessionIds - sessions to archive.
   * @returns {Promise<{archived: string[], failed: object[]}>} the outcome split.
   */
  async archiveMany(sessionIds) {
    const ids = this.normalizeBatch(sessionIds)
    const archived = []
    const failed = []
    for (const id of ids) {
      try {
        await this.ctx.workspaceRegistry.archiveSession(id)
        archived.push(id)
      }
      catch (error) {
        if (error?.name === 'WorkspaceActiveSessionError') {
          const activity = Array.isArray(error.activity) ? error.activity : []
          failed.push({
            sessionId: id,
            code: 'session-open',
            message: 'the session is still active; stop its work or wait for it to finish before archiving',
            activity,
          })
          continue
        }
        if (error?.name === 'WorkspaceUnknownSessionError') {
          failed.push({ sessionId: id, code: 'session-unknown', message: `no stored session has id "${id}"` })
          continue
        }
        // A storage fault is not a per-session refusal; stop rather than
        // reporting a half-applied batch as if the rest had failed for a reason.
        throw error
      }
    }
    return { archived, failed }
  }

  /**
   * Move a batch of sessions into the bin.
   *
   * Each id runs the full {@link trash} path (admission, move, accounting
   * cleanup, corpus hiding), so a batch is exactly N single deletes and inherits
   * their safety: a refused session stays visible and unmoved, and a failure
   * mid-way leaves the sessions already trashed safely in the bin, restorable
   * one by one. The answer is the outcome split, not an all-or-nothing error.
   *
   * A batch may name both a session and one of its subagents; the subagent is
   * skipped and reported as part of its ancestor's entry instead of failing
   * with `session-unknown` after the ancestor already moved it.
   *
   * @param {unknown} sessionIds - sessions to delete.
   * @returns {Promise<{trashed: object[], failed: object[]}>} the outcome split.
   */
  async trashMany(sessionIds) {
    const ids = this.normalizeBatch(sessionIds)
    const childIndex = await this.childIndex()
    const requested = new Set(ids)
    /** Requested id → the requested ancestor whose tree already moves it. */
    const covered = new Map()
    for (const id of ids) {
      for (const header of await this.descendants(id, childIndex)) {
        const childId = String(header.id)
        if (requested.has(childId) && !covered.has(childId)) covered.set(childId, id)
      }
    }
    const trashed = []
    const failed = []
    const byRoot = new Map()
    const failedById = new Map()
    for (const id of ids) {
      if (covered.has(id)) continue
      try {
        const result = await this.trash(id)
        byRoot.set(id, String(result.binId))
        trashed.push({ sessionId: String(result.sessionId), binId: String(result.binId), title: result.title ?? null, childCount: Number(result.childCount ?? 0) })
      }
      catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'internal'
        const entry = {
          sessionId: id,
          code,
          message: error?.message ?? String(error),
          ...(error?.details?.activity === undefined ? {} : { activity: error.details.activity }),
        }
        failedById.set(id, entry)
        failed.push(entry)
      }
    }
    for (const [id, ancestorId] of covered) {
      const binId = byRoot.get(ancestorId)
      if (binId !== undefined) {
        trashed.push({ sessionId: id, binId, title: null, childCount: 0, withParent: ancestorId })
        continue
      }
      // The ancestor was refused, so it never moved this subagent: report the
      // real refusal against the child too instead of silently dropping it.
      const ancestorFailure = failedById.get(ancestorId)
      failed.push({
        sessionId: id,
        code: ancestorFailure?.code ?? 'session-unknown',
        message: `subagent of "${ancestorId}"; it was not deleted because its parent session was refused`,
        ...(ancestorFailure?.activity === undefined ? {} : { activity: ancestorFailure.activity }),
      })
    }
    return { trashed, failed }
  }

  /**
   * Resolve a bin id, accepting the entry id, the session id inside it, or the
   * id of any subagent in its tree.
   * @param {unknown} binId - caller-supplied identifier.
   * @returns {Promise<string>} the absolute entry directory.
   */
  async resolveEntry(binId) {
    if (!isSafeSegment(binId)) throw new BinError('bin-invalid', `"${String(binId)}" is not a plausible recycle-bin id`)
    const direct = join(binRoot(), String(binId))
    if (await exists(join(direct, MANIFEST))) return direct
    for (const row of await this.list()) {
      if (entryNodes(row).some(node => node.sessionId === String(binId))) return join(binRoot(), row.binId)
    }
    throw new BinError('bin-unknown', `no recycle-bin entry matches "${String(binId)}"`, { binId: String(binId) })
  }
}

/**
 * The single action table shared by the HTTP route and mirrored by the tool.
 *
 * The batch actions answer with *both* the per-entry arrays and their counts.
 * The arrays are the service's own return value; the counts are what a UI
 * wants to print ("已彻底删除 2 个条目") and are projected here rather than in
 * the Client, so every transport sees the same shape. Omitting them was the
 * 1.3.0 bug that printed "已彻底删除 undefined 个条目": the UI reads
 * `purgedCount`, and only the *tool* wrapper was computing it.
 *
 * Exported so the bundle's offline test can pin that shape (the route is a
 * thin wrapper around it).
 *
 * @param {SessionRecycleBin} bin - the service.
 * @param {any} body - request payload.
 * @returns {Promise<object>} the result payload.
 */
export async function dispatch(bin, body) {
  const action = typeof body?.action === 'string' ? body.action : ''
  switch (action) {
    case 'list':
      return { entries: await bin.list() }
    case 'preview': {
      const ids = Array.isArray(body?.sessionIds)
        ? body.sessionIds
        : body?.sessionId === undefined ? [] : [body.sessionId]
      if (ids.length === 0) throw new BinError('session-invalid', 'preview needs a "sessionId" or a non-empty "sessionIds" array')
      return await bin.preview(ids)
    }
    case 'trash':
      return await bin.trash(body.sessionId)
    case 'restore':
      return await bin.restore(body.binId)
    case 'purge':
      return await bin.purge(body.binId)
    case 'purgeAll':
      return await bin.purgeAll()
    case 'restoreMany': {
      const { restored, failed } = await bin.restoreMany(body.binIds)
      return { restored, failed, restoredCount: restored.length, failedCount: failed.length }
    }
    case 'purgeMany': {
      const { purged, failed } = await bin.purgeMany(body.binIds)
      return { purged, failed, purgedCount: purged.length, failedCount: failed.length }
    }
    case 'trashMany': {
      const { trashed, failed } = await bin.trashMany(body.sessionIds)
      const childCount = trashed.reduce((total, entry) => total + Number(entry.childCount ?? 0), 0)
      return { trashed, failed, trashedCount: trashed.length, childCount, failedCount: failed.length }
    }
    case 'archiveMany': {
      const { archived, failed } = await bin.archiveMany(body.sessionIds)
      return { archived, failed, archivedCount: archived.length, failedCount: failed.length }
    }
    default:
      throw new BinError('action-invalid', `unknown action "${action}"; expected list, preview, trash, restore, purge, purgeAll, restoreMany, purgeMany, trashMany or archiveMany`)
  }
}

/**
 * Host plugin entry: one service, one HTTP route, one model tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function apply(ctx) {
  const bin = new SessionRecycleBin(ctx)

  // A deleted session keeps a live Session object while its Agent lives; filter
  // it out of the corpus list (see `installHiddenSessionFilter`) so it cannot
  // reappear as the sidebar's synthetic "Ungrouped" group. A reload loses the
  // in-memory set but not the Agents, so rebuild it from the bin entries.
  ctx.inject(['sessionQuery'], queryCtx => {
    queryCtx.effect(() => installHiddenSessionFilter(queryCtx, bin.hidden), 'session-recycle-bin: hide trashed live sessions')
    void bin.repopulateHidden().catch(error => ctx.logger.warn(`session-recycle-bin: hidden-session rebuild failed: ${String(error)}`))
  })

  ctx.inject(['webServer', 'connection'], webCtx => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: async (request, response) => {
        // Same trust gate the shipped /api fence and the plugin market use:
        // an untrusted authority or a cross-site page is refused outright.
        const rejection = webCtx.connection.requestRejection(request)
        if (rejection !== undefined) {
          sendJson(response, rejection, { ok: false, code: 'forbidden', message: 'request refused by the Host trust gate' })
          return
        }
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        try {
          const body = await readJsonBody(request)
          sendJson(response, 200, { ok: true, ...await dispatch(bin, body) })
        }
        catch (error) {
          const code = typeof error?.code === 'string' ? error.code : 'internal'
          const status = statusFor(code)
          if (status === 500) ctx.logger.warn(`session-recycle-bin: request failed: ${String(error?.stack ?? error)}`)
          sendJson(response, status, { ok: false, code, message: error?.message ?? String(error), details: error?.details ?? {} })
        }
      },
    }), 'session-recycle-bin: route')
  })

  ctx.inject(['tools'], toolsCtx => {
    toolsCtx.effect(() => toolsCtx.tools.register(deleteSessionTool(bin)), 'session-recycle-bin: delete_session tool')
  })

  ctx.logger.info(`session-recycle-bin: recycle bin at ${binRoot()}`)
}

/**
 * The `delete_session` model tool. It calls the same service methods the UI
 * does, so both callers observe identical behaviour and identical refusals.
 *
 * Exported so the bundle's offline test can drive the tool's `execute` switch
 * directly (the `preview` branch and the child-count summaries are otherwise
 * only reachable from a live Agent).
 *
 * @param {SessionRecycleBin} bin - the service.
 * @returns {object} a registry-ready tool definition.
 */
export function deleteSessionTool(bin) {
  return {
    name: 'delete_session',
    description: 'Delete a DeepSeek Harness chat session. The session moves to a restorable recycle bin '
      + '(under $DSH_HOME/session-recycle-bin), its workspace accounting is cleared, and its sidebar row '
      + 'disappears; nothing is destroyed until it is purged. Subagent sessions follow their parent: deleting a '
      + 'session also moves every subagent conversation under it, as ONE bin entry that restores and purges as a '
      + 'unit; a subagent cannot be deleted on its own while its parent session still exists. A session that '
      + 'still has running work (a turn, background job, subagent, or scheduled reminder) is refused; an '
      + 'opened-but-idle session can be deleted. Actions: "preview" reports how many subagent sessions a '
      + 'delete would take with it; "trash" moves one session (and its subagents) into the bin — this is the '
      + 'delete the user sees; "trashMany" moves up to 200 sessions and reports which ones were refused; '
      + '"archiveMany" archives up to 200 sessions with DSH\'s own archive (kept on disk, hidden from the '
      + 'default list, restorable through the archived filter); "list" reads the bin; "restore" puts one '
      + 'entry (and its subagents) back (identify it by binId or sessionId); "restoreMany" puts several '
      + 'entries back; "purge" destroys one entry (and its subagents) permanently; "purgeMany" destroys '
      + 'several entries permanently; "purgeAll" empties the bin. Only delete or archive sessions the user '
      + 'asked you to, and prefer "list" before guessing a binId.',
    // Raw JSON Schema in the registry's enforced subset (not the authoring DSL):
    // `required` is a name array, and every nested object states its openness.
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['preview', 'trash', 'trashMany', 'archiveMany', 'list', 'restore', 'restoreMany', 'purge', 'purgeMany', 'purgeAll'],
          description: 'preview reports the subagent sessions a delete would take with it; trash moves a session '
            + 'and its subagents into the bin (the delete the UI performs); trashMany moves many; archiveMany '
            + 'archives many with the shipped archive; list reads the bin; restore puts one entry and its '
            + 'subagents back; restoreMany puts several back; purge destroys one entry and its subagents '
            + 'permanently; purgeMany destroys several; purgeAll empties the bin.',
        },
        sessionId: {
          type: 'string',
          description: 'Session id to preview or trash, for example "session-1a2b3c4d-…". Required for "preview" (single session) and "trash".',
        },
        sessionIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Session ids to act on, at most 200, distinct. Required for "preview" (several sessions), "trashMany" and "archiveMany".',
        },
        binId: {
          type: 'string',
          description: 'Recycle-bin entry id, the session id that entry holds, or any subagent id in its tree. Required for "restore" and "purge".',
        },
        binIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Recycle-bin entry ids (each may also be a session id in its tree), at most 200, distinct. Required for "restoreMany" and "purgeMany".',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'action', 'summary'],
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          summary: { type: 'string' },
          sessionId: { type: 'string' },
          binId: { type: 'string' },
          purged: { type: 'integer' },
          childCount: { type: 'integer' },
          trashedCount: { type: 'integer' },
          archivedCount: { type: 'integer' },
          restoredCount: { type: 'integer' },
          purgedCount: { type: 'integer' },
          failedCount: { type: 'integer' },
          children: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['sessionId'],
              properties: {
                sessionId: { type: 'string' },
                title: { type: 'string' },
              },
            },
          },
          failed: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              required: ['sessionId', 'code'],
              properties: {
                sessionId: { type: 'string' },
                code: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['binId', 'sessionId', 'deletedAt'],
              properties: {
                binId: { type: 'string' },
                sessionId: { type: 'string' },
                title: { type: 'string' },
                cwd: { type: 'string' },
                deletedAt: { type: 'string' },
                hadDirectory: { type: 'boolean' },
                childCount: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    /**
     * @param {{action: string, sessionId?: string, binId?: string}} args - validated arguments.
     * @returns {Promise<object>} the tool result.
     */
    async execute(args) {
      switch (args.action) {
        case 'preview': {
          const ids = Array.isArray(args.sessionIds) && args.sessionIds.length > 0
            ? args.sessionIds
            : typeof args.sessionId === 'string' && args.sessionId.length > 0 ? [args.sessionId] : []
          if (ids.length === 0) throw new Error('action "preview" requires a sessionId or a non-empty sessionIds array')
          const { sessions, childCount, missing } = await bin.preview(ids)
          const children = sessions.flatMap(session => session.children)
          const named = sessions.length === 1
            ? `Deleting ${sessions[0].sessionId}`
            : `Deleting these ${sessions.length} sessions`
          return {
            ok: true,
            action: 'preview',
            childCount,
            children,
            summary: childCount === 0
              ? `${named} would take no subagent sessions with it.`
              : `${named} would also move ${childCount} subagent session${childCount === 1 ? '' : 's'} into the recycle bin `
                + `(${children.map(child => `${child.sessionId}${typeof child.title === 'string' ? ` "${child.title}"` : ''}`).join(', ')}); they restore and purge together with their parent.`
              + (missing.length === 0 ? '' : ` No stored session matches: ${missing.join(', ')}.`),
          }
        }
        case 'trashMany': {
          if (!Array.isArray(args.sessionIds) || args.sessionIds.length === 0) {
            throw new Error('action "trashMany" requires a non-empty sessionIds array')
          }
          const { trashed, failed } = await bin.trashMany(args.sessionIds)
          const childCount = trashed.reduce((total, entry) => total + Number(entry.childCount ?? 0), 0)
          return {
            ok: true,
            action: 'trashMany',
            trashedCount: trashed.length,
            childCount,
            failedCount: failed.length,
            failed,
            summary: `Moved ${trashed.length} session${trashed.length === 1 ? '' : 's'} into the recycle bin`
              + (childCount === 0 ? '' : ` together with ${childCount} subagent session${childCount === 1 ? '' : 's'}`)
              + (failed.length === 0
                ? '. Every session in the batch is restorable until purged.'
                : `; ${failed.length} could not be deleted (${failed.map(entry => `${entry.sessionId}: ${entry.code}`).join(', ')}). Those sessions are untouched.`),
          }
        }
        case 'archiveMany': {
          if (!Array.isArray(args.sessionIds) || args.sessionIds.length === 0) {
            throw new Error('action "archiveMany" requires a non-empty sessionIds array')
          }
          const { archived, failed } = await bin.archiveMany(args.sessionIds)
          return {
            ok: true,
            action: 'archiveMany',
            archivedCount: archived.length,
            failedCount: failed.length,
            failed,
            summary: `Archived ${archived.length} session${archived.length === 1 ? '' : 's'} with DSH's own archive; they stay on disk and come back through the archived filter`
              + (failed.length === 0
                ? '.'
                : `; ${failed.length} still have running work and were left alone (${failed.map(entry => `${entry.sessionId}: ${entry.code}`).join(', ')}).`),
          }
        }
        case 'list': {
          const entries = await bin.list()
          const summary = entries.length === 0
            ? 'The session recycle bin is empty.'
            : `The session recycle bin holds ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}: `
              + entries.map(entry => `${entry.sessionId} (deleted ${entry.deletedAt}${typeof entry.title === 'string' ? `, title "${entry.title}"` : ''}${entry.childCount > 0 ? `, carrying ${entry.childCount} subagent session${entry.childCount === 1 ? '' : 's'}` : ''})`).join('; ')
          return {
            ok: true,
            action: 'list',
            summary,
            entries: entries.map(entry => ({
              binId: String(entry.binId),
              sessionId: String(entry.sessionId),
              ...(typeof entry.title === 'string' ? { title: entry.title } : {}),
              ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}),
              deletedAt: String(entry.deletedAt),
              hadDirectory: entry.hadDirectory === true,
              ...(Number(entry.childCount ?? 0) > 0 ? { childCount: Number(entry.childCount) } : {}),
            })),
          }
        }
        case 'trash': {
          if (typeof args.sessionId !== 'string' || args.sessionId.length === 0) {
            throw new Error('action "trash" requires a sessionId')
          }
          const result = await bin.trash(args.sessionId)
          const childCount = Number(result.childCount ?? 0)
          return {
            ok: true,
            action: 'trash',
            sessionId: String(result.sessionId),
            binId: String(result.binId),
            ...(childCount > 0 ? { childCount } : {}),
            summary: `Moved session ${result.sessionId} into the recycle bin as ${result.binId}`
              + (childCount === 0 ? '' : `, together with ${childCount} subagent session${childCount === 1 ? '' : 's'}`)
              + '. Its sidebar row is gone; nothing is destroyed until the entry is purged.',
          }
        }
        case 'restore': {
          if (typeof args.binId !== 'string' || args.binId.length === 0) {
            throw new Error('action "restore" requires a binId (the entry id or the session id)')
          }
          const result = await bin.restore(args.binId)
          const childCount = Number(result.childCount ?? 0)
          return {
            ok: true,
            action: 'restore',
            sessionId: String(result.sessionId),
            binId: String(result.binId),
            ...(childCount > 0 ? { childCount } : {}),
            summary: `Restored session ${result.sessionId} from the recycle bin`
              + (childCount === 0 ? '' : `, together with ${childCount} subagent session${childCount === 1 ? '' : 's'}`)
              + '. Refresh the page if the sidebar has not caught up.',
          }
        }
        case 'purge': {
          if (typeof args.binId !== 'string' || args.binId.length === 0) {
            throw new Error('action "purge" requires a binId (the entry id or the session id)')
          }
          const result = await bin.purge(args.binId)
          const childCount = Number(result.childCount ?? 0)
          return {
            ok: true,
            action: 'purge',
            ...(typeof result.sessionId === 'string' ? { sessionId: result.sessionId } : {}),
            binId: String(result.binId),
            ...(childCount > 0 ? { childCount } : {}),
            summary: `Permanently deleted recycle-bin entry ${result.binId}`
              + (childCount === 0 ? '' : ` and its ${childCount} subagent session${childCount === 1 ? '' : 's'}`)
              + '. This cannot be undone.',
          }
        }
        case 'purgeAll': {
          const { purged, childCount } = await bin.purgeAll()
          return {
            ok: true,
            action: 'purgeAll',
            purged,
            ...(Number(childCount ?? 0) > 0 ? { childCount: Number(childCount) } : {}),
            entries: [],
            summary: `Emptied the session recycle bin, permanently deleting ${purged} entr${purged === 1 ? 'y' : 'ies'}`
              + (Number(childCount ?? 0) === 0 ? '' : ` (including ${childCount} subagent session${childCount === 1 ? '' : 's'})`)
              + '.',
          }
        }
        case 'restoreMany': {
          if (!Array.isArray(args.binIds) || args.binIds.length === 0) {
            throw new Error('action "restoreMany" requires a non-empty binIds array')
          }
          const { restored, failed } = await bin.restoreMany(args.binIds)
          return {
            ok: true,
            action: 'restoreMany',
            restoredCount: restored.length,
            failedCount: failed.length,
            failed,
            summary: `Restored ${restored.length} entr${restored.length === 1 ? 'y' : 'ies'} from the recycle bin`
              + (failed.length === 0
                ? '. Refresh the page if the sidebar has not caught up.'
                : `; ${failed.length} could not be restored (${failed.map(entry => `${entry.binId}: ${entry.code}`).join(', ')}).`),
          }
        }
        case 'purgeMany': {
          if (!Array.isArray(args.binIds) || args.binIds.length === 0) {
            throw new Error('action "purgeMany" requires a non-empty binIds array')
          }
          const { purged, failed } = await bin.purgeMany(args.binIds)
          return {
            ok: true,
            action: 'purgeMany',
            purgedCount: purged.length,
            failedCount: failed.length,
            failed,
            summary: `Permanently deleted ${purged.length} recycle-bin entr${purged.length === 1 ? 'y' : 'ies'}. This cannot be undone`
              + (failed.length === 0
                ? '.'
                : `; ${failed.length} failed (${failed.map(entry => `${entry.binId}: ${entry.code}`).join(', ')}).`),
          }
        }
        default:
          throw new Error(`unknown action "${String(args.action)}"`)
      }
    },
  }
}
