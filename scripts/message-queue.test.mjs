import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const {
  MessageQueue, InboxRequests, EMPTY_QUEUE, INBOX_TOOL, INBOX_SERVER, INBOX_INSTRUCTIONS,
  inboxTool, inboxContent, codexInboxContent, inboxConfigForShell, messageQueueId,
} = await load("messageQueue");
const { claudeInboxReply, claudeInboxInitialize, CLAUDE_INBOX_TOOL, codexInboxReceiptId } = await load("inboxProtocol");
const { initialChatState, baseReducer } = await load("chatState");
const { chatReducer, claudeChatFlags, controlLine } = await load("claudeChat");
const { codexReducer, resultLine } = await load("codexChat");
const { integrationInstructions } = await load("integrations");

const message = (id, extra = {}) => ({ id, text: `instrucción ${id}`, images: [], previews: [], createdAt: 100, ...extra });
const batch = (id, messages) => ({ messages: [], receipt: { id, messages } });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test("room and team inboxes use stable native queue IDs without renaming valid tab queues", () => {
  assert.equal(messageQueueId("room-123-planner"), "t-room-123-planner");
  assert.equal(messageQueueId("team-123-builder"), "t-team-123-builder");
  assert.equal(messageQueueId("t-session"), "t-session");
  assert.notEqual(messageQueueId("room-123-planner"), messageQueueId("room-123-executor"));
});

test("Codex confirms only successful receipts from its own MCP inbox", () => {
  const item = { type: "mcpToolCall", status: "completed", server: INBOX_SERVER, tool: INBOX_TOOL,
    result: { structuredContent: { receiptId: "r-delivered-1" } } };
  assert.equal(codexInboxReceiptId(item), "r-delivered-1");
  for (const altered of [null, {}, { ...item, status: "inProgress" }, { ...item, status: "failed" },
    { ...item, server: "another_server" }, { ...item, tool: "another_tool" }, { ...item, error: { message: "failed" } },
    { ...item, result: { ...item.result, isError: true } }, { ...item, result: { structuredContent: { receiptId: null } } },
    { ...item, result: { structuredContent: { receiptId: "../another-tab" } } }]) {
    assert.equal(codexInboxReceiptId(altered), null);
  }
});

test("WSL bridge launches through interop while keeping native storage arguments intact", () => {
  const args = ["--trex-inbox-mcp", "C:\\Users\\Mi PC\\AppData\\Local\\trex", "t-queue"];
  for (const command of ["C:\\Users\\Mi PC\\trex.exe", "C:/Users/Mi PC/trex.exe", "\\\\?\\C:\\Users\\Mi PC\\trex.exe"]) {
    const config = { "mcp_servers.trex_inbox.command": command, "mcp_servers.trex_inbox.args": args };
    const converted = inboxConfigForShell(config, "wsl");
    assert.equal(converted["mcp_servers.trex_inbox.command"], "/mnt/c/Users/Mi PC/trex.exe");
    assert.strictEqual(converted["mcp_servers.trex_inbox.args"], args);
    assert.strictEqual(inboxConfigForShell(config, "pwsh"), config);
  }
  const linux = { "mcp_servers.trex_inbox.command": "/opt/trex/bin/trex" };
  assert.strictEqual(inboxConfigForShell(linux, "bash"), linux);
});

