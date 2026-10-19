import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PendingStore } from "../src/pending.js"
import { ReplyRuntime } from "../src/runtime.js"
import { HttpError } from "../src/client.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "a2a-rt-"))

function fakeTarget() {
  return {
    running: false, records: [], permList: [], formList: [],
    async activeSessions() { return this.running ? { ses_B: { type: "running" } } : {} },
    async messages() { return this.records },
    async permissions() { return this.permList },
    async forms() { return this.formList },
  }
}
function fakeLocal() {
  return {
    sent: [], seen: new Set(),
    async synthetic(id, body) {
      if (this.seen.has(body.id)) throw new HttpError("conflict", 409)
      this.seen.add(body.id)
      this.sent.push({ session: id, ...body })
    },
  }
}
const entry = (extra = {}) => ({ id: "e1", parentSession: "ses_A", server: "mini", target: "ses_B", afterIdleId: "i1", sentMessageId: "m", traceId: "a2a_t", hop: 1, path: ["me/ses_A"], createdAt: Date.now(), deadline: Date.now() + 60_000, ...extra })

function setup() {
  const store = new PendingStore(tmp()).load()
  const target = fakeTarget()
  const local = fakeLocal()
  const rt = new ReplyRuntime({ store, serverFor: (n) => (n === "mini" ? target : undefined), local, selfName: "me", pollMs: 1e9 })
  return { store, target, local, rt }
}

test("delivers the reply once with steer+resume and reply metadata", async () => {
  const { store, target, local, rt } = setup()
  await store.add(entry())
  target.records = [{ id: "i2", type: "idle", outcome: "succeeded" }, { id: "a", type: "assistant", content: [{ type: "text", text: "51" }] }, { id: "m", type: "user" }, { id: "i1", type: "idle", outcome: "succeeded" }]
  await rt.tick("e1")
  assert.equal(local.sent.length, 1)
  const d = local.sent[0]
  assert.equal(d.session, "ses_A")
  assert.equal(d.delivery, "steer")
  assert.equal(d.resume, true)
  assert.equal(d.metadata.a2a.kind, "reply")
  assert.match(d.text, /<a2a-reply from="mini\/ses_B" trace="a2a_t" state="completed" inReplyTo="m">\n51\n/)
  assert.equal(store.list().length, 0)
  rt.stop()
})

test("a retry after a lost response reuses the id; 409 counts as delivered", async () => {
  const { store, target, local, rt } = setup()
  const e = await store.add(entry())
  target.records = [{ id: "i2", type: "idle", outcome: "succeeded" }, { id: "a", type: "assistant", content: [{ type: "text", text: "ok" }] }]
  await rt.deliver(e, "completed", "ok")
  const firstId = e.replyMsgId
  await rt.deliver(e, "completed", "ok") // simulated retry
  assert.equal(e.replyMsgId, firstId)
  assert.equal(local.sent.length, 1)
  rt.stop()
})

test("running target: waits, and sends one blocked notice", async () => {
  const { store, target, local, rt } = setup()
  await store.add(entry())
  target.running = true
  target.formList = [{ id: "frm_1", title: "Questions" }]
  await rt.tick("e1")
  await rt.tick("e1")
  assert.equal(local.sent.length, 1)
  assert.match(local.sent[0].text, /state="blocked"/)
  assert.equal(store.list().length, 1, "still waiting for the real reply")
  rt.stop()
})

test("deadline produces a timeout notice and drops the entry", async () => {
  const { store, local, rt } = setup()
  await store.add(entry({ deadline: Date.now() - 1 }))
  await rt.tick("e1")
  assert.match(local.sent[0].text, /state="timeout"/)
  assert.equal(store.list().length, 0)
  rt.stop()
})

test("deleted target reports an error", async () => {
  const { store, target, local, rt } = setup()
  await store.add(entry())
  target.messages = async () => { throw new HttpError("gone", 404) }
  await rt.tick("e1")
  assert.match(local.sent[0].text, /state="error"[\s\S]*no longer exists/)
  rt.stop()
})

test("execution events arm a check for watched sessions", async () => {
  const { store, rt } = setup()
  await store.add(entry())
  rt.onEvent("mini", { type: "session.execution.succeeded", data: { sessionID: "ses_B" } })
  assert.ok(rt.timers.has("e1"))
  rt.onEvent("mini", { type: "session.execution.started", data: { sessionID: "ses_B" } })
  assert.ok(!rt.timers.has("e1"))
  rt.stop()
})
