// restep-server · Biblioteca de servidor para Restep 1 (borrador 4): https://restep.wubytes.com/1/
// Hace la parte difícil del protocolo (descubrimiento, parámetros, errores, Merge Patch, ETag,
// Idempotency-Key, caché, idioma) y deja al usuario solo el acceso a sus datos: un adaptador con
// list, get, create, update y delete por colección.
//
// El núcleo solo usa la Web estándar (Request, Response, URL, Web Crypto), así que funciona igual en
// Node 18+, Deno, Bun o Cloudflare Workers. Los adaptadores de Node http y Express están al final.
//
//   import { createRestep, memoryAdapter, toNodeListener } from './restep-server.mjs';
//   const api = createRestep({ collections: { books: { fields: {...}, data: memoryAdapter([...]) } } });
//   createServer(toNodeListener(api)).listen(8080);

const webcrypto = globalThis.crypto?.subtle ? globalThis.crypto : (await import('node:crypto')).webcrypto;

const SPEC = 'https://restep.wubytes.com/1/';
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
// Compara dos valores de un mismo tipo del descubrimiento (6.1). Para usarla en un adaptador propio.
export function compareValues(type, a, b) {
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
export function matches(row, { field, op, value, type }) {
  const v = valueAt(row, field);
  if (op === 'null') return (v === undefined || v === null) === value;
  if (v === undefined || v === null) return false;
  if (op === 'in') return value.some((x) => compareValues(type, v, x) === 0);
  return COMPARE[op](compareValues(type, v, value));
}
// Ordena por [{ field, desc, type }]; los valores ausentes van al final en los dos sentidos.
export function sorter(sort) {
  return (a, b) => {
    for (const { field, desc, type } of sort) {
      const x = valueAt(a, field), y = valueAt(b, field);
      if (x == null || y == null) { if (x == null && y == null) continue; return x == null ? 1 : -1; }
      const d = compareValues(type, x, y) * (desc ? -1 : 1);
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
export function memoryAdapter(initial = [], { generateId } = {}) {
  const rows = new Map(initial.map((r) => [String(r.id), structuredClone({ ...r, id: String(r.id) })]));
  let counter = Math.max(0, ...[...rows.keys()].map(Number).filter(Number.isInteger)) + 1;
  const newId = generateId ?? (() => { while (rows.has(String(counter))) counter++; return String(counter++); });
  return {
    rows,
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
    async create(data) { const id = newId(); rows.set(id, structuredClone({ id, ...data })); return structuredClone(rows.get(id)); },
    async update(id, data) { rows.set(id, structuredClone({ ...data, id })); return structuredClone(rows.get(id)); },
    async delete(id) { rows.delete(id); },
  };
}

// Almacén de claves de idempotencia en memoria (7.1). En producción, uno duradero con la misma forma:
// reserve(key, print, ttlMs) debe ser atómico (como SET NX): devuelve la entrada que ya había
// ({ print, response? }; sin response, la primera sigue en curso) o null tras reservarla.
export function memoryIdempotencyStore() {
  const map = new Map();
  const live = (key) => { const e = map.get(key); if (e && e.expires <= Date.now()) { map.delete(key); return undefined; } return e; };
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
  if (name.startsWith('_') || name.includes('.')) throw configError(`${cname}.fields.${name}: un campo no puede empezar por _ ni llevar punto`);
  return d;
}
function normalizeCollection(name, def) {
  if (!def.data || typeof def.data.list !== 'function' || typeof def.data.get !== 'function')
    throw configError(`${name}: data tiene que ser un adaptador con list y get (por ejemplo memoryAdapter([...]))`);
  const fields = { id: { type: 'string' } };
  for (const [f, d] of Object.entries(def.fields ?? {})) if (f !== 'id') fields[f] = normalizeField(f, d, name);
  const c = {
    name, path: def.path ?? `/${name}`, description: def.description, fields, data: def.data,
    filter: {}, sort: def.sort ?? [], defaultSort: def.defaultSort ?? ['id'],
    maxLimit: def.maxLimit ?? 50, defaultLimit: def.defaultLimit ?? 20, count: def.count,
    validate: def.validate, requireIfMatch: !!def.requireIfMatch, requireIdempotencyKey: !!def.requireIdempotencyKey,
    methods: ['GET', ...(def.data.create ? ['POST'] : [])],
    itemMethods: ['GET', ...(def.data.update ? ['PATCH'] : []), ...(def.data.delete ? ['DELETE'] : [])],
  };
  if (!/^\/[A-Za-z0-9\-._~/]*[^/]$/.test(c.path) || c.path.includes('{')) throw configError(`${name}: path tiene que ser una ruta fija como /books (sin plantillas)`);
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
    c.filter[f] = { ops, type, description: Array.isArray(d) ? undefined : d.description };
  }
  for (const s of [...c.sort, ...c.defaultSort.map((x) => x.replace(/^-/, ''))])
    if (!c.typeOf(s)) throw configError(`${name}.sort: ${s} no es un campo escalar ni una traducción`);
  if (c.count && !['exact', 'estimated'].includes(c.count)) throw configError(`${name}.count: "exact" o "estimated"`);
  return c;
}

// ── createRestep ──────────────────────────────────────────────────────────────
export function createRestep(options) {
  const {
    collections: defs, base: rawBase = '', languages = LIBRARY_LANGUAGES, languageTags = null,
    idempotencyTtl = DAY, idempotencyStore = memoryIdempotencyStore(), secret, maxBodyBytes = 1 << 20,
    status = null, oauth = null, authenticate = null, docs = null, cors = null, onError = (e) => console.error(e), version = '1',
  } = options;
  const base = rawBase.replace(/\/$/, '');
  if (base && !/^\/[^?#]*$/.test(base)) throw configError('base tiene que empezar por / (como "/api")');
  if (!languages.length || languages.some((l) => !LIBRARY_LANGUAGES.includes(l))) throw configError(`languages: solo ${LIBRARY_LANGUAGES.join(', ')}`);
  if (idempotencyTtl < DAY) throw configError('idempotencyTtl: al menos 86400 segundos (7.1)');
  if (oauth && (!Array.isArray(oauth.authorizationServers) || !oauth.authorizationServers.length || typeof oauth.verifyToken !== 'function'))
    throw configError('oauth necesita authorizationServers (al menos uno) y verifyToken(token, request)');
  const colls = Object.fromEntries(Object.entries(defs).map(([n, d]) => [n, normalizeCollection(n, d)]));
  for (const c of Object.values(colls)) for (const [f, d] of Object.entries(c.fields))
    if (d.type === 'relation' && !colls[d.to]) throw configError(`${c.name}.fields.${f}: la colección ${d.to} no existe`);
  const writable = Object.values(colls).some((c) => c.methods.length > 1 || c.itemMethods.length > 1);
  const profiles = ['core', 'query', ...(writable ? ['writes'] : [])];
  const extensions = oauth ? ['oauth'] : [];
  const profileLink = [...profiles, ...extensions].map((p) => `<${SPEC}${p}>; rel="profile"`).join(', ');
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
    const body = { type: `${SPEC}errors#${e.code}`, title: text(TITLES[e.status] ?? 'Error', lang), status: e.status, code: e.code,
      ...(e.detail != null && { detail: text(e.detail, lang) }), ...extra };
    const headers = { 'Cache-Control': 'no-store', Vary: 'Accept-Language', 'Content-Language': lang, ...e.headers };
    if (e.status === 401 && !Object.keys(e.headers).some((k) => k.toLowerCase() === 'www-authenticate')) headers['WWW-Authenticate'] = 'Bearer realm="restep"';
    return respond(ctx, e.status, body, headers);
  }

  // ── Representaciones ──
  // Solo los campos declarados (más id y los miembros _ que dé el adaptador); un mapa de idioma sin
  // traducciones es {} (3); una relación que llega como id suelto se convierte en { id } (3).
  function represent(c, raw) {
    const out = { id: String(raw.id) };
    for (const [f, d] of Object.entries(c.fields)) {
      if (f === 'id') continue;
      let v = raw[f];
      if (d.type === 'map') v = isObject(v) ? v : {};
      else if (d.type === 'relation' && (typeof v === 'string' || typeof v === 'number')) v = { id: String(v) };
      if (v !== undefined) out[f] = v;
    }
    for (const [k, v] of Object.entries(raw)) if (k.startsWith('_') && k !== '_etag') out[k] = v;
    return out;
  }
  const pick = (row, fields) => {
    if (!fields) return row;
    const out = { id: row.id };
    for (const f of fields) if (f in row) out[f] = row[f];
    for (const [k, v] of Object.entries(row)) if (k.startsWith('_')) out[k] = v;
    return out;
  };
  const itemPath = (c, id) => `${base}${c.path}/${id}`;
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
        : d.type === 'relation' ? { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }
        : { type: d.type };
      if (d.description) s.description = text(d.description, lang);
      const nullable = d.type === 'map' ? kind === 'update' : !d.required;
      return nullable ? { anyOf: [s, { type: 'null' }] } : s;
    };
    const names = Object.keys(c.fields).filter((f) => f !== 'id');
    const props = (kind) => Object.fromEntries(names.map((f) => [f, json(f, kind)]));
    const required = names.filter((f) => c.fields[f].required);
    const reserved = { '^_': {} };
    return {
      item: { type: 'object', required: ['id', ...required], properties: { id: { type: 'string', readOnly: true }, ...props('item') } },
      ...(c.methods.includes('POST') && { create: { type: 'object', required, properties: props('create'), patternProperties: reserved, additionalProperties: false } }),
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
        methods: c.methods, item_methods: c.itemMethods, schemas: schemas(c, lang),
        filter: Object.fromEntries(Object.entries(c.filter).map(([f, d]) => [f, {
          type: d.type, ...(d.type === 'enum' && { values: c.fields[f].values }), ops: d.ops,
          ...(d.description && { description: text(d.description, lang) }) }])),
        sort: c.sort, max_limit: c.maxLimit, ...(c.count && { count: c.count }),
        ...(maps(c).length && { language_maps: Object.fromEntries(maps(c).map((f) => [f, {}])) }),
        ...(rels.length && { relations: Object.fromEntries(rels.map((r) => [r, { to: c.fields[r].to,
          ...(c.fields[r].description && { description: text(c.fields[r].description, lang) }) }])) }),
      }];
    }));
    return { restep: '1.0', version, profiles, extensions,
      ...(writable && { idempotency: { ttl: idempotencyTtl } }),
      ...(statusPath && { status: statusPath }), collections };
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
      out.push({ field, op, value: v, type: d.type });
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
    const type = (ctx.request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!types.includes(type))
      throw new RestepError(415, 'unsupported_media_type', t(`Send ${types.join(' or ')}.`, `Envía ${types.join(' o ')}.`),
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
        if (!(await colls[d.to].data.get(v.id, { ...ctx, collection: colls[d.to] })))
          errors.push({ pointer: ptr(f), code: 'unknown', detail: t(`There is no ${d.to} ${v.id}.`, `No hay ningún ${d.to} ${v.id}.`) });
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

  // Exclusión por elemento: evaluar If-Match y escribir es atómico dentro de este proceso (7.2).
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
    const sort = parseSort(c, params).map((s) => ({ ...s, type: c.typeOf(s.field) }));
    if (!sort.some((s) => s.field === 'id')) sort.push({ field: 'id', desc: false, type: 'string' }); // desempate estable (6.2)
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
    const page = await c.data.list({ filter, sort, limit, cursor, count: count === 'true', fields }, { ...ctx, collection: c });
    if (count === 'true' && typeof page.total !== 'number') throw new Error(`restep-server: ${c.name}.data.list no ha devuelto total con count`);
    let next = null;
    if (page.next != null) {
      const q = new URLSearchParams(params);
      q.set('cursor', await makeCursor(page.next, print));
      next = `${ctx.url.pathname}?${q}`;
    }
    const items = page.items.map((r) => pick(represent(c, r), fields));
    return { items, next, ...(count === 'true' && { total: page.total }), ...(count === 'true' && c.count === 'estimated' && { total_estimated: true }) };
  }

  async function collectionEtag(c, ctx) {
    const page = await c.data.list({ filter: [], sort: [{ field: 'id', desc: false, type: 'string' }], limit: Math.min(c.defaultLimit, c.maxLimit), cursor: null, count: false, fields: null }, { ...ctx, collection: c });
    return etagOf(page.items.map((r) => represent(c, r)));
  }

  async function create(c, ctx) {
    const req = ctx.request;
    const rawKey = req.headers.get('idempotency-key');
    let key = null;
    if (rawKey !== null) {
      const m = rawKey.trim().match(/^"((?:[\x20\x21\x23-\x5b\x5d-\x7e]|\\["\\])*)"$/);
      if (!m) throw new RestepError(400, 'bad_request', t('Idempotency-Key must be a quoted string, such as "8e03978e-40d5".', 'Idempotency-Key tiene que ser una cadena entre comillas, como "8e03978e-40d5".'));
      key = m[1];
    } else if (c.requireIdempotencyKey) throw new RestepError(400, 'idempotency_key_required', t('This collection requires Idempotency-Key.', 'Esta colección exige Idempotency-Key.'));
    const [body, sent] = await readBody(ctx, ['application/json']);
    // 7.1: una clave es de un principal y de un destino; dos peticiones son la misma si sus cuerpos son iguales como JSON.
    const scope = key !== null ? `${await hash(String(ctx.principal ?? ''))} POST ${ctx.url.pathname} ${key}` : null;
    const print = scope && await hash(canonical(sent));
    const saved = scope ? await idempotencyStore.reserve(scope, print, idempotencyTtl * 1000) : null;
    let reserved = scope && !saved;
    try {
      if (saved && saved.print === print) {
        if (!saved.response) throw new RestepError(409, 'conflict', t('The same request is still being processed.', 'La misma petición todavía se está procesando.'));
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
      if ('id' in body) throw invalid([{ pointer: '/id', code: 'read_only', detail: t('The server assigns id.', 'El servidor asigna el id.') }]);
      const errors = await bodyErrors(c, body, undefined, ctx);
      const data = { ...body };
      for (const f of maps(c)) if (!isObject(data[f])) data[f] = {};
      for (const f of Object.keys(data)) if (data[f] === null && c.fields[f].type !== 'relation') delete data[f];
      errors.push(...requiredErrors(c, data).filter((e) => !errors.some((x) => x.pointer === e.pointer)));
      if (!errors.length) errors.push(...await customErrors(c, data, { ...ctx, collection: c, method: 'POST' }));
      if (errors.length) throw invalid(errors);
      const stored = await c.data.create(data, { ...ctx, collection: c });
      if (!stored || stored.id == null) throw new Error(`restep-server: ${c.name}.data.create tiene que devolver el elemento con su id`);
      const row = represent(c, stored);
      const minimal = ctx.preferMinimal;
      const response = [201, minimal ? undefined : row, { Location: itemPath(c, row.id), ETag: await etagOf(row),
        'Cache-Group-Invalidation': groups([`${base}${c.path}`, itemPath(c, row.id)]), ...(minimal && { 'Preference-Applied': 'return=minimal' }) }];
      if (scope) { await idempotencyStore.complete(scope, response); reserved = false; }
      return respond(ctx, ...response);
    } finally {
      // Una petición rechazada antes de ejecutarse no gasta la clave (7.1).
      if (reserved) await idempotencyStore.release(scope);
    }
  }

  async function writeItem(c, id, ctx) {
    const patch = ctx.method === 'PATCH' ? (await readBody(ctx, ['application/merge-patch+json', 'application/json']))[0] : null;
    return withLock(`${c.name}/${id}`, async () => {
      const cctx = { ...ctx, collection: c };
      const raw = await c.data.get(id, cctx);
      if (!raw) throw notFound(ctx.url.pathname);
      const current = represent(c, raw);
      const tag = await etagOf(current);
      const ifMatch = ctx.request.headers.get('if-match'), ifNone = ctx.request.headers.get('if-none-match');
      if (c.requireIfMatch && ifMatch === null) throw new RestepError(428, 'precondition_required', t('This collection requires If-Match to write.', 'Esta colección exige If-Match para escribir.'));
      if (ifMatch !== null && !strongMatch(ifMatch, tag)) throw new RestepError(412, 'precondition_failed', t('Someone changed it: read it again before writing.', 'Alguien lo ha cambiado: vuelve a leerlo antes de escribir.'));
      if (ifNone !== null && weakMatch(ifNone, tag)) throw new RestepError(412, 'precondition_failed', t('If-None-Match matches the current item.', 'If-None-Match coincide con el elemento actual.'));
      const invalidate = { 'Cache-Group-Invalidation': groups([`${base}${c.path}`, itemPath(c, id)]) };
      if (ctx.method === 'DELETE') {
        await c.data.delete(id, cctx);
        return respond(ctx, 204, undefined, invalidate);
      }
      if ('id' in patch) {
        if (patch.id !== id) throw invalid([{ pointer: '/id', code: 'read_only', detail: t('id cannot change.', 'id no puede cambiar.') }]);
        delete patch.id;
      }
      const errors = await bodyErrors(c, patch, current, ctx);
      if (errors.length) throw invalid(errors);
      const { id: _, ...rest } = current;
      const merged = applyPatch(c, Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith('_'))), patch);
      errors.push(...requiredErrors(c, merged));
      if (!errors.length) errors.push(...await customErrors(c, merged, { ...cctx, current, patch }));
      if (errors.length) throw invalid(errors, t('The result of the patch is not valid.', 'El resultado del parche no es válido.'));
      const stored = await c.data.update(id, merged, { ...cctx, current, patch });
      const row = represent(c, stored ?? { ...merged, id });
      const etag = await etagOf(row);
      if (ctx.preferMinimal) return respond(ctx, 204, undefined, { ETag: etag, ...invalidate, 'Preference-Applied': 'return=minimal' });
      return respond(ctx, 200, row, { ETag: etag, ...invalidate });
    });
  }

  async function readItem(c, raw, ctx) {
    const params = ctx.url.searchParams;
    const row = represent(c, raw);
    const fields = parseFields(c, params);
    const itemTag = await etagOf(row);
    // 7.2: con fields, otra representación con su propia ETag; la del elemento va en _etag.
    const data = fields ? { ...pick(row, fields), _etag: itemTag } : row;
    const tag = fields ? await etagOf(data) : itemTag;
    const headers = { ETag: tag, 'Cache-Control': cacheControl(ctx, 'no-cache'), 'Cache-Groups': groups([itemPath(c, row.id)]) };
    const ifMatch = ctx.request.headers.get('if-match');
    if (ifMatch !== null && !strongMatch(ifMatch, itemTag)) throw new RestepError(412, 'precondition_failed', t('If-Match does not match the current representation.', 'If-Match no coincide con la representación actual.'));
    if (weakMatch(ctx.request.headers.get('if-none-match'), tag)) return respond(ctx, 304, undefined, headers);
    return respond(ctx, 200, data, headers);
  }

  async function route(ctx) {
    const { url, method } = ctx;
    // 10.5: los metadatos son públicos y no son un recurso de la API.
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
    if (url.pathname !== `${base}/` && !url.pathname.startsWith(`${base}/`)) throw notFound(url.pathname);
    ctx.principal = await principalOf(ctx.request, url);
    const rel = url.pathname.slice(base.length);
    if (rel === '/') return serveDiscovery(ctx);

    let c, id;
    for (const x of Object.values(colls)) {
      if (rel === x.path) { c = x; break; }
      if (rel.startsWith(`${x.path}/`)) {
        const rest = rel.slice(x.path.length + 1);
        let decoded;
        try { decoded = decodeURIComponent(rest); } catch { decoded = ''; }
        // Un id son caracteres no reservados (3); los dos puntos serían una acción, que no se implementa.
        if (rest && !rest.includes('/') && /^[A-Za-z0-9\-._~]+$/.test(decoded) && decoded !== '.' && decoded !== '..') { c = x; id = decoded; }
        break;
      }
    }
    if (!c) throw notFound(url.pathname);
    let raw;
    if (id !== undefined) { // 5.4: el 404 va antes que el 405 y el 400
      raw = await c.data.get(id, { ...ctx, collection: c });
      if (!raw) throw notFound(url.pathname);
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
    if (id === undefined) return create(c, ctx);
    return writeItem(c, id, ctx);
  }

  // CORS (opcional) para clientes de navegador, como el explorador: cors: true (cualquier origen) o
  // cors: { origins: ['https://…'] }. Responde el preflight y expone las cabeceras que un cliente
  // Restep necesita leer (ETag para escribir con If-Match, Location, Link, Allow, Retry-After…).
  const corsOrigins = cors === true ? '*' : cors?.origins ?? null;
  const EXPOSE = 'ETag, Location, Link, Allow, Retry-After, Content-Language, Deprecation, Sunset, Cache-Groups, Cache-Group-Invalidation, WWW-Authenticate';
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
        ...(allow !== '*' && { Vary: 'Origin' }),
      } });
    }
    const response = await handleRestep(request);
    if (!allow) return response;
    const h = new Headers(response.headers);
    h.set('Access-Control-Allow-Origin', allow);
    h.set('Access-Control-Expose-Headers', EXPOSE);
    if (allow !== '*') h.append('Vary', 'Origin');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
  }
  async function handleRestep(request) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const ctx = { request, url, method, read: method === 'GET' || method === 'HEAD', principal: null,
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
