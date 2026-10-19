// Loop and echo prevention for outgoing sends.

import { MAX_HOP } from "./envelope.js"

export const sessionPart = (address) => String(address).slice(String(address).lastIndexOf("/") + 1)

/**
 * Returns a refusal reason, or null when the send may go ahead.
 * @param {{from: string, to: string, env: import("./envelope.js").Envelope, maxHop?: number}} p
 */
export function checkSend({ from, to, env, maxHop = MAX_HOP }) {
  // Servers may know each other by different names, so sessions are compared
  // by id (the part after the last "/"), which is unique across servers.
  if (sessionPart(from) === sessionPart(to)) return "refused: a session cannot send to itself"
  if (env.hop > maxHop) {
    return `refused: hop limit reached (this message would be hop ${env.hop}, max ${maxHop}). Trace ${env.traceId} has bounced between agents too many times; answer with what you have instead of sending again`
  }
  if (env.path.length > 0 && sessionPart(env.path[0]) === sessionPart(to)) {
    return `refused: trace ${env.traceId} was started by ${to}. Your final answer is already returned to it automatically; just answer instead of sending`
  }
  return null
}

/** Sliding-window rate limit per (from, to) pair. */
export class RateLimiter {
  constructor({ limit = 10, windowMs = 60_000, now = Date.now } = {}) {
    this.limit = limit
    this.windowMs = windowMs
    this.now = now
    /** @type {Map<string, number[]>} */
    this.hits = new Map()
  }

  /** Records a hit and returns null, or returns a refusal reason without recording. */
  take(from, to) {
    const key = `${from}\u0000${to}`
    const t = this.now()
    const recent = (this.hits.get(key) ?? []).filter((at) => t - at < this.windowMs)
    if (recent.length >= this.limit) {
      this.hits.set(key, recent)
      const waitSec = Math.ceil((this.windowMs - (t - recent[0])) / 1000)
      return `refused: rate limit of ${this.limit} messages per ${Math.round(this.windowMs / 1000)}s from ${from} to ${to}; try again in ${waitSec}s`
    }
    recent.push(t)
    this.hits.set(key, recent)
    if (this.hits.size > 1000) {
      for (const [k, v] of this.hits) if (!v.some((at) => t - at < this.windowMs)) this.hits.delete(k)
    }
    return null
  }
}
