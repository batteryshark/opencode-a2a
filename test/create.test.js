import { test } from "node:test"
import assert from "node:assert/strict"
import { _tools } from "../src/plugin.js"
import { RateLimiter } from "../src/guards.js"
import { buildEnvelope } from "../src/envelope.js"

// Fictional sessions and peers; all server methods below are in-memory doubles.
const CALLER = "ses_caller0001"
const ctx = { sessionID: CALLER }

function fakeServer(name) {
  let n = 0
  return {
    name,
    created: [],
    prompts: [],
    async createSession(body) {
      this.created.push(body)
      const directory = body.parentID ? "/work/caller" : body.location?.directory
      return { id: `ses_${name}new${++n}`, title: body.title, parentID: body.parentID, location: { directory } }
    },
    async getSession(id) {
      if (id === CALLER) return { id, title: "caller", location: { directory: "/work/caller" } }
      return { id, title: "other", location: { directory: "/work/caller" } }
    },
    async messages() { return [] },
    async prompt(id, body) { this.prompts.push({ id, ...body }) },
  }
}

function setup({ inbound = [] } = {}) {
  const local = fakeServer("local")
  local.messages = async () => inbound
  const mini = fakeServer("mini")
  const state = {
    peers: () => ({
      self: { name: "laptop", allowCreate: true },
      peers: new Map([
        ["mini", { name: "mini", url: "http://127.0.0.1:4096", allowCreate: true, defaultDirectory: "/workspace/review", replyTimeoutSec: 60 }],
        ["box", { name: "box", url: "http://127.0.0.1:4097", allowCreate: false }],
      ]),
    }),
    serverFor: (n) => (n === "local" ? local : n === "mini" ? mini : n === "box" ? fakeServer("box") : undefined),
    local,
    store: { added: [], async add(e) { this.added.push(e); return e }, async remove() {} },
    runtime: { registered: [], async register(e) { this.registered.push(e) } },
    limiter: new RateLimiter({ limit: 10, windowMs: 60_000 }),
  }
  const byName = Object.fromEntries(_tools(state).map((t) => [t.name, t]))
  return { state, local, mini, tools: byName }
}

test("a2a_create locally nests under the caller by default", async () => {
  const { local, tools } = setup()
  const r = await tools.a2a_create.execute({ server: "local", title: "Review worker", model: "example/model" }, ctx)
  assert.equal(r.metadata.a2a.ok, true, r.content)
  const body = local.created[0]
  assert.equal(body.parentID, CALLER)
  assert.equal(body.location, undefined, "a child takes its parent's location")
  assert.equal(body.title, "Review worker", "title is used as given")
  assert.deepEqual(body.model, { providerID: "example", id: "model" })
  assert.deepEqual(body.metadata.a2a, { createdBy: `laptop/${CALLER}`, parent: `laptop/${CALLER}`, nested: true })
  assert.equal(r.metadata.a2a.nested, true)
  assert.equal(r.metadata.a2a.parentID, CALLER)
  assert.deepEqual(JSON.parse(JSON.stringify(r.metadata)), r.metadata)
  assert.match(r.content, /nested under this session/)
})

test("a2a_create nest:false creates a root session in the caller's directory", async () => {
  const { local, tools } = setup()
  for (const nest of [false, "false"]) {
    const r = await tools.a2a_create.execute({ server: "local", title: "solo", nest }, ctx)
    assert.equal(r.metadata.a2a.ok, true, r.content)
    assert.equal("parentID" in r.metadata.a2a, false)
    assert.deepEqual(JSON.parse(JSON.stringify(r.metadata)), r.metadata)
  }
  for (const body of local.created) {
    assert.equal(body.parentID, undefined)
    assert.deepEqual(body.location, { directory: "/work/caller" })
    assert.equal(body.metadata.a2a.nested, false)
  }
})

test("a2a_create to a peer never sends parentID; the parent is recorded in metadata", async () => {
  const { mini, tools } = setup()
  const r = await tools.a2a_create.execute({ server: "mini", title: "remote", nest: true }, ctx)
  assert.equal(r.metadata.a2a.ok, true, r.content)
  const body = mini.created[0]
  assert.equal("parentID" in body, false)
  assert.deepEqual(body.location, { directory: "/workspace/review" })
  assert.equal(body.metadata.a2a.parent, `laptop/${CALLER}`)
  assert.equal(body.metadata.a2a.nested, false)
  assert.equal(r.metadata.a2a.nested, false)
  assert.equal("parentID" in r.metadata.a2a, false)
  assert.deepEqual(JSON.parse(JSON.stringify(r.metadata)), r.metadata)
})

test("a different local directory turns nesting off; the same one keeps it", async () => {
  const { local, tools } = setup()
  const r = await tools.a2a_create.execute({ server: "local", title: "elsewhere", directory: "/other" }, ctx)
  assert.equal(r.metadata.a2a.ok, true)
  assert.equal(local.created[0].parentID, undefined)
  assert.deepEqual(local.created[0].location, { directory: "/other" })
  assert.match(r.content, /Not nested/)
  assert.equal("parentID" in r.metadata.a2a, false)
  assert.deepEqual(JSON.parse(JSON.stringify(r.metadata)), r.metadata)
  await tools.a2a_create.execute({ server: "local", directory: "/work/caller/" }, ctx)
  assert.equal(local.created[1].parentID, CALLER)
})

