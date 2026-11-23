// Pruebas de restep-server. Desde restep/:  node tools/restep-server/test.mjs
// 1. El servidor de ejemplo pasa restep-check --writes con 0 fallos (sin y con oauth).
// 2. Pruebas directas de handle(Request): orden de errores, idempotencia, 428, idioma, base, adaptadores.
// Puertos: 8810-8819.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRestep, memoryAdapter, memorySingleton, toExpress, toHono, toNodeListener, RestepError } from './restep-server.mjs';
import { exampleApi } from './example.mjs';

const unit = process.argv.includes('--unit');
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
if (!unit) for (const [label, port, token] of [['sin credenciales', 8810, null], ['con oauth', 8811, 'secreto']]) {
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

await test('la tabla de opciones del README nombra cada opción de createRestep', async () => {
  const { readFileSync } = await import('node:fs');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, 'restep-server.mjs'), 'utf8');
  const block = src.match(/export function createRestep\(options\) \{\n  const \{([\s\S]*?)\} = options;/)[1];
  const names = [...block.matchAll(/(?:^|,)\s*([A-Za-z]+)\s*(?=[:=,]|$)/gm)].map((m) => m[1]);
  const readme = readFileSync(join(here, 'README.md'), 'utf8');
  const missing = names.filter((n) => !new RegExp(`^\\|[^|\\n]*\`${n}\``, 'm').test(readme));
  assert.ok(names.length > 15 && names.includes('version'), `no se leyeron las opciones: ${names}`);
  assert.deepEqual(missing, [], `faltan en el README: ${missing.join(', ')}`);
});
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
await test('filtros con nombre: interruptor, con valor, sin operadores y con Y (6.1)', async () => {
  const doc = await (await req('GET', '/')).json();
  assert.deepEqual(Object.keys(doc.collections.books.named_filters), ['bargain', 'search']);
  assert.equal(doc.collections.books.named_filters.search.type, 'string');
  assert.equal(doc.collections.books.named_filters.bargain.type, undefined);
  const ids = async (q) => (await (await req('GET', `/books?${q}`)).json()).items.map((x) => x.id);
  assert.deepEqual(await ids('filter[bargain]'), ['15', '30']);
  assert.deepEqual(await ids('filter[bargain]='), ['15', '30']);
  assert.deepEqual(await ids('filter[search]=NIEBLA&sort=id'), ['50', '7']);
  assert.deepEqual(await ids('filter[bargain]&filter[category]=poesia'), ['30']);
  assert.equal((await problem(await req('GET', '/books?filter[bargain]=true'), 400, 'invalid_parameter')).parameter, 'filter[bargain]');
  await problem(await req('GET', '/books?filter[search]='), 400, 'invalid_parameter');
  assert.equal((await problem(await req('GET', '/books?filter[search][eq]=x'), 400, 'unsupported_parameter')).parameter, 'filter[search][eq]');
  await problem(await req('GET', '/books?filter[bargain]&filter[bargain]'), 400, 'invalid_parameter');
  assert.throws(() => createRestep({ collections: { x: { data: memoryAdapter([]), fields: { a: { type: 'string' } }, filter: { a: ['eq'] },
    namedFilters: { a: { description: 'x' } } } } }), /ya es una clave de filter/);
  assert.throws(() => createRestep({ collections: { x: { data: memoryAdapter([]), namedFilters: { b: {} } } } }), /necesita description/);
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
await test('idempotencia: repetición, discrepancia y petición en curso (409 request_in_progress)', async () => {
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
  const busy = await send();
  await problem(busy, 409, 'request_in_progress');
  assert.match(busy.headers.get('retry-after'), /^\d+$/);
  // Otro cuerpo con la misma clave mientras la primera sigue en curso: 422, no 409.
  const other = await slow.handle(new Request('http://x/notes', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': '"s"' }, body: '{"text":"b"}' }));
  await problem(other, 422, 'idempotency_mismatch');
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
await test('formulario (4.3): title, default, labels y orden en create; el POST aplica los default', async () => {
  const doc = await (await req('GET', '/', { headers: { 'accept-language': 'es' } })).json();
  const create = doc.collections.books.schemas.create;
  assert.deepEqual(Object.keys(create.properties).slice(0, 3), ['title', 'price', 'category']);
  assert.equal(create.properties.title.title, 'Título');
  assert.equal(create.properties.category.default, 'novela-negra');
  assert.deepEqual(create.properties.category.anyOf[0].oneOf[1], { const: 'ciencia-ficcion', title: 'Ciencia ficción' });
  assert.equal(create.properties.signed.default, false);
  assert.ok(!('default' in doc.collections.books.schemas.update.properties.category), 'default no va en update');
  const r = await req('POST', '/books', { body: { title: 'Sin categoría', price: '5.00' } });
  assert.equal(r.status, 201);
  const item = await r.json();
  assert.equal(item.category, 'novela-negra');
  assert.equal(item.signed, false);
  const withNull = await (await req('POST', '/books', { body: { title: 'Con null', price: '5.00', category: null } })).json();
  assert.ok(!('category' in withNull), 'null no es ausente: no toma el default');
  assert.throws(() => createRestep({ collections: { x: { fields: { n: { type: 'integer', default: 'uno' } }, data: memoryAdapter([]) } } }), /default/);
});
await test('acción new (11.1): GET /books:new da el cuerpo relleno y no crea nada', async () => {
  const doc = await (await req('GET', '/')).json();
  assert.ok(doc.extensions.includes('actions'));
  assert.deepEqual(doc.collections.books.actions.new, { ...doc.collections.books.actions.new, on: 'collection', safe: true, idempotent: true, method: 'GET' });
  assert.equal(doc.collections.products.actions, undefined);
  const before = (await (await req('GET', '/books?limit=50')).json()).items.length;
  for (const path of ['/books:new', '/books%3Anew']) {
    const r = await req('GET', path);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'private, no-store');
    const body = await r.json();
    assert.equal(body.category, 'novela-negra');
    assert.equal(body.published, new Date().toISOString().slice(0, 10));
  }
  assert.equal((await (await req('GET', '/books?limit=50')).json()).items.length, before);
  await problem(await req('POST', '/books:new', { body: {} }), 405, 'method_not_allowed');
  // 8: If-None-Match también en la acción (con *, o con su ETag).
  assert.equal((await req('GET', '/books:new', { headers: { 'if-none-match': '*' } })).status, 304);
  await problem(await req('GET', '/books:new?sort=title'), 400, 'unsupported_parameter');
  await problem(await req('GET', '/products:new'), 404, 'not_found');
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
await test('_etag en los elementos del listado (7.2): la ETag del GET del elemento, también con fields', async () => {
  const list = await (await req('GET', '/books?limit=3')).json();
  for (const it of list.items) {
    const r = await req('GET', `/books/${it.id}`);
    assert.equal(it._etag, r.headers.get('etag'));
  }
  const some = await (await req('GET', '/books?limit=3&fields=title')).json();
  assert.deepEqual(some.items.map((x) => x._etag), list.items.map((x) => x._etag));
  assert.deepEqual(Object.keys(some.items[0]).sort(), ['_etag', 'id', 'title']);
  // Se puede escribir con el _etag del listado sin leer el elemento.
  const w = await req('PATCH', `/books/${list.items[0].id}`, { body: { rating: 4.1 }, headers: { 'content-type': 'application/merge-patch+json', 'if-match': list.items[0]._etag } });
  assert.equal(w.status, 200);
  // Un elemento de solo lectura (sin update ni delete) no lo lleva.
  const ro = createRestep({ collections: { notes: { fields: { text: 'string' }, data: { list: memoryAdapter([{ id: '1', text: 'a' }]).list, get: memoryAdapter([{ id: '1', text: 'a' }]).get } } } });
  const items = (await (await ro.handle(new Request('http://x/notes'))).json()).items;
  assert.deepEqual(items, [{ id: '1', text: 'a' }]);
  // If-Match de un POST a la colección con la ETag de su GET.
  const tag = (await req('GET', '/books')).headers.get('etag');
  await problem(await req('POST', '/books', { body: { title: 'x', price: '1.00' }, headers: { 'if-match': '"otra"' } }), 412, 'precondition_failed');
  assert.equal((await req('POST', '/books', { body: { title: 'x', price: '1.00' }, headers: { 'if-match': tag } })).status, 201);
});
await test('CORS (5.8): cabeceras expuestas y Vary: Origin en toda respuesta con una lista de orígenes', async () => {
  const mk = (cors) => createRestep({ cors, collections: { notes: { fields: { text: 'string' }, data: memoryAdapter([{ id: '1', text: 'a' }]) } } });
  const fixed = mk({ origins: ['https://app.test'] });
  const get = (h) => fixed.handle(new Request('http://x/notes', { headers: h }));
  const ok = await get({ origin: 'https://app.test' });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://app.test');
  const expose = ok.headers.get('access-control-expose-headers').split(/,\s*/);
  for (const h of ['ETag', 'Location', 'Link', 'Allow', 'Accept-Patch', 'Accept-Query', 'Retry-After', 'Deprecation', 'Sunset', 'Idempotent-Replayed', 'Preference-Applied', 'DPoP-Nonce'])
    assert.ok(expose.includes(h), h);
  assert.match(ok.headers.get('vary'), /Origin/);
  for (const r of [await get({}), await get({ origin: 'https://otro.test' }), await fixed.handle(new Request('http://x/notes/nope', { headers: { origin: 'https://app.test' } }))]) {
    assert.match(r.headers.get('vary') ?? '', /\bOrigin\b/);
  }
  assert.equal((await get({ origin: 'https://otro.test' })).headers.get('access-control-allow-origin'), null);
  const pre = await fixed.handle(new Request('http://x/notes/nope', { method: 'OPTIONS', headers: { origin: 'https://app.test', 'access-control-request-method': 'PATCH', 'access-control-request-headers': 'content-type, if-match, prefer' } }));
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://app.test');
  assert.match(pre.headers.get('vary'), /Origin/);
  // Con cors: true (*) la respuesta no depende de Origin: sin Vary: Origin.
  const any = await mk(true).handle(new Request('http://x/notes', { headers: { origin: 'https://app.test' } }));
  assert.equal(any.headers.get('access-control-allow-origin'), '*');
  assert.doesNotMatch(any.headers.get('vary') ?? '', /Origin/);
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

// ── 2b. Borrador 6 ──
console.log('borrador 6');
const patchH = (h = {}) => ({ 'content-type': 'application/merge-patch+json', ...h });
await test('descubrimiento (1.1, 4.2, 8): 1.0-draft.6, cache, id_from, collations, singletons', async () => {
  const doc = await (await req('GET', '/')).json();
  assert.equal(doc.restep, '1.0-draft.6');
  assert.deepEqual(doc.profiles, ['core', 'query', 'writes', 'cache']);
  assert.equal(doc.collections.categories.id_from, 'either');
  assert.equal(doc.collections.books.id_from, undefined);
  assert.deepEqual(doc.collections.categories.collations, { name: 'server' });
  assert.equal(doc.collections.categories.schemas.create.properties.id.type, 'string');
  assert.deepEqual(doc.singletons.shop.methods, ['GET', 'PATCH']);
  assert.equal(doc.singletons.shop.path, '/shop');
  assert.deepEqual(doc.idempotency, { ttl: 86400 });
  for (const k of Object.keys(doc)) assert.ok(['restep', 'version', 'profiles', 'extensions', 'idempotency', 'status', 'collections', 'singletons'].includes(k), k);
  const cred = createRestep({ authenticate: () => 'ana', idempotencyAnonymous: false, collections: { notes: { fields: { text: 'string' }, data: memoryAdapter() } } });
  const d2 = await cred.handle(new Request('http://x/'));
  assert.deepEqual((await d2.json()).idempotency, { ttl: 86400, anonymous: false });
  assert.match(d2.headers.get('cache-control'), /private/); // depende de credenciales (5.1, 4.2)
});
await test('tipo de contenido (3): 415 sin Content-Type, con otro tipo o con otro charset; utf-8 entre comillas vale', async () => {
  const body = JSON.stringify({ title: 'x', price: '1.00' });
  for (const h of [{}, { 'content-type': 'text/plain' }, { 'content-type': 'application/x-www-form-urlencoded' }, { 'content-type': 'application/json; charset=latin1' }])
    await problem(await api.handle(new Request('http://api.test/books', { method: 'POST', headers: h, body })), 415, 'unsupported_media_type');
  await problem(await api.handle(new Request('http://api.test/books', { method: 'POST', headers: {}, body: '' })), 415, 'unsupported_media_type');
  await problem(await req('POST', '/books', { body: '' }), 400, 'bad_request');
  for (const ct of ['application/json; charset=UTF-8', 'Application/JSON; charset="utf-8"; x=1'])
    assert.equal((await req('POST', '/books', { body, headers: { 'content-type': ct } })).status, 201, ct);
  const p = await req('PATCH', '/books/7', { body: { rating: 4.6 }, headers: { 'content-type': 'application/merge-patch+json; charset=iso-8859-1' } });
  await problem(p, 415, 'unsupported_media_type');
  assert.equal(p.headers.get('accept-patch'), 'application/merge-patch+json');
});
await test('_etag (7.2): en el GET del elemento, el POST y el PATCH, igual a la ETag del elemento y calculado sin _etag', async () => {
  const g = await req('GET', '/books/12');
  const item = await g.json();
  assert.equal(item._etag, g.headers.get('etag'));
  assert.equal((await (await req('GET', '/books/12')).json())._etag, item._etag);
  const c = await req('POST', '/books', { body: { title: 'Con _etag', price: '2.00' } });
  const created = await c.json();
  assert.equal(created._etag, c.headers.get('etag'));
  const w = await req('PATCH', created.id && `/books/${created.id}`, { body: { ...created, rating: 3 }, headers: patchH({ 'if-match': created._etag }) });
  assert.equal(w.status, 200);
  const patched = await w.json();
  assert.equal(patched._etag, w.headers.get('etag'));
  assert.equal(patched._etag, (await req('GET', `/books/${created.id}`)).headers.get('etag'));
});
await test('PATCH sin cambios (5.1): no llama a update y deja la misma ETag', async () => {
  let updates = 0;
  const base = memoryAdapter([{ id: '1', text: 'a', when: '2026-01-01T10:00:00Z' }]);
  const x = createRestep({ collections: { notes: { fields: { text: 'string', when: 'datetime' }, data: { ...base, async update(...a) { updates++; return base.update(...a); } } } } });
  const r0 = await x.handle(new Request('http://x/notes/1'));
  const read = await r0.json();
  const r = await x.handle(new Request('http://x/notes/1', { method: 'PATCH', headers: patchH(), body: JSON.stringify(read) }));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('etag'), r0.headers.get('etag'));
  assert.equal(updates, 0);
  await x.handle(new Request('http://x/notes/1', { method: 'PATCH', headers: patchH(), body: '{"text":"b"}' }));
  assert.equal(updates, 1);
});
await test('Idempotency-Key (7.1): la query cuenta para «la misma petición», no para el destino; entrada en errors', async () => {
  const body = { title: 'Idem', price: '3.00' };
  const k = { 'idempotency-key': '"q-1"' };
  assert.equal((await req('POST', '/books?x=1', { body, headers: k })).status, 201);
  // El mismo destino tras decodificar la ruta (%62ooks es books) y la misma query en otro orden y otra codificación: repetición.
  const again = await req('POST', '/%62ooks?x=%31', { body, headers: k });
  assert.equal(again.headers.get('idempotent-replayed'), 'true');
  await problem(await req('POST', '/books?x=2', { body, headers: k }), 422, 'idempotency_mismatch');
  for (const bad of ['q-1', '"a";p=1', '"a" , "b"']) {
    const p = await problem(await req('POST', '/books', { body, headers: { 'idempotency-key': bad } }), 400, 'bad_request');
    assert.equal(p.errors[0].header, 'Idempotency-Key', bad);
  }
  // En PATCH se ignora.
  assert.equal((await req('PATCH', '/books/7', { body: {}, headers: patchH({ 'idempotency-key': 'mal' }) })).status, 200);
});
await test('idempotency.anonymous false (7.1): 400 con la clave sin credenciales, sin efecto; con credenciales, normal', async () => {
  const data = memoryAdapter();
  const x = createRestep({ idempotencyAnonymous: false, authenticate: (r) => r.headers.get('x-user'),
    collections: { notes: { fields: { text: 'string' }, requireIdempotencyKey: true, data } } });
  const post = (h, body = '{"text":"a"}') => x.handle(new Request('http://x/notes', { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body }));
  const p = await problem(await post({ 'idempotency-key': '"k"' }), 400, 'bad_request');
  assert.deepEqual([p.errors[0].header, p.errors[0].code], ['Idempotency-Key', 'unknown']);
  assert.equal(data.rows.size, 0);
  // Sin credenciales no se le exige la clave aunque el recurso la exija.
  assert.equal((await post({})).status, 201);
  // Con credenciales se exige y funciona.
  await problem(await post({ 'x-user': 'ana' }), 400, 'idempotency_key_required');
  assert.equal((await post({ 'x-user': 'ana', 'idempotency-key': '"k"' })).status, 201);
  assert.equal((await post({ 'x-user': 'ana', 'idempotency-key': '"k"' })).headers.get('idempotent-replayed'), 'true');
});
await test('id_from (5.1): either, client, formato, idPattern y taken (también el de un elemento borrado)', async () => {
  const ids = async (r) => (await r.json()).id;
  assert.equal(await ids(await req('POST', '/categories', { body: { id: 'cat-x', name: 'Mapas' } })), 'cat-x');
  assert.equal((await req('GET', '/categories/cat-x')).status, 200);
  const t1 = await problem(await req('POST', '/categories', { body: { id: 'cat-x', name: 'Otra' } }), 409, 'conflict');
  assert.deepEqual([t1.errors[0].pointer, t1.errors[0].code], ['/id', 'taken']);
  assert.equal((await req('DELETE', '/categories/cat-x')).status, 204);
  await problem(await req('POST', '/categories', { body: { id: 'cat-x', name: 'Vuelve' } }), 409, 'conflict');
  for (const [id, code] of [[7, 'type'], ['a b', 'format'], ['..', 'format'], ['', 'format']]) {
    const p = await problem(await req('POST', '/categories', { body: { id, name: 'Mal' } }), 422, 'invalid');
    assert.deepEqual([p.errors[0].pointer, p.errors[0].code], ['/id', code], String(id));
  }
  // Sin id, el servidor asigna uno que la colección no ha tenido.
  assert.ok(!['1', '2', '3', '4', '5', 'cat-x'].includes(await ids(await req('POST', '/categories', { body: { name: 'Sin id' } }))));
  const strict = createRestep({ collections: { tags: { idFrom: 'client', idPattern: '^[0-9a-f]{8}$', fields: { label: 'string' }, data: memoryAdapter() } } });
  const post = (b) => strict.handle(new Request('http://x/tags', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }));
  const r = await problem(await post({ label: 'x' }), 422, 'invalid');
  assert.deepEqual([r.errors[0].pointer, r.errors[0].code], ['/id', 'required']);
  assert.equal((await problem(await post({ id: 'zzzzzzzz' }), 422, 'invalid')).errors[0].code, 'format');
  assert.equal((await post({ id: '0123abcd' })).status, 201);
  const doc = await (await strict.handle(new Request('http://x/'))).json();
  assert.deepEqual(doc.collections.tags.schemas.create.required, ['id']);
  assert.throws(() => createRestep({ collections: { t: { idFrom: 'client', data: { list() {}, get() {}, create() {} } } } }), /taken/);
  assert.throws(() => createRestep({ collections: { t: { idFrom: 'nadie', data: memoryAdapter() } } }), /idFrom/);
});
await test('rutas (3): segmentos comparados tras decodificar; un id distinto no responde', async () => {
  assert.equal((await (await req('GET', '/books/%37')).json()).id, '7');
  await problem(await req('GET', '/books/07'), 404, 'not_found');
  assert.equal((await req('GET', '/%62ooks/7')).status, 200);
  await problem(await req('GET', '/books/7%2Fx'), 404, 'not_found');
  // Un adaptador que devuelve otro id (07 por 7) no hace que /books/07 responda.
  const loose = memoryAdapter([{ id: '7', text: 'a' }]);
  const x = createRestep({ collections: { notes: { fields: { text: 'string' }, data: { ...loose, get: (id) => loose.get(String(Number(id))) } } } });
  await problem(await x.handle(new Request('http://x/notes/07')), 404, 'not_found');
});
await test('+ es un espacio en la query (5.2) y collations "server" (6.1)', async () => {
  const ids = async (q) => (await (await req('GET', `/categories?${q}`)).json()).items.map((x) => x.id);
  assert.deepEqual(await ids('filter[name]=Material+escolar'), ['3']);
  assert.deepEqual(await ids('filter[name]=Material%20escolar'), ['3']);
  assert.deepEqual(await ids('filter[name]=libros'), ['2']); // sin distinguir mayúsculas
  assert.deepEqual(await ids('filter[name]=LAMPARAS'), ['5']); // ni acentos
  const names = (await (await req('GET', '/categories?sort=name&limit=5')).json()).items.map((x) => x.name);
  assert.deepEqual(names.slice(0, 3), ['Lámparas', 'Libros', 'Libros infantiles']);
  assert.throws(() => createRestep({ collections: { a: { fields: { n: 'integer' }, filter: { n: ['eq'] }, collations: { n: 'server' }, data: memoryAdapter() } } }), /collations/);
  assert.throws(() => createRestep({ collections: { a: { filter: { id: ['eq'] }, collations: { id: 'server' }, data: memoryAdapter() } } }), /collations/);
  assert.throws(() => createRestep({ collections: { a: { fields: { s: 'string' }, filter: { s: ['eq'] }, collations: { s: 'es-u-co-trad' }, data: memoryAdapter() } } }), /collations/);
});
await test('relaciones (5.1): entrada unknown en /rel/id; con su valor actual se ignora sin comprobarla', async () => {
  const p = await problem(await req('PATCH', '/products/2', { body: { category: { id: 'nadie' } }, headers: patchH() }), 422, 'invalid');
  assert.deepEqual([p.errors[0].pointer, p.errors[0].code], ['/category/id', 'unknown']);
  // products/5 enlaza a la categoría 5; aunque desaparezca, devolverla tal cual no falla.
  const cats = memoryAdapter([{ id: '1', name: 'a' }]);
  const x = createRestep({ collections: { cats: { fields: { name: 'string' }, data: cats },
    things: { fields: { cat: { type: 'relation', to: 'cats' }, n: 'integer' }, data: memoryAdapter([{ id: '1', cat: { id: '1' }, n: 1 }]) } } });
  cats.rows.delete('1');
  const r = await x.handle(new Request('http://x/things/1', { method: 'PATCH', headers: patchH(), body: '{"cat":{"id":"1","extra":true},"n":2}' }));
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).cat, { id: '1' });
});
await test('singletons (5.9): GET con href y _etag, fields, 405, PATCH con If-Match y sin cambios', async () => {
  const g = await req('GET', '/shop');
  const shop = await g.json();
  assert.deepEqual(shop.featured, { id: '2', href: '/categories/2' });
  assert.equal(shop._etag, g.headers.get('etag'));
  assert.ok(!('id' in shop));
  assert.equal(g.headers.get('cache-control'), 'no-cache');
  assert.deepEqual(Object.keys(await (await req('GET', '/shop?fields=city')).json()).sort(), ['_etag', 'city']);
  await problem(await req('GET', '/shop?include=featured'), 400, 'unsupported_parameter');
  for (const m of ['POST', 'DELETE']) {
    const r = await req(m, '/shop', m === 'POST' ? { body: {} } : {});
    await problem(r, 405, 'method_not_allowed');
    assert.equal(r.headers.get('allow'), 'GET, PATCH, HEAD');
  }
  assert.equal((await req('HEAD', '/shop')).status, 200);
  await problem(await req('PATCH', '/shop', { body: { city: 'Getxo' }, headers: patchH({ 'if-match': '"vieja"' }) }), 412, 'precondition_failed');
  const same = await req('PATCH', '/shop', { body: shop, headers: patchH({ 'if-match': shop._etag }) });
  assert.equal(same.headers.get('etag'), shop._etag);
  const w = await req('PATCH', '/shop', { body: { city: 'Getxo', featured: { href: '/categories/4', id: '4' } }, headers: patchH({ 'if-match': shop._etag }) });
  assert.equal(w.status, 200);
  const after = await w.json();
  assert.deepEqual([after.city, after.featured.href], ['Getxo', '/categories/4']);
  await problem(await req('PATCH', '/shop', { body: { name: null }, headers: patchH() }), 422, 'invalid');
  await problem(await req('PATCH', '/shop', { body: { featured: { id: 'nadie' } }, headers: patchH() }), 422, 'invalid');
  assert.equal((await req('GET', '/shop', { headers: { 'if-none-match': after._etag } })).status, 304);
  assert.throws(() => createRestep({ collections: { books: { data: memoryAdapter() } }, singletons: { featured: { path: '/books/featured', data: memorySingleton() } } }), /choca/);
});
await test('gramática de los nombres (3, 5.4): se rechaza al arrancar; un reason mal formado da 500', async () => {
  assert.throws(() => createRestep({ collections: { a: { fields: { 'mal nombre': 'string' }, data: memoryAdapter() } } }), /gramática/);
  assert.throws(() => createRestep({ collections: { '1a': { data: memoryAdapter() } } }), /gramática/);
  assert.throws(() => createRestep({ collections: { a: { namedFilters: { 'con.punto': { description: 'x' } }, data: memoryAdapter() } } }), /gramática/);
  assert.throws(() => createRestep({ collections: { a: { fields: { ['x'.repeat(65)]: 'string' }, data: memoryAdapter() } } }), /gramática/);
  assert.throws(() => createRestep({ collections: { a: { filter: { id: ['lt'] }, data: memoryAdapter() } } }), /sin lt/);
  const x = createRestep({ onError: () => {}, collections: { notes: { data: { ...memoryAdapter(), async list() { throw new RestepError(409, 'conflict', 'x', { reason: 'no vale' }); } } } } });
  await problem(await x.handle(new Request('http://x/notes')), 500, 'internal');
});
await test('Origin (5.8): una escritura con cookie desde otro origen da 403 sin efecto', async () => {
  const data = memoryAdapter([{ id: '1', text: 'a' }]);
  const mk = (opts = {}) => createRestep({ authenticate: (r) => (/sesion=ana/.test(r.headers.get('cookie') ?? '') ? 'ana' : null),
    cors: { origins: ['https://app.test'] }, collections: { notes: { fields: { text: 'string' }, data } }, ...opts });
  const x = mk();
  const send = (method, path, h) => x.handle(new Request(`http://api.test${path}`, { method, headers: { cookie: 'sesion=ana', ...(method !== 'DELETE' && { 'content-type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json' }), ...h },
    body: method === 'DELETE' ? undefined : '{"text":"z"}' }));
  for (const [m, p] of [['POST', '/notes'], ['PATCH', '/notes/1'], ['DELETE', '/notes/1']]) {
    await problem(await send(m, p, { origin: 'https://evil.test' }), 403, 'forbidden');
    await problem(await send(m, p, { 'sec-fetch-site': 'cross-site' }), 403, 'forbidden');
    await problem(await send(m, p, { origin: 'null' }), 403, 'forbidden');
  }
  assert.deepEqual([...data.rows.keys()], ['1']);
  assert.equal(data.rows.get('1').text, 'a');
  assert.equal((await send('PATCH', '/notes/1', { origin: 'http://api.test' })).status, 200);
  assert.equal((await send('PATCH', '/notes/1', { origin: 'https://app.test' })).status, 200);
  assert.equal((await send('PATCH', '/notes/1', { origin: 'null', 'sec-fetch-site': 'same-origin' })).status, 200);
  assert.equal((await send('POST', '/notes', {})).status, 201); // sin Origin ni Sec-Fetch-Site: no es de un navegador
  assert.equal((await x.handle(new Request('http://api.test/notes', { headers: { cookie: 'sesion=ana', origin: 'https://evil.test' } }))).status, 200); // GET: seguro
  // Sin credenciales, o con browserCredentials: false (solo tokens en Authorization), no se comprueba.
  const anon = await x.handle(new Request('http://api.test/notes', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.test' }, body: '{}' }));
  assert.equal(anon.status, 201);
  const off = mk({ browserCredentials: false });
  assert.equal((await off.handle(new Request('http://api.test/notes/1', { method: 'PATCH', headers: { cookie: 'sesion=ana', origin: 'https://evil.test', 'content-type': 'application/json' }, body: '{}' }))).status, 200);
});

// ── 3. Adaptadores de framework ──
console.log('adaptadores');
if (!unit) await test('Express: con un body parser que ya consumió el cuerpo y montado bajo /api', async () => {
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
    assert.deepEqual(l.items.map(({ _etag, ...x }) => x), [{ id: '1', text: 'hola' }]);
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
