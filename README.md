# restep-server (prototype)

A library for writing a [Restep 1](https://restep.wubytes.com/1/) server (draft 6: discovery
declares `"restep": "1.0-draft.6"`) without implementing the protocol by hand: you declare the collections and write the access to your data;
the library does the rest. One file, Node 18+, no dependencies.

The core only uses the standard Web APIs (`Request`, `Response`, `URL`, Web Crypto):
`createRestep(...)` returns `handle(request) => Promise<Response>`, which works the same on Node,
Deno, Bun or Cloudflare Workers. There are thin adapters for Node http, Express and Hono.

```bash
npm install restep-server
```

## Minimal example

```js
import { createServer } from 'node:http';
import { createRestep, memoryAdapter, toNodeListener } from './restep-server.mjs';

const api = createRestep({
  collections: {
    books: {
      fields: {
        title: { type: 'string', required: true },
        price: { type: 'decimal', required: true },
        category: { type: 'enum', values: ['novela-negra', 'poesia'] },
      },
      filter: { price: ['lt', 'le', 'gt', 'ge'], category: ['eq', 'in'] },
      sort: ['title', 'price'],
      count: 'exact',
      data: memoryAdapter([{ id: '7', title: 'La niebla de Portugalete', price: '18.50', category: 'novela-negra' }]),
    },
  },
});
createServer(toNodeListener(api)).listen(8080);
```

That already gives you discovery at `/`, `GET/HEAD /books` with filters, sorting, `fields`, `limit`,
cursors and `count`, and `GET/PATCH/DELETE /books/7` and `POST /books` with validation, Merge Patch,
`ETag`, `If-Match` and `Idempotency-Key`. A full example, with language maps, relations,
dates, durations, a custom validation rule, client-chosen `id`s, a collation,
a singleton and optional oauth, is in [`example-api.mjs`](example-api.mjs) (started by
[`example.mjs`](example.mjs)):

```bash
PORT=8810 node tools/restep-server/example.mjs
npx restep-check http://localhost:8810/ --writes      # 0 failed
```

## Your part: the data adapter

Each collection takes in `data` an object with these methods. `list` and `get` are required; the
rest are optional and, if missing, their HTTP method disappears from the collection (`methods`,
`item_methods` and the `Allow` of `405` responses are computed for you).