// Models the native boundary, including an outstanding receipt until its exact
// ID is acknowledged. All assertions below exercise the real JS queue/protocol.
function memoryQueue(before = async () => {}) {
  let stored = { messages: [], receipt: null }, receiptNumber = 0, active = 0, maxActive = 0;
  const calls = [], changes = [], failures = new Map();
  const operation = (name, mutate) => async (...args) => {
    const label = ["enqueue", "remove", "ack"].includes(name) ? `${name}:${args[0]?.id ?? args[0]}` : name;
    calls.push(label);
    maxActive = Math.max(maxActive, ++active);
    try {
      await before(label);
      if (failures.has(name)) {
        const error = failures.get(name);
        failures.delete(name);
        throw error;
      }
      mutate(...args);
      return structuredClone(stored);
    } finally { active--; }
  };
  const transport = {
    list: operation("list", () => {}),
    enqueue: operation("enqueue", item => {
      if (![...stored.messages, ...(stored.receipt?.messages ?? [])].some(old => old.id === item.id)) {
        stored.messages.push(structuredClone(item));
      }
    }),
    remove: operation("remove", id => { stored.messages = stored.messages.filter(item => item.id !== id); }),
    read: operation("read", () => {
      if (!stored.receipt && stored.messages.length) {
        stored.receipt = { id: `receipt-${++receiptNumber}`, messages: stored.messages };
        stored.messages = [];
      }
    }),
    ack: operation("ack", id => { if (stored.receipt?.id === id) stored.receipt = null; }),
  };
  return {
    queue: new MessageQueue(transport, value => changes.push(structuredClone(value))),
    calls, changes, failures, get maxActive() { return maxActive; },
    get stored() { return structuredClone(stored); },
  };
}

test("concurrent enqueue/remove/read operations reach the transport serially in FIFO order", async () => {
  const entered = deferred(), release = deferred();
  const store = memoryQueue(async label => {
    if (label === "enqueue:first") { entered.resolve(); await release.promise; }
  });
  const { queue } = store;
  assert.deepEqual(queue.snapshot, EMPTY_QUEUE);
  const pending = [
    queue.enqueue(message("first")), queue.enqueue(message("second", { createdAt: 1 })),
    queue.remove("first"), queue.enqueue(message("third", { createdAt: 0 })), queue.read(),
  ];
  await entered.promise;
  try {
    assert.deepEqual(store.calls, ["enqueue:first"]);
    assert.deepEqual(queue.snapshot, EMPTY_QUEUE, "unsettled native writes must not publish snapshots");
  } finally { release.resolve(); }
  const snapshots = await Promise.all(pending);
  assert.equal(store.maxActive, 1);
  assert.deepEqual(store.calls, ["enqueue:first", "enqueue:second", "remove:first", "enqueue:third", "read"]);
  assert.deepEqual(snapshots[4].receipt.messages.map(item => item.id), ["second", "third"]);
  assert.deepEqual(store.changes, snapshots);
  assert.strictEqual(queue.snapshot, snapshots[4]);
});

test("an acknowledgement cancelled while waiting preserves its claimed receipt", async () => {
  const entered = deferred(), release = deferred();
  const store = memoryQueue(async label => {
    if (label === "enqueue:later") { entered.resolve(); await release.promise; }
  });
  await store.queue.enqueue(message("claimed"));
  const snapshot = await store.queue.read();
  let current = true;
  const waiting = store.queue.enqueue(message("later"));
  await entered.promise;
  const acknowledgement = store.queue.ack(snapshot.receipt.id, () => current);
  current = false;
  release.resolve();
  await waiting;
  const after = await acknowledgement;
  assert.equal(after.receipt.id, snapshot.receipt.id);
  assert.deepEqual(after.messages.map(item => item.id), ["later"]);
  assert.ok(!store.calls.some(label => label.startsWith("ack:")));
});

test("reads share an unacknowledged receipt while later enqueues and removals remain pending", async () => {
  const { queue } = memoryQueue();
  const [, first, , repeated, removed] = await Promise.all([
    queue.enqueue(message("first")), queue.read(), queue.enqueue(message("later")), queue.read(), queue.remove("later"),
  ]);
  assert.deepEqual(first.receipt.messages.map(item => item.id), ["first"]);
  assert.deepEqual(repeated.receipt, first.receipt);
  assert.deepEqual(repeated.messages.map(item => item.id), ["later"]);
  assert.deepEqual(removed, first);
  await queue.ack(first.receipt.id);
  assert.deepEqual(await queue.load(), EMPTY_QUEUE);
});

test("a failed enqueue preserves the input and snapshot, and subsequent operations recover", async () => {
  const { queue, failures, changes } = memoryQueue();
  const draft = Object.freeze(message("draft", { images: Object.freeze([]), previews: Object.freeze([]) }));
  const error = new Error("disk full");
  failures.set("enqueue", error);
  const failed = queue.enqueue(draft);
  const rejection = assert.rejects(failed, reason => reason === error);
  const retried = queue.enqueue(draft), read = queue.read();
  await rejection;
  assert.deepEqual((await retried).messages, [draft]);
  assert.deepEqual((await read).receipt.messages, [draft]);
  assert.equal(changes.length, 2, "a rejected operation must not publish an empty or stale snapshot");
  assert.deepEqual(draft, message("draft"));
});

