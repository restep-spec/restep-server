// restep-server · Biblioteca de servidor para Restep 1 (borrador 6, "restep": "1.0-draft.6"): https://restep.wubytes.com/1/
// Hace la parte difícil del protocolo (descubrimiento, parámetros, errores, Merge Patch, ETag,
// Idempotency-Key, caché, idioma) y deja al usuario solo el acceso a sus datos: un adaptador con
// list, get, create, update y delete por colección (y get y update por singleton).
//
// El núcleo solo usa la Web estándar (Request, Response, URL, Web Crypto), así que funciona igual en
// Node 18+, Deno, Bun o Cloudflare Workers. Los adaptadores de Node http y Express están al final.
//
//   import { createRestep, memoryAdapter, toNodeListener } from './restep-server.mjs';
//   const api = createRestep({ collections: { books: { fields: {...}, data: memoryAdapter([...]) } } });
//   createServer(toNodeListener(api)).listen(8080);

const webcrypto = globalThis.crypto?.subtle ? globalThis.crypto : (await import('node:crypto')).webcrypto;

const PROFILE = 'https://w3id.org/restep/1/'; // identificador: enlace de perfil y tipos de error
const RESTEP = '1.0-draft.6'; // 1.1: un borrador se declara con su sufijo
// 3: gramática de los nombres que declara el descubrimiento (colecciones, campos, filtros, acciones, reasons…).
export const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
// 3: un id son caracteres no reservados del RFC 3986, ni "." ni "..".
const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9\-._~]+$/.test(v) && v !== '.' && v !== '..';
const COLLATIONS = ['codepoint', 'server'];
const RESERVED = ['filter', 'sort', 'fields', 'include', 'count', 'limit', 'cursor', 'since', 'languages'];
const SCALARS = ['string', 'integer', 'number', 'decimal', 'boolean', 'date', 'datetime', 'duration', 'enum'];
const OPS = ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'in', 'null'];
const LIBRARY_LANGUAGES = ['en', 'es']; // los idiomas en que la biblioteca sabe dar sus textos
const DAY = 86400;

// ── Textos para personas (5.6) ─────────────────────────────────────────────────
// Un texto es una cadena (igual en todos los idiomas) o un objeto { en, es, ... }.
export const t = (en, es) => ({ en, es });
const text = (v, lang) => (v == null || typeof v === 'string' ? v : v[lang] ?? v.en ?? Object.values(v)[0]);

// Lookup del RFC 4647 (3.4) sobre los idiomas ofrecidos: por peso y luego por orden en la cabecera,
// sin distinguir mayúsculas, recortando por el final. *, q=0 y los rangos mal formados se ignoran.
const RANGE = /^[a-z]{1,8}(-[a-z0-9]{1,8})*$/i;
export function pickLanguage(header, languages) {
  const ranges = [];
  (header ?? '').split(',').forEach((part, i) => {
    const [range, ...params] = part.split(';').map((x) => x.trim());
    if (!RANGE.test(range)) return;
    let q = 1;
    for (const p of params) {
      const m = /^q=(0(\.\d{0,3})?|1(\.0{0,3})?)$/i.exec(p);
      if (!m) return;
      q = Number(m[1]);
    }
    if (q > 0) ranges.push({ range: range.toLowerCase(), q, i });
  });
  ranges.sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { range } of ranges) {
    for (let tag = range; tag;) {
      if (languages.includes(tag)) return tag;
      const cut = tag.lastIndexOf('-');
      tag = cut < 0 ? '' : tag.slice(0, cut).replace(/-[a-z0-9]$/, '');
    }
  }
  return languages[0];
}

// Etiqueta de idioma bien formada (RFC 5646, 2.1) y en minúsculas.
export const LANGUAGE_TAG = new RegExp('^(?:(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{4,8})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|[0-9]{3}))?' +
  '(?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*(?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*(?:-x(?:-[a-z0-9]{1,8})+)?' +
  '|x(?:-[a-z0-9]{1,8})+|en-gb-oed|i-(?:ami|bnn|default|enochian|hak|klingon|lux|mingo|navajo|pwn|tao|tay|tsu)' +
  '|sgn-(?:be-fr|be-nl|ch-de)|art-lojban|cel-gaulish|no-bok|no-nyn|zh-(?:guoyu|hakka|min|min-nan|xiang))$');

// ── Errores (5.4) ──────────────────────────────────────────────────────────────
// Lánzalo desde un adaptador para responder con un problem+json: new RestepError(409, 'conflict', 'Ya existe.')
// detail (y el detail de cada entrada de errors) puede ser un texto t(en, es).
export class RestepError extends Error {
  constructor(status, code, detail, { headers = {}, ...extra } = {}) {
    // 5.4: un reason sigue la gramática de los nombres; uno que no la cumple es un error de programación (500).
    if (extra.reason !== undefined && (typeof extra.reason !== 'string' || !NAME.test(extra.reason)))
      throw new Error(`restep-server: reason ${JSON.stringify(extra.reason)} no cumple la gramática de los nombres (3)`);
    super(text(detail, 'en') ?? code);
    Object.assign(this, { status, code, detail, extra, headers });
  }
}
const TITLES = {
  400: t('Bad request', 'Petición incorrecta'), 401: t('Unauthenticated', 'Sin autenticar'), 403: t('Forbidden', 'Prohibido'),
  404: t('Not found', 'No encontrado'), 405: t('Method not allowed', 'Método no permitido'), 406: t('Not acceptable', 'No aceptable'),
  409: t('Conflict', 'Conflicto'), 410: t('Gone', 'Ya no existe'), 412: t('Precondition failed', 'Falla una precondición'),
  413: t('Content too large', 'Contenido demasiado grande'), 415: t('Unsupported media type', 'Tipo de contenido no admitido'),
  422: t('Invalid data', 'Datos no válidos'), 428: t('Precondition required', 'Falta una precondición'),
  429: t('Too many requests', 'Demasiadas peticiones'), 500: t('Internal error', 'Error interno'),
  501: t('Not implemented', 'No implementado'), 503: t('Unavailable', 'No disponible'),
};
const bad = (parameter, detail) => new RestepError(400, 'invalid_parameter', detail, { parameter });
const unsupported = (parameter, detail = t(`This resource does not support ${parameter}.`, `Este recurso no admite ${parameter}.`)) =>
  new RestepError(400, 'unsupported_parameter', detail, { parameter });
const invalid = (errors, detail = t('Invalid data.', 'Datos no válidos.')) => new RestepError(422, 'invalid', detail, { errors });
const once = (key) => bad(key, t(`Send ${key} once.`, `Envía ${key} una sola vez.`));
const notFound = (path) => new RestepError(404, 'not_found', t(`${path} does not exist.`, `${path} no existe.`));
// 5.1: un id que la colección tiene o tuvo. Igual tanto si el cliente puede ver ese elemento como si no.
// Lánzalo desde el create de un adaptador propio cuando su clave primaria rechace el id.
export const takenError = () => new RestepError(409, 'conflict', t('That id is taken.', 'Ese id ya está cogido.'),
  { errors: [{ pointer: '/id', code: 'taken', detail: t('An item of this collection has or had this id.', 'Un elemento de esta colección tiene o tuvo este id.') }] });

