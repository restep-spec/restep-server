# restep-server (prototipo)

Biblioteca para escribir un servidor [Restep 1](https://restep.wubytes.com/1/) (borrador 6: el
descubrimiento declara `"restep": "1.0-draft.6"`) sin implementar el protocolo a mano: tú declaras las colecciones y escribes el acceso a tus datos;
la biblioteca hace el resto. Un solo archivo, Node 18+, sin dependencias.

El núcleo solo usa la Web estándar (`Request`, `Response`, `URL`, Web Crypto):
`createRestep(...)` devuelve `handle(request) => Promise<Response>`, que funciona igual en Node,
Deno, Bun o Cloudflare Workers. Para Node http, Express y Hono hay adaptadores finos.

```bash
npm install restep-server
```

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
fechas, duraciones, una regla de validación propia, `id` elegidos por el cliente, una colación,
un singleton y oauth opcional, está en [`example-api.mjs`](example-api.mjs) (lo arranca
[`example.mjs`](example.mjs)):

```bash
PORT=8810 node tools/restep-server/example.mjs
npx restep-check http://localhost:8810/ --writes      # 0 failed
```

## Qué haces tú: el adaptador de datos

Cada colección lleva en `data` un objeto con estos métodos. `list` y `get` son obligatorios; los
demás son opcionales y, si faltan, su método HTTP desaparece de la colección (`methods`,
`item_methods` y el `Allow` de los `405` se calculan solos).

| Método | Recibe | Devuelve |
|---|---|---|
| `list(query, ctx)` | `{ filter, sort, limit, cursor, count, fields }` | `{ items, next, total }` |
| `get(id, ctx)` | el `id` de la URL (antes de `PATCH` y `DELETE`, con `ctx.forUpdate: true`: bloquéalo si hay transacción) | el elemento o `null` (da `404`) |
| `create(data, ctx)` | el cuerpo ya validado, sin miembros `_`; con `id` solo si el cliente lo eligió (`idFrom`) | el elemento guardado, con su `id` (el del cliente, si lo eligió) |
| `update(id, data, ctx)` | el elemento completo ya fusionado y validado (`ctx.patch`: el parche; `ctx.current`: lo anterior). No se llama si el `PATCH` no cambia ningún dato (5.1) | el elemento guardado |
| `delete(id, ctx)` | el `id` | nada |
| `taken(id, ctx)` | un `id` elegido por el cliente; solo con `idFrom: 'client'` o `'either'`, donde es obligatorio | `true` si la colección tiene o tuvo ese `id`, lo vea o no este principal (5.1) |

- `filter` es una lista de `{ field, op, value, type }` con el valor ya convertido a su tipo (un
  `in` trae una lista; un `null`, un booleano). `sort` es `[{ field, desc, type }]` y siempre
  acaba en `id`, para desempatar. `field` puede ser `campo`, `mapa.etiqueta` o `relacion.id`.
- Un filtro con nombre (`namedFilters`, 6.1) llega en `filter` como `{ named, value }`: `value` es
  `true` en un interruptor y el valor ya convertido en uno con `type`. Tu adaptador lo traduce por su
  nombre (un scope del ORM, una subconsulta, una búsqueda de texto). `memoryAdapter` usa el `apply`
  de su declaración, que también llega en el filtro.
- `cursor` es lo que tu `list` devolvió en `next` para la página anterior (un desplazamiento, una
  clave, lo que quieras que sea JSON), o `null` en la primera. La biblioteca lo firma con HMAC y lo
  liga a la colección, los filtros, el orden y el principal, así que nunca te llega uno manipulado
  ni de otra consulta.
- `fields` es solo una pista: puedes devolver los elementos enteros. Si la colección tiene `update`
  o `delete`, llega `null`, porque el `_etag` de cada elemento del listado se calcula sobre la
  representación completa.
- `ctx` lleva `request`, `principal`, `lang` y `collection`.
- `get` compara el `id` punto de código a punto de código (3): `07` no es `7`. Si tu clave es
  numérica, no conviertas `"07"` en `7` (la biblioteca da `404` igualmente si el elemento que
  devuelves tiene otro `id`). `get` devuelve `null` también para un elemento que este principal no
  puede ver: así el `404` y la entrada `unknown` de una relación son iguales en los dos casos (5.1).
- Con `idFrom: 'client'` o `'either'` (5.1), los `id` usados no se reutilizan nunca: `taken` tiene
  que recordar los de los elementos borrados mientras exista la colección (o un hash de ellos), y
  el `id` que asigna tu `create` sin `id` del cliente no puede ser uno que la colección haya
  tenido. Entre procesos, tu clave primaria tiene que rechazar el duplicado: lanza
  `takenError()` (exportado) desde `create`.