test("a failed read leaves all messages available to the next queued read", async () => {
  const { queue, failures, changes } = memoryQueue();
  await queue.enqueue(message("kept"));
  const previous = queue.snapshot;
  failures.set("read", new Error("cannot persist receipt"));
  await assert.rejects(queue.read(), /cannot persist receipt/);
  assert.strictEqual(queue.snapshot, previous);
  assert.equal(changes.length, 1);
  assert.deepEqual((await queue.read()).receipt.messages, [message("kept")]);
});

test("a failed remove does not delete its message or poison a subsequent enqueue/read", async () => {
  const { queue, failures } = memoryQueue();
  await queue.enqueue(message("kept"));
  failures.set("remove", new Error("remove failed"));
  const rejected = assert.rejects(queue.remove("kept"), /remove failed/);
  const added = queue.enqueue(message("next"));
  await rejected;
  await added;
  assert.deepEqual((await queue.read()).receipt.messages.map(item => item.id), ["kept", "next"]);
});

test("a failed acknowledgement retains its receipt and stale acknowledgements cannot clear a newer batch", async () => {
  const { queue, failures } = memoryQueue();
  await queue.enqueue(message("first"));
  const first = await queue.read();
  await queue.enqueue(message("later"));
  failures.set("ack", new Error("ack failed"));
  await assert.rejects(queue.ack(first.receipt.id), /ack failed/);
  assert.deepEqual((await queue.read()).receipt, first.receipt);
  await queue.ack(first.receipt.id);
  const next = await queue.read();
  assert.deepEqual(next.receipt.messages.map(item => item.id), ["later"]);
  assert.notEqual(next.receipt.id, first.receipt.id);
  assert.deepEqual((await queue.ack(first.receipt.id)).receipt, next.receipt);
});

test("a failed initial load does not prevent later enqueue and reload", async () => {
  const { queue, failures } = memoryQueue();
  failures.set("list", new Error("temporarily unavailable"));
  await assert.rejects(queue.load(), /temporarily unavailable/);
  await queue.enqueue(message("saved"));
  assert.deepEqual((await queue.load()).messages, [message("saved")]);
});

test("concurrent duplicate InboxRequests share the exact in-flight promise and original batch", async () => {
  const requests = new InboxRequests(), gate = deferred();
  let calls = 0;
  const first = requests.read("process:request", () => { calls++; return gate.promise; });
  const duplicate = requests.read("process:request", () => { calls++; throw new Error("duplicate read"); });
  assert.strictEqual(duplicate, first);
  assert.equal(calls, 1);
  const original = batch("receipt-a", [message("a")]);
  gate.resolve(original);
  assert.strictEqual(await duplicate, original);
});

test("a duplicate request after acknowledgement never claims a later batch", async () => {
  const { queue } = memoryQueue(), requests = new InboxRequests();
  await queue.enqueue(message("first"));
  const first = await requests.read("p:one", queue.read);
  await queue.ack(first.receipt.id);
  await queue.enqueue(message("later"));
  const duplicate = await requests.read("p:one", queue.read);
  assert.deepEqual(duplicate, first);
  assert.deepEqual(queue.snapshot.messages.map(item => item.id), ["later"]);
  assert.deepEqual((await requests.read("p:two", queue.read)).receipt.messages.map(item => item.id), ["later"]);
});

test("a cached empty request stays empty even after new messages arrive", async () => {
  const { queue } = memoryQueue(), requests = new InboxRequests();
  assert.deepEqual(await requests.read("p:empty", queue.read), EMPTY_QUEUE);
  await queue.enqueue(message("later"));
  assert.deepEqual(await requests.read("p:empty", queue.read), EMPTY_QUEUE);
  assert.deepEqual(queue.snapshot.messages.map(item => item.id), ["later"]);
});