// ── Tipos y comparación (3, 6.1) ──────────────────────────────────────────────
export const DECIMAL = /^-?\d+(\.\d+)?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|([+-])(\d{2}):(\d{2}))$/;
const DURATION = /^P(?!$)(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?=\d)(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;
const validDate = (y, m, d) => { const x = new Date(Date.UTC(+y, +m - 1, +d)); return x.getUTCMonth() === +m - 1 && x.getUTCDate() === +d; };
const isDate = (v) => { const m = DATE.exec(v); return !!m && validDate(m[1], m[2], m[3]); };
const isDatetime = (v) => { const m = DATETIME.exec(v); return !!m && validDate(m[1], m[2], m[3]) && +m[4] < 24 && +m[5] < 60 && +m[6] < 61; };

function cmpDecimal(a, b) { // exacta: compara cadenas de dígitos, nunca a través de Number
  const neg = (s) => s.startsWith('-') && /[1-9]/.test(s);
  if (neg(a) !== neg(b)) return neg(a) ? -1 : 1;
  const sign = neg(a) ? -1 : 1;
  const [ai, af = ''] = a.replace('-', '').split('.'), [bi, bf = ''] = b.replace('-', '').split('.');
  const i1 = ai.replace(/^0+(?=\d)/, ''), i2 = bi.replace(/^0+(?=\d)/, '');
  if (i1.length !== i2.length) return sign * (i1.length - i2.length);
  if (i1 !== i2) return sign * (i1 < i2 ? -1 : 1);
  const n = Math.max(af.length, bf.length), f1 = af.padEnd(n, '0'), f2 = bf.padEnd(n, '0');
  return f1 === f2 ? 0 : sign * (f1 < f2 ? -1 : 1);
}
function cmpText(a, b) { // por puntos de código Unicode, no por unidades UTF-16
  const x = [...a], y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
}
function instant(v) { // [segundos desde 1970, fracción como cadena de dígitos]
  const m = DATETIME.exec(v);
  if (!m) return [NaN, ''];
  const offset = m[8].toUpperCase() === 'Z' ? 0 : (m[9] === '-' ? -1 : 1) * (+m[10] * 60 + +m[11]);
  return [Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 - offset * 60, (m[7] ?? '').slice(1)];
}
function seconds(v) { // longitud de una duración sin años ni meses; un día cuenta como 24 horas
  const m = DURATION.exec(v);
  if (!m) return NaN;
  const n = (i) => Number(m[i] ?? 0);
  return n(1) * 365 * DAY + n(2) * 30 * DAY + n(3) * 7 * DAY + n(4) * DAY + n(5) * 3600 + n(6) * 60 + n(7);
}
// La colación "server" de memoryAdapter (6.1): sin distinguir mayúsculas ni acentos. Es total y
// determinista, y su igualdad es la de su orden (compare da 0 exactamente cuando son iguales).
const serverCollator = new Intl.Collator('und', { sensitivity: 'base' });
// Compara dos valores de un mismo tipo del descubrimiento (6.1). Para usarla en un adaptador propio.
// collation: la de collations para ese campo; "server" compara texto con serverCollator, cualquier otra por puntos de código.
export function compareValues(type, a, b, collation) {
  if (collation === 'server' && (type === 'string' || type === undefined)) return serverCollator.compare(String(a), String(b));
  switch (type) {
    case 'decimal': return cmpDecimal(String(a), String(b));
    case 'integer': case 'number': return a - b;
    case 'boolean': return Number(a) - Number(b);
    case 'date': return cmpText(String(a), String(b));
    case 'datetime': {
      const [s1, f1] = instant(a), [s2, f2] = instant(b);
      if (s1 !== s2) return s1 - s2;
      const n = Math.max(f1.length, f2.length), x = f1.padEnd(n, '0'), y = f2.padEnd(n, '0');
      return x === y ? 0 : x < y ? -1 : 1;
    }
    case 'duration': return seconds(a) - seconds(b);
    default: return cmpText(String(a), String(b));
  }
}
// El valor de una ruta: "price", "name.es-mx" (una traducción) o "author.id" (el id de una relación).
export const valueAt = (row, path) => {
  const dot = path.indexOf('.');
  if (dot < 0) return row[path];
  const head = row[path.slice(0, dot)], tail = path.slice(dot + 1);
  // Una relación guardada como id suelto se lee como { id } (igual que en la representación).
  return (typeof head === 'string' || typeof head === 'number') && tail === 'id' ? String(head) : head?.[tail];
};
const COMPARE = { eq: (c) => c === 0, ne: (c) => c !== 0, lt: (c) => c < 0, le: (c) => c <= 0, gt: (c) => c > 0, ge: (c) => c >= 0 };
// ¿Cumple row el filtro { field, op, value, type }? Salvo null, ningún operador casa con un valor ausente o null.
// Un filtro con nombre (6.1) llega como { named, value, apply } y lo decide su apply (row, value) => boolean.
export function matches(row, { field, op, value, type, collation, named, apply }) {
  if (named !== undefined) {
    if (typeof apply !== 'function') throw new Error(`El filtro con nombre ${named} necesita apply para filtrar en memoria; un adaptador propio lo traduce por su nombre`);
    return !!apply(row, value);
  }
  const v = valueAt(row, field);
  if (op === 'null') return (v === undefined || v === null) === value;
  if (v === undefined || v === null) return false;
  if (op === 'in') return value.some((x) => compareValues(type, v, x, collation) === 0);
  return COMPARE[op](compareValues(type, v, value, collation));
}
// Ordena por [{ field, desc, type, collation }]; los valores ausentes van al final en los dos sentidos.
export function sorter(sort) {
  return (a, b) => {
    for (const { field, desc, type, collation } of sort) {
      const x = valueAt(a, field), y = valueAt(b, field);
      if (x == null || y == null) { if (x == null && y == null) continue; return x == null ? 1 : -1; }
      const d = compareValues(type, x, y, collation) * (desc ? -1 : 1);
      if (d) return d;
    }
    return 0;
  };
}

// ── Adaptador en memoria ──────────────────────────────────────────────────────
// Para pruebas y ejemplos. Un adaptador propio implementa los mismos métodos (todos opcionales salvo
// list y get); los que faltan quitan su método HTTP de la colección.
//   list({ filter, sort, limit, cursor, count }, ctx) → { items, next, total }
//   get(id, ctx) → item | null;  create(data, ctx) → item;  update(id, data, ctx) → item;  delete(id, ctx)
//   taken(id, ctx) → boolean: si el id lo tiene o lo tuvo un elemento (5.1), para id_from "client" o "either"
export function memoryAdapter(initial = [], { generateId } = {}) {
  const rows = new Map(initial.map((r) => [String(r.id), structuredClone({ ...r, id: String(r.id) })]));
  // 5.1: los id que ha tenido la colección, también los de elementos borrados: nunca se reutilizan.
  const used = new Set(rows.keys());
  let counter = Math.max(0, ...[...rows.keys()].map(Number).filter(Number.isInteger)) + 1;
  const newId = generateId ?? (() => { while (used.has(String(counter))) counter++; return String(counter++); });
  return {
    rows,
    async taken(id) { return used.has(id); },
    async list({ filter, sort, limit, cursor, count }) {
      const all = [...rows.values()].filter((r) => filter.every((f) => matches(r, f))).sort(sorter(sort));
      const offset = cursor ?? 0; // el cursor de este adaptador es un desplazamiento; la biblioteca lo firma
      return {
        items: all.slice(offset, offset + limit).map((r) => structuredClone(r)),
        next: offset + limit < all.length ? offset + limit : null,
        ...(count && { total: all.length }),
      };
    },
    async get(id) { return rows.has(id) ? structuredClone(rows.get(id)) : null; },
    // data.id llega si el cliente lo eligió (id_from); si no, se asigna uno que la colección no haya tenido.
    async create(data) {
      const id = data.id ?? newId();
      if (used.has(id)) throw takenError();
      used.add(id);
      rows.set(id, structuredClone({ ...data, id }));
      return structuredClone(rows.get(id));
    },
    async update(id, data) { rows.set(id, structuredClone({ ...data, id })); return structuredClone(rows.get(id)); },
    async delete(id) { rows.delete(id); },
  };
}

// Un singleton en memoria (5.9), para pruebas y ejemplos: get(ctx) → objeto; update(data, ctx) → objeto.
export function memorySingleton(initial = {}) {
  let value = structuredClone(initial);
  return {
    async get() { return structuredClone(value); },
    async update(data) { value = structuredClone(data); return structuredClone(value); },
  };
}

// Almacén de claves de idempotencia en memoria (7.1). En producción, uno duradero con la misma forma:
// reserve(key, print, ttlMs) debe ser atómico (como SET NX): devuelve la entrada que ya había
// ({ print, response? }; sin response, la primera sigue en curso) o null tras reservarla.
// Pending outcomes must not expire into retries. Recover them before releasing a key.
// Custom stores receive ctx last; use ctx.transaction when createTransaction is configured.
export function memoryIdempotencyStore() {
  const map = new Map();
  const live = (key) => { const e = map.get(key); if (e?.response && e.expires <= Date.now()) { map.delete(key); return undefined; } return e; };
  return {
    reserve(key, print, ttl) {
      const e = live(key);
      if (e) return e;
      map.set(key, { print, expires: Date.now() + ttl });
      return null;
    },
    complete(key, response) { const e = map.get(key); if (e) e.response = response; },
    release(key) { map.delete(key); },
  };
}

// ── Utilidades ────────────────────────────────────────────────────────────────
const enc = new TextEncoder();
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const hash = async (s) => hex(await webcrypto.subtle.digest('SHA-256', enc.encode(s))).slice(0, 32);
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
export const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : isObject(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  : JSON.stringify(v));
const etagOf = async (v) => `"${await hash(canonical(v))}"`;
const ptr = (f) => `/${String(f).replace(/~/g, '~0').replace(/\//g, '~1')}`;
const sfString = (s) => `"${s.replace(/[\\"]/g, '\\$&')}"`;
const tags = (h) => (h ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const strongMatch = (h, tag) => tags(h).some((x) => x === '*' || (!x.startsWith('W/') && x === tag));
const weakMatch = (h, tag) => tags(h).some((x) => x === '*' || x.replace(/^W\//, '') === tag);
// 3: el tipo de un cuerpo, sin distinguir mayúsculas. charset solo puede ser utf-8, entre comillas o no y
// en cualquier caja; los demás parámetros se ignoran. Sin Content-Type, ni siquiera vacío, no vale.
function mediaTypeOk(header, types) {
  if (header === null) return false;
  const [type, ...params] = header.split(';');
  if (!types.includes(type.trim().toLowerCase())) return false;
  for (const p of params) {
    const eq = p.indexOf('=');
    if (eq < 0 || p.slice(0, eq).trim().toLowerCase() !== 'charset') continue;
    let value = p.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\(.)/g, '$1');
    if (value.toLowerCase() !== 'utf-8') return false;
  }
  return true;
}
const baseName = (k) => k.replace(/\[.*$/, '');
const isReserved = (b) => RESERVED.includes(b) || b.startsWith('$');
// RFC 7396, apartado 2
export function mergePatch(target, patch) {
  if (!isObject(patch)) return patch;
  const out = isObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) { if (v === null) delete out[k]; else out[k] = mergePatch(out[k], v); }
  return out;
}

// ── Configuración ─────────────────────────────────────────────────────────────
function configError(msg) { return new Error(`restep-server: ${msg}`); }
function normalizeField(name, f, cname) {
  const d = typeof f === 'string' ? { type: f } : { ...f };
  if (![...SCALARS, 'map', 'relation'].includes(d.type)) throw configError(`${cname}.fields.${name}: tipo desconocido ${d.type}`);
  if (d.type === 'enum' && (!Array.isArray(d.values) || !d.values.length)) throw configError(`${cname}.fields.${name}: un enum necesita values`);
  if (d.type === 'relation' && typeof d.to !== 'string') throw configError(`${cname}.fields.${name}: una relación necesita to`);
  // 3: los campos se declaran en los esquemas del descubrimiento, así que siguen la gramática de los nombres.
  if (!NAME.test(name)) throw configError(`${cname}.fields.${name}: un campo sigue la gramática de los nombres (3): una letra y hasta 63 letras, dígitos, _ o -`);
  // 4.3: default solo en escalares; el de un enum, uno de sus valores. labels: la etiqueta de cada valor del enum.
  if ('default' in d && (d.type === 'map' || d.type === 'relation')) throw configError(`${cname}.fields.${name}: default solo en campos escalares`);
  if ('default' in d && d.type === 'enum' && !d.values.includes(d.default)) throw configError(`${cname}.fields.${name}: default tiene que ser uno de values`);
  if (d.labels !== undefined && (d.type !== 'enum' || typeof d.labels !== 'object' || d.values.some((v) => d.labels[v] == null)))
    throw configError(`${cname}.fields.${name}: labels es para un enum y lleva una etiqueta por cada valor`);
  if (d.examples !== undefined && !Array.isArray(d.examples)) throw configError(`${cname}.fields.${name}: examples es una lista`);
  return d;
}
const FIXED_PATH = /^(\/(?!\.\.?(?:\/|$))[A-Za-z0-9\-._~]+)+$/; // una ruta fija, sin plantillas, sin "/" final ni segmentos de puntos
function normalizeCollection(name, def) {
  if (!NAME.test(name)) throw configError(`${name}: el nombre de una colección sigue la gramática de los nombres (3)`);
  if (!def.data || typeof def.data.list !== 'function' || typeof def.data.get !== 'function')
    throw configError(`${name}: data tiene que ser un adaptador con list y get (por ejemplo memoryAdapter([...]))`);
  const fields = { id: { type: 'string' } };
  for (const [f, d] of Object.entries(def.fields ?? {})) if (f !== 'id') fields[f] = normalizeField(f, d, name);
  const c = {
    name, path: def.path ?? `/${name}`, description: def.description, fields, data: def.data,
    filter: {}, namedFilters: {}, sort: def.sort ?? [], defaultSort: def.defaultSort ?? ['id'],
    maxLimit: def.maxLimit ?? 50, defaultLimit: def.defaultLimit ?? 20, count: def.count,
    validate: def.validate, newItem: def.newItem, requireIfMatch: !!def.requireIfMatch, requireIdempotencyKey: !!def.requireIdempotencyKey,
    idFrom: def.idFrom, idPattern: def.idPattern, collations: def.collations,
    methods: ['GET', ...(def.data.create ? ['POST'] : [])],
    itemMethods: ['GET', ...(def.data.update ? ['PATCH'] : []), ...(def.data.delete ? ['DELETE'] : [])],
  };
  if (!FIXED_PATH.test(c.path)) throw configError(`${name}: path tiene que ser una ruta fija como /books (sin plantillas: esta biblioteca no hace subcolecciones)`);
  // 5.1: quién elige el id. "client" y "either" necesitan saber qué id ha tenido la colección (taken).
  if (c.idFrom !== undefined) {
    if (!['server', 'client', 'either'].includes(c.idFrom)) throw configError(`${name}.idFrom: "server", "client" o "either"`);
    if (c.idFrom !== 'server' && (typeof def.data.taken !== 'function' || !def.data.create))
      throw configError(`${name}.idFrom: "${c.idFrom}" necesita un adaptador con create y taken(id, ctx), que diga si la colección tiene o tuvo ese id (5.1)`);
  }
  if (c.idPattern !== undefined && (c.idFrom ?? 'server') === 'server') throw configError(`${name}.idPattern: solo con idFrom "client" o "either"`);
  if (c.idPattern !== undefined) { try { c.idRegExp = new RegExp(c.idPattern, 'u'); } catch { throw configError(`${name}.idPattern: no es una expresión regular`); } }
  c.typeOf = (p) => {
    const dot = p.indexOf('.');
    if (dot < 0) return fields[p]?.type === 'map' || fields[p]?.type === 'relation' ? undefined : fields[p]?.type;
    const [a, b] = [p.slice(0, dot), p.slice(dot + 1)];
    if (fields[a]?.type === 'map' && LANGUAGE_TAG.test(b)) return 'string';
    if (fields[a]?.type === 'relation' && b === 'id') return 'string';
    return undefined;
  };
  for (const [f, d] of Object.entries(def.filter ?? {})) {
    const ops = Array.isArray(d) ? d : d.ops;
    const type = c.typeOf(f);
    if (!type) throw configError(`${name}.filter.${f}: no es un campo escalar, una traducción (campo.etiqueta) ni relación.id`);
    for (const op of ops) if (!OPS.includes(op)) throw configError(`${name}.filter.${f}: operador desconocido ${op}`);
    if (type === 'boolean' && ops.some((o) => !['eq', 'ne', 'null'].includes(o))) throw configError(`${name}.filter.${f}: un boolean solo admite eq, ne y null (6.1)`);
    if (f === 'id' && ops.some((o) => ['lt', 'le', 'gt', 'ge'].includes(o))) throw configError(`${name}.filter.id: el orden de los id es del servidor; sin lt, le, gt ni ge (6.1)`);
    c.filter[f] = { ops, type, description: Array.isArray(d) ? undefined : d.description };
  }
  // 6.1: filtros con nombre. Sin type, un interruptor; con type, llevan un valor de ese tipo.
  for (const [f, d] of Object.entries(def.namedFilters ?? {})) {
    if (!d || typeof d !== 'object' || !d.description) throw configError(`${name}.namedFilters.${f}: necesita description, que es lo que dice qué elementos devuelve`);
    if (!NAME.test(f)) throw configError(`${name}.namedFilters.${f}: un filtro con nombre sigue la gramática de los nombres (3)`);
    if (Object.hasOwn(c.filter, f)) throw configError(`${name}.namedFilters.${f}: ya es una clave de filter (6.1)`);
    if (d.type !== undefined && !SCALARS.includes(d.type)) throw configError(`${name}.namedFilters.${f}: tipo desconocido ${d.type}`);
    if (d.type === 'enum' && (!Array.isArray(d.values) || !d.values.length)) throw configError(`${name}.namedFilters.${f}: un enum necesita values`);
    if (d.apply !== undefined && typeof d.apply !== 'function') throw configError(`${name}.namedFilters.${f}: apply tiene que ser una función (fila, valor) => boolean`);
    c.namedFilters[f] = { type: d.type, values: d.values, description: d.description, apply: d.apply };
  }
  for (const s of [...c.sort, ...c.defaultSort.map((x) => x.replace(/^-/, ''))])
    if (!c.typeOf(s)) throw configError(`${name}.sort: ${s} no es un campo escalar ni una traducción`);
  // 6.1: collations, por campo de texto (o traducción campo.etiqueta) declarado en filter o en sort; nunca id.
  if (c.collations !== undefined) {
    if (!isObject(c.collations)) throw configError(`${name}.collations: un objeto { campo: "codepoint" | "server" }`);
    for (const [f, v] of Object.entries(c.collations)) {
      if (!COLLATIONS.includes(v)) throw configError(`${name}.collations.${f}: "codepoint" o "server"`);
      if (f === 'id' || c.typeOf(f) !== 'string' || !(Object.hasOwn(c.filter, f) || c.sort.includes(f)))
        throw configError(`${name}.collations.${f}: tiene que ser un campo string (o campo.etiqueta) declarado en filter o en sort, y no id`);
    }
  }
  c.collationOf = (f) => c.collations?.[f] ?? 'codepoint';
  if (c.count && !['exact', 'estimated'].includes(c.count)) throw configError(`${name}.count: "exact" o "estimated"`);
  if (c.newItem !== undefined && (typeof c.newItem !== 'function' || !def.data.create)) throw configError(`${name}.newItem: una función (ctx) => cuerpo, en una colección que admite POST`);
  return c;
}
// 5.9: un singleton, como /me: un elemento sin id ni colección. Su adaptador tiene get(ctx) y, para PATCH, update(data, ctx).
function normalizeSingleton(name, def) {
  if (!NAME.test(name)) throw configError(`singletons.${name}: el nombre sigue la gramática de los nombres (3)`);
  if (!def?.data || typeof def.data.get !== 'function') throw configError(`singletons.${name}: data tiene que ser un adaptador con get(ctx) y, si admite PATCH, update(data, ctx)`);
  const path = def.path ?? `/${name}`;
  if (!FIXED_PATH.test(path)) throw configError(`singletons.${name}: path tiene que ser una ruta fija como /me (sin plantillas)`);
  const fields = {};
  for (const [f, d] of Object.entries(def.fields ?? {})) {
    if (f === 'id') throw configError(`singletons.${name}.fields.id: esta biblioteca no da id a un singleton`);
    fields[f] = normalizeField(f, d, `singletons.${name}`);
    if (fields[f].type === 'map') throw configError(`singletons.${name}.fields.${f}: los mapas de idioma en un singleton quedan fuera de Restep 1 (5.9)`);
  }
  return { name, singleton: true, path, description: def.description, fields, data: def.data, validate: def.validate,
    requireIfMatch: !!def.requireIfMatch, methods: ['GET', ...(def.data.update ? ['PATCH'] : [])] };
}

// ── createRestep ──────────────────────────────────────────────────────────────
export function createRestep(options) {
  const {
    collections: defs, base: rawBase = '', languages = LIBRARY_LANGUAGES, languageTags = null,
    idempotencyTtl = DAY, idempotencyStore = memoryIdempotencyStore(), secret, maxBodyBytes = 1 << 20,
    createTransaction = null, status = null, oauth = null, authenticate = null, docs = null, cors = null, onError = (e) => console.error(e), version = '1',
    singletons: singletonDefs = {}, idempotencyAnonymous = true, browserCredentials = oauth ? false : 'auto',
  } = options;
  if (createTransaction !== null && typeof createTransaction !== 'function') throw configError('createTransaction must be a function');
  if (typeof idempotencyAnonymous !== 'boolean') throw configError('idempotencyAnonymous: true o false (7.1)');
  if (![true, false, 'auto'].includes(browserCredentials) && typeof browserCredentials !== 'function')
    throw configError('browserCredentials: "auto", true, false o una función (request) => boolean (5.8)');
  const base = rawBase.replace(/\/$/, '');
  if (base && !/^\/[^?#]*$/.test(base)) throw configError('base tiene que empezar por / (como "/api")');
  if (!languages.length || languages.some((l) => !LIBRARY_LANGUAGES.includes(l))) throw configError(`languages: solo ${LIBRARY_LANGUAGES.join(', ')}`);
  if (idempotencyTtl < DAY) throw configError('idempotencyTtl: al menos 86400 segundos (7.1)');
  if (oauth && (!Array.isArray(oauth.authorizationServers) || !oauth.authorizationServers.length || typeof oauth.verifyToken !== 'function'))
    throw configError('oauth necesita authorizationServers (al menos uno) y verifyToken(token, request)');
  const colls = Object.fromEntries(Object.entries(defs).map(([n, d]) => [n, normalizeCollection(n, d)]));
  const singles = Object.fromEntries(Object.entries(singletonDefs).map(([n, d]) => [n, normalizeSingleton(n, d)]));
  for (const c of [...Object.values(colls), ...Object.values(singles)]) for (const [f, d] of Object.entries(c.fields))
    if (d.type === 'relation' && !colls[d.to]) throw configError(`${c.singleton ? 'singletons.' : ''}${c.name}.fields.${f}: la colección ${d.to} no existe`);
  // 5.9: la ruta de un singleton no es una que tenga o pueda tener una colección o uno de sus elementos.
  for (const s of Object.values(singles)) {
    const clash = Object.values(colls).find((c) => s.path === c.path || s.path.startsWith(`${c.path}/`))
      ?? Object.values(singles).find((o) => o !== s && o.path === s.path);
    if (clash) throw configError(`singletons.${s.name}: la ruta ${s.path} choca con ${clash.singleton ? 'el singleton' : 'la colección'} ${clash.name}`);
  }
  const writable = Object.values(colls).some((c) => c.methods.length > 1 || c.itemMethods.length > 1)
    || Object.values(singles).some((s) => s.methods.length > 1);
  // cache (8) solo pide core: Cache-Control en toda lectura, ETag del elemento, 304 y Cache-Groups, que la biblioteca da siempre.
  const profiles = ['core', 'query', ...(writable ? ['writes'] : []), 'cache'];
  // actions (11.1): solo la acción new, en las colecciones con newItem.
  const extensions = [...(Object.values(colls).some((c) => c.newItem) ? ['actions'] : []), ...(oauth ? ['oauth'] : [])];
  // 4.1: un único enlace de perfil, a la URI de la versión; qué se implementa lo dice el descubrimiento.
  const profileLink = `<${PROFILE}>; rel="profile"`;
  // Documentación de la API (4.2, DEBERÍA): rel="service-doc" en la respuesta del descubrimiento.
  // docs: una URL o una lista de { href, hreflang, title }.
  const docsList = docs == null ? [] : (Array.isArray(docs) ? docs : [docs]).map((d) => (typeof d === 'string' ? { href: d } : d));
  if (docsList.some((d) => typeof d.href !== 'string' || !/^https?:\/\//.test(d.href))) throw configError('docs: una URL absoluta o una lista de { href, hreflang, title }');
  const docsLink = docsList.map((d) => `<${d.href}>; rel="service-doc"${d.hreflang ? `; hreflang="${d.hreflang}"` : ''}${d.title ? `; title="${d.title.replace(/"/g, "'")}"` : ''}`).join(', ');
  const statusPath = status ? `${base}${status.path ?? '/health'}` : null;
  const languageList = [...languages];
  const isMap = (c, f) => c.fields[f]?.type === 'map';
  const maps = (c) => Object.keys(c.fields).filter((f) => isMap(c, f));
  const relations = (c) => Object.keys(c.fields).filter((f) => c.fields[f].type === 'relation');

  // Firma de cursores (6.4): HMAC con una clave fija si se da secret; si no, una al azar por proceso.
  const keyPromise = webcrypto.subtle.importKey('raw', typeof secret === 'string' ? enc.encode(secret) : secret ?? webcrypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sign = async (s) => b64u(new Uint8Array(await webcrypto.subtle.sign('HMAC', await keyPromise, enc.encode(s)))).slice(0, 27);

  // ── Respuestas ──
  const cacheControl = (ctx, cc) => (ctx.principal != null && !cc.includes('no-store') ? `private, ${cc.replace(/^public, /, '')}` : cc);
  function respond(ctx, status, data, headers = {}) {
    const body = data === undefined || status === 204 || status === 304 ? null : JSON.stringify(data);
    const h = new Headers({ Link: profileLink, ...headers });
    if (body !== null) h.set('Content-Type', status >= 400 ? 'application/problem+json' : 'application/json');
    return new Response(ctx.method === 'HEAD' ? null : body, { status, headers: h });
  }
  function problem(ctx, e) {
    const lang = ctx.lang;
    const extra = e.extra.errors ? { ...e.extra, errors: e.extra.errors.map((x) => ({ ...x, ...(x.detail != null && { detail: text(x.detail, lang) }) })) } : e.extra;
    const body = { type: `${PROFILE}errors#${e.code}`, title: text(TITLES[e.status] ?? 'Error', lang), status: e.status, code: e.code,
      ...(e.detail != null && { detail: text(e.detail, lang) }), ...extra };
    const headers = { 'Cache-Control': 'no-store', Vary: 'Accept-Language', 'Content-Language': lang, ...e.headers };
    if (e.status === 401 && !Object.keys(e.headers).some((k) => k.toLowerCase() === 'www-authenticate')) headers['WWW-Authenticate'] = 'Bearer realm="restep"';
    return respond(ctx, e.status, body, headers);
  }

  // ── Representaciones ──
  // Solo los campos declarados (más id y los miembros _ que dé el adaptador); un mapa de idioma sin
  // traducciones es {} (3); una relación que llega como id suelto se convierte en { id } (3).
  // En un singleton no hay id, y cada relación lleva href, porque no declara relations (5.9).
  function represent(c, raw) {
    const out = c.singleton ? {} : { id: String(raw.id) };
    for (const [f, d] of Object.entries(c.fields)) {
      if (f === 'id') continue;
      let v = raw[f];
      if (d.type === 'map') v = isObject(v) ? v : {};
      else if (d.type === 'relation' && (typeof v === 'string' || typeof v === 'number')) v = { id: String(v) };
      if (d.type === 'relation' && isObject(v)) v = c.singleton ? { id: String(v.id), href: itemPath(colls[d.to], String(v.id)) } : { id: String(v.id) };
      if (v !== undefined) out[f] = v;
    }
    for (const [k, v] of Object.entries(raw)) if (k.startsWith('_') && k !== '_etag') out[k] = v;
    return out;
  }
  const pick = (row, fields) => {
    if (!fields) return row;
    const out = 'id' in row ? { id: row.id } : {};
    for (const f of fields) if (f in row) out[f] = row[f];
    for (const [k, v] of Object.entries(row)) if (k.startsWith('_')) out[k] = v;
    return out;
  };
  const itemPath = (c, id) => (c.singleton ? `${base}${c.path}` : `${base}${c.path}/${id}`);
  // 7.2: con writes, toda respuesta cuyo cuerpo es un elemento lleva en _etag la ETag del elemento, calculada sin _etag.
  const withEtag = async (row) => (writable ? { ...row, _etag: await etagOf(row) } : row);
  const groups = (paths) => paths.slice(0, 32).map(sfString).join(', ');

  // ── Descubrimiento (4.2) y esquemas (4.3) ──
  function schemas(c, lang) {
    const DEC = t('A decimal in a string, such as "18.50".', 'Un decimal en una cadena, como "18.50".');
    const json = (f, kind) => {
      const d = c.fields[f];
      const s = d.type === 'decimal' ? { type: 'string', pattern: DECIMAL.source, description: text(DEC, lang) }
        : d.type === 'enum' ? { type: 'string', enum: d.values }
        : d.type === 'date' ? { type: 'string', format: 'date' }
        : d.type === 'datetime' ? { type: 'string', format: 'date-time' }
        : d.type === 'duration' ? { type: 'string', format: 'duration' }
        : d.type === 'map' ? { type: 'object', propertyNames: { pattern: LANGUAGE_TAG.source },
          additionalProperties: { type: kind === 'update' ? ['string', 'null'] : 'string' },
          description: text(t('Translations, by language tag in lowercase, such as {"en": "…", "es-mx": "…"}.',
            'Traducciones, por etiqueta de idioma en minúsculas, como {"en": "…", "es-mx": "…"}.'), lang) }
        : d.type === 'relation' ? { type: 'object', required: ['id'], properties: { id: { type: 'string' }, ...(c.singleton && { href: { type: 'string' } }) } }
        : { type: d.type };
      // Un enum con labels: las opciones con su etiqueta, para un formulario (4.3).
      if (d.type === 'enum' && d.labels) { delete s.enum; s.oneOf = d.values.map((v) => ({ const: v, title: text(d.labels[v], lang) })); }
      const nullable = d.type === 'map' ? kind === 'update' : !d.required;
      const out = nullable ? { anyOf: [s, { type: 'null' }] } : s;
      // Las anotaciones de un formulario van en la propiedad, fuera del anyOf (4.3). default, solo en create.
      if (d.title) out.title = text(d.title, lang);
      if (d.description) out.description = text(d.description, lang);
      if (kind === 'create' && 'default' in d) out.default = d.default;
      if (d.examples) out.examples = d.examples;
      return out;
    };
    const names = Object.keys(c.fields).filter((f) => f !== 'id');
    const props = (kind) => Object.fromEntries(names.map((f) => [f, json(f, kind)]));
    const required = names.filter((f) => c.fields[f].required);
    const requiredCreate = required.filter((f) => !('default' in c.fields[f])); // con default, el POST puede no traerlo
    const reserved = { '^_': {} };
    const ID_SOURCE = '^(?!\\.\\.?$)[A-Za-z0-9._~-]+$';
    // 5.1: con id_from "client" o "either", el create admite id (y con "client" lo exige), con el formato que restringe idPattern.
    const ownId = c.idFrom === 'client' || c.idFrom === 'either';
    const idCreate = { type: 'string', pattern: ID_SOURCE, ...(c.idPattern && { allOf: [{ pattern: c.idPattern }] }) };
    if (c.singleton) return {
      item: { type: 'object', required, properties: props('item') },
      ...(c.methods.includes('PATCH') && { update: { type: 'object',
        description: text(t('A JSON Merge Patch: absent leaves a field untouched, null deletes it.', 'Un JSON Merge Patch: lo ausente no cambia, null lo borra.'), lang),
        properties: props('update'), patternProperties: reserved, additionalProperties: false } }),
    };
    return {
      item: { type: 'object', required: ['id', ...required], properties: { id: { type: 'string', readOnly: true }, ...props('item') } },
      ...(c.methods.includes('POST') && { create: { type: 'object', required: [...(c.idFrom === 'client' ? ['id'] : []), ...requiredCreate],
        properties: { ...(ownId && { id: idCreate }), ...props('create') }, patternProperties: reserved, additionalProperties: false } }),
      ...(c.itemMethods.includes('PATCH') && { update: { type: 'object',
        description: text(t('A JSON Merge Patch: absent leaves a field untouched, null deletes it.', 'Un JSON Merge Patch: lo ausente no cambia, null lo borra.'), lang),
        properties: { id: { type: 'string' }, ...props('update') }, patternProperties: reserved, additionalProperties: false } }),
    };
  }
  function discoveryDocument(lang) {
    const collections = Object.fromEntries(Object.values(colls).map((c) => {
      const rels = relations(c);
      return [c.name, {
        path: c.path,
        ...(c.description && { description: text(c.description, lang) }),
        methods: c.methods, item_methods: c.itemMethods, ...(c.idFrom && { id_from: c.idFrom }), schemas: schemas(c, lang),
        filter: Object.fromEntries(Object.entries(c.filter).map(([f, d]) => [f, {
          type: d.type, ...(d.type === 'enum' && { values: c.fields[f].values }), ops: d.ops,
          ...(d.description && { description: text(d.description, lang) }) }])),
        ...(Object.keys(c.namedFilters).length && { named_filters: Object.fromEntries(Object.entries(c.namedFilters).map(([f, d]) => [f, {
          ...(d.type && { type: d.type }), ...(d.type === 'enum' && { values: d.values }), description: text(d.description, lang) }])) }),
        sort: c.sort, ...(c.collations && Object.keys(c.collations).length && { collations: c.collations }),
        max_limit: c.maxLimit, ...(c.count && { count: c.count }),
        ...(c.newItem && { actions: { new: { on: 'collection', safe: true, idempotent: true, method: 'GET',
          description: text(t('The body of a POST already filled in for this client, to start a form; it creates nothing.',
            'El cuerpo de un POST ya relleno para este cliente, para empezar un formulario; no crea nada.'), lang) } } }),
        ...(maps(c).length && { language_maps: Object.fromEntries(maps(c).map((f) => [f, {}])) }),
        ...(rels.length && { relations: Object.fromEntries(rels.map((r) => [r, { to: c.fields[r].to,
          ...(c.fields[r].description && { description: text(c.fields[r].description, lang) }) }])) }),
      }];
    }));
    const singletons = Object.fromEntries(Object.values(singles).map((s) => [s.name, {
      path: s.path, methods: s.methods, ...(s.description && { description: text(s.description, lang) }), schemas: schemas(s, lang) }]));
    // 4.2: el mismo documento para todos los principales; solo cambian sus textos, con Accept-Language.
    return { restep: RESTEP, version, profiles, extensions,
      ...(writable && { idempotency: { ttl: idempotencyTtl, ...(!idempotencyAnonymous && { anonymous: false }) } }),
      ...(statusPath && { status: statusPath }), collections, ...(Object.keys(singletons).length && { singletons }) };
  }

  // ── Autenticación ──
  const metadataPath = `/.well-known/oauth-protected-resource${base ? `${base}/` : ''}`;
  const origin = (url) => options.publicOrigin ?? url.origin;
  async function principalOf(request, url) {
    if (oauth) {
      const m = /^bearer +(\S+)$/i.exec(request.headers.get('authorization') ?? '');
      const who = m ? await oauth.verifyToken(m[1], request) : null;
      if (who != null) return String(who);
      // RFC 6750, 3: solo la raíz exacta apunta a los metadatos (RFC 9728, 3.3).
      const sent = m ? ', error="invalid_token"' : '';
      const challenge = url.pathname === `${base}/` && !url.search
        ? `Bearer realm="restep", resource_metadata="${origin(url)}${metadataPath}"${sent}` : `Bearer realm="restep"${sent}`;
      throw new RestepError(401, 'unauthenticated', t('Send Authorization: Bearer with a valid token.', 'Envía Authorization: Bearer con un token válido.'),
        { headers: { 'WWW-Authenticate': challenge } });
    }
    if (authenticate) { const who = await authenticate(request); return who == null ? null : String(who); }
    return null;
  }

  // ── query: parámetros (5.3, 6) ──
  function checkReserved(params, allowed) {
    for (const key of new Set(params.keys())) {
      const b = baseName(key);
      if (!isReserved(b)) continue; // los demás parámetros son de la API
      if (!allowed.includes(b)) throw unsupported(key);
      if (b === 'filter' && key === 'filter') throw unsupported(key, t('filter as an expression needs the filter-expr extension.', 'filter como expresión necesita la extensión filter-expr.'));
      if (b !== 'filter' && key !== b) throw unsupported(key);
      if (params.getAll(key).length > 1) throw once(key);
    }
  }
  function parseValue(c, field, type, raw, key) {
    const ok = type === 'string' ? true
      : type === 'enum' ? c.fields[field].values.includes(raw)
      : type === 'decimal' ? DECIMAL.test(raw)
      : type === 'integer' ? /^-?\d+$/.test(raw) && Number.isSafeInteger(Number(raw))
      : type === 'number' ? /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(raw)
      : type === 'boolean' ? raw === 'true' || raw === 'false'
      : type === 'date' ? isDate(raw) : type === 'datetime' ? isDatetime(raw)
      : type === 'duration' ? DURATION.test(raw) && !/^P[^T]*[YM]/.test(raw) : false;
    if (!ok) {
      if (type === 'enum') throw bad(key, t(`${raw} is not one of: ${c.fields[field].values.join(', ')}.`, `${raw} no es ninguno de: ${c.fields[field].values.join(', ')}.`));
      if (type === 'duration' && DURATION.test(raw)) throw bad(key, t('A duration with years or months has no fixed length.', 'Una duración con años o meses no tiene longitud fija.'));
      throw bad(key, t(`${raw} is not a valid ${type}.`, `${raw} no es un ${type} válido.`));
    }
    return type === 'integer' || type === 'number' ? Number(raw) : type === 'boolean' ? raw === 'true' : raw;
  }
  function parseFilters(c, params) {
    const out = [], seen = new Set();
    for (const [key, value] of params) {
      if (baseName(key) !== 'filter') continue;
      const m = key.match(/^filter\[([^\][]+)\](?:\[([^\][]+)\])?$/);
      if (!m) throw unsupported(key, t('This resource supports filter[field] and filter[field][op].', 'Este recurso admite filter[campo] y filter[campo][op].'));
      const [, field, op = 'eq'] = m;
      if (Object.hasOwn(c.namedFilters, field)) { // 6.1: sin operadores; un interruptor sin valor, uno con type con un valor de su tipo
        const n = c.namedFilters[field];
        if (m[2] !== undefined) throw unsupported(key, t(`${field} is a named filter: it takes no operator.`, `${field} es un filtro con nombre: no lleva operador.`));
        if (!n.type && value !== '') throw bad(key, t(`${field} is a switch: it takes no value.`, `${field} es un interruptor: no lleva valor.`));
        if (n.type && value === '') throw bad(key, t(`${field} needs a ${n.type} value.`, `${field} necesita un valor ${n.type}.`));
        const v = n.type ? parseValue({ fields: { [field]: { values: n.values } } }, field, n.type, value, key) : true;
        out.push({ named: field, value: v, ...(n.apply && { apply: n.apply }) });
        continue;
      }
      const d = Object.hasOwn(c.filter, field) ? c.filter[field] : null;
      if (!d) throw unsupported(key, t(`There is no filter on ${field}. Filters: ${Object.keys(c.filter).join(', ') || 'none'}.`, `No hay filtro por ${field}. Filtros: ${Object.keys(c.filter).join(', ') || 'ninguno'}.`));
      if (!d.ops.includes(op)) throw unsupported(key, t(`${field} supports: ${d.ops.join(', ')}.`, `${field} admite: ${d.ops.join(', ')}.`));
      if (seen.has(`${field} ${op}`)) throw bad(key, t('The same filter appears twice.', 'El mismo filtro aparece dos veces.'));
      seen.add(`${field} ${op}`);
      let v;
      if (op === 'null') {
        if (value !== 'true' && value !== 'false') throw bad(key, t('Use true or false.', 'Usa true o false.'));
        v = value === 'true';
      } else if (op === 'in') {
        const parts = value.split(',');
        if (parts.some((x) => x === '')) throw bad(key, t('in needs a non-empty, comma-separated list.', 'in necesita una lista no vacía, separada por comas.'));
        v = parts.map((x) => parseValue(c, field, d.type, x, key));
      } else v = parseValue(c, field, d.type, value, key);
      out.push({ field, op, value: v, type: d.type, collation: c.collationOf(field) });
    }
    return out;
  }
  function parseSort(c, params) {
    if (!params.has('sort')) return c.defaultSort.map((s) => ({ field: s.replace(/^-/, ''), desc: s.startsWith('-') }));
    if (!c.sort.length) throw unsupported('sort');
    return params.get('sort').split(',').map((s) => {
      const f = s.replace(/^-/, '');
      if (!f) throw bad('sort', t('Empty sort key.', 'Clave de orden vacía.'));
      if (!c.sort.includes(f)) throw unsupported('sort', t(`${f} is not sortable. Sortable: ${c.sort.join(', ')}.`, `${f} no se puede ordenar. Se puede por: ${c.sort.join(', ')}.`));
      return { field: f, desc: s.startsWith('-') };
    });
  }
  function parseFields(c, params) {
    const raw = params.get('fields');
    if (raw === null) return null;
    return raw.split(',').map((f) => {
      const head = f.split('.')[0];
      if (f.includes('.') && isMap(c, head)) throw bad('fields', t(`${head} is a language map: ask for it whole.`, `${head} es un mapa de idioma: pídelo entero.`));
      if (f.includes('.')) throw unsupported('fields', t('Dotted paths in fields need the relations profile.', 'Las rutas con punto en fields necesitan el perfil relations.'));
      if (!Object.hasOwn(c.fields, f)) throw bad('fields', t(`There is no field ${f || '(empty)'}.`, `No hay ningún campo ${f || '(vacío)'}.`));
      return f;
    });
  }
  // Un cursor es opaco y va firmado; está ligado a la colección, los filtros, el orden y el principal (6.4),
  // no a limit, fields, include ni count.
  const PAGE_ONLY = ['cursor', 'limit', 'fields', 'include', 'count'];
  const queryPrint = (c, params, principal) => hash(JSON.stringify([c.path, principal,
    [...params].filter(([k]) => !PAGE_ONLY.includes(k) && (baseName(k) === 'filter' || k === 'sort')).sort()]));
  async function makeCursor(value, print) {
    const payload = b64u(enc.encode(JSON.stringify({ c: value, q: print })));
    return `${payload}.${await sign(payload)}`;
  }
  async function readCursor(params, print) {
    if (!params.has('cursor')) return null;
    const fail = bad('cursor', t('Invalid or expired cursor, or one issued for another query.', 'Cursor no válido o caducado, o emitido para otra consulta.'));
    const parts = params.get('cursor').split('.');
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || parts[1] !== await sign(parts[0])) throw fail;
    let o;
    try { o = JSON.parse(new TextDecoder().decode(fromB64u(parts[0]))); } catch { throw fail; }
    if (!isObject(o) || o.q !== print || o.c == null) throw fail;
    return o.c;
  }

  // ── writes: cuerpos y validación (3, 5.1, 7) ──
  async function readBody(ctx, types) {
    // 3: application/json (y, en un PATCH, application/merge-patch+json), en UTF-8; sin Content-Type, 415 aunque el cuerpo esté vacío.
    if (!mediaTypeOk(ctx.request.headers.get('content-type'), types))
      throw new RestepError(415, 'unsupported_media_type', t(`Send ${types.join(' or ')}, in UTF-8.`, `Envía ${types.join(' o ')}, en UTF-8.`),
        types.includes('application/merge-patch+json') ? { headers: { 'Accept-Patch': 'application/merge-patch+json' } } : {});
    const tooLarge = () => new RestepError(413, 'content_too_large', t(`The body may be up to ${maxBodyBytes} bytes.`, `El cuerpo puede tener hasta ${maxBodyBytes} bytes.`));
    if (Number(ctx.request.headers.get('content-length') ?? 0) > maxBodyBytes) throw tooLarge();
    const raw = await ctx.request.text();
    if (enc.encode(raw).length > maxBodyBytes) throw tooLarge();
    let v;
    try { v = JSON.parse(raw); } catch {}
    if (!isObject(v)) throw new RestepError(400, 'bad_request', t('The body is not a valid JSON object.', 'El cuerpo no es un objeto JSON válido.'));
    // 5.1: los miembros que empiezan por _ son de Restep y una escritura los ignora.
    return [Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('_'))), v];
  }
  const typeOk = (d, v) => (d.type === 'decimal' ? typeof v === 'string' && DECIMAL.test(v)
    : d.type === 'integer' ? Number.isSafeInteger(v) : d.type === 'number' ? typeof v === 'number' && Number.isFinite(v)
    : d.type === 'boolean' ? typeof v === 'boolean' : d.type === 'date' ? typeof v === 'string' && isDate(v)
    : d.type === 'datetime' ? typeof v === 'string' && isDatetime(v) : d.type === 'duration' ? typeof v === 'string' && DURATION.test(v)
    : typeof v === 'string');
  for (const c of Object.values(colls)) for (const [f, d] of Object.entries(c.fields))
    if ('default' in d && !typeOk(d, d.default)) throw configError(`${c.name}.fields.${f}: default no es un ${d.type} válido`);
  // Valida los miembros de un cuerpo antes de fusionarlo. current: el elemento guardado (PATCH) o undefined (POST).
  async function bodyErrors(c, body, current, ctx) {
    const errors = [];
    const patch = current !== undefined;
    for (const [f, v] of Object.entries(body)) {
      const d = c.fields[f];
      if (!d) { errors.push({ pointer: ptr(f), code: 'unknown', detail: t(`There is no field ${f}.`, `No hay ningún campo ${f}.`) }); continue; }
      if (d.type === 'map') {
        if (v === null && patch) continue; // vacía el mapa
        if (!isObject(v)) { errors.push({ pointer: ptr(f), code: 'type', detail: t(`${f} must be an object of translations, such as {"en": "…"}.`, `${f} tiene que ser un objeto de traducciones, como {"en": "…"}.`) }); continue; }
        for (const [tag, s] of Object.entries(v)) {
          const where = ptr(f) + ptr(tag), wellFormed = LANGUAGE_TAG.test(tag);
          if (!wellFormed) errors.push({ pointer: where, code: 'format', detail: t(`${tag} is not a well-formed language tag in lowercase.`, `${tag} no es una etiqueta de idioma bien formada en minúsculas.`) });
          if (s === null && patch) continue;
          if (typeof s !== 'string') errors.push({ pointer: where, code: 'type', detail: t('A translation must be a string.', 'Una traducción tiene que ser una cadena.') });
          else if (wellFormed && languageTags && !languageTags.includes(tag) && current?.[f]?.[tag] !== s)
            errors.push({ pointer: where, code: 'unknown', detail: t(`This API does not take ${tag}; it takes ${languageTags.join(', ')}.`, `Esta API no admite ${tag}; admite ${languageTags.join(', ')}.`) });
        }
        continue;
      }
      if (v === null) {
        if (!patch && !d.required) continue;
        if (d.required) errors.push({ pointer: ptr(f), code: 'required', detail: t(`${f} is required.`, `${f} es obligatorio.`) });
        continue;
      }
      if (d.type === 'relation') {
        if (!isObject(v) || typeof v.id !== 'string') { errors.push({ pointer: ptr(f), code: 'type', detail: t(`${f} must be an object with an id, or null.`, `${f} tiene que ser un objeto con un id, o null.`) }); continue; }
        body[f] = { id: v.id }; // 5.1: solo se lee su id; nunca se modifica el elemento relacionado
        // 5.1: con su valor actual se ignora sin comprobarla, así que devolver lo leído nunca falla por ella.
        if (patch && current?.[f]?.id === v.id) continue;
        // 5.1: un elemento que no existe y uno que el principal no puede ver dan la misma entrada (el get del
        // adaptador devuelve null para los dos).
        if (!isId(v.id) || !(await colls[d.to].data.get(v.id, { ...ctx, collection: colls[d.to] })))
          errors.push({ pointer: `${ptr(f)}/id`, code: 'unknown', detail: t(`There is no ${d.to} ${v.id}.`, `No hay ningún ${d.to} ${v.id}.`) });
        continue;
      }
      if (!typeOk(d, v)) errors.push({ pointer: ptr(f), code: 'type', detail: t(`${f} must be a ${d.type}${d.type === 'decimal' ? ' in a string, such as "18.50"' : ''}.`, `${f} tiene que ser de tipo ${d.type}${d.type === 'decimal' ? ' en una cadena, como "18.50"' : ''}.`) });
      else if (d.type === 'enum' && !d.values.includes(v)) errors.push({ pointer: ptr(f), code: 'format', detail: t(`${f} must be one of: ${d.values.join(', ')}.`, `${f} tiene que ser uno de: ${d.values.join(', ')}.`) });
    }
    return errors;
  }
  function requiredErrors(c, row) {
    return Object.entries(c.fields).filter(([f, d]) => d.required && (row[f] === undefined || row[f] === null))
      .map(([f]) => ({ pointer: ptr(f), code: 'required', detail: t(`${f} is required.`, `${f} es obligatorio.`) }));
  }
  async function customErrors(c, row, ctx) {
    if (!c.validate) return [];
    const r = await c.validate(row, ctx);
    return Array.isArray(r) ? r : [];
  }
  // Fusiona un parche (5.1): Merge Patch, salvo las relaciones (se sustituyen enteras) y los mapas de idioma
  // (se fusionan y, vacíos o borrados, quedan en {}).
  function applyPatch(c, current, patch) {
    const out = { ...current };
    for (const [f, v] of Object.entries(patch)) {
      const d = c.fields[f];
      if (d.type === 'relation') out[f] = v === null ? null : { id: v.id };
      else if (d.type === 'map') out[f] = v === null ? {} : mergePatch(isObject(current[f]) ? current[f] : {}, v);
      else if (v === null) delete out[f];
      else out[f] = mergePatch(current[f], v);
    }
    return out;
  }

  // Exclusión por elemento: evaluar If-Match y escribir es atómico dentro de este proceso (7.2). Entre
  // procesos lo hace la transacción de createTransaction con el get de forUpdate.
  const locks = new Map();
  async function withLock(key, fn) {
    const prev = locks.get(key) ?? Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    const chained = prev.then(() => mine);
    locks.set(key, chained);
    await prev;
    try { return await fn(); } finally { release(); if (locks.get(key) === chained) locks.delete(key); }
  }

  // ── Rutas ──
  async function serveDiscovery(ctx) {
    if (!ctx.read) throw new RestepError(405, 'method_not_allowed', t('Only GET and HEAD.', 'Solo GET y HEAD.'), { headers: { Allow: 'GET, HEAD' } });
    checkReserved(ctx.url.searchParams, []);
    const doc = discoveryDocument(ctx.lang);
    const headers = { ETag: await etagOf([ctx.lang, doc]), 'Cache-Control': cacheControl(ctx, 'public, max-age=300'), Vary: 'Accept-Language', 'Content-Language': ctx.lang,
      ...(docsLink && { Link: `${profileLink}, ${docsLink}` }) };
    if (weakMatch(ctx.request.headers.get('if-none-match'), headers.ETag)) return respond(ctx, 304, undefined, headers);
    return respond(ctx, 200, doc, headers);
  }

  async function listCollection(c, ctx) {
    const params = ctx.url.searchParams;
    const filter = parseFilters(c, params);
    const sort = parseSort(c, params).map((s) => ({ ...s, type: c.typeOf(s.field), collation: c.collationOf(s.field) }));
    if (!sort.some((s) => s.field === 'id')) sort.push({ field: 'id', desc: false, type: 'string', collation: 'codepoint' }); // desempate estable (6.2)
    const rawLimit = params.get('limit');
    const limit = rawLimit === null ? Math.min(c.defaultLimit, c.maxLimit) : Number(rawLimit);
    if (rawLimit !== null && (!/^\d+$/.test(rawLimit) || limit < 1 || limit > c.maxLimit))
      throw bad('limit', t(`Between 1 and ${c.maxLimit}.`, `Entre 1 y ${c.maxLimit}.`));
    const count = params.get('count');
    if (count !== null && !c.count) throw unsupported('count');
    if (count !== null && count !== 'true' && count !== 'false') throw bad('count', t('Use true or false.', 'Usa true o false.'));
    const fields = parseFields(c, params);
    const print = await queryPrint(c, params, ctx.principal);
    const cursor = await readCursor(params, print);
    // 7.2: si el elemento admite PATCH o DELETE, cada uno lleva en _etag la ETag de su GET, calculada
    // sobre la representación completa; por eso el adaptador no recibe fields como pista en ese caso.
    const itemEtag = c.itemMethods.length > 1;
    const page = await c.data.list({ filter, sort, limit, cursor, count: count === 'true', fields: itemEtag ? null : fields }, { ...ctx, collection: c });
    if (count === 'true' && typeof page.total !== 'number') throw new Error(`restep-server: ${c.name}.data.list no ha devuelto total con count`);
    let next = null;
    if (page.next != null) {
      const q = new URLSearchParams(params);
      q.set('cursor', await makeCursor(page.next, print));
      next = `${ctx.url.pathname}?${q}`;
    }
    const items = await Promise.all(page.items.map(async (r) => {
      const row = represent(c, r);
      return itemEtag ? { ...pick(row, fields), _etag: await etagOf(row) } : pick(row, fields);
    }));
    return { items, next, ...(count === 'true' && { total: page.total }), ...(count === 'true' && c.count === 'estimated' && { total_estimated: true }) };
  }

  async function collectionEtag(c, ctx) {
    // La misma ETag que un GET de la colección sin parámetros (con el _etag de cada elemento).
    return etagOf(await listCollection(c, { ...ctx, url: new URL(`${base}${c.path}`, ctx.url) }));
  }

  // 7.1: la clave de la petición, ya comprobada; null si no trae. Una mal formada (o con parámetros) da 400 con su entrada.
  function idempotencyKey(c, ctx) {
    const raw = ctx.request.headers.get('idempotency-key');
    const anonymous = ctx.principal == null;
    if (raw === null) {
      // Con "anonymous": false, un recurso que exige la clave no se la exige a una petición sin credenciales.
      if (c.requireIdempotencyKey && !(anonymous && !idempotencyAnonymous))
        throw new RestepError(400, 'idempotency_key_required', t('This collection requires Idempotency-Key.', 'Esta colección exige Idempotency-Key.'),
          { errors: [{ header: 'Idempotency-Key', code: 'required', detail: t('Send Idempotency-Key.', 'Envía Idempotency-Key.') }] });
      return null;
    }
    const m = raw.trim().match(/^"((?:[\x20\x21\x23-\x5b\x5d-\x7e]|\\["\\])*)"$/);
    if (!m) throw new RestepError(400, 'bad_request', t('Idempotency-Key must be a quoted string without parameters, such as "8e03978e-40d5".', 'Idempotency-Key tiene que ser una cadena entre comillas y sin parámetros, como "8e03978e-40d5".'),
      { errors: [{ header: 'Idempotency-Key', code: 'format', detail: t('Not a Structured Fields string without parameters.', 'No es una cadena de Structured Fields sin parámetros.') }] });
    // 7.1: con "anonymous": false, una petición sin credenciales que trae la clave recibe 400 antes de cualquier efecto.
    if (anonymous && !idempotencyAnonymous)
      throw new RestepError(400, 'bad_request', t('This API does not take Idempotency-Key without credentials.', 'Esta API no admite Idempotency-Key sin credenciales.'),
        { errors: [{ header: 'Idempotency-Key', code: 'unknown', detail: t('Send it with credentials, or leave it out.', 'Envíala con credenciales, o no la envíes.') }] });
    return m[1].replace(/\\(["\\])/g, '$1');
  }

  // 5.1: el id de un POST según id_from. Devuelve las entradas de errors (vacía si vale).
  function idErrors(c, body) {
    const from = c.idFrom ?? 'server';
    if (!('id' in body)) return from === 'client' ? [{ pointer: '/id', code: 'required', detail: t('This collection takes its id from the client: send id.', 'Esta colección recibe el id del cliente: envía id.') }] : [];
    if (from === 'server') return [{ pointer: '/id', code: 'read_only', detail: t('The server assigns id.', 'El servidor asigna el id.') }];
    const v = body.id;
    if (typeof v !== 'string') return [{ pointer: '/id', code: 'type', detail: t('id must be a string.', 'id tiene que ser una cadena.') }];
    if (!isId(v)) return [{ pointer: '/id', code: 'format', detail: t('id is made of A-Z a-z 0-9 - . _ ~, and is not "." or "..".', 'id se hace con A-Z a-z 0-9 - . _ ~, y no es "." ni "..".') }];
    if (c.idRegExp && !c.idRegExp.test(v)) return [{ pointer: '/id', code: 'format', detail: t(`id must match ${c.idPattern}.`, `id tiene que cumplir ${c.idPattern}.`) }];
    return [];
  }

  async function create(c, ctx) {
    const req = ctx.request;
    const key = idempotencyKey(c, ctx);
    const [body, sent] = await readBody(ctx, ['application/json']);
    // 7.1: una clave es de un principal y de un destino (método y ruta, tras decodificar los porcentajes, sin la query).
    // Dos peticiones son la misma si además coinciden su query (tras decodificar, sin importar el orden) y sus cuerpos como JSON.
    const scope = key !== null ? `${await hash(String(ctx.principal ?? ''))} POST ${ctx.path} ${key}` : null;
    const query = [...ctx.url.searchParams].sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
    const print = scope && await hash(canonical([query, sent]));
    const saved = scope ? await idempotencyStore.reserve(scope, print, idempotencyTtl * 1000, ctx) : null;
    let reserved = scope && !saved;
    let effectStarted = false;
    try {
      if (saved && saved.print === print) {
        // 7.1: la misma petición mientras la primera sigue en curso; el cliente puede repetirla con la misma clave.
        if (!saved.response) throw new RestepError(409, 'request_in_progress', t('The same request is still being processed: send it again with the same key in a moment.', 'La misma petición todavía se está procesando: vuelve a enviarla con la misma clave dentro de un momento.'), { headers: { 'Retry-After': '1' } });
        const [status, data, headers] = saved.response;
        return respond(ctx, status, data, { ...headers, 'Idempotent-Replayed': 'true' });
      }
      // 5.4: 412 va antes que 422, así que las precondiciones se miran antes que una clave usada con otro cuerpo.
      const ifMatch = req.headers.get('if-match'), ifNone = req.headers.get('if-none-match');
      if (ifMatch !== null || ifNone !== null) {
        const tag = await collectionEtag(c, ctx);
        if (ifMatch !== null && !strongMatch(ifMatch, tag)) throw new RestepError(412, 'precondition_failed', t('If-Match does not match the current collection.', 'If-Match no coincide con la colección actual.'));
        if (ifNone !== null && weakMatch(ifNone, tag)) throw new RestepError(412, 'precondition_failed', t('If-None-Match matches the current collection.', 'If-None-Match coincide con la colección actual.'));
      }
      if (saved) throw new RestepError(422, 'idempotency_mismatch', t('That Idempotency-Key was already used with a different request.', 'Esa Idempotency-Key ya se usó con otra petición.'));
      const ownId = 'id' in body && (c.idFrom === 'client' || c.idFrom === 'either') ? body.id : undefined;
      const { id: _, ...rest } = body;
      const errors = [...idErrors(c, body), ...await bodyErrors(c, rest, undefined, ctx)];
      const data = { ...rest };
      for (const [f, d] of Object.entries(c.fields)) if ('default' in d && !(f in data)) data[f] = d.default; // 4.3
      for (const f of maps(c)) if (!isObject(data[f])) data[f] = {};
      for (const f of Object.keys(data)) if (data[f] === null && c.fields[f].type !== 'relation') delete data[f];
      errors.push(...requiredErrors(c, data).filter((e) => !errors.some((x) => x.pointer === e.pointer)));
      if (!errors.length) errors.push(...await customErrors(c, data, { ...ctx, collection: c, method: 'POST' }));
      if (errors.length) throw invalid(errors);
      const make = async () => {
        // 5.4: el 409 de un id cogido va después del 422. taken() responde igual lo vea el cliente o no (5.1).
        if (ownId !== undefined && await c.data.taken(ownId, { ...ctx, collection: c })) throw takenError();
        // Once the adapter starts, an exception does not prove that no effect occurred.
        effectStarted = true;
        return c.data.create(ownId !== undefined ? { id: ownId, ...data } : data, { ...ctx, collection: c });
      };
      // Dentro del proceso, comprobar el id y crear es atómico; entre procesos lo garantiza la clave primaria del adaptador.
      const stored = ownId !== undefined ? await withLock(`${c.name}/${ownId}`, make) : await make();
      if (!stored || stored.id == null) throw new Error(`restep-server: ${c.name}.data.create tiene que devolver el elemento con su id`);
      if (ownId !== undefined && String(stored.id) !== ownId) throw new Error(`restep-server: ${c.name}.data.create tiene que guardar el id que eligió el cliente`);
      const row = represent(c, stored);
      const etag = await etagOf(row);
      const minimal = ctx.preferMinimal;
      const response = [201, minimal ? undefined : { ...row, _etag: etag }, { Location: itemPath(c, row.id), ETag: etag,
        'Cache-Group-Invalidation': groups([`${base}${c.path}`, itemPath(c, row.id)]), ...(minimal && { 'Preference-Applied': 'return=minimal' }) }];
      if (scope) { await idempotencyStore.complete(scope, response, ctx); reserved = false; }
      return respond(ctx, ...response);
    } catch (e) {
      // Un 409 taken del adaptador (su clave primaria) es un rechazo sin efecto: no gasta la clave.
      if (e instanceof RestepError && e.status === 409 && e.extra.errors?.some((x) => x.code === 'taken')) effectStarted = false;
      throw e;
    } finally {
      // Una petición rechazada antes de ejecutarse no gasta la clave (7.1).
      // Keep uncertain outcomes reserved until recovery; never blindly repeat the effect.
      if (reserved && !effectStarted) await idempotencyStore.release(scope, ctx);
    }
  }

  // PATCH y DELETE de un elemento, y PATCH de un singleton (id undefined).
  async function writeItem(c, id, ctx) {
    const patch = ctx.method === 'PATCH' ? (await readBody(ctx, ['application/merge-patch+json', 'application/json']))[0] : null;
    return withLock(c.singleton ? `singleton:${c.name}` : `${c.name}/${id}`, async () => {
      const cctx = { ...ctx, collection: c };
      // forUpdate: inside createTransaction, the adapter locks what it reads (SELECT ... FOR UPDATE), so
      // If-Match and the write are atomic across processes too (7.2).
      const raw = c.singleton ? await c.data.get({ ...cctx, forUpdate: true }) : await c.data.get(id, { ...cctx, forUpdate: true });
      if (!raw) throw notFound(ctx.path);
      const current = represent(c, raw);
      const tag = await etagOf(current);
      const ifMatch = ctx.request.headers.get('if-match'), ifNone = ctx.request.headers.get('if-none-match');
      if (c.requireIfMatch && ifMatch === null) throw new RestepError(428, 'precondition_required', t('This resource requires If-Match to write.', 'Este recurso exige If-Match para escribir.'));
      if (ifMatch !== null && !strongMatch(ifMatch, tag)) throw new RestepError(412, 'precondition_failed', t('Someone changed it: read it again before writing.', 'Alguien lo ha cambiado: vuelve a leerlo antes de escribir.'));
      if (ifNone !== null && weakMatch(ifNone, tag)) throw new RestepError(412, 'precondition_failed', t('If-None-Match matches the current item.', 'If-None-Match coincide con el elemento actual.'));
      const path = itemPath(c, id);
      const invalidate = { 'Cache-Group-Invalidation': groups(c.singleton ? [path] : [`${base}${c.path}`, path]) };
      if (ctx.method === 'DELETE') {
        await c.data.delete(id, cctx);
        return respond(ctx, 204, undefined, invalidate);
      }
      // 5.1: id es de solo lectura: con su valor actual se ignora; con otro, 422 read_only sin aplicar nada.
      if (!c.singleton && 'id' in patch) {
        if (patch.id !== id) throw invalid([{ pointer: '/id', code: 'read_only', detail: t('id cannot change.', 'id no puede cambiar.') }]);
        delete patch.id;
      }
      const errors = await bodyErrors(c, patch, current, ctx);
      if (errors.length) throw invalid(errors);
      const { id: _, ...rest } = current;
      const before = Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith('_')));
      const merged = applyPatch(c, before, patch);
      errors.push(...requiredErrors(c, merged));
      if (!errors.length) errors.push(...await customErrors(c, merged, { ...cctx, current, patch }));
      if (errors.length) throw invalid(errors, t('The result of the patch is not valid.', 'El resultado del parche no es válido.'));
      // 5.1: un PATCH que no cambia ningún dato deja el elemento como estaba (ni el adaptador ni la ETag se enteran).
      let row = current;
      if (canonical(merged) !== canonical(before)) {
        const stored = c.singleton ? await c.data.update(merged, { ...cctx, current, patch }) : await c.data.update(id, merged, { ...cctx, current, patch });
        row = represent(c, stored ?? (c.singleton ? merged : { ...merged, id }));
      }
      const etag = await etagOf(row);
      if (ctx.preferMinimal) return respond(ctx, 204, undefined, { ETag: etag, ...invalidate, 'Preference-Applied': 'return=minimal' });
      return respond(ctx, 200, { ...row, _etag: etag }, { ETag: etag, ...invalidate });
    });
  }

  // 11.1 y 4.3: el cuerpo de un POST ya relleno para este cliente y este momento, para empezar un
  // formulario: los default del esquema create y, encima, lo que devuelve newItem(ctx). No crea nada.
  async function newItem(c, ctx) {
    if (!ctx.read) throw new RestepError(405, 'method_not_allowed', t('Only GET and HEAD.', 'Solo GET y HEAD.'), { headers: { Allow: 'GET, HEAD' } });
    checkReserved(ctx.url.searchParams, []);
    const defaults = Object.fromEntries(Object.entries(c.fields).filter(([, d]) => 'default' in d).map(([f, d]) => [f, d.default]));
    const extra = await c.newItem({ ...ctx, collection: c });
    const data = { ...defaults, ...(isObject(extra) ? extra : {}) };
    // 8: If-None-Match se evalúa en todo GET, también aquí (con su ETag, o con *).
    const headers = { ETag: await etagOf(data), 'Cache-Control': 'private, no-store' };
    if (weakMatch(ctx.request.headers.get('if-none-match'), headers.ETag)) return respond(ctx, 304, undefined, headers);
    return respond(ctx, 200, data, headers);
  }

  // GET y HEAD de un elemento o de un singleton.
  async function readItem(c, raw, ctx) {
    const params = ctx.url.searchParams;
    const row = represent(c, raw);
    const fields = parseFields(c, params);
    const itemTag = await etagOf(row);
    // 7.2: el ETag del elemento completo es la ETag del elemento, calculada sin _etag, y con writes va también en
    // _etag. Con fields es otra representación, con su propia ETag; la del elemento sigue en _etag.
    const data = fields ? { ...pick(row, fields), ...(writable && { _etag: itemTag }) } : await withEtag(row);
    const tag = fields ? await etagOf(data) : itemTag;
    const headers = { ETag: tag, 'Cache-Control': cacheControl(ctx, 'no-cache'), 'Cache-Groups': groups([itemPath(c, row.id)]) };
    const ifMatch = ctx.request.headers.get('if-match');
    if (ifMatch !== null && !strongMatch(ifMatch, itemTag)) throw new RestepError(412, 'precondition_failed', t('If-Match does not match the current representation.', 'If-Match no coincide con la representación actual.'));
    if (weakMatch(ctx.request.headers.get('if-none-match'), tag)) return respond(ctx, 304, undefined, headers);
    return respond(ctx, 200, data, headers);
  }

  // 5.8: credenciales que el navegador añade solo (cookies, autenticación HTTP, certificado de cliente).
  // "auto": las hay si la petición trae Cookie o Authorization Basic o Digest; un certificado de cliente no se ve
  // desde Request, así que quien lo use pone browserCredentials: true.
  const browserCredentialed = (request) => (typeof browserCredentials === 'function' ? !!browserCredentials(request)
    : browserCredentials === 'auto' ? request.headers.has('cookie') || /^(basic|digest)\s/i.test(request.headers.get('authorization') ?? '')
    : browserCredentials);
  // ¿La envió un navegador desde un origen que no es el de la API ni uno permitido (cors.origins)?
  function foreignOrigin(ctx) {
    const sent = ctx.request.headers.get('origin'), site = ctx.request.headers.get('sec-fetch-site');
    if (sent === null) return site === 'cross-site' || site === 'same-site';
    if (sent === 'null') return site !== 'same-origin'; // Referrer-Policy: no-referrer manda Origin: null a su propio origen
    return sent !== origin(ctx.url) && !(Array.isArray(corsOrigins) && corsOrigins.includes(sent));
  }

  // 5.9: GET, HEAD y PATCH de un singleton; POST y DELETE dan 405.
  async function serveSingleton(s, ctx) {
    if (!s.methods.includes(ctx.method) && ctx.method !== 'HEAD') {
      const allow = [...s.methods, 'HEAD'].join(', ');
      throw new RestepError(405, 'method_not_allowed', t(`Supports ${allow}.`, `Admite ${allow}.`), { headers: { Allow: allow } });
    }
    // 5.9: include y los demás parámetros reservados, salvo fields en una lectura, dan unsupported_parameter.
    checkReserved(ctx.url.searchParams, ctx.read ? ['fields'] : []);
    ctx.preferMinimal = /(^|[ ,;])return=minimal\b/.test(ctx.request.headers.get('prefer') ?? '');
    if (ctx.read) {
      const raw = await s.data.get({ ...ctx, collection: s });
      if (!raw) throw notFound(ctx.path); // 5.9 y 4.2: el adaptador devuelve null a un principal que no puede usarlo
      return readItem(s, raw, ctx);
    }
    const write = (x) => writeItem(s, undefined, x);
    return createTransaction ? createTransaction((transaction) => write({ ...ctx, transaction }), ctx) : write(ctx);
  }

  async function route(ctx) {
    const { url, method } = ctx;
    // 11.5: los metadatos son públicos y no son un recurso de la API.
    if (oauth && url.pathname === metadataPath) {
      if (!ctx.read) throw new RestepError(405, 'method_not_allowed', t('Only GET and HEAD.', 'Solo GET y HEAD.'), { headers: { Allow: 'GET, HEAD' } });
      const meta = { resource: `${origin(url)}${base}/`, authorization_servers: oauth.authorizationServers,
        ...(oauth.scopesSupported && { scopes_supported: oauth.scopesSupported }), bearer_methods_supported: ['header'] };
      return new Response(method === 'HEAD' ? null : JSON.stringify(meta), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' } });
    }
    // 4.4: el estado del servicio, fuera de la API: sin enlaces de perfil ni problem+json.
    if (statusPath && url.pathname === statusPath) {
      if (!ctx.read) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } });
      let ok = true;
      try { ok = status.check ? !!(await status.check()) : true; } catch { ok = false; }
      return new Response(method === 'HEAD' ? null : JSON.stringify({ status: ok ? 'pass' : 'fail' }),
        { status: ok ? 200 : 503, headers: { 'Content-Type': 'application/health+json', 'Cache-Control': 'no-store' } });
    }
    // 3: cada segmento de la ruta se compara tras decodificar los porcentajes (/books/%37 es /books/7). Un segmento
    // que al decodificarse tiene "/" no es ninguna ruta de la API.
    let segments;
    try { segments = url.pathname.split('/').slice(1).map(decodeURIComponent); } catch { throw notFound(url.pathname); }
    if (segments.some((s) => s.includes('/'))) throw notFound(url.pathname);
    ctx.path = `/${segments.join('/')}`;
    if (ctx.path !== `${base}/` && !ctx.path.startsWith(`${base}/`)) throw notFound(url.pathname);
    ctx.principal = await principalOf(ctx.request, url);
    // 5.8 (paso 1 del orden de 5.4): una escritura con credenciales que el navegador añade solo, desde un origen
    // que no es el de la API ni uno permitido, da 403 sin efecto.
    if (!ctx.read && ctx.principal != null && browserCredentialed(ctx.request) && foreignOrigin(ctx))
      throw new RestepError(403, 'forbidden', t('This origin may not write with these credentials.', 'Este origen no puede escribir con estas credenciales.'));
    const rel = ctx.path.slice(base.length);
    if (rel === '/') return serveDiscovery(ctx);

    // 11.1: la acción new de una colección (GET /books:new); los dos puntos pueden venir como %3A.
    const action = Object.values(colls).find((x) => x.newItem && rel === `${x.path}:new`);
    if (action) return newItem(action, ctx);
    const single = Object.values(singles).find((s) => rel === s.path);
    if (single) return serveSingleton(single, ctx);

    let c, id;
    for (const x of Object.values(colls)) {
      if (rel === x.path) { c = x; break; }
      if (rel.startsWith(`${x.path}/`)) {
        const rest = rel.slice(x.path.length + 1);
        // Un id son caracteres no reservados (3); cualquier otra cosa (dos puntos de una acción, otro segmento) no existe.
        if (isId(rest)) { c = x; id = rest; }
        break;
      }
    }
    if (!c) throw notFound(url.pathname);
    let raw;
    if (id !== undefined) { // 5.4: el 404 va antes que el 405 y el 400
      raw = await c.data.get(id, { ...ctx, collection: c });
      // 3: un id se compara punto de código a punto de código; un adaptador que devuelve otro (07 por 7) no vale.
      if (!raw || String(raw.id) !== id) throw notFound(url.pathname);
    }
    const methods = id === undefined ? c.methods : c.itemMethods;
    if (!methods.includes(method) && method !== 'HEAD') {
      const allow = [...methods, 'HEAD'].join(', ');
      throw new RestepError(405, 'method_not_allowed', t(`Supports ${allow}.`, `Admite ${allow}.`), { headers: { Allow: allow } });
    }
    checkReserved(url.searchParams, !ctx.read ? [] : id === undefined ? ['filter', 'sort', 'fields', 'count', 'limit', 'cursor'] : ['fields']);
    ctx.preferMinimal = /(^|[ ,;])return=minimal\b/.test(ctx.request.headers.get('prefer') ?? '');

    if (ctx.read && id === undefined) {
      const data = await listCollection(c, ctx);
      const tag = await etagOf(data);
      const headers = { ETag: tag, 'Cache-Control': cacheControl(ctx, 'no-cache'),
        'Cache-Groups': groups([`${base}${c.path}`, ...data.items.map((r) => itemPath(c, r.id))]) };
      if (ctx.request.headers.get('if-match') !== null && !strongMatch(ctx.request.headers.get('if-match'), tag))
        throw new RestepError(412, 'precondition_failed', t('If-Match does not match the current representation.', 'If-Match no coincide con la representación actual.'));
      if (weakMatch(ctx.request.headers.get('if-none-match'), tag)) return respond(ctx, 304, undefined, headers);
      return respond(ctx, 200, data, headers);
    }
    if (ctx.read) return readItem(c, raw, ctx);
    const write = id === undefined ? (x) => create(c, x) : (x) => writeItem(c, id, x);
    return createTransaction ? createTransaction((transaction) => write({ ...ctx, transaction }), ctx) : write(ctx);
  }

  // CORS (5.8, opcional) para clientes de navegador, como el explorador: cors: true (cualquier origen) o
  // cors: { origins: ['https://…'] }. Responde el preflight sin reglas de Restep y expone las cabeceras
  // que un cliente Restep necesita leer (ETag para escribir con If-Match, Location, Link, Allow, Retry-After…).
  // Con una lista de orígenes, la respuesta depende de Origin: Vary: Origin en todas, también sin Origin.
  const corsOrigins = cors === true ? '*' : cors?.origins ?? null;
  const varyOrigin = Array.isArray(corsOrigins);
  const EXPOSE = 'ETag, Location, Link, Allow, Accept-Patch, Accept-Query, Retry-After, Content-Language, Deprecation, Sunset, Idempotent-Replayed, Preference-Applied, Cache-Groups, Cache-Group-Invalidation, WWW-Authenticate, DPoP-Nonce';
  function corsOrigin(request) {
    const origin = request.headers.get('origin');
    if (!corsOrigins || !origin) return null;
    return corsOrigins === '*' ? '*' : corsOrigins.includes(origin) ? origin : null;
  }
  async function handle(request) {
    const allow = corsOrigin(request);
    if (allow && request.method === 'OPTIONS' && request.headers.has('access-control-request-method')) {
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': allow,
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, PATCH, DELETE, QUERY',
        'Access-Control-Allow-Headers': request.headers.get('access-control-request-headers') ?? 'Content-Type',
        'Access-Control-Max-Age': '86400',
        ...(varyOrigin && { Vary: 'Origin' }),
      } });
    }
    const response = await handleRestep(request);
    if (!allow && !varyOrigin) return response;
    const h = new Headers(response.headers);
    if (allow) {
      h.set('Access-Control-Allow-Origin', allow);
      h.set('Access-Control-Expose-Headers', EXPOSE);
    }
    if (varyOrigin) h.append('Vary', 'Origin');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
  }
  async function handleRestep(request) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const ctx = { request, url, method, path: url.pathname, read: method === 'GET' || method === 'HEAD', principal: null,
      lang: pickLanguage(request.headers.get('accept-language'), languageList) };
    try {
      return await route(ctx);
    } catch (e) {
      if (!(e instanceof RestepError)) {
        onError(e);
        e = new RestepError(500, 'internal', t('Something went wrong on the server.', 'Algo ha fallado en el servidor.'));
      }
      return problem(ctx, e);
    }
  }

  return { handle, discovery: (lang = languageList[0]) => discoveryDocument(lang), profiles, extensions };
}

