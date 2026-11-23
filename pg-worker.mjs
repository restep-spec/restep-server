// Servidor de prueba para pg.test.mjs: un proceso del sistema operativo con su propio pool de
// conexiones, contra el clúster temporal. Varios a la vez comparten la base de datos.
//   PGHOST=<directorio del socket> PGPORT=5432x PORT=81xx node pg-worker.mjs
// Inyección de fallos, solo en este archivo de pruebas, con cabeceras de la petición:
//   x-test-delay: ms   espera dentro de la transacción: tras insertar (POST) o antes de escribir (PATCH, DELETE)
//   x-test-fault: throw-after-create   el adaptador inserta y luego lanza (rollback)
//                 kill-before-commit   SIGKILL a este proceso justo antes de enviar COMMIT
//                 kill-after-commit    SIGKILL justo después de recibir la confirmación del COMMIT
//                 lose-commit-ack      el COMMIT llega a PostgreSQL y se confirma, pero la respuesta
//                                      se pierde: un proxy de socket corta la conexión
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

// Proxy de socket Unix delante de PostgreSQL: transparente salvo cuando se arma para perder la
// respuesta de un COMMIT (el servidor lo procesa; el cliente nunca recibe la confirmación).
// Dentro del directorio del clúster: se borra con él aunque este proceso muera con SIGKILL.
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
real.on('error', () => {}); // conexiones inactivas que caen con un reinicio de PostgreSQL
// El mismo pool, con los fallos alrededor del COMMIT que envía pgTransaction.
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

// alice-1 y alice-2 son dos tokens del mismo principal (una credencial renovada).
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