| Method | Receives | Returns |
|---|---|---|
| `list(query, ctx)` | `{ filter, sort, limit, cursor, count, fields }` | `{ items, next, total }` |
| `get(id, ctx)` | the `id` from the URL (before `PATCH` and `DELETE`, with `ctx.forUpdate: true`: lock it if there is a transaction) | the item or `null` (gives `404`) |
| `create(data, ctx)` | the already validated body, without `_` members; with `id` only if the client chose it (`idFrom`) | the saved item, with its `id` (the client's, if it chose one) |
| `update(id, data, ctx)` | the full item, already merged and validated (`ctx.patch`: the patch; `ctx.current`: the previous state). Not called if the `PATCH` changes no data (5.1) | the saved item |
| `delete(id, ctx)` | the `id` | nothing |
| `taken(id, ctx)` | a client-chosen `id`; only with `idFrom: 'client'` or `'either'`, where it is required | `true` if the collection has or had that `id`, whether this principal can see it or not (5.1) |

- `filter` is a list of `{ field, op, value, type }` with the value already converted to its type (an
  `in` brings a list; a `null`, a boolean). `sort` is `[{ field, desc, type }]` and always
  ends in `id`, as a tiebreaker. `field` can be `field`, `map.tag` or `relation.id`.
- A named filter (`namedFilters`, 6.1) arrives in `filter` as `{ named, value }`: `value` is
  `true` for a switch, and the already converted value for one with `type`. Your adapter translates it by its
  name (an ORM scope, a subquery, a text search). `memoryAdapter` uses the `apply`
  from its declaration, which also arrives in the filter.
- `cursor` is whatever your `list` returned in `next` for the previous page (an offset, a
  key, anything that is JSON), or `null` on the first one. The library signs it with HMAC and
  binds it to the collection, the filters, the sort order and the principal, so you never get a
  tampered one or one from another query.
- `fields` is only a hint: you may return whole items. If the collection has `update`
  or `delete`, it arrives as `null`, because the `_etag` of each listed item is computed over the
  full representation.
- `ctx` carries `request`, `principal`, `lang` and `collection`.
- `get` compares the `id` code point by code point (3): `07` is not `7`. If your key is
  numeric, do not turn `"07"` into `7` (the library gives `404` anyway if the item you
  return has a different `id`). `get` also returns `null` for an item this principal cannot
  see: that way the `404` and the `unknown` entry of a relation are the same in both cases (5.1).
- With `idFrom: 'client'` or `'either'` (5.1), used `id`s are never reused: `taken` has
  to remember those of deleted items for as long as the collection exists (or a hash of them), and
  the `id` your `create` assigns when the client sends none cannot be one the collection has
  had. Across processes, your primary key has to reject the duplicate: throw
  `takenError()` (exported) from `create`.
- Filters and sort fields arrive with `collation` (`"codepoint"` or `"server"`, 6.1). With
  `"server"`, equality and ordering are yours (a database collation): total,
  deterministic and consistent with each other. If a field cannot be read on an item by this
  principal, your `list` treats it as absent (6.1), and `total` counts only what it sees (6.5): the
  library does not know what each principal can read.
- For domain errors, throw `new RestepError(409, 'conflict', 'Already exists.', { reason: 'duplicate' })`.
  Any other exception gives `500 internal` and goes through `onError`.
- `memoryAdapter(rows)` implements everything in memory for tests and examples, `taken` included; its
  `"server"` collation ignores case and accents (`Intl.Collator` with `sensitivity: 'base'`).
  `memorySingleton(object)` is the same for a singleton. It also exports the pieces for your own
  adapter: `matches`, `sorter`, `compareValues` and `valueAt`, with the comparison rules
  of 6.1 (exact decimals, dates and instants, durations, text by code point or with the
  `"server"` collation).

## What the library does

- **Discovery (1.1, 4.2, 4.3)**: `"restep": "1.0-draft.6"`, profiles (`core`, `query`,
  `writes` if there are writes, `cache`), `idempotency` (with `anonymous: false` if asked), `status`,
  collections with `description`, `methods`, `item_methods`, `id_from`, `filter` with types and
  operators, `sort`, `collations`, `max_limit`, `count`, `language_maps`, `relations` and
  `item`, `create` and `update` JSON Schemas generated from the fields, and `singletons`. The
  same document for every principal (only the texts change, with `Accept-Language`), with
  `ETag`, `304` and `Vary: Accept-Language`; `private` when there is a principal. It adds no custom members.
- **Names (3)**: at startup it rejects collections, singletons, fields and named filters that do not
  match `ALPHA *63( ALPHA / DIGIT / "_" / "-" )`; a malformed `reason` in a `RestepError` gives `500`.
- **Paths (3)**: each segment is compared after percent-decoding (`/books/%37` is `/books/7`;
  `/books/07` is not).
- **Profile header (4.1)** on every API response.
- **Parameters (5.3, 6)**: rejects every reserved parameter the resource does not implement for that
  method (`unsupported_parameter`) and every wrong value (`invalid_parameter`), always with
  `parameter`: undeclared filters and operators, types, empty `in`, the same filter twice
  (also `filter[f]` with `filter[f][eq]`), durations with years or months, `limit` out of range,
  `fields` entries that do not exist or reach into a language map, tampered cursors or cursors from
  another query, repeated parameters, `$whatever`.
- **Errors (5.4)**: `problem+json` with `type`, `title`, `status`, `code` and `detail`, in the order
  of draft 6: `401`/`403` → `404` → `405` → `400` for parameters and headers → `400` for the body,
  `415` and `413` → replay and `409 request_in_progress` → `428` → `412` → `422` → `409 conflict`.
- **Writes (3, 5.1, 7)**: `Content-Type: application/json` required (for `PATCH`, also
  `application/merge-patch+json`), with `utf-8` as the only `charset`: any other type, another `charset`
  or none gives `415` (with `Accept-Patch` on a `PATCH`), and an empty body with `application/json`
  gives `400`. `201` with `Location`, Merge Patch (RFC 7396) with the Restep exceptions
  (relations are replaced whole and only their `id` is read; language maps are merged and end up
  as `{}`), `_` members ignored, `422 invalid` with `errors` and `pointer`, `413` for size,
  `Prefer: return=minimal`. A `PATCH` that changes no data touches neither the item nor its ETag.
  A relation set to its current value is ignored without checking it; one pointing to an item that
  does not exist gives `422` with `unknown` at `/relation/id`.
- **`id` (5.1)**: with `idFrom` undeclared or `'server'`, an `id` in the `POST` gives `422` with
  `read_only` at `/id`. With `'client'` (mandatory, `required` if missing) or `'either'`
  (optional), it validates it (`type`, `format`, and `idPattern` if you give one) and gives `409 conflict`
  with `taken` at `/id` for one the collection has or had, after the `422`s.
- **Concurrency (7.2)**: strong ETag of the full item, computed without `_etag`; `_etag` in every
  response whose body is an item (its `GET`, with or without `fields`, the `201` of the `POST` and the `200`
  of the `PATCH`) and in each item of a listing when it allows `PATCH` or `DELETE` (the same ETag as
  its `GET`, computed over the full representation even with `fields`), `If-Match`
  (lists, `*`, strong comparison) evaluated atomically with the write within the process
  and, with `createTransaction` and `ctx.forUpdate`, across processes,
  `If-None-Match` (`304` on reads, `412` on writes) and `428` with `requireIfMatch: true`.
- **Idempotency (7.1)**: `Idempotency-Key` as a Structured Fields string without parameters (a
  malformed one gives `400 bad_request` with a `header` entry), per principal and target (method and
  decoded path, without the query); two requests are the same if, in addition, their query (after
  decoding, in any order) and their bodies as JSON values match. Replay with `Idempotent-Replayed: true`,
  `422 idempotency_mismatch` (also while the first one is still in progress), `409
  request_in_progress` with `Retry-After` for the same request while the first is still in progress, `400
  idempotency_key_required` with `requireIdempotencyKey: true`. A rejected request does not use up the key.
  With `idempotencyAnonymous: false`, discovery says `"anonymous": false` and a `POST` without
  credentials (no principal) carrying the key gives `400 bad_request` with the `unknown` entry before
  any effect, and `requireIdempotencyKey` does not apply to those requests.
- **Caching (`cache` profile, 8)**: `Cache-Control` on every response to `GET` and `HEAD`, errors
  included (`private` if there is a principal; errors, `no-store`), ETag on items, collections,
  singletons and discovery, `304` with `If-None-Match`, `Cache-Groups` on reads and
  `Cache-Group-Invalidation` on writes. A response with a principal is `private` even
  without this profile (5.1).
- **Singletons (5.9)**: `singletons: { me: { path, description, fields, data } }` with `data.get(ctx)`
  and, for `PATCH`, `data.update(merged, ctx)`. `GET`/`HEAD` with `fields`, ETag, `_etag` and `304`;
  `PATCH` like an item's (validation, `If-Match`, `428` with `requireIfMatch`, no write when nothing
  changes); `POST` and `DELETE` give `405`; `include` and the other reserved parameters,
  `unsupported_parameter`. Relations carry `href`. No `id`, no language maps, no actions.