test("a2a_create without caller context returns JSON-safe root metadata", async () => {
  const { local, tools } = setup()
  const r = await tools.a2a_create.execute({ server: "local", directory: "/work/standalone" }, {})
  assert.equal(r.metadata.a2a.ok, true, r.content)
  assert.equal(r.metadata.a2a.nested, false)
  assert.equal("parentID" in r.metadata.a2a, false)
  assert.deepEqual(JSON.parse(JSON.stringify(r.metadata)), r.metadata)
  assert.equal(local.created[0].parentID, undefined)
})

test("title is optional and never prefixed", async () => {
  const { local, tools } = setup()
  await tools.a2a_create.execute({ server: "local" }, ctx)
  assert.equal("title" in local.created[0], false)
  await tools.a2a_create.execute({ server: "local", title: "  plain title " }, ctx)
  assert.equal(local.created[1].title, "plain title")
})

test("allowCreate is still enforced", async () => {
  const { tools } = setup()
  const r = await tools.a2a_create.execute({ server: "box", title: "x" }, ctx)
  assert.equal(r.metadata.a2a.ok, false)
  assert.match(r.content, /not allowed/)
})

test("local creation requires self.allowCreate too", async () => {
  const { state, local, tools } = setup()
  const peers = state.peers()
  peers.self.allowCreate = false
  state.peers = () => peers
  const r = await tools.a2a_create.execute({ server: "local" }, ctx)
  assert.equal(r.metadata.a2a.ok, false)
  assert.equal(local.created.length, 0)
})

test("send requires caller context before creating or prompting", async () => {
  const { local, tools } = setup()
  const r = await tools.a2a_send.execute({ text: "Review this", create: { title: "worker" } }, {})
  assert.equal(r.metadata.a2a.ok, false)
  assert.match(r.content, /no calling session id/)
  assert.equal(local.created.length, 0)
  assert.equal(local.prompts.length, 0)
})

test("send identity comes from context and queue/expectReply:false are passed through", async () => {
  const { local, state, tools } = setup()
  const r = await tools.a2a_send.execute({ to: "ses_target0001", text: "Review this", from: "forged/ses_fake0001", delivery: "queue", expectReply: false }, ctx)
  assert.equal(r.metadata.a2a.ok, true, r.content)
  assert.equal(local.prompts[0].metadata.a2a.from, `laptop/${CALLER}`)
  assert.equal(local.prompts[0].delivery, "queue")
  assert.equal(r.metadata.a2a.replyPending, false)
  assert.equal(state.store.added.length, 0)
})

test("a2a_send with create makes a nested session and sends to it", async () => {
  const { local, state, tools } = setup()
  const r = await tools.a2a_send.execute({ text: "what is 2+2?", create: { title: "adder", model: "deepseek/deepseek-flash" } }, ctx)
  assert.equal(r.metadata.a2a.ok, true, r.content)
  assert.equal(local.created[0].parentID, CALLER)
  assert.equal(local.prompts.length, 1)
  const child = r.metadata.a2a.to.split("/")[1]
  assert.equal(local.prompts[0].id.startsWith("msg_"), true)
  assert.equal(local.prompts[0].metadata.a2a.to, `laptop/${child}`)
  assert.equal(state.store.added[0].parentSession, CALLER)
  assert.equal(state.store.added[0].target, child)
  assert.equal(state.runtime.registered.length, 1)
  assert.equal(r.metadata.a2a.created, true)
  assert.equal(r.metadata.a2a.nested, true)
})

test("a2a_send with create on a peer omits parentID", async () => {
  const { mini, tools } = setup()
  const r = await tools.a2a_send.execute({ to: "mini", text: "hi", expectReply: false, create: { title: "r" } }, ctx)
  assert.equal(r.metadata.a2a.ok, true, r.content)
  assert.equal("parentID" in mini.created[0], false)
  assert.equal(mini.prompts.length, 1)
})

test("a2a_send with create refuses on the hop limit before creating anything", async () => {
  let env = buildEnvelope({ from: "x/ses_1", to: "x/ses_2" })
  for (let i = 2; i <= 4; i++) env = buildEnvelope({ from: `x/ses_${i}`, to: `x/ses_${i + 1}`, inbound: env })
  const { local, tools } = setup({ inbound: [{ type: "user", text: "q", metadata: { a2a: env } }] })
  const r = await tools.a2a_send.execute({ text: "go", create: { title: "deep" } }, ctx)
  assert.equal(r.metadata.a2a.ok, false)
  assert.match(r.content, /hop limit/)
  assert.equal(local.created.length, 0)
})

test("a nested child sending back to its parent is still refused as a cycle", async () => {
  const PARENT = "ses_parent0001"
  const fromParent = buildEnvelope({ from: `laptop/${PARENT}`, to: `laptop/${CALLER}`, expectReply: true })
  const { local, tools } = setup({ inbound: [{ type: "user", text: "q", metadata: { a2a: fromParent } }] })
  const r = await tools.a2a_send.execute({ to: PARENT, text: "hi" }, ctx)
  assert.equal(r.metadata.a2a.ok, false)
  assert.match(r.content, /started by/)
  assert.equal(local.prompts.length, 0)
})
