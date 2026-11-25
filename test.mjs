// restep-server tests. From restep/:  node tools/restep-server/test.mjs
// 1. The example server passes restep-check --writes with 0 failures (without and with oauth).
// 2. Direct tests of handle(Request): error order, idempotency, 428, language, base, adapters.
// Ports: free random ones (listen on 0).
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
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.stack.split('\n').slice(0, 3).join('\n        ')}`); }
}
const run = (cmd, args, env = {}) => new Promise((resolve) => {
  const p = spawn(cmd, args, { env: { ...process.env, ...env } });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('close', (code) => resolve({ code, out }));
});
const listen = (handler, port = 0) => new Promise((resolve) => { const s = createServer(handler).listen(port, () => resolve(s)); });

// ── 1. restep-check against the example ──
console.log('restep-check against the example server');
if (!unit) for (const [label, token] of [['without credentials', null], ['with oauth', 'secreto']]) {
  await test(`restep-check --writes, ${label}, 0 failed`, async () => {
    const server = await listen(toNodeListener(exampleApi({ token })));
    const port = server.address().port;
    try {
      const r = await run(process.execPath, [checker, `http://localhost:${port}/`, '--writes', ...(token ? ['-H', `Authorization: Bearer ${token}`] : [])]);
      const summary = r.out.trim().split('\n').at(-1);
      console.log(`        ${summary}`);
      assert.equal(r.code, 0, r.out);
      assert.match(summary, /^0 failed · 0 warnings/);
    } finally { server.close(); }
  });
}

// ── 2. handle(Request) directly ──
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