test("two distinct requests see the same outstanding receipt without removing later messages", async () => {
  const { queue } = memoryQueue(), requests = new InboxRequests();
  await queue.enqueue(message("first"));
  const one = requests.read("p:one", queue.read), two = requests.read("p:two", queue.read);
  const [first, second] = await Promise.all([one, two]);
  assert.deepEqual(first.receipt, second.receipt);
  await queue.ack(first.receipt.id);
  await queue.enqueue(message("later"));
  assert.deepEqual(await requests.read("p:two", queue.read), second);
  assert.deepEqual(queue.snapshot.messages.map(item => item.id), ["later"]);
});

test("a rejected request can retry, while successful retries remain idempotent", async () => {
  const requests = new InboxRequests();
  let reject;
  const failed = new Promise((_, fail) => { reject = fail; });
  const one = requests.read("p:retry", () => failed);
  const two = requests.read("p:retry", () => { assert.fail("an in-flight retry must not invoke storage twice"); });
  const checks = [assert.rejects(one, /storage failed/), assert.rejects(two, /storage failed/)];
  reject(new Error("storage failed"));
  await Promise.all(checks);
  const recovered = batch("retry", [message("kept")]);
  const retry = requests.read("p:retry", () => Promise.resolve(recovered));
  assert.strictEqual(await retry, recovered);
  assert.strictEqual(requests.read("p:retry", () => { throw new Error("duplicate retry"); }), retry);
});

test("request IDs are scoped to their provider process", async () => {
  const requests = new InboxRequests();
  const a = batch("a", [message("a")]), b = batch("b", [message("b")]);
  assert.strictEqual(await requests.read("process-a:1", async () => a), a);
  assert.strictEqual(await requests.read("process-b:1", async () => b), b);
});

test("old duplicate request IDs must not consume newer messages after many other requests", async () => {
  const { queue } = memoryQueue(), requests = new InboxRequests();
  await queue.enqueue(message("original"));
  const original = await requests.read("p:original", queue.read);
  await queue.ack(original.receipt.id);
  for (let index = 0; index < 129; index++) await requests.read(`p:other-${index}`, queue.read);
  await queue.enqueue(message("later"));
  assert.deepEqual(await requests.read("p:original", queue.read), original,
    "evicting a remembered request must not turn its retry into a new destructive read");
  assert.deepEqual(queue.snapshot.messages.map(item => item.id), ["later"]);
});

const mcpRequest = (method, params = {}, id = 7) => ({
  subtype: "mcp_message", server_name: INBOX_SERVER, message: { jsonrpc: "2.0", id, method, params },
});
const wireReply = reply => {
  assert.ok(reply, "the inbox server must handle its own MCP envelope");
  assert.ok(!reply.line.includes("\n"), "stdio responses must fit on one physical line");
  const outer = JSON.parse(reply.line);
  assert.equal(outer.type, "control_response");
  assert.equal(outer.response.subtype, "success");
  return { outer, mcp: outer.response.response.mcp_response };
};

test("Claude registers the SDK MCP server and includes inbox instructions in its launch flags", () => {
  assert.deepEqual(JSON.parse(controlLine("init-control", claudeInboxInitialize)), {
    type: "control_request", request_id: "init-control", request: { subtype: "initialize", sdkMcpServers: [INBOX_SERVER] },
  });
  assert.equal(CLAUDE_INBOX_TOOL, `mcp__${INBOX_SERVER}__${INBOX_TOOL}`);
  assert.ok(claudeChatFlags(null, null).some(value => value.includes(INBOX_INSTRUCTIONS)));
});

for (const protocolVersion of ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]) {
  test(`Claude MCP initialize negotiates ${protocolVersion} without reading the inbox`, async () => {
    let reads = 0;
    const reply = await claudeInboxReply("outer-initialize", mcpRequest("initialize", { protocolVersion }), async () => { reads++; return EMPTY_QUEUE; });
    const { outer, mcp } = wireReply(reply);
    assert.equal(outer.response.request_id, "outer-initialize");
    assert.deepEqual(mcp, { jsonrpc: "2.0", id: 7, result: {
      protocolVersion, capabilities: { tools: {} }, serverInfo: { name: INBOX_SERVER, version: "1.0.0" },
      instructions: integrationInstructions("claude"),
    } });
    assert.equal(reply.receipt, null);
    assert.equal(reads, 0);
  });
}