- **Origin (5.8)**: a `POST`, `PATCH` or `DELETE` authenticated with credentials the browser
  adds on its own, whose `Origin` is neither the API's nor one of `cors.origins`, gives `403 forbidden` with no
  effect (`Origin: null` is fine with `Sec-Fetch-Site: same-origin`; without `Origin`,
  `Sec-Fetch-Site` decides). See `browserCredentials`.
- **Language (5.6)**: the library's texts (errors, descriptions) in English and Spanish,
  chosen with RFC 4647 *lookup*; yours can be `t('en', 'es')`. Data never changes.
- **Language maps (3)**: tag validation (`format`), types and unsupported tags
  (`unknown`, with the `languageTags` option), filtering and sorting by exact `field.tag`.
- **Service status (4.4)** with `status: { path: '/health', check: async () => true }`.
- **oauth (11.5)** with `oauth: { authorizationServers, scopesSupported, verifyToken(token, request) }`:
  RFC 9728 metadata at its URL, `WWW-Authenticate` challenges with `resource_metadata` only at the root.
  Without oauth, `authenticate(request)` can return a principal or throw a 401/403 `RestepError`.

## `createRestep` options

| Option | Default | Purpose |
|---|---|---|
| `collections` | (required) | `{ name: { fields, filter, namedFilters, sort, defaultSort, collations, maxLimit, defaultLimit, count, path, description, idFrom, idPattern, validate, newItem, requireIfMatch, requireIdempotencyKey, data } }`. `collations`: `{ field: 'codepoint' \| 'server' }` (6.1), only `string` fields (or `field.tag`) in `filter` or `sort`, never `id`. `idFrom`: `'server'`, `'client'` or `'either'` (5.1). `idPattern`: regular expression that restricts the client's `id`, also in the `create` schema |
| `singletons` | — | `{ name: { path, description, fields, validate, requireIfMatch, data } }` (5.9) |
| `base` | `''` | Path of the API root, such as `/api` |
| `version` | `'1'` | The `version` of the discovery document: your API's major version, the one in its path (`/v2/` → `'2'`, 5.5) |
| `languages` | `['en', 'es']` | Languages of the texts; the first one is the default |
| `languageTags` | any | Tags the language maps accept |
| `secret` | random | Cursor key; set it if there are several instances |
| `createTransaction` | — | Wraps each write (`POST`, `PATCH`, `DELETE`) in an adapter transaction: the creation with its idempotency record, and `If-Match` with the write; see "Persistence" |
| `idempotencyStore` | in memory | Key store; a durable one with `reserve`, `complete` and `release` |
| `idempotencyTtl` | `86400` | Seconds (minimum 86400) |
| `idempotencyAnonymous` | `true` | `false` rejects `Idempotency-Key` without credentials and declares it (7.1). Going from `true` to `false` is a breaking change (5.5) |
| `browserCredentials` | `'auto'` (`false` with `oauth`) | Whether a request's credentials are added by the browser on its own (5.8). `'auto'`: if it carries `Cookie` or `Authorization: Basic`/`Digest`. `true`: always (a client certificate is not visible from `Request`). `false`: only tokens in `Authorization`. Or a function `(request) => boolean`. The allowed origins are the API's (`publicOrigin` or the request's) and those in `cors.origins` |
| `maxBodyBytes` | 1 MiB | More gives `413` |
| `cors` | — | `true` (any origin) or `{ origins: [...] }` (5.8): answers the preflight without Restep rules and exposes `ETag`, `Location`, `Link`, `Allow`, `Accept-Patch`, `Accept-Query`, `Retry-After`, `Deprecation`, `Sunset`, `Idempotent-Replayed`, `Preference-Applied`, `DPoP-Nonce`… to browser clients. With a list of origins, every response carries `Vary: Origin`, also without `Origin` or with a disallowed origin |
| `docs` | — | Documentation URL, or a list of `{ href, hreflang, title }`: it goes as `Link: rel="service-doc"` in discovery (4.2, SHOULD) |
| `status`, `oauth`, `authenticate` | — | See above |
| `publicOrigin` | the request's | Public origin behind a proxy (for oauth and for the `Origin` check) |
| `onError` | `console.error` | Receives the exceptions that end in `500` |

The field types are those of discovery (`string`, `integer`, `number`, `decimal`,
`boolean`, `date`, `datetime`, `duration`, `enum` with `values`) plus `map` (language map) and
`relation` (to-one, with `to`). A field can carry `required: true` and `description`. `validate(row,
ctx)` returns a list of `errors` entries for custom rules (see the cycle rule in the example).
Field names follow the grammar of 3; one that does not will not start.

### Forms (4.3)

With these options, the `create` schema guides a client that renders a creation form:

| On the field | In the schema | What it does |
|---|---|---|
| `title: t('Title', 'Título')` | `title`, in the request's language | Field label |
| `description` | `description` | Help text |
| `default: 'novela-negra'` | `default`, only in `create` | Initial value. A `POST` without the field saves it with that value (a `null` does count as bringing it). A required field with `default` is no longer in the `create` schema's `required` |
| `labels: { 'novela-negra': t('Crime', 'Novela negra'), … }` | `oneOf` of `const` with `title`, instead of `enum` | Options of an `enum` with their label |
| `examples: ['PT6H']` | `examples` | Examples for the placeholder; never sent |

Fields come out in the order they are declared in `fields`, which is the order they are shown in.

For what depends on the client or the moment (today's date, their shop), `newItem: (ctx) => body`
adds the action `GET /collection:new` (`actions` extension, 11.1). It returns the `default`s and, on top,
whatever `newItem` returns, with `Cache-Control: private, no-store`, and creates nothing. It is the trial that
the spec's future work cites (Appendix B), so it may change.

## Framework adapters

```js
createServer(toNodeListener(api)).listen(8080);       // Node http
app.use(toExpress(api));                               // Express (with base: '/api' if mounted with app.use('/api', …))
app.all('*', toHono(api));                             // Hono
export default { fetch: api.handle };                  // Cloudflare Workers, Deno, Bun
```

`toExpress` uses `req.originalUrl` and, if a body parser already read the body, serializes it again.
Better to mount it before `express.json()`: that parser answers malformed JSON on its own,
without `problem+json`.

## Profiles covered and not covered

Discovery only announces what it complies with: `core`, `query`, `cache`, `writes` (if any
collection or singleton writes), `actions` (if there is `newItem`) and `oauth` (if configured).

| Profile or extension | Status |
|---|---|
| `core` | Yes, except deprecations (`deprecations`, `Deprecation`, `Sunset`, 5.5), custom read-only fields (only `id` is one), `406` for `Accept` (it always answers JSON) and major versions (`/v2/`) |
| `query` | Yes. `"server"` collations and fields a principal cannot read are handled by your adapter |
| `writes` | Yes. With several instances or persistence, only with a transactional adapter such as the PostgreSQL one ([`pg.mjs`](#postgresql)); the library's own `If-Match` lock only coordinates one process |
| `cache` | Yes (since draft 6 it is a separate profile; the library already did what it asks) |
| `oauth` | Yes, without per-request scopes: a `403 insufficient_scope` is thrown by your `verifyToken` or your adapter |
| `relations` | No: it does not announce the profile, does no `include`, and has no subcollections (`path` with a template and `parent`). To-one relations are declared, validated and filterable by `relation.id` |
| `sync` | No: no collection declares `sync` and `:changes` gives `404` |
| `actions` | Only the `new` action of collections with `newItem`; any other path with a colon gives `404` |
| `inherit` | No: it neither announces it nor declares `inherit` |
| `batch`, `filter-expr`, `query-method` | No: their parameters and paths fail loudly (`unsupported_parameter`, `404`) |

### Draft 6, rule by rule

| Rule (draft 6) | Where |
|---|---|
| `"restep": "1.0-draft.6"` (1.1) | Library |
| Stable or experimental status (1.2) | Does not apply: it announces no experimental part |
| `cache` separate from `writes`; `private` on every response with credentials (5.1, 8) | Library: announces `cache`; `private` when there is a principal. Making your `authenticate` return a principal for every request with credentials is up to you |
| `inherit` as an extension (11.6) | Not implemented, not announced |
| `id_from`, `taken`, deleted `id`s not reused (5.1) | Library, with the adapter's `taken` (memory: yes; `pg.mjs`: does not support `idFrom`) |
| `collations` (6.1) | Declaration and validation in the library; the `"server"` collation is applied by the adapter (`memoryAdapter`: case- and accent-insensitive) |
| `singletons` (5.9) | Library, without `id`, language maps or actions |
| Subcollections with `parent` (4.2) | Not implemented: a `path` with a template will not start |
| `415` and `charset` on writes (3, 5.1) | Library |
| Order between errors (5.4) | Library, for the errors it produces; the per-field `403` and the state `409` are thrown by your `validate` or your adapter |
| Query in "the same request", not in the target (7.1) | Library |
| `idempotency.anonymous` (7.1) | Library (`idempotencyAnonymous`); there are no idempotent `POST` actions that ignore the key |
| `_etag` on every item response, ETag without `_etag` (7.2) | Library |
| `fields`/`include` on writes, `limit` without `max_limit` → `unsupported_parameter` (5.3, 6.3, 6.4) | Library (it always declares `max_limit`) |
| Name grammar (3) | Library, at startup; `reason` when thrown |
| `+` as space; path compared after decoding (3, 5.2) | Library |
| Read-only on `POST`/`PATCH` (4.3, 5.1) | Only `id`; a relation set to its current value is ignored without checking it. Custom read-only fields: not implemented |
| Same discovery for everyone; custom members with `x-` (4.2) | Library (adds no custom members) |
| `deprecations`, `announced`, `kind` (5.5) | Not implemented |
| `Origin`/`Sec-Fetch-Site` with browser credentials (5.8) | Library, with `browserCredentials`; a client certificate you have to declare yourself |
| `sync` per collection (10) | Not implemented (`:changes` gives `404`) |
| `403` for a field that cannot be changed, `409` for state, unreadable fields in filters and `total`, the same `422` for an invisible item (5.1, 6.1, 6.5) | Delegated: your adapter and your `validate` |
| `429`/`503` only without effect (5.7) | The library does not produce them; if your adapter throws them, it must be without effect |

## Persistence, failures and multiple instances

The in-memory store is for examples and tests: it loses the keys on restart. A
durable store separate from the data **is not enough** to comply with §7.1. The effect of creating
the resource and the response that will be replayed must be committed in the same transaction.

`createTransaction(work, ctx)` wraps each complete write (collection `POST`, item `PATCH` and
`DELETE`):

```js
const api = createRestep({
  collections,
  idempotencyStore,
  createTransaction: (work) => database.transaction((connection) => work(connection)),
});
```

`database.transaction` is your adapter's transactional method, not a Restep
dependency. It must commit only if `work` succeeds, roll back if it fails, and resolve its
promise after the commit. It must not automatically re-run the callback with the same
consumed request. The connection arrives as `ctx.transaction` in `data.get`, `data.create`,
`data.update` and `data.delete`, and as the last `ctx` argument of `reserve(key, print, ttlMs, ctx)`,
`complete(key, response, ctx)` and `release(key, ctx)`. **They must all use that same transaction**.
`reserve` must be atomic across processes; its implementation must also resolve concurrent
reservations. Before `PATCH` and `DELETE`, the library reads the item with `ctx.forUpdate: true`:
the adapter must lock it (`SELECT … FOR UPDATE`) so that evaluating `If-Match` and writing are
atomic across processes too (7.2).

Without that coordination, an exception after calling `data.create` leaves the reservation
pending: the retry gets `409 request_in_progress`, and never blindly creates again.
That includes an adapter that commits the effect and then throws a connection error.
Pending reservations in the in-memory store do not expire automatically. A custom
store must keep those with an uncertain outcome until it recovers the response or proves
there was no effect; it must not delete them on a TTL. This protection prevents duplicates, but
may need operational recovery to unblock the key. Requests that
fail during validation do release their reservation.

This library's mutex only protects the current process. External effects (payments,
email) need their own coordination; the hook does not turn them into database
transactions.

### PostgreSQL

[`pg.mjs`](pg.mjs) is a transactional adapter for PostgreSQL 11 or later. It has no
dependencies either: it takes a pool compatible with [`pg`](https://node-postgres.com/) (`pool.connect()`
gives a client with `query(text, values)` and `release(err)`).

```js
import pg from 'pg';
import { createRestep } from './restep-server.mjs';
import { migrate, pgTransaction, pgIdempotencyStore, pgDocumentAdapter } from './pg.mjs';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await migrate(pool); // once, at deploy time; not from several processes at once

const api = createRestep({
  collections: { books: { fields, data: pgDocumentAdapter({ pool, collection: 'books' }) } },
  createTransaction: pgTransaction(pool),
  idempotencyStore: pgIdempotencyStore(),
  secret: process.env.RESTEP_SECRET, // the same on every instance, for the cursors
});
```

| Export | What it does |
|---|---|
| `schema(opts)`, `migrate(pool, opts)` | The SQL for the tables (below) and running it. `opts`: `idempotencyTable`, `itemsTable` |
| `pgTransaction(pool)` | The `createTransaction`: `BEGIN`, the work on one connection, `COMMIT`; `ROLLBACK` if it fails. A failed `COMMIT` (dropped connection, lost acknowledgement) gives `500` and is not retried: the client's retry with the same key resolves it by reading the database |
| `pgIdempotencyStore({ table })` | The key store. Requires `ctx.transaction` |
| `pgDocumentAdapter({ pool, collection, table })` | A data adapter that stores each item as `jsonb`, with `id`s from a sequence (`bigserial`: never reused, and `07` is not `7`). It has no `taken`, so it does not support `idFrom: 'client'` or `'either'`. It writes in the transaction and locks with `ctx.forUpdate`. `list` filters and sorts in the process with the library's rules: fine for tests and small collections; for large ones, write your own SQL adapter following the same contract |
| `inFlightReservations(pool)` | The transactions currently holding a reserved key: `pid`, `state`, `age_ms`, `xact_start`, `application_name`, `client_addr`, `wait_event` |
| `terminateReservation(pool, pid)` | Terminates the backend of a stuck reservation and waits for it to disappear. Rejects (`false`) a `pid` that has no reservation |
| `purgeExpired(pool, { table })` | Deletes the stored responses whose time has passed |

Your own data adapter can use `pgTransaction` and `pgIdempotencyStore` the same way: its writes
just need to use `ctx.transaction`, and its `get` must add `FOR UPDATE` when
`ctx.forUpdate` arrives with a transaction.

**Schema** (`schema()` generates it; table names are configurable):

```sql
CREATE TABLE restep_idempotency (
  scope      text PRIMARY KEY,   -- principal (hash), method, path and key
  print      text NOT NULL,      -- hash of the body as a JSON value
  response   jsonb,              -- { status, headers, body_text? }: the body as JSON text, to replay it verbatim
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX restep_idempotency_expires ON restep_idempotency (expires_at);
-- Deferred constraint trigger: a reservation without a response cannot be committed.
CREATE CONSTRAINT TRIGGER restep_idempotency_complete AFTER INSERT OR UPDATE ON restep_idempotency
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION restep_idempotency_complete();
CREATE TABLE restep_items (
  collection text NOT NULL, id bigserial, doc jsonb NOT NULL, PRIMARY KEY (collection, id)
);
```

**How it guarantees 7.1 and 7.2:**

- The key row, the created resource and the stored response are committed in the same
  transaction. If the process dies before the `COMMIT`, PostgreSQL rolls back all three; if
  it dies after, or the acknowledgement is lost, all three are there and the retry replays the response.
  The deferred trigger prevents committing a reservation without a response, so **the table never holds
  reservations with an uncertain outcome**, and none expires on a TTL: only complete responses expire.
- While a request is in progress, its transaction holds two advisory locks
  (`pg_try_advisory_xact_lock`): one on the key and another on the key plus the body. Another request with
  the same key, from any process, answers without waiting: `409 request_in_progress` if its
  body is the same and `422 idempotency_mismatch` if not. The locks are released on their own when the
  transaction ends, also if the process dies or its backend is terminated.
- `PATCH` and `DELETE` read the item with `FOR UPDATE` inside the transaction: a second
  write with the same version waits for the first, reads the new version and gets `412` (or `404`
  if the first one deleted it).

**Stuck reservations: operational procedure.** A reservation only exists while its
transaction lives. If the retries for a key get `409` for a long time, its transaction is still
open: a slow request, or a hung process (or a half-closed connection) that PostgreSQL has not
detected yet.

1. Watch them with `inFlightReservations(pool)` or with SQL (the shared advisory lock
   `(0x52455354, 0)` marks the transactions holding a reservation):

   ```sql
   SELECT a.pid, a.state, now() - a.xact_start AS age, a.application_name, a.client_addr
     FROM pg_locks l JOIN pg_stat_activity a USING (pid)
    WHERE l.locktype = 'advisory' AND l.classid = 1380275028 AND l.objid = 0 AND l.objsubid = 2
    ORDER BY a.xact_start;
   ```

   Alert when `age` comfortably exceeds the maximum duration of a write.
2. If the owning process is still working (`state = 'active'`), wait. If it has been `idle in transaction`
   for a long time, or its process no longer exists, terminate it: `terminateReservation(pool, pid)` or
   `SELECT pg_terminate_backend(pid)`.
3. Terminating the backend rolls back the whole transaction: reservation, effect and response. That rollback
   is the proof there was no effect; nothing needs releasing by hand. The next retry with
   the same key creates the resource exactly once. If the transaction did commit before it was
   terminated, the key row has its response and the retry replays it.
4. To make this happen on its own, set `idle_in_transaction_session_timeout` (for example, a few
   times the maximum duration of a write) and TCP keepalives on the server. It is safe for the same
   reason: PostgreSQL rolls back atomically. What must not be done, and this adapter does not do, is
   delete a committed reservation without a response because a deadline has passed.

To look up the stored response for a specific key:
`SELECT response FROM restep_idempotency WHERE scope LIKE '% POST /books <key>'`.
`purgeExpired(pool)` (for example, once a day) deletes expired responses.

**Limits.** Effects outside PostgreSQL (payments, email, another database) are not part of the
transaction. Operating system or disk crashes are not tested (the tests stop
PostgreSQL with `pg_ctl stop -m immediate`, which does recover from the WAL). Tested with
PostgreSQL 14, `READ COMMITTED` isolation and `pg` 8.

## Tests

```bash
node --test tools/restep-server/recovery.test.mjs
node tools/restep-server/test.mjs
node --test tools/restep-server/pg.test.mjs   # needs PostgreSQL and npm install in tools/restep-server
```

They start the example on ports 8810 and 8811 (the latter with oauth) and run
`restep-check --writes` (0.7.0, draft 6) against it, which must report 0 failures; then they test
`handle(Request)` directly (error order, idempotency with a request in progress, `428`,
language, `base`, adapter errors, wrong configuration and, from draft 6, `415` and `charset`,
`_etag`, the query in idempotency, `idempotencyAnonymous`, `idFrom` and `taken`, decoded
paths, `+` as space, collations, relations set to their current value, singletons,
name grammar and `Origin`) and the Express (port 8813) and Hono adapters.

`pg.test.mjs` creates a temporary cluster (`initdb` in a temporary directory, Unix socket only,
port 54320-54329; stopped and deleted at the end, also on failure) and starts two server
processes ([`pg-worker.mjs`](pg-worker.mjs), ports 8100 and 8101) against the same database.
It tests with real failures: simultaneous requests from both processes, `SIGKILL` before and after
the `COMMIT`, a committed `COMMIT` whose response is cut by a socket proxy, `pg_terminate_backend`
of a stuck reservation, PostgreSQL crash and recovery, and concurrent `PATCH`/`DELETE` with the
same version. It looks for the binaries in `PG_BIN`, `pg_config --bindir`, the `PATH` and the usual paths;
without binaries or without `pg` installed it is skipped and says so (`node tools/verify.mjs` lists it as skipped,
not as passed). The simulations in `recovery.test.mjs` stay as port-free regressions.

## Questions about the spec

Draft 6 settled several of the ones listed here: `count=false` without a declared `count` and
`fields` on a write give `unsupported_parameter` (5.3, 6.3), `If-Match` against a just-deleted
item gives `404` (7.2), idempotency without credentials can be rejected with `"anonymous": false`
(7.1), and the `If-Match` of a `POST` is compared with the ETag of the collection's `GET` without parameters
(7.2). Still open:

- **Wait or answer `409` while the first request is in progress** (7.1): the specification allows
  both. Here it does not wait: the second gets `409 request_in_progress` (or `422` if its body
  differs) as soon as it sees the lock, so as not to tie up connections on slow requests. An edge case: a
  third request with the same body as another that is about to get `422` may get a transient
  `409`; its retry gets the final response.
- **Collection ETag for `If-Match` on a `POST`** (7.2): it is that of the `GET` without parameters, which
  here is the default first page, so it does not protect against changes beyond it.
- **Browser credentials** (5.8): a library does not know which credential your
  `authenticate` used, so `'auto'` infers it from the headers (`Cookie`, `Basic`, `Digest`). With
  non-authenticating cookies next to a token in `Authorization`, `'auto'` may reject a
  cross-origin write that the specification does not cover; set `browserCredentials: false`.
- **"The value the item would have"** (5.1, read-only fields on a `POST`): the library
  cannot know it before the adapter creates the item, which is why it offers no custom read-only
  fields.
- **`taken` the same for everyone** (5.1): the library asks `taken` before creating, but only the
  adapter can guarantee that the answer does not depend on what the principal sees, and that deleted
  `id`s are remembered.
- **Default order**: an `id` is compared as text, so `"12"` comes before `"7"`. It is
  deterministic (5.2) and draft 6 makes clear that the order of `id`s is up to the server, but
  it is surprising; that is why `defaultSort` exists.

## Code and issues

Code and issues: <https://github.com/restep-spec/restep-server>. That repository is generated from the Restep
site, where the tool is developed alongside the [specification](https://restep.wubytes.com/1/) and the reference
server: `vendor/` and `schema/` are copies from the site so the tests run on their own.

MIT licensed.
