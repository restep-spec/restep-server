// Test server for pg.test.mjs: an operating system process with its own connection pool,
// against the temporary cluster. Several at once share the database.
//   PGHOST=<socket directory> PGPORT=5432x PORT=81xx node pg-worker.mjs
// Fault injection, only in this test file, with request headers:
//   x-test-delay: ms   waits inside the transaction: after inserting (POST) or before writing (PATCH, DELETE)
//   x-test-fault: throw-after-create   the adapter inserts and then throws (rollback)
//                 kill-before-commit   SIGKILL to this process right before sending COMMIT
//                 kill-after-commit    SIGKILL right after receiving the COMMIT confirmation
//                 lose-commit-ack      the COMMIT reaches PostgreSQL and is confirmed, but the response
//                                      is lost: a socket proxy cuts the connection
import { createServer as createNet, connect } from 'node:net';
import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { createRestep, toNodeListener } from './restep-server.mjs';
import { pgTransaction, pgIdempotencyStore, pgDocumentAdapter } from './pg.mjs';

const { PGHOST, PGPORT, PORT } = process.env;
const request = new AsyncLocalStorage();
const fault = () => request.getStore()?.headers.get('x-test-fault') ?? null;
const delay = () => Number(request.getStore()?.headers.get('x-test-delay') ?? 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Unix socket proxy in front of PostgreSQL: transparent except when armed to lose the
// response of a COMMIT (the server processes it; the client never receives the confirmation).
// Inside the cluster directory: it is deleted with it even if this process dies with SIGKILL.
const proxyDir = mkdtempSync(join(PGHOST, 'px-'));
let armed = false;
createNet((client) => {
  const server = connect(join(PGHOST, `.s.PGSQL.${PGPORT}`));
  let doomed = false;
  client.on('data', (d) => { if (armed && d.includes('COMMIT')) { armed = false; doomed = true; } server.write(d); });
  server.on('data', (d) => { if (doomed) { client.destroy(); server.destroy(); } else client.write(d); });
  client.on('close', () => server.destroy()); server.on('close', () => client.destroy());
  client.on('error', () => {}); server.on('error', () => {});
}).listen(join(proxyDir, `.s.PGSQL.${PGPORT}`));
process.on('exit', () => rmSync(proxyDir, { recursive: true, force: true }));

const real = new pg.Pool({ host: proxyDir, port: Number(PGPORT), user: 'postgres', database: 'postgres', max: 8 });
real.on('error', () => {}); // idle connections that drop when PostgreSQL restarts
// The same pool, with the faults around the COMMIT that pgTransaction sends.
const pool = {
  query: (...args) => real.query(...args),
  async connect() {
    const client = await real.connect();
    return new Proxy(client, { get(target, prop) {
      if (prop !== 'query') return typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop];
      return async (text, ...rest) => {
        if (text !== 'COMMIT') return target.query(text, ...rest);
        const f = fault();
        if (f === 'kill-before-commit') process.kill(process.pid, 'SIGKILL');
        if (f === 'lose-commit-ack') armed = true;
        const result = await target.query(text, ...rest);
        if (f === 'kill-after-commit') process.kill(process.pid, 'SIGKILL');
        return result;
      };
    } });
  },
};

const data = (collection) => {
  const base = pgDocumentAdapter({ pool, collection });
  return {
    ...base,
    async create(row, ctx) {
      const created = await base.create(row, ctx);
      if (delay()) await sleep(delay());
      if (fault() === 'throw-after-create') throw new Error('injected: connection lost after insert');
      return created;
    },
    async update(id, row, ctx) { if (delay()) await sleep(delay()); return base.update(id, row, ctx); },
    async delete(id, ctx) { if (delay()) await sleep(delay()); return base.delete(id, ctx); },
  };
};

// alice-1 and alice-2 are two tokens of the same principal (a renewed credential).
const principals = { 'alice-1': 'alice', 'alice-2': 'alice', bob: 'bob' };
const api = createRestep({
  collections: {
    books: { fields: { title: { type: 'string', required: true }, copies: { type: 'integer' } }, data: data('books') },
    authors: { fields: { name: { type: 'string', required: true } }, data: data('authors') },
  },
  authenticate: (req) => principals[/^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1]] ?? null,
  createTransaction: pgTransaction(pool),
  idempotencyStore: pgIdempotencyStore(),
  secret: 'pg-test',
  onError: (e) => process.stderr.write(`[worker ${PORT}] ${e.message}\n`),
});
const listener = toNodeListener(api);
createServer((req, res) => {
  const headers = new Headers(Object.entries(req.headers).filter(([k]) => k.startsWith('x-test-')));
  request.run({ headers }, () => listener(req, res));
}).listen(Number(PORT), 'localhost', () => process.stdout.write('ready\n'));
