// restep-server · Server library for Restep 1 (draft 7, "restep": "1.0-draft.7"): https://restep.wubytes.com/1/
// Does the hard part of the protocol (discovery, parameters, errors, Merge Patch, ETag,
// Idempotency-Key, caching, language) and leaves the user only the access to their data: an adapter with
// list, get, create, update and delete per collection (and get and update per singleton).
//
// The core only uses the standard Web APIs (Request, Response, URL, Web Crypto), so it works the same on
// Node 18+, Deno, Bun or Cloudflare Workers. The Node http and Express adapters are at the end.
//
//   import { createRestep, memoryAdapter, toNodeListener } from './restep-server.mjs';
//   const api = createRestep({ collections: { books: { fields: {...}, data: memoryAdapter([...]) } } });
//   createServer(toNodeListener(api)).listen(8080);

const webcrypto = globalThis.crypto?.subtle ? globalThis.crypto : (await import('node:crypto')).webcrypto;

const PROFILE = 'https://w3id.org/restep/1/'; // identifier: profile link and error types
const RESTEP = '1.0-draft.7'; // 1.1: a draft is declared with its suffix
// 3: the grammar of the names the discovery declares (collections, fields, filters, actions, reasons…).
export const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
// 3: an id is unreserved characters of RFC 3986, and not "." or "..".
const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9\-._~]+$/.test(v) && v !== '.' && v !== '..';
const COLLATIONS = ['codepoint', 'server'];
const RESERVED = ['filter', 'sort', 'fields', 'include', 'count', 'limit', 'cursor', 'since', 'languages'];
const SCALARS = ['string', 'integer', 'number', 'decimal', 'boolean', 'date', 'datetime', 'localdatetime', 'timezone', 'duration', 'enum'];
// 6.1: the closed list of operators; no other may be declared.
const OPS = ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'in', 'nin', 'null', 'prefix', 'contains'];
// 11.1 and 4.3: the effects an unsafe operation may declare.
const EFFECTS = ['destroys', 'external', 'charges'];
// 5.1: the methods this server knows; any other gets 501. QUERY is known (405 without query-method).
const KNOWN_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'QUERY', 'TRACE', 'CONNECT'];
const LIBRARY_LANGUAGES = ['en', 'es']; // the languages the library can give its texts in
const DAY = 86400;

// ── Human-readable texts (5.6) ─────────────────────────────────────────────────
// A text is a string (the same in every language) or an object { en, es, ... }.
export const t = (en, es) => ({ en, es });
const text = (v, lang) => (v == null || typeof v === 'string' ? v : v[lang] ?? v.en ?? Object.values(v)[0]);

// RFC 4647 Lookup (3.4) over the offered languages: by weight, then by order in the header,
// case-insensitive, trimming from the end. *, q=0 and malformed ranges are ignored.
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

// A well-formed language tag (RFC 5646, 2.1), in lowercase.
export const LANGUAGE_TAG = new RegExp('^(?:(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{4,8})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|[0-9]{3}))?' +
  '(?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*(?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*(?:-x(?:-[a-z0-9]{1,8})+)?' +
  '|x(?:-[a-z0-9]{1,8})+|en-gb-oed|i-(?:ami|bnn|default|enochian|hak|klingon|lux|mingo|navajo|pwn|tao|tay|tsu)' +
  '|sgn-(?:be-fr|be-nl|ch-de)|art-lojban|cel-gaulish|no-bok|no-nyn|zh-(?:guoyu|hakka|min|min-nan|xiang))$');

// ── Errors (5.4) ──────────────────────────────────────────────────────────────
// 5.4: the closed table of codes, by status. A status it does not list takes http_ and its three digits.
export const ERROR_CODES = {
  400: ['bad_request', 'invalid_parameter', 'unsupported_parameter', 'idempotency_key_required'], 401: ['unauthenticated'],
  403: ['forbidden'], 404: ['not_found'], 405: ['method_not_allowed'], 406: ['not_acceptable'], 408: ['request_timeout'],
  409: ['conflict', 'request_in_progress'], 410: ['state_expired', 'retired'], 412: ['precondition_failed'],
  413: ['content_too_large'], 414: ['uri_too_long'], 415: ['unsupported_media_type'], 421: ['misdirected_request'],
  422: ['invalid', 'idempotency_mismatch'], 424: ['not_executed'], 425: ['too_early'], 428: ['precondition_required'],
  429: ['rate_limited'], 500: ['internal'], 501: ['not_implemented'], 502: ['bad_gateway'], 503: ['unavailable'], 504: ['gateway_timeout'],
};
// 5.4: the code a status must carry. null code: the only one the table gives that status, or http_NNN.
function codeFor(status, code) {
  if (!Number.isInteger(status) || status < 400 || status > 599) throw new Error(`restep-server: ${status} is not an error status`);
  const listed = ERROR_CODES[status];
  if (!listed) {
    if (code != null && code !== `http_${status}`) throw new Error(`restep-server: status ${status} is not in the table of 5.4, so its code is http_${status}, not ${code}`);
    return `http_${status}`;
  }
  if (code == null && listed.length === 1) return listed[0];
  if (!listed.includes(code)) throw new Error(`restep-server: code ${code} does not go with status ${status}; use one of ${listed.join(', ')} (5.4)`);
  return code;
}
// Throw it from an adapter to answer with a problem+json: new RestepError(409, 'conflict', 'Already exists.')
// detail (and the detail of each entry of errors) may be a text t(en, es).
export class RestepError extends Error {
  constructor(status, code, detail, { headers = {}, ...extra } = {}) {
    // 5.4: a reason follows the name grammar; one that does not is a programming error (500).
    if (extra.reason !== undefined && (typeof extra.reason !== 'string' || !NAME.test(extra.reason)))
      throw new Error(`restep-server: reason ${JSON.stringify(extra.reason)} does not follow the name grammar (3)`);
    // 5.4: the table is closed; a code that does not go with the status is a programming error (500).
    code = codeFor(status, code);
    super(text(detail, 'en') ?? code);
    Object.assign(this, { status, code, detail, extra, headers });
  }
}
const TITLES = {
  400: t('Bad request', 'Petición incorrecta'), 401: t('Unauthenticated', 'Sin autenticar'), 403: t('Forbidden', 'Prohibido'),
  404: t('Not found', 'No encontrado'), 405: t('Method not allowed', 'Método no permitido'), 406: t('Not acceptable', 'No aceptable'),
  408: t('Request timeout', 'Tiempo de petición agotado'),
  409: t('Conflict', 'Conflicto'), 410: t('Gone', 'Ya no existe'), 412: t('Precondition failed', 'Falla una precondición'),
  413: t('Content too large', 'Contenido demasiado grande'), 414: t('URI too long', 'URI demasiado larga'),
  415: t('Unsupported media type', 'Tipo de contenido no admitido'), 421: t('Misdirected request', 'Petición mal dirigida'),
  422: t('Invalid data', 'Datos no válidos'), 424: t('Failed dependency', 'Falla una dependencia'), 425: t('Too early', 'Demasiado pronto'),
  428: t('Precondition required', 'Falta una precondición'),
  429: t('Too many requests', 'Demasiadas peticiones'), 431: t('Request header fields too large', 'Cabeceras demasiado grandes'),
  500: t('Internal error', 'Error interno'), 501: t('Not implemented', 'No implementado'), 502: t('Bad gateway', 'Pasarela incorrecta'),
  503: t('Unavailable', 'No disponible'), 504: t('Gateway timeout', 'Tiempo de pasarela agotado'),
  511: t('Network authentication required', 'Hace falta autenticarse en la red'),
};
// 5.1 and 5.4 (RFC 9213): fields aimed at shared caches, which would let one store a response that must not be.
const SHARED_CACHE_FIELD = /^(cdn-cache-control|[a-z0-9-]+-cdn-cache-control|surrogate-control)$/i;
const bad = (parameter, detail) => new RestepError(400, 'invalid_parameter', detail, { parameter });
const unsupported = (parameter, detail = t(`This resource does not support ${parameter}.`, `Este recurso no admite ${parameter}.`)) =>
  new RestepError(400, 'unsupported_parameter', detail, { parameter });
const invalid = (errors, detail = t('Invalid data.', 'Datos no válidos.')) => new RestepError(422, 'invalid', detail, { errors });
const once = (key) => bad(key, t(`Send ${key} once.`, `Envía ${key} una sola vez.`));
const notFound = (path) => new RestepError(404, 'not_found', t(`${path} does not exist.`, `${path} no existe.`));
// 5.1: an id the collection has or had. Same whether or not the client can see that item.
// Throw it from the create of a custom adapter when its primary key rejects the id.
export const takenError = () => new RestepError(409, 'conflict', t('That id is taken.', 'Ese id ya está cogido.'),
  { errors: [{ pointer: '/id', code: 'taken', detail: t('An item of this collection has or had this id.', 'Un elemento de esta colección tiene o tuvo este id.') }] });

// ── Types and comparison (3, 6.1) ────────────────────────────────────────────
export const DECIMAL = /^-?\d+(\.\d+)?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
// 3: T and Z are written in uppercase and accepted in lowercase.
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|([+-])(\d{2}):(\d{2}))$/;
const LOCALDATETIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?$/;
// 3: the duration grammar of RFC 3339 (Appendix A), plus a fraction of up to nine digits in the seconds;
// letters in either case. Groups: 1 years, 2 months, 3 days, 4 hours, 5 minutes, 6 seconds, 7 weeks.
const SEC = '(\\d+(?:\\.\\d{1,9})?)S';
const DURATION = new RegExp(`^P(?:(?:(?:(\\d+)Y)?(?:(\\d+)M)?(?:(\\d+)D)?)(?:T(?:(\\d+)H)?(?:(\\d+)M)?(?:${SEC})?)?|(\\d+)W)$`, 'i');
// The regular expression above lets through what the grammar's nesting forbids (P1Y2D, PT1H5S, P, PT):
// each unit present needs the next smaller one of its part present too, up to the last one given.
function isDuration(v) {
  const m = typeof v === 'string' && DURATION.exec(v);
  if (!m) return false;
  if (m[7] !== undefined) return true;
  const chain = (parts) => { const at = parts.map((x) => x !== undefined); const first = at.indexOf(true), last = at.lastIndexOf(true);
    return first < 0 || at.slice(first, last + 1).every(Boolean); };
  const hasDate = [m[1], m[2], m[3]].some((x) => x !== undefined), hasTime = [m[4], m[5], m[6]].some((x) => x !== undefined);
  if (!hasDate && !hasTime) return false;
  if (/T/i.test(v) && !hasTime) return false;
  return chain([m[1], m[2], m[3]]) && chain([m[4], m[5], m[6]]);
}
const validDate = (y, m, d) => { const x = new Date(Date.UTC(+y, +m - 1, +d)); return x.getUTCMonth() === +m - 1 && x.getUTCDate() === +d; };
const isDate = (v) => { const m = DATE.exec(v); return !!m && validDate(m[1], m[2], m[3]); };
const isDatetime = (v) => { const m = DATETIME.exec(v); return !!m && validDate(m[1], m[2], m[3]) && +m[4] < 24 && +m[5] < 60 && +m[6] < 61 && (m[10] === undefined || (+m[10] < 24 && +m[11] < 60)); };
const isLocalDatetime = (v) => { const m = LOCALDATETIME.exec(v); return !!m && validDate(m[1], m[2], m[3]) && +m[4] < 24 && +m[5] < 60 && +m[6] < 61; };
// 3: a time zone is a name of the IANA Time Zone Database, such as Europe/Madrid.
const isTimezone = (v) => {
  if (typeof v !== 'string' || !/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(v)) return false;
  try { return new Intl.DateTimeFormat('en', { timeZone: v }).resolvedOptions().timeZone !== undefined; } catch { return false; }
};
// 6.1: a filter value with a leap second (:60) gives invalid_parameter; 3: so does one in a request body (422 format).
const leapSecond = (v) => /[Tt]\d{2}:\d{2}:60/.test(v);
// 6.1, 11.1: an integer or number operand follows the number grammar of RFC 8259 (section 6), exponent included
// (2e1 is 20); +20, .5, 020 and 0x14 do not match it.
const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$/;
// 5.3 and 6.1: this library's limit on an integer or number operand, computed from its digits and exponent, never
// through floating point: zero, or a magnitude from 1e-300 to 1e300. Within it, the operand is a finite, nonzero
// JavaScript number; over it, invalid_parameter names the limit, and the operand is never replaced by an
// infinity or zero.
const NUMBER_LIMIT = 300;
function numberOverLimit(raw) {
  const m = /^-?(\d+)(?:\.(\d+))?(?:[eE]([-+]?\d+))?$/.exec(raw);
  if (!m) return false;
  const digits = (m[1] + (m[2] ?? '')).replace(/^0+/, '');
  if (!digits) return false; // zero
  const top = BigInt(digits.length - 1) + BigInt(m[3] ?? 0) - BigInt((m[2] ?? '').length); // value in [10^top, 10^(top+1))
  const limit = BigInt(NUMBER_LIMIT);
  return top > limit || (top === limit && digits.replace(/0+$/, '') !== '1') || top < -limit;
}
// 6.1: a numeric literal whose exact decimal value has no fractional part (20, 20.0, 2e1, 2.50e1 is not),
// computed from its digits and exponent, never through floating point.
function integerLiteral(raw) {
  const m = /^-?(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([-+]?\d+))?$/.exec(raw);
  if (!m) return false;
  const frac = (m[2] ?? '').replace(/0+$/, '');
  if (!/[1-9]/.test(m[1] + frac)) return true; // zero
  const digits = (m[1] + frac).replace(/0+$/, '');
  const trailing = (m[1] + frac).length - digits.length;
  const exp = BigInt(m[3] ?? 0) - BigInt(frac.length) + BigInt(trailing);
  return exp >= 0n;
}

