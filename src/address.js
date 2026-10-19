// Addressing: "server/sessionId", "server/title:<search>", or bare forms that
// mean this server ("local").
//
//   ses_abc            -> { server: "local", sessionId: "ses_abc" }
//   title:Planner      -> { server: "local", title: "Planner" }
//   Planner            -> { server: "local", title: "Planner" }
//   mini/ses_abc       -> { server: "mini",  sessionId: "ses_abc" }
//   mini/title:Planner -> { server: "mini",  title: "Planner" }
//   mini/Planner       -> { server: "mini",  title: "Planner" }
//
// The part before the first "/" is a server only when it names "local" or a
// configured peer, so a title that happens to contain "/" still works as a
// bare local title.

export const LOCAL = "local"

const SESSION_ID = /^ses_[A-Za-z0-9_-]{4,128}$/

export const isSessionId = (value) => typeof value === "string" && SESSION_ID.test(value)

/**
 * @param {string} input
 * @param {Iterable<string>} peerNames configured peer names (without "local")
 * @returns {{server: string, sessionId?: string, title?: string}}
 */
export function parseAddress(input, peerNames = []) {
  if (typeof input !== "string" || !input.trim()) throw new Error("address is empty; use server/sessionId or server/title:<search>")
  const raw = input.trim()
  const names = new Set(peerNames)
  let server = LOCAL
  let rest = raw
  const slash = raw.indexOf("/")
  if (slash > 0 && !raw.startsWith("title:")) {
    const head = raw.slice(0, slash)
    if (head === LOCAL || names.has(head)) {
      server = head
      rest = raw.slice(slash + 1)
    } else if (isSessionId(raw.slice(slash + 1)) && !names.has(head)) {
      throw new Error(`unknown server "${head}"; configured: ${[LOCAL, ...names].join(", ")}`)
    }
  }
  rest = rest.trim()
  if (!rest) throw new Error(`address "${raw}" has no session; use ${server}/ses_... or ${server}/title:<search>`)
  if (rest.startsWith("title:")) {
    const title = rest.slice("title:".length).trim()
    if (!title) throw new Error(`address "${raw}" has an empty title search`)
    return { server, title }
  }
  if (isSessionId(rest)) return { server, sessionId: rest }
  return { server, title: rest }
}

export const formatAddress = (server, sessionId) => `${server}/${sessionId}`
