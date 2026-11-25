// PostgreSQL persistence for restep-server: one transaction per write, shared by the data adapter
// and the idempotency store, so the effect and the stored response commit (or roll back) together.
// No runtime dependencies: pass a pool compatible with `pg` (node-postgres): pool.connect() gives a
// client with query(text, values) and release(err).
//
//   import pg from 'pg';
//   import { createRestep } from './restep-server.mjs';
//   import { migrate, pgTransaction, pgIdempotencyStore, pgDocumentAdapter } from './pg.mjs';
//   const pool = new pg.Pool();
//   await migrate(pool);                       // once, at deploy time
//   const api = createRestep({
//     collections: { books: { fields, data: pgDocumentAdapter({ pool, collection: 'books' }) } },
//     createTransaction: pgTransaction(pool),
//     idempotencyStore: pgIdempotencyStore(),
//   });
import { matches, sorter } from './restep-server.mjs';

// Advisory lock tag (two-int form: NAMESPACE, 0) held, shared, by every transaction that has reserved
// an idempotency key. It does not block anything; it only makes in-flight reservations observable.
export const NAMESPACE = 0x52455354; // 'REST'

const ident = (name) => {
  if (!/^[a-z_][a-z0-9_]{0,54}$/.test(name)) throw new Error(`restep-server/pg: invalid table name ${name}`);
  return name;
};

// DDL for both tables. Run it once (migrate) before starting servers: concurrent CREATE ... IF NOT EXISTS
// from several processes can fail.
export function schema({ idempotencyTable = 'restep_idempotency', itemsTable = 'restep_items' } = {}) {
  const t = ident(idempotencyTable), items = ident(itemsTable);
  return `
CREATE TABLE IF NOT EXISTS ${t} (
  scope      text PRIMARY KEY,
  print      text NOT NULL,
  response   jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ${t}_expires ON ${t} (expires_at);
-- A reservation may only commit together with its response: a row without one would be an uncertain
-- outcome that nobody can resolve. Checked at commit time, against the row as it is then.
CREATE OR REPLACE FUNCTION ${t}_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM ${t} WHERE scope = NEW.scope AND response IS NULL) THEN
    RAISE EXCEPTION 'restep: idempotency reservation % committed without a stored response', NEW.scope;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS ${t}_complete ON ${t};
CREATE CONSTRAINT TRIGGER ${t}_complete AFTER INSERT OR UPDATE ON ${t}
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${t}_complete();
CREATE TABLE IF NOT EXISTS ${items} (
  collection text   NOT NULL,
  id         bigserial,
  doc        jsonb  NOT NULL,
  PRIMARY KEY (collection, id)
);`;
}

export async function migrate(pool, options) {
  await pool.query(schema(options));
}

// createTransaction for createRestep. BEGIN, run the work on one connection, COMMIT; ROLLBACK if the
// work throws. A failed COMMIT (lost connection, lost acknowledgement) is reported as an error and never
// retried here: the outcome is unknown to this process, and the retry with the same Idempotency-Key
// finds out from the database (the stored response, or nothing at all).
export function pgTransaction(pool) {
  return async function createTransaction(work) {
    const client = await pool.connect();
    let broken;
    // A connection that drops while checked out emits 'error' on the client; without a listener it
    // would end the process. The pending query rejects anyway; remember it to discard the connection.
    const onError = (e) => { broken ??= e; };
    client.on?.('error', onError);
    try {
      await client.query('BEGIN');
      let result;
      try {
        result = await work(client);
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (rollbackError) { broken = rollbackError; }
        throw e;
      }
      try { await client.query('COMMIT'); } catch (e) { broken = e; throw e; }
      return result;
    } finally {
      client.removeListener?.('error', onError);
      client.release(broken); // with an error, the pool discards the connection
    }
  };
}

const needTransaction = (what, ctx) => {
  if (!ctx?.transaction) throw new Error(`restep-server/pg: ${what} needs ctx.transaction; configure createTransaction: pgTransaction(pool)`);
  return ctx.transaction;
};