// 6.1: the exact value of a JSON number (a filter operand, or a stored number written as JavaScript does,
// 4.3 or 1e+21) as a plain decimal string without exponent or trailing zeros: 2e1 and 20.0 are "20". Never
// through floating point. Within NUMBER_LIMIT the result has at most a few hundred digits.
function plainDecimal(raw) {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([-+]?\d+))?$/.exec(String(raw));
  if (!m) return String(raw);
  let digits = (m[2] + (m[3] ?? '')).replace(/^0+/, '');
  if (!digits) return '0';
  let point = (m[2].replace(/^0+/, '').length || -((m[3] ?? '').match(/^0*/)[0].length)) + Number(m[4] ?? 0);
  if (!m[2].replace(/^0+/, '')) digits = digits.replace(/^0+/, '');
  digits = digits.replace(/0+$/, '') || '0';
  const int = point <= 0 ? '0' : digits.slice(0, point).padEnd(point, '0');
  const frac = point >= digits.length ? '' : point < 0 ? '0'.repeat(-point) + digits : digits.slice(point);
  return `${m[1] && digits !== '0' ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}
function cmpDecimal(a, b) { // exact: compares digit strings, never through Number
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
function cmpText(a, b) { // by Unicode code points, not UTF-16 units
  const x = [...a], y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
}
function instant(v) { // [seconds since 1970, fraction as a digit string]
  const m = DATETIME.exec(v);
  if (!m) return [NaN, ''];
  const offset = m[8].toUpperCase() === 'Z' ? 0 : (m[9] === '-' ? -1 : 1) * (+m[10] * 60 + +m[11]);
  return [Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 - offset * 60, (m[7] ?? '').slice(1)];
}
// 3 and 6.1: the exact length of a duration in nanoseconds; a day counts as 24 hours (a stored value with
// years or months counts 365 and 30 days, since a filter value never carries them).
function nanoseconds(v) {
  const m = DURATION.exec(v);
  if (!m) return null;
  const n = (i) => BigInt(m[i] ?? 0);
  const [whole, frac = ''] = (m[6] ?? '0').split('.');
  const day = 86400n;
  const s = n(1) * 365n * day + n(2) * 30n * day + n(7) * 7n * day + n(3) * day + n(4) * 3600n + n(5) * 60n + BigInt(whole);
  return s * 1000000000n + BigInt(frac.padEnd(9, '0'));
}
const cmpFraction = (f1, f2) => { const n = Math.max(f1.length, f2.length), x = f1.padEnd(n, '0'), y = f2.padEnd(n, '0'); return x === y ? 0 : x < y ? -1 : 1; };
// The "server" collation of memoryAdapter (6.1): case- and accent-insensitive. It is total and
// deterministic, and its equality is that of its order (compare gives 0 exactly when they are equal).
const serverCollator = new Intl.Collator('und', { sensitivity: 'base' });
// Compares two values of the same discovery type (6.1). For use in a custom adapter.
// collation: the one in collations for that field; "server" compares text with serverCollator, any other by code point.
export function compareValues(type, a, b, collation) {
  if (collation === 'server' && (type === 'string' || type === 'enum' || type === undefined)) return serverCollator.compare(String(a), String(b));
  switch (type) {
    case 'decimal': return cmpDecimal(String(a), String(b));
    case 'integer': case 'number': return cmpDecimal(plainDecimal(a), plainDecimal(b)); // 6.1: exactly
    case 'boolean': return Number(a) - Number(b);
    case 'date': return cmpText(String(a), String(b));
    case 'datetime': {
      const [s1, f1] = instant(a), [s2, f2] = instant(b);
      if (s1 !== s2) return s1 - s2;
      return cmpFraction(f1, f2);
    }
    case 'localdatetime': { // 6.1: as wall-clock date-times, without any zone, exactly
      const [x, f1 = ''] = String(a).toUpperCase().split('.'), [y, f2 = ''] = String(b).toUpperCase().split('.');
      return cmpText(x, y) || cmpFraction(f1, f2);
    }
    case 'duration': { const x = nanoseconds(a), y = nanoseconds(b); return x === y ? 0 : x < y ? -1 : 1; }
    default: return cmpText(String(a), String(b));
  }
}
// 6.1: the "server" collation of memoryAdapter for prefix and contains, consistent with its eq: without case or accents.
const fold = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('und');
// The value at a path: "price", "name.es-mx" (a translation) or "author.id" (the id of a relation).
export const valueAt = (row, path) => {
  const dot = path.indexOf('.');
  if (dot < 0) return row[path];
  const head = row[path.slice(0, dot)], tail = path.slice(dot + 1);
  // A relation stored as a bare id is read as { id } (the same as in the representation).
  return (typeof head === 'string' || typeof head === 'number') && tail === 'id' ? String(head) : head?.[tail];
};
const COMPARE = { eq: (c) => c === 0, ne: (c) => c !== 0, lt: (c) => c < 0, le: (c) => c <= 0, gt: (c) => c > 0, ge: (c) => c >= 0 };
// One scalar against one operator (6.1). Except null, no operator matches an absent or null value.
function test1(v, { op, value, type, collation }) {
  if (op === 'null') return (v === undefined || v === null) === value;
  if (v === undefined || v === null) return false;
  if (op === 'in') return value.some((x) => compareValues(type, v, x, collation) === 0);
  if (op === 'nin') return value.every((x) => compareValues(type, v, x, collation) !== 0);
  if (op === 'prefix' || op === 'contains') {
    const [x, y] = collation === 'server' ? [fold(v), fold(value)] : [String(v), String(value)];
    return op === 'prefix' ? x.startsWith(y) : x.includes(y);
  }
  return COMPARE[op](compareValues(type, v, value, collation));
}
// 6.1: the elements of a to-many relationship ({ id } objects) or of a list field; absent and null are [].
const elementsOf = (row, group, kind) => {
  const v = row[group];
  if (!Array.isArray(v)) return [];
  return kind === 'relation' ? v.filter((x) => x != null).map((x) => (isObject(x) ? x : { id: String(x) })) : v;
};
// Does row meet the filter { field, op, value, type }? Except null, no operator matches an absent or null value.
// A named filter (6.1) comes as { named, value, apply } and its apply (row, value) => boolean decides it.
// A field filter may carry read(row), which gives the value to compare (a localized field, 3).
// A group (6.1) comes as { group, kind, filters, null }: the filters on a to-many relationship (kind
// "relation", each filter's field relative to the related item, such as "id") or on a list field (kind "list",
// field ""); it matches when some element matches all of them, and null: true negates it. null tests the group,
// never an element (6.1): alone, true when it is empty, absent or null; with other filters of the group, true
// when no visible element matches all the other filters of the group at once, and false when some does.
export function matches(row, f) {
  if (f.named !== undefined) {
    if (typeof f.apply !== 'function') throw new Error(`Named filter ${f.named} needs apply to filter in memory; a custom adapter translates it by name`);
    return !!f.apply(row, f.value);
  }
  if (f.group !== undefined) {
    const els = elementsOf(row, f.group, f.kind);
    const some = els.some((e) => f.filters.every((x) => test1(x.field ? valueAt(e, x.field) : e, x)));
    if (f.null === true) return f.filters.length ? !some : els.length === 0;
    if (f.null === false && !f.filters.length) return els.length > 0;
    return some;
  }
  return test1(f.read ? f.read(row) : valueAt(row, f.field), f);
}
// Sorts by [{ field, desc, type, collation }]; absent values go last in both directions.
// A key may carry read(row) (a localized field), or group and kind (a to-many path with quantifier, 6.2):
// ascending by the least value among the elements, descending by the greatest.
export function sorter(sort) {
  const keyOf = (row, s) => {
    if (s.group === undefined) return s.read ? s.read(row) : valueAt(row, s.field);
    const vals = elementsOf(row, s.group, s.kind).map((e) => (s.sub ? valueAt(e, s.sub) : e)).filter((v) => v != null)
      .sort((x, y) => compareValues(s.type, x, y, s.collation));
    return s.desc ? vals.at(-1) : vals[0];
  };
  return (a, b) => {
    for (const s of sort) {
      const x = keyOf(a, s), y = keyOf(b, s);
      if (x == null || y == null) { if (x == null && y == null) continue; return x == null ? 1 : -1; }
      const d = compareValues(s.type, x, y, s.collation) * (s.desc ? -1 : 1);
      if (d) return d;
    }
    return 0;
  };
}

// ── In-memory adapter ─────────────────────────────────────────────────────────
// For tests and examples. A custom adapter implements the same methods (all optional except
// list and get); the missing ones remove their HTTP method from the collection.
//   list({ filter, sort, limit, cursor, count }, ctx) → { items, next, total }
//   get(id, ctx) → item | null;  create(data, ctx) → item;  update(id, data, ctx) → item;  delete(id, ctx)
//   taken(id, ctx) → boolean: whether an item has or had the id (5.1), for id_from "client" or "either";
//     with reusableIds, only whether an item has it now.
// With reusableIds (5.1, 7.2), an item that takes back the id of a deleted one is a new incarnation: rows carry
// _incarnation, which never reaches the representation but counts towards the item ETag.
export function memoryAdapter(initial = [], { generateId } = {}) {
  const rows = new Map(initial.map((r) => [String(r.id), structuredClone({ ...r, id: String(r.id) })]));
  // 5.1: the ids the collection has had, also those of deleted items: they are never reused.
  const used = new Set(rows.keys());
  let counter = Math.max(0, ...[...rows.keys()].map(Number).filter(Number.isInteger)) + 1;
  const newId = generateId ?? (() => { while (used.has(String(counter))) counter++; return String(counter++); });
  const incarnations = new Map(); // id → how many items have had it, in a collection with reusableIds
  return {
    rows,
    async taken(id, ctx) { return ctx?.collection?.reusableIds ? rows.has(id) : used.has(id); },
    async list({ filter, sort, limit, cursor, count }) {
      const all = [...rows.values()].filter((r) => filter.every((f) => matches(r, f))).sort(sorter(sort));
      const offset = cursor ?? 0; // this adapter's cursor is an offset; the library signs it
      return {
        items: all.slice(offset, offset + limit).map((r) => structuredClone(r)),
        next: offset + limit < all.length ? offset + limit : null,
        ...(count && { total: all.length }),
      };
    },
    async get(id) { return rows.has(id) ? structuredClone(rows.get(id)) : null; },
    // data.id arrives if the client chose it (id_from); otherwise one the collection has not had is assigned.
    async create(data, ctx) {
      const id = data.id ?? newId();
      const reusable = !!ctx?.collection?.reusableIds && data.id !== undefined;
      if (reusable ? rows.has(id) : used.has(id)) throw takenError();
      const n = (incarnations.get(id) ?? (used.has(id) ? 1 : 0)) + 1;
      incarnations.set(id, n);
      used.add(id);
      rows.set(id, structuredClone({ ...data, id, ...(n > 1 && { _incarnation: n }) }));
      return structuredClone(rows.get(id));
    },
    async update(id, data) {
      const inc = rows.get(id)?._incarnation;
      rows.set(id, structuredClone({ ...data, id, ...(inc !== undefined && { _incarnation: inc }) }));
      return structuredClone(rows.get(id));
    },
    async delete(id) { rows.delete(id); },
  };
}

// An in-memory singleton (5.9), for tests and examples: get(ctx) → object; update(data, ctx) → object.
export function memorySingleton(initial = {}) {
  let value = structuredClone(initial);
  return {
    async get() { return structuredClone(value); },
    async update(data) { value = structuredClone(data); return structuredClone(value); },
  };
}

// In-memory store of idempotency keys (7.1). In production, a durable one with the same shape:
// reserve(key, print, ttlMs) must be atomic (like SET NX): it returns the entry that was already there
// ({ print, response? }; without response, the first is still in progress) or null after reserving it.
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

// ── Utilities ─────────────────────────────────────────────────────────────────
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
const BASIS = Symbol('what else the item ETag depends on');
// 5.1 (RFC 6266): the filename of a Content-Disposition, quoted or not, or undefined.
function dispositionFilename(h) {
  const m = /;\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))/i.exec(h ?? '');
  return m ? (m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]) : undefined;
}
// 5.1 (RFC 7578): the one part named file of a multipart/form-data body, or null if there is not exactly one part.
function onePart(header, bytes) {
  const b = /;\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(header);
  if (!b) return null;
  const boundary = `--${b[1] ?? b[2]}`;
  const latin = new TextDecoder('latin1').decode(bytes); // one char per byte, so offsets are byte offsets
  const first = latin.indexOf(boundary), second = latin.indexOf(`\r\n${boundary}`, first + boundary.length);
  // Exactly one part: the second delimiter is the closing one ("--" after it).
  if (first < 0 || second < 0 || latin.slice(second + 2 + boundary.length, second + 4 + boundary.length) !== '--') return null;
  const start = first + boundary.length + 2, headEnd = latin.indexOf('\r\n\r\n', start);
  if (latin.slice(first + boundary.length, start) !== '\r\n' || headEnd < 0 || headEnd > second) return null;
  const head = latin.slice(start, headEnd).split('\r\n');
  const field = (n) => head.find((l) => l.toLowerCase().startsWith(`${n}:`))?.slice(n.length + 1).trim();
  const disposition = field('content-disposition') ?? '', type = field('content-type');
  if (!/^form-data\b/i.test(disposition) || !/;\s*name\s*=\s*(?:"file"|file)\s*(?:;|$)/i.test(disposition) || !type) return null;
  return { bytes: bytes.slice(headEnd + 4, second), type, filename: dispositionFilename(disposition) };
}
// 5.1: does a media type match one of the declared ranges (* matches any subtype, */* any type)?
const mediaRangeMatch = (ranges, type) => typeof type === 'string' && ranges.some((r) => {
  const [a, b] = r.toLowerCase().split('/'), [x, y] = type.toLowerCase().split(';')[0].trim().split('/');
  return (a === '*' || a === x) && (b === '*' || b === y);
});
// 3 (RFC 7493, 2.3): the pointer of the first member name repeated in an object of a valid JSON text, or null.
function duplicateMember(raw) {
  const stack = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      let j = i + 1;
      while (raw[j] !== '"') j += raw[j] === '\\' ? 2 : 1;
      const top = stack.at(-1);
      if (top?.object && top.expectKey) {
        const k = JSON.parse(raw.slice(i, j + 1));
        if (top.keys.has(k)) return [...stack.slice(0, -1).map((x) => x.at), k].map(ptr).join('');
        top.keys.add(k); top.expectKey = false; top.at = k;
      }
      i = j;
    } else if (ch === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
    else if (ch === '[') stack.push({ object: false, at: 0 });
    else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === ',') { const top = stack.at(-1); if (top?.object) top.expectKey = true; else if (top) top.at++; }
  }
  return null;
}
// 3 (RFC 7493, 2.1): format entries for strings, member names included, with unpaired surrogates or noncharacters.
// The pointer is the string that holds it, or "" when that string is a member name: a pointer to it would have to
// contain the same code point.
function badCharacters(v, at = '') {
  const bad = (str) => { for (const ch of str) { const cp = ch.codePointAt(0);
    if ((cp >= 0xd800 && cp <= 0xdfff) || (cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe) return true; } return false; };
  const entry = (pointer) => ({ pointer, code: 'format', detail: t('An unpaired surrogate or a noncharacter.', 'Un sustituto suelto o un no carácter.') });
  if (typeof v === 'string') return bad(v) ? [entry(at)] : [];
  if (Array.isArray(v)) return v.flatMap((x, i) => badCharacters(x, `${at}/${i}`));
  if (isObject(v)) return Object.entries(v).flatMap(([k, x]) => (bad(k) ? [entry('')] : badCharacters(x, at + ptr(k))));
  return [];
}
const ptr = (f) => `/${String(f).replace(/~/g, '~0').replace(/\//g, '~1')}`;
const sfString = (s) => `"${s.replace(/[\\"]/g, '\\$&')}"`;
const tags = (h) => (h ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const strongMatch = (h, tag) => tags(h).some((x) => x === '*' || (!x.startsWith('W/') && x === tag));
const weakMatch = (h, tag) => tags(h).some((x) => x === '*' || x.replace(/^W\//, '') === tag);
// 3: the type of a body, case-insensitive. charset can only be utf-8, quoted or not and
// in any case; the other parameters are ignored. Without Content-Type, not even an empty one, it is not valid.
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
// RFC 7396, section 2
export function mergePatch(target, patch) {
  if (!isObject(patch)) return patch;
  const out = isObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) { if (v === null) delete out[k]; else out[k] = mergePatch(out[k], v); }
  return out;
}

// ── Configuration ─────────────────────────────────────────────────────────────
function configError(msg) { return new Error(`restep-server: ${msg}`); }
function normalizeField(name, f, cname) {
  const d = typeof f === 'string' ? { type: f } : { ...f };
  if (![...SCALARS, 'map', 'relation', 'list', 'localized'].includes(d.type)) throw configError(`${cname}.fields.${name}: unknown type ${d.type}`);
  if (d.type === 'enum' && (!Array.isArray(d.values) || !d.values.length)) throw configError(`${cname}.fields.${name}: an enum needs values`);
  if (d.type === 'relation' && typeof d.to !== 'string') throw configError(`${cname}.fields.${name}: a relation needs to`);
  // 3: a list of scalars, such as formats: { type: 'list', items: 'string' }.
  if (d.type === 'list' && (!SCALARS.includes(d.items) || d.items === 'enum' && (!Array.isArray(d.values) || !d.values.length)))
    throw configError(`${cname}.fields.${name}: a list needs items, a scalar type (and values for an enum)`);
  if (d.many !== undefined && (d.type !== 'relation' || typeof d.many !== 'boolean')) throw configError(`${cname}.fields.${name}: many is true or false, on a relation`);
  // 3: a localized field is the text of a language map of the same item (its source) in the language of the response.
  if (d.type === 'localized' && typeof d.source !== 'string') throw configError(`${cname}.fields.${name}: a localized field needs source, a language map of the same item`);
  // 5.1: readOnly: a field only the server sets (created_at, a total).
  if (d.readOnly !== undefined && (typeof d.readOnly !== 'boolean' || ['map', 'localized'].includes(d.type))) throw configError(`${cname}.fields.${name}: readOnly is true or false, and not on a language map or a localized field`);
  // 5.1: media_types on a relation to a collection that declares upload.
  if (d.mediaTypes !== undefined && (d.type !== 'relation' || !Array.isArray(d.mediaTypes) || !d.mediaTypes.length || !d.mediaTypes.every((m) => MEDIA_RANGE.test(m))))
    throw configError(`${cname}.fields.${name}: mediaTypes is a list of media ranges such as image/* or application/pdf, on a relation`);
  // 3: fields are declared in the discovery schemas, so they follow the name grammar.
  if (!NAME.test(name)) throw configError(`${cname}.fields.${name}: a field follows the name grammar (3): a letter and up to 63 letters, digits, _ or -`);
  // 4.3: default only on scalars; that of an enum, one of its values. labels: the label of each enum value.
  if ('default' in d && !SCALARS.includes(d.type)) throw configError(`${cname}.fields.${name}: default only on scalar fields`);
  if ('default' in d && d.readOnly) throw configError(`${cname}.fields.${name}: a readOnly field takes no default from the client`);
  if ('default' in d && d.type === 'enum' && !d.values.includes(d.default)) throw configError(`${cname}.fields.${name}: default must be one of values`);
  if (d.labels !== undefined && (d.type !== 'enum' || typeof d.labels !== 'object' || d.values.some((v) => d.labels[v] == null)))
    throw configError(`${cname}.fields.${name}: labels is for an enum and has one label per value`);
  if (d.examples !== undefined && !Array.isArray(d.examples)) throw configError(`${cname}.fields.${name}: examples is a list`);
  return d;
}
// 5.1: a media range: type/subtype, type/* or */*.
const MEDIA_RANGE = /^(\*\/\*|[a-z0-9][a-z0-9!#$&^_.+-]*\/(\*|[a-z0-9][a-z0-9!#$&^_.+-]*))$/i;
const FIXED_PATH = /^(\/(?!\.\.?(?:\/|$))[A-Za-z0-9\-._~]+)+$/; // a fixed path, no templates, no trailing "/" or dot segments
// 4.3 and 11.1: { METHOD: [effects] } for the unsafe methods a collection or its items support.
function normalizeEffects(where, value, methods) {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw configError(`${where}: an object { METHOD: [effects] }`);
  for (const [m, list] of Object.entries(value)) {
    if (!methods.includes(m) || m === 'GET') throw configError(`${where}.${m}: not an unsafe method this resource supports (${methods.filter((x) => x !== 'GET').join(', ') || 'none'})`);
    if (!Array.isArray(list) || new Set(list).size !== list.length || list.some((e) => !EFFECTS.includes(e)))
      throw configError(`${where}.${m}: a list without repeats of ${EFFECTS.join(', ')}`);
  }
  return Object.keys(value).length ? value : undefined;
}
// 11.1: the declared parameters of a GET action, such as the form a new action prepares.
function normalizeParams(where, value) {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw configError(`${where}: an object { name: { type, values, list, required, description } }`);
  const out = {};
  for (const [p, d] of Object.entries(value)) {
    if (!NAME.test(p) || isReserved(p)) throw configError(`${where}.${p}: a parameter follows the name grammar (3) and is not reserved (5.3)`);
    if (!isObject(d) || !SCALARS.includes(d.type)) throw configError(`${where}.${p}: needs a type from 4.2`);
    if (d.type === 'enum' && (!Array.isArray(d.values) || !d.values.length)) throw configError(`${where}.${p}: an enum needs values`);
    out[p] = { type: d.type, values: d.values, list: !!d.list, required: !!d.required, description: d.description };
  }
  return out;
}
function normalizeCollection(name, def) {
  if (!NAME.test(name)) throw configError(`${name}: a collection name follows the name grammar (3)`);
  if (!def.data || typeof def.data.get !== 'function' || (def.data.list !== undefined && typeof def.data.list !== 'function'))
    throw configError(`${name}: data must be an adapter with get and, to list the collection, list (for example memoryAdapter([...]))`);
  const fields = { id: { type: 'string' } };
  for (const [f, d] of Object.entries(def.fields ?? {})) if (f !== 'id') fields[f] = normalizeField(f, d, name);
  const listable = typeof def.data.list === 'function';
  const c = {
    name, path: def.path ?? `/${name}`, description: def.description, fields, data: def.data,
    filter: {}, namedFilters: {}, sort: def.sort ?? [], defaultSort: def.defaultSort ?? ['id'],
    maxLimit: def.maxLimit ?? 50, defaultLimit: def.defaultLimit ?? 20, count: def.count,
    validate: def.validate, newItem: def.newItem, requireIfMatch: !!def.requireIfMatch, requireIdempotencyKey: !!def.requireIdempotencyKey,
    idFrom: def.idFrom, idPattern: def.idPattern, collations: def.collations,
    reusableIds: !!def.reusableIds, upsert: !!def.upsert,
    // 4.3: a collection without GET cannot be listed (its adapter has no list).
    methods: [...(listable ? ['GET'] : []), ...(def.data.create || def.upload ? ['POST'] : [])],
    itemMethods: ['GET', ...(def.data.update ? ['PATCH'] : []), ...(def.data.delete ? ['DELETE'] : [])],
  };
  if (!FIXED_PATH.test(c.path)) throw configError(`${name}: path must be a fixed path such as /books (no templates: this library does not do subcollections)`);
  // 5.1: who picks the id. "client" and "either" need to know which ids the collection has had (taken).
  if (c.idFrom !== undefined) {
    if (!['server', 'client', 'either'].includes(c.idFrom)) throw configError(`${name}.idFrom: "server", "client" or "either"`);
    if (c.idFrom !== 'server' && (typeof def.data.taken !== 'function' || !def.data.create))
      throw configError(`${name}.idFrom: "${c.idFrom}" needs an adapter with create and taken(id, ctx), which says whether the collection has or had that id (5.1)`);
  }
  if (c.idPattern !== undefined && (c.idFrom ?? 'server') === 'server') throw configError(`${name}.idPattern: only with idFrom "client" or "either"`);
  if (c.idPattern !== undefined) { try { c.idRegExp = new RegExp(c.idPattern, 'u'); } catch { throw configError(`${name}.idPattern: not a regular expression`); } }
  // 5.1: reusable_ids only with id_from "client"; upsert with "client" or "either", and PATCH.
  if (def.reusableIds !== undefined && typeof def.reusableIds !== 'boolean') throw configError(`${name}.reusableIds: true or false`);
  if (c.reusableIds && c.idFrom !== 'client') throw configError(`${name}.reusableIds: only with idFrom "client" (5.1)`);
  if (def.upsert !== undefined && typeof def.upsert !== 'boolean') throw configError(`${name}.upsert: true or false`);
  if (c.upsert && !(['client', 'either'].includes(c.idFrom) && def.data.update && def.data.create))
    throw configError(`${name}.upsert: needs idFrom "client" or "either" and an adapter with create and update (5.1)`);
  // 7.2: upsert with requireIfMatch is allowed: If-None-Match: * on a PATCH meets the requirement.
  // 5.1: upload, a POST that carries the bytes of a file; the adapter's upload(file, ctx) creates the item.
  if (def.upload !== undefined) {
    const u = def.upload;
    if (!isObject(u) || !Array.isArray(u.mediaTypes) || !u.mediaTypes.length || !u.mediaTypes.every((m) => MEDIA_RANGE.test(m)))
      throw configError(`${name}.upload: { mediaTypes: ['image/*', ...], maxSize, multipart }`);
    if (u.maxSize !== undefined && !(Number.isSafeInteger(u.maxSize) && u.maxSize >= 1)) throw configError(`${name}.upload.maxSize: a number of bytes, at least 1`);
    if (u.multipart !== undefined && typeof u.multipart !== 'boolean') throw configError(`${name}.upload.multipart: true or false`);
    if (typeof def.data.upload !== 'function') throw configError(`${name}.upload: needs an adapter with upload(file, ctx), which creates the item and gives it _content`);
    c.upload = { mediaTypes: u.mediaTypes.map((m) => m.toLowerCase()), maxSize: u.maxSize, multipart: !!u.multipart };
    // 5.1: in a collection that also creates from JSON, a POST with application/json is always an item, so a JSON
    // file can only come as the file part of multipart/form-data: mediaTypes that admit application/json (also
    // through a wildcard) need multipart.
    if (typeof def.data.create === 'function' && mediaRangeMatch(c.upload.mediaTypes, 'application/json') && !c.upload.multipart)
      throw configError(`${name}.upload: creates items from JSON and its mediaTypes admit application/json, so it needs multipart: true (5.1)`);
  }
  c.methodEffects = normalizeEffects(`${name}.methodEffects`, def.methodEffects, c.methods);
  c.itemMethodEffects = normalizeEffects(`${name}.itemMethodEffects`, def.itemMethodEffects, c.itemMethods);
  // 3 and 6.1: what a path names. type: the type a filter compares; many: a path through a to-many
  // relationship ({ group, kind: 'relation', sub }) or a list field ({ group, kind: 'list' }).
  c.pathInfo = (p) => {
    const dot = p.indexOf('.');
    const d = fields[dot < 0 ? p : p.slice(0, dot)];
    if (!d) return null;
    if (dot < 0) {
      if (d.type === 'list') return { type: d.items, many: { group: p, kind: 'list' } };
      if (d.type === 'relation' && d.many) return { type: 'string', many: { group: p, kind: 'relation' }, whole: true };
      if (d.type === 'localized') return { type: 'string', localized: d.source };
      return d.type === 'map' || d.type === 'relation' ? null : { type: d.type };
    }
    const b = p.slice(dot + 1);
    if (d.type === 'map' && LANGUAGE_TAG.test(b)) return { type: 'string' };
    if (d.type === 'relation' && b === 'id') return d.many ? { type: 'string', many: { group: p.slice(0, dot), kind: 'relation', sub: 'id' } } : { type: 'string' };
    return null;
  };
  c.typeOf = (p) => c.pathInfo(p)?.type;
  for (const f of Object.keys(fields)) if (fields[f].type === 'localized' && fields[fields[f].source]?.type !== 'map')
    throw configError(`${name}.fields.${f}: source ${fields[f].source} is not a language map of this collection (3)`);
  if (!listable && (def.filter || def.namedFilters || def.sort || def.count))
    throw configError(`${name}: a collection without list (no GET) declares no filter, namedFilters, sort or count (4.3)`);
  for (const [f, d] of Object.entries(def.filter ?? {})) {
    const ops = Array.isArray(d) ? d : d.ops;
    const info = c.pathInfo(f);
    const type = info?.type;
    if (!type) throw configError(`${name}.filter.${f}: not a scalar field, a translation (field.tag), relation.id, a localized field or a list`);
    if (!Array.isArray(ops) || !ops.length) throw configError(`${name}.filter.${f}: needs a list of operators`);
    for (const op of ops) if (!OPS.includes(op)) throw configError(`${name}.filter.${f}: unknown operator ${op} (6.1 lists ${OPS.join(', ')})`);
    if (type === 'boolean' && ops.some((o) => !['eq', 'ne', 'null'].includes(o))) throw configError(`${name}.filter.${f}: a boolean only supports eq, ne and null (6.1)`);
    if (f === 'id' && ops.some((o) => ['lt', 'le', 'gt', 'ge'].includes(o))) throw configError(`${name}.filter.id: id order belongs to the server; no lt, le, gt or ge (6.1)`);
    // 6.1: prefix and contains only on string fields and translations, never on id.
    if (ops.some((o) => o === 'prefix' || o === 'contains') && (type !== 'string' || f === 'id' || info.many || /\.id$/.test(f)))
      throw configError(`${name}.filter.${f}: prefix and contains only on string fields and translations, never on id (6.1)`);
    const quantifier = Array.isArray(d) ? undefined : d.quantifier;
    if (quantifier !== undefined && quantifier !== 'some') throw configError(`${name}.filter.${f}: quantifier is "some" (6.1)`);
    // 6.1: the to-many relationship or the list field itself, with null as its only operator, may omit quantifier
    // or declare "some": both select the same (and it has the type of the related items' id, string, or of the elements).
    const nullOnly = info.many && !f.includes('.') && ops.every((o) => o === 'null');
    if (info.many && !nullOnly && quantifier !== 'some') throw configError(`${name}.filter.${f}: a path through a to-many relationship or a list field needs quantifier: "some" (6.1)`);
    if (!info.many && quantifier) throw configError(`${name}.filter.${f}: quantifier only on a path through a to-many relationship or a list field (6.1)`);
    if (info.many && ops.some((o) => o === 'ne' || o === 'nin')) throw configError(`${name}.filter.${f}: no ne or nin with quantifier; ask null on the group (6.1)`);
    if (info.whole && ops.some((o) => o !== 'null')) throw configError(`${name}.filter.${f}: the to-many relationship itself declares only null (6.1)`);
    const required = Array.isArray(d) ? false : !!d.required;
    c.filter[f] = { ops, type, description: Array.isArray(d) ? undefined : d.description, required, quantifier, info };
  }
  // 6.1: named filters. Without type, a switch; with type, they carry a value of that type.
  for (const [f, d] of Object.entries(def.namedFilters ?? {})) {
    if (!d || typeof d !== 'object' || !d.description) throw configError(`${name}.namedFilters.${f}: needs description, which says which items it returns`);
    if (!NAME.test(f)) throw configError(`${name}.namedFilters.${f}: a named filter follows the name grammar (3)`);
    if (Object.hasOwn(c.filter, f)) throw configError(`${name}.namedFilters.${f}: already a key of filter (6.1)`);
    if (d.type !== undefined && !SCALARS.includes(d.type)) throw configError(`${name}.namedFilters.${f}: unknown type ${d.type}`);
    if (d.type === 'enum' && (!Array.isArray(d.values) || !d.values.length)) throw configError(`${name}.namedFilters.${f}: an enum needs values`);
    if (d.apply !== undefined && typeof d.apply !== 'function') throw configError(`${name}.namedFilters.${f}: apply must be a function (row, value) => boolean`);
    // 6.1: default, only on a switch: it applies unless the request turns it off with filter[name]=false.
    if (d.default !== undefined && (d.default !== true || d.type !== undefined)) throw configError(`${name}.namedFilters.${f}: default is true, and only on a switch (a named filter without type) (6.1)`);
    if (d.required !== undefined && typeof d.required !== 'boolean') throw configError(`${name}.namedFilters.${f}: required is true or false`);
    c.namedFilters[f] = { type: d.type, values: d.values, description: d.description, apply: d.apply, default: !!d.default, required: !!d.required };
  }
  for (const s of [...c.sort, ...c.defaultSort.map((x) => x.replace(/^-/, ''))]) {
    const info = c.pathInfo(s);
    if (!info) throw configError(`${name}.sort: ${s} is not a scalar field or a translation`);
    // 6.2: a to-many path sorts only if filter declares it with quantifier.
    if (info.many && (info.whole || c.filter[s]?.quantifier !== 'some')) throw configError(`${name}.sort: ${s} goes through a to-many relationship or is a list; declare it in filter with quantifier first (6.2)`);
  }
  // 6.1: collations, per text field (or translation field.tag) declared in filter or in sort; never id.
  if (c.collations !== undefined) {
    if (!isObject(c.collations)) throw configError(`${name}.collations: an object { field: "codepoint" | "server" }`);
    for (const [f, v] of Object.entries(c.collations)) {
      if (!COLLATIONS.includes(v)) throw configError(`${name}.collations.${f}: "codepoint" or "server"`);
      const info = c.pathInfo(f);
      const ok = f !== 'id' && info && !info.many && (info.localized
        || info.type === 'string' && Object.hasOwn(c.filter, f) || ['string', 'enum'].includes(info.type) && c.sort.includes(f));
      if (!ok) throw configError(`${name}.collations.${f}: must be a string field (or field.tag) declared in filter, a sort key that holds strings or a localized field, and not id`);
    }
  }
  c.collationOf = (f) => c.collations?.[f] ?? 'codepoint';
  if (c.count && !['exact', 'estimated'].includes(c.count)) throw configError(`${name}.count: "exact" or "estimated"`);
  if (c.newItem !== undefined && (typeof c.newItem !== 'function' || !def.data.create)) throw configError(`${name}.newItem: a function (ctx) => body, on a collection that supports POST`);
  c.newParams = normalizeParams(`${name}.newParams`, def.newParams);
  c.newSchema = def.newSchema;
  if (c.newSchema !== undefined && (typeof c.newSchema !== 'function' || !c.newItem)) throw configError(`${name}.newSchema: a function (ctx, createSchema) => schema, only with newItem`);
  if (c.newParams && !c.newItem) throw configError(`${name}.newParams: only with newItem`);
  c.localized = Object.keys(fields).filter((f) => fields[f].type === 'localized');
  return c;
}
// 4.2 and 5.9: a path template's variables are simple expressions with distinct names.
const VARIABLE = /^\{([A-Za-z][A-Za-z0-9_]*)\}$/;
const LITERAL = /^(?!\.\.?$)[A-Za-z0-9\-._~]+$/;
// 5.9: a singleton, like /me: an item with no id or collection. Its adapter has get(ctx) and, for PATCH, update(data, ctx).
// With parent, it hangs from an item (its path a template, /readers/{reader_id}/settings) or from another singleton.
function normalizeSingleton(name, def) {
  if (!NAME.test(name)) throw configError(`singletons.${name}: the name follows the name grammar (3)`);
  if (!def?.data || typeof def.data.get !== 'function') throw configError(`singletons.${name}: data must be an adapter with get(ctx) and, if it supports PATCH, update(data, ctx)`);
  const path = def.path ?? `/${name}`;
  if (def.parent === undefined && !FIXED_PATH.test(path)) throw configError(`singletons.${name}: path must be a fixed path such as /me (a template only with parent, 5.9)`);
  if (def.parent !== undefined && (typeof def.parent !== 'string' || !path.startsWith('/') || !path.slice(1).split('/').every((x) => VARIABLE.test(x) || LITERAL.test(x))))
    throw configError(`singletons.${name}: parent is the name of a collection or a singleton, and path a template such as /readers/{reader_id}/settings`);
  const fields = {};
  for (const [f, d] of Object.entries(def.fields ?? {})) {
    if (f === 'id') throw configError(`singletons.${name}.fields.id: this library does not give a singleton an id`);
    fields[f] = normalizeField(f, d, `singletons.${name}`);
    if (['map', 'localized'].includes(fields[f].type)) throw configError(`singletons.${name}.fields.${f}: language maps in a singleton are outside Restep 1 (5.9)`);
  }
  const methods = ['GET', ...(def.data.update ? ['PATCH'] : [])];
  // 4.3 and 5.9: a singleton MAY declare the effects of its PATCH; undeclared, it counts as all three.
  const methodEffects = normalizeEffects(`singletons.${name}.methodEffects`, def.methodEffects, methods);
  return { name, singleton: true, path, parent: def.parent, description: def.description, fields, data: def.data, validate: def.validate,
    requireIfMatch: !!def.requireIfMatch, methods, methodEffects };
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
  if (typeof idempotencyAnonymous !== 'boolean') throw configError('idempotencyAnonymous: true or false (7.1)');
  if (![true, false, 'auto'].includes(browserCredentials) && typeof browserCredentials !== 'function')
    throw configError('browserCredentials: "auto", true, false or a function (request) => boolean (5.8)');
  const base = rawBase.replace(/\/$/, '');
  if (base && !/^\/[^?#]*$/.test(base)) throw configError('base must start with / (such as "/api")');
  if (!languages.length || languages.some((l) => !LIBRARY_LANGUAGES.includes(l))) throw configError(`languages: only ${LIBRARY_LANGUAGES.join(', ')}`);
  if (idempotencyTtl < DAY) throw configError('idempotencyTtl: at least 86400 seconds (7.1)');
  if (oauth && (!Array.isArray(oauth.authorizationServers) || !oauth.authorizationServers.length || typeof oauth.verifyToken !== 'function'))
    throw configError('oauth needs authorizationServers (at least one) and verifyToken(token, request)');
  const colls = Object.fromEntries(Object.entries(defs).map(([n, d]) => [n, normalizeCollection(n, d)]));
  const singles = Object.fromEntries(Object.entries(singletonDefs).map(([n, d]) => [n, normalizeSingleton(n, d)]));
  for (const c of [...Object.values(colls), ...Object.values(singles)]) for (const [f, d] of Object.entries(c.fields)) {
    if (d.type === 'relation' && !colls[d.to]) throw configError(`${c.singleton ? 'singletons.' : ''}${c.name}.fields.${f}: collection ${d.to} does not exist`);
    if (d.mediaTypes && !colls[d.to].upload) throw configError(`${c.singleton ? 'singletons.' : ''}${c.name}.fields.${f}: mediaTypes only on a relation to a collection that declares upload (5.1)`);
  }
  // 5.9: a singleton with parent: its path is the parent's item path, or the parent singleton's path, followed
  // by / and one or more literal segments; its variables take in order the ids of the parent items.
  for (const s of Object.values(singles)) {
    const segs = s.path.slice(1).split('/');
    if (s.parent === undefined) { s.segments = segs; continue; }
    const pc = colls[s.parent], ps = singles[s.parent];
    if (!pc && (!ps || ps === s)) throw configError(`singletons.${s.name}.parent: ${s.parent} is not a collection or another singleton`);
    let prefix;
    if (pc) prefix = [...pc.path.slice(1).split('/'), null]; // null: a variable
    else {
      for (let at = ps, hops = 0; at.parent !== undefined; at = singles[at.parent] ?? colls[at.parent], hops++)
        if (at === s || hops > 32 || !at) throw configError(`singletons.${s.name}.parent: a cycle of parents`);
      prefix = ps.path.slice(1).split('/').map((x) => (VARIABLE.test(x) ? null : x));
    }
    const ok = segs.length > prefix.length && prefix.every((x, i) => (x === null ? VARIABLE.test(segs[i]) : segs[i] === x))
      && segs.slice(prefix.length).every((x) => LITERAL.test(x));
    const vars = segs.filter((x) => VARIABLE.test(x)).map((x) => VARIABLE.exec(x)[1]);
    if (!ok || new Set(vars).size !== vars.length)
      throw configError(`singletons.${s.name}: path must be ${pc ? `${pc.path}/{variable}` : ps.path} followed by / and literal segments, with variables of distinct names (5.9, 4.2)`);
    s.segments = segs;
  }
  // 5.9: a singleton's path is not one that a collection or one of its items has or could have.
  const shape = (segs) => segs.map((x) => (VARIABLE.test(x) ? '{}' : x));
  const sameShape = (a, b) => a.length === b.length && a.every((x, i) => x === b[i] || x === '{}' || b[i] === '{}');
  for (const s of Object.values(singles)) {
    const mine = shape(s.segments);
    const clash = Object.values(colls).find((c) => { const cs = c.path.slice(1).split('/'); return sameShape(mine, cs) || sameShape(mine, [...cs, '{}']); })
      ?? Object.values(singles).find((o) => o !== s && sameShape(mine, shape(o.segments)));
    if (clash) throw configError(`singletons.${s.name}: path ${s.path} clashes with ${clash.singleton ? 'singleton' : 'collection'} ${clash.name}`);
  }
  const writable = Object.values(colls).some((c) => c.methods.includes('POST') || c.itemMethods.length > 1)
    || Object.values(singles).some((s) => s.methods.length > 1);
  // cache (8) only asks for core: Cache-Control on every read, the item ETag, 304 and Cache-Groups, which the library always gives.
  const profiles = ['core', 'query', ...(writable ? ['writes'] : []), 'cache'];
  // actions (11.1): only the new action, on collections with newItem.
  const extensions = [...(Object.values(colls).some((c) => c.newItem) ? ['actions'] : []), ...(oauth ? ['oauth'] : [])];
  // 4.1: a single profile link, to the version URI; what is implemented is told by the discovery.
  const profileLink = `<${PROFILE}>; rel="profile"`;
  // API documentation (4.2, SHOULD): rel="service-doc" in the discovery response.
  // docs: a URL or a list of { href, hreflang, title }.
  const docsList = docs == null ? [] : (Array.isArray(docs) ? docs : [docs]).map((d) => (typeof d === 'string' ? { href: d } : d));
  if (docsList.some((d) => typeof d.href !== 'string' || !/^https?:\/\//.test(d.href))) throw configError('docs: an absolute URL or a list of { href, hreflang, title }');
  const docsLink = docsList.map((d) => `<${d.href}>; rel="service-doc"${d.hreflang ? `; hreflang="${d.hreflang}"` : ''}${d.title ? `; title="${d.title.replace(/"/g, "'")}"` : ''}`).join(', ');
  const statusPath = status ? `${base}${status.path ?? '/health'}` : null;
  const languageList = [...languages];
  const isMap = (c, f) => c.fields[f]?.type === 'map';
  const maps = (c) => Object.keys(c.fields).filter((f) => isMap(c, f));
  const relations = (c) => Object.keys(c.fields).filter((f) => c.fields[f].type === 'relation');
  const hasLocalized = Object.values(colls).some((c) => c.localized.length);

  // Cursor signing (6.4): HMAC with a fixed key if secret is given; otherwise a random one per process.
  const keyPromise = webcrypto.subtle.importKey('raw', typeof secret === 'string' ? enc.encode(secret) : secret ?? webcrypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sign = async (s) => b64u(new Uint8Array(await webcrypto.subtle.sign('HMAC', await keyPromise, enc.encode(s)))).slice(0, 27);

  // ── Responses ──
  const cacheControl = (ctx, cc) => (ctx.principal != null && !cc.includes('no-store') ? `private, ${cc.replace(/^public, /, '')}` : cc);
  function respond(ctx, status, data, headers = {}) {
    const body = data === undefined || status === 204 || status === 304 ? null : JSON.stringify(data);
    const h = new Headers({ Link: profileLink, ...headers });
    if (body !== null) h.set('Content-Type', status >= 400 ? 'application/problem+json' : 'application/json');
    // 5.1 and 5.4: a response that depends on credentials, or that no cache may store, carries no field
    // aimed at shared caches (RFC 9213), which would let one store it.
    const cc = h.get('cache-control') ?? '';
    if (ctx.principal != null || /\b(private|no-store)\b/.test(cc)) for (const k of [...h.keys()]) if (SHARED_CACHE_FIELD.test(k)) h.delete(k);
    return new Response(ctx.method === 'HEAD' ? null : body, { status, headers: h });
  }
  function problem(ctx, e) {
    const lang = ctx.lang;
    const extra = e.extra.errors ? { ...e.extra, errors: e.extra.errors.map((x) => ({ ...x, ...(x.detail != null && { detail: text(x.detail, lang) }) })) } : e.extra;
    const body = { type: `${PROFILE}errors#${e.code}`, title: text(TITLES[e.status] ?? 'Error', lang), status: e.status, code: e.code,
      ...(e.detail != null && { detail: text(e.detail, lang) }), ...extra };
    // 5.4: every problem is no-store (428, 429, 431 and 511 must be), whatever the adapter's headers say.
    const own = Object.fromEntries(Object.entries(e.headers).filter(([k]) => k.toLowerCase() !== 'cache-control'));
    const headers = { 'Cache-Control': 'no-store', Vary: 'Accept-Language', 'Content-Language': lang, ...own };
    if (e.status === 401 && !Object.keys(e.headers).some((k) => k.toLowerCase() === 'www-authenticate')) headers['WWW-Authenticate'] = 'Bearer realm="restep"';
    return respond(ctx, e.status, body, headers);
  }

  // ── Representations ──
  // Only the declared fields (plus id and the _ members the adapter gives); a language map without
  // translations is {} (3); a relation that arrives as a bare id becomes { id } (3).
  // A singleton has no id, and each relation carries href, because it does not declare relations (5.9).
  // A localized field is the text of its source in the response language (3, 5.6); instants, local
  // date-times and durations are written in uppercase (3). What else counts towards the item ETag
  // without being in the representation (the language of localized fields, the adapter's _incarnation
  // for reusable ids) goes in a hidden property, read by itemTag.
  function represent(c, raw, lang) {
    const out = c.singleton ? {} : { id: String(raw.id) };
    const relation = (d, v) => {
      if (typeof v === 'string' || typeof v === 'number') v = { id: String(v) };
      if (!isObject(v)) return v;
      return c.singleton ? { id: String(v.id), href: itemPath(colls[d.to], String(v.id)) } : { id: String(v.id) };
    };
    const upper = (type, v) => (typeof v === 'string' && ['datetime', 'localdatetime', 'duration'].includes(type) ? v.toUpperCase() : v);
    for (const [f, d] of Object.entries(c.fields)) {
      if (f === 'id') continue;
      let v = raw[f];
      if (d.type === 'map') v = isObject(v) ? v : {};
      else if (d.type === 'localized') v = localizedText(raw[d.source], lang);
      else if (d.type === 'relation') v = d.many ? (Array.isArray(v) ? v.filter((x) => x != null).map((x) => relation(d, x)) : v == null ? [] : v) : relation(d, v);
      else if (d.type === 'list') v = Array.isArray(v) ? v.map((x) => upper(d.items, x)) : v;
      else v = upper(d.type, v);
      if (v !== undefined) out[f] = v;
    }
    for (const [k, v] of Object.entries(raw)) if (k.startsWith('_') && k !== '_etag' && k !== '_incarnation') out[k] = v;
    const basis = { ...(raw._incarnation !== undefined && { incarnation: raw._incarnation }), ...(c.localized?.length && { lang }) };
    if (Object.keys(basis).length) Object.defineProperty(out, BASIS, { value: basis });
    return out;
  }
  // 3: a localized field takes its source's text in the response language or, where the map lacks it,
  // that of a regional variant (MAY fill); otherwise null.
  function localizedText(map, lang) {
    if (!isObject(map)) return null;
    if (typeof map[lang] === 'string') return map[lang];
    const k = Object.keys(map).find((x) => x.startsWith(`${lang}-`) && typeof map[x] === 'string');
    return k === undefined ? null : map[k];
  }
  // 7.2: the item ETag, of the full representation without _etag; it differs by language where the item has
  // localized fields, and between incarnations of a reusable id.
  const itemTag = (row) => etagOf(row[BASIS] ? [row, row[BASIS]] : row);
  const pick = (row, fields) => {
    if (!fields) return row;
    const out = 'id' in row ? { id: row.id } : {};
    for (const f of fields) if (f in row) out[f] = row[f];
    for (const [k, v] of Object.entries(row)) if (k.startsWith('_')) out[k] = v;
    return out;
  };
  const itemPath = (c, id) => (c.singleton ? `${base}${c.path}` : `${base}${c.path}/${id}`);
  // 7.2: with writes, every response whose body is an item carries in _etag the item ETag, computed without _etag.
  const withEtag = async (row) => (writable ? { ...row, _etag: await itemTag(row) } : row);
  const groups = (paths) => paths.slice(0, 32).map(sfString).join(', ');

  // ── Discovery (4.2) and schemas (4.3) ──
  function schemas(c, lang) {
    const DEC = t('A decimal in a string, such as "18.50".', 'Un decimal en una cadena, como "18.50".');
    const scalar = (type, values) => (type === 'decimal' ? { type: 'string', pattern: DECIMAL.source, description: text(DEC, lang) }
      : type === 'enum' ? { type: 'string', enum: values }
      : type === 'date' ? { type: 'string', format: 'date' }
      : type === 'datetime' ? { type: 'string', format: 'date-time' }
      : type === 'localdatetime' ? { type: 'string', pattern: LOCALDATETIME.source }
      : type === 'duration' ? { type: 'string', format: 'duration' }
      : type === 'timezone' ? { type: 'string' }
      : { type });
    const json = (f, kind) => {
      const d = c.fields[f];
      const rel = { type: 'object', required: ['id'], properties: { id: { type: 'string' }, ...(c.singleton && { href: { type: 'string' } }) } };
      const s = d.type === 'map' ? { type: 'object', propertyNames: { pattern: LANGUAGE_TAG.source },
          additionalProperties: { type: kind === 'update' ? ['string', 'null'] : 'string' },
          description: text(t('Translations, by language tag in lowercase, such as {"en": "…", "es-mx": "…"}.',
            'Traducciones, por etiqueta de idioma en minúsculas, como {"en": "…", "es-mx": "…"}.'), lang) }
        : d.type === 'relation' ? (d.many ? { type: 'array', items: rel } : rel)
        : d.type === 'list' ? { type: 'array', items: scalar(d.items, d.values) }
        : d.type === 'localized' ? { type: 'string' }
        : scalar(d.type, d.values);
      // An enum with labels: the options with their label, for a form (4.3).
      if (d.type === 'enum' && d.labels) { delete s.enum; s.oneOf = d.values.map((v) => ({ const: v, title: text(d.labels[v], lang) })); }
      const nullable = d.type === 'map' ? kind === 'update' : !d.required && !(d.type === 'relation' && d.many && kind === 'item');
      const out = nullable ? { anyOf: [s, { type: 'null' }] } : s;
      // 5.1: a localized field, or one only the server sets, is read-only (only in item, below).
      if (d.type === 'localized' || d.readOnly) out.readOnly = true;
      // A form's annotations go on the property, outside the anyOf (4.3). default, only in create.
      if (d.title) out.title = text(d.title, lang);
      if (d.description) out.description = text(d.description, lang);
      if (kind === 'create' && 'default' in d) out.default = d.default;
      if (d.examples) out.examples = d.examples;
      return out;
    };
    const names = Object.keys(c.fields).filter((f) => f !== 'id');
    // 4.3: the read-only fields that 5.1 ignores are dropped before validating create and update, so they are not there.
    const writes = (f) => c.fields[f].type !== 'localized' && !c.fields[f].readOnly;
    const props = (kind) => Object.fromEntries(names.filter((f) => kind === 'item' || writes(f)).map((f) => [f, json(f, kind)]));
    const required = names.filter((f) => c.fields[f].required);
    const requiredCreate = required.filter((f) => writes(f) && !('default' in c.fields[f])); // with a default, the POST may omit it
    const reserved = { '^_': {} };
    const ID_SOURCE = '^(?!\\.\\.?$)[A-Za-z0-9._~-]+$';
    // 5.1: with id_from "client" or "either", create accepts an id (and with "client" requires it), in the format idPattern restricts.
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
      // 5.1: a collection that only takes uploads (no data.create) has no JSON body to describe, so no create schema;
      // restep-check and the mock read its absence as "does not create items from JSON".
      ...(c.methods.includes('POST') && c.data.create && { create: { type: 'object', required: [...(c.idFrom === 'client' ? ['id'] : []), ...requiredCreate],
        properties: { ...(ownId && { id: idCreate }), ...props('create') }, patternProperties: reserved, additionalProperties: false } }),
      ...(c.itemMethods.includes('PATCH') && { update: { type: 'object',
        description: text(t('A JSON Merge Patch: absent leaves a field untouched, null deletes it.', 'Un JSON Merge Patch: lo ausente no cambia, null lo borra.'), lang),
        properties: { id: { type: 'string' }, ...props('update') }, patternProperties: reserved, additionalProperties: false } }),
    };
  }
  // 11.1: the result of the new action: the starting values and the effective schema, which only restricts create.
  const newOutput = { type: 'object', required: ['values', 'schema'], properties: { values: { type: 'object' }, schema: { type: 'object' } } };
  const paramDecl = (d, lang) => ({ type: d.type, ...(d.type === 'enum' && { values: d.values }), ...(d.list && { list: true }),
    ...(d.required && { required: true }), ...(d.description && { description: text(d.description, lang) }) });
  function discoveryDocument(lang) {
    const collections = Object.fromEntries(Object.values(colls).map((c) => {
      const rels = relations(c);
      const listable = c.methods.includes('GET');
      const valuesOf = (f) => { const d = c.fields[f.split('.')[0]]; return d?.values; };
      return [c.name, {
        path: c.path,
        ...(c.description && { description: text(c.description, lang) }),
        methods: c.methods, item_methods: c.itemMethods,
        ...(c.methodEffects && { method_effects: c.methodEffects }), ...(c.itemMethodEffects && { item_method_effects: c.itemMethodEffects }),
        ...(c.idFrom && { id_from: c.idFrom }), ...(c.reusableIds && { reusable_ids: true }), ...(c.upsert && { upsert: true }),
        ...(c.upload && { upload: { media_types: c.upload.mediaTypes, ...(c.upload.maxSize && { max_size: c.upload.maxSize }), ...(c.upload.multipart && { multipart: true }) } }),
        schemas: schemas(c, lang),
        // 4.3: a collection without GET declares no filter, named filters, sort, limit or count.
        ...(listable && { filter: Object.fromEntries(Object.entries(c.filter).map(([f, d]) => [f, {
          type: d.type, ...(d.type === 'enum' && { values: valuesOf(f) }), ops: d.ops, ...(d.quantifier && { quantifier: d.quantifier }),
          ...(d.required && { required: true }), ...(d.description && { description: text(d.description, lang) }) }])) }),
        ...(Object.keys(c.namedFilters).length && { named_filters: Object.fromEntries(Object.entries(c.namedFilters).map(([f, d]) => [f, {
          ...(d.type && { type: d.type }), ...(d.type === 'enum' && { values: d.values }), description: text(d.description, lang),
          ...(d.default && { default: true }), ...(d.required && { required: true }) }])) }),
        ...(listable && { sort: c.sort }), ...(c.collations && Object.keys(c.collations).length && { collations: c.collations }),
        ...(listable && { max_limit: c.maxLimit }), ...(c.count && { count: c.count }),
        ...(c.newItem && { actions: { new: { on: 'collection', safe: true, idempotent: true, method: 'GET',
          description: text(t('The starting values of a new item for this client and the schema of its POST, to start a form; it creates nothing.',
            'Los valores iniciales de un elemento nuevo para este cliente y el esquema de su POST, para empezar un formulario; no crea nada.'), lang),
          ...(c.newParams && { params: Object.fromEntries(Object.entries(c.newParams).map(([p, d]) => [p, paramDecl(d, lang)])) }),
          output: newOutput } } }),
        ...(maps(c).length && { language_maps: Object.fromEntries(maps(c).map((f) => [f, {}])) }),
        ...(c.localized.length && { localized: Object.fromEntries(c.localized.map((f) => [f, { source: c.fields[f].source }])) }),
        ...(rels.length && { relations: Object.fromEntries(rels.map((r) => [r, { to: c.fields[r].to, ...(c.fields[r].many && { many: true }),
          ...(c.fields[r].mediaTypes && { media_types: c.fields[r].mediaTypes }),
          ...(c.fields[r].description && { description: text(c.fields[r].description, lang) }) }])) }),
      }];
    }));
    const singletons = Object.fromEntries(Object.values(singles).map((s) => [s.name, {
      path: s.path, ...(s.parent && { parent: s.parent }), methods: s.methods, ...(s.description && { description: text(s.description, lang) }), schemas: schemas(s, lang),
      ...(s.methodEffects && { method_effects: s.methodEffects }) }]));
    // 4.2: the same document for every principal; only its texts change, with Accept-Language.
    // 5.6: with localized fields, the default language is declared.
    return { restep: RESTEP, version, ...(hasLocalized && { default_language: languageList[0] }), profiles, extensions,
      ...(writable && { idempotency: { ttl: idempotencyTtl, ...(!idempotencyAnonymous && { anonymous: false }) } }),
      ...(statusPath && { status: statusPath }), collections, ...(Object.keys(singletons).length && { singletons }) };
  }

  // ── Authentication ──
  const metadataPath = `/.well-known/oauth-protected-resource${base ? `${base}/` : ''}`;
  const origin = (url) => options.publicOrigin ?? url.origin;
  async function principalOf(request, url) {
    if (oauth) {
      const m = /^bearer +(\S+)$/i.exec(request.headers.get('authorization') ?? '');
      const who = m ? await oauth.verifyToken(m[1], request) : null;
      if (who != null) return who;
      // RFC 6750, 3: only the exact root points to the metadata (RFC 9728, 3.3).
      const sent = m ? ', error="invalid_token"' : '';
      const challenge = url.pathname === `${base}/` && !url.search
        ? `Bearer realm="restep", resource_metadata="${origin(url)}${metadataPath}"${sent}` : `Bearer realm="restep"${sent}`;
      throw new RestepError(401, 'unauthenticated', t('Send Authorization: Bearer with a valid token.', 'Envía Authorization: Bearer con un token válido.'),
        { headers: { 'WWW-Authenticate': challenge } });
    }
    if (authenticate) return authenticate(request);
    return null;
  }
  // 2: the principal includes whoever acts on its behalf. authenticate and verifyToken may return
  // { principal, actor }; an acting principal and the one it represents never share keys or cursors.
  function setPrincipal(ctx, who) {
    if (who == null) { ctx.principal = null; return; }
    if (isObject(who)) {
      if (who.principal == null) throw new Error('restep-server: authenticate returned an object without principal');
      ctx.principal = String(who.principal);
      if (who.actor != null) ctx.actor = String(who.actor);
    } else ctx.principal = String(who);
  }
  // What keys and cursors are bound to (2, 6.4, 7.1): the principal and, if any, its actor.
  const whoKey = (ctx) => (ctx.actor === undefined ? ctx.principal : JSON.stringify([ctx.principal, ctx.actor]));

  // ── query: parameters (5.3, 6) ──
  function checkReserved(params, allowed) {
    for (const key of new Set(params.keys())) {
      const b = baseName(key);
      if (!isReserved(b)) continue; // the other parameters belong to the API
      if (!allowed.includes(b)) throw unsupported(key);
      if (b === 'filter' && key === 'filter') throw unsupported(key, t('filter as an expression needs the filter-expr extension.', 'filter como expresión necesita la extensión filter-expr.'));
      if (b !== 'filter' && key !== b) throw unsupported(key);
      if (params.getAll(key).length > 1) throw once(key);
    }
  }
  // values: those of an enum. Returns the value to compare with.
  function parseValue(values, type, raw, key) {
    const ok = type === 'string' ? true
      : type === 'enum' ? values.includes(raw)
      : type === 'decimal' ? DECIMAL.test(raw)
      // 6.1: a numeric operand outside the range of the field is compared as a number, without an error,
      // subject to the limit of numberOverLimit (5.3).
      // 6.1: an integer operand is one whose exact decimal value has no fractional part (20.0 is 20; 20.5 is not).
      : type === 'integer' ? integerLiteral(raw)
      : type === 'number' ? JSON_NUMBER.test(raw)
      : type === 'boolean' ? raw === 'true' || raw === 'false'
      : type === 'date' ? isDate(raw) : type === 'datetime' ? isDatetime(raw) && !leapSecond(raw)
      : type === 'localdatetime' ? isLocalDatetime(raw) && !leapSecond(raw)
      : type === 'timezone' ? isTimezone(raw)
      : type === 'duration' ? isDuration(raw) && !/^P[^T]*[YM]/i.test(raw) : false;
    // 5.3 and 6.1: an operand over the limit gives invalid_parameter with the limit in detail.
    if (ok && (type === 'integer' || type === 'number') && numberOverLimit(raw))
      throw bad(key, t(`A numeric operand is 0 or has a magnitude from 1e-${NUMBER_LIMIT} to 1e${NUMBER_LIMIT}, this server's limit.`,
        `Un operando numérico es 0 o tiene una magnitud de 1e-${NUMBER_LIMIT} a 1e${NUMBER_LIMIT}, el límite de este servidor.`));
    if (!ok) {
      if (type === 'enum') throw bad(key, t(`${raw} is not one of: ${values.join(', ')}.`, `${raw} no es ninguno de: ${values.join(', ')}.`));
      if (type === 'duration' && isDuration(raw)) throw bad(key, t('A duration with years or months has no fixed length.', 'Una duración con años o meses no tiene longitud fija.'));
      if ((type === 'datetime' || type === 'localdatetime') && leapSecond(raw)) throw bad(key, t('A time with a leap second (:60) cannot be compared.', 'Una hora con segundo intercalar (:60) no se puede comparar.'));
      throw bad(key, t(`${raw} is not a valid ${type}.`, `${raw} no es un ${type} válido.`));
    }
    // 6.1: kept as its exact decimal value, never as a floating-point number (4.300000000000000000001 is not 4.3).
    return type === 'integer' || type === 'number' ? plainDecimal(raw) : type === 'boolean' ? raw === 'true' : raw;
  }
  // 6.1: operands equal under the field's type are the same value, also for the cursor (20 and 20.0).
  function sameValue(type, v) {
    if (Array.isArray(v)) return v.map((x) => sameValue(type, x));
    if (type === 'decimal') { const [i, f = ''] = String(v).replace(/^-/, '').split('.'); const n = `${i.replace(/^0+(?=\d)/, '')}${f.replace(/0+$/, '') ? `.${f.replace(/0+$/, '')}` : ''}`; return /^-/.test(v) && n !== '0' ? `-${n}` : n; }
    if (type === 'datetime') { const [sec, frac] = instant(v); return `${sec}.${frac.replace(/0+$/, '')}`; }
    if (type === 'localdatetime') { const [x, f = ''] = String(v).toUpperCase().split('.'); return `${x}.${f.replace(/0+$/, '')}`; }
    if (type === 'duration') return String(nanoseconds(v));
    if (type === 'integer' || type === 'number') return plainDecimal(v);
    return v;
  }
  // The filters of a list request (6.1), for the adapter, and what the cursor is bound to (6.4): the same
  // filters, with their values as their type compares them, and the default filters it does not turn off.
  function parseFilters(c, params, lang) {
    const out = [], seen = new Set(), groups = new Map(), sent = new Set(), off = new Set(), print = [];
    for (const [key, value] of params) {
      if (baseName(key) !== 'filter') continue;
      const m = key.match(/^filter\[([^\][]+)\](?:\[([^\][]+)\])?$/);
      if (!m) throw unsupported(key, t('This resource supports filter[field] and filter[field][op].', 'Este recurso admite filter[campo] y filter[campo][op].'));
      const [, field, op = 'eq'] = m;
      if (Object.hasOwn(c.namedFilters, field)) { // 6.1: no operators; a switch without value, one with type with a value of its type
        const n = c.namedFilters[field];
        if (m[2] !== undefined) throw unsupported(key, t(`${field} is a named filter: it takes no operator.`, `${field} es un filtro con nombre: no lleva operador.`));
        if (seen.has(field)) throw once(key);
        seen.add(field);
        // 6.1: filter[name]=false turns a default filter off; it does not negate it.
        if (n.default && value === 'false') { off.add(field); print.push([field, false]); continue; }
        if (!n.type && value !== '') throw bad(key, t(`${field} is a switch: it takes no value.`, `${field} es un interruptor: no lleva valor.`));
        if (n.type && value === '') throw bad(key, t(`${field} needs a ${n.type} value.`, `${field} necesita un valor ${n.type}.`));
        const v = n.type ? parseValue(n.values, n.type, value, key) : true;
        sent.add(field);
        out.push({ named: field, value: v, ...(n.apply && { apply: n.apply }) });
        print.push([field, sameValue(n.type, v)]);
        continue;
      }
      const d = Object.hasOwn(c.filter, field) ? c.filter[field] : null;
      if (!d) throw unsupported(key, t(`There is no filter on ${field}. Filters: ${Object.keys(c.filter).join(', ') || 'none'}.`, `No hay filtro por ${field}. Filtros: ${Object.keys(c.filter).join(', ') || 'ninguno'}.`));
      if (!d.ops.includes(op)) throw unsupported(key, t(`${field} supports: ${d.ops.join(', ')}.`, `${field} admite: ${d.ops.join(', ')}.`));
      if (seen.has(`${field} ${op}`)) throw bad(key, t('The same filter appears twice.', 'El mismo filtro aparece dos veces.'));
      seen.add(`${field} ${op}`);
      sent.add(field);
      const values = c.fields[field.split('.')[0]]?.values;
      let v;
      if (op === 'null') {
        if (value !== 'true' && value !== 'false') throw bad(key, t('Use true or false.', 'Usa true o false.'));
        v = value === 'true';
      } else if (op === 'in' || op === 'nin') {
        // 6.1: an empty list is an error; an empty element between commas is the empty string.
        if (value === '') throw bad(key, t(`${op} needs a non-empty, comma-separated list.`, `${op} necesita una lista no vacía, separada por comas.`));
        v = value.split(',').map((x) => parseValue(values, d.type, x, key));
      } else {
        if ((op === 'prefix' || op === 'contains') && value === '') throw bad(key, t(`${op} needs a non-empty value.`, `${op} necesita un valor no vacío.`));
        v = parseValue(values, d.type, value, key);
      }
      print.push([field, op, sameValue(d.type, v)]);
      const one = { field, op, value: v, type: d.type, collation: c.collationOf(field) };
      const info = d.info;
      if (info.localized) { // 3 and 6.1: in the language of the response, with the text the representation gives
        const source = info.localized;
        Object.assign(one, { localized: { source, language: lang }, read: (row) => localizedText(row[source], lang) });
      }
      if (info.many) { // 6.1: the filters on one to-many relationship or list field form a group
        const g = groups.get(info.many.group) ?? { group: info.many.group, kind: info.many.kind, filters: [] };
        groups.set(info.many.group, g);
        // 6.1: null tests the whole group (the relationship or the list), never each element.
        if (info.whole || op === 'null') {
          // 6.1: more than one null filter on the same to-many relationship or list field, its own or that of a
          // path through it, gives invalid_parameter, even when their values agree.
          if (g.null !== undefined) throw bad(key, t(`Only one null filter on ${info.many.group}, its own or that of a path through it.`, `Solo un filtro null sobre ${info.many.group}, el suyo o el de una ruta que pase por él.`));
          g.null = v;
        }
        else g.filters.push({ ...one, field: info.many.sub ?? '' });
        continue;
      }
      out.push(one);
    }
    out.push(...groups.values());
    // 6.1: a required filter missing gives invalid_parameter naming it.
    for (const [f, d] of Object.entries(c.filter)) if (d.required && !sent.has(f))
      throw bad(`filter[${f}]`, t(`This collection requires filter[${f}].`, `Esta colección exige filter[${f}].`));
    for (const [f, n] of Object.entries(c.namedFilters)) {
      if (n.required && !sent.has(f)) throw bad(`filter[${f}]`, t(`This collection requires filter[${f}].`, `Esta colección exige filter[${f}].`));
      // 6.1: a default filter applies to every list request that does not turn it off.
      if (n.default && !sent.has(f) && !off.has(f)) { out.push({ named: f, value: true, default: true, ...(n.apply && { apply: n.apply }) }); print.push([f, true]); }
    }
    return { filter: out, print: print.map((x) => JSON.stringify(x)).sort() };
  }
  function parseSort(c, params, lang) {
    const key = (field, desc) => {
      const info = c.pathInfo(field);
      const k = { field, desc, type: info.type, collation: c.collationOf(field) };
      if (info.localized) Object.assign(k, { localized: { source: info.localized, language: lang }, read: (row) => localizedText(row[info.localized], lang) });
      if (info.many) Object.assign(k, { group: info.many.group, kind: info.many.kind, ...(info.many.sub && { sub: info.many.sub }), quantifier: 'some' });
      return k;
    };
    if (!params.has('sort')) return c.defaultSort.map((s) => key(s.replace(/^-/, ''), s.startsWith('-')));
    if (!c.sort.length) throw unsupported('sort');
    return params.get('sort').split(',').map((s) => {
      const f = s.replace(/^-/, '');
      if (!f) throw bad('sort', t('Empty sort key.', 'Clave de orden vacía.'));
      if (!c.sort.includes(f)) throw unsupported('sort', t(`${f} is not sortable. Sortable: ${c.sort.join(', ')}.`, `${f} no se puede ordenar. Se puede por: ${c.sort.join(', ')}.`));
      return key(f, s.startsWith('-'));
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
  // A cursor is opaque and signed; it is bound to the collection, the filters (with the defaults that stay
  // applied), the order, the principal and, with localized fields, the language (6.4); not to limit, fields, include or count.
  const queryPrint = (c, filterPrint, sort, ctx) => hash(JSON.stringify([c.path, whoKey(ctx), filterPrint,
    sort.map((s) => [s.field, s.desc]), c.localized.length ? ctx.lang : null]));
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

  // ── writes: bodies and validation (3, 5.1, 7) ──
  async function readBody(ctx, types) {
    // 3: application/json (and, on a PATCH, application/merge-patch+json), in UTF-8; without Content-Type, 415 even if the body is empty.
    if (!mediaTypeOk(ctx.request.headers.get('content-type'), types))
      throw new RestepError(415, 'unsupported_media_type', t(`Send ${types.join(' or ')}, in UTF-8.`, `Envía ${types.join(' o ')}, en UTF-8.`),
        types.includes('application/merge-patch+json') ? { headers: { 'Accept-Patch': 'application/merge-patch+json' } } : {});
    const tooLarge = () => new RestepError(413, 'content_too_large', t(`The body may be up to ${maxBodyBytes} bytes.`, `El cuerpo puede tener hasta ${maxBodyBytes} bytes.`));
    if (Number(ctx.request.headers.get('content-length') ?? 0) > maxBodyBytes) throw tooLarge();
    const raw = await ctx.request.text();
    if (enc.encode(raw).length > maxBodyBytes) throw tooLarge();
    let v;
    try { v = JSON.parse(raw); } catch {
      throw new RestepError(400, 'bad_request', t('The body is not valid JSON.', 'El cuerpo no es JSON válido.'));
    }
    // 3: an I-JSON message repeats no member name; the meaning of one that does would depend on the parser.
    const dup = duplicateMember(raw);
    if (dup !== null) throw new RestepError(400, 'bad_request', t('The body repeats a member name.', 'El cuerpo repite el nombre de un miembro.'),
      { errors: [{ pointer: dup, code: 'format', detail: t('A member name appears twice in this object.', 'El nombre de un miembro aparece dos veces en este objeto.') }] });
    // 3: unpaired surrogates and noncharacters give 422 invalid with a format entry, after the preconditions (5.4).
    ctx.ijsonErrors = badCharacters(v);
    // 5.1 and 4.3: a JSON value that is not an object is kept; it gives 422 with objectBody(), after the
    // preconditions (5.4).
    if (!isObject(v)) return [v, v];
    // 5.1: members that start with _ belong to Restep and a write ignores them.
    return [Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('_'))), v];
  }
  // 5.1 and 4.3: a body that is a JSON value but not an object gives 422 invalid, with a type entry at "".
  function objectBody(v, ctx) {
    if (!isObject(v)) throw invalid([{ pointer: '', code: 'type', detail: t('The body must be a JSON object.', 'El cuerpo tiene que ser un objeto JSON.') }]);
    if (ctx?.ijsonErrors?.length) throw invalid(ctx.ijsonErrors);
    return v;
  }
  const scalarOk = (type, v, values) => (type === 'decimal' ? typeof v === 'string' && DECIMAL.test(v)
    : type === 'integer' ? Number.isSafeInteger(v) : type === 'number' ? typeof v === 'number' && Number.isFinite(v)
    : type === 'boolean' ? typeof v === 'boolean' : type === 'date' ? typeof v === 'string' && isDate(v)
    : type === 'datetime' ? typeof v === 'string' && isDatetime(v) : type === 'localdatetime' ? typeof v === 'string' && isLocalDatetime(v)
    : type === 'timezone' ? isTimezone(v) : type === 'duration' ? isDuration(v)
    : type === 'enum' ? typeof v === 'string' && (values === undefined || values.includes(v))
    : typeof v === 'string');
  const typeOk = (d, v) => (d.type === 'list' ? Array.isArray(v) && v.every((x) => scalarOk(d.items, x, d.values)) : scalarOk(d.type, v));
  for (const c of [...Object.values(colls), ...Object.values(singles)]) for (const [f, d] of Object.entries(c.fields))
    if ('default' in d && (!scalarOk(d.type, d.default, d.values) || (['datetime', 'localdatetime'].includes(d.type) && leapSecond(d.default))))
      throw configError(`${c.name}.fields.${f}: default is not a valid ${d.type}${['datetime', 'localdatetime'].includes(d.type) ? ' without a leap second (3)' : ''}`);
  // Validates the members of a body before merging it. current: the stored item (PATCH) or undefined (POST).
  async function bodyErrors(c, body, current, ctx) {
    const errors = [];
    const patch = current !== undefined;
    for (const [f, v] of Object.entries(body)) {
      const d = c.fields[f];
      if (!d) { errors.push({ pointer: ptr(f), code: 'unknown', detail: t(`There is no field ${f}.`, `No hay ningún campo ${f}.`) }); continue; }
      if (d.type === 'map') {
        if (v === null && patch) continue; // empties the map
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
      if (d.type === 'relation' && d.many) { // 3: a to-many list is replaced whole
        if (!Array.isArray(v) || v.some((x) => !isObject(x) || typeof x.id !== 'string')) { errors.push({ pointer: ptr(f), code: 'type', detail: t(`${f} must be a list of objects with an id.`, `${f} tiene que ser una lista de objetos con un id.`) }); continue; }
        body[f] = v.map((x) => ({ id: x.id }));
        if (patch && canonical(body[f]) === canonical((current?.[f] ?? []).map((x) => ({ id: x.id })))) continue;
        for (const [i, x] of v.entries()) errors.push(...await relatedErrors(d, x.id, `${ptr(f)}/${i}/id`, ctx));
        continue;
      }
      if (d.type === 'relation') {
        if (!isObject(v) || typeof v.id !== 'string') { errors.push({ pointer: ptr(f), code: 'type', detail: t(`${f} must be an object with an id, or null.`, `${f} tiene que ser un objeto con un id, o null.`) }); continue; }
        body[f] = { id: v.id }; // 5.1: only its id is read; the related item is never modified
        // 5.1: with its current value it is ignored without checking, so returning what was read never fails because of it.
        if (patch && current?.[f]?.id === v.id) continue;
        errors.push(...await relatedErrors(d, v.id, `${ptr(f)}/id`, ctx));
        continue;
      }
      if (!typeOk(d, v)) errors.push({ pointer: ptr(f), code: 'type', detail: t(`${f} must be a ${d.type}${d.type === 'decimal' ? ' in a string, such as "18.50"' : ''}.`, `${f} tiene que ser de tipo ${d.type}${d.type === 'decimal' ? ' en una cadena, como "18.50"' : ''}.`) });
      else if (d.type === 'enum' && !d.values.includes(v)) errors.push({ pointer: ptr(f), code: 'format', detail: t(`${f} must be one of: ${d.values.join(', ')}.`, `${f} tiene que ser uno de: ${d.values.join(', ')}.`) });
      // 3: a server never writes a leap second (:60) and rejects an instant or a local date-time with one with a format entry.
      else if (['datetime', 'localdatetime'].includes(d.type) || (d.type === 'list' && ['datetime', 'localdatetime'].includes(d.items)))
        for (const [at, x] of d.type === 'list' ? v.map((x, i) => [`${ptr(f)}/${i}`, x]) : [[ptr(f), v]])
          if (leapSecond(x)) errors.push({ pointer: at, code: 'format', detail: t('A time cannot have a leap second (:60).', 'Una hora no puede tener segundo intercalar (:60).') });
    }
    return errors;
  }
  // 5.1: an item that does not exist and one the principal cannot see give the same entry (the adapter's get
  // returns null for both). With mediaTypes, a file of another type gives format (5.1).
  async function relatedErrors(d, id, pointer, ctx) {
    const target = colls[d.to];
    const item = isId(id) ? await target.data.get(id, { ...ctx, collection: target }) : null;
    if (!item) return [{ pointer, code: 'unknown', detail: t(`There is no ${d.to} ${id}.`, `No hay ningún ${d.to} ${id}.`) }];
    if (d.mediaTypes && !mediaRangeMatch(d.mediaTypes, item._content?.media_type))
      return [{ pointer, code: 'format', detail: t(`${d.to} ${id} is not a file of type ${d.mediaTypes.join(', ')}.`, `${d.to} ${id} no es un archivo de tipo ${d.mediaTypes.join(', ')}.`) }];
    return [];
  }
  // 5.1: read-only fields in a write. In a POST, one only the server sets is ignored whatever its value, and a
  // localized field is ignored with the text the item would get; in a PATCH, either is ignored with its current
  // value (a localized field's text in any language the API offers). Any other value gives read_only.
  function readOnlyErrors(c, body, current) {
    const errors = [];
    const readOnly = (f) => ({ pointer: ptr(f), code: 'read_only', detail: t(`${f} is read-only.`, `${f} es de solo lectura.`) });
    for (const f of Object.keys(body)) {
      const d = c.fields[f];
      if (!d || !(d.readOnly || d.type === 'localized')) continue;
      const v = body[f];
      let ignore;
      if (d.type === 'localized') {
        const map = current === undefined ? body[d.source] : current[d.source];
        ignore = languageList.some((l) => localizedText(map, l) === v) || (v === null && !isObject(map));
      } else if (current === undefined) ignore = true;
      else {
        const was = current[f];
        ignore = (v ?? null) === (was ?? null) || (v != null && was != null && (SCALARS.includes(d.type) && scalarOk(d.type, v)
          ? compareValues(d.type, v, was) === 0 : canonical(v) === canonical(was)));
      }
      if (ignore) delete body[f]; else errors.push(readOnly(f));
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
  // Merges a patch (5.1): Merge Patch, except relations (replaced whole) and language maps
  // (merged and, when emptied or deleted, left as {}).
  function applyPatch(c, current, patch) {
    const out = { ...current };
    for (const [f, v] of Object.entries(patch)) {
      const d = c.fields[f];
      if (d.type === 'relation') out[f] = d.many ? (v ?? []).map((x) => ({ id: x.id })) : v === null ? null : { id: v.id };
      else if (d.type === 'map') out[f] = v === null ? {} : mergePatch(isObject(current[f]) ? current[f] : {}, v);
      else if (v === null) delete out[f];
      else out[f] = mergePatch(current[f], v);
    }
    return out;
  }

  // Per-item exclusion: evaluating If-Match and writing is atomic within this process (7.2). Across
  // processes the createTransaction transaction does it, with the forUpdate get.
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

  // ── Routes ──
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
    const { filter, print: filterPrint } = parseFilters(c, params, ctx.lang);
    const sort = parseSort(c, params, ctx.lang);
    if (!sort.some((s) => s.field === 'id')) sort.push({ field: 'id', desc: false, type: 'string', collation: 'codepoint' }); // desempate estable (6.2)
    const rawLimit = params.get('limit');
    const limit = rawLimit === null ? Math.min(c.defaultLimit, c.maxLimit) : Number(rawLimit);
    if (rawLimit !== null && (!/^\d+$/.test(rawLimit) || limit < 1 || limit > c.maxLimit))
      throw bad('limit', t(`Between 1 and ${c.maxLimit}.`, `Entre 1 y ${c.maxLimit}.`));
    const count = params.get('count');
    if (count !== null && !c.count) throw unsupported('count');
    if (count !== null && count !== 'true' && count !== 'false') throw bad('count', t('Use true or false.', 'Usa true o false.'));
    const fields = parseFields(c, params);
    const print = await queryPrint(c, filterPrint, sort, ctx);
    const cursor = await readCursor(params, print);
    // 7.2: if the item supports PATCH or DELETE, each carries in _etag the ETag of its GET, computed
    // over the full representation; that is why the adapter does not receive fields as a hint in that case.
    const itemEtag = c.itemMethods.length > 1;
    const page = await c.data.list({ filter, sort, limit, cursor, count: count === 'true', fields: itemEtag ? null : fields }, { ...ctx, collection: c });
    if (count === 'true' && typeof page.total !== 'number') throw new Error(`restep-server: ${c.name}.data.list did not return total with count`);
    let next = null;
    if (page.next != null) {
      const q = new URLSearchParams(params);
      q.set('cursor', await makeCursor(page.next, print));
      next = `${ctx.url.pathname}?${q}`;
    }
    const items = await Promise.all(page.items.map(async (r) => {
      const row = represent(c, r, ctx.lang);
      return itemEtag ? { ...pick(row, fields), _etag: await itemTag(row) } : pick(row, fields);
    }));
    return { items, next, ...(count === 'true' && { total: page.total }), ...(count === 'true' && c.count === 'estimated' && { total_estimated: true }) };
  }

  async function collectionEtag(c, ctx) {
    // The same ETag as a GET of the collection without parameters (with each item's _etag); null where that
    // GET carries none: the collection has no GET, or it gives an error (a required filter, 6.1).
    if (!c.methods.includes('GET')) return null;
    try { return await etagOf(await listCollection(c, { ...ctx, url: new URL(`${base}${c.path}`, ctx.url) })); }
    catch (e) { if (e instanceof RestepError && e.status < 500) return null; throw e; }
  }

  // 7.1: the request's key, already checked; null if it carries none. A malformed one (or with parameters) gives 400 with its entry.
  function idempotencyKey(c, ctx) {
    const raw = ctx.request.headers.get('idempotency-key');
    const anonymous = ctx.principal == null;
    if (raw === null) {
      // With "anonymous": false, a resource that requires the key does not require it of a request without credentials.
      if (c.requireIdempotencyKey && !(anonymous && !idempotencyAnonymous))
        throw new RestepError(400, 'idempotency_key_required', t('This collection requires Idempotency-Key.', 'Esta colección exige Idempotency-Key.'),
          { errors: [{ header: 'Idempotency-Key', code: 'required', detail: t('Send Idempotency-Key.', 'Envía Idempotency-Key.') }] });
      return null;
    }
    const m = raw.trim().match(/^"((?:[\x20\x21\x23-\x5b\x5d-\x7e]|\\["\\])*)"$/);
    if (!m) throw new RestepError(400, 'bad_request', t('Idempotency-Key must be a quoted string without parameters, such as "8e03978e-40d5".', 'Idempotency-Key tiene que ser una cadena entre comillas y sin parámetros, como "8e03978e-40d5".'),
      { errors: [{ header: 'Idempotency-Key', code: 'format', detail: t('Not a Structured Fields string without parameters.', 'No es una cadena de Structured Fields sin parámetros.') }] });
    // 7.1: with "anonymous": false, a request without credentials that carries the key gets 400 before any effect.
    if (anonymous && !idempotencyAnonymous)
      throw new RestepError(400, 'bad_request', t('This API does not take Idempotency-Key without credentials.', 'Esta API no admite Idempotency-Key sin credenciales.'),
        { errors: [{ header: 'Idempotency-Key', code: 'unknown', detail: t('Send it with credentials, or leave it out.', 'Envíala con credenciales, o no la envíes.') }] });
    return m[1].replace(/\\(["\\])/g, '$1');
  }

  // 5.1: the id of a POST according to id_from. Returns the errors entries (empty if it is fine).
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

  // 5.1: the bytes of a file, for a collection that declares upload: their own media type (one it declares,
  // * matching any subtype) or, with multipart, multipart/form-data with exactly one part named file.
  // A JSON body is an upload only where the collection does not create from JSON and its mediaTypes admit
  // application/json, also through a wildcard (application/* or */*); where it creates from JSON, a POST with
  // application/json is always an item creation (5.1). Only top-level application/json selects creation: a +json
  // type, such as application/ld+json, is a file like any other.
  const isUpload = (c, type) => !!c.upload && type !== null
    && (!mediaTypeOk(type, ['application/json']) || (!c.data.create && mediaRangeMatch(c.upload.mediaTypes, 'application/json')));
  // 5.1: the media types a collection with upload accepts in a POST, for Accept-Post.
  const acceptPost = (c) => [...new Set([...(c.data.create ? ['application/json'] : []), ...c.upload.mediaTypes,
    ...(c.upload.multipart ? ['multipart/form-data'] : [])])].join(', ');
  async function readUpload(c, ctx) {
    const header = ctx.request.headers.get('content-type');
    const mediaType = header.split(';')[0].trim().toLowerCase();
    const limit = c.upload.maxSize ?? maxBodyBytes;
    const tooLarge = () => new RestepError(413, 'content_too_large', t(`The file may be up to ${limit} bytes.`, `El archivo puede tener hasta ${limit} bytes.`));
    const refuse = (detail) => new RestepError(415, 'unsupported_media_type', detail);
    const declared = c.data.create ? t(`Send application/json or a file of type ${c.upload.mediaTypes.join(', ')}.`, `Envía application/json o un archivo de tipo ${c.upload.mediaTypes.join(', ')}.`)
      : t(`Send a file of type ${c.upload.mediaTypes.join(', ')}.`, `Envía un archivo de tipo ${c.upload.mediaTypes.join(', ')}.`);
    // 5.1: an outer multipart/form-data always selects multipart upload: 415 without multipart, even when
    // mediaTypes match it (multipart/* or */*).
    const multipart = mediaType === 'multipart/form-data';
    if (multipart && !c.upload.multipart) throw refuse(declared);
    if (!multipart && !mediaRangeMatch(c.upload.mediaTypes, mediaType)) throw refuse(declared);
    const multipartLimit = limit + 64 * 1024; // room for the part's own headers
    if (Number(ctx.request.headers.get('content-length') ?? 0) > (multipart ? multipartLimit : limit)) throw tooLarge();
    let bytes = new Uint8Array(await ctx.request.arrayBuffer());
    let type = mediaType, filename = dispositionFilename(ctx.request.headers.get('content-disposition'));
    if (multipart) {
      const part = onePart(header, bytes);
      if (!part || !mediaRangeMatch(c.upload.mediaTypes, part.type)) throw refuse(t('multipart/form-data carries exactly one part, named file, with a declared type.',
        'multipart/form-data lleva exactamente una parte, llamada file, con un tipo declarado.'));
      ({ bytes, filename } = part);
      type = part.type.split(';')[0].trim().toLowerCase();
    }
    if (bytes.length > limit) throw tooLarge();
    return { bytes, mediaType: type, filename, size: bytes.length };
  }
  async function create(c, ctx) {
    const req = ctx.request;
    const key = idempotencyKey(c, ctx);
    let file, body, sent;
    try {
      file = isUpload(c, req.headers.get('content-type')) ? await readUpload(c, ctx) : null;
      // 5.1: a collection that only takes uploads (no create from JSON) and whose mediaTypes do not admit
      // application/json, also through a wildcard, answers 415 to JSON.
      if (!file && !c.data.create) throw new RestepError(415, 'unsupported_media_type', t(`Send a file of type ${c.upload.mediaTypes.join(', ')}.`, `Envía un archivo de tipo ${c.upload.mediaTypes.join(', ')}.`));
      [body, sent] = file ? [null, { upload: file.mediaType, sha256: hex(await webcrypto.subtle.digest('SHA-256', file.bytes)) }]
        : await readBody(ctx, ['application/json']);
    } catch (e) {
      // 5.1: a 415 from a collection with upload carries Accept-Post with the media types it accepts (W3C LDP 1.0, 7.1).
      if (c.upload && e instanceof RestepError && e.status === 415) e.headers = { ...e.headers, 'Accept-Post': acceptPost(c) };
      throw e;
    }
    // 7.1: a key belongs to a principal and a target (method and path, after percent-decoding, without the query).
    // Two requests are the same if their query also matches (after decoding; regardless of the order of different
    // names, but not of the repeated values of one name) and their bodies as JSON.
    const scope = key !== null ? `${await hash(String(whoKey(ctx) ?? ''))} POST ${ctx.path} ${key}` : null;
    const byName = new Map();
    for (const [k, v] of ctx.url.searchParams) byName.set(k, [...(byName.get(k) ?? []), v]);
    const query = [...byName].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const print = scope && await hash(canonical([query, sent]));
    const saved = scope ? await idempotencyStore.reserve(scope, print, idempotencyTtl * 1000, ctx) : null;
    let reserved = scope && !saved;
    let effectStarted = false;
    try {
      if (saved && saved.print === print) {
        // 7.1: the same request while the first is still in progress; the client may repeat it with the same key.
        if (!saved.response) throw new RestepError(409, 'request_in_progress', t('The same request is still being processed: send it again with the same key in a moment.', 'La misma petición todavía se está procesando: vuelve a enviarla con la misma clave dentro de un momento.'), { headers: { 'Retry-After': '1' } });
        const [status, data, headers] = saved.response;
        // 7.1: the body gives no more than a read now: if the created item no longer exists (the one in its body or, with
        // return=minimal, the one in its Location), the same status and Location, without body or ETag. If it exists, the body
        // is its current representation, as a read gives it now, with its current ETag. 7.3: a replay of a 201 without
        // body (return=minimal) carries no ETag even if the item exists: the client reads the item at Location.
        const id = data?.id ?? (headers?.Location ? decodeURIComponent(headers.Location.split('/').at(-1)) : undefined);
        const now = id === undefined ? null : await c.data.get(String(id), { ...ctx, collection: c });
        const { ETag, ...rest } = headers ?? {};
        if (id !== undefined && (!now || String(now.id) !== String(id))) return respond(ctx, status, undefined, { ...rest, 'Idempotent-Replayed': 'true' });
        // 7.1: a stored body that is not the item's current representation carries no Content-Location, ETag or _etag.
        if (!now) {
          const { 'Content-Location': _cl, ...plain } = rest;
          const stored = isObject(data) ? Object.fromEntries(Object.entries(data).filter(([k]) => k !== '_etag')) : data;
          return respond(ctx, status, stored, { ...plain, 'Idempotent-Replayed': 'true' });
        }
        if (data === undefined) {
          const { 'Content-Location': _cl, ...plain } = rest;
          return respond(ctx, status, undefined, { ...plain, 'Idempotent-Replayed': 'true' });
        }
        const row = represent(c, now, ctx.lang);
        const tag = await itemTag(row);
        return respond(ctx, status, { ...row, _etag: tag }, { ...rest, ETag: tag, 'Idempotent-Replayed': 'true',
          ...(c.localized.length && { Vary: 'Accept-Language', 'Content-Language': ctx.lang }) });
      }
      // 5.4: 412 goes before 422, so the preconditions are checked before a key used with another body.
      const ifMatch = req.headers.get('if-match'), ifNone = req.headers.get('if-none-match');
      if (ifMatch !== null || ifNone !== null) {
        // 7.2: * depends on whether this principal can read the collection; a list compares with the ETag of its
        // GET without parameters, and where it carries none, nothing matches.
        const readable = c.methods.includes('GET');
        const tag = await collectionEtag(c, ctx);
        const star = (h) => tags(h).includes('*');
        if (ifMatch !== null && !(star(ifMatch) ? readable : tag !== null && strongMatch(ifMatch, tag)))
          throw new RestepError(412, 'precondition_failed', t('If-Match does not match the current collection.', 'If-Match no coincide con la colección actual.'));
        if (ifNone !== null && (star(ifNone) ? readable : tag !== null && weakMatch(ifNone, tag)))
          throw new RestepError(412, 'precondition_failed', t('If-None-Match matches the current collection.', 'If-None-Match coincide con la colección actual.'));
      }
      if (saved) throw new RestepError(422, 'idempotency_mismatch', t('That Idempotency-Key was already used with a different request.', 'Esa Idempotency-Key ya se usó con otra petición.'));
      if (file) return await finishCreate(c, ctx, async () => {
        effectStarted = true;
        const stored = await c.data.upload(file, { ...ctx, collection: c });
        const content = stored?._content;
        if (!isObject(content) || typeof content.href !== 'string' || typeof content.media_type !== 'string' || !Number.isSafeInteger(content.size))
          throw new Error(`restep-server: ${c.name}.data.upload must return the item with _content { href, media_type, size } (5.1)`);
        return stored;
      }, scope, () => { reserved = false; });
      objectBody(body, ctx);
      const ownId = 'id' in body && (c.idFrom === 'client' || c.idFrom === 'either') ? body.id : undefined;
      const { id: _, ...rest } = body;
      const data = await createData(c, rest, ctx, idErrors(c, body));
      const make = async () => {
        // 5.4: the 409 for a taken id goes after the 422. taken() answers the same whether or not the client sees it (5.1).
        if (ownId !== undefined && await c.data.taken(ownId, { ...ctx, collection: c })) throw takenError();
        // Once the adapter starts, an exception does not prove that no effect occurred.
        effectStarted = true;
        return c.data.create(ownId !== undefined ? { id: ownId, ...data } : data, { ...ctx, collection: c });
      };
      // Within the process, checking the id and creating is atomic; across processes the adapter's primary key guarantees it.
      return await finishCreate(c, ctx, async () => {
        const stored = ownId !== undefined ? await withLock(`${c.name}/${ownId}`, make) : await make();
        if (ownId !== undefined && stored && String(stored.id) !== ownId) throw new Error(`restep-server: ${c.name}.data.create must store the id the client chose`);
        return stored;
      }, scope, () => { reserved = false; });
    } catch (e) {
      // A 409 taken from the adapter (its primary key) is a rejection with no effect: it does not spend the key.
      if (e instanceof RestepError && e.status === 409 && e.extra.errors?.some((x) => x.code === 'taken')) effectStarted = false;
      throw e;
    } finally {
      // A request rejected before it runs does not spend the key (7.1).
      // Keep uncertain outcomes reserved until recovery; never blindly repeat the effect.
      if (reserved && !effectStarted) await idempotencyStore.release(scope, ctx);
    }
  }

  // The data of a new item from the body of a POST (or the result of a PATCH that creates, 5.1), validated:
  // read-only fields, types, defaults (4.3), required fields and the API's own rules; 422 with every entry.
  async function createData(c, rest, ctx, errors) {
    errors = [...errors, ...readOnlyErrors(c, rest, undefined), ...await bodyErrors(c, rest, undefined, ctx)];
    const data = { ...rest };
    for (const [f, d] of Object.entries(c.fields)) if ('default' in d && !(f in data)) data[f] = d.default; // 4.3
    for (const f of maps(c)) if (!isObject(data[f])) data[f] = {};
    for (const f of Object.keys(data)) if (data[f] === null && c.fields[f].type !== 'relation') delete data[f];
    errors.push(...requiredErrors(c, data).filter((e) => !errors.some((x) => x.pointer === e.pointer)));
    if (!errors.length) errors.push(...await customErrors(c, data, { ...ctx, collection: c, method: 'POST' }));
    if (errors.length) throw invalid(errors);
    return data;
  }
  // The 201 of a POST (and of a PATCH that creates, 5.1): Location, the representation and the item ETag,
  // stored under the idempotency key before answering.
  async function finishCreate(c, ctx, make, scope, done) {
    const stored = await make();
    if (!stored || stored.id == null) throw new Error(`restep-server: ${c.name}.data.create must return the item with its id`);
    const row = represent(c, stored, ctx.lang);
    const etag = await itemTag(row);
    const minimal = ctx.preferMinimal;
    const response = [201, minimal ? undefined : { ...row, _etag: etag }, { Location: itemPath(c, row.id), ETag: etag,
      'Cache-Group-Invalidation': groups([`${base}${c.path}`, itemPath(c, row.id)]), ...(minimal && { 'Preference-Applied': 'return=minimal' }),
      ...(c.localized.length && { Vary: 'Accept-Language', 'Content-Language': ctx.lang }) }];
    if (scope) { await idempotencyStore.complete(scope, response, ctx); done(); }
    return respond(ctx, ...response);
  }

  // PATCH and DELETE of an item, and PATCH of a singleton (id undefined).
  async function writeItem(c, id, ctx) {
    const patch = ctx.method === 'PATCH' ? (await readBody(ctx, ['application/merge-patch+json', 'application/json']))[0] : null;
    return withLock(c.singleton ? `singleton:${ctx.selfPath}` : `${c.name}/${id}`, async () => {
      const cctx = { ...ctx, collection: c };
      // forUpdate: inside createTransaction, the adapter locks what it reads (SELECT ... FOR UPDATE), so
      // If-Match and the write are atomic across processes too (7.2).
      const raw0 = c.singleton ? await c.data.get({ ...cctx, forUpdate: true }) : await c.data.get(id, { ...cctx, forUpdate: true });
      const raw = raw0 && (c.singleton || String(raw0.id) === id) ? raw0 : null;
      const ifMatch = ctx.request.headers.get('if-match'), ifNone = ctx.request.headers.get('if-none-match');
      // 7.2: in a collection with upsert, If-None-Match: * on a PATCH meets a required If-Match: it creates
      // the item if its id is free, and gives 412 if it is not (the If-None-Match check below). Only * does:
      // a list of entity tags does not meet it, and gets 428.
      const createOnly = c.upsert && ctx.method === 'PATCH' && ifNone?.trim() === '*';
      if (!raw && c.upsert && ctx.method === 'PATCH') return upsertCreate(c, id, patch, ctx, ifMatch, createOnly);
      if (!raw) throw notFound(ctx.path);
      const current = represent(c, raw, ctx.lang);
      // 7.2: with localized fields each language is a representation; If-Match succeeds with the current
      // item ETag of any language the API offers, and If-None-Match is evaluated against that same choice.
      const tagsNow = c.localized?.length ? await Promise.all(languageList.map((l) => itemTag(represent(c, raw, l)))) : [await itemTag(current)];
      if (c.requireIfMatch && ifMatch === null && !createOnly) throw new RestepError(428, 'precondition_required', t('This resource requires If-Match to write.', 'Este recurso exige If-Match para escribir.'));
      if (ifMatch !== null && !tagsNow.some((tag) => strongMatch(ifMatch, tag))) throw new RestepError(412, 'precondition_failed', t('Someone changed it: read it again before writing.', 'Alguien lo ha cambiado: vuelve a leerlo antes de escribir.'));
      if (ifNone !== null && tagsNow.some((tag) => weakMatch(ifNone, tag))) throw new RestepError(412, 'precondition_failed', t('If-None-Match matches the current item.', 'If-None-Match coincide con el elemento actual.'));
      const path = ctx.selfPath ?? itemPath(c, id);
      const invalidate = { 'Cache-Group-Invalidation': groups(c.singleton ? [path] : [`${base}${c.path}`, path]),
        ...(c.localized?.length && { Vary: 'Accept-Language', 'Content-Language': ctx.lang }) };
      if (ctx.method === 'DELETE') {
        await c.data.delete(id, cctx);
        return respond(ctx, 204, undefined, invalidate);
      }
      objectBody(patch, ctx); // 5.1 and 5.4: after the preconditions
      // 5.1: id is read-only: with its current value it is ignored; with another, 422 read_only without applying anything.
      if (!c.singleton && 'id' in patch) {
        if (patch.id !== id) throw invalid([{ pointer: '/id', code: 'read_only', detail: t('id cannot change.', 'id no puede cambiar.') }]);
        delete patch.id;
      }
      const errors = [...readOnlyErrors(c, patch, current), ...await bodyErrors(c, patch, current, ctx)];
      if (errors.length) throw invalid(errors);
      const { id: _, ...rest } = current;
      // A localized field is derived from its source: it is not data to store.
      const before = Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith('_') && c.fields[k]?.type !== 'localized'));
      const merged = applyPatch(c, before, patch);
      errors.push(...requiredErrors(c, merged));
      if (!errors.length) errors.push(...await customErrors(c, merged, { ...cctx, current, patch }));
      if (errors.length) throw invalid(errors, t('The result of the patch is not valid.', 'El resultado del parche no es válido.'));
      // 5.1: a PATCH that changes no data leaves the item as it was (neither the adapter nor the ETag notice).
      let row = current;
      if (canonical(merged) !== canonical(before)) {
        const stored = c.singleton ? await c.data.update(merged, { ...cctx, current, patch }) : await c.data.update(id, merged, { ...cctx, current, patch });
        row = represent(c, stored ?? (c.singleton ? merged : { ...merged, id, ...(raw._incarnation !== undefined && { _incarnation: raw._incarnation }) }), ctx.lang);
      }
      const etag = await itemTag(row);
      if (ctx.preferMinimal) return respond(ctx, 204, undefined, { ETag: etag, ...invalidate, 'Preference-Applied': 'return=minimal' });
      return respond(ctx, 200, { ...row, _etag: etag }, { ETag: etag, ...invalidate });
    });
  }

  // 5.1: a PATCH to a free id of a collection that declares upsert creates the item: the merge patch applied
  // to {}, validated as the body of a POST, answered 201 as a POST. The id of a deleted item, which is not
  // free without reusable_ids, gives 404; If-Match fails with 412, and If-None-Match: * lets it create.
  // With requireIfMatch, only If-None-Match: * (createOnly) lets it create; without either, 428 (7.2).
  async function upsertCreate(c, id, patch, ctx, ifMatch, createOnly) {
    const cctx = { ...ctx, collection: c };
    if (await c.data.taken(id, cctx)) throw notFound(ctx.path);
    if (c.requireIfMatch && ifMatch === null && !createOnly)
      throw new RestepError(428, 'precondition_required', t('This resource requires If-Match to write, or If-None-Match: * to create.', 'Este recurso exige If-Match para escribir, o If-None-Match: * para crear.'));
    if (ifMatch !== null) throw new RestepError(412, 'precondition_failed', t('There is no item to match: If-Match only holds on an item that exists.', 'No hay elemento con el que coincidir: If-Match solo se cumple con un elemento que existe.'));
    objectBody(patch, ctx);
    const { id: sentId, ...rest } = patch;
    const idErr = sentId !== undefined && sentId !== id ? [{ pointer: '/id', code: 'read_only', detail: t('id is the one in the path.', 'id es el de la ruta.') }]
      : idErrors(c, { id });
    // RFC 7396: null deletes, so applied to {} it leaves nothing.
    const result = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== null).map(([k, v]) => [k, isObject(v) ? mergePatch({}, v) : v]));
    const data = await createData(c, result, ctx, idErr);
    return finishCreate(c, ctx, async () => c.data.create({ id, ...data }, cctx), null, () => {});
  }

  // 11.1 and 4.3: the body of a POST already filled in for this client and this moment, to start a
  // form: the defaults of the create schema and, on top, what newItem(ctx) returns. It creates nothing.
  // 11.1: the result is { values, schema }: schema is the collection's create schema, which newSchema(ctx, schema)
  // may restrict (never widen); with newParams, the action's declared parameters arrive in ctx.params.
  async function newItem(c, ctx) {
    if (!ctx.read) throw new RestepError(405, 'method_not_allowed', t('Only GET and HEAD.', 'Solo GET y HEAD.'), { headers: { Allow: 'GET, HEAD' } });
    checkReserved(ctx.url.searchParams, []);
    const params = actionParams(c.newParams ?? {}, ctx.url.searchParams);
    const defaults = Object.fromEntries(Object.entries(c.fields).filter(([, d]) => 'default' in d).map(([f, d]) => [f, d.default]));
    const nctx = { ...ctx, collection: c, params };
    const extra = await c.newItem(nctx);
    const create = schemas(c, ctx.lang).create;
    const schema = c.newSchema ? await c.newSchema(nctx, structuredClone(create)) : create;
    if (!isObject(schema)) throw new Error(`restep-server: ${c.name}.newSchema must return a JSON Schema object`);
    const data = { values: { ...defaults, ...(isObject(extra) ? extra : {}) }, schema };
    // 8: If-None-Match is evaluated on every GET, here too (with its ETag, or with *).
    const headers = { ETag: await etagOf(data), 'Cache-Control': 'private, no-store' };
    if (weakMatch(ctx.request.headers.get('if-none-match'), headers.ETag)) return respond(ctx, 304, undefined, headers);
    return respond(ctx, 200, data, headers);
  }

  // GET and HEAD of an item or a singleton.
  async function readItem(c, raw, ctx) {
    const params = ctx.url.searchParams;
    const row = represent(c, raw, ctx.lang);
    const fields = parseFields(c, params);
    const whole = await itemTag(row);
    // 7.2: the ETag of the whole item is the item ETag, computed without _etag, and with writes it also goes in
    // _etag. With fields it is another representation, with its own ETag; the item's stays in _etag.
    const data = fields ? { ...pick(row, fields), ...(writable && { _etag: whole }) } : await withEtag(row);
    const tag = fields ? await etagOf(c.localized?.length ? [data, ctx.lang] : data) : whole;
    const headers = { ETag: tag, 'Cache-Control': cacheControl(ctx, 'no-cache'), 'Cache-Groups': groups([ctx.selfPath ?? itemPath(c, row.id)]),
      ...(c.localized?.length && { Vary: 'Accept-Language', 'Content-Language': ctx.lang }) };
    const ifMatch = ctx.request.headers.get('if-match');
    if (ifMatch !== null && !strongMatch(ifMatch, whole)) throw new RestepError(412, 'precondition_failed', t('If-Match does not match the current representation.', 'If-Match no coincide con la representación actual.'));
    if (weakMatch(ctx.request.headers.get('if-none-match'), tag)) return respond(ctx, 304, undefined, headers);
    return respond(ctx, 200, data, headers);
  }

  // 11.1: the declared query parameters of a GET action. A missing required one, a wrong value, an empty
  // list or a repeated one give invalid_parameter; an undeclared one, unsupported_parameter (5.3).
  function actionParams(declared, params) {
    const out = {};
    for (const key of new Set(params.keys())) {
      if (isReserved(baseName(key))) continue; // checkReserved has dealt with these
      const d = Object.hasOwn(declared, key) ? declared[key] : null;
      if (!d) throw unsupported(key, t(`This action does not take ${key}.`, `Esta acción no admite ${key}.`));
      if (params.getAll(key).length > 1) throw once(key);
      const raw = params.get(key);
      if (d.list) {
        if (raw === '') throw bad(key, t(`${key} needs a non-empty, comma-separated list.`, `${key} necesita una lista no vacía, separada por comas.`));
        out[key] = raw.split(',').map((x) => parseValue(d.values, d.type, x, key));
      } else out[key] = parseValue(d.values, d.type, raw, key);
    }
    for (const [p, d] of Object.entries(declared)) if (d.required && !(p in out)) throw bad(p, t(`This action requires ${p}.`, `Esta acción exige ${p}.`));
    return out;
  }

  // 5.8: credentials the browser adds by itself (cookies, HTTP authentication, client certificate).
  // "auto": there are some if the request carries Cookie or Authorization Basic or Digest; a client certificate is not seen
  // from Request, so whoever uses one sets browserCredentials: true.
  const browserCredentialed = (request) => (typeof browserCredentials === 'function' ? !!browserCredentials(request)
    : browserCredentials === 'auto' ? request.headers.has('cookie') || /^(basic|digest)\s/i.test(request.headers.get('authorization') ?? '')
    : browserCredentials);
  // Was it sent by a browser from an origin that is neither the API's nor an allowed one (cors.origins)?
  function foreignOrigin(ctx) {
    const sent = ctx.request.headers.get('origin'), site = ctx.request.headers.get('sec-fetch-site');
    if (sent === null) return site === 'cross-site' || site === 'same-site';
    if (sent === 'null') return site !== 'same-origin'; // Referrer-Policy: no-referrer manda Origin: null a su propio origen
    return sent !== origin(ctx.url) && !(Array.isArray(corsOrigins) && corsOrigins.includes(sent));
  }

  // 5.9: GET, HEAD and PATCH of a singleton; POST and DELETE give 405.
  // 5.9: the singleton a path names, with the ids its variables take, or null.
  function matchSingleton(rel) {
    const segs = rel.slice(1).split('/');
    for (const s of Object.values(singles)) {
      if (s.segments.length !== segs.length) continue;
      const ids = {};
      if (s.segments.every((x, i) => { const v = VARIABLE.exec(x); if (v) { ids[v[1]] = segs[i]; return isId(segs[i]); } return x === segs[i]; })) return { s, ids };
    }
    return null;
  }
  // 5.9: a singleton with parent exists while its parent does: under an item that does not exist, 404.
  async function parentsExist(s, ids, ctx) {
    if (s.parent === undefined) return true;
    const pc = colls[s.parent];
    if (pc) {
      const v = VARIABLE.exec(s.segments[pc.path.slice(1).split('/').length])[1];
      const item = await pc.data.get(ids[v], { ...ctx, collection: pc });
      return !!item && String(item.id) === ids[v];
    }
    const ps = singles[s.parent];
    return (await parentsExist(ps, ids, ctx)) && !!(await ps.data.get({ ...ctx, collection: ps, ids }));
  }
  async function serveSingleton(s, ctx, ids = {}) {
    ctx.ids = ids;
    ctx.selfPath = `${base}/${s.segments.map((x) => { const v = VARIABLE.exec(x); return v ? ids[v[1]] : x; }).join('/')}`;
    if (!(await parentsExist(s, ids, ctx))) throw notFound(ctx.path);
    if (!s.methods.includes(ctx.method) && ctx.method !== 'HEAD') {
      const allow = [...s.methods, 'HEAD'].join(', ');
      throw new RestepError(405, 'method_not_allowed', t(`Supports ${allow}.`, `Admite ${allow}.`), { headers: { Allow: allow } });
    }
    // 5.9: include and the other reserved parameters, except fields on a read, give unsupported_parameter.
    checkReserved(ctx.url.searchParams, ctx.read ? ['fields'] : []);
    ctx.preferMinimal = /(^|[ ,;])return=minimal\b/.test(ctx.request.headers.get('prefer') ?? '');
    if (ctx.read) {
      const raw = await s.data.get({ ...ctx, collection: s });
      if (!raw) throw notFound(ctx.path); // 5.9 and 4.2: the adapter returns null for a principal that cannot use it
      return readItem(s, raw, ctx);
    }
    const write = (x) => writeItem(s, undefined, x);
    return createTransaction ? createTransaction((transaction) => write({ ...ctx, transaction }), ctx) : write(ctx);
  }

  async function route(ctx) {
    const { url, method } = ctx;
    // 11.5: the metadata is public and is not an API resource.
    if (oauth && url.pathname === metadataPath) {
      if (!ctx.read) throw new RestepError(405, 'method_not_allowed', t('Only GET and HEAD.', 'Solo GET y HEAD.'), { headers: { Allow: 'GET, HEAD' } });
      const meta = { resource: `${origin(url)}${base}/`, authorization_servers: oauth.authorizationServers,
        ...(oauth.scopesSupported && { scopes_supported: oauth.scopesSupported }), bearer_methods_supported: ['header'] };
      return new Response(method === 'HEAD' ? null : JSON.stringify(meta), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' } });
    }
    // 4.4: the service status, outside the API: no profile links or problem+json.
    if (statusPath && url.pathname === statusPath) {
      if (!ctx.read) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } });
      let ok = true;
      try { ok = status.check ? !!(await status.check()) : true; } catch { ok = false; }
      return new Response(method === 'HEAD' ? null : JSON.stringify({ status: ok ? 'pass' : 'fail' }),
        { status: ok ? 200 : 503, headers: { 'Content-Type': 'application/health+json', 'Cache-Control': 'no-store' } });
    }
    // 3: each path segment is compared after percent-decoding (/books/%37 is /books/7). A segment
    // that has "/" once decoded is not any API path.
    let segments;
    try { segments = url.pathname.split('/').slice(1).map(decodeURIComponent); } catch { throw notFound(url.pathname); }
    if (segments.some((s) => s.includes('/'))) throw notFound(url.pathname);
    ctx.path = `/${segments.join('/')}`;
    if (ctx.path !== `${base}/` && !ctx.path.startsWith(`${base}/`)) throw notFound(url.pathname);
    setPrincipal(ctx, await principalOf(ctx.request, url));
    // 5.8 (step 1 of the order in 5.4): a write with credentials the browser adds by itself, from an origin
    // that is neither the API's nor an allowed one, gives 403 without effect.
    if (!ctx.read && ctx.principal != null && browserCredentialed(ctx.request) && foreignOrigin(ctx))
      throw new RestepError(403, 'forbidden', t('This origin may not write with these credentials.', 'Este origen no puede escribir con estas credenciales.'));
    // 5.1: a method the server does not know at all gets 501.
    if (!KNOWN_METHODS.includes(method)) throw new RestepError(501, 'not_implemented', t(`This server does not know the method ${method}.`, `Este servidor no conoce el método ${method}.`));
    const rel = ctx.path.slice(base.length);
    if (rel === '/') return serveDiscovery(ctx);

    // 11.1: the new action of a collection (GET /books:new); the colon may arrive as %3A.
    const action = Object.values(colls).find((x) => x.newItem && rel === `${x.path}:new`);
    if (action) return newItem(action, ctx);
    const single = matchSingleton(rel);
    if (single) return serveSingleton(single.s, ctx, single.ids);

    let c, id;
    for (const x of Object.values(colls)) {
      if (rel === x.path) { c = x; break; }
      if (rel.startsWith(`${x.path}/`)) {
        const rest = rel.slice(x.path.length + 1);
        // An id is unreserved characters (3); anything else (an action's colon, another segment) does not exist.
        if (isId(rest)) { c = x; id = rest; }
        break;
      }
    }
    if (!c) throw notFound(url.pathname);
    let raw;
    if (id !== undefined) { // 5.4: the 404 goes before the 405 and the 400
      raw = await c.data.get(id, { ...ctx, collection: c });
      // 3: an id is compared code point by code point; an adapter that returns another (07 for 7) is not valid.
      // 5.1: a PATCH to a free id of a collection with upsert is not a request to something that does not exist.
      if ((!raw || String(raw.id) !== id) && !(c.upsert && method === 'PATCH')) throw notFound(url.pathname);
    }
    const methods = id === undefined ? c.methods : c.itemMethods;
    // 4.3: Allow lists every supported method, and HEAD wherever it lists GET.
    if (!methods.includes(method === 'HEAD' ? 'GET' : method)) {
      const allow = [...methods, ...(methods.includes('GET') ? ['HEAD'] : [])].join(', ');
      throw new RestepError(405, 'method_not_allowed', t(`Supports ${allow}.`, `Admite ${allow}.`), { headers: { Allow: allow } });
    }
    checkReserved(url.searchParams, !ctx.read ? [] : id === undefined ? ['filter', 'sort', 'fields', 'count', 'limit', 'cursor'] : ['fields']);
    ctx.preferMinimal = /(^|[ ,;])return=minimal\b/.test(ctx.request.headers.get('prefer') ?? '');

    if (ctx.read && id === undefined) {
      const data = await listCollection(c, ctx);
      const tag = await etagOf(data);
      const headers = { ETag: tag, 'Cache-Control': cacheControl(ctx, 'no-cache'),
        'Cache-Groups': groups([`${base}${c.path}`, ...data.items.map((r) => itemPath(c, r.id))]),
        // 5.6: localized fields, and the items and order that depend on them, change with Accept-Language.
        ...(c.localized.length && { Vary: 'Accept-Language', 'Content-Language': ctx.lang }) };
      if (ctx.request.headers.get('if-match') !== null && !strongMatch(ctx.request.headers.get('if-match'), tag))
        throw new RestepError(412, 'precondition_failed', t('If-Match does not match the current representation.', 'If-Match no coincide con la representación actual.'));
      if (weakMatch(ctx.request.headers.get('if-none-match'), tag)) return respond(ctx, 304, undefined, headers);
      return respond(ctx, 200, data, headers);
    }
    if (ctx.read) return readItem(c, raw, ctx);
    const write = id === undefined ? (x) => create(c, x) : (x) => writeItem(c, id, x);
    return createTransaction ? createTransaction((transaction) => write({ ...ctx, transaction }), ctx) : write(ctx);
  }

  // CORS (5.8, optional) for browser clients, like the explorer: cors: true (any origin) or
  // cors: { origins: ['https://…'] }. It answers the preflight without Restep rules and exposes the headers
  // a Restep client needs to read (ETag to write with If-Match, Location, Link, Allow, Retry-After…).
  // With a list of origins, the response depends on Origin: Vary: Origin on all of them, also without Origin.
  const corsOrigins = cors === true ? '*' : cors?.origins ?? null;
  const varyOrigin = Array.isArray(corsOrigins);
  const EXPOSE = 'ETag, Location, Content-Location, Link, Allow, Accept-Patch, Accept-Post, Accept-Query, Retry-After, Content-Language, Deprecation, Sunset, Idempotent-Replayed, Preference-Applied, Cache-Groups, Cache-Group-Invalidation, WWW-Authenticate, DPoP-Nonce';
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

// ── Framework adapters ────────────────────────────────────────────────────────
// Node http: createServer(toNodeListener(api)).listen(8080). origin fixes the public origin if a proxy sits in front.
export function toNodeListener(api, { origin } = {}) {
  return (req, res) => { serveNode(api, req, res, { origin }).catch((e) => { console.error(e); if (!res.headersSent) res.writeHead(500); res.end(); }); };
}
// Express: app.use(toExpress(api)), or app.use('/api', toExpress(api)) with base: '/api'. It uses req.originalUrl,
// so the full path arrives intact. If a body parser already read the body, it serializes it again.
export function toExpress(api, { origin } = {}) {
  return (req, res, next) => { serveNode(api, req, res, { origin, url: req.originalUrl }).catch(next); };
}
// Hono: app.all('*', toHono(api)). Hono already works with Request and Response.
export const toHono = (api) => (c) => api.handle(c.req.raw);

async function serveNode(api, req, res, { origin, url }) {
  const proto = req.socket?.encrypted ? 'https' : 'http';
  const full = new URL(url ?? req.url, origin ?? `${proto}://${req.headers.host ?? 'localhost'}`);
  const headers = new Headers();
  for (let i = 0; i < (req.rawHeaders ?? []).length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  const init = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (req.body !== undefined && (req.readableEnded || req.complete)) {
      // An Express body parser already consumed it: it is rebuilt (bodies are compared as JSON values).
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
