// Minimal HTTP client for an OpenCode v2 server (/api/*, HTTP basic auth).
// Error messages carry the server name, route and status, never credentials.

const TIMEOUT_MS = 15_000

export class HttpError extends Error {
  constructor(message, status) {
    super(message)
    this.name = "HttpError"
    this.status = status
  }
}

export class ServerClient {
  /**
   * @param {{name: string, url: string, username?: string, getPassword?: () => string|undefined, fetchImpl?: typeof fetch}} opts
   */
  constructor({ name, url, username, getPassword, fetchImpl }) {
    this.name = name
    this.url = url.replace(/\/+$/, "")
    this.username = username || "opencode"
    this.getPassword = getPassword ?? (() => undefined)
    this.fetch = fetchImpl ?? ((...a) => fetch(...a))
  }

  headers(extra = {}) {
    const h = { accept: "application/json", ...extra }
    const pw = this.getPassword()
    if (pw) h.authorization = `Basic ${Buffer.from(`${this.username}:${pw}`).toString("base64")}`
    return h
  }

  async request(method, route, { query, body, timeoutMs = TIMEOUT_MS, signal } = {}) {
    const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [k, String(v)])).toString() : ""
    const target = `${this.url}${route}${qs ? `?${qs}` : ""}`
    const init = { method, headers: this.headers(body !== undefined ? { "content-type": "application/json" } : {}) }
    if (body !== undefined) init.body = JSON.stringify(body)
    init.signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
    let res
    try {
      res = await this.fetch(target, init)
    } catch (error) {
      const why = error?.name === "TimeoutError" ? "timed out" : (error?.cause?.code || error?.code || error?.name || "network error")
      throw new HttpError(`server "${this.name}" unreachable at ${this.url} (${why})`, 0)
    }
    if (res.status === 204) return undefined
    const text = await res.text().catch(() => "")
    if (!res.ok) {
      let detail = ""
      try {
        const j = JSON.parse(text)
        detail = j?.message || j?.error?.message || j?.data?.message || j?._tag || ""
      } catch {
        detail = text
      }
      detail = String(detail).replace(/\s+/g, " ").slice(0, 200)
      const auth = res.status === 401 ? " (check the peer's password)" : ""
      throw new HttpError(`server "${this.name}": ${method} ${route} returned HTTP ${res.status}${auth}${detail ? `: ${detail}` : ""}`, res.status)
    }
    if (!text) return undefined
    let json
    try { json = JSON.parse(text) } catch { throw new HttpError(`server "${this.name}": ${method} ${route} returned non-JSON`, res.status) }
    return json && typeof json === "object" && "data" in json ? json.data : json
  }

  listSessions({ limit = 20, search, order = "desc", directory } = {}) {
    return this.request("GET", "/api/session", { query: { limit, search, order, directory } })
  }
  activeSessions() {
    return this.request("GET", "/api/session/active")
  }
  getSession(id) {
    return this.request("GET", `/api/session/${encodeURIComponent(id)}`)
  }
  createSession(body) {
    return this.request("POST", "/api/session", { body })
  }
  messages(id, { limit = 50, order = "desc", type } = {}) {
    return this.request("GET", `/api/session/${encodeURIComponent(id)}/message`, { query: { limit, order, type } })
  }
  prompt(id, body) {
    return this.request("POST", `/api/session/${encodeURIComponent(id)}/prompt`, { body })
  }
  synthetic(id, body) {
    return this.request("POST", `/api/session/${encodeURIComponent(id)}/synthetic`, { body })
  }
  permissions(id) {
    return this.request("GET", `/api/session/${encodeURIComponent(id)}/permission`)
  }
  forms(id) {
    return this.request("GET", `/api/session/${encodeURIComponent(id)}/form`)
  }

  /**
   * Server-sent events from /api/event as parsed objects. Ends when the stream
   * closes; throws on connect failure. The caller owns reconnects.
   */
  async *events(signal) {
    let res
    try {
      res = await this.fetch(`${this.url}/api/event`, { headers: this.headers({ accept: "text/event-stream" }), signal })
    } catch (error) {
      if (signal?.aborted) return
      throw new HttpError(`server "${this.name}" event stream unreachable (${error?.cause?.code || error?.name || "network error"})`, 0)
    }
    if (!res.ok || !res.body) throw new HttpError(`server "${this.name}": event stream returned HTTP ${res.status}`, res.status)
    yield* parseSse(res.body, signal)
  }
}

/** Parses an SSE byte stream into JSON objects (one per event's data). */
export async function* parseSse(body, signal) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let cut
      while ((cut = buf.search(/\r?\n\r?\n/)) !== -1) {
        const block = buf.slice(0, cut)
        buf = buf.slice(cut).replace(/^\r?\n\r?\n/, "")
        const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n")
        if (!data) continue
        try { yield JSON.parse(data) } catch {}
      }
    }
  } finally {
    try { await reader.cancel() } catch {}
  }
}
