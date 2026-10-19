// Reaching the OpenCode server this plugin runs inside.
//
// The plugin context exposes session.prompt/synthetic/create/get and the
// event bus in-process, but not session listing or message reads, so the
// plugin also talks to its own server over HTTP. The URL and password are
// found, in order, from:
//   1. A2A_LOCAL_URL / peers-file `self.url` (+ self.passwordEnv/passwordFile)
//   2. OpenCode's service registration (state dir service*.json whose pid is
//      this process) -- `opencode serve --service`
//   3. this process's argv (--hostname/--port), password from
//      OPENCODE_SERVER_PASSWORD / OPENCODE_PASSWORD
//   4. the TCP ports this process listens on (lsof), probed with /api/session
// When none works, sends to local sessions and reply delivery still go
// through the in-process context; listing and reading local sessions fail
// with a message that names A2A_LOCAL_URL.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { ServerClient, HttpError } from "./client.js"
import { resolvePassword } from "./config.js"

const envPassword = (env) => env.OPENCODE_SERVER_PASSWORD || env.OPENCODE_PASSWORD || undefined
const envUsername = (env) => env.OPENCODE_SERVER_USERNAME || env.OPENCODE_USERNAME || "opencode"

export function serviceRegistration({ env = process.env, pid = process.pid } = {}) {
  const dir = path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "opencode")
  let files = []
  try { files = fs.readdirSync(dir).filter((f) => /^service.*\.json$/.test(f)) } catch { return null }
  for (const f of files) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))
      if (doc?.pid === pid && typeof doc.url === "string") return { url: doc.url, password: typeof doc.password === "string" ? doc.password : undefined }
    } catch {}
  }
  return null
}

export function urlFromArgv(argv = process.argv) {
  let port, hostname
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--port") port = argv[i + 1]
    else if (a.startsWith("--port=")) port = a.slice(7)
    else if (a === "--hostname") hostname = argv[i + 1]
    else if (a.startsWith("--hostname=")) hostname = a.slice(11)
  }
  const p = Number(port)
  if (!Number.isInteger(p) || p <= 0) return null
  let host = !hostname || hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname
  if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`
  return `http://${host}:${p}`
}

function listeningPorts(pid = process.pid) {
  return new Promise((resolve) => {
    execFile("lsof", ["-a", "-nP", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], { timeout: 3000 }, (error, stdout) => {
      if (error && !stdout) return resolve([])
      const urls = []
      for (const line of String(stdout).split("\n")) {
        const m = /^n(.*):(\d+)$/.exec(line.trim())
        if (!m) continue
        let host = m[1] === "*" || m[1] === "0.0.0.0" ? "127.0.0.1" : m[1] === "[::]" ? "[::1]" : m[1]
        urls.push(`http://${host}:${m[2]}`)
      }
      resolve([...new Set(urls)])
    })
  })
}

async function probe(client) {
  try {
    await client.listSessions({ limit: 1 })
    return true
  } catch {
    return false
  }
}

/** Finds a working HTTP client for this server, or null. */
export async function resolveLocalClient(self, { env = process.env, log = () => {} } = {}) {
  const username = self.username || envUsername(env)
  const selfPassword = () => {
    try { return resolvePassword(self, env) } catch { return undefined }
  }
  const candidates = []
  if (self.url) candidates.push({ url: self.url, password: selfPassword() ?? envPassword(env), how: "configured URL" })
  const reg = serviceRegistration({ env })
  if (reg) candidates.push({ url: reg.url, password: reg.password ?? envPassword(env), how: "service registration" })
  const fromArgv = urlFromArgv()
  if (fromArgv) candidates.push({ url: fromArgv, password: selfPassword() ?? envPassword(env), how: "argv" })
  const tried = new Set()
  const tryOne = async (c) => {
    if (tried.has(c.url)) return null
    tried.add(c.url)
    const client = new ServerClient({ name: "local", url: c.url, username, getPassword: () => c.password })
    if (await probe(client)) {
      log(`local server reached via ${c.how} at ${c.url}`)
      return client
    }
    return null
  }
  for (const c of candidates) {
    const client = await tryOne(c)
    if (client) return client
  }
  for (const url of await listeningPorts()) {
    const client = await tryOne({ url, password: selfPassword() ?? reg?.password ?? envPassword(env), how: "listening port" })
    if (client) return client
  }
  return null
}