- Los filtros y el orden llegan con `collation` (`"codepoint"` o `"server"`, 6.1). Con
  `"server"`, la igualdad y el orden son los tuyos (una colación de la base de datos), totales,
  deterministas y coherentes entre sí. Si un campo no se puede leer en un elemento para este
  principal, tu `list` lo trata como ausente (6.1), y `total` cuenta solo lo que ve (6.5): la
  biblioteca no sabe qué puede leer cada principal.
- Para errores de tu dominio, lanza `new RestepError(409, 'conflict', 'Ya existe.', { reason: 'duplicate' })`.
  Cualquier otra excepción da `500 internal` y pasa por `onError`.
- `memoryAdapter(filas)` implementa todo en memoria para pruebas y ejemplos, `taken` incluido; su
  colación `"server"` no distingue mayúsculas ni acentos (`Intl.Collator` con `sensitivity: 'base'`).
  `memorySingleton(objeto)` es lo mismo para un singleton. Exporta también las piezas para un
  adaptador propio: `matches`, `sorter`, `compareValues` y `valueAt`, con las reglas de comparación
  del 6.1 (decimales exactos, fechas e instantes, duraciones, texto por puntos de código o con la
  colación `"server"`).

## Qué hace la biblioteca

- **Descubrimiento (1.1, 4.2, 4.3)**: `"restep": "1.0-draft.6"`, perfiles (`core`, `query`,
  `writes` si hay escrituras, `cache`), `idempotency` (con `anonymous: false` si se pide), `status`,
  colecciones con `description`, `methods`, `item_methods`, `id_from`, `filter` con tipos y
  operadores, `sort`, `collations`, `max_limit`, `count`, `language_maps`, `relations` y esquemas
  JSON Schema `item`, `create` y `update` generados a partir de los campos, y `singletons`. El
  mismo documento para todos los principales (solo cambian los textos con `Accept-Language`), con
  `ETag`, `304` y `Vary: Accept-Language`; `private` cuando hay principal. No añade miembros propios.
- **Nombres (3)**: al arrancar rechaza colecciones, singletons, campos y filtros con nombre que no
  cumplan `ALPHA *63( ALPHA / DIGIT / "_" / "-" )`; un `reason` mal formado en un `RestepError` da `500`.
- **Rutas (3)**: cada segmento se compara tras decodificar porcentajes (`/books/%37` es `/books/7`;
  `/books/07` no lo es).
- **Cabecera de perfil (4.1)** en todas las respuestas de la API.
- **Parámetros (5.3, 6)**: rechaza todo parámetro reservado que el recurso no implementa para ese
  método (`unsupported_parameter`) y todo valor erróneo (`invalid_parameter`), siempre con
  `parameter`: filtros y operadores no declarados, tipos, `in` vacío, el mismo filtro dos veces
  (también `filter[f]` con `filter[f][eq]`), duraciones con años o meses, `limit` fuera de rango,
  campos de `fields` que no existen o que entran en un mapa de idioma, cursores manipulados o de
  otra consulta, parámetros repetidos, `$loquesea`.
- **Errores (5.4)**: `problem+json` con `type`, `title`, `status`, `code` y `detail`, en el orden
  del borrador 6: `401`/`403` → `404` → `405` → `400` de parámetros y cabeceras → `400` del cuerpo,
  `415` y `413` → repetición y `409 request_in_progress` → `428` → `412` → `422` → `409 conflict`.
- **Escrituras (3, 5.1, 7)**: `Content-Type: application/json` obligatorio (en `PATCH`, también
  `application/merge-patch+json`), con `charset` solo `utf-8`: cualquier otro tipo, otro `charset`
  o ninguno da `415` (con `Accept-Patch` en un `PATCH`), y un cuerpo vacío con `application/json`
  da `400`. `201` con `Location`, Merge Patch (RFC 7396) con las excepciones de Restep (las
  relaciones se sustituyen enteras y solo se lee su `id`; los mapas de idioma se fusionan y quedan
  en `{}`), miembros `_` ignorados, `422 invalid` con `errors` y `pointer`, `413` por tamaño,
  `Prefer: return=minimal`. Un `PATCH` que no cambia ningún dato no toca el elemento ni su ETag.
  Una relación con su valor actual se ignora sin comprobarla; a un elemento que no existe da `422`
  con `unknown` en `/relación/id`.
- **`id` (5.1)**: con `idFrom` sin declarar o `'server'`, un `id` en el `POST` da `422` con
  `read_only` en `/id`. Con `'client'` (obligatorio, `required` si falta) o `'either'`
  (opcional), lo valida (`type`, `format`, y `idPattern` si lo das) y da `409 conflict` con `taken`
  en `/id` a uno que la colección tiene o tuvo, después de los `422`.
