import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import test from "node:test";
import { load } from "./ts-loader.mjs";

const { MessageQueue, dispatchQueuedMessage } = await load("messageQueue");
const { roomQueueAddress, roomQueueSnapshot } = await load("agentRoom");
const item = (id, text = `Mensaje ${id}`) => ({ id, text, createdAt: 123, images: [{ mediaType: "image/png", data: "aW1hZ2U=" }], previews: ["data:image/png;base64,aW1hZ2U="] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function storage(messages) {
  let stored = { messages: structuredClone(messages), receipt: null, outbox: [] }, sequence = 0;
  const calls = [], failures = new Set();
  const operation = (name, action) => async (...args) => {
    calls.push(name);
    if (failures.delete(name)) throw new Error(`failed ${name}`);
    action(...args);
    return structuredClone(stored);
  };
  const transport = {
    list: operation("list", () => {}),
    enqueue: operation("enqueue", message => stored.messages.push(structuredClone(message))),
    remove: operation("remove", id => { stored.messages = stored.messages.filter(message => message.id !== id); }),
    read: operation("read", () => {
      if (!stored.receipt && stored.messages.length) {
        stored.receipt = { id: "inbox-receipt", messages: stored.messages }; stored.messages = [];
      }
    }),
    ack: operation("ack", id => { if (stored.receipt?.id === id) stored.receipt = null; }),
    update: operation("update", (id, text, expectedText) => {
      const message = stored.messages.find(message => message.id === id);
      if (!message || message.text !== expectedText) throw new Error("stale edit");
      message.text = text;
    }),
    claimDirect: operation("claimDirect", (id, expected) => {
      const index = stored.messages.findIndex(message => message.id === id);
      if (stored.outbox.length || index < 0 || !isDeepStrictEqual(stored.messages[index], expected)) throw new Error("already read or changed");
      const predecessors = stored.messages.slice(0, index).map(message => message.id);
      const [message] = stored.messages.splice(index, 1);
      stored.outbox.push({ id: `direct-${++sequence}`, message, predecessors });
    }),
    ackDirect: operation("ackDirect", id => { stored.outbox = stored.outbox.filter(dispatch => dispatch.id !== id); }),
    restoreDirect: operation("restoreDirect", id => {
      const dispatch = stored.outbox.find(dispatch => dispatch.id === id);
      if (!dispatch) return;
      const position = stored.messages.reduce((last, message, index) => dispatch.predecessors.includes(message.id) ? index + 1 : last, 0);
      stored.messages.splice(position, 0, dispatch.message);
      stored.outbox = stored.outbox.filter(dispatch => dispatch.id !== id);
    }),
  };
  return { queue: () => new MessageQueue(transport, () => {}), calls, failures,
    get snapshot() { return structuredClone(stored); } };
}

test("direct delivery reserves before provider input and acknowledges only accepted payloads", async () => {
  const first = item("first"), store = storage([first, item("second")]), queue = store.queue();
  const sent = [];
  await dispatchQueuedMessage(queue, first, async message => {
    assert.equal(store.snapshot.outbox.length, 1);
    assert.deepEqual(store.snapshot.messages.map(message => message.id), ["second"]);
    sent.push(message); return true;
  });
  assert.deepEqual(sent, [first]);
  assert.deepEqual(store.calls, ["claimDirect", "ackDirect"]);
  assert.deepEqual(store.snapshot.outbox, []);
});

test("inbox polling during a forced send cannot deliver the reserved message twice", async () => {
  const first = item("first"), store = storage([first, item("second")]), queue = store.queue();
  await dispatchQueuedMessage(queue, first, async () => {
    const read = await queue.read();
    assert.deepEqual(read.receipt.messages.map(message => message.id), ["second"]);
    assert.equal(read.outbox[0].message.id, "first");
    return true;
  });
  assert.deepEqual(store.snapshot.receipt.messages.map(message => message.id), ["second"]);
});

test("a rejected or failed direct send stays durable across queue reconstruction without replay", async () => {
  for (const outcome of [false, new Error("transport disconnected")]) {
    const first = item("first"), store = storage([first]), queue = store.queue();
    let sends = 0;
    await assert.rejects(dispatchQueuedMessage(queue, first, async () => { sends++; if (outcome instanceof Error) throw outcome; return outcome; }));
    const restored = await store.queue().load();
    assert.equal(sends, 1);
    assert.deepEqual(restored.outbox[0].message, first);
    assert.ok(!store.calls.includes("ackDirect") && !store.calls.includes("restoreDirect"));
  }
});

test("an acknowledgement failure retains the accepted message for review", async () => {
  const first = item("first"), store = storage([first]); store.failures.add("ackDirect");
  await assert.rejects(dispatchQueuedMessage(store.queue(), first, async () => true), /failed ackDirect/);
  assert.deepEqual(store.snapshot.outbox[0].message, first);
});

test("Stop or unmount after reservation or provider acceptance never removes uncertain data", async () => {
  for (const boundary of ["claimed", "accepted"]) {
    const first = item("first"), store = storage([first]), queue = store.queue(); let checks = 0, sends = 0;
    await assert.rejects(dispatchQueuedMessage(queue, first, async () => { sends++; return true; }, () => ++checks < (boundary === "claimed" ? 2 : 3)));
    assert.equal(sends, boundary === "claimed" ? 0 : 1);
    assert.deepEqual(store.snapshot.outbox[0].message, first);
    assert.ok(!store.calls.includes("ackDirect"));
  }
});

test("a concurrent text change rejects stale direct delivery while preserving attachments and order", async () => {
  const first = item("first"), second = item("second"), store = storage([first, second]), queue = store.queue();
  await queue.update("first", "Texto corregido", first.text);
  let sends = 0;
  await assert.rejects(dispatchQueuedMessage(queue, first, async () => { sends++; return true; }), /changed/);
  assert.equal(sends, 0);
  assert.deepEqual(store.snapshot.messages, [{ ...first, text: "Texto corregido" }, second]);
  await assert.rejects(queue.update("first", "Edición antigua", first.text), /stale/);
});

test("explicit review restores the message ahead of later arrivals, preserving images", async () => {
  const first = item("first"), second = item("second"), store = storage([first, second]), queue = store.queue();
  await assert.rejects(dispatchQueuedMessage(queue, second, async () => false));
  await queue.enqueue(item("third"));
  await queue.restoreDirect(store.snapshot.outbox[0].id);
  assert.deepEqual(store.snapshot.messages, [first, second, item("third")]);
  assert.deepEqual(store.snapshot.outbox, []);
});

test("editing, reservation, and subsequent operations share the queue's serialized tail", async () => {
  const first = item("first"), store = storage([first]), queue = store.queue(), ready = deferred();
  const update = queue.update("first", "Actualizado", first.text);
  const send = update.then(() => dispatchQueuedMessage(queue, { ...first, text: "Actualizado" }, async message => {
    assert.equal(message.text, "Actualizado"); await ready.promise; return true;
  }));
  ready.resolve(); await send;
  assert.deepEqual(store.calls, ["update", "claimDirect", "ackDirect"]);
});

test("shared-room snapshots namespace direct reservations and retain exact native owners", () => {
  const raw = { messages: [item("second")], receipt: { id: "receipt", messages: [item("third")] },
    outbox: [{ id: "dispatch", message: item("first"), predecessors: ["prior"] }] };
  const named = roomQueueSnapshot("planner", raw);
  assert.equal(named.outbox[0].id, "planner::dispatch");
  assert.deepEqual(roomQueueAddress(named.outbox[0].id), { role: "planner", id: "dispatch" });
  assert.deepEqual(roomQueueAddress(named.outbox[0].message.id), { role: "planner", id: "first" });
  assert.deepEqual(named.outbox[0].predecessors, ["planner::prior"]);
  assert.equal(named.messages[0].id, "planner::second");
  assert.equal(named.receipt.id, "planner::receipt");
  assert.equal(raw.outbox[0].message.id, "first");
  assert.throws(() => roomQueueAddress("unowned"), /agente/);
});
