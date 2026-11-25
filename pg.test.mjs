// Persistence tests with a real PostgreSQL (P0.2-P0.6): node --test tools/restep-server/pg.test.mjs
// They start a temporary cluster (pg-cluster.mjs: initdb in a temporary directory, Unix socket only,
// port 54320-54329) and two server processes (pg-worker.mjs, ports 8100 and 8101) that share the
// database. The failures are real: processes killed with SIGKILL before or after the COMMIT, a
// confirmed COMMIT whose response is lost, backends ended with pg_terminate_backend and PostgreSQL
// crashes (pg_ctl stop -m immediate) with recovery from the WAL.
// Without PostgreSQL binaries or without the pg package, the suite is skipped and says so.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pgUnavailable, startCluster } from './pg-cluster.mjs';

const skip = pgUnavailable();
if (skip) console.log(`# SKIPPED: PostgreSQL tests (${skip})`);
if (skip) test('persistence tests with PostgreSQL', { skip: `SKIPPED: ${skip}` }, () => {});
const worker = fileURLToPath(new URL('./pg-worker.mjs', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const later = async (ms, fn) => { await sleep(ms); return fn(); };

let cluster, admin, pgmod, A, B;

function startWorker(port) {
  const proc = spawn(process.execPath, [worker], { env: { ...process.env, PGHOST: cluster.host, PGPORT: String(cluster.port), PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((r) => proc.once('exit', (code, signal) => r(signal ?? code)));
  const ready = new Promise((resolve, reject) => {
    proc.stdout.once('data', resolve);
    exited.then((how) => reject(new Error(`worker ${port} exited (${how}): ${log}`)));
  });
  return ready.then(() => ({ proc, port, exited, log: () => log }));
}
async function stopWorker(w) {
  if (w && w.proc.exitCode === null && w.proc.signalCode === null) { w.proc.kill('SIGKILL'); await w.exited; }
}

async function call(w, method, path, { body, key, token = 'alice-1', etag, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = method === 'PATCH' ? 'application/merge-patch+json' : 'application/json';
  if (key !== undefined) h['idempotency-key'] = `"${key}"`;
  if (token) h.authorization = `Bearer ${token}`;
  if (etag) h['if-match'] = etag;
  try {
    const r = await fetch(`http://localhost:${w.port}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, headers: r.headers, text, json: text ? JSON.parse(text) : null };
  } catch (e) {
    return { status: 'network-error', error: e };
  }
}
const post = (w, title, key, opts = {}) => call(w, 'POST', opts.path ?? '/books', { body: opts.body ?? { title }, key, ...opts });
// A client that honours Retry-After: it repeats while the first request is still in progress.
async function untilSettled(fn, tries = 100) {
  for (let i = 0; i < tries; i++) {
    const r = await fn();
    if (r.status !== 409) return r;
    assert.equal(r.json.code, 'request_in_progress');
    await sleep(100);
  }
  throw new Error('the reservation did not settle');
}
const rows = async (title, collection = 'books') => (await admin.query("SELECT id FROM restep_items WHERE collection = $1 AND doc->>'title' = $2", [collection, title])).rowCount;
const keys = async () => (await admin.query('SELECT scope, response FROM restep_idempotency')).rows;
const replayed = (r) => r.headers.get('idempotent-replayed') === 'true';

describe('restep-server with real PostgreSQL', { skip: skip ?? false }, () => {
  before(async () => {
    pgmod = (await import('pg')).default;
    cluster = await startCluster();
    admin = new pgmod.Pool({ host: cluster.host, port: cluster.port, user: 'postgres', database: 'postgres', max: 3 });
    admin.on('error', () => {});
    const { migrate } = await import('./pg.mjs');
    await migrate(admin);
    [A, B] = await Promise.all([startWorker(8100), startWorker(8101)]);
  });
  after(async () => {
    await Promise.all([stopWorker(A), stopWorker(B)]);
    await admin?.end().catch(() => {});
    cluster?.stop();
  });
  beforeEach(async () => {
    await admin.query('TRUNCATE restep_items, restep_idempotency');
    for (const [name, port] of [['A', 8100], ['B', 8101]]) {
      const w = name === 'A' ? A : B;
      if (w.proc.exitCode !== null || w.proc.signalCode !== null) { if (name === 'A') A = await startWorker(port); else B = await startWorker(port); }
    }
  });

  // ── P0.2: one transaction for the resource, the reservation and the response ──
  describe('P0.2 shared transaction', () => {
    test('the resource and the stored response commit together and another process replays it', async () => {
      const r = await post(A, 'Uno', 'k-1');
      assert.equal(r.status, 201);
      assert.equal(await rows('Uno'), 1);
      const [saved] = await keys();
      assert.equal(saved.response.status, 201);
      // The body is stored as JSON text, with its keys in the order sent (jsonb would reorder them).
      assert.equal(saved.response.body_text, r.text);
      const again = await post(B, 'Uno', 'k-1');
      assert.equal(again.status, 201);
      assert.ok(replayed(again));
      assert.equal(again.text, r.text);
      assert.equal(again.headers.get('location'), r.headers.get('location'));
      assert.equal(again.headers.get('etag'), r.headers.get('etag'));
      assert.equal(await rows('Uno'), 1);
    });

    test('Prefer: return=minimal replays without a body', async () => {
      const r = await post(A, 'Mínimo', 'k-min', { headers: { prefer: 'return=minimal' } });
      assert.equal(r.status, 201);
      assert.equal(r.text, '');
      const again = await post(B, 'Mínimo', 'k-min', { headers: { prefer: 'return=minimal' } });
      assert.equal(again.status, 201);
      assert.ok(replayed(again));
      assert.equal(again.text, '');
      assert.equal(again.headers.get('location'), r.headers.get('location'));
    });

    test('a reservation without a response cannot commit (deferred trigger)', async () => {
      const client = await admin.connect();
      try {
        await client.query('BEGIN');
        await client.query("INSERT INTO restep_idempotency (scope, print, expires_at) VALUES ('suelta', 'x', now() + interval '1 day')");
        await assert.rejects(client.query('COMMIT'), /without a stored response/);
      } finally { client.release(); }
      assert.equal((await keys()).length, 0);
    });

    test('the store and the adapter writes require the transaction', async () => {
      const { pgIdempotencyStore, pgDocumentAdapter } = await import('./pg.mjs');
      await assert.rejects(async () => pgIdempotencyStore().reserve('k', 'p', 1000, {}), /needs ctx.transaction/);
      await assert.rejects(pgDocumentAdapter({ pool: admin, collection: 'books' }).create({ title: 'x' }, {}), /needs ctx.transaction/);
    });
  });

  // ── P0.3: idempotency across two processes ──
  describe('P0.3 idempotency across processes', () => {
    test('25 keys sent almost at once (0-16 ms) to two processes: one effect per key and consistent responses', async () => {
      const n = 25;
      const results = await Promise.all(Array.from({ length: n }, (_, i) =>
        Promise.all([post(A, `Simultáneo ${i}`, `sim-${i}`), later(i % 5 * 4, () => post(B, `Simultáneo ${i}`, `sim-${i}`))])));
      let conflicts = 0, replays = 0;
      for (const [i, pair] of results.entries()) {
        const fresh = pair.filter((r) => r.status === 201 && !replayed(r));
        assert.equal(fresh.length, 1, `key ${i}: ${pair.map((r) => r.status).join(', ')}`);
        for (const r of pair.filter((x) => x !== fresh[0])) {
          if (r.status === 409) {
            conflicts++;
            assert.equal(r.json.code, 'request_in_progress');
            assert.ok(r.headers.get('retry-after'));
          } else {
            replays++;
            assert.equal(r.status, 201);
            assert.ok(replayed(r));
            assert.equal(r.text, fresh[0].text);
          }
        }
        assert.equal(await rows(`Simultáneo ${i}`), 1, `key ${i}`);
        const settled = await untilSettled(() => post(B, `Simultáneo ${i}`, `sim-${i}`));
        assert.equal(settled.status, 201);
        assert.ok(replayed(settled));
        assert.equal(settled.text, fresh[0].text);
      }
      console.log(`# concurrent: ${n} keys, ${conflicts} 409 request_in_progress responses, ${replays} replays`);
      assert.equal((await keys()).length, n);
    });

    test('in progress in another process: the same body gives 409, another body 422; once done, it replays', async () => {
      const first = post(A, 'Lento', 'k-curso', { headers: { 'x-test-delay': '1000' } });
      await sleep(300);
      const same = await post(B, 'Lento', 'k-curso');
      assert.equal(same.status, 409);
      assert.equal(same.json.code, 'request_in_progress');
      assert.equal(same.headers.get('retry-after'), '1');
      const other = await post(B, 'Otro', 'k-curso');
      assert.equal(other.status, 422);
      assert.equal(other.json.code, 'idempotency_mismatch');
      const done = await first;
      assert.equal(done.status, 201);
      const again = await post(B, 'Lento', 'k-curso');
      assert.ok(replayed(again));
      assert.equal(again.text, done.text);
      assert.equal((await post(B, 'Otro', 'k-curso')).json.code, 'idempotency_mismatch');
      assert.equal(await rows('Lento'), 1);
      assert.equal(await rows('Otro'), 0);
    });

    test('bodies equal as JSON (member order) are the same request', async () => {
      const r = await call(A, 'POST', '/books', { body: { title: 'Orden', copies: 2 }, key: 'k-orden' });
      const again = await call(B, 'POST', '/books', { body: { copies: 2, title: 'Orden' }, key: 'k-orden' });
      assert.equal(r.status, 201);
      assert.ok(replayed(again));
      assert.equal(await rows('Orden'), 1);
    });

    test('the key belongs to the principal and the target; a renewed token finds it', async () => {
      const r = await post(A, 'Mío', 'k-comp', { token: 'alice-1' });
      const renewed = await post(B, 'Mío', 'k-comp', { token: 'alice-2' });
      assert.ok(replayed(renewed));
      assert.equal(renewed.text, r.text);
      const bob = await post(B, 'Mío', 'k-comp', { token: 'bob' });
      assert.equal(bob.status, 201);
      assert.ok(!replayed(bob));
      assert.notEqual(bob.json.id, r.json.id);
      const anon = await post(A, 'Mío', 'k-comp', { token: null });
      assert.equal(anon.status, 201);
      assert.ok(!replayed(anon));
      const author = await call(B, 'POST', '/authors', { body: { name: 'Mío' }, key: 'k-comp' });
      assert.equal(author.status, 201);
      assert.ok(!replayed(author));
      assert.equal(await rows('Mío'), 3);
    });

    test('the same key from two principals at once does not block either', async () => {
      const [alice, bob] = await Promise.all([
        post(A, 'Paralelo', 'k-par', { token: 'alice-1', headers: { 'x-test-delay': '500' } }),
        (async () => { await sleep(100); return post(B, 'Paralelo', 'k-par', { token: 'bob' }); })(),
      ]);
      assert.equal(alice.status, 201);
      assert.equal(bob.status, 201);
      assert.ok(!replayed(alice) && !replayed(bob));
      assert.equal(await rows('Paralelo'), 2);
    });
  });

  // ── P0.4: real failures around the commit ──
  describe('P0.4 failure recovery', () => {
    test('rollback: the adapter inserts and fails; nothing remains and the retry creates once', async () => {
      const r = await post(A, 'Revertido', 'k-rb', { headers: { 'x-test-fault': 'throw-after-create' } });
      assert.equal(r.status, 500);
      assert.equal(await rows('Revertido'), 0);
      assert.equal((await keys()).length, 0);
      const retry = await post(B, 'Revertido', 'k-rb');
      assert.equal(retry.status, 201);
      assert.ok(!replayed(retry));
      assert.equal(await rows('Revertido'), 1);
    });

    test('the process dies before COMMIT: no effect, and the retry from another process creates once', async () => {
      const r = await post(A, 'Antes', 'k-antes', { headers: { 'x-test-fault': 'kill-before-commit' } });
      assert.equal(r.status, 'network-error');
      assert.equal(await A.exited, 'SIGKILL');
      const retry = await untilSettled(() => post(B, 'Antes', 'k-antes'));
      assert.equal(retry.status, 201);
      assert.ok(!replayed(retry));
      assert.equal(await rows('Antes'), 1);
    });

    test('the process dies after COMMIT: the retry recovers the response, also after a restart', async () => {
      const r = await post(A, 'Después', 'k-despues', { headers: { 'x-test-fault': 'kill-after-commit' } });
      assert.equal(r.status, 'network-error');
      assert.equal(await A.exited, 'SIGKILL');
      assert.equal(await rows('Después'), 1);
      const retry = await post(B, 'Después', 'k-despues');
      assert.equal(retry.status, 201);
      assert.ok(replayed(retry));
      A = await startWorker(8100); // process restart
      const again = await post(A, 'Después', 'k-despues');
      assert.ok(replayed(again));
      assert.equal(again.text, retry.text);
      assert.equal(await rows('Después'), 1);
    });

    test('the COMMIT acknowledgement is lost: 500, but the retry replays the committed response', async () => {
      const r = await post(A, 'Sin acuse', 'k-acuse', { headers: { 'x-test-fault': 'lose-commit-ack' } });
      assert.equal(r.status, 500);
      assert.equal(await rows('Sin acuse'), 1);
      const retry = await post(A, 'Sin acuse', 'k-acuse');
      assert.equal(retry.status, 201);
      assert.ok(replayed(retry));
      assert.equal(await rows('Sin acuse'), 1);
    });

    test('PostgreSQL crash with one request in progress and another committed; after WAL recovery, nothing is duplicated', async () => {
      const done = await post(A, 'Confirmado', 'k-wal-1');
      assert.equal(done.status, 201);
      const running = post(A, 'En vuelo', 'k-wal-2', { headers: { 'x-test-delay': '1500' } });
      await sleep(400);
      let interrupted;
      try { cluster.crash(); interrupted = await running; } finally { cluster.start(); }
      assert.equal(interrupted.status, 500);
      // The pool may hold connections from before the crash: the first attempt on one of them gives 500.
      const retry = async (fn) => { for (let i = 0; i < 10; i++) { const r = await fn(); if (r.status !== 500) return r; await sleep(100); } return fn(); };
      const again = await retry(() => post(B, 'Confirmado', 'k-wal-1'));
      assert.ok(replayed(again));
      assert.equal(again.text, done.text);
      const second = await retry(() => post(A, 'En vuelo', 'k-wal-2'));
      assert.equal(second.status, 201);
      assert.ok(!replayed(second));
      assert.equal(await rows('Confirmado'), 1);
      assert.equal(await rows('En vuelo'), 1);
    });
  });

  // ── P0.5: reservations with an uncertain outcome ──
  describe('P0.5 in-progress and stuck reservations', () => {
    test('a stuck reservation is visible, is terminated (rollback shown) and the retry creates once', async () => {
      const { inFlightReservations, terminateReservation } = await import('./pg.mjs');
      const stuck = post(A, 'Atascado', 'k-atasco', { headers: { 'x-test-delay': '3000' } });
      let inFlight = [];
      for (let i = 0; i < 50 && !inFlight.length; i++) { await sleep(50); inFlight = await inFlightReservations(admin); }
      assert.equal(inFlight.length, 1);
      assert.equal(inFlight[0].state, 'idle in transaction');
      assert.ok(inFlight[0].age_ms >= 0);
      assert.equal((await post(B, 'Atascado', 'k-atasco')).status, 409);
      assert.equal(await terminateReservation(admin, inFlight[0].pid), true);
      assert.equal(await terminateReservation(admin, inFlight[0].pid), false);
      assert.deepEqual(await inFlightReservations(admin), []);
      assert.equal(await rows('Atascado'), 0); // the effect was undone with the reservation
      assert.equal((await keys()).length, 0);
      const retry = await post(B, 'Atascado', 'k-atasco');
      assert.equal(retry.status, 201);
      assert.ok(!replayed(retry));
      assert.equal((await stuck).status, 500);
      assert.equal(await rows('Atascado'), 1);
    });

    test('terminating a backend that holds no reservation is refused', async () => {
      const { terminateReservation } = await import('./pg.mjs');
      const { rows: [{ pid }] } = await admin.query('SELECT pg_backend_pid() AS pid');
      assert.equal(await terminateReservation(admin, pid), false);
    });

    test('only completed responses expire; once expired, the key counts as new', async () => {
      const { purgeExpired } = await import('./pg.mjs');
      const first = await post(A, 'Caduca', 'k-ttl');
      await admin.query("UPDATE restep_idempotency SET expires_at = now() - interval '1 second'");
      const again = await post(B, 'Caduca', 'k-ttl');
      assert.equal(again.status, 201);
      assert.ok(!replayed(again)); // 7.1: after the TTL, the key counts as new
      assert.notEqual(again.json.id, first.json.id);
      await admin.query("UPDATE restep_idempotency SET expires_at = now() - interval '1 second'");
      assert.equal(await purgeExpired(admin), 1);
      assert.equal((await keys()).length, 0);
    });
  });

  // ── P0.6: atomic If-Match and write across processes ──
  describe('P0.6 atomic If-Match across processes', () => {
    const book = async (title) => {
      const r = await post(A, title, undefined);
      return { path: r.headers.get('location'), etag: r.headers.get('etag') };
    };

    test('two PATCHes with the same version from two processes: one applies, the other gives 412', async () => {
      const { path, etag } = await book('Versión');
      const [a, b] = await Promise.all([
        call(A, 'PATCH', path, { body: { copies: 1 }, etag, headers: { 'x-test-delay': '600' } }),
        later(150, () => call(B, 'PATCH', path, { body: { copies: 2 }, etag })),
      ]);
      assert.equal(a.status, 200);
      assert.equal(b.status, 412);
      assert.equal(b.json.code, 'precondition_failed');
      const now = await call(B, 'GET', path);
      assert.equal(now.json.copies, 1);
      assert.equal(now.headers.get('etag'), a.headers.get('etag'));
    });

    test('PATCH in progress and DELETE with the same version: the DELETE gives 412 and deletes nothing', async () => {
      const { path, etag } = await book('Parche primero');
      const [a, b] = await Promise.all([
        call(A, 'PATCH', path, { body: { copies: 3 }, etag, headers: { 'x-test-delay': '600' } }),
        later(150, () => call(B, 'DELETE', path, { etag })),
      ]);
      assert.equal(a.status, 200);
      assert.equal(b.status, 412);
      assert.equal((await call(B, 'GET', path)).json.copies, 3);
    });

    test('DELETE in progress and PATCH with the same version: the PATCH does not revive the item (404)', async () => {
      const { path, etag } = await book('Borrado primero');
      const [a, b] = await Promise.all([
        call(A, 'DELETE', path, { etag, headers: { 'x-test-delay': '600' } }),
        later(150, () => call(B, 'PATCH', path, { body: { copies: 4 }, etag })),
      ]);
      assert.equal(a.status, 204);
      assert.equal(b.status, 404); // 5.4: 404 before 412
      assert.equal((await call(A, 'GET', path)).status, 404);
      assert.equal(await rows('Borrado primero'), 0);
    });

    test('two DELETEs with the same version: only one deletes', async () => {
      const { path, etag } = await book('Dos borrados');
      const [a, b] = await Promise.all([
        call(A, 'DELETE', path, { etag, headers: { 'x-test-delay': '600' } }),
        later(150, () => call(B, 'DELETE', path, { etag })),
      ]);
      assert.equal(a.status, 204);
      assert.equal(b.status, 404);
    });

    test('20 rounds of concurrent PATCHes from two processes with the same version: exactly one per round', async () => {
      const { path } = await book('Rondas');
      for (let i = 1; i <= 20; i++) {
        const etag = (await call(A, 'GET', path)).headers.get('etag');
        const pair = await Promise.all([call(A, 'PATCH', path, { body: { copies: i * 10 + 1 }, etag }), call(B, 'PATCH', path, { body: { copies: i * 10 + 2 }, etag })]);
        assert.deepEqual(pair.map((r) => r.status).sort(), [200, 412], `ronda ${i}`);
        const winner = pair.find((r) => r.status === 200);
        assert.equal((await call(B, 'GET', path)).json.copies, winner.json.copies);
      }
    });

    test('PATCH without If-Match from two processes does not lose the other write', async () => {
      const { path } = await book('Sin versión');
      await Promise.all([
        call(A, 'PATCH', path, { body: { copies: 7 }, headers: { 'x-test-delay': '500' } }),
        later(150, () => call(B, 'PATCH', path, { body: { title: 'Sin versión, cambiado' } })),
      ]);
      const now = (await call(A, 'GET', path)).json;
      assert.equal(now.copies, 7);
      assert.equal(now.title, 'Sin versión, cambiado');
    });

    test('an id with a leading zero is not the same item, even if the column is bigint (3)', async () => {
      const { path } = await book('Cero delante');
      assert.equal((await call(A, 'GET', path)).status, 200);
      assert.equal((await call(A, 'GET', path.replace(/\/(\d+)$/, '/0$1'))).status, 404);
      // The same id with its first digit encoded (%37 is 7) is the item.
      assert.equal((await call(A, 'GET', path.replace(/\/(\d)(\d*)$/, (_, a, b) => `/%3${a}${b}`))).status, 200);
    });
  });
});