- **Concurrencia (7.2)**: ETag fuerte del elemento completo, calculada sin `_etag`; `_etag` en toda
  respuesta cuyo cuerpo es un elemento (su `GET`, con o sin `fields`, el `201` del `POST` y el `200`
  del `PATCH`) y en cada elemento de un listado cuando admite `PATCH` o `DELETE` (la misma ETag que
  su `GET`, calculada sobre la representación completa aunque haya `fields`), `If-Match`
  (listas, `*`, comparación fuerte) evaluado de forma atómica con la escritura dentro del proceso
  y, con `createTransaction` y `ctx.forUpdate`, entre procesos,
  `If-None-Match` (`304` en lecturas, `412` en escrituras) y `428` con `requireIfMatch: true`.
- **Idempotencia (7.1)**: `Idempotency-Key` como cadena de Structured Fields sin parámetros (una
  mal formada da `400 bad_request` con una entrada `header`), por principal y destino (método y
  ruta decodificada, sin la query); dos peticiones son la misma si además coinciden su query (tras
  decodificar, en cualquier orden) y sus cuerpos como valores JSON. Repetición con `Idempotent-Replayed: true`,
  `422 idempotency_mismatch` (también mientras la primera sigue en curso), `409
  request_in_progress` con `Retry-After` para la misma petición mientras la primera sigue en curso, `400
  idempotency_key_required` con `requireIdempotencyKey: true`. Una petición rechazada no gasta la clave.
  Con `idempotencyAnonymous: false`, el descubrimiento dice `"anonymous": false` y un `POST` sin
  credenciales (sin principal) con la clave da `400 bad_request` con la entrada `unknown` antes de
  cualquier efecto, y `requireIdempotencyKey` no se aplica a esas peticiones.
- **Caché (perfil `cache`, 8)**: `Cache-Control` en toda respuesta a `GET` y `HEAD`, errores
  incluidos (`private` si hay principal; los errores, `no-store`), ETag en elementos, colecciones,
  singletons y descubrimiento, `304` con `If-None-Match`, `Cache-Groups` en las lecturas y
  `Cache-Group-Invalidation` en las escrituras. Una respuesta con principal es `private` también
  sin este perfil (5.1).
- **Singletons (5.9)**: `singletons: { me: { path, description, fields, data } }` con `data.get(ctx)`
  y, para `PATCH`, `data.update(merged, ctx)`. `GET`/`HEAD` con `fields`, ETag, `_etag` y `304`;
  `PATCH` como el de un elemento (validación, `If-Match`, `428` con `requireIfMatch`, sin cambios
  no escribe); `POST` y `DELETE` dan `405`; `include` y los demás parámetros reservados,
  `unsupported_parameter`. Las relaciones llevan `href`. Sin `id`, sin mapas de idioma ni acciones.
- **Origen (5.8)**: un `POST`, `PATCH` o `DELETE` autenticado con credenciales que el navegador
  añade solo, cuyo `Origin` no es el de la API ni uno de `cors.origins`, da `403 forbidden` sin
  efecto (`Origin: null` vale con `Sec-Fetch-Site: same-origin`; sin `Origin`, decide
  `Sec-Fetch-Site`). Ver `browserCredentials`.
- **Idioma (5.6)**: los textos de la biblioteca (errores, descripciones) en inglés y español,
  elegidos con el *lookup* del RFC 4647; los tuyos pueden ser `t('en', 'es')`. Los datos nunca cambian.
- **Mapas de idioma (3)**: validación de etiquetas (`format`), tipos y etiquetas no admitidas
  (`unknown`, con la opción `languageTags`), filtro y orden por `campo.etiqueta` exacta.
- **Estado del servicio (4.4)** con `status: { path: '/health', check: async () => true }`.
- **oauth (11.5)** con `oauth: { authorizationServers, scopesSupported, verifyToken(token, request) }`:
  metadatos del RFC 9728 en su URL, retos `WWW-Authenticate` con `resource_metadata` solo en la raíz.
  Sin oauth, `authenticate(request)` puede devolver un principal o lanzar un `RestepError` 401/403.

## Opciones de `createRestep`

