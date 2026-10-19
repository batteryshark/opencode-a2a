// Peers file and local paths. Passwords are resolved lazily and never leave
// this module except inside an Authorization header built by the client.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { LOCAL } from "./address.js"

export const DEFAULT_REPLY_TIMEOUT_SEC = 30 * 60
const PEER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export const expandHome = (p) => (typeof p === "string" && (p === "~" || p.startsWith("~/")) ? path.join(os.homedir(), p.slice(1)) : p)

export const configDir = (env = process.env) => env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".config", "opencode")

export const peersFilePath = (env = process.env) => expandHome(env.A2A_PEERS_FILE) || path.join(configDir(env), "a2a-peers.json")

export const stateDir = (env = process.env) => expandHome(env.A2A_STATE_DIR) || path.join(configDir(env), "a2a")

/**
 * @typedef {object} Peer
 * @property {string} name
 * @property {string} [url]
 * @property {string} [username]
 * @property {string} [passwordEnv]
 * @property {string} [passwordFile]
 * @property {boolean} [allowCreate]
 * @property {number} [replyTimeoutSec]
 * @property {string} [defaultDirectory]
 */

/**
 * Validates and normalizes a parsed peers document.
 * @returns {{self: Peer, peers: Map<string, Peer>, warnings: string[]}}
 */
export function normalizePeers(doc, env = process.env) {
  const warnings = []
  const peers = new Map()
  const list = Array.isArray(doc?.peers) ? doc.peers : []
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue
    const name = String(entry.name ?? "")
    if (!PEER_NAME.test(name) || name === LOCAL) {
      warnings.push(`peer name "${name}" is invalid or reserved; skipped`)
      continue
    }
    let url
    try {
      const parsed = new URL(String(entry.url))
      if (!/^https?:$/.test(parsed.protocol)) throw new Error("protocol")
      if (parsed.username || parsed.password) {
        warnings.push(`peer "${name}": credentials in the URL are not allowed (use passwordEnv or passwordFile); skipped`)
        continue
      }
      url = parsed.origin + parsed.pathname.replace(/\/+$/, "")
    } catch {
      warnings.push(`peer "${name}" has no valid http(s) url; skipped`)
      continue
    }
    peers.set(name, pickPeerFields({ ...entry, name, url }))
  }
  const selfDoc = doc?.self && typeof doc.self === "object" ? doc.self : {}
  const self = pickPeerFields({ ...selfDoc, name: String(env.A2A_SELF_NAME || selfDoc.name || os.hostname().split(".")[0] || LOCAL) })
  if (selfDoc.url) {
    try { self.url = new URL(String(selfDoc.url)).origin } catch { warnings.push("self.url is invalid; ignored") }
  }
  if (env.A2A_LOCAL_URL) {
    try { self.url = new URL(env.A2A_LOCAL_URL).origin } catch { warnings.push("A2A_LOCAL_URL is invalid; ignored") }
  }
  return { self, peers, warnings }
}

function pickPeerFields(e) {
  const out = { name: e.name }
  if (e.url) out.url = e.url
  if (typeof e.username === "string" && e.username) out.username = e.username
  if (typeof e.passwordEnv === "string" && e.passwordEnv) out.passwordEnv = e.passwordEnv
  if (typeof e.passwordFile === "string" && e.passwordFile) out.passwordFile = e.passwordFile
  out.allowCreate = e.allowCreate === true
  const t = Number(e.replyTimeoutSec)
  out.replyTimeoutSec = Number.isFinite(t) && t > 0 ? t : DEFAULT_REPLY_TIMEOUT_SEC
  if (typeof e.defaultDirectory === "string" && e.defaultDirectory) out.defaultDirectory = expandHome(e.defaultDirectory)
  return out
}

/** Reads the peers file; a missing file is "no peers". Never throws. */
export function loadPeers(env = process.env) {
  const file = peersFilePath(env)
  let doc = {}
  const warnings = []
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    if (error?.code !== "ENOENT") warnings.push(`could not read peers file ${file}: ${error?.code || "invalid JSON"}`)
  }
  const result = normalizePeers(doc, env)
  return { ...result, file, warnings: [...warnings, ...result.warnings] }
}

/**
 * Resolves a peer's password from its env var or file. Returns undefined when
 * none is configured. Errors name the source, never the value.
 */
export function resolvePassword(peer, env = process.env) {
  if (peer.passwordEnv) {
    const value = env[peer.passwordEnv]
    if (value) return value
    if (!peer.passwordFile) throw new Error(`password env var ${peer.passwordEnv} for "${peer.name}" is not set`)
  }
  if (peer.passwordFile) {
    try {
      const value = fs.readFileSync(expandHome(peer.passwordFile), "utf8").trim()
      if (value) return value
    } catch (error) {
      throw new Error(`password file for "${peer.name}" is unreadable (${error?.code || "error"})`)
    }
    throw new Error(`password file for "${peer.name}" is empty`)
  }
  return undefined
}
