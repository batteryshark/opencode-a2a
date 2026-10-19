// Message ids in OpenCode's ascending format: "msg_" + 12 hex (time) + 14
// base62. OpenCode refuses a second admission of the same id (HTTP 409), so a
// retry that reuses a persisted id can never deliver twice.

import crypto from "node:crypto"

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/**
 * @param {number} now   ms timestamp for the ordering prefix
 * @param {string} [seed] when given, the suffix is derived from it (deterministic)
 */
export function mintMessageId(now = Date.now(), seed) {
  const bytes = seed ? crypto.createHash("sha256").update(seed).digest() : crypto.randomBytes(14)
  const time = (BigInt(Math.floor(now)) * 0x1000n + BigInt(bytes[0] * 16 + (bytes[1] & 0x0f))).toString(16).padStart(12, "0").slice(-12)
  let suffix = ""
  for (let i = 0; i < 14; i++) suffix += B62[bytes[(i + 2) % bytes.length] % 62]
  return `msg_${time}${suffix}`
}

export const MESSAGE_ID = /^msg_[A-Za-z0-9]{8,64}$/