| Opción | Por defecto | Para qué |
|---|---|---|
| `collections` | (obligatoria) | `{ nombre: { fields, filter, namedFilters, sort, defaultSort, collations, maxLimit, defaultLimit, count, path, description, idFrom, idPattern, validate, newItem, requireIfMatch, requireIdempotencyKey, data } }`. `collations`: `{ campo: 'codepoint' \| 'server' }` (6.1), solo campos `string` (o `campo.etiqueta`) de `filter` o `sort`, nunca `id`. `idFrom`: `'server'`, `'client'` o `'either'` (5.1). `idPattern`: expresión regular que restringe el `id` del cliente, también en el esquema `create` |
| `singletons` | — | `{ nombre: { path, description, fields, validate, requireIfMatch, data } }` (5.9) |
| `base` | `''` | Ruta de la raíz de la API, como `/api` |
| `version` | `'1'` | El `version` del documento de descubrimiento: la versión mayor de tu API, la de su ruta (`/v2/` → `'2'`, 5.5) |
| `languages` | `['en', 'es']` | Idiomas de los textos; el primero es el de por defecto |
| `languageTags` | cualquiera | Etiquetas que aceptan los mapas de idioma |
| `secret` | al azar | Clave de los cursores; fíjala si hay varias instancias |
| `createTransaction` | — | Envuelve cada escritura (`POST`, `PATCH`, `DELETE`) en una transacción del adaptador: la creación con su registro de idempotencia, y `If-Match` con la escritura; ver «Persistencia» |
| `idempotencyStore` | en memoria | Almacén de claves; uno duradero con `reserve`, `complete` y `release` |
| `idempotencyTtl` | `86400` | Segundos (mínimo 86400) |
| `idempotencyAnonymous` | `true` | `false` rechaza `Idempotency-Key` sin credenciales y lo declara (7.1). Pasar de `true` a `false` es un cambio incompatible (5.5) |
| `browserCredentials` | `'auto'` (`false` con `oauth`) | Si las credenciales de una petición las añade el navegador solo (5.8). `'auto'`: si trae `Cookie` o `Authorization: Basic`/`Digest`. `true`: siempre (un certificado de cliente no se ve desde `Request`). `false`: solo tokens en `Authorization`. O una función `(request) => boolean`. Los orígenes permitidos son el de la API (`publicOrigin` o el de la petición) y los de `cors.origins` |
| `maxBodyBytes` | 1 MiB | Más da `413` |
| `cors` | — | `true` (cualquier origen) o `{ origins: [...] }` (5.8): responde el preflight sin reglas de Restep y expone `ETag`, `Location`, `Link`, `Allow`, `Accept-Patch`, `Accept-Query`, `Retry-After`, `Deprecation`, `Sunset`, `Idempotent-Replayed`, `Preference-Applied`, `DPoP-Nonce`… a los clientes de navegador. Con una lista de orígenes, toda respuesta lleva `Vary: Origin`, también sin `Origin` o con un origen no permitido |
| `docs` | — | URL de la documentación, o lista de `{ href, hreflang, title }`: va como `Link: rel="service-doc"` en el descubrimiento (4.2, DEBERÍA) |
| `status`, `oauth`, `authenticate` | — | Ver arriba |
| `publicOrigin` | el de la petición | Origen público detrás de un proxy (para oauth y para la comprobación de `Origin`) |
| `onError` | `console.error` | Recibe las excepciones que acaban en `500` |

Los tipos de campo son los del descubrimiento (`string`, `integer`, `number`, `decimal`,
`boolean`, `date`, `datetime`, `duration`, `enum` con `values`) más `map` (mapa de idioma) y
`relation` (a uno, con `to`). Un campo puede llevar `required: true` y `description`. `validate(row,
ctx)` devuelve una lista de entradas de `errors` para reglas propias (ver la de ciclos en el ejemplo).
Los nombres de campo siguen la gramática de 3; uno que no la cumple no arranca.

### Formularios (4.3)

Con estas opciones, el esquema `create` guía al cliente que pinta un formulario de alta:

| En el campo | En el esquema | Qué hace |
|---|---|---|
| `title: t('Title', 'Título')` | `title`, en el idioma de la petición | Etiqueta del campo |
| `description` | `description` | Texto de ayuda |
| `default: 'novela-negra'` | `default`, solo en `create` | Valor inicial. El `POST` que no trae el campo lo guarda con ese valor (un `null` sí lo trae). Un campo obligatorio con `default` deja de estar en el `required` de `create` |
| `labels: { 'novela-negra': t('Crime', 'Novela negra'), … }` | `oneOf` de `const` con `title`, en lugar de `enum` | Opciones de un `enum` con su etiqueta |
| `examples: ['PT6H']` | `examples` | Ejemplos para el placeholder; nunca se envían |

Los campos salen en el orden en que se declaran en `fields`, que es el orden en que se muestran.

Para lo que depende del cliente o del momento (la fecha de hoy, su tienda), `newItem: (ctx) => cuerpo`
añade la acción `GET /colección:new` (extensión `actions`, 11.1). Devuelve los `default` y, encima,
lo que devuelva `newItem`, con `Cache-Control: private, no-store`, y no crea nada. Es la prueba que
cita el trabajo futuro de la spec (Apéndice B), así que puede cambiar.

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

Anuncia en el descubrimiento solo lo que cumple: `core`, `query`, `cache`, `writes` (si alguna
colección o singleton escribe), `actions` (si hay `newItem`) y `oauth` (si se configura).