await test('the README options table names every createRestep option', async () => {
  const { readFileSync } = await import('node:fs');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, 'restep-server.mjs'), 'utf8');
  const block = src.match(/export function createRestep\(options\) \{\n  const \{([\s\S]*?)\} = options;/)[1];
  const names = [...block.matchAll(/(?:^|,)\s*([A-Za-z]+)\s*(?=[:=,]|$)/gm)].map((m) => m[1]);
  const readme = readFileSync(join(here, 'README.md'), 'utf8');
  const missing = names.filter((n) => !new RegExp(`^\\|[^|\\n]*\`${n}\``, 'm').test(readme));
  assert.ok(names.length > 15 && names.includes('version'), `the options were not read: ${names}`);
  assert.deepEqual(missing, [], `missing from the README: ${missing.join(', ')}`);
});
await test('404 comes before 405 and 400 (5.4)', async () => {
  await problem(await req('PUT', '/books/nope?filter[x]=1'), 404, 'not_found');
  const r = await req('PUT', '/books/7?filter[x]=1');
  await problem(r, 405, 'method_not_allowed');
  assert.equal(r.headers.get('allow'), 'GET, PATCH, DELETE, HEAD');
});
await test('a reserved parameter on a POST gives unsupported_parameter before 415', async () => {
  const p = await problem(await req('POST', '/books?sort=title', { body: 'x', headers: { 'content-type': 'text/plain' } }), 400, 'unsupported_parameter');
  assert.equal(p.parameter, 'sort');
});
await test('400 for a non-JSON body comes before 412 (5.4)', async () => {
  await problem(await req('PATCH', '/books/7', { body: '{', headers: { 'content-type': 'application/merge-patch+json', 'if-match': '"viejo"' } }), 400, 'bad_request');
});
await test('filters: types, operators and repeats', async () => {
  assert.equal((await problem(await req('GET', '/books?filter[price][le]=abc'), 400, 'invalid_parameter')).parameter, 'filter[price][le]');
  assert.equal((await problem(await req('GET', '/books?filter[title]=x'), 400, 'unsupported_parameter')).parameter, 'filter[title]');
  await problem(await req('GET', '/books?filter[reading_time][le]=P1Y'), 400, 'invalid_parameter');
  await problem(await req('GET', '/books?filter[category]=poesia&filter[category][eq]=poesia'), 400, 'invalid_parameter');
  await problem(await req('GET', '/books?$top=1'), 400, 'unsupported_parameter');
  const r = await (await req('GET', '/books?filter[reading_time][gt]=PT23H&filter[published][ge]=2022-01-01')).json();
  assert.deepEqual(r.items.map((x) => x.id), ['15']);
  const d = await (await req('GET', '/books?filter[price][lt]=10')).json(); // 9.00 < 10 even though as text it is not
  assert.deepEqual(d.items.map((x) => x.id), ['30']);
});
await test('named filters: switch, with value, no operators and AND (6.1)', async () => {
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
    namedFilters: { a: { description: 'x' } } } } }), /already a key of filter/);
  assert.throws(() => createRestep({ collections: { x: { data: memoryAdapter([]), namedFilters: { b: {} } } } }), /needs description/);
});
await test('pagination: next with a signed cursor, bound to filters and sort', async () => {
  const p1 = await (await req('GET', '/books?limit=2&sort=-price')).json();
  assert.equal(p1.items.length, 2);
  assert.match(p1.next, /^\/books\?limit=2&sort=-price&cursor=/);
  const p2 = await req('GET', p1.next.replace('limit=2', 'limit=3'));
  assert.equal(p2.status, 200);
  const other = await req('GET', p1.next.replace('sort=-price', 'sort=price'));
  assert.equal((await problem(other, 400, 'invalid_parameter')).parameter, 'cursor');
});
await test('idempotency: replay, mismatch and request in progress (409 request_in_progress)', async () => {
  const body = { title: 'Nuevo', price: '10.00' };
  const k = { 'idempotency-key': '"k-1"' };
  const a = await req('POST', '/books', { body, headers: k });
  assert.equal(a.status, 201);
  const b = await req('POST', '/books', { body: { price: '10.00', title: 'Nuevo' }, headers: k });
  assert.equal(b.headers.get('idempotent-replayed'), 'true');
  assert.equal(b.headers.get('location'), a.headers.get('location'));
  await problem(await req('POST', '/books', { body: { ...body, title: 'Otro' }, headers: k }), 422, 'idempotency_mismatch');
  // 7.1: with the book deleted, the repetition gives the same status and Location, without body or ETag (a read would give 404).
  assert.equal((await req('DELETE', a.headers.get('location'))).status, 204);
  const gone = await req('POST', '/books', { body, headers: k });
  assert.equal(gone.status, 201);
  assert.equal(gone.headers.get('location'), a.headers.get('location'));
  assert.equal(gone.headers.get('etag'), null);
  assert.equal(await gone.text(), '');
  // A slow adapter: the same request while the first is still in progress gives 409.
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
  // Another body with the same key while the first is still in progress: 422, not 409.
  const other = await slow.handle(new Request('http://x/notes', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': '"s"' }, body: '{"text":"b"}' }));
  await problem(other, 422, 'idempotency_mismatch');
  finish();
  assert.equal((await first).status, 201);
});
await test('validation: 422 with errors and pointer', async () => {
  const p = await problem(await req('POST', '/books', { body: { price: 3, category: 'x', nope: 1 } }), 422, 'invalid');
  const got = p.errors.map((e) => `${e.pointer} ${e.code}`).sort();
  assert.deepEqual(got, ['/category format', '/nope unknown', '/price type', '/title required']);
  const q = await problem(await req('PATCH', '/products/1', { body: { category: { id: '999' } }, headers: { 'content-type': 'application/merge-patch+json' } }), 422, 'invalid');
  assert.equal(q.errors[0].code, 'unknown');
  const cyc = await problem(await req('PATCH', '/categories/1', { body: { parent: { id: '3' } }, headers: { 'content-type': 'application/merge-patch+json' } }), 422, 'invalid');
  assert.equal(cyc.errors[0].code, 'cycle');
});
await test('form (4.3): title, default, labels and order in create; POST applies the defaults', async () => {
  const doc = await (await req('GET', '/', { headers: { 'accept-language': 'es' } })).json();
  const create = doc.collections.books.schemas.create;
  assert.deepEqual(Object.keys(create.properties).slice(0, 3), ['title', 'price', 'category']);
  assert.equal(create.properties.title.title, 'Título');
  assert.equal(create.properties.category.default, 'novela-negra');
  assert.deepEqual(create.properties.category.anyOf[0].oneOf[1], { const: 'ciencia-ficcion', title: 'Ciencia ficción' });
  assert.equal(create.properties.signed.default, false);
  assert.ok(!('default' in doc.collections.books.schemas.update.properties.category), 'default is not in update');
  const r = await req('POST', '/books', { body: { title: 'Sin categoría', price: '5.00' } });
  assert.equal(r.status, 201);
  const item = await r.json();
  assert.equal(item.category, 'novela-negra');
  assert.equal(item.signed, false);
  const withNull = await (await req('POST', '/books', { body: { title: 'Con null', price: '5.00', category: null } })).json();
  assert.ok(!('category' in withNull), 'null is not absent: it does not take the default');
  assert.throws(() => createRestep({ collections: { x: { fields: { n: { type: 'integer', default: 'uno' } }, data: memoryAdapter([]) } } }), /default/);
});
await test('new action (11.1): GET /books:new gives the prefilled body and creates nothing', async () => {
  const doc = await (await req('GET', '/')).json();
  assert.ok(doc.extensions.includes('actions'));
  assert.deepEqual(doc.collections.books.actions.new, { ...doc.collections.books.actions.new, on: 'collection', safe: true, idempotent: true, method: 'GET' });
  assert.equal(doc.collections.products.actions, undefined);
  const before = (await (await req('GET', '/books?limit=50')).json()).items.length;
  for (const path of ['/books:new', '/books%3Anew']) {
    const r = await req('GET', path);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'private, no-store');
    // 11.1 (draft 7): { values, schema }; the schema is the create schema, which it may only restrict.
    const { values, schema } = await r.json();
    assert.equal(values.category, 'novela-negra');
    assert.equal(values.published, new Date().toISOString().slice(0, 10));
    assert.deepEqual(schema, doc.collections.books.schemas.create);
  }
  assert.ok(doc.collections.books.actions.new.output, 'the new action declares its output');
  assert.equal((await (await req('GET', '/books?limit=50')).json()).items.length, before);
  await problem(await req('POST', '/books:new', { body: {} }), 405, 'method_not_allowed');
  // 8: If-None-Match also on the action (with *, or with its ETag).
  assert.equal((await req('GET', '/books:new', { headers: { 'if-none-match': '*' } })).status, 304);
  await problem(await req('GET', '/books:new?sort=title'), 400, 'unsupported_parameter');
  await problem(await req('GET', '/products:new'), 404, 'not_found');
});
await test('language (5.6): error texts in Spanish, same data', async () => {
  const r = await req('GET', '/books/nope', { headers: { 'accept-language': 'es-ES, en;q=0.5' } });
  const p = await problem(r, 404, 'not_found');
  assert.equal(p.title, 'No encontrado');
  assert.equal(r.headers.get('content-language'), 'es');
  assert.match(r.headers.get('vary'), /Accept-Language/);
  const d = await (await req('GET', '/', { headers: { 'accept-language': 'es' } })).json();
  assert.equal(d.collections.books.description, 'Libros del catálogo de El Marcapáginas, uno por edición.');
});
await test('cache: Cache-Groups on reads and Cache-Group-Invalidation on writes', async () => {
  const r = await req('GET', '/books?limit=2&sort=-price');
  assert.equal(r.headers.get('cache-groups'), '"/books", "/books/23", "/books/21"');
  const w = await req('PATCH', '/books/7', { body: { rating: 4.7 }, headers: { 'content-type': 'application/merge-patch+json' } });
  assert.equal(w.status, 200);
  assert.equal(w.headers.get('cache-group-invalidation'), '"/books", "/books/7"');
});
await test('_etag on list items (7.2): the ETag of the item GET, also with fields', async () => {
  const list = await (await req('GET', '/books?limit=3')).json();
  for (const it of list.items) {
    const r = await req('GET', `/books/${it.id}`);
    assert.equal(it._etag, r.headers.get('etag'));
  }
  const some = await (await req('GET', '/books?limit=3&fields=title')).json();
  assert.deepEqual(some.items.map((x) => x._etag), list.items.map((x) => x._etag));
  assert.deepEqual(Object.keys(some.items[0]).sort(), ['_etag', 'id', 'title']);
  // You can write with the _etag from the listing without reading the item.
  const w = await req('PATCH', `/books/${list.items[0].id}`, { body: { rating: 4.1 }, headers: { 'content-type': 'application/merge-patch+json', 'if-match': list.items[0]._etag } });
  assert.equal(w.status, 200);
  // A read-only item (no update or delete) does not carry it.
  const ro = createRestep({ collections: { notes: { fields: { text: 'string' }, data: { list: memoryAdapter([{ id: '1', text: 'a' }]).list, get: memoryAdapter([{ id: '1', text: 'a' }]).get } } } });
  const items = (await (await ro.handle(new Request('http://x/notes'))).json()).items;
  assert.deepEqual(items, [{ id: '1', text: 'a' }]);
  // If-Match of a POST to the collection with the ETag of its GET.
  const tag = (await req('GET', '/books')).headers.get('etag');
  await problem(await req('POST', '/books', { body: { title: 'x', price: '1.00' }, headers: { 'if-match': '"otra"' } }), 412, 'precondition_failed');
  assert.equal((await req('POST', '/books', { body: { title: 'x', price: '1.00' }, headers: { 'if-match': tag } })).status, 201);
});
await test('CORS (5.8): exposed headers and Vary: Origin on every response with a list of origins', async () => {
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
  // With cors: true (*) the response does not depend on Origin: no Vary: Origin.
  const any = await mk(true).handle(new Request('http://x/notes', { headers: { origin: 'https://app.test' } }));
  assert.equal(any.headers.get('access-control-allow-origin'), '*');
  assert.doesNotMatch(any.headers.get('vary') ?? '', /Origin/);
});
await test('428 when the collection requires If-Match', async () => {
  const strict = createRestep({ collections: { notes: { fields: { text: 'string' }, requireIfMatch: true, data: memoryAdapter([{ id: '1', text: 'a' }]) } } });
  const r = await strict.handle(new Request('http://x/notes/1', { method: 'DELETE' }));
  await problem(r, 428, 'precondition_required');
});
await test('base /api: links, Location and discovery under the root', async () => {
  const sub = createRestep({ base: '/api', collections: { notes: { fields: { text: 'string' }, defaultLimit: 1, data: memoryAdapter([{ id: '1', text: 'a' }, { id: '2', text: 'b' }]) } } });
  const page = await (await sub.handle(new Request('http://x/api/notes'))).json();
  assert.match(page.next, /^\/api\/notes\?cursor=/);
  assert.equal((await sub.handle(new Request('http://x/api/'))).status, 200);
  assert.equal((await sub.handle(new Request('http://x/notes'))).status, 404);
  const c = await sub.handle(new Request('http://x/api/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"c"}' }));
  assert.equal(c.headers.get('location'), '/api/notes/3');
});
await test('an adapter can throw RestepError (409) and any other failure gives 500 internal', async () => {
  const x = createRestep({ onError: () => {}, collections: { notes: { fields: { text: 'string' }, data: {
    ...memoryAdapter([{ id: '1' }]),
    async create() { throw new RestepError(409, 'conflict', 'Ya existe.', { reason: 'duplicate' }); },
    async list() { throw new Error('the database is not responding'); },
  } } } });
  const p = await problem(await x.handle(new Request('http://x/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })), 409, 'conflict');
  assert.equal(p.reason, 'duplicate');
  await problem(await x.handle(new Request('http://x/notes')), 500, 'internal');
});
await test('bad configuration: clear messages on create', async () => {
  assert.throws(() => createRestep({ collections: { a: { fields: { ok: 'boolean' }, filter: { ok: ['lt'] }, data: memoryAdapter() } } }), /boolean only supports/);
  assert.throws(() => createRestep({ collections: { a: { fields: { name: 'map' }, filter: { name: ['eq'] }, data: memoryAdapter() } } }), /field\.tag/);
  assert.throws(() => createRestep({ collections: { a: { fields: {} } } }), /adapter with get/);
});

// ── 2b. Draft 6 ──
console.log('draft 6 and earlier');
const patchH = (h = {}) => ({ 'content-type': 'application/merge-patch+json', ...h });
await test('discovery (1.1, 4.2, 8): 1.0-draft.7, cache, id_from, collations, singletons', async () => {
  const doc = await (await req('GET', '/')).json();
  assert.equal(doc.restep, '1.0-draft.7');
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
  assert.match(d2.headers.get('cache-control'), /private/); // depends on credentials (5.1, 4.2)
});
await test('content type (3): 415 without Content-Type, with another type or another charset; quoted utf-8 is fine', async () => {
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
await test('_etag (7.2): on the item GET, POST and PATCH, equal to the item ETag and computed without _etag', async () => {
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
await test('PATCH without changes (5.1): does not call update and keeps the same ETag', async () => {
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
await test('Idempotency-Key (7.1): the query counts for "the same request", not for the target; entry in errors', async () => {
  const body = { title: 'Idem', price: '3.00' };
  const k = { 'idempotency-key': '"q-1"' };
  assert.equal((await req('POST', '/books?x=1', { body, headers: k })).status, 201);
  // The same target after decoding the path (%62ooks is books) and the same query in another order and encoding: a repetition.
  const again = await req('POST', '/%62ooks?x=%31', { body, headers: k });
  assert.equal(again.headers.get('idempotent-replayed'), 'true');
  await problem(await req('POST', '/books?x=2', { body, headers: k }), 422, 'idempotency_mismatch');
  for (const bad of ['q-1', '"a";p=1', '"a" , "b"']) {
    const p = await problem(await req('POST', '/books', { body, headers: { 'idempotency-key': bad } }), 400, 'bad_request');
    assert.equal(p.errors[0].header, 'Idempotency-Key', bad);
  }
  // On PATCH it is ignored.
  assert.equal((await req('PATCH', '/books/7', { body: {}, headers: patchH({ 'idempotency-key': 'mal' }) })).status, 200);
});
await test('idempotency.anonymous false (7.1): 400 with the key and no credentials, no effect; with credentials, normal', async () => {
  const data = memoryAdapter();
  const x = createRestep({ idempotencyAnonymous: false, authenticate: (r) => r.headers.get('x-user'),
    collections: { notes: { fields: { text: 'string' }, requireIdempotencyKey: true, data } } });
  const post = (h, body = '{"text":"a"}') => x.handle(new Request('http://x/notes', { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body }));
  const p = await problem(await post({ 'idempotency-key': '"k"' }), 400, 'bad_request');
  assert.deepEqual([p.errors[0].header, p.errors[0].code], ['Idempotency-Key', 'unknown']);
  assert.equal(data.rows.size, 0);
  // Without credentials the key is not required even if the resource requires it.
  assert.equal((await post({})).status, 201);
  // With credentials it is required and works.
  await problem(await post({ 'x-user': 'ana' }), 400, 'idempotency_key_required');
  assert.equal((await post({ 'x-user': 'ana', 'idempotency-key': '"k"' })).status, 201);
  assert.equal((await post({ 'x-user': 'ana', 'idempotency-key': '"k"' })).headers.get('idempotent-replayed'), 'true');
});
await test('id_from (5.1): either, client, format, idPattern and taken (also that of a deleted item)', async () => {
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
  // Without an id, the server assigns one the collection has not had.
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
await test('paths (3): segments compared after decoding; a different id does not answer', async () => {
  assert.equal((await (await req('GET', '/books/%37')).json()).id, '7');
  await problem(await req('GET', '/books/07'), 404, 'not_found');
  assert.equal((await req('GET', '/%62ooks/7')).status, 200);
  await problem(await req('GET', '/books/7%2Fx'), 404, 'not_found');
  // An adapter that returns another id (07 for 7) does not make /books/07 respond.
  const loose = memoryAdapter([{ id: '7', text: 'a' }]);
  const x = createRestep({ collections: { notes: { fields: { text: 'string' }, data: { ...loose, get: (id) => loose.get(String(Number(id))) } } } });
  await problem(await x.handle(new Request('http://x/notes/07')), 404, 'not_found');
});
await test('+ is a space in the query (5.2) and collations "server" (6.1)', async () => {
  const ids = async (q) => (await (await req('GET', `/categories?${q}`)).json()).items.map((x) => x.id);
  assert.deepEqual(await ids('filter[name]=Material+escolar'), ['3']);
  assert.deepEqual(await ids('filter[name]=Material%20escolar'), ['3']);
  assert.deepEqual(await ids('filter[name]=libros'), ['2']); // case-insensitive
  assert.deepEqual(await ids('filter[name]=LAMPARAS'), ['5']); // nor accents
  const names = (await (await req('GET', '/categories?sort=name&limit=5')).json()).items.map((x) => x.name);
  assert.deepEqual(names.slice(0, 3), ['Lámparas', 'Libros', 'Libros infantiles']);
  assert.throws(() => createRestep({ collections: { a: { fields: { n: 'integer' }, filter: { n: ['eq'] }, collations: { n: 'server' }, data: memoryAdapter() } } }), /collations/);
  assert.throws(() => createRestep({ collections: { a: { filter: { id: ['eq'] }, collations: { id: 'server' }, data: memoryAdapter() } } }), /collations/);
  assert.throws(() => createRestep({ collections: { a: { fields: { s: 'string' }, filter: { s: ['eq'] }, collations: { s: 'es-u-co-trad' }, data: memoryAdapter() } } }), /collations/);
});
await test('relations (5.1): unknown entry at /rel/id; with its current value it is ignored unchecked', async () => {
  const p = await problem(await req('PATCH', '/products/2', { body: { category: { id: 'nadie' } }, headers: patchH() }), 422, 'invalid');
  assert.deepEqual([p.errors[0].pointer, p.errors[0].code], ['/category/id', 'unknown']);
  // products/5 links to category 5; even if it disappears, returning it as is does not fail.
  const cats = memoryAdapter([{ id: '1', name: 'a' }]);
  const x = createRestep({ collections: { cats: { fields: { name: 'string' }, data: cats },
    things: { fields: { cat: { type: 'relation', to: 'cats' }, n: 'integer' }, data: memoryAdapter([{ id: '1', cat: { id: '1' }, n: 1 }]) } } });
  cats.rows.delete('1');
  const r = await x.handle(new Request('http://x/things/1', { method: 'PATCH', headers: patchH(), body: '{"cat":{"id":"1","extra":true},"n":2}' }));
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).cat, { id: '1' });
});
await test('singletons (5.9): GET with href and _etag, fields, 405, PATCH with If-Match and without changes', async () => {
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
  assert.throws(() => createRestep({ collections: { books: { data: memoryAdapter() } }, singletons: { featured: { path: '/books/featured', data: memorySingleton() } } }), /clashes/);
});
await test('name grammar (3, 5.4): rejected at startup; a malformed reason gives 500', async () => {
  assert.throws(() => createRestep({ collections: { a: { fields: { 'mal nombre': 'string' }, data: memoryAdapter() } } }), /name grammar/);
  assert.throws(() => createRestep({ collections: { '1a': { data: memoryAdapter() } } }), /name grammar/);
  assert.throws(() => createRestep({ collections: { a: { namedFilters: { 'con.punto': { description: 'x' } }, data: memoryAdapter() } } }), /name grammar/);
  assert.throws(() => createRestep({ collections: { a: { fields: { ['x'.repeat(65)]: 'string' }, data: memoryAdapter() } } }), /name grammar/);
  assert.throws(() => createRestep({ collections: { a: { filter: { id: ['lt'] }, data: memoryAdapter() } } }), /no lt/);
  const x = createRestep({ onError: () => {}, collections: { notes: { data: { ...memoryAdapter(), async list() { throw new RestepError(409, 'conflict', 'x', { reason: 'no vale' }); } } } } });
  await problem(await x.handle(new Request('http://x/notes')), 500, 'internal');
});
await test('Origin (5.8): a write with a cookie from another origin gives 403 with no effect', async () => {
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
  assert.equal((await send('POST', '/notes', {})).status, 201); // no Origin or Sec-Fetch-Site: not from a browser
  assert.equal((await x.handle(new Request('http://api.test/notes', { headers: { cookie: 'sesion=ana', origin: 'https://evil.test' } }))).status, 200); // GET: seguro
  // Without credentials, or with browserCredentials: false (only tokens in Authorization), nothing is checked.
  const anon = await x.handle(new Request('http://api.test/notes', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.test' }, body: '{}' }));
  assert.equal(anon.status, 201);
  const off = mk({ browserCredentials: false });
  assert.equal((await off.handle(new Request('http://api.test/notes/1', { method: 'PATCH', headers: { cookie: 'sesion=ana', origin: 'https://evil.test', 'content-type': 'application/json' }, body: '{}' }))).status, 200);
});

// ── 2c. Draft 7 ──
console.log('draft 7');
const call = (x, method, path, { body, headers = {}, type } = {}) => x.handle(new Request(`http://api.test${path}`, {
  method, headers: { ...(body !== undefined && { 'content-type': type ?? (method === 'PATCH' ? 'application/merge-patch+json' : 'application/json') }), ...headers },
  body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
}));
const ids = async (r) => (await r.json()).items.map((x) => x.id);
await test('error codes (5.4): closed table, http_NNN for an unlisted status, no-store and no CDN fields', async () => {
  const x = createRestep({ onError: () => {}, collections: { notes: { fields: { text: 'string' }, data: { ...memoryAdapter([{ id: '1', text: 'a' }]),
    async list(q) { if (q.filter.length) throw new RestepError(429, 'rate_limited', 'Slow down.', { headers: { 'Retry-After': '5', 'CDN-Cache-Control': 'max-age=60', 'Cache-Control': 'public, max-age=60' } }); return memoryAdapter().list(q); },
    async create() { throw new RestepError(418, undefined, 'No coffee.'); } } } } });
  const r = await call(x, 'GET', '/notes?filter[id]=1');
  // filter on id is not declared: unsupported_parameter comes first; declare one to reach the adapter.
  await problem(r, 400, 'unsupported_parameter');
  const y = createRestep({ onError: () => {}, collections: { notes: { fields: { text: 'string' }, filter: { text: ['eq'] }, data: { ...memoryAdapter(),
    async list() { throw new RestepError(429, 'rate_limited', 'Slow down.', { headers: { 'Retry-After': '5', 'CDN-Cache-Control': 'max-age=60', 'Cache-Control': 'public, max-age=60' } }); },
    async create() { throw new RestepError(418, undefined, 'No coffee.'); } } } } });
  const slow = await call(y, 'GET', '/notes');
  await problem(slow, 429, 'rate_limited');
  assert.equal(slow.headers.get('cache-control'), 'no-store');
  assert.equal(slow.headers.get('cdn-cache-control'), null);
  assert.equal(slow.headers.get('retry-after'), '5');
  const tea = await problem(await call(y, 'POST', '/notes', { body: {} }), 418, 'http_418');
  assert.equal(tea.type, 'https://w3id.org/restep/1/errors#http_418');
  assert.throws(() => new RestepError(409, 'nope'), /does not go with status 409/);
  assert.throws(() => new RestepError(431, 'too_big'), /http_431/);
  assert.equal(new RestepError(431).code, 'http_431');
  assert.equal(new RestepError(404).code, 'not_found');
});
await test('methods (5.1, 4.3): 501 for an unknown method; a collection without GET; Allow with HEAD only beside GET', async () => {
  await problem(await req('BREW', '/books'), 501, 'not_implemented');
  await problem(await req('QUERY', '/books'), 405, 'method_not_allowed');
  const inbox = memoryAdapter();
  const x = createRestep({ collections: { inbox: { fields: { text: 'string' }, data: { get: inbox.get, create: inbox.create },
    methodEffects: { POST: ['external'] } } } });
  const doc = await (await call(x, 'GET', '/')).json();
  const c = doc.collections.inbox;
  assert.deepEqual(c.methods, ['POST']);
  assert.deepEqual(c.method_effects, { POST: ['external'] });
  for (const k of ['filter', 'sort', 'max_limit', 'count', 'named_filters']) assert.ok(!(k in c), k);
  for (const m of ['GET', 'HEAD']) {
    const r = await call(x, m, '/inbox');
    assert.equal(r.status, 405);
    assert.equal(r.headers.get('allow'), 'POST');
  }
  // 7.2: without a GET there is no current representation: If-Match: * fails, If-None-Match: * goes on.
  await problem(await call(x, 'POST', '/inbox', { body: { text: 'a' }, headers: { 'if-match': '*' } }), 412, 'precondition_failed');
  assert.equal((await call(x, 'POST', '/inbox', { body: { text: 'a' }, headers: { 'if-none-match': '*' } })).status, 201);
  assert.equal((await call(x, 'GET', '/inbox/1')).status, 200);
  assert.throws(() => createRestep({ collections: { a: { data: { get: inbox.get }, sort: ['id'] } } }), /without list/);
  assert.throws(() => createRestep({ collections: { a: { data: memoryAdapter(), itemMethodEffects: { DELETE: ['boom'] } } } }), /itemMethodEffects/);
  assert.throws(() => createRestep({ collections: { a: { data: memoryAdapter(), methodEffects: { PATCH: [] } } } }), /not an unsafe method/);
  const fx = createRestep({ collections: { a: { data: memoryAdapter(), itemMethodEffects: { DELETE: [], PATCH: [] } } } });
  assert.deepEqual((await (await call(fx, 'GET', '/')).json()).collections.a.item_method_effects, { DELETE: [], PATCH: [] });
});
await test('I-JSON (3): a repeated member name gives 400, an unpaired surrogate 422 format', async () => {
  const p = await problem(await req('POST', '/books', { body: '{"title":"a","price":"1.00","title":"b"}' }), 400, 'bad_request');
  assert.equal(p.errors[0].pointer, '/title');
  const q = await problem(await req('PATCH', '/books/7', { body: '{"x":[{"a":1,"a":2}]}', headers: patchH() }), 400, 'bad_request');
  assert.equal(q.errors[0].pointer, '/x/0/a');
  assert.equal((await req('POST', '/books', { body: '{"title":"a\\"title\\":","price":"1.00"}' })).status, 201); // inside a string it is not a member
  const s = await problem(await req('POST', '/books', { body: '{"title":"bad \\ud800 one","price":"1.00"}' }), 422, 'invalid');
  assert.deepEqual([s.errors[0].pointer, s.errors[0].code], ['/title', 'format']);
  await problem(await req('POST', '/books', { body: '{"title":"\\ufdd0","price":"1.00"}' }), 422, 'invalid');
});
await test('instants and durations (3): written in uppercase, accepted in lowercase; fractions of a second; local times and zones', async () => {
  const x = createRestep({ collections: { runs: {
    fields: { at: 'datetime', took: 'duration', local: 'localdatetime', zone: 'timezone' },
    filter: { took: ['lt', 'ge', 'eq'], at: ['ge'], local: ['lt'], zone: ['eq'], id: ['eq'] }, sort: ['took'],
    data: memoryAdapter([{ id: '1', at: '2026-01-01t10:00:00z', took: 'pt1.5s', local: '2027-03-30t19:00:00', zone: 'Europe/Madrid' },
      { id: '2', at: '2026-01-02T10:00:00+01:00', took: 'PT0.250S', local: '2027-03-30T18:59:59.5' }, { id: '3', took: 'PT2S' }]) } } });
  const one = await (await call(x, 'GET', '/runs/1')).json();
  assert.deepEqual([one.at, one.took, one.local], ['2026-01-01T10:00:00Z', 'PT1.5S', '2027-03-30T19:00:00']);
  assert.deepEqual(await ids(await call(x, 'GET', '/runs?filter[took][lt]=PT1.6S')), ['1', '2']);
  assert.deepEqual(await ids(await call(x, 'GET', '/runs?filter[took]=PT0.25S')), ['2']);
  assert.deepEqual(await ids(await call(x, 'GET', '/runs?sort=-took')), ['3', '1', '2']);
  assert.deepEqual(await ids(await call(x, 'GET', '/runs?filter[local][lt]=2027-03-30T19:00:00')), ['2']);
  assert.deepEqual(await ids(await call(x, 'GET', '/runs?filter[zone]=Europe/Madrid')), ['1']);
  await problem(await call(x, 'GET', '/runs?filter[zone]=Mars/Olympus'), 400, 'invalid_parameter');
  // 6.1: a leap second gives invalid_parameter.
  assert.equal((await problem(await call(x, 'GET', '/runs?filter[at][ge]=2016-12-31T23:59:60Z'), 400, 'invalid_parameter')).parameter, 'filter[at][ge]');
  // A request body takes lowercase, and the response writes uppercase.
  const r = await call(x, 'POST', '/runs', { body: { at: '2026-05-05t08:00:00z', took: 'p1dt2h' } });
  assert.equal(r.status, 201);
  assert.deepEqual(Object.values(await r.json()).slice(1, 3), ['2026-05-05T08:00:00Z', 'P1DT2H']);
  for (const bad of ['P1Y2D', 'PT1H5S', 'PT1.5H', 'PT1.1234567891S', 'P', 'PT']) {
    const p = await problem(await call(x, 'POST', '/runs', { body: { took: bad } }), 422, 'invalid');
    assert.equal(p.errors[0].pointer, '/took', bad);
  }
  await problem(await call(x, 'POST', '/runs', { body: { zone: 'Nowhere/At_All' } }), 422, 'invalid');
  const doc = await (await call(x, 'GET', '/')).json();
  assert.equal(doc.collections.runs.filter.local.type, 'localdatetime');
  assert.equal(doc.collections.runs.filter.zone.type, 'timezone');
});
await test('operators (6.1): nin, prefix and contains; in lists; numbers out of range compare without error', async () => {
  const b = createRestep({ collections: { books: { fields: { category: { type: 'enum', values: ['a', 'b', 'c'] }, year: 'integer' },
    filter: { category: ['in', 'nin'], year: ['ge', 'gt'] },
    data: memoryAdapter([{ id: '1', category: 'a', year: 2020 }, { id: '2', category: 'b', year: 2021 }, { id: '3', category: 'c' }, { id: '4', year: 1 }]) } } });
  const q = async (s) => ids(await call(b, 'GET', `/books?${s}`));
  assert.deepEqual(await q('filter[category][nin]=a,b'), ['3']); // never an absent value
  assert.deepEqual(await q('filter[year][ge]=99999999999999999999'), []);
  assert.deepEqual(await q('filter[year][gt]=-99999999999999999999'), ['1', '2', '4']);
  await problem(await call(b, 'GET', '/books?filter[category][in]='), 400, 'invalid_parameter');
  await problem(await call(b, 'GET', '/books?filter[category][nin]=a,z'), 400, 'invalid_parameter');
  const x = createRestep({ collections: { tags: { fields: { name: 'string', code: 'string' }, collations: { name: 'server' },
    filter: { name: ['prefix', 'contains', 'in', 'eq'], code: ['prefix', 'in'] },
    data: memoryAdapter([{ id: '1', name: 'Ñandú', code: 'a' }, { id: '2', name: 'nandu azul', code: '' }, { id: '3', name: 'Lámpara', code: 'b,c' }]) } } });
  const t2 = async (s) => ids(await call(x, 'GET', `/tags?${s}`));
  assert.deepEqual(await t2('filter[name][prefix]=nan'), ['1', '2']); // server collation: no case, no accents
  assert.deepEqual(await t2('filter[name][contains]=AMP'), ['3']);
  assert.deepEqual(await t2('filter[code][prefix]=b'), ['3']);
  assert.deepEqual(await t2('filter[code][in]=a,,z'), ['1', '2']); // an empty element is the empty string
  await problem(await call(x, 'GET', '/tags?filter[name][prefix]='), 400, 'invalid_parameter');
  const doc = await (await call(x, 'GET', '/')).json();
  assert.deepEqual(doc.collections.tags.filter.name.ops, ['prefix', 'contains', 'in', 'eq']);
  assert.throws(() => createRestep({ collections: { a: { fields: { n: 'integer' }, filter: { n: ['prefix'] }, data: memoryAdapter() } } }), /prefix and contains/);
  assert.throws(() => createRestep({ collections: { a: { filter: { id: ['contains'] }, data: memoryAdapter() } } }), /prefix and contains/);
  assert.throws(() => createRestep({ collections: { a: { fields: { n: 'integer' }, filter: { n: ['between'] }, data: memoryAdapter() } } }), /unknown operator/);
});
await test('cursor (6.1, 6.4): operands equal under the type are the same filter; next encodes [ and ]', async () => {
  const p1 = await (await req('GET', '/books?filter[price][ge]=10&limit=2')).json();
  assert.match(p1.next, /filter%5Bprice%5D%5Bge%5D=10/);
  assert.equal((await req('GET', p1.next.replace('=10&', '=10.00&'))).status, 200);
  await problem(await req('GET', p1.next.replace('=10&', '=11&')), 400, 'invalid_parameter');
  await problem(await req('GET', '/books?filter[price]=20&filter[price][eq]=20.0'), 400, 'invalid_parameter');
});
await test('default and required filters (6.1): applied unless turned off, never on an item; required gives invalid_parameter', async () => {
  const x = createRestep({ collections: { orders: { fields: { isbn: 'string', active: 'boolean' },
    filter: { isbn: { ops: ['eq'], required: true } },
    namedFilters: { active: { description: 'Not archived.', default: true, apply: (r) => r.active }, mine: { description: 'Mine.', required: false, apply: () => true } },
    data: memoryAdapter([{ id: '1', isbn: 'x', active: true }, { id: '2', isbn: 'x', active: false }, { id: '3', isbn: 'y', active: true }]), defaultLimit: 1 } } });
  const doc = await (await call(x, 'GET', '/')).json();
  assert.deepEqual(doc.collections.orders.filter.isbn, { type: 'string', ops: ['eq'], required: true });
  assert.equal(doc.collections.orders.named_filters.active.default, true);
  assert.equal((await problem(await call(x, 'GET', '/orders'), 400, 'invalid_parameter')).parameter, 'filter[isbn]');
  assert.deepEqual(await ids(await call(x, 'GET', '/orders?filter[isbn]=x&limit=5')), ['1']);
  assert.deepEqual(await ids(await call(x, 'GET', '/orders?filter[isbn]=x&filter[active]=false&limit=5')), ['1', '2']);
  assert.deepEqual(await ids(await call(x, 'GET', '/orders?filter[isbn]=x&filter[active]&limit=5')), ['1']);
  assert.equal((await problem(await call(x, 'GET', '/orders?filter[isbn]=x&filter[mine]=false'), 400, 'invalid_parameter')).parameter, 'filter[mine]');
  assert.equal((await call(x, 'GET', '/orders/2')).status, 200);
  // 6.4: the cursor is bound to the default filters the request does not turn off.
  const page = await (await call(x, 'GET', '/orders?filter[isbn]=x&filter[active]=false')).json();
  await problem(await call(x, 'GET', page.next.replace('&filter%5Bactive%5D=false', '')), 400, 'invalid_parameter');
  assert.equal((await call(x, 'GET', page.next)).status, 200);
  // 7.2: a POST's If-Match list finds no ETag when the GET without parameters fails (a required filter).
  await problem(await call(x, 'POST', '/orders', { body: {}, headers: { 'if-match': '"x"' } }), 412, 'precondition_failed');
  assert.throws(() => createRestep({ collections: { a: { fields: { n: 'integer' }, namedFilters: { b: { description: 'b', type: 'string', default: true } }, data: memoryAdapter() } } }), /only on a switch/);
});
await test('to-many filters (6.1, 6.2): quantifier some, groups, null on the group, sort by the least or greatest', async () => {
  const x = createRestep({ collections: {
    tags: { fields: { name: 'string' }, data: memoryAdapter([{ id: 't1', name: 'a' }, { id: 't2', name: 'b' }]) },
    books: { fields: { formats: { type: 'list', items: 'string' }, scores: { type: 'list', items: 'integer' }, tags: { type: 'relation', to: 'tags', many: true } },
      filter: { formats: { ops: ['eq', 'in', 'null'], quantifier: 'some' }, scores: { ops: ['ge', 'le'], quantifier: 'some' },
        'tags.id': { ops: ['eq', 'in'], quantifier: 'some' }, tags: { ops: ['null'] } },
      sort: ['id', 'scores'],
      data: memoryAdapter([{ id: '1', formats: ['pdf', 'epub'], scores: [1, 5], tags: [{ id: 't1' }] }, { id: '2', formats: ['epub'], scores: [3], tags: ['t2'] },
        { id: '3', formats: [], scores: [2, 4], tags: [] }, { id: '4' }]) } } });
  const q = async (s) => ids(await call(x, 'GET', `/books?${s}`));
  assert.deepEqual(await q('filter[formats]=pdf'), ['1']);
  assert.deepEqual(await q('filter[formats][in]=pdf,epub'), ['1', '2']);
  // A group: some element matches all its filters (3 is in [2, 4] only across two elements).
  assert.deepEqual(await q('filter[scores][ge]=3&filter[scores][le]=3'), ['2']);
  assert.deepEqual(await q('filter[scores][ge]=2&filter[scores][le]=4'), ['2', '3']);
  assert.deepEqual(await q('filter[formats][null]=true'), ['3', '4']);
  assert.deepEqual(await q('filter[formats]=pdf&filter[formats][null]=true'), ['2', '3', '4']); // null: true negates the group
  assert.deepEqual(await q('filter[tags.id]=t2'), ['2']);
  assert.deepEqual(await q('filter[tags][null]=true'), ['3', '4']);
  assert.deepEqual(await q('filter[tags][null]=false'), ['1', '2']);
  assert.deepEqual(await q('sort=scores'), ['1', '3', '2', '4']); // least: 1, 2, 3; none last
  assert.deepEqual(await q('sort=-scores'), ['1', '3', '2', '4']); // greatest: 5, 4, 3; none last
  const four = await (await call(x, 'GET', '/books/4')).json();
  assert.deepEqual(four.tags, []);
  assert.deepEqual((await (await call(x, 'GET', '/books/2')).json()).tags, [{ id: 't2' }]);
  const doc = await (await call(x, 'GET', '/')).json();
  assert.equal(doc.collections.books.filter['tags.id'].quantifier, 'some');
  assert.equal(doc.collections.books.relations.tags.many, true);
  // Writes: a to-many list is replaced whole; an unknown item gives unknown at its id.
  const p = await problem(await call(x, 'PATCH', '/books/1', { body: { tags: [{ id: 't2' }, { id: 'zz' }] } }), 422, 'invalid');
  assert.deepEqual([p.errors[0].pointer, p.errors[0].code], ['/tags/1/id', 'unknown']);
  assert.deepEqual((await (await call(x, 'PATCH', '/books/1', { body: { tags: [{ id: 't2' }] } })).json()).tags, [{ id: 't2' }]);
  const bad = (filter) => () => createRestep({ collections: { t: { fields: { name: 'string' }, data: memoryAdapter() },
    b: { fields: { f: { type: 'list', items: 'string' }, tags: { type: 'relation', to: 't', many: true } }, filter, data: memoryAdapter() } } });
  assert.throws(bad({ f: ['eq'] }), /quantifier/);
  assert.throws(bad({ 'tags.id': { ops: ['ne'], quantifier: 'some' } }), /no ne or nin/);
  assert.throws(bad({ tags: { ops: ['eq'], quantifier: 'some' } }), /only null/);
  // Council 1 (6.1): null on the relationship or list itself, as its only operator, has the type of the related
  // items' id (string) or of the elements; council b7 r3 8: it may omit quantifier or declare "some" (below).
  assert.deepEqual(doc.collections.books.filter.tags, { type: 'string', ops: ['null'] });
  const listNull = await (await call(bad({ f: ['null'] })(), 'GET', '/')).json();
  assert.deepEqual(listNull.collections.b.filter.f, { type: 'string', ops: ['null'] });
});
await test('localized fields (3, 5.6, 7.2): by Accept-Language, read-only, Vary, ETag by language, If-Match in any language', async () => {
  const x = createRestep({ collections: { genres: {
    fields: { name_i18n: 'map', name: { type: 'localized', source: 'name_i18n' }, slug: 'string' },
    filter: { name: ['eq', 'prefix'] }, sort: ['id', 'name'], collations: { name: 'server' }, defaultLimit: 1,
    data: memoryAdapter([{ id: '1', slug: 'crime', name_i18n: { 'es-es': 'Novela negra', en: 'Crime fiction' } },
      { id: '2', slug: 'poetry', name_i18n: { es: 'Poesía', en: 'Poetry' } }, { id: '3', slug: 'none', name_i18n: { fr: 'Rien' } }]) } } });
  const es = { 'accept-language': 'es' };
  const doc = await (await call(x, 'GET', '/')).json();
  assert.equal(doc.default_language, 'en');
  assert.deepEqual(doc.collections.genres.localized, { name: { source: 'name_i18n' } });
  assert.equal(doc.collections.genres.schemas.item.properties.name.readOnly, true);
  assert.ok(!('name' in doc.collections.genres.schemas.create.properties));
  const rEn = await call(x, 'GET', '/genres/1'), rEs = await call(x, 'GET', '/genres/1', { headers: es });
  const en = await rEn.json(), sp = await rEs.json();
  assert.deepEqual([en.name, sp.name], ['Crime fiction', 'Novela negra']); // es fills from es-es
  assert.equal((await (await call(x, 'GET', '/genres/3')).json()).name, null);
  assert.equal(rEs.headers.get('content-language'), 'es');
  assert.match(rEs.headers.get('vary'), /Accept-Language/);
  assert.notEqual(rEn.headers.get('etag'), rEs.headers.get('etag'));
  const n3 = [await call(x, 'GET', '/genres/3'), await call(x, 'GET', '/genres/3', { headers: es })];
  assert.notEqual(n3[0].headers.get('etag'), n3[1].headers.get('etag'), 'the item ETag differs by language even when the text is the same');
  // Filters and sorts in the response language; the cursor is bound to it.
  assert.deepEqual(await ids(await call(x, 'GET', '/genres?filter[name][prefix]=poe&limit=5', { headers: es })), ['2']);
  assert.deepEqual(await ids(await call(x, 'GET', '/genres?filter[name]=crime fiction&limit=5')), ['1']);
  const list = await call(x, 'GET', '/genres?sort=name', { headers: es });
  assert.match(list.headers.get('vary'), /Accept-Language/);
  const page = await list.json();
  await problem(await call(x, 'GET', page.next), 400, 'invalid_parameter');
  assert.equal((await call(x, 'GET', page.next, { headers: es })).status, 200);
  // If-Match with the English ETag works on a request in Spanish; the field sent back as read is ignored.
  const w = await call(x, 'PATCH', '/genres/1', { body: { ...sp, slug: 'noir' }, headers: { ...es, 'if-match': en._etag } });
  assert.equal(w.status, 200);
  assert.equal((await w.json()).name, 'Novela negra');
  const ro = await problem(await call(x, 'PATCH', '/genres/1', { body: { name: 'Otra' } }), 422, 'invalid');
  assert.deepEqual([ro.errors[0].pointer, ro.errors[0].code], ['/name', 'read_only']);
  assert.equal((await call(x, 'POST', '/genres', { body: { name_i18n: { en: 'Essay' }, name: 'Essay' } })).status, 201);
  await problem(await call(x, 'POST', '/genres', { body: { name_i18n: { en: 'Essay' }, name: 'Ensayo' } }), 422, 'invalid');
  assert.throws(() => createRestep({ collections: { a: { fields: { n: { type: 'localized', source: 'nope' } }, data: memoryAdapter() } } }), /source/);
});
await test('read-only fields (5.1): in a POST, one only the server sets is ignored whatever its value', async () => {
  const data = memoryAdapter([{ id: '1', text: 'a', created_at: '2026-01-01T00:00:00Z' }]);
  const x = createRestep({ collections: { notes: { fields: { text: 'string', created_at: { type: 'datetime', readOnly: true } },
    data: { ...data, create: (d, ctx) => data.create({ ...d, created_at: '2026-11-24T10:00:00Z' }, ctx) } } } });
  const r = await call(x, 'POST', '/notes', { body: { text: 'b', created_at: '1999-01-01T00:00:00Z' } });
  assert.equal(r.status, 201);
  assert.equal((await r.json()).created_at, '2026-11-24T10:00:00Z');
  assert.equal((await call(x, 'PATCH', '/notes/1', { body: { text: 'c', created_at: '2026-01-01T01:00:00+01:00' } })).status, 200); // the same instant
  const p = await problem(await call(x, 'PATCH', '/notes/1', { body: { created_at: '2020-01-01T00:00:00Z' } }), 422, 'invalid');
  assert.deepEqual([p.errors[0].pointer, p.errors[0].code], ['/created_at', 'read_only']);
  const doc = await (await call(x, 'GET', '/')).json();
  assert.equal(doc.collections.notes.schemas.item.properties.created_at.readOnly, true);
  assert.ok(!('created_at' in doc.collections.notes.schemas.create.properties));
});
await test('reusable_ids (5.1, 7.2): a deleted id is free again, as a new incarnation with another ETag', async () => {
  const x = createRestep({ collections: { subs: { idFrom: 'client', reusableIds: true, fields: { level: 'string' }, data: memoryAdapter() } } });
  const doc = await (await call(x, 'GET', '/')).json();
  assert.equal(doc.collections.subs.reusable_ids, true);
  const a = await call(x, 'POST', '/subs', { body: { id: 'ana', level: 'gold' } });
  const tagA = a.headers.get('etag');
  await problem(await call(x, 'POST', '/subs', { body: { id: 'ana', level: 'gold' } }), 409, 'conflict');
  assert.equal((await call(x, 'DELETE', '/subs/ana')).status, 204);
  const b = await call(x, 'POST', '/subs', { body: { id: 'ana', level: 'gold' } });
  assert.equal(b.status, 201);
  assert.notEqual(b.headers.get('etag'), tagA);
  assert.ok(!('_incarnation' in await b.json()));
  await problem(await call(x, 'PATCH', '/subs/ana', { body: { level: 'silver' }, headers: { 'if-match': tagA } }), 412, 'precondition_failed');
  assert.equal((await call(x, 'PATCH', '/subs/ana', { body: { level: 'silver' }, headers: { 'if-match': b.headers.get('etag') } })).status, 200);
  assert.throws(() => createRestep({ collections: { a: { idFrom: 'either', reusableIds: true, data: memoryAdapter() } } }), /reusableIds/);
});
await test('upsert (5.1, 7.2): a PATCH to a free id creates; If-Match fails, If-None-Match: * creates; a deleted id gives 404', async () => {
  const x = createRestep({ collections: { drafts: { idFrom: 'client', upsert: true, fields: { text: { type: 'string', required: true }, n: { type: 'integer', default: 1 } }, data: memoryAdapter() } } });
  assert.equal((await (await call(x, 'GET', '/')).json()).collections.drafts.upsert, true);
  const c = await call(x, 'PATCH', '/drafts/current', { body: { text: 'hola' }, headers: { 'if-none-match': '*' } });
  assert.equal(c.status, 201);
  assert.equal(c.headers.get('location'), '/drafts/current');
  const made = await c.json();
  assert.deepEqual([made.id, made.text, made.n, made._etag], ['current', 'hola', 1, c.headers.get('etag')]);
  const u = await call(x, 'PATCH', '/drafts/current', { body: { text: 'adiós' } });
  assert.equal(u.status, 200);
  await problem(await call(x, 'PATCH', '/drafts/current', { body: { text: 'x' }, headers: { 'if-none-match': '*' } }), 412, 'precondition_failed');
  await problem(await call(x, 'PATCH', '/drafts/other', { body: { text: 'x' }, headers: { 'if-match': '*' } }), 412, 'precondition_failed');
  const p = await problem(await call(x, 'PATCH', '/drafts/other', { body: { n: 2 } }), 422, 'invalid');
  assert.deepEqual([p.errors[0].pointer, p.errors[0].code], ['/text', 'required']);
  await problem(await call(x, 'PATCH', '/drafts/other', { body: { text: 'x', id: 'else' } }), 422, 'invalid');
  assert.equal((await call(x, 'DELETE', '/drafts/current')).status, 204);
  await problem(await call(x, 'PATCH', '/drafts/current', { body: { text: 'again' } }), 404, 'not_found');
  await problem(await call(x, 'DELETE', '/drafts/nope'), 404, 'not_found');
  // With reusable_ids the deleted id is free, so the PATCH creates it again.
  const y = createRestep({ collections: { d: { idFrom: 'client', reusableIds: true, upsert: true, fields: { text: 'string' }, data: memoryAdapter() } } });
  assert.equal((await call(y, 'PATCH', '/d/k', { body: { text: 'a' } })).status, 201);
  assert.equal((await call(y, 'DELETE', '/d/k')).status, 204);
  assert.equal((await call(y, 'PATCH', '/d/k', { body: { text: 'b' } })).status, 201);
  assert.throws(() => createRestep({ collections: { a: { upsert: true, data: memoryAdapter() } } }), /upsert/);
});
await test('singletons with parent (5.9): under an item or another singleton; 404 under an item that does not exist', async () => {
  const seen = [];
  const x = createRestep({ collections: { readers: { fields: { name: 'string' }, data: memoryAdapter([{ id: 'r1', name: 'Ana' }]) } },
    singletons: {
      settings: { parent: 'readers', path: '/readers/{reader_id}/settings', fields: { theme: 'string' },
        data: { async get(ctx) { seen.push(ctx.ids.reader_id); return { theme: `dark-${ctx.ids.reader_id}` }; }, async update(d) { return d; } } },
      privacy: { parent: 'settings', path: '/readers/{reader_id}/settings/privacy', fields: { public: 'boolean' }, data: memorySingleton({ public: false }) },
    } });
  const doc = await (await call(x, 'GET', '/')).json();
  assert.deepEqual([doc.singletons.settings.parent, doc.singletons.settings.path], ['readers', '/readers/{reader_id}/settings']);
  const r = await call(x, 'GET', '/readers/r1/settings');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).theme, 'dark-r1');
  assert.equal(r.headers.get('cache-groups'), '"/readers/r1/settings"');
  await problem(await call(x, 'GET', '/readers/nobody/settings'), 404, 'not_found');
  assert.equal((await call(x, 'GET', '/readers/r1/settings/privacy')).status, 200);
  await problem(await call(x, 'GET', '/readers/nobody/settings/privacy'), 404, 'not_found');
  const w = await call(x, 'PATCH', '/readers/r1/settings', { body: { theme: 'light' } });
  assert.equal(w.status, 200);
  assert.equal((await call(x, 'GET', '/readers/r1')).status, 200);
  const bad = (path, parent = 'readers') => () => createRestep({ collections: { readers: { data: memoryAdapter() } }, singletons: { s: { parent, path, data: memorySingleton() } } });
  assert.throws(bad('/readers/{id}'), /followed by/);
  assert.throws(bad('/other/{id}/s'), /followed by/);
  assert.throws(bad('/readers/{id}/s', 'nadie'), /not a collection/);
  assert.throws(() => createRestep({ collections: {}, singletons: { s: { path: '/a/{x}', data: memorySingleton() } } }), /template only with parent/);
});
await test('upload (5.1): a file instead of JSON, with _content; 415, 413, multipart, idempotency and media_types', async () => {
  const files = memoryAdapter();
  let n = 0;
  const x = createRestep({ maxBodyBytes: 1 << 20, collections: {
    files: { upload: { mediaTypes: ['image/*', 'application/pdf'], maxSize: 8, multipart: true }, fields: { name: 'string' },
      data: { ...files, create: undefined, async upload(f, ctx) { n++; return files.create({ name: f.filename ?? null, _content: { href: `/blobs/${n}`, media_type: f.mediaType, size: f.size } }, ctx); } } },
    posts: { fields: { cover: { type: 'relation', to: 'files', mediaTypes: ['image/*'] } }, data: memoryAdapter() } } });
  const doc = await (await call(x, 'GET', '/')).json();
  assert.deepEqual(doc.collections.files.upload, { media_types: ['image/*', 'application/pdf'], max_size: 8, multipart: true });
  assert.deepEqual(doc.collections.posts.relations.cover.media_types, ['image/*']);
  const png = new Uint8Array([137, 80, 78, 71]);
  const r = await call(x, 'POST', '/files', { body: png, type: 'image/png', headers: { 'content-disposition': 'attachment; filename="a.png"', 'idempotency-key': '"u1"' } });
  assert.equal(r.status, 201);
  const item = await r.json();
  assert.deepEqual([item.name, item._content], ['a.png', { href: '/blobs/1', media_type: 'image/png', size: 4 }]);
  const again = await call(x, 'POST', '/files', { body: png, type: 'image/png', headers: { 'idempotency-key': '"u1"' } });
  assert.equal(again.headers.get('idempotent-replayed'), 'true');
  assert.equal(n, 1);
  await problem(await call(x, 'POST', '/files', { body: new Uint8Array([1]), type: 'image/png', headers: { 'idempotency-key': '"u1"' } }), 422, 'idempotency_mismatch');
  await problem(await call(x, 'POST', '/files', { body: 'hi', type: 'text/plain' }), 415, 'unsupported_media_type');
  await problem(await call(x, 'POST', '/files', { body: { name: 'x' } }), 415, 'unsupported_media_type'); // no create: only files
  await problem(await call(x, 'POST', '/files', { body: new Uint8Array(9), type: 'application/pdf' }), 413, 'content_too_large');
  const part = (name, type, bytes, extra = '') => `--B\r\nContent-Disposition: form-data; name="${name}"; filename="f.pdf"\r\nContent-Type: ${type}\r\n\r\n${bytes}\r\n${extra}`;
  const m = await call(x, 'POST', '/files', { body: `${part('file', 'application/pdf', '%PDF')}--B--\r\n`, type: 'multipart/form-data; boundary=B' });
  assert.equal(m.status, 201);
  assert.deepEqual((await m.json())._content.size, 4);
  await problem(await call(x, 'POST', '/files', { body: `${part('file', 'application/pdf', '%PDF')}${part('other', 'image/png', 'x').replace('--B', '--B')}--B--\r\n`, type: 'multipart/form-data; boundary=B' }), 415, 'unsupported_media_type');
  await problem(await call(x, 'POST', '/files', { body: `${part('photo', 'application/pdf', '%PDF')}--B--\r\n`, type: 'multipart/form-data; boundary=B' }), 415, 'unsupported_media_type');
  // A relation with media_types rejects a file of another type with format at its id.
  const pdfId = (await (await call(x, 'GET', '/files?limit=5')).json()).items.find((f) => f._content.media_type === 'application/pdf').id;
  const p = await problem(await call(x, 'POST', '/posts', { body: { cover: { id: pdfId } } }), 422, 'invalid');
  assert.deepEqual([p.errors[0].pointer, p.errors[0].code], ['/cover/id', 'format']);
  assert.equal((await call(x, 'POST', '/posts', { body: { cover: { id: item.id } } })).status, 201);
  const noMulti = createRestep({ collections: { f: { upload: { mediaTypes: ['image/png'] }, data: { ...memoryAdapter(), upload: async () => ({}) } } } });
  await problem(await call(noMulti, 'POST', '/f', { body: `${part('file', 'image/png', 'x')}--B--\r\n`, type: 'multipart/form-data; boundary=B' }), 415, 'unsupported_media_type');
  assert.throws(() => createRestep({ collections: { f: { upload: { mediaTypes: ['image/png'] }, data: memoryAdapter() } } }), /upload\(file, ctx\)/);
});
await test('new action (11.1): declared params, the effective schema and HEAD', async () => {
  let got;
  const x = createRestep({ collections: { orders: { fields: { kind: { type: 'enum', values: ['shop', 'gift'] }, note: 'string' },
    newItem: (ctx) => { got = ctx.params; return { kind: ctx.params.kind ?? 'shop' }; },
    newParams: { kind: { type: 'enum', values: ['shop', 'gift'], description: 'Which form.' }, tags: { type: 'string', list: true } },
    newSchema: (ctx, schema) => ({ ...schema, required: ['kind'] }),
    data: memoryAdapter() } } });
  const doc = await (await call(x, 'GET', '/')).json();
  assert.deepEqual(doc.collections.orders.actions.new.params, { kind: { type: 'enum', values: ['shop', 'gift'], description: 'Which form.' }, tags: { type: 'string', list: true } });
  const r = await (await call(x, 'GET', '/orders:new?kind=gift&tags=a,b')).json();
  assert.deepEqual([r.values.kind, r.schema.required], ['gift', ['kind']]);
  assert.deepEqual(got, { kind: 'gift', tags: ['a', 'b'] });
  assert.equal((await problem(await call(x, 'GET', '/orders:new?other=1'), 400, 'unsupported_parameter')).parameter, 'other');
  assert.equal((await problem(await call(x, 'GET', '/orders:new?kind=nope'), 400, 'invalid_parameter')).parameter, 'kind');
  await problem(await call(x, 'GET', '/orders:new?tags='), 400, 'invalid_parameter');
  const h = await call(x, 'HEAD', '/orders:new');
  assert.equal(h.status, 200);
  assert.equal(await h.text(), '');
});
await test('principal and actor (2): an acting principal and the one it represents share no keys or cursors', async () => {
  const data = memoryAdapter();
  const x = createRestep({ authenticate: (r) => { const [p, a] = (r.headers.get('x-user') ?? '').split('/'); return p ? (a ? { principal: p, actor: a } : p) : null; },
    collections: { notes: { fields: { text: 'string' }, defaultLimit: 1, data } } });
  const post = (user) => call(x, 'POST', '/notes', { body: { text: 'a' }, headers: { 'x-user': user, 'idempotency-key': '"same"' } });
  assert.equal((await post('ana')).status, 201);
  const bot = await post('ana/bot');
  assert.equal(bot.status, 201);
  assert.equal(bot.headers.get('idempotent-replayed'), null);
  assert.equal((await post('ana/bot')).headers.get('idempotent-replayed'), 'true');
  const page = await (await call(x, 'GET', '/notes', { headers: { 'x-user': 'ana/bot' } })).json();
  await problem(await call(x, 'GET', page.next, { headers: { 'x-user': 'ana' } }), 400, 'invalid_parameter');
  assert.equal((await call(x, 'GET', page.next, { headers: { 'x-user': 'ana/bot' } })).status, 200);
});
await test('replay (7.1): the body gives no more than a read would now: the current representation', async () => {
  const k = { 'idempotency-key': '"replay-now"' };
  const a = await req('POST', '/books', { body: { title: 'Antes', price: '1.00' }, headers: k });
  const made = await a.json();
  await req('PATCH', `/books/${made.id}`, { body: { title: 'Después' }, headers: patchH() });
  const b = await req('POST', '/books', { body: { title: 'Antes', price: '1.00' }, headers: k });
  assert.deepEqual([b.status, b.headers.get('location'), b.headers.get('idempotent-replayed')], [201, a.headers.get('location'), 'true']);
  const now = await b.json();
  assert.equal(now.title, 'Después');
  assert.equal(now._etag, b.headers.get('etag'));
  assert.equal(b.headers.get('etag'), (await req('GET', `/books/${made.id}`)).headers.get('etag'));
});
await test('paths (3): a segment that does not decode to UTF-8 is an item that does not exist', async () => {
  await problem(await req('GET', '/books/%FF'), 404, 'not_found');
  await problem(await req('PATCH', '/books/%C3', { body: {}, headers: patchH() }), 404, 'not_found');
});

// ── Council decisions on draft 7 (round 1) ──
await test('council 2 (5.1): a 415 from a collection with upload carries Accept-Post; JSON is an upload only where declared', async () => {
  const up = (create, mediaTypes, multipart = false) => {
    const files = memoryAdapter();
    return { upload: { mediaTypes, multipart }, fields: { name: 'string' },
      data: { ...files, create: create ? files.create : undefined, upload: (f, ctx) => files.create({ _content: { href: '/b/1', media_type: f.mediaType, size: f.size } }, ctx) } };
  };
  const x = createRestep({ cors: { origins: ['https://app.example'] }, collections: { files: up(false, ['image/*', 'application/pdf'], true), docs: up(true, ['application/pdf']),
    blobs: up(false, ['application/json']), notes: { fields: { text: 'string' }, data: memoryAdapter() } } });
  for (const [body, type] of [[{ name: 'x' }, undefined], ['hi', 'text/plain']]) {
    const r = await call(x, 'POST', '/files', { body, type });
    await problem(r, 415, 'unsupported_media_type');
    assert.equal(r.headers.get('accept-post'), 'image/*, application/pdf, multipart/form-data');
  }
  const none = await x.handle(new Request('http://api.test/files', { method: 'POST', body: '{}' }));
  assert.equal(none.status, 415);
  const d = await call(x, 'POST', '/docs', { body: 'hi', type: 'text/plain' });
  await problem(d, 415, 'unsupported_media_type');
  assert.equal(d.headers.get('accept-post'), 'application/json, application/pdf');
  // application/json declared in mediaTypes, and no create: a JSON body is the bytes of a file.
  const j = await call(x, 'POST', '/blobs', { body: { any: 1 } });
  assert.equal(j.status, 201);
  assert.equal((await j.json())._content.media_type, 'application/json');
  const n = await call(x, 'POST', '/notes', { body: 'hi', type: 'text/plain' });
  await problem(n, 415, 'unsupported_media_type');
  assert.equal(n.headers.get('accept-post'), null);
  const c = await x.handle(new Request('http://api.test/notes', { headers: { origin: 'https://app.example' } }));
  assert.match(c.headers.get('access-control-expose-headers'), /(^|, )Accept-Post(,|$)/);
  // Without data.create there is no JSON body to describe: no create schema, which tells a client it only takes files.
  const doc = await (await call(x, 'GET', '/')).json();
  assert.deepEqual([doc.collections.files.schemas.create, doc.collections.blobs.schemas.create], [undefined, undefined]);
  assert.equal(doc.collections.docs.schemas.create.type, 'object');
});
await test('council 3 (6.1): 20.0 is a valid operand of an integer field, the same as 20, also for the cursor; 20.5 is not', async () => {
  const x = createRestep({ collections: { items: { fields: { n: 'integer' }, filter: { n: ['eq', 'ge', 'in'] }, defaultLimit: 1,
    data: memoryAdapter([{ id: '1', n: 10 }, { id: '2', n: 20 }, { id: '3', n: 25 }]) } } });
  for (const v of ['20', '20.0', '2e1', '2.0E1', '200e-1']) assert.deepEqual(await ids(await call(x, 'GET', `/items?filter[n]=${v}`)), ['2'], v);
  assert.deepEqual(await ids(await call(x, 'GET', '/items?filter[n][in]=2.5e1,7')), ['3']);
  for (const v of ['20.5', '1e-1', '2.05e1', 'x'])
    assert.equal((await problem(await call(x, 'GET', `/items?filter[n]=${v}`), 400, 'invalid_parameter')).parameter, 'filter[n]', v);
  const p1 = await (await call(x, 'GET', '/items?filter[n][ge]=10')).json();
  assert.match(p1.next, /filter%5Bn%5D%5Bge%5D=10&/);
  assert.equal((await call(x, 'GET', p1.next.replace('=10&', '=10.00&'))).status, 200);
  assert.equal((await call(x, 'GET', p1.next.replace('=10&', '=1e1&'))).status, 200);
  await problem(await call(x, 'GET', p1.next.replace('=10&', '=10.5&')), 400, 'invalid_parameter');
});
await test('council 4 (3): an instant with a leap second (:60) in a body gives 422 invalid with a format entry', async () => {
  const x = createRestep({ collections: { runs: { fields: { at: 'datetime', times: { type: 'list', items: 'datetime' }, made: { type: 'datetime', readOnly: true } },
    data: memoryAdapter([{ id: '1', at: '2026-01-01T00:00:00Z' }]) } } });
  const p = await problem(await call(x, 'POST', '/runs', { body: { at: '2016-12-31T23:59:60Z' } }), 422, 'invalid');
  assert.deepEqual(p.errors.map((e) => [e.pointer, e.code]), [['/at', 'format']]);
  const q = await problem(await call(x, 'PATCH', '/runs/1', { body: { at: '2016-12-31t23:59:60z' } }), 422, 'invalid');
  assert.deepEqual(q.errors.map((e) => [e.pointer, e.code]), [['/at', 'format']]);
  const l = await problem(await call(x, 'POST', '/runs', { body: { times: ['2016-12-31T23:59:59Z', '2016-12-31T23:59:60+00:00'] } }), 422, 'invalid');
  assert.deepEqual(l.errors.map((e) => [e.pointer, e.code]), [['/times/1', 'format']]);
  // 5.1: a field only the server sets is ignored in a POST whatever its value, a leap second included.
  assert.equal((await call(x, 'POST', '/runs', { body: { at: '2016-12-31T23:59:59Z', made: '2016-12-31T23:59:60Z' } })).status, 201);
  assert.throws(() => createRestep({ collections: { a: { fields: { at: { type: 'datetime', default: '2016-12-31T23:59:60Z' } }, data: memoryAdapter() } } }), /leap second/);
});
await test('council 5 (5.1): a server-only field is ignored in a POST whatever its value, type included, and never set by a PATCH', async () => {
  const x = createRestep({ collections: { carts: { fields: { note: 'string', total: { type: 'decimal', readOnly: true } },
    data: memoryAdapter([{ id: '1', note: 'a', total: '10.00' }]) } } });
  const r = await call(x, 'POST', '/carts', { body: { note: 'b', total: 42 } });
  assert.equal(r.status, 201);
  assert.ok(!('total' in await r.json()));
  assert.equal((await call(x, 'PATCH', '/carts/1', { body: { total: '10.0' } })).status, 200); // its current value
  const p = await problem(await call(x, 'PATCH', '/carts/1', { body: { total: '11.00' } }), 422, 'invalid');
  assert.deepEqual([p.errors[0].pointer, p.errors[0].code], ['/total', 'read_only']);
});
await test('council 6 (5.3, 11.1): a GET action without params answers any query parameter with unsupported_parameter', async () => {
  for (const q of ['x=1', 'kind=gift', 'limit=5']) {
    const p = await problem(await req('GET', `/books:new?${q}`), 400, 'unsupported_parameter');
    assert.equal(p.parameter, q.split('=')[0]);
  }
  assert.ok(!('params' in (await (await req('GET', '/')).json()).collections.books.actions.new));
});
await test('council 7 (7.2): with upsert and requireIfMatch, If-None-Match: * on a PATCH creates a free id and gives 412 on a taken one', async () => {
  const x = createRestep({ collections: { drafts: { idFrom: 'client', upsert: true, requireIfMatch: true, fields: { text: 'string' }, data: memoryAdapter() } } });
  await problem(await call(x, 'PATCH', '/drafts/a', { body: { text: 'x' } }), 428, 'precondition_required');
  await problem(await call(x, 'PATCH', '/drafts/a', { body: { text: 'x' }, headers: { 'if-none-match': '"abc"' } }), 428, 'precondition_required');
  await problem(await call(x, 'PATCH', '/drafts/a', { body: { text: 'x' }, headers: { 'if-match': '*' } }), 412, 'precondition_failed');
  const c = await call(x, 'PATCH', '/drafts/a', { body: { text: 'x' }, headers: { 'if-none-match': '*' } });
  assert.equal(c.status, 201);
  await problem(await call(x, 'PATCH', '/drafts/a', { body: { text: 'y' }, headers: { 'if-none-match': '*' } }), 412, 'precondition_failed');
  await problem(await call(x, 'PATCH', '/drafts/a', { body: { text: 'y' } }), 428, 'precondition_required');
  assert.equal((await call(x, 'PATCH', '/drafts/a', { body: { text: 'y' }, headers: { 'if-match': c.headers.get('etag') } })).status, 200);
  // 428 comes before 422 (5.4) on the creating PATCH too.
  await problem(await call(x, 'PATCH', '/drafts/b', { body: [] }), 428, 'precondition_required');
  // A deleted id is not free without reusableIds: 404, as before.
  const tag = (await call(x, 'GET', '/drafts/a')).headers.get('etag');
  assert.equal((await call(x, 'DELETE', '/drafts/a', { headers: { 'if-match': tag } })).status, 204);
  await problem(await call(x, 'PATCH', '/drafts/a', { body: { text: 'z' }, headers: { 'if-none-match': '*' } }), 404, 'not_found');
});
await test('council 8 (4.3, 5.9): a singleton declares method_effects with PATCH as its only key', async () => {
  const x = createRestep({ collections: {}, singletons: { me: { fields: { name: 'string' }, methodEffects: { PATCH: [] }, data: memorySingleton({ name: 'a' }) },
    prefs: { fields: { theme: 'string' }, data: memorySingleton({}) } } });
  const doc = await (await call(x, 'GET', '/')).json();
  assert.deepEqual(doc.singletons.me.method_effects, { PATCH: [] });
  assert.ok(!('method_effects' in doc.singletons.prefs));
  const s = (data, methodEffects) => () => createRestep({ collections: {}, singletons: { me: { methodEffects, data } } });
  assert.throws(s(memorySingleton(), { DELETE: [] }), /methodEffects\.DELETE/);
  assert.throws(s(memorySingleton(), { GET: [] }), /methodEffects\.GET/);
  assert.throws(s(memorySingleton(), { PATCH: ['nope'] }), /methodEffects\.PATCH/);
  assert.throws(s({ get: async () => ({}) }, { PATCH: [] }), /methodEffects\.PATCH/); // no update, no PATCH
});
await test('council 11 (3, 5.4): an unpaired surrogate points to the string that holds it; a JSON syntax error wins with 400', async () => {
  const p = await problem(await req('POST', '/books', { body: '{"title":"a","price":"1.00","tags":["ok","\\udc00"]}' }), 422, 'invalid');
  assert.ok(p.errors.some((e) => e.pointer === '/tags/1' && e.code === 'format'));
  const k = await problem(await req('POST', '/books', { body: '{"title":"a","price":"1.00","x\\ud800":1}' }), 422, 'invalid');
  // council b7 r3 10 (3): in a member name, the pointer is "", also in a nested object.
  assert.ok(k.errors.some((e) => e.pointer === '' && e.code === 'format'));
  assert.ok(!k.errors.some((e) => e.pointer.includes('\ud800')));
  await problem(await req('POST', '/books', { body: '{"title":"\\ud800","price":"1.00",' }), 400, 'bad_request');
  await problem(await req('PATCH', '/books/7', { body: '{"title":"\\ud800"', headers: patchH() }), 400, 'bad_request');
});
await test('council 12 (7.1): a replayed body that is not the current representation carries no ETag, _etag or Content-Location', async () => {
  // A store whose saved response has a body without an id to reload: the library cannot show the current item.
  const store = { async reserve(scope, print) { return { print, response: [201, { text: 'old', _etag: '"t1"' }, { ETag: '"t1"', 'Content-Location': '/notes/9' }] }; },
    async complete() {}, async release() {} };
  const x = createRestep({ idempotencyStore: store, collections: { notes: { fields: { text: 'string' }, data: memoryAdapter() } } });
  const r = await call(x, 'POST', '/notes', { body: { text: 'old' }, headers: { 'idempotency-key': '"k"' } });
  assert.equal(r.status, 201);
  assert.equal(r.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual([r.headers.get('etag'), r.headers.get('content-location')], [null, null]);
  assert.deepEqual(await r.json(), { text: 'old' });
  // With an item to reload, the replay is its current representation, with its current ETag and _etag.
  const y = createRestep({ collections: { notes: { fields: { text: 'string' }, data: memoryAdapter() } } });
  const first = await call(y, 'POST', '/notes', { body: { text: 'a' }, headers: { 'idempotency-key': '"k"' } });
  const id = (await first.json()).id;
  const w = await call(y, 'PATCH', `/notes/${id}`, { body: { text: 'b' } });
  const again = await call(y, 'POST', '/notes', { body: { text: 'a' }, headers: { 'idempotency-key': '"k"' } });
  const body = await again.json();
  assert.deepEqual([body.text, body._etag, again.headers.get('etag')], ['b', w.headers.get('etag'), w.headers.get('etag')]);
});

// ── Council decisions on draft 7 (round 3) ──
await test('council b7 r3 1, 2 (5.1): create announces JSON creation; a mixed collection takes JSON as an item; a JSON file needs multipart', async () => {
  const up = (create, mediaTypes, multipart = false) => {
    const files = memoryAdapter();
    return { upload: { mediaTypes, multipart }, fields: { name: 'string' },
      data: { ...files, create: create ? files.create : undefined, upload: (f, ctx) => files.create({ _content: { href: '/b/1', media_type: f.mediaType, size: f.size } }, ctx) } };
  };
  // 2: mediaTypes that admit application/json (also through a wildcard) in a collection that creates from JSON need multipart.
  for (const m of [['application/json'], ['application/*'], ['image/png', 'application/json']])
    assert.throws(() => createRestep({ collections: { f: up(true, m) } }), /multipart: true \(5\.1\)/, m.join());
  const x = createRestep({ collections: { mixed: up(true, ['application/*'], true), only: up(false, ['image/png']), jsonFiles: up(false, ['application/json']) } });
  const doc = await (await call(x, 'GET', '/')).json();
  // 1: with data.create the collection publishes create; without it, none, and it only takes uploads.
  assert.equal(doc.collections.mixed.schemas.create.type, 'object');
  assert.deepEqual([doc.collections.only.schemas.create, doc.collections.jsonFiles.schemas.create], [undefined, undefined]);
  const o = await call(x, 'POST', '/only', { body: { name: 'x' } });
  await problem(o, 415, 'unsupported_media_type');
  assert.equal(o.headers.get('accept-post'), 'image/png');
  // 2: in the mixed collection, a POST with application/json is an item creation, never a file.
  const item = await call(x, 'POST', '/mixed', { body: { name: 'x' } });
  assert.equal(item.status, 201);
  const made = await item.json();
  assert.deepEqual([made.name, made._content], ['x', undefined]);
  // A JSON file goes only as the file part of multipart/form-data.
  const boundary = 'b0';
  const mp = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.json"\r\nContent-Type: application/json\r\n\r\n{"name":"y"}\r\n--${boundary}--\r\n`;
  const file = await call(x, 'POST', '/mixed', { body: mp, type: `multipart/form-data; boundary=${boundary}` });
  assert.equal(file.status, 201);
  assert.equal((await file.json())._content.media_type, 'application/json');
});
await test('council b7 r3 3, 4 (3): a leap second in a localdatetime gives 422 format; in a server-only field of a POST it is ignored', async () => {
  const x = createRestep({ collections: { runs: { fields: { local: 'localdatetime', locals: { type: 'list', items: 'localdatetime' },
    stamped: { type: 'localdatetime', readOnly: true }, seen: { type: 'datetime', readOnly: true } }, data: memoryAdapter([{ id: '1', local: '2027-01-01T00:00:00' }]) } } });
  const p = await problem(await call(x, 'POST', '/runs', { body: { local: '2016-12-31T23:59:60' } }), 422, 'invalid');
  assert.deepEqual([p.errors[0].pointer, p.errors[0].code], ['/local', 'format']);
  const l = await problem(await call(x, 'POST', '/runs', { body: { locals: ['2016-12-31T23:59:59', '2016-12-31t23:59:60.5'] } }), 422, 'invalid');
  assert.deepEqual([l.errors[0].pointer, l.errors[0].code], ['/locals/1', 'format']);
  const q = await problem(await call(x, 'PATCH', '/runs/1', { body: { local: '2016-12-31T23:59:60' } }), 422, 'invalid');
  assert.deepEqual([q.errors[0].pointer, q.errors[0].code], ['/local', 'format']);
  // 3: never written: a default with one is a configuration error.
  assert.throws(() => createRestep({ collections: { r: { fields: { local: { type: 'localdatetime', default: '2016-12-31T23:59:60' } }, data: memoryAdapter() } } }), /leap second/);
  // 4: a server-only field in a POST is ignored whatever its value, a leap second included.
  const r = await call(x, 'POST', '/runs', { body: { local: '2027-01-01T00:00:00', stamped: '2016-12-31T23:59:60', seen: '2016-12-31T23:59:60Z' } });
  assert.equal(r.status, 201);
  const made = await r.json();
  assert.deepEqual([made.stamped, made.seen], [undefined, undefined]);
});
await test('council b7 r3 5 (7.3): a replay of a 201 without body carries no ETag, even if the item still exists', async () => {
  const x = createRestep({ collections: { notes: { fields: { text: 'string' }, data: memoryAdapter() } } });
  const h = { 'idempotency-key': '"m"', prefer: 'return=minimal' };
  const first = await call(x, 'POST', '/notes', { body: { text: 'a' }, headers: h });
  assert.equal(first.status, 201);
  assert.equal(await first.text(), '');
  const again = await call(x, 'POST', '/notes', { body: { text: 'a' }, headers: h });
  assert.equal(again.status, 201);
  assert.equal(again.headers.get('idempotent-replayed'), 'true');
  assert.equal(again.headers.get('location'), first.headers.get('location'));
  assert.equal((await call(x, 'GET', first.headers.get('location'))).status, 200); // the item exists
  assert.deepEqual([again.headers.get('etag'), again.headers.get('content-location'), await again.text()], [null, null, '']);
});
await test('council b7 r3 6 (7.2): with upsert and requireIfMatch, If-None-Match with a list of tags gives 428; only * creates', async () => {
  const x = createRestep({ collections: { drafts: { idFrom: 'client', upsert: true, requireIfMatch: true, fields: { text: 'string' }, data: memoryAdapter([{ id: 'b', text: 'b' }]) } } });
  for (const h of ['"x", "y"', 'W/"x"', '"x", *'])
    await problem(await call(x, 'PATCH', '/drafts/a', { body: { text: 'x' }, headers: { 'if-none-match': h } }), 428, 'precondition_required');
  await problem(await call(x, 'PATCH', '/drafts/b', { body: { text: 'x' }, headers: { 'if-none-match': '"x", "y"' } }), 428, 'precondition_required');
  assert.equal((await call(x, 'PATCH', '/drafts/a', { body: { text: 'x' }, headers: { 'if-none-match': ' * ' } })).status, 201);
});
await test('council b7 r3 7 (6.1, 11.1): integer and number operands follow the RFC 8259 number grammar, also in GET action params', async () => {
  const x = createRestep({ collections: { items: { fields: { n: 'integer', x: 'number', d: 'decimal' }, filter: { n: ['eq', 'in'], x: ['eq', 'in'], d: ['eq'] },
    newItem: () => ({}), newParams: { n: { type: 'integer' }, ns: { type: 'integer', list: true }, x: { type: 'number' } },
    data: memoryAdapter([{ id: '1', n: 20, x: 20, d: '20.00' }, { id: '2', n: 0, x: 0.5, d: '0.5' }]) } } });
  for (const v of ['20', '2e1', '2E%2B1', '200e-1', '20.0']) {
    assert.deepEqual(await ids(await call(x, 'GET', `/items?filter[n]=${v}`)), ['1'], v);
    assert.deepEqual(await ids(await call(x, 'GET', `/items?filter[x]=${v}`)), ['1'], v);
  }
  assert.deepEqual(await ids(await call(x, 'GET', '/items?filter[x]=5e-1')), ['2']);
  assert.deepEqual(await ids(await call(x, 'GET', '/items?filter[n]=-0')), ['2']);
  for (const v of ['%2B20', '.5', '020', '0x14', '2e', '1.', '-', '00', 'Infinity'])
    for (const f of ['n', 'x']) await problem(await call(x, 'GET', `/items?filter[${f}]=${v}`), 400, 'invalid_parameter');
  for (const v of ['%2B20', '020', '0x14']) await problem(await call(x, 'GET', `/items?filter[n][in]=1,${v}`), 400, 'invalid_parameter');
  // decimal keeps its own grammar: no exponent.
  await problem(await call(x, 'GET', '/items?filter[d]=2e1'), 400, 'invalid_parameter');
  // GET action params, each element of a list too.
  assert.equal((await call(x, 'GET', '/items:new?n=2e1&ns=1,2.0,3e0&x=5e-1')).status, 200);
  for (const q of ['n=020', 'n=%2B20', 'n=2.5', 'ns=1,020', 'ns=1,0x14', 'x=.5', 'x=0x14'])
    await problem(await call(x, 'GET', `/items:new?${q}`), 400, 'invalid_parameter');
});
await test('council b7 r3 8, 9 (6.1): a null-only filter may declare quantifier some; null with a quantifier tests the group, never an element', async () => {
  const rows = [{ id: '1', tags: ['a', null], rel: [{ id: 't1' }] }, { id: '2', tags: ['b'], rel: [] }, { id: '3', tags: [] }, { id: '4' }];
  const books = (filter) => createRestep({ collections: { t: { fields: { name: 'string' }, data: memoryAdapter([{ id: 't1' }]) },
    b: { fields: { tags: { type: 'list', items: 'string' }, rel: { type: 'relation', to: 't', many: true } }, filter, data: memoryAdapter(rows) } } });
  // 8: with null as its only operator, omitting quantifier or declaring "some" selects the same.
  const without = books({ tags: ['null'], rel: ['null'] }), withSome = books({ tags: { ops: ['null'], quantifier: 'some' }, rel: { ops: ['null'], quantifier: 'some' } });
  const doc = await (await call(withSome, 'GET', '/')).json();
  assert.deepEqual(doc.collections.b.filter.tags, { type: 'string', ops: ['null'], quantifier: 'some' });
  for (const q of ['filter[tags][null]=true', 'filter[tags][null]=false', 'filter[rel][null]=true', 'filter[rel][null]=false'])
    assert.deepEqual(await ids(await call(withSome, 'GET', `/b?${q}`)), await ids(await call(without, 'GET', `/b?${q}`)), q);
  // 9: alone, null: true is an empty, absent or null group; a null element does not make it true.
  assert.deepEqual(await ids(await call(without, 'GET', '/b?filter[tags][null]=true')), ['3', '4']);
  assert.deepEqual(await ids(await call(without, 'GET', '/b?filter[tags][null]=false')), ['1', '2']);
  // With in: true is "no element matches", false is "some element matches".
  const mixed = books({ tags: { ops: ['in', 'null'], quantifier: 'some' }, 'rel.id': { ops: ['eq', 'null'], quantifier: 'some' } });
  assert.deepEqual(await ids(await call(mixed, 'GET', '/b?filter[tags][in]=a,z&filter[tags][null]=true')), ['2', '3', '4']);
  assert.deepEqual(await ids(await call(mixed, 'GET', '/b?filter[tags][in]=a,z&filter[tags][null]=false')), ['1']);
  // null on rel.id tests the relationship, not whether some related item's id is null.
  assert.deepEqual(await ids(await call(mixed, 'GET', '/b?filter[rel.id][null]=true')), ['2', '3', '4']);
  assert.deepEqual(await ids(await call(mixed, 'GET', '/b?filter[rel.id][null]=false')), ['1']);
  assert.deepEqual(await ids(await call(mixed, 'GET', '/b?filter[rel.id]=t1&filter[rel.id][null]=true')), ['2', '3', '4']);
});
await test('council b7 r4 1a, 1b, 2, 4b (5.1): JSON as a file by wildcard; +json is a file; outer multipart needs multipart; filename optional', async () => {
  const up = (create, mediaTypes, multipart = false) => {
    const files = memoryAdapter();
    return { upload: { mediaTypes, multipart }, fields: { name: 'string' },
      data: { ...files, create: create ? files.create : undefined,
        upload: (f, ctx) => files.create({ name: f.filename ?? null, _content: { href: '/b/1', media_type: f.mediaType, size: f.size } }, ctx) } };
  };
  const x = createRestep({ collections: { app: up(false, ['application/*']), any: up(false, ['*/*']), img: up(false, ['image/*']),
    mixed: up(true, ['application/ld+json']), multi: up(false, ['*/*', 'multipart/*']), parts: up(false, ['image/png'], true) } });
  const doc = await (await call(x, 'GET', '/')).json();
  assert.deepEqual(doc.collections.any.upload.media_types, ['*/*']);
  // 1a: in an upload-only collection, application/* or */* admits application/json as a file.
  for (const c of ['app', 'any']) {
    const r = await call(x, 'POST', `/${c}`, { body: { name: 'x' } });
    assert.equal(r.status, 201, c);
    assert.deepEqual([(await r.json())._content.media_type], ['application/json'], c);
  }
  // Media types that do not admit it: 415.
  await problem(await call(x, 'POST', '/img', { body: { name: 'x' } }), 415, 'unsupported_media_type');
  // 1b: a +json type is a file; only top-level application/json selects creation from JSON.
  const ld = await call(x, 'POST', '/mixed', { body: '{"name":"x"}', type: 'application/ld+json' });
  assert.equal(ld.status, 201);
  assert.deepEqual([(await ld.json())._content.media_type], ['application/ld+json']);
  const item = await call(x, 'POST', '/mixed', { body: { name: 'x' } });
  assert.deepEqual([item.status, (await item.json())._content], [201, undefined]);
  const ldFile = await call(x, 'POST', '/app', { body: '{}', type: 'application/ld+json' });
  assert.deepEqual([ldFile.status, (await ldFile.json())._content.media_type], [201, 'application/ld+json']);
  // 2: an outer multipart/form-data without multipart: true gives 415, even when mediaTypes match it.
  const part = (head) => `--B\r\n${head}\r\nContent-Type: image/png\r\n\r\nx\r\n--B--\r\n`;
  for (const c of ['any', 'multi'])
    await problem(await call(x, 'POST', `/${c}`, { body: part('Content-Disposition: form-data; name="file"; filename="a.png"'), type: 'multipart/form-data; boundary=B' }), 415, 'unsupported_media_type');
  // multipart/mixed is not form-data: with mediaTypes that match it, it is a file like any other.
  assert.equal((await call(x, 'POST', '/multi', { body: 'x', type: 'multipart/mixed; boundary=B' })).status, 201);
  // 4b: the server does not require filename on the file part.
  const noName = await call(x, 'POST', '/parts', { body: part('Content-Disposition: form-data; name="file"'), type: 'multipart/form-data; boundary=B' });
  assert.equal(noName.status, 201);
  assert.deepEqual([(await noName.json())._content.media_type], ['image/png']);
});
await test('council b7 r4 5a, 5b (6.1): two null filters on one group give invalid_parameter; null=true with others is "none matches all"', async () => {
  const rows = [{ id: '1', tags: ['a', 'b'], rel: [{ id: 't1' }, { id: 't2' }] }, { id: '2', tags: ['a'], rel: [{ id: 't1' }] }, { id: '3', tags: [] }];
  const x = createRestep({ collections: { t: { fields: { name: 'string' }, data: memoryAdapter([{ id: 't1', name: 'one' }, { id: 't2', name: 'two' }]) },
    b: { fields: { tags: { type: 'list', items: 'string' }, rel: { type: 'relation', to: 't', many: true } },
      filter: { tags: { ops: ['eq', 'in', 'null'], quantifier: 'some' }, rel: ['null'], 'rel.id': { ops: ['eq', 'in', 'null'], quantifier: 'some' } }, data: memoryAdapter(rows) } } });
  // 5a: its own and that of a path through it, even when the values agree.
  for (const q of ['filter[rel][null]=true&filter[rel.id][null]=true', 'filter[rel.id][null]=false&filter[rel][null]=true', 'filter[rel][null]=false&filter[rel.id][null]=false'])
    assert.equal((await problem(await call(x, 'GET', `/b?${q}`), 400, 'invalid_parameter')).parameter, q.split('&')[1].split('=')[0], q);
  // 5b: true is "no visible element matches all the other filters of the group at once".
  // Row 1 has b and a, but no element that is both b and in {a, c}.
  assert.deepEqual(await ids(await call(x, 'GET', '/b?filter[tags]=b&filter[tags][in]=a,c&filter[tags][null]=true')), ['1', '2', '3']);
  assert.deepEqual(await ids(await call(x, 'GET', '/b?filter[tags]=a&filter[tags][in]=a,c&filter[tags][null]=true')), ['3']);
  assert.deepEqual(await ids(await call(x, 'GET', '/b?filter[rel.id]=t2&filter[rel.id][in]=t1,x&filter[rel.id][null]=true')), ['1', '2', '3']);
  assert.deepEqual(await ids(await call(x, 'GET', '/b?filter[rel.id]=t2&filter[rel.id][in]=t1,t2&filter[rel.id][null]=true')), ['2', '3']);
});
await test('council b7 r4 6 (5.3, 6.1): a numeric operand over the limit gives invalid_parameter with the limit; never infinity or zero', async () => {
  const x = createRestep({ collections: { items: { fields: { n: 'integer', x: 'number' }, filter: { n: ['eq', 'lt', 'in'], x: ['eq', 'gt', 'in'] },
    data: memoryAdapter([{ id: '1', n: 20, x: 0 }, { id: '2', n: -5, x: 1e-10 }]) } } });
  // Outside the field's range, within the limit: compared as a number.
  assert.deepEqual(await ids(await call(x, 'GET', '/items?filter[n][lt]=1e300')), ['1', '2']);
  assert.deepEqual(await ids(await call(x, 'GET', '/items?filter[n][lt]=-99999999999999999999')), []);
  assert.deepEqual(await ids(await call(x, 'GET', '/items?filter[x][gt]=1e-300')), ['2']);
  assert.deepEqual(await ids(await call(x, 'GET', '/items?filter[x]=0e-99999999999999999999')), ['1']);
  for (const q of ['n][lt]=1e301', 'n][lt]=1.0000001e300', 'n]=-1e99999999999999999999', 'n][in]=1,1e400', 'x][gt]=1e-301', 'x]=-1e-400', 'x]=1e400', 'x][in]=0,9e-99999999999999999999']) {
    const p = await problem(await call(x, 'GET', `/items?filter[${q}`), 400, 'invalid_parameter');
    assert.match(p.detail, /1e-300 to 1e300/, q);
  }
});
await test('council b7 r3 10 (3): an unpaired surrogate or noncharacter in a member name, also nested, points to ""', async () => {
  for (const body of ['{"title":"a","price":"1.00","x\\ud800":1}', '{"title":"a","price":"1.00","tags":[{"\\ufdd0":1}]}']) {
    const p = await problem(await req('POST', '/books', { body }), 422, 'invalid');
    assert.ok(p.errors.some((e) => e.pointer === '' && e.code === 'format'), body);
  }
});

// ── 3. Framework adapters ──
console.log('adapters');
if (!unit) await test('Express: with a body parser that already consumed the body, mounted under /api', async () => {
  const handler = toExpress(createRestep({ base: '/api', collections: { notes: { fields: { text: 'string' }, data: memoryAdapter() } } }));
  // Simulates express.json() and the app.use('/api', ...) mount: req.url loses /api, originalUrl keeps it.
  const server = await listen(async (req, res) => {
    req.originalUrl = req.url;
    req.url = req.url.replace(/^\/api/, '') || '/';
    if (req.method === 'POST') { let s = ''; for await (const c of req) s += c; req.body = JSON.parse(s); }
    handler(req, res, (e) => { res.writeHead(500); res.end(String(e)); });
  });
  const port = server.address().port;
  try {
    const r = await fetch(`http://localhost:${port}/api/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"hola"}' });
    assert.equal(r.status, 201);
    assert.equal(r.headers.get('location'), '/api/notes/1');
    const l = await (await fetch(`http://localhost:${port}/api/notes`)).json();
    assert.deepEqual(l.items.map(({ _etag, ...x }) => x), [{ id: '1', text: 'hola' }]);
  } finally { server.close(); }
});
await test('Hono: the handler receives c.req.raw', async () => {
  const h = toHono(api);
  const r = await h({ req: { raw: new Request('http://api.test/books/7') } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).id, '7');
});

console.log(`\n${failed ? 'FAILING' : 'All good'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
