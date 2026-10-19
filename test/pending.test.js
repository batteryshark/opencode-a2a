import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PendingStore } from "../src/pending.js"
import { mintMessageId, MESSAGE_ID } from "../src/ids.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "a2a-pending-"))
const entry = (id, extra = {}) => ({ id, parentSession: "ses_A", server: "mini", target: "ses_B", afterIdleId: null, sentMessageId: "msg_1", traceId: "a2a_t", hop: 1, path: [], createdAt: Date.now(), deadline: Date.now() + 1000, ...extra })

test("add, persist atomically, reload", async () => {
  const dir = tmp()
  const s = new PendingStore(dir).load()
  await s.add(entry("e1"))
  await s.add(entry("e2"))
  await s.update("e1", { replyMsgId: "msg_x" })
  await s.remove("e2")
  await s.flush()
  const file = path.join(dir, "pending.json")
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), [])
  const again = new PendingStore(dir).load()
  assert.deepEqual(again.list().map((e) => [e.id, e.replyMsgId]), [["e1", "msg_x"]])
})

test("corrupt file is moved aside, malformed entries dropped", async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, "pending.json"), "{nope")
  const logs = []
  const s = new PendingStore(dir, { log: (m) => logs.push(m) }).load()
  assert.equal(s.list().length, 0)
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("pending.json.corrupt-")))
  fs.writeFileSync(path.join(dir, "pending.json"), JSON.stringify({ entries: [entry("ok"), { id: "bad" }] }))
  const t = new PendingStore(dir, { log: (m) => logs.push(m) }).load()
  assert.deepEqual(t.list().map((e) => e.id), ["ok"])
})

test("concurrent writes serialize", async () => {
  const dir = tmp()
  const s = new PendingStore(dir).load()
  await Promise.all(Array.from({ length: 20 }, (_, i) => s.add(entry(`e${i}`, { createdAt: i }))))
  assert.equal(new PendingStore(dir).load().list().length, 20)
})

test("message ids: valid format, deterministic with a seed", () => {
  const a = mintMessageId(1791786298385, "entry:reply")
  const b = mintMessageId(1791786298385, "entry:reply")
  assert.equal(a, b)
  assert.match(a, MESSAGE_ID)
  assert.equal(a.length, 4 + 12 + 14)
  assert.notEqual(mintMessageId(1791786298385, "other"), a)
  assert.match(mintMessageId(), MESSAGE_ID)
})