| Perfil o extensión | Estado |
|---|---|
| `core` | Sí, salvo retiradas (`deprecations`, `Deprecation`, `Sunset`, 5.5), campos de solo lectura propios (solo `id` lo es), `406` por `Accept` (siempre responde JSON) y versiones mayores (`/v2/`) |
| `query` | Sí. Las colaciones `"server"` y los campos que un principal no puede leer los resuelve tu adaptador |
| `writes` | Sí. Con varias instancias o persistencia, solo con un adaptador transaccional como el de PostgreSQL ([`pg.mjs`](#postgresql)); el bloqueo de `If-Match` propio de la biblioteca solo coordina un proceso |
| `cache` | Sí (desde el borrador 6 es un perfil aparte; la biblioteca ya hacía lo que pide) |
| `oauth` | Sí, sin scopes por petición: un `403 insufficient_scope` lo lanza tu `verifyToken` o tu adaptador |
| `relations` | No: no anuncia el perfil ni hace `include`, ni subcolecciones (`path` con plantilla y `parent`). Las relaciones a uno sí se declaran, se validan y se filtran por `relacion.id` |
| `sync` | No: ninguna colección declara `sync` y `:changes` da `404` |
| `actions` | Solo la acción `new` de las colecciones con `newItem`; cualquier otra ruta con dos puntos da `404` |
| `inherit` | No: ni lo anuncia ni declara `inherit` |
| `batch`, `filter-expr`, `query-method` | No: sus parámetros y rutas fallan en voz alta (`unsupported_parameter`, `404`) |

### Borrador 6, regla a regla

| Regla (borrador 6) | Dónde |
|---|---|
| `"restep": "1.0-draft.6"` (1.1) | Biblioteca |
| Estado estable o experimental (1.2) | No aplica: no anuncia ninguna parte experimental |
| `cache` separado de `writes`; `private` en toda respuesta con credenciales (5.1, 8) | Biblioteca: anuncia `cache`; `private` cuando hay principal. Que tu `authenticate` devuelva un principal para toda petición con credenciales es cosa tuya |
| `inherit` como extensión (11.6) | No implementado, no anunciado |
| `id_from`, `taken`, `id` borrados no reutilizados (5.1) | Biblioteca, con `taken` del adaptador (memoria: sí; `pg.mjs`: no admite `idFrom`) |
| `collations` (6.1) | Declaración y validación en la biblioteca; la colación `"server"` la aplica el adaptador (`memoryAdapter`: sin mayúsculas ni acentos) |
| `singletons` (5.9) | Biblioteca, sin `id`, mapas de idioma ni acciones |
| Subcolecciones con `parent` (4.2) | No implementado: `path` con plantilla no arranca |
| `415` y `charset` en escrituras (3, 5.1) | Biblioteca |
| Orden entre errores (5.4) | Biblioteca, para los errores que da ella; el `403` por campo y el `409` por estado los lanza tu `validate` o tu adaptador |
| Query en «la misma petición», no en el destino (7.1) | Biblioteca |
| `idempotency.anonymous` (7.1) | Biblioteca (`idempotencyAnonymous`); no hay acciones `POST` idempotentes que ignoren la clave |
| `_etag` en toda respuesta de un elemento, ETag sin `_etag` (7.2) | Biblioteca |
| `fields`/`include` en escrituras, `limit` sin `max_limit` → `unsupported_parameter` (5.3, 6.3, 6.4) | Biblioteca (siempre declara `max_limit`) |
| Gramática de los nombres (3) | Biblioteca, al arrancar; `reason` al lanzar |
| `+` como espacio; ruta comparada tras decodificar (3, 5.2) | Biblioteca |
| Solo lectura en `POST`/`PATCH` (4.3, 5.1) | Solo `id`; una relación con su valor actual se ignora sin comprobarla. Campos de solo lectura propios: no implementado |
| Descubrimiento igual para todos; miembros propios con `x-` (4.2) | Biblioteca (no añade miembros propios) |
| `deprecations`, `announced`, `kind` (5.5) | No implementado |
| `Origin`/`Sec-Fetch-Site` con credenciales del navegador (5.8) | Biblioteca, con `browserCredentials`; un certificado de cliente lo tienes que declarar tú |
| `sync` por colección (10) | No implementado (`:changes` da `404`) |
| `403` por campo que no se puede cambiar, `409` por estado, campos ilegibles en filtros y `total`, `422` igual para un elemento invisible (5.1, 6.1, 6.5) | Delegado: tu adaptador y tu `validate` |
| `429`/`503` solo sin efecto (5.7) | La biblioteca no los da; si tu adaptador los lanza, que sea sin efecto |

## Persistencia, fallos y varias instancias

El almacén en memoria es para ejemplos y pruebas: pierde las claves al reiniciar. Un
almacén duradero separado de los datos **no basta** para cumplir §7.1. El efecto de crear
el recurso y la respuesta que se repetirá deben confirmarse en la misma transacción.

`createTransaction(work, ctx)` envuelve cada escritura completa (`POST` de colección, `PATCH` y
`DELETE` de un elemento):

```js
const api = createRestep({
  collections,
  idempotencyStore,
  createTransaction: (work) => database.transaction((connection) => work(connection)),
});
```

`database.transaction` es el método transaccional de tu adaptador, no una dependencia de
Restep. Debe confirmar únicamente si `work` termina bien, revertir si falla y resolver su
promesa después del commit. No debe reejecutar automáticamente el callback con la misma
petición consumida. La conexión llega como `ctx.transaction` a `data.get`, `data.create`,
`data.update` y `data.delete`, y como último argumento `ctx` a `reserve(key, print, ttlMs, ctx)`,
`complete(key, response, ctx)` y `release(key, ctx)`. **Todos deben usar esa misma transacción**.
`reserve` debe ser atómico entre procesos; su implementación debe resolver también las reservas
concurrentes. Antes de `PATCH` y `DELETE`, la biblioteca lee el elemento con `ctx.forUpdate: true`:
el adaptador debe bloquearlo (`SELECT … FOR UPDATE`) para que evaluar `If-Match` y escribir sean
atómicos también entre procesos (7.2).

Sin esa coordinación, una excepción después de llamar a `data.create` deja la reserva
pendiente: el reintento recibe `409 request_in_progress`, nunca vuelve a crear a ciegas.
Esto incluye un adaptador que confirma el efecto y después lanza un error de conexión.
Las reservas pendientes del almacén en memoria no caducan automáticamente. Un almacén
propio debe conservar las de resultado incierto hasta recuperar la respuesta o demostrar
que no hubo efecto; no debe borrarlas por un TTL. Esta protección evita duplicados, pero
puede necesitar recuperación operativa para desbloquear la clave. Las peticiones que
fallan durante la validación sí liberan su reserva.

El mutex de esta biblioteca solo protege el proceso actual. Los efectos externos (pagos,
correo) requieren su propia coordinación; el hook no los convierte en transacciones de base
de datos.

### PostgreSQL

[`pg.mjs`](pg.mjs) es un adaptador transaccional para PostgreSQL 11 o posterior. Tampoco tiene
dependencias: recibe un pool compatible con [`pg`](https://node-postgres.com/) (`pool.connect()`
da un cliente con `query(text, values)` y `release(err)`).

```js
import pg from 'pg';
import { createRestep } from './restep-server.mjs';
import { migrate, pgTransaction, pgIdempotencyStore, pgDocumentAdapter } from './pg.mjs';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await migrate(pool); // una vez, al desplegar; no desde varios procesos a la vez

const api = createRestep({
  collections: { books: { fields, data: pgDocumentAdapter({ pool, collection: 'books' }) } },
  createTransaction: pgTransaction(pool),
  idempotencyStore: pgIdempotencyStore(),
  secret: process.env.RESTEP_SECRET, // el mismo en todas las instancias, para los cursores
});
```

| Exporta | Qué hace |
|---|---|
| `schema(opts)`, `migrate(pool, opts)` | El SQL de las tablas (abajo) y su ejecución. `opts`: `idempotencyTable`, `itemsTable` |
| `pgTransaction(pool)` | El `createTransaction`: `BEGIN`, el trabajo en una conexión, `COMMIT`; `ROLLBACK` si falla. Un `COMMIT` fallido (conexión caída, confirmación perdida) da `500` y no se reintenta: el reintento del cliente con la misma clave lo resuelve leyendo la base de datos |
| `pgIdempotencyStore({ table })` | El almacén de claves. Exige `ctx.transaction` |
| `pgDocumentAdapter({ pool, collection, table })` | Un adaptador de datos que guarda cada elemento como `jsonb`, con `id` de una secuencia (`bigserial`: nunca se reutilizan, y `07` no es `7`). No tiene `taken`, así que no admite `idFrom: 'client'` ni `'either'`. Escribe en la transacción y bloquea con `ctx.forUpdate`. `list` filtra y ordena en el proceso con las reglas de la biblioteca: vale para pruebas y colecciones pequeñas; para las grandes, escribe tu adaptador con SQL siguiendo el mismo contrato |
| `inFlightReservations(pool)` | Las transacciones que tienen ahora una clave reservada: `pid`, `state`, `age_ms`, `xact_start`, `application_name`, `client_addr`, `wait_event` |
| `terminateReservation(pool, pid)` | Termina el backend de una reserva atascada y espera a que desaparezca. Rechaza (`false`) un `pid` que no tiene reserva |
| `purgeExpired(pool, { table })` | Borra las respuestas guardadas cuyo plazo ha pasado |

Tu propio adaptador de datos puede usar `pgTransaction` y `pgIdempotencyStore` igual: basta con
que sus escrituras usen `ctx.transaction` y su `get` añada `FOR UPDATE` cuando llega
`ctx.forUpdate` con transacción.

**Esquema** (`schema()` lo genera; los nombres de tabla son configurables):

```sql
CREATE TABLE restep_idempotency (
  scope      text PRIMARY KEY,   -- principal (hash), método, ruta y clave
  print      text NOT NULL,      -- hash del cuerpo como valor JSON
  response   jsonb,              -- { status, headers, body_text? }: el cuerpo como texto JSON, para repetirlo igual
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX restep_idempotency_expires ON restep_idempotency (expires_at);
-- Trigger de restricción diferido: una reserva sin respuesta no puede confirmarse.
CREATE CONSTRAINT TRIGGER restep_idempotency_complete AFTER INSERT OR UPDATE ON restep_idempotency
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION restep_idempotency_complete();
CREATE TABLE restep_items (
  collection text NOT NULL, id bigserial, doc jsonb NOT NULL, PRIMARY KEY (collection, id)
);
```

**Cómo garantiza 7.1 y 7.2:**

- La fila de la clave, el recurso creado y la respuesta guardada se confirman en la misma
  transacción. Si el proceso muere antes del `COMMIT`, PostgreSQL revierte las tres cosas; si
  muere después, o se pierde la confirmación, las tres están y el reintento repite la respuesta.
  El trigger diferido impide confirmar una reserva sin respuesta, así que **nunca hay en la tabla
  reservas con resultado incierto**, y ninguna caduca por TTL: solo caducan respuestas completas.
- Mientras una petición está en curso, su transacción tiene dos bloqueos consultivos
  (`pg_try_advisory_xact_lock`): uno de la clave y otro de la clave con el cuerpo. Otra petición con
  la misma clave, desde cualquier proceso, responde sin esperar: `409 request_in_progress` si su
  cuerpo es el mismo y `422 idempotency_mismatch` si no. Los bloqueos se liberan solos al acabar la
  transacción, también si el proceso muere o se termina su backend.
- `PATCH` y `DELETE` leen el elemento con `FOR UPDATE` dentro de la transacción: una segunda
  escritura con la misma versión espera a la primera, lee la versión nueva y recibe `412` (o `404`
  si la primera lo borró).

**Reservas atascadas: procedimiento operativo.** Una reserva solo existe mientras vive su
transacción. Si los reintentos de una clave reciben `409` durante mucho tiempo, su transacción sigue
abierta: una petición lenta, o un proceso colgado (o una conexión medio cerrada) que PostgreSQL aún
no ha detectado.

1. Obsérvalas con `inFlightReservations(pool)` o con SQL (el bloqueo consultivo `(0x52455354, 0)`,
   compartido, marca a las transacciones con una reserva):

   ```sql
   SELECT a.pid, a.state, now() - a.xact_start AS age, a.application_name, a.client_addr
     FROM pg_locks l JOIN pg_stat_activity a USING (pid)
    WHERE l.locktype = 'advisory' AND l.classid = 1380275028 AND l.objid = 0 AND l.objsubid = 2
    ORDER BY a.xact_start;
   ```

   Alerta cuando `age` supere con holgura la duración máxima de una escritura.
2. Si el proceso dueño sigue trabajando (`state = 'active'`), espera. Si está `idle in transaction`
   mucho tiempo, o su proceso ya no existe, termínalo: `terminateReservation(pool, pid)` o
   `SELECT pg_terminate_backend(pid)`.
3. Terminar el backend revierte la transacción entera: reserva, efecto y respuesta. Esa reversión
   es la prueba de que no hubo efecto; no hace falta liberar nada a mano. El siguiente reintento con
   la misma clave crea el recurso una sola vez. Si la transacción llegó a confirmarse antes de
   terminarla, la fila de la clave tiene su respuesta y el reintento la repite.
4. Para que esto ocurra solo, configura `idle_in_transaction_session_timeout` (por ejemplo, unas
   veces la duración máxima de una escritura) y keepalives TCP en el servidor. Es seguro por el mismo
   motivo: PostgreSQL revierte de forma atómica. Lo que no se debe hacer, y este adaptador no hace, es
   borrar una reserva confirmada sin respuesta por haber pasado un plazo.

Para consultar la respuesta guardada de una clave concreta:
`SELECT response FROM restep_idempotency WHERE scope LIKE '% POST /books <clave>'`.
`purgeExpired(pool)` (por ejemplo, una vez al día) borra las respuestas caducadas.

**Límites.** Los efectos fuera de PostgreSQL (pagos, correo, otra base de datos) no entran en la
transacción. No se prueba la caída del sistema operativo ni del disco (las pruebas paran
PostgreSQL con `pg_ctl stop -m immediate`, que sí recupera desde el WAL). Se ha probado con
PostgreSQL 14, aislamiento `READ COMMITTED` y `pg` 8.

## Pruebas

```bash
node --test tools/restep-server/recovery.test.mjs
node tools/restep-server/test.mjs
node --test tools/restep-server/pg.test.mjs   # necesita PostgreSQL y npm install en tools/restep-server
```

Arrancan el ejemplo en los puertos 8810 y 8811 (este con oauth) y le pasan
`restep-check --writes` (0.7.0, borrador 6), que tiene que dar 0 fallos; después prueban
`handle(Request)` directamente (orden de errores, idempotencia con una petición en curso, `428`,
idioma, `base`, errores del adaptador, configuración errónea y, del borrador 6, `415` y `charset`,
`_etag`, la query en la idempotencia, `idempotencyAnonymous`, `idFrom` y `taken`, rutas
decodificadas, `+` como espacio, colaciones, relaciones con su valor actual, singletons,
gramática de los nombres y `Origin`) y los adaptadores de Express (puerto 8813) y Hono.

`pg.test.mjs` crea un clúster temporal (`initdb` en un directorio temporal, solo socket Unix,
puerto 54320-54329; se para y se borra al terminar, también si falla) y arranca dos procesos
servidores ([`pg-worker.mjs`](pg-worker.mjs), puertos 8100 y 8101) contra la misma base de datos.
Prueba con fallos reales: peticiones simultáneas desde los dos procesos, `SIGKILL` antes y después
del `COMMIT`, un `COMMIT` confirmado cuya respuesta corta un proxy de socket, `pg_terminate_backend`
de una reserva atascada, caída y recuperación de PostgreSQL, y `PATCH`/`DELETE` concurrentes con la
misma versión. Busca los binarios en `PG_BIN`, `pg_config --bindir`, el `PATH` y rutas habituales;
sin binarios o sin `pg` instalado se omite y lo dice (`node tools/verify.mjs` la lista como omitida,
no como aprobada). Las simulaciones de `recovery.test.mjs` se mantienen como regresiones sin puertos.

## Dudas sobre la spec

El borrador 6 resolvió varias de las que había aquí: `count=false` sin `count` declarado y
`fields` en una escritura dan `unsupported_parameter` (5.3, 6.3), `If-Match` contra un elemento recién
borrado da `404` (7.2), la idempotencia sin credenciales se puede rechazar con `"anonymous": false`
(7.1) y el `If-Match` de un `POST` se compara con la ETag del `GET` de la colección sin parámetros
(7.2). Quedan:

- **Esperar o responder `409` con la primera petición en curso** (7.1): la especificación permite
  las dos cosas. Aquí no se espera: la segunda recibe `409 request_in_progress` (o `422` si su cuerpo
  es otro) en cuanto ve el bloqueo, para no atar conexiones a peticiones lentas. Un caso límite: una
  tercera petición con el mismo cuerpo que otra que está a punto de recibir `422` puede recibir un
  `409` pasajero; su reintento obtiene la respuesta definitiva.
- **ETag de la colección para `If-Match` en un `POST`** (7.2): es la del `GET` sin parámetros, que
  aquí es la primera página por defecto, así que no protege de cambios más allá de ella.
- **Credenciales del navegador** (5.8): una biblioteca no sabe con qué credencial autenticó tu
  `authenticate`, así que `'auto'` lo deduce de las cabeceras (`Cookie`, `Basic`, `Digest`). Con
  cookies que no autentican junto a un token en `Authorization`, `'auto'` puede rechazar una
  escritura de otro origen que la especificación no cubre; pon `browserCredentials: false`.
- **«El valor que el elemento tendría»** (5.1, campos de solo lectura en un `POST`): la biblioteca
  no puede saberlo antes de que el adaptador cree el elemento, por eso no ofrece campos de solo
  lectura propios.
- **`taken` igual para todos** (5.1): la biblioteca pregunta a `taken` antes de crear, pero que la
  respuesta no dependa de lo que ve el principal, y que se recuerden los `id` borrados, solo lo
  puede garantizar el adaptador.
- **Orden por defecto**: un `id` se compara como texto, así que `"12"` va antes que `"7"`. Es
  determinista (5.2) y el borrador 6 deja claro que el orden de los `id` es del servidor, pero
  sorprende; por eso existe `defaultSort`.

## Código y avisos

Código y avisos: <https://github.com/restep-spec/restep-server>. Ese repositorio se genera desde la web de
Restep, donde la herramienta se desarrolla junto a la [especificación](https://restep.wubytes.com/1/) y el servidor de
referencia: `vendor/` y `schema/` son copias de la web para que las pruebas funcionen solas.

Licencia MIT.
