import { test } from "node:test"
import assert from "node:assert/strict"
import { checkSend, RateLimiter } from "../src/guards.js"
import { buildEnvelope } from "../src/envelope.js"

test("self send is refused, even under different server names", () => {
  const env = buildEnvelope({ from: "a/ses_A", to: "local/ses_A" })
  assert.match(checkSend({ from: "a/ses_A", to: "local/ses_A", env }), /itself/)
})

test("hop limit", () => {
  let env = buildEnvelope({ from: "a/ses_1", to: "b/ses_2" })
  for (let i = 2; i <= 4; i++) env = buildEnvelope({ from: `x/ses_${i}`, to: `x/ses_${i + 1}`, inbound: env })
  assert.equal(env.hop, 4)
  assert.equal(checkSend({ from: "x/ses_4", to: "x/ses_5", env }), null)
  const five = buildEnvelope({ from: "x/ses_5", to: "x/ses_6", inbound: env })
  assert.match(checkSend({ from: "x/ses_5", to: "x/ses_6", env: five }), /hop limit/)
})

test("cycle back to the trace origin is refused", () => {
  const first = buildEnvelope({ from: "a/ses_A", to: "b/ses_B" })
  const back = buildEnvelope({ from: "b/ses_B", to: "mini/ses_A", inbound: first })
  assert.match(checkSend({ from: "b/ses_B", to: "mini/ses_A", env: back }), /started by/)
  const onward = buildEnvelope({ from: "b/ses_B", to: "c/ses_C", inbound: first })
  assert.equal(checkSend({ from: "b/ses_B", to: "c/ses_C", env: onward }), null)
})

test("rate limiter per pair with a sliding window", () => {
  let t = 0
  const rl = new RateLimiter({ limit: 3, windowMs: 1000, now: () => t })
  for (let i = 0; i < 3; i++) assert.equal(rl.take("a", "b"), null)
  assert.match(rl.take("a", "b"), /rate limit/)
  assert.equal(rl.take("a", "c"), null, "other pair unaffected")
  t = 1001
  assert.equal(rl.take("a", "b"), null)
})