test("unsupported MCP protocol versions fall back without accidentally consuming a batch", async () => {
  const reply = await claudeInboxReply("fallback", mcpRequest("initialize", { protocolVersion: "unknown" }), async () => { throw new Error("handshake must not read"); });
  assert.equal(wireReply(reply).mcp.result.protocolVersion, "2025-11-25");
  assert.equal(reply.receipt, null);
});

test("MCP tools/list advertises the empty input schema without reading storage", async () => {
  let reads = 0;
  const reply = await claudeInboxReply("outer-list", mcpRequest("tools/list", {}, "list-id"), async () => { reads++; return EMPTY_QUEUE; });
  const { mcp } = wireReply(reply);
  assert.equal(mcp.id, "list-id");
  assert.deepEqual(mcp.result.tools, [inboxTool]);
  assert.deepEqual(inboxTool.inputSchema, { type: "object", properties: {}, additionalProperties: false });
  assert.equal(inboxTool.name, INBOX_TOOL);
  assert.equal(reads, 0);
  assert.equal(reply.receipt, null);
});

test("MCP initialized/cancelled notifications and ping acknowledge control traffic without reading", async () => {
  let reads = 0;
  for (const method of ["notifications/initialized", "notifications/cancelled", "ping"]) {
    const request = mcpRequest(method);
    if (method.startsWith("notifications/")) delete request.message.id;
    const reply = await claudeInboxReply(`outer-${method}`, request, async () => { reads++; return EMPTY_QUEUE; });
    const { outer, mcp } = wireReply(reply);
    assert.equal(outer.response.request_id, `outer-${method}`);
    assert.ok(!mcp.error);
    assert.equal(reply.receipt, null);
  }
  assert.equal(reads, 0);
});

test("unrelated Claude control subtypes and MCP servers are ignored without reading", async () => {
  const read = async () => { assert.fail("unrelated control traffic must not consume the inbox"); };
  assert.equal(await claudeInboxReply("x", { ...mcpRequest("tools/call"), server_name: "other-server" }, read), null);
  assert.equal(await claudeInboxReply("x", { ...mcpRequest("tools/call"), subtype: "can_use_tool" }, read), null);
});

for (const id of [0, 42, "inner-call-id"]) {
  test(`MCP tools/call preserves nested request ID ${JSON.stringify(id)} independently of the control ID`, async () => {
    const snapshot = batch("receipt-with-images", [message("q", {
      text: 'Conserva "comillas"\ny emojis 🦖', images: [{ mediaType: "image/png", data: "cG5n" }], previews: ["private-preview"],
    })]);
    let reads = 0;
    const reply = await claudeInboxReply("outer-control-id", mcpRequest("tools/call", { name: INBOX_TOOL, arguments: {} }, id), async () => { reads++; return snapshot; });
    const { outer, mcp } = wireReply(reply);
    assert.equal(outer.response.request_id, "outer-control-id");
    assert.equal(mcp.jsonrpc, "2.0");
    assert.strictEqual(mcp.id, id);
    assert.equal(mcp.result.isError, false);
    assert.deepEqual(mcp.result.content, inboxContent(snapshot.receipt));
    assert.deepEqual(mcp.result.content.at(-1), { type: "image", data: "cG5n", mimeType: "image/png" });
    assert.ok(mcp.result.content[1].text.includes(snapshot.receipt.messages[0].text));
    assert.ok(!reply.line.includes("private-preview"));
    assert.strictEqual(reply.receipt, snapshot.receipt);
    assert.equal(reads, 1);
  });
}

test("calling an empty inbox returns a successful text result and no receipt", async () => {
  const reply = await claudeInboxReply("empty", mcpRequest("tools/call", { name: INBOX_TOOL, arguments: {} }), async () => EMPTY_QUEUE);
  const { mcp } = wireReply(reply);
  assert.equal(mcp.result.isError, false);
  assert.deepEqual(mcp.result.content, inboxContent(null));
  assert.equal(mcp.result.content.length, 1);
  assert.equal(mcp.result.content[0].type, "text");
  assert.equal(reply.receipt, null);
});