// Idempotency store (7.1). Every call runs on the request's transaction:
// - reserve takes a transaction-scoped advisory lock on key+body (print) and then one on the key (scope).
//   The key lock says "a request with this key is running"; the key+body lock says which body it has,
//   so a concurrent request answers 409 request_in_progress (same body) or 422 idempotency_mismatch
//   (another body) without waiting, and without reading the other transaction's uncommitted rows.
//   Edge case: a third request with the same body as one that is itself about to get 422 may get a
//   transient 409 instead; its retry gets the final answer.
// - The reservation row, the created resource and the stored response commit together. If the
//   transaction dies (crash, rollback, terminated backend), all three disappear and the advisory locks
//   are released: there is no committed reservation with an uncertain outcome, and nothing expires by TTL
//   into a duplicate. Only completed responses expire, after ttl.
export function pgIdempotencyStore({ table = 'restep_idempotency' } = {}) {
  const t = ident(table);
  const tryLock = async (client, ...keys) => (await client.query(
    `SELECT pg_try_advisory_xact_lock(hashtextextended(${keys.map((_, i) => `$${i + 1}`).join(" || ' ' || ")}, 0)) AS ok`, keys)).rows[0].ok;
  async function claim(client, key, print, ttl) {
    // We hold the key lock: no other transaction is writing this key, and every committed one is visible.
    const { rows } = await client.query(`SELECT print, response, expires_at <= now() AS expired FROM ${t} WHERE scope = $1`, [key]);
    if (rows.length && !rows[0].expired) return { print: rows[0].print, response: fromJson(rows[0].response) };
    if (rows.length) await client.query(`DELETE FROM ${t} WHERE scope = $1`, [key]); // 7.1: after the TTL the key counts as new
    await client.query(`SELECT pg_advisory_xact_lock_shared(${NAMESPACE}, 0)`);
    await client.query(`INSERT INTO ${t} (scope, print, expires_at) VALUES ($1, $2, now() + $3 * interval '1 millisecond')`, [key, print, ttl]);
    return null;
  }
  return {
    async reserve(key, print, ttl, ctx) {
      const client = needTransaction('reserve', ctx);
      // Key+body first, then key. Whoever holds the key lock also holds its own key+body lock, so:
      // key+body taken by someone else: the same request is running (409).
      if (!(await tryLock(client, key, print))) return { print, response: null };
      // We hold key+body; key taken: what runs has another body (422).
      if (!(await tryLock(client, key))) return { print: null, response: null };
      return claim(client, key, print, ttl);
    },
    async complete(key, response, ctx) {
      const [status, body, headers] = response;
      // 7.1: the repetition gives the same body. jsonb reorders object keys, so the body is stored
      // as JSON text (body_text), which keeps the order it was sent in.
      const { rowCount } = await needTransaction('complete', ctx).query(`UPDATE ${t} SET response = $2 WHERE scope = $1`,
        [key, JSON.stringify({ status, headers, ...(body !== undefined && { body_text: JSON.stringify(body) }) })]);
      if (rowCount !== 1) throw new Error('restep-server/pg: complete without a reservation');
    },
    async release(key, ctx) {
      await needTransaction('release', ctx).query(`DELETE FROM ${t} WHERE scope = $1`, [key]);
    },
  };
}
// body: responses stored before body_text, which already came reordered by jsonb.
const fromJson = (r) => (r == null ? undefined : [r.status, r.body_text !== undefined ? JSON.parse(r.body_text) : r.body, r.headers]);

// Observability (P0.5): transactions holding an idempotency reservation right now, oldest first.
// A long-lived one is a request that has not finished (or a stuck connection); retries get 409.
export async function inFlightReservations(pool) {
  const { rows } = await pool.query(`
    SELECT a.pid, a.state, a.application_name, a.client_addr::text AS client_addr, a.xact_start,
           (extract(epoch FROM now() - a.xact_start) * 1000)::bigint AS age_ms, a.wait_event_type, a.wait_event
      FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE l.locktype = 'advisory' AND l.classid = ${NAMESPACE} AND l.objid = 0 AND l.objsubid = 2 AND l.granted
     ORDER BY a.xact_start`);
  return rows.map((r) => ({ ...r, age_ms: Number(r.age_ms) }));
}

