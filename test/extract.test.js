import { test } from "node:test"
import assert from "node:assert/strict"
import { readReplyOutcome, newestIdleId, outcomeBody, formatTranscript } from "../src/extract.js"

const idle = (id, outcome = "succeeded") => ({ id, type: "idle", outcome, time: { created: 1 } })
const asst = (id, text, extra = {}) => ({ id, type: "assistant", content: text === null ? [] : [{ type: "text", text }], time: { created: 1 }, ...extra })
const user = (id, text) => ({ id, type: "user", text, time: { created: 1 } })

// newest first
const before = [idle("i1"), asst("a1", "old answer"), user("u1", "old question")]

test("newestIdleId", () => {
  assert.equal(newestIdleId(before), "i1")
  assert.equal(newestIdleId([user("u", "x")]), null)
})

test("no new idle record means not done", () => {
  assert.equal(readReplyOutcome([asst("a2", "partial"), user("m", "q"), ...before], { afterIdleId: "i1", sentMessageId: "m" }), null)
})

test("answer is the newest assistant text of our turn", () => {
  const recs = [idle("i2"), asst("a3", null), asst("a2", "51"), user("m", "17*3?"), ...before]
  assert.deepEqual(readReplyOutcome(recs, { afterIdleId: "i1", sentMessageId: "m" }), { state: "completed", text: "51", errorMessage: "", idleId: "i2" })
})

test("first session run (no baseline)", () => {
  const recs = [idle("i1"), asst("a1", "PONG"), user("m", "ping")]
  assert.equal(readReplyOutcome(recs, { afterIdleId: null, sentMessageId: "m" }).text, "PONG")
})

test("our message in a later turn is matched to that turn, not an earlier one", () => {
  const recs = [idle("i3"), asst("a5", "mine"), user("m", "ours"), idle("i2"), asst("a4", "someone else's"), user("u2", "other"), ...before]
  assert.equal(readReplyOutcome(recs, { afterIdleId: "i1", sentMessageId: "m" }).text, "mine")
  // our message has not finished yet although another turn did
  const pendingRecs = [user("m", "ours"), idle("i2"), asst("a4", "other answer"), user("u2", "other"), ...before]
  assert.equal(readReplyOutcome(pendingRecs, { afterIdleId: "i1", sentMessageId: "m" }), null)
})

test("failed and interrupted outcomes", () => {
  const failed = [idle("i2", "failed"), asst("a2", "", { error: { message: "rate limited" } }), user("m", "q"), ...before]
  const o = readReplyOutcome(failed, { afterIdleId: "i1", sentMessageId: "m" })
  assert.equal(o.state, "error")
  assert.match(outcomeBody(o), /rate limited/)
  const stopped = readReplyOutcome([idle("i2", "interrupted"), user("m", "q"), ...before], { afterIdleId: "i1" })
  assert.equal(stopped.state, "cancelled")
  assert.match(outcomeBody(stopped), /stopped/)
  assert.match(outcomeBody({ state: "completed", text: "", errorMessage: "" }), /without a text reply/)
})

test("transcript formatting", () => {
  const t = formatTranscript([idle("i2"), asst("a2", "51"), { ...user("m", "q?"), metadata: { a2a: { from: "a/ses_A", kind: "request" } } }], 5)
  assert.equal(t, "[user via a2a from a/ses_A] q?\n\n[assistant] 51")
})