test("unknown MCP tools and methods return nested JSON-RPC errors without claiming messages", async () => {
  let reads = 0;
  for (const [request, code] of [
    [mcpRequest("tools/call", { name: "unknown_tool", arguments: {} }, "unknown-tool"), -32602],
    [mcpRequest("resources/list", {}, "unknown-method"), -32601],
  ]) {
    const reply = await claudeInboxReply("outer-error", request, async () => { reads++; return EMPTY_QUEUE; });
    const { mcp } = wireReply(reply);
    assert.equal(mcp.id, request.message.id);
    assert.equal(mcp.error.code, code);
    assert.ok(mcp.error.message);
    assert.ok(!("result" in mcp));
    assert.equal(reply.receipt, null);
  }
  assert.equal(reads, 0);
});

test("MCP rejects absent, scalar, array and extra arguments without accessing storage", async () => {
  let reads = 0;
  for (const args of [undefined, null, [], "{}", 0, false, { unexpected: true }]) {
    const reply = await claudeInboxReply("invalid", mcpRequest("tools/call", { name: INBOX_TOOL, arguments: args }), async () => { reads++; return EMPTY_QUEUE; });
    const { mcp } = wireReply(reply);
    assert.equal(mcp.error?.code, -32602, JSON.stringify(args));
    assert.ok(!("result" in mcp));
    assert.equal(reply.receipt, null);
  }
  assert.equal(reads, 0);
});

test("storage failure becomes an MCP tool error result with both IDs intact and can be retried", async () => {
  const requests = new InboxRequests(), request = mcpRequest("tools/call", { name: INBOX_TOOL, arguments: {} }, "inner-failure");
  const failed = await claudeInboxReply("outer-failure", request, () => requests.read("p:failed", async () => { throw new Error("disk unavailable"); }));
  const { outer, mcp } = wireReply(failed);
  assert.equal(outer.response.request_id, "outer-failure");
  assert.equal(mcp.id, "inner-failure");
  assert.equal(mcp.result.isError, true);
  assert.match(mcp.result.content[0].text, /disk unavailable/);
  assert.ok(!("error" in mcp));
  assert.equal(failed.receipt, null);
  const snapshot = batch("recovered", [message("kept")]);
  const recovered = await claudeInboxReply("outer-failure", request, () => requests.read("p:failed", async () => snapshot));
  assert.equal(wireReply(recovered).mcp.result.isError, false);
  assert.deepEqual(recovered.receipt, snapshot.receipt);
});

test("retried raw Claude MCP calls return their original receipt after a successful delivery", async () => {
  const { queue } = memoryQueue(), requests = new InboxRequests();
  const request = mcpRequest("tools/call", { name: INBOX_TOOL, arguments: {} }, "mcp-1");
  const call = () => claudeInboxReply("control-1", request, () => requests.read("proc:control-1", queue.read));
  await queue.enqueue(message("first"));
  const first = await call();
  await queue.ack(first.receipt.id);
  await queue.enqueue(message("later"));
  const duplicate = await call();
  assert.equal(duplicate.line, first.line);
  assert.deepEqual(duplicate.receipt, first.receipt);
  assert.deepEqual(queue.snapshot.messages.map(item => item.id), ["later"]);
});

const illustrated = { id: "image-receipt", messages: [
  message("first", { text: "primero\ncon salto 🦖", images: [{ mediaType: "image/png", data: "cG5n" }, { mediaType: "image/jpeg", data: "anBlZw==" }], previews: ["DO_NOT_SEND_PREVIEW"] }),
  message("image-only", { text: "", images: [{ mediaType: "image/webp", data: "d2VicA==" }], previews: ["DO_NOT_SEND_PREVIEW"] }),
] };