// Ends a stuck reservation by terminating its backend. PostgreSQL then rolls the whole transaction
// back: reservation, effect and response alike, which proves there was no effect. Refuses a pid that
// does not hold a reservation. Resolves once the backend is gone; returns false if it had already ended.
export async function terminateReservation(pool, pid, { timeoutMs = 10000 } = {}) {
  if (!(await inFlightReservations(pool)).some((r) => r.pid === pid)) return false;
  await pool.query('SELECT pg_terminate_backend($1)', [pid]);
  const until = Date.now() + timeoutMs;
  while ((await pool.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid])).rowCount) {
    if (Date.now() > until) throw new Error(`restep-server/pg: backend ${pid} did not end`);
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
}

// Deletes completed responses past their TTL. Never touches running reservations (they are not rows
// that anyone else can see).
export async function purgeExpired(pool, { table = 'restep_idempotency' } = {}) {
  return (await pool.query(`DELETE FROM ${ident(table)} WHERE expires_at <= now() AND response IS NOT NULL`)).rowCount;
}

// Data adapter storing each item as a jsonb document in one table shared by collections. Writes run
// on the request's transaction; the item read before PATCH/DELETE (ctx.forUpdate) locks the row, so
// evaluating If-Match and writing are atomic across processes (7.2).
// list() filters and sorts in this process with the library's own rules: fine for tests and small
// collections, not for large ones (write SQL for those).
export function pgDocumentAdapter({ pool, collection, table = 'restep_items' }) {
  const t = ident(table);
  const item = (r) => ({ ...r.doc, id: String(r.id) });
  // 3: ids are compared code point by code point: "07" is not item 7, even though bigint would read it that way.
  const validId = (id) => /^(0|[1-9][0-9]{0,17})$/.test(id);
  return {
    async list({ filter, sort, limit, cursor, count }, ctx) {
      const { rows } = await (ctx?.transaction ?? pool).query(`SELECT id, doc FROM ${t} WHERE collection = $1`, [collection]);
      const all = rows.map(item).filter((r) => filter.every((f) => matches(r, f))).sort(sorter(sort));
      const offset = cursor ?? 0;
      return { items: all.slice(offset, offset + limit), next: offset + limit < all.length ? offset + limit : null, ...(count && { total: all.length }) };
    },
    async get(id, ctx) {
      if (!validId(id)) return null;
      const lock = ctx?.forUpdate && ctx?.transaction ? ' FOR UPDATE' : '';
      const { rows } = await (ctx?.transaction ?? pool).query(`SELECT id, doc FROM ${t} WHERE collection = $1 AND id = $2${lock}`, [collection, id]);
      return rows.length ? item(rows[0]) : null;
    },
    async create(data, ctx) {
      const { rows } = await needTransaction('create', ctx).query(`INSERT INTO ${t} (collection, doc) VALUES ($1, $2) RETURNING id, doc`, [collection, JSON.stringify(data)]);
      return item(rows[0]);
    },
    async update(id, data, ctx) {
      const { id: _, ...doc } = data;
      const { rows } = await needTransaction('update', ctx).query(`UPDATE ${t} SET doc = $3 WHERE collection = $1 AND id = $2 RETURNING id, doc`, [collection, id, JSON.stringify(doc)]);
      if (!rows.length) throw new Error('restep-server/pg: update of a row that is gone; was it read with ctx.forUpdate?');
      return item(rows[0]);
    },
    async delete(id, ctx) {
      const { rowCount } = await needTransaction('delete', ctx).query(`DELETE FROM ${t} WHERE collection = $1 AND id = $2`, [collection, id]);
      if (rowCount !== 1) throw new Error('restep-server/pg: delete of a row that is gone; was it read with ctx.forUpdate?');
    },
  };
}
