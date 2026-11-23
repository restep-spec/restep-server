import { test } from "node:test";
import assert from "node:assert/strict";
import { createRestep, memoryAdapter, memoryIdempotencyStore } from "./restep-server.mjs";

const request = (title = "Book") => new Request("https://api.example/books", {
  method: "POST", headers: { "content-type": "application/json", "idempotency-key": '"recovery"' },
  body: JSON.stringify({ title }),
});
const setup = (data, store, extra = {}) => createRestep({
  collections: { books: { fields: { title: { type: "string", required: true } }, data } },
  idempotencyStore: store, onError: () => {}, ...extra,
});

test("a failure recording the response never repeats the committed creation", async () => {
  const data = memoryAdapter([]), store = memoryIdempotencyStore();
  const broken = { ...store, complete() { throw new Error("storage unavailable"); } };
  const api = setup(data, broken);
  assert.equal((await api.handle(request())).status, 500);
  assert.equal((await api.handle(request())).status, 409);
  assert.equal((await setup(data, broken).handle(request())).status, 409);
  assert.equal((await api.handle(request("different"))).status, 422);
  const response = await api.handle(new Request("https://api.example/books"));
  assert.equal((await response.json()).items.length, 1);
});

test("adapter errors after an effect keep the reservation; validation errors release it", async () => {
  const data = memoryAdapter([]);
  const api = setup({ ...data, async create(...args) { await data.create(...args); throw new Error("connection lost"); } }, memoryIdempotencyStore());
  assert.equal((await api.handle(request(42))).status, 422);
  assert.equal((await api.handle(request())).status, 500);
  assert.equal((await api.handle(request())).status, 409);
  assert.equal((await (await api.handle(new Request("https://api.example/books"))).json()).items.length, 1);
});

test("unfinished reservations do not expire into duplicate effects", () => {
  const store = memoryIdempotencyStore();
  assert.equal(store.reserve("key", "body", -1), null);
  assert.equal(store.reserve("key", "body", 100).print, "body");
  store.complete("key", [201, {}, {}]);
  assert.equal(store.reserve("key", "body", 100), null);
});

test("transaction context reaches creation and idempotency storage before commit", async () => {
  const data = memoryAdapter([]), store = memoryIdempotencyStore(), transaction = {};
  const events = [];
  const wrapped = Object.fromEntries(["reserve", "complete", "release"].map((name) => [name, (...args) => {
    assert.equal(args.at(-1).transaction, transaction);
    events.push(name);
    return store[name](...args);
  }]));
  const api = setup({ ...data, create(row, ctx) { assert.equal(ctx.transaction, transaction); events.push("create"); return data.create(row); } }, wrapped, {
    async createTransaction(work) { events.push("begin"); const result = await work(transaction); events.push("commit"); return result; },
  });
  assert.equal((await api.handle(request())).status, 201);
  assert.deepEqual(events, ["begin", "reserve", "create", "complete", "commit"]);
  assert.equal((await api.handle(request())).headers.get("idempotent-replayed"), "true");
});

test("PATCH and DELETE run inside the transaction and read the item for update", async () => {
  // Regression: If-Match was evaluated outside createTransaction, so only the in-process mutex
  // protected it; pg.test.mjs reproduces the race with two processes and PostgreSQL.
  const data = memoryAdapter([{ id: "1", title: "Book" }]), transaction = {}, events = [];
  const api = setup({
    ...data,
    get(id, ctx) { if (ctx.transaction) { assert.equal(ctx.transaction, transaction); events.push(`get${ctx.forUpdate ? " forUpdate" : ""}`); } return data.get(id); },
    update(id, row, ctx) { assert.equal(ctx.transaction, transaction); events.push("update"); return data.update(id, row); },
    delete(id, ctx) { assert.equal(ctx.transaction, transaction); events.push("delete"); return data.delete(id); },
  }, memoryIdempotencyStore(), {
    async createTransaction(work) { events.push("begin"); const result = await work(transaction); events.push("commit"); return result; },
  });
  const etag = (await api.handle(new Request("https://api.example/books/1"))).headers.get("etag");
  const patch = await api.handle(new Request("https://api.example/books/1", {
    method: "PATCH", headers: { "content-type": "application/merge-patch+json", "if-match": etag }, body: JSON.stringify({ title: "New" }),
  }));
  assert.equal(patch.status, 200);
  assert.equal((await api.handle(new Request("https://api.example/books/1", { method: "DELETE", headers: { "if-match": etag } }))).status, 412);
  assert.equal((await api.handle(new Request("https://api.example/books/1", { method: "DELETE" }))).status, 204);
  assert.deepEqual(events, ["begin", "get forUpdate", "update", "commit", "begin", "get forUpdate", "begin", "get forUpdate", "delete", "commit"]);
});

for (const failure of ["rollback", "lost commit acknowledgement"]) {
  test(`transaction adapter recovers after ${failure} without duplicate rows`, async () => {
    // Simulate a durable transaction boundary; this is not a real database crash test.
    let committed = { rows: [], keys: new Map() }, fail = true;
    const data = {
      async list() { return { items: committed.rows, next: null }; },
      async get(id) { return committed.rows.find((row) => row.id === id) ?? null; },
      async create(body, ctx) {
        const row = { id: String(ctx.transaction.rows.length + 1), ...body };
        ctx.transaction.rows.push(row);
        return row;
      },
    };
    const store = {
      reserve(key, print, ttl, { transaction }) {
        if (transaction.keys.has(key)) return transaction.keys.get(key);
        transaction.keys.set(key, { print });
        return null;
      },
      complete(key, response, { transaction }) { transaction.keys.get(key).response = response; },
      release(key, { transaction }) { transaction.keys.delete(key); },
    };
    const createTransaction = async (work) => {
      const tx = structuredClone(committed);
      const result = await work(tx);
      if (fail && failure === "rollback") { fail = false; throw new Error("rollback"); }
      committed = tx;
      if (fail) { fail = false; throw new Error("commit acknowledgement lost"); }
      return result;
    };
    assert.equal((await setup(data, store, { createTransaction }).handle(request())).status, 500);
    assert.equal(committed.rows.length, failure === "rollback" ? 0 : 1);
    const retry = await setup(data, store, { createTransaction }).handle(request());
    assert.equal(retry.status, 201);
    assert.equal(committed.rows.length, 1);
    assert.equal(retry.headers.get("idempotent-replayed"), failure === "rollback" ? null : "true");
  });
}
