// Pruebas de restep-server. Desde restep/:  node tools/restep-server/test.mjs
// 1. El servidor de ejemplo pasa restep-check --writes con 0 fallos (sin y con oauth).
// 2. Pruebas directas de handle(Request): orden de errores, idempotencia, 428, idioma, base, adaptadores.
// Puertos: 8810-8819.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRestep, memoryAdapter, toExpress, toHono, toNodeListener, RestepError } from './restep-server.mjs';
import { exampleApi } from './example.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const checker = join(here, 'vendor/restep-check.mjs');
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failed++; console.log(`  FALLA ${name}\n        ${e.stack.split('\n').slice(0, 3).join('\n        ')}`); }
}
const run = (cmd, args, env = {}) => new Promise((resolve) => {
  const p = spawn(cmd, args, { env: { ...process.env, ...env } });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('close', (code) => resolve({ code, out }));
});
const listen = (handler, port) => new Promise((resolve) => { const s = createServer(handler).listen(port, () => resolve(s)); });

// ── 1. restep-check contra el ejemplo ──
console.log('restep-check contra el servidor de ejemplo');
for (const [label, port, token] of [['sin credenciales', 8810, null], ['con oauth', 8811, 'secreto']]) {
  await test(`restep-check --writes, ${label}, 0 fallos`, async () => {
    const server = await listen(toNodeListener(exampleApi({ token })), port);
    try {
      const r = await run(process.execPath, [checker, `http://localhost:${port}/`, '--writes', ...(token ? ['-H', `Authorization: Bearer ${token}`] : [])]);
      const summary = r.out.trim().split('\n').at(-1);
      console.log(`        ${summary}`);
      assert.equal(r.code, 0, r.out);
      assert.match(summary, /^0 failed · 0 warnings/);
    } finally { server.close(); }
  });
}

// ── 2. handle(Request) directamente ──
console.log('handle(Request)');
const api = exampleApi({ token: null });
const req = (method, path, { body, headers = {} } = {}) => api.handle(new Request(`http://api.test${path}`, {
  method, headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
  body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
}));
const problem = async (r, status, code) => {
  assert.equal(r.status, status);
  assert.equal(r.headers.get('content-type'), 'application/problem+json');
  const p = await r.json();
  assert.equal(p.code, code);
  return p;
};