/**
 * The local server as a client: HTTP when reachable, the in-process plugin
 * context otherwise (for the calls the context supports).
 */
export class LocalServer {
  constructor({ ctx, self, env = process.env, log = () => {} }) {
    this.name = "local"
    this.ctx = ctx
    this.self = self
    this.env = env
    this.log = log
    this.http = null
    this.resolving = null
    this.lastFailure = 0
  }

  async httpClient({ required = false } = {}) {
    if (this.http) return this.http
    if (!this.resolving && Date.now() - this.lastFailure > 10_000) {
      this.resolving = resolveLocalClient(this.self, { env: this.env, log: this.log }).then((c) => {
        this.http = c
        if (!c) this.lastFailure = Date.now()
        this.resolving = null
        return c
      })
    }
    const client = this.resolving ? await this.resolving : this.http
    if (!client && required) {
      throw new HttpError("cannot reach this OpenCode server over HTTP to read sessions; set A2A_LOCAL_URL (and OPENCODE_SERVER_PASSWORD if the server uses one) or self.url in the peers file", 0)
    }
    return client
  }

  async call(method, ...args) {
    const c = await this.httpClient({ required: true })
    try {
      return await c[method](...args)
    } catch (error) {
      if (error?.status === 0 || error?.status === 401) this.http = null
      throw error
    }
  }

  listSessions(o) { return this.call("listSessions", o) }
  activeSessions() { return this.call("activeSessions") }
  messages(id, o) { return this.call("messages", id, o) }
  permissions(id) { return this.call("permissions", id) }
  forms(id) { return this.call("forms", id) }

  async getSession(id) {
    const c = await this.httpClient()
    if (c) return this.call("getSession", id)
    try {
      return await this.ctx.session.get({ sessionID: id })
    } catch (error) {
      throw ctxError(error, `get session ${id}`)
    }
  }

  async createSession(body) {
    const c = await this.httpClient()
    if (c) return this.call("createSession", body)
    try {
      return await this.ctx.session.create(body)
    } catch (error) {
      throw ctxError(error, "create session")
    }
  }

  async prompt(id, body) {
    const c = await this.httpClient()
    if (c) return this.call("prompt", id, body)
    try {
      return await this.ctx.session.prompt({ sessionID: id, ...body })
    } catch (error) {
      throw ctxError(error, `prompt ${id}`)
    }
  }

  async synthetic(id, body) {
    const c = await this.httpClient()
    if (c) return this.call("synthetic", id, body)
    try {
      return await this.ctx.session.synthetic({ sessionID: id, ...body })
    } catch (error) {
      throw ctxError(error, `synthetic ${id}`)
    }
  }

  async *events(signal) {
    // In-process bus first: no auth, no socket.
    if (this.ctx?.event?.subscribe) {
      yield { type: "server.connected", data: {} }
      for await (const event of this.ctx.event.subscribe({ signal })) yield event
      return
    }
    const c = await this.httpClient({ required: true })
    yield* c.events(signal)
  }
}

/** Maps an in-process context error onto HttpError statuses the runtime understands. */
export function ctxError(error, what) {
  const tag = String(error?._tag || error?.name || "")
  const msg = String(error?.message || error || "")
  const status = /Conflict/i.test(tag + msg) ? 409 : /NotFound|not found/i.test(tag + msg) ? 404 : 500
  return new HttpError(`local ${what} failed: ${msg.slice(0, 200) || tag}`, status)
}
