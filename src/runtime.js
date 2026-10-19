// Reply routing: watches target sessions and pushes each answer back into the
// session that sent the message, as a synthetic steer+resume message.
//
// Event-driven with polling as a safety net:
//   - one event stream per target server that has pending entries; a
//     session.execution.{succeeded,failed,interrupted} for a watched target,
//     or a (re)connect, arms a short timer for its entries
//   - a periodic sweep re-checks every entry (deadlines, missed events,
//     blocked targets) and resumes entries restored from disk at startup
// A tick only believes OpenCode's own records: not running per
// /api/session/active, and an idle record newer than the send.

import { buildReplyText } from "./envelope.js"
import { readReplyOutcome, outcomeBody } from "./extract.js"
import { mintMessageId } from "./ids.js"

const QUIET_MS = 500
const SETTLE_MS = 2_000
const SETTLE_CHECKS = 3
const RETRY_BASE_MS = 2_000
const RETRY_MAX_MS = 60_000
const RECONNECT_MAX_MS = 30_000
const END_EVENTS = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])

export class ReplyRuntime {
  /**
   * @param {object} o
   * @param {import("./pending.js").PendingStore} o.store
   * @param {(server: string) => any} o.serverFor   client for "local" or a peer name; undefined if unknown
   * @param {any} o.local                            client used to deliver into parent sessions
   * @param {string} o.selfName
   * @param {(msg: string) => void} [o.log]
   * @param {() => number} [o.now]
   * @param {number} [o.pollMs]
   */
  constructor({ store, serverFor, local, selfName, log = () => {}, now = Date.now, pollMs = 15_000 }) {
    this.store = store
    this.serverFor = serverFor
    this.local = local
    this.selfName = selfName
    this.log = log
    this.now = now
    this.pollMs = pollMs
    this.timers = new Map() // entry id -> timeout
    this.ticking = new Set()
    this.failures = new Map() // entry id -> {count, nextAt}
    this.settle = new Map() // entry id -> checks spent
    this.watchers = new Map() // server -> AbortController
    this.stopped = false
    this.sweepTimer = null
  }

  start() {
    this.store.load()
    const restored = this.store.list()
    if (restored.length) this.log(`resuming ${restored.length} pending repl${restored.length === 1 ? "y" : "ies"}`)
    for (const e of restored) {
      this.ensureWatcher(e.server)
      this.arm(e.id, QUIET_MS)
    }
    this.sweepTimer = setInterval(() => this.sweep(), this.pollMs)
    this.sweepTimer.unref?.()
    return this
  }

  stop() {
    this.stopped = true
    clearInterval(this.sweepTimer)
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    for (const c of this.watchers.values()) c.abort()
    this.watchers.clear()
  }

  async register(entry) {
    await this.store.add(entry)
    this.ensureWatcher(entry.server)
    // A short turn can end before the entry existed.
    this.arm(entry.id, QUIET_MS)
    return entry
  }

  pendingFor(server, sessionId) {
    return this.store.list().filter((e) => e.server === server && (sessionId === undefined || e.target === sessionId))
  }

  sweep() {
    if (this.stopped) return
    const t = this.now()
    for (const e of this.store.list()) {
      const f = this.failures.get(e.id)
      if (f && f.nextAt > t && e.deadline > t) continue
      if (!this.timers.has(e.id)) this.arm(e.id, 0)
      this.ensureWatcher(e.server)
    }
  }

  arm(id, delay = QUIET_MS) {
    if (this.stopped || !this.store.get(id)) return
    clearTimeout(this.timers.get(id))
    const timer = setTimeout(() => {
      this.timers.delete(id)
      this.tick(id).catch((error) => this.log(`tick failed: ${error?.message ?? error}`))
    }, Math.max(0, delay))
    timer.unref?.()
    this.timers.set(id, timer)
  }

  retryLater(id, error) {
    const f = this.failures.get(id) ?? { count: 0, nextAt: 0 }
    f.count += 1
    const delay = Math.min(RETRY_BASE_MS * 2 ** (f.count - 1), RETRY_MAX_MS)
    f.nextAt = this.now() + delay
    this.failures.set(id, f)
    if (f.count === 1 || f.count % 5 === 0) this.log(`reply check failed (attempt ${f.count}): ${error?.message ?? error}`)
    this.arm(id, delay)
  }

  // --- event streams --------------------------------------------------------

  ensureWatcher(server) {
    if (this.stopped || this.watchers.has(server)) return
    const client = this.serverFor(server)
    if (!client?.events) return
    const controller = new AbortController()
    this.watchers.set(server, controller)
    ;(async () => {
      let backoff = 1000
      while (!controller.signal.aborted && this.pendingFor(server).length > 0) {
        try {
          for await (const event of client.events(controller.signal)) {
            backoff = 1000
            this.onEvent(server, event)
            if (this.pendingFor(server).length === 0) break
          }
        } catch (error) {
          if (controller.signal.aborted) break
          this.log(`event stream for "${server}" dropped: ${error?.message ?? error}`)
        }
        if (controller.signal.aborted || this.pendingFor(server).length === 0) break
        await new Promise((r) => { const t = setTimeout(r, backoff); t.unref?.() })
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
        // A reconnect may have missed the end of a turn: re-check everything.
        for (const e of this.pendingFor(server)) this.arm(e.id, 0)
      }
    })().finally(() => {
      if (this.watchers.get(server) === controller) this.watchers.delete(server)
      controller.abort()
    })
  }

