import { test } from "node:test"
import assert from "node:assert/strict"
import { parseAddress } from "../src/address.js"

const peers = ["mini", "box"]

test("bare session id and title mean local", () => {
  assert.deepEqual(parseAddress("ses_abcd1234"), { server: "local", sessionId: "ses_abcd1234" })
  assert.deepEqual(parseAddress("Planner"), { server: "local", title: "Planner" })
  assert.deepEqual(parseAddress("title:Planner"), { server: "local", title: "Planner" })
})

test("server prefixes", () => {
  assert.deepEqual(parseAddress("mini/ses_abcd1234", peers), { server: "mini", sessionId: "ses_abcd1234" })
  assert.deepEqual(parseAddress("mini/title:Big Plan", peers), { server: "mini", title: "Big Plan" })
  assert.deepEqual(parseAddress("mini/Big Plan", peers), { server: "mini", title: "Big Plan" })
  assert.deepEqual(parseAddress("local/ses_abcd1234", peers), { server: "local", sessionId: "ses_abcd1234" })
})

test("a title containing a slash stays a local title", () => {
  assert.deepEqual(parseAddress("fix a/b test", peers), { server: "local", title: "fix a/b test" })
  assert.deepEqual(parseAddress("title:mini/thing", peers), { server: "local", title: "mini/thing" })
})

test("unknown server with a session id is an error", () => {
  assert.throws(() => parseAddress("nope/ses_abcd1234", peers), /unknown server "nope"/)
})

test("empty inputs are errors", () => {
  assert.throws(() => parseAddress(""), /empty/)
  assert.throws(() => parseAddress("mini/", peers), /no session/)
  assert.throws(() => parseAddress("mini/title:", peers), /empty title/)
})
