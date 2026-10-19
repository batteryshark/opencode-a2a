import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { normalizePeers, resolvePassword } from "../src/config.js"

// All peer addresses and credential strings in these tests are synthetic.
test("peers are validated; local is reserved; URL credentials rejected", () => {
  const { peers, warnings, self } = normalizePeers({
    self: { name: "laptop", allowCreate: true },
    peers: [
      { name: "mini", url: "http://127.0.0.1:4096/", passwordEnv: "X", replyTimeoutSec: 60 },
      { name: "local", url: "http://x" },
      { name: "leak", url: "http://opencode:secret@host:1" },
      { name: "bad", url: "ftp://x" },
    ],
  }, {})
  assert.deepEqual([...peers.keys()], ["mini"])
  assert.equal(peers.get("mini").url, "http://127.0.0.1:4096")
  assert.equal(peers.get("mini").replyTimeoutSec, 60)
  assert.equal(peers.get("mini").allowCreate, false)
  assert.equal(self.name, "laptop")
  assert.equal(self.allowCreate, true)
  assert.equal(warnings.length, 3)
  assert.ok(!warnings.join(" ").includes("secret"), "warnings never echo a password")
})

test("passwords from env or file, errors never contain the value", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-pw-"))
  const file = path.join(dir, "mini.pw")
  fs.writeFileSync(file, "hunter2\n")
  assert.equal(resolvePassword({ name: "m", passwordEnv: "PW" }, { PW: "s3cret" }), "s3cret")
  assert.equal(resolvePassword({ name: "m", passwordFile: file }, {}), "hunter2")
  assert.equal(resolvePassword({ name: "m", passwordEnv: "MISSING", passwordFile: file }, {}), "hunter2")
  assert.throws(() => resolvePassword({ name: "m", passwordEnv: "MISSING" }, {}), /MISSING .* not set/)
  assert.throws(() => resolvePassword({ name: "m", passwordFile: path.join(dir, "nope") }, {}), /unreadable \(ENOENT\)/)
  assert.equal(resolvePassword({ name: "m" }, {}), undefined)
})
