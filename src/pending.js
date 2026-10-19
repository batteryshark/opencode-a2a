// Pending replies, persisted so a restart still delivers.
//
// File: <stateDir>/pending.json, written atomically (tmp + rename, mode 600)
// through a serialized write chain. A malformed file is moved aside instead of
// being overwritten; one malformed entry is dropped alone.

import fs from "node:fs"
import path from "node:path"

const FILE_VERSION = 1
export const MAX_ENTRIES = 200

/**
 * @typedef {object} PendingEntry
 * @property {string} id              unique entry id
 * @property {string} parentSession   caller session (always on this server)
 * @property {string} server          target server name ("local" or a peer)
 * @property {string} target          target session id
 * @property {string|null} afterIdleId newest idle record of the target before the send
 * @property {string} sentMessageId   id the prompt was admitted with
 * @property {string} traceId
 * @property {number} hop
 * @property {string[]} path
 * @property {number} createdAt
 * @property {number} deadline        ms timestamp
 * @property {string} [replyMsgId]    deterministic id of the delivery into the parent; minted once, persisted before the first attempt
 * @property {string} [blockedMsgId]  id of the one "blocked" notice, once sent
 */

const isStr = (v) => typeof v === "string" && v.length > 0

export function validEntry(e) {
  return !!e && typeof e === "object"
    && isStr(e.id) && isStr(e.parentSession) && isStr(e.server) && isStr(e.target)
    && (e.afterIdleId === null || isStr(e.afterIdleId))
    && isStr(e.sentMessageId) && isStr(e.traceId)
    && Number.isFinite(e.createdAt) && Number.isFinite(e.deadline)
}

export class PendingStore {
  constructor(dir, { now = Date.now, log = () => {} } = {}) {
    this.dir = dir
    this.file = path.join(dir, "pending.json")
    this.now = now
    this.log = log
    /** @type {Map<string, PendingEntry>} */
    this.entries = new Map()
    this.loaded = false
    this.writeChain = Promise.resolve()
  }

  load() {
    if (this.loaded) return this
    let raw
    try {
      raw = fs.readFileSync(this.file, "utf8")
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
      this.loaded = true
      return this
    }
    let doc
    try {
      doc = JSON.parse(raw)
    } catch {
      const backup = `${this.file}.corrupt-${this.now()}`
      try { fs.renameSync(this.file, backup) } catch {}
      this.log(`pending file was unreadable; moved to ${backup}`)
      doc = { entries: [] }
    }
    for (const e of Array.isArray(doc?.entries) ? doc.entries : []) {
      if (validEntry(e)) this.entries.set(e.id, e)
      else this.log("dropped one malformed pending entry")
    }
    this.loaded = true
    return this
  }

  list() {
    return [...this.entries.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  get(id) {
    return this.entries.get(id)
  }

  /** Adds an entry and resolves once it is on disk. */
  async add(entry) {
    if (!validEntry(entry)) throw new TypeError("invalid pending entry")
    this.entries.set(entry.id, entry)
    if (this.entries.size > MAX_ENTRIES) {
      for (const stale of this.list().filter((e) => e.id !== entry.id).slice(0, this.entries.size - MAX_ENTRIES)) {
        this.entries.delete(stale.id)
        this.log(`too many pending replies; dropped the oldest (trace ${stale.traceId})`)
      }
    }
    await this.persist()
    return entry
  }

  async update(id, patch) {
    const e = this.entries.get(id)
    if (!e) return undefined
    Object.assign(e, patch)
    await this.persist()
    return e
  }

  async remove(id) {
    if (!this.entries.delete(id)) return false
    await this.persist()
    return true
  }

  persist() {
    const payload = JSON.stringify({ version: FILE_VERSION, entries: this.list() }, null, 1)
    const run = async () => {
      await fs.promises.mkdir(this.dir, { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
      await fs.promises.writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 })
      await fs.promises.rename(tmp, this.file)
    }
    // Each write waits for the previous one; a failure does not poison the chain.
    const next = this.writeChain.then(run, run)
    this.writeChain = next.catch((error) => this.log(`failed to persist pending replies: ${error?.message ?? error}`))
    return next
  }

  flush() {
    return this.writeChain
  }
}
