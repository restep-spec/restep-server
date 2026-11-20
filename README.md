# restep-server (prototipo)

Biblioteca para escribir un servidor [Restep 1](https://restep.wubytes.com/es/1/) (borrador 4)
sin implementar el protocolo a mano: tú declaras las colecciones y escribes el acceso a tus datos;
la biblioteca hace el resto. Un solo archivo, Node 18+, sin dependencias.

El núcleo solo usa la Web estándar (`Request`, `Response`, `URL`, Web Crypto):
`createRestep(...)` devuelve `handle(request) => Promise<Response>`, que funciona igual en Node,
Deno, Bun o Cloudflare Workers. Para Node http, Express y Hono hay adaptadores finos.

## Ejemplo mínimo

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

Con eso ya hay descubrimiento en `/`, `GET/HEAD /books` con filtros, orden, `fields`, `limit`,
cursores y `count`, y `GET/PATCH/DELETE /books/7` y `POST /books` con validación, Merge Patch,
`ETag`, `If-Match` e `Idempotency-Key`. Un ejemplo completo, con mapas de idioma, relaciones,
fechas, duraciones, una regla de validación propia y oauth opcional, está en
[`example.mjs`](example.mjs):

```bash
PORT=8810 node tools/restep-server/example.mjs
node vendor/restep-check.mjs http://localhost:8810/ --writes      # 0 failed
```

## Qué haces tú: el adaptador de datos

Cada colección lleva en `data` un objeto con estos métodos. `list` y `get` son obligatorios; los
demás son opcionales y, si faltan, su método HTTP desaparece de la colección (`methods`,
`item_methods` y el `Allow` de los `405` se calculan solos).

| Método | Recibe | Devuelve |
|---|---|---|
| `list(query, ctx)` | `{ filter, sort, limit, cursor, count, fields }` | `{ items, next, total }` |
| `get(id, ctx)` | el `id` de la URL | el elemento o `null` (da `404`) |
| `create(data, ctx)` | el cuerpo ya validado, sin `id` ni miembros `_` | el elemento guardado, con su `id` |
| `update(id, data, ctx)` | el elemento completo ya fusionado y validado (`ctx.patch`: el parche; `ctx.current`: lo anterior) | el elemento guardado |
| `delete(id, ctx)` | el `id` | nada |

- `filter` es una lista de `{ field, op, value, type }` con el valor ya convertido a su tipo (un
  `in` trae una lista; un `null`, un booleano). `sort` es `[{ field, desc, type }]` y siempre
  acaba en `id`, para desempatar. `field` puede ser `campo`, `mapa.etiqueta` o `relacion.id`.
- `cursor` es lo que tu `list` devolvió en `next` para la página anterior (un desplazamiento, una
  clave, lo que quieras que sea JSON), o `null` en la primera. La biblioteca lo firma con HMAC y lo
  liga a la colección, los filtros, el orden y el principal, así que nunca te llega uno manipulado
  ni de otra consulta.
- `ctx` lleva `request`, `principal`, `lang` y `collection`.
- Para errores de tu dominio, lanza `new RestepError(409, 'conflict', 'Ya existe.', { reason: 'duplicate' })`.
  Cualquier otra excepción da `500 internal` y pasa por `onError`.
- `memoryAdapter(filas)` implementa todo en memoria para pruebas y ejemplos. Exporta también las
  piezas para un adaptador propio: `matches`, `sorter`, `compareValues` y `valueAt`, con las reglas
  de comparación del 6.1 (decimales exactos, fechas e instantes, duraciones, texto por puntos de código).

## Qué hace la biblioteca

- **Descubrimiento (4.2, 4.3)**: el documento de la raíz con perfiles, `idempotency`, `status`,
  colecciones con `description`, `methods`, `item_methods`, `filter` con tipos y operadores, `sort`,
  `max_limit`, `count`, `language_maps`, `relations` y esquemas JSON Schema `item`, `create` y
  `update` generados a partir de los campos. Con `ETag`, `304` y `Vary: Accept-Language`.
- **Cabecera de perfil (4.1)** en todas las respuestas de la API.
- **Parámetros (5.3, 6)**: rechaza todo parámetro reservado que el recurso no implementa para ese
  método (`unsupported_parameter`) y todo valor erróneo (`invalid_parameter`), siempre con
  `parameter`: filtros y operadores no declarados, tipos, `in` vacío, el mismo filtro dos veces
  (también `filter[f]` con `filter[f][eq]`), duraciones con años o meses, `limit` fuera de rango,
  campos de `fields` que no existen o que entran en un mapa de idioma, cursores manipulados o de
  otra consulta, parámetros repetidos, `$loquesea`.
- **Errores (5.4)**: `problem+json` con `type`, `title`, `status`, `code` y `detail`, en el orden
  de estados de la especificación (401, 404, 405, 400, 415, 413, 428, 412, 422, 409).
- **Escrituras (5.1, 7)**: `201` con `Location`, Merge Patch (RFC 7396) con las excepciones de
  Restep (las relaciones se sustituyen enteras y solo se lee su `id`; los mapas de idioma se
  fusionan y quedan en `{}`), miembros `_` ignorados, `id` del servidor, `422 invalid` con `errors`
  y `pointer`, `415` con `Accept-Patch`, `413` por tamaño, `Prefer: return=minimal`.
- **Concurrencia (7.2)**: ETag fuerte del elemento completo, `_etag` con `fields`, `If-Match`
  (listas, `*`, comparación fuerte) evaluado de forma atómica con la escritura dentro del proceso,
  `If-None-Match` (`304` en lecturas, `412` en escrituras) y `428` con `requireIfMatch: true`.
- **Idempotencia (7.1)**: `Idempotency-Key` como cadena de Structured Fields, por principal y
  destino, cuerpos comparados como valores JSON, repetición con `Idempotent-Replayed: true`,
  `422 idempotency_mismatch`, `409` mientras la primera sigue en curso, `400
  idempotency_key_required` con `requireIdempotencyKey: true`. Una petición rechazada no gasta la clave.
- **Caché (7.3)**: `Cache-Control` en todas las lecturas y errores (`private` si hay principal),
  `Cache-Groups` en las lecturas y `Cache-Group-Invalidation` en las escrituras.
- **Idioma (5.6)**: los textos de la biblioteca (errores, descripciones) en inglés y español,
  elegidos con el *lookup* del RFC 4647; los tuyos pueden ser `t('en', 'es')`. Los datos nunca cambian.
- **Mapas de idioma (3)**: validación de etiquetas (`format`), tipos y etiquetas no admitidas
  (`unknown`, con la opción `languageTags`), filtro y orden por `campo.etiqueta` exacta.
- **Estado del servicio (4.4)** con `status: { path: '/health', check: async () => true }`.
- **oauth (10.5)** con `oauth: { authorizationServers, scopesSupported, verifyToken(token, request) }`:
  metadatos del RFC 9728 en su URL, retos `WWW-Authenticate` con `resource_metadata` solo en la raíz.
  Sin oauth, `authenticate(request)` puede devolver un principal o lanzar un `RestepError` 401/403.

## Opciones de `createRestep`

| Opción | Por defecto | Para qué |
|---|---|---|
| `collections` | (obligatoria) | `{ nombre: { fields, filter, sort, defaultSort, maxLimit, defaultLimit, count, path, description, validate, requireIfMatch, requireIdempotencyKey, data } }` |
| `base` | `''` | Ruta de la raíz de la API, como `/api` |
| `languages` | `['en', 'es']` | Idiomas de los textos; el primero es el de por defecto |
| `languageTags` | cualquiera | Etiquetas que aceptan los mapas de idioma |
| `secret` | al azar | Clave de los cursores; fíjala si hay varias instancias |
| `idempotencyStore` | en memoria | Almacén de claves; uno duradero con `reserve`, `complete` y `release` |
| `idempotencyTtl` | `86400` | Segundos (mínimo 86400) |
| `maxBodyBytes` | 1 MiB | Más da `413` |
| `cors` | — | `true` (cualquier origen) o `{ origins: [...] }`: responde el preflight y expone `ETag`, `Location`, `Link`, `Allow`… a los clientes de navegador |
| `docs` | — | URL de la documentación, o lista de `{ href, hreflang, title }`: va como `Link: rel="service-doc"` en el descubrimiento (4.2, DEBERÍA) |
| `status`, `oauth`, `authenticate` | — | Ver arriba |
| `publicOrigin` | el de la petición | Origen público detrás de un proxy (para oauth) |
| `onError` | `console.error` | Recibe las excepciones que acaban en `500` |

Los tipos de campo son los del descubrimiento (`string`, `integer`, `number`, `decimal`,
`boolean`, `date`, `datetime`, `duration`, `enum` con `values`) más `map` (mapa de idioma) y
`relation` (a uno, con `to`). Un campo puede llevar `required: true` y `description`. `validate(row,
ctx)` devuelve una lista de entradas de `errors` para reglas propias (ver la de ciclos en el ejemplo).

## Adaptadores de framework

```js
createServer(toNodeListener(api)).listen(8080);       // Node http
app.use(toExpress(api));                               // Express (con base: '/api' si va en app.use('/api', …))
app.all('*', toHono(api));                             // Hono
export default { fetch: api.handle };                  // Cloudflare Workers, Deno, Bun
```

`toExpress` usa `req.originalUrl` y, si un body parser ya leyó el cuerpo, lo vuelve a serializar.
Mejor montarlo antes de `express.json()`: ese parser responde por su cuenta a un JSON mal formado,
sin `problem+json`.

## Perfiles que cubre y que no

| Perfil o extensión | Estado |
|---|---|
| `core` | Sí, salvo valores heredados (5.7) y retiradas (`deprecations`, `Deprecation`, `Sunset`, 5.5) |
| `query` | Sí |
| `writes` | Sí. La atomicidad de `If-Match` es por proceso; con varias instancias, `update` tiene que comprobar la versión en la base de datos |
| `oauth` | Sí, sin scopes por petición: un `403 insufficient_scope` lo lanza tu `verifyToken` o tu adaptador |
| `relations` | No: no anuncia el perfil ni hace `include`, ni subcolecciones con plantilla en `path`. Las relaciones a uno sí se declaran, se validan y se filtran por `relacion.id` |
| `sync` | No |
| `actions`, `batch`, `filter-expr`, `query-method` | No: sus parámetros y rutas fallan en voz alta (`unsupported_parameter`, `404`) |

Tampoco hace `406` por `Accept` (siempre responde JSON) ni versiones mayores (`/v2/`).

## Pruebas

```bash
node tools/restep-server/test.mjs
```

Arrancan el ejemplo en los puertos 8810 y 8811 (este con oauth) y le pasan
`restep-check --writes`, que tiene que dar 0 fallos; después prueban `handle(Request)` directamente
(orden de errores, idempotencia con una petición en curso, `428`, idioma, `base`, errores del
adaptador, configuración errónea) y los adaptadores de Express (puerto 8813) y Hono.

## Dudas sobre la spec

- **ETag de una colección para `If-Match` en un `POST`** (7.3): la spec dice que `If-None-Match` que
  coincide da `412` a una escritura, pero no qué representación de la colección cuenta. Como la
  referencia, se usa la de la primera página por defecto, lo que no protege de cambios más allá.
- **Idempotencia sin autenticación** (7.1): la clave es «de un principal». Sin credenciales, todos
  los clientes anónimos comparten espacio de claves; la spec no dice nada de ese caso.
- **`count=false` en una colección que no declara `count`** (6.5): `count=false` «equivale a no
  enviarlo», pero 5.3 obliga a rechazar un parámetro reservado que el recurso no implementa. Aquí
  da `unsupported_parameter` con cualquier valor, igual que la referencia.
- **`fields` en escrituras**: 6.3 solo habla de lecturas; `PATCH /books/7?fields=title` da
  `unsupported_parameter`. Podría tener sentido para recortar la respuesta del `PATCH`.
- **Orden por defecto**: un `id` se compara como texto, así que `"12"` va antes que `"7"`. Es
  determinista (5.2), pero sorprende; por eso existe `defaultSort`.

## Código y avisos

Código y avisos: <https://github.com/restep-spec/restep-server>. Ese repositorio se genera desde la web de
Restep, donde la herramienta se desarrolla junto a la [especificación](https://restep.wubytes.com/1/) y el servidor de
referencia: `vendor/` y `schema/` son copias de la web para que las pruebas funcionen solas.

Licencia MIT.