// ── Adaptadores de framework ──────────────────────────────────────────────────
// Node http: createServer(toNodeListener(api)).listen(8080). origin fija el origen público si hay un proxy delante.
export function toNodeListener(api, { origin } = {}) {
  return (req, res) => { serveNode(api, req, res, { origin }).catch((e) => { console.error(e); if (!res.headersSent) res.writeHead(500); res.end(); }); };
}
// Express: app.use(toExpress(api)), o app.use('/api', toExpress(api)) con base: '/api'. Usa req.originalUrl,
// así que la ruta completa llega intacta. Si un body parser ya leyó el cuerpo, lo vuelve a serializar.
export function toExpress(api, { origin } = {}) {
  return (req, res, next) => { serveNode(api, req, res, { origin, url: req.originalUrl }).catch(next); };
}
// Hono: app.all('*', toHono(api)). Hono ya trabaja con Request y Response.
export const toHono = (api) => (c) => api.handle(c.req.raw);

async function serveNode(api, req, res, { origin, url }) {
  const proto = req.socket?.encrypted ? 'https' : 'http';
  const full = new URL(url ?? req.url, origin ?? `${proto}://${req.headers.host ?? 'localhost'}`);
  const headers = new Headers();
  for (let i = 0; i < (req.rawHeaders ?? []).length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  const init = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (req.body !== undefined && (req.readableEnded || req.complete)) {
      // Un body parser de Express ya lo consumió: se reconstruye (los cuerpos se comparan como valores JSON).
      init.body = typeof req.body === 'string' || req.body instanceof Uint8Array ? req.body : JSON.stringify(req.body);
      headers.delete('content-length');
    } else {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const size = chunks.reduce((n, c) => n + c.length, 0);
      const body = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) { body.set(c, at); at += c.length; }
      init.body = body;
    }
  }
  const response = await api.handle(new Request(full, init));
  const out = {};
  response.headers.forEach((v, k) => { out[k] = v; });
  res.writeHead(response.status, out);
  res.end(response.body ? new Uint8Array(await response.arrayBuffer()) : undefined);
}