test("inbox content preserves message and image order, MIME types and image-only messages", () => {
  const before = structuredClone(illustrated), content = inboxContent(illustrated);
  assert.deepEqual(content.map(part => part.type), ["text", "text", "image", "image", "text", "image"]);
  assert.match(content[0].text, /image-receipt/);
  assert.ok(content[1].text.includes(illustrated.messages[0].text));
  assert.match(content[1].text, /first/);
  assert.match(content[4].text, /image-only/);
  assert.deepEqual(content[2], { type: "image", data: "cG5n", mimeType: "image/png" });
  assert.deepEqual(content[3], { type: "image", data: "anBlZw==", mimeType: "image/jpeg" });
  assert.deepEqual(content[5], { type: "image", data: "d2VicA==", mimeType: "image/webp" });
  assert.ok(!JSON.stringify(content).includes("DO_NOT_SEND_PREVIEW"));
  assert.deepEqual(illustrated, before);
  assert.deepEqual(inboxContent({ id: "empty", messages: [] }), inboxContent(null));
});

for (const id of [0, 19, "codex-request"]) {
  test(`Codex dynamic-tool result serializes text/images and preserves request ID ${JSON.stringify(id)}`, () => {
    const contentItems = codexInboxContent(illustrated);
    const line = resultLine(id, { contentItems, success: true });
    assert.ok(!line.includes("\n"));
    const parsed = JSON.parse(line);
    assert.deepEqual(Object.keys(parsed).sort(), ["id", "result"]);
    assert.strictEqual(parsed.id, id);
    assert.equal(parsed.result.success, true);
    assert.deepEqual(parsed.result.contentItems.map(part => part.type), ["inputText", "inputText", "inputImage", "inputImage", "inputText", "inputImage"]);
    assert.deepEqual(parsed.result.contentItems[2], { type: "inputImage", imageUrl: "data:image/png;base64,cG5n" });
    assert.deepEqual(parsed.result.contentItems[3], { type: "inputImage", imageUrl: "data:image/jpeg;base64,anBlZw==" });
    assert.deepEqual(parsed.result.contentItems[5], { type: "inputImage", imageUrl: "data:image/webp;base64,d2VicA==" });
    assert.ok(parsed.result.contentItems[1].text.includes(illustrated.messages[0].text));
    assert.ok(!line.includes("DO_NOT_SEND_PREVIEW"));
    assert.ok(contentItems.every(part => !("mimeType" in part) && !("data" in part)));
  });
}

test("Codex empty and failed dynamic-tool results have the app-server result envelope", () => {
  const empty = JSON.parse(resultLine("empty", { contentItems: codexInboxContent(null), success: true }));
  assert.equal(empty.result.success, true);
  assert.deepEqual(empty.result.contentItems, [{ type: "inputText", text: inboxContent(null)[0].text }]);
  const failed = JSON.parse(resultLine(8, { contentItems: [{ type: "inputText", text: "storage failed\nretry" }], success: false }));
  assert.deepEqual(failed, { id: 8, result: { contentItems: [{ type: "inputText", text: "storage failed\nretry" }], success: false } });
});

const rpc = (method, params, id) => ({ type: "rpc", message: { method, params, ...(id === undefined ? {} : { id }) }, scope: "proc", now: 200 });

test("Codex dynamic tool lifecycle updates one tool item, including a failed result", () => {
  const item = { type: "dynamicToolCall", id: "tool-1", tool: INBOX_TOOL, arguments: {}, status: "inProgress", contentItems: [], success: null };
  const initial = codexReducer(initialChatState(), rpc("item/started", { item }));
  assert.equal(initial.items[0].status, "running");
  const completed = codexReducer(initial, rpc("item/completed", { item: { ...item, status: "completed", success: true, contentItems: codexInboxContent(illustrated) } }));
  assert.equal(completed.items.length, 1);
  assert.equal(completed.items[0].kind, "tool");
  assert.equal(completed.items[0].name, INBOX_TOOL);
  assert.equal(completed.items[0].status, "done");
  assert.match(completed.items[0].output, /image-receipt/);
  assert.ok(!completed.items[0].output.includes("base64"));
  const failed = codexReducer(initial, rpc("item/completed", { item: { ...item, status: "completed", success: false, contentItems: [{ type: "inputText", text: "cannot read storage" }] } }));
  assert.equal(failed.items[0].status, "error");
  assert.equal(failed.items[0].output, "cannot read storage");
});