  onEvent(server, event) {
    const type = event?.type
    if (type === "server.connected") {
      for (const e of this.pendingFor(server)) this.arm(e.id, QUIET_MS)
      return
    }
    const sessionID = event?.data?.sessionID
    if (!sessionID) return
    if (END_EVENTS.has(type)) {
      for (const e of this.pendingFor(server, sessionID)) {
        this.settle.delete(e.id)
        this.arm(e.id, QUIET_MS)
      }
    } else if (type === "session.execution.started") {
      for (const e of this.pendingFor(server, sessionID)) {
        clearTimeout(this.timers.get(e.id))
        this.timers.delete(e.id)
      }
    }
  }

  // --- checking and delivering ---------------------------------------------

  async tick(id) {
    if (this.stopped) return
    const entry = this.store.get(id)
    if (!entry) return
    if (this.ticking.has(id)) return this.arm(id, QUIET_MS)
    this.ticking.add(id)
    try {
      await this.check(entry)
      this.failures.delete(id)
    } catch (error) {
      this.retryLater(id, error)
    } finally {
      this.ticking.delete(id)
    }
  }

  async check(entry) {
    const from = `${entry.server}/${entry.target}`
    if (this.now() > entry.deadline) {
      const secs = Math.round((entry.deadline - entry.createdAt) / 1000)
      const span = secs >= 120 ? `${Math.round(secs / 60)} min` : `${secs} s`
      await this.deliver(entry, "timeout", `No reply from ${from} within ${span}. It may still be working or waiting on its user.`)
      return this.finish(entry)
    }
    const client = this.serverFor(entry.server)
    if (!client) {
      await this.deliver(entry, "error", `Server "${entry.server}" is no longer configured; the reply cannot be collected.`)
      return this.finish(entry)
    }
    let records
    let running = false
    try {
      const active = await client.activeSessions()
      running = !!(active && typeof active === "object" && active[entry.target])
      records = await client.messages(entry.target, { limit: 50, order: "desc" })
    } catch (error) {
      if (error?.status === 404) {
        await this.deliver(entry, "error", `The target session ${from} no longer exists.`)
        return this.finish(entry)
      }
      throw error
    }
    const outcome = running ? null : readReplyOutcome(records, { afterIdleId: entry.afterIdleId, sentMessageId: entry.sentMessageId })
    if (outcome) {
      await this.deliver(entry, outcome.state, outcomeBody(outcome))
      return this.finish(entry)
    }
    if (!entry.blockedMsgId) await this.checkBlocked(entry, client)
    if (!running) {
      // Idle without our turn's idle record yet: either the record trails the
      // event briefly, or the prompt has not started. A few short rechecks
      // cover the first; events and the sweep cover the second.
      const spent = this.settle.get(entry.id) ?? 0
      if (spent < SETTLE_CHECKS) {
        this.settle.set(entry.id, spent + 1)
        this.arm(entry.id, SETTLE_MS)
      }
    }
  }

  async checkBlocked(entry, client) {
    let reason = ""
    try {
      const perms = await client.permissions(entry.target)
      if (Array.isArray(perms) && perms.length) reason = `a permission request (${perms.map((p) => p.action).filter(Boolean).slice(0, 3).join(", ") || "pending"})`
    } catch {}
    if (!reason) {
      try {
        const forms = await client.forms(entry.target)
        if (Array.isArray(forms) && forms.length) reason = `a question for its user ("${String(forms[0].title ?? "").slice(0, 80)}")`
      } catch {}
    }
    if (!reason) return
    await this.deliver(entry, "blocked", `The target session ${entry.server}/${entry.target} is waiting on ${reason}. Its reply will still be delivered here if it finishes before the deadline.`, "blockedMsgId")
  }

  async finish(entry) {
    clearTimeout(this.timers.get(entry.id))
    this.timers.delete(entry.id)
    this.failures.delete(entry.id)
    this.settle.delete(entry.id)
    await this.store.remove(entry.id)
  }

  /**
   * Admits a reply or notice into the parent session. The message id is minted
   * once (deterministically from the entry), persisted before the first
   * attempt, and reused on retries; OpenCode answers a re-admission with 409,
   * which counts as delivered.
   */
  async deliver(entry, state, body, idField = "replyMsgId") {
    if (!entry[idField]) {
      await this.store.update(entry.id, { [idField]: mintMessageId(this.now(), `${entry.id}:${idField}`) })
    }
    const id = entry[idField]
    const from = `${entry.server}/${entry.target}`
    const text = buildReplyText({ from, traceId: entry.traceId, state, body, sentMessageId: entry.sentMessageId })
    const metadata = {
      a2a: {
        v: 1,
        from,
        to: `${this.selfName}/${entry.parentSession}`,
        traceId: entry.traceId,
        hop: entry.hop ?? 1,
        path: [...(entry.path ?? []), from],
        kind: "reply",
        replyTo: entry.sentMessageId,
        state,
      },
    }
    try {
      await this.local.synthetic(entry.parentSession, {
        id,
        text,
        description: state === "completed" ? `a2a reply from ${from}` : `a2a ${state}: ${from}`,
        metadata,
        delivery: "steer",
        resume: true,
      })
      this.log(`delivered ${state} from ${from} to ${entry.parentSession}`)
    } catch (error) {
      if (error?.status === 409) return // an earlier attempt landed
      if (error?.status === 404) {
        this.log(`dropping reply from ${from}: parent session ${entry.parentSession} no longer exists`)
        return
      }
      throw error
    }
  }
}
