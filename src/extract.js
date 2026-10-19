// Reading a target session's records (newest first, as
// GET /api/session/:id/message?order=desc returns them).
//
// OpenCode appends an `{type:"idle", outcome}` record whenever a run ends. A
// turn's answer is the newest assistant text between its closing idle record
// and the idle record before it.

const OUTCOME_STATES = { succeeded: "completed", failed: "error", interrupted: "cancelled" }

const isIdle = (r) => r && r.type === "idle" && typeof r.id === "string"

export const assistantText = (record) =>
  (Array.isArray(record?.content) ? record.content : [])
    .map((item) => (item && item.type === "text" && typeof item.text === "string" ? item.text : ""))
    .join("")
    .trim()

/** Id of the newest idle record, or null when the session has never finished a run. */
export function newestIdleId(recordsNewestFirst) {
  const idle = (recordsNewestFirst ?? []).find(isIdle)
  return idle ? idle.id : null
}

/**
 * How the turn that handled our message ended, or null while it has not.
 *
 * @param {any[]} records newest first
 * @param {{afterIdleId: string|null, sentMessageId?: string}} opts
 *   afterIdleId: the newest idle record before we sent (null: none existed).
 *   sentMessageId: the id our prompt was admitted with; when it is on the
 *   page, the answer is taken from the turn that contains it.
 * @returns {null | {state: "completed"|"error"|"cancelled", text: string, errorMessage: string, idleId: string}}
 */
export function readReplyOutcome(records, { afterIdleId, sentMessageId } = { afterIdleId: null }) {
  const list = Array.isArray(records) ? records : []
  let baseline = list.length
  if (afterIdleId) {
    const at = list.findIndex((r) => r && r.id === afterIdleId)
    if (at !== -1) baseline = at
  }
  const idleIdx = []
  for (let i = 0; i < baseline; i++) if (isIdle(list[i]) && list[i].id !== afterIdleId) idleIdx.push(i)
  if (idleIdx.length === 0) return null

  let closing
  const mine = sentMessageId ? list.findIndex((r, i) => i < baseline && r && r.id === sentMessageId) : -1
  if (mine !== -1) {
    // The oldest idle record newer than our message closes our turn.
    const newer = idleIdx.filter((i) => i < mine)
    if (newer.length === 0) return null
    closing = Math.max(...newer)
  } else {
    // Our message is not on the page (or its id is unknown): the first run
    // that ended after we sent is the one that handled it.
    closing = Math.max(...idleIdx)
  }
  const olderBoundary = idleIdx.find((i) => i > closing) ?? baseline
  const turn = list.slice(closing + 1, olderBoundary).filter((r) => r && r.type === "assistant")
  const withText = turn.find((r) => assistantText(r))
  const reply = withText ?? turn[0]
  const idle = list[closing]
  return {
    state: OUTCOME_STATES[idle.outcome] ?? "completed",
    text: reply ? assistantText(reply) : "",
    errorMessage: typeof reply?.error?.message === "string" ? reply.error.message.trim() : "",
    idleId: idle.id,
  }
}

/** Body text for a reply notice, never silent. */
export function outcomeBody({ state, text, errorMessage }) {
  if (state === "completed") return text || "(The target session finished without a text reply.)"
  if (state === "error") {
    const failure = errorMessage ? `The target session failed: ${errorMessage}` : "The target session failed."
    return text ? `${failure}\n\nIts last reply:\n${text}` : failure
  }
  const stopped = "The target session was stopped before it finished."
  return text ? `${stopped}\n\nIts last reply:\n${text}` : stopped
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** Compact transcript of the newest `limit` conversational records, oldest first. */
export function formatTranscript(recordsNewestFirst, limit = 5, maxChars = 4000) {
  const picked = []
  for (const r of recordsNewestFirst ?? []) {
    if (!r || typeof r !== "object") continue
    let line = null
    if (r.type === "user") line = `[user${r.metadata?.a2a ? ` via a2a from ${r.metadata.a2a.from}` : ""}] ${clip(String(r.text ?? ""), maxChars)}`
    else if (r.type === "synthetic") line = `[synthetic${r.metadata?.a2a ? ` a2a ${r.metadata.a2a.kind}` : ""}] ${clip(String(r.text ?? ""), maxChars)}`
    else if (r.type === "assistant") {
      const t = assistantText(r)
      if (t) line = `[assistant] ${clip(t, maxChars)}`
      else if (r.error?.message) line = `[assistant error] ${clip(String(r.error.message), 500)}`
    }
    if (line) picked.push(line)
    if (picked.length >= limit) break
  }
  return picked.reverse().join("\n\n")
}