test("Codex inbox dynamic-tool requests do not create permission prompts or turns", () => {
  const state = initialChatState();
  assert.strictEqual(codexReducer(state, rpc("item/tool/call", { tool: INBOX_TOOL, arguments: {}, callId: "call-1", threadId: "thread", turnId: "turn" }, "request-1")), state);
});

for (const [name, reducer] of [["base", baseReducer], ["Claude", chatReducer], ["Codex", codexReducer]]) {
  for (const busy of [false, true]) {
    test(`${name} queuedRead preserves ${busy ? "active" : "idle"} turn accounting and deduplicates retried receipts`, () => {
      let state = initialChatState();
      if (busy) {
        state = reducer(state, { type: "send", id: "sent", text: "original task", now: 100 });
        state = { ...state, activeMessageIds: ["sent"], turnId: "active-turn", completedTurnIds: ["older-turn"], queuedAfterInterrupt: ["sent"] };
      }
      const before = structuredClone(state), { items: ignored, ...metadata } = state;
      const action = { type: "queuedRead", messages: illustrated.messages };
      const next = reducer(state, action);
      const { items, ...afterMetadata } = next;
      assert.deepEqual(afterMetadata, metadata);
      assert.deepEqual(state, before, "reducers must not mutate the previous state");
      assert.deepEqual(items.slice(state.items.length), illustrated.messages.map(item => ({
        kind: "user", id: item.id, text: item.text, images: item.previews.length, previews: item.previews, fromQueue: true,
      })));
      const retried = reducer(next, action);
      assert.deepEqual(retried, next);
      const staleRetry = reducer(retried, { type: "queuedRead", messages: [message("first", { text: "must not replace delivered text" })] });
      assert.deepEqual(staleRetry, next);
    });
  }
}

test("queuedRead ignores already displayed IDs while appending new messages in batch order", () => {
  const state = baseReducer(initialChatState(), { type: "send", id: "existing", text: "already visible", now: 0 });
  const next = baseReducer(state, { type: "queuedRead", messages: [message("existing"), message("new-a"), message("new-b")] });
  assert.deepEqual(next.items.map(item => item.id), ["existing", "new-a", "new-b"]);
  assert.equal(next.items[0].text, "already visible");
  assert.equal(next.pendingTurns, 1);
  assert.deepEqual(next.pendingMessageIds, ["existing"]);
});

test("queuedRead also deduplicates repeated IDs inside a single delivery batch", () => {
  const next = baseReducer(initialChatState(), { type: "queuedRead", messages: [message("same"), message("same"), message("other")] });
  assert.deepEqual(next.items.map(item => item.id), ["same", "other"]);
  assert.equal(next.pendingTurns, 0);
});

test("Claude completes its original turn after queuedRead without leaving a phantom pending turn", () => {
  let state = chatReducer(initialChatState(), { type: "send", id: "sent", text: "task", now: 100 });
  state = chatReducer(state, { type: "queuedRead", messages: [message("queued")] });
  state = chatReducer(state, { type: "line", event: { type: "result", subtype: "success", duration_ms: 100, is_error: false }, now: 200 });
  assert.equal(state.pendingTurns, 0);
  assert.deepEqual(state.pendingMessageIds, []);
  assert.equal(state.items.filter(item => item.kind === "user").length, 2);
  assert.equal(state.items.filter(item => item.kind === "turn").length, 1);
});

test("Codex completes its original turn after queuedRead without leaving a phantom pending turn", () => {
  let state = codexReducer(initialChatState(), { type: "send", id: "sent", text: "task", now: 100 });
  state = codexReducer(state, rpc("turn/started", { turn: { id: "turn-1" } }));
  state = codexReducer(state, { type: "queuedRead", messages: [message("queued")] });
  state = codexReducer(state, rpc("turn/completed", { turn: { id: "turn-1", status: "completed", durationMs: 100 } }));
  assert.equal(state.pendingTurns, 0);
  assert.deepEqual(state.pendingMessageIds, []);
  assert.equal(state.items.filter(item => item.kind === "user").length, 2);
  assert.equal(state.items.filter(item => item.kind === "turn").length, 1);
});