await test('404 va antes que 405 y que 400 (5.4)', async () => {
  await problem(await req('PUT', '/books/nope?filter[x]=1'), 404, 'not_found');
  const r = await req('PUT', '/books/7?filter[x]=1');
  await problem(r, 405, 'method_not_allowed');
  assert.equal(r.headers.get('allow'), 'GET, PATCH, DELETE, HEAD');
});
await test('un parámetro reservado en un POST da unsupported_parameter antes que 415', async () => {
  const p = await problem(await req('POST', '/books?sort=title', { body: 'x', headers: { 'content-type': 'text/plain' } }), 400, 'unsupported_parameter');
  assert.equal(p.parameter, 'sort');
});
await test('400 por cuerpo no JSON va antes que 412 (5.4)', async () => {
  await problem(await req('PATCH', '/books/7', { body: '{', headers: { 'content-type': 'application/merge-patch+json', 'if-match': '"viejo"' } }), 400, 'bad_request');
});
await test('filtros: tipos, operadores y repetidos', async () => {
  assert.equal((await problem(await req('GET', '/books?filter[price][le]=abc'), 400, 'invalid_parameter')).parameter, 'filter[price][le]');
  assert.equal((await problem(await req('GET', '/books?filter[title]=x'), 400, 'unsupported_parameter')).parameter, 'filter[title]');
  await problem(await req('GET', '/books?filter[reading_time][le]=P1Y'), 400, 'invalid_parameter');
  await problem(await req('GET', '/books?filter[category]=poesia&filter[category][eq]=poesia'), 400, 'invalid_parameter');
  await problem(await req('GET', '/books?$top=1'), 400, 'unsupported_parameter');
  const r = await (await req('GET', '/books?filter[reading_time][gt]=PT23H&filter[published][ge]=2022-01-01')).json();
  assert.deepEqual(r.items.map((x) => x.id), ['15']);
  const d = await (await req('GET', '/books?filter[price][lt]=10')).json(); // 9.00 < 10 aunque como texto no lo sea
  assert.deepEqual(d.items.map((x) => x.id), ['30']);
});
await test('paginación: next con cursor firmado, ligado a filtros y orden', async () => {
  const p1 = await (await req('GET', '/books?limit=2&sort=-price')).json();
  assert.equal(p1.items.length, 2);
  assert.match(p1.next, /^\/books\?limit=2&sort=-price&cursor=/);
  const p2 = await req('GET', p1.next.replace('limit=2', 'limit=3'));
  assert.equal(p2.status, 200);
  const other = await req('GET', p1.next.replace('sort=-price', 'sort=price'));
  assert.equal((await problem(other, 400, 'invalid_parameter')).parameter, 'cursor');
});
await test('idempotencia: repetición, discrepancia y petición en curso (409)', async () => {
  const body = { title: 'Nuevo', price: '10.00' };
  const k = { 'idempotency-key': '"k-1"' };
  const a = await req('POST', '/books', { body, headers: k });
  assert.equal(a.status, 201);
  const b = await req('POST', '/books', { body: { price: '10.00', title: 'Nuevo' }, headers: k });
  assert.equal(b.headers.get('idempotent-replayed'), 'true');
  assert.equal(b.headers.get('location'), a.headers.get('location'));
  await problem(await req('POST', '/books', { body: { ...body, title: 'Otro' }, headers: k }), 422, 'idempotency_mismatch');
  // Un adaptador lento: la misma petición mientras la primera sigue en curso da 409.
  let finish;
  const slow = createRestep({ collections: { notes: { fields: { text: 'string' }, data: {
    ...memoryAdapter(), async create(d) { await new Promise((r) => { finish = r; }); return { id: '1', ...d }; },
  } } } });
  const send = () => slow.handle(new Request('http://x/notes', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': '"s"' }, body: '{"text":"a"}' }));
  const first = send();
  await new Promise((r) => setTimeout(r, 20));
  await problem(await send(), 409, 'conflict');
  finish();
  assert.equal((await first).status, 201);
});
await test('validación: 422 con errors y pointer', async () => {
  const p = await problem(await req('POST', '/books', { body: { price: 3, category: 'x', nope: 1 } }), 422, 'invalid');
  const got = p.errors.map((e) => `${e.pointer} ${e.code}`).sort();
  assert.deepEqual(got, ['/category format', '/nope unknown', '/price type', '/title required']);
  const q = await problem(await req('PATCH', '/products/1', { body: { category: { id: '999' } }, headers: { 'content-type': 'application/merge-patch+json' } }), 422, 'invalid');
  assert.equal(q.errors[0].code, 'unknown');
  const cyc = await problem(await req('PATCH', '/categories/1', { body: { parent: { id: '3' } }, headers: { 'content-type': 'application/merge-patch+json' } }), 422, 'invalid');
  assert.equal(cyc.errors[0].code, 'cycle');
});
await test('idioma (5.6): textos de error en español, datos iguales', async () => {
  const r = await req('GET', '/books/nope', { headers: { 'accept-language': 'es-ES, en;q=0.5' } });
  const p = await problem(r, 404, 'not_found');
  assert.equal(p.title, 'No encontrado');
  assert.equal(r.headers.get('content-language'), 'es');
  assert.match(r.headers.get('vary'), /Accept-Language/);
  const d = await (await req('GET', '/', { headers: { 'accept-language': 'es' } })).json();
  assert.equal(d.collections.books.description, 'Libros del catálogo de El Marcapáginas, uno por edición.');
});
await test('caché: Cache-Groups en lecturas y Cache-Group-Invalidation en escrituras', async () => {
  const r = await req('GET', '/books?limit=2&sort=-price');
  assert.equal(r.headers.get('cache-groups'), '"/books", "/books/23", "/books/21"');
  const w = await req('PATCH', '/books/7', { body: { rating: 4.7 }, headers: { 'content-type': 'application/merge-patch+json' } });
  assert.equal(w.status, 200);
  assert.equal(w.headers.get('cache-group-invalidation'), '"/books", "/books/7"');
});
await test('428 cuando la colección exige If-Match', async () => {
  const strict = createRestep({ collections: { notes: { fields: { text: 'string' }, requireIfMatch: true, data: memoryAdapter([{ id: '1', text: 'a' }]) } } });
  const r = await strict.handle(new Request('http://x/notes/1', { method: 'DELETE' }));
  await problem(r, 428, 'precondition_required');
});
await test('base /api: enlaces, Location y descubrimiento bajo la raíz', async () => {
  const sub = createRestep({ base: '/api', collections: { notes: { fields: { text: 'string' }, defaultLimit: 1, data: memoryAdapter([{ id: '1', text: 'a' }, { id: '2', text: 'b' }]) } } });
  const page = await (await sub.handle(new Request('http://x/api/notes'))).json();
  assert.match(page.next, /^\/api\/notes\?cursor=/);
  assert.equal((await sub.handle(new Request('http://x/api/'))).status, 200);
  assert.equal((await sub.handle(new Request('http://x/notes'))).status, 404);
  const c = await sub.handle(new Request('http://x/api/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"c"}' }));
  assert.equal(c.headers.get('location'), '/api/notes/3');
});
await test('un adaptador puede lanzar RestepError (409) y un fallo cualquiera da 500 internal', async () => {
  const x = createRestep({ onError: () => {}, collections: { notes: { fields: { text: 'string' }, data: {
    ...memoryAdapter([{ id: '1' }]),
    async create() { throw new RestepError(409, 'conflict', 'Ya existe.', { reason: 'duplicate' }); },
    async list() { throw new Error('la base de datos no responde'); },
  } } } });
  const p = await problem(await x.handle(new Request('http://x/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })), 409, 'conflict');
  assert.equal(p.reason, 'duplicate');
  await problem(await x.handle(new Request('http://x/notes')), 500, 'internal');
});
await test('configuración errónea: mensajes claros al crear', async () => {
  assert.throws(() => createRestep({ collections: { a: { fields: { ok: 'boolean' }, filter: { ok: ['lt'] }, data: memoryAdapter() } } }), /boolean solo admite/);
  assert.throws(() => createRestep({ collections: { a: { fields: { name: 'map' }, filter: { name: ['eq'] }, data: memoryAdapter() } } }), /campo\.etiqueta/);
  assert.throws(() => createRestep({ collections: { a: { fields: {} } } }), /adaptador con list y get/);
});

// ── 3. Adaptadores de framework ──
console.log('adaptadores');
await test('Express: con un body parser que ya consumió el cuerpo y montado bajo /api', async () => {
  const handler = toExpress(createRestep({ base: '/api', collections: { notes: { fields: { text: 'string' }, data: memoryAdapter() } } }));
  // Simula express.json() y el montaje app.use('/api', ...): req.url pierde /api, originalUrl lo conserva.
  const server = await listen(async (req, res) => {
    req.originalUrl = req.url;
    req.url = req.url.replace(/^\/api/, '') || '/';
    if (req.method === 'POST') { let s = ''; for await (const c of req) s += c; req.body = JSON.parse(s); }
    handler(req, res, (e) => { res.writeHead(500); res.end(String(e)); });
  }, 8813);
  try {
    const r = await fetch('http://localhost:8813/api/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"hola"}' });
    assert.equal(r.status, 201);
    assert.equal(r.headers.get('location'), '/api/notes/1');
    const l = await (await fetch('http://localhost:8813/api/notes')).json();
    assert.deepEqual(l.items, [{ id: '1', text: 'hola' }]);
  } finally { server.close(); }
});
await test('Hono: el handler recibe c.req.raw', async () => {
  const h = toHono(api);
  const r = await h({ req: { raw: new Request('http://api.test/books/7') } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).id, '7');
});

console.log(`\n${failed ? 'FALLAN' : 'Todo bien'}: ${passed} pasan, ${failed} fallan`);
process.exit(failed ? 1 : 0);
