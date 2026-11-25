// Definition of the example API (the El Marcapáginas bookshop), without a server: used by example.mjs
// (Node) and by the demo published on a Worker (projects/restep-demo).
import { createRestep, memoryAdapter, memorySingleton, t } from './restep-server.mjs';

export function exampleApi({ token = globalThis.process?.env?.RESTEP_TOKEN, ...more } = {}) {
  return createRestep({
    languageTags: ['en', 'en-au', 'en-gb', 'es', 'es-es', 'es-mx'],
    status: { path: '/health' },
    docs: [{ href: 'https://restep.wubytes.com/1/', hreflang: 'en' }, { href: 'https://restep.wubytes.com/es/1/', hreflang: 'es' }],
    ...(token && { oauth: {
      authorizationServers: ['https://auth.example.com'], scopesSupported: ['books:read', 'books:write'],
      verifyToken: (tok) => (tok === token ? 'cliente-de-prueba' : null),
    } }),
    collections: {
      books: {
        description: t('Books in the catalogue of El Marcapáginas, one per edition.', 'Libros del catálogo de El Marcapáginas, uno por edición.'),
        // title, default, examples and labels guide the create form (4.3); the field order is theirs.
        fields: {
          title: { type: 'string', required: true, title: t('Title', 'Título'), examples: ['La niebla de Portugalete'] },
          price: { type: 'decimal', required: true, title: t('Price', 'Precio'), description: t('In euros, such as "18.50".', 'En euros, como "18.50".') },
          category: { type: 'enum', values: ['novela-negra', 'ciencia-ficcion', 'ensayo', 'poesia', 'infantil'], default: 'novela-negra',
            title: t('Category', 'Categoría'), labels: { 'novela-negra': t('Crime', 'Novela negra'), 'ciencia-ficcion': t('Science fiction', 'Ciencia ficción'),
              ensayo: t('Essay', 'Ensayo'), poesia: t('Poetry', 'Poesía'), infantil: t('Children', 'Infantil') } },
          year: { type: 'integer', title: t('Year', 'Año') },
          published: { type: 'date', title: t('Published', 'Publicado') },
          reading_time: { type: 'duration', title: t('Reading time', 'Tiempo de lectura'), examples: ['PT6H'] },
          rating: { type: 'number', title: t('Rating', 'Valoración') },
          signed: { type: 'boolean', default: false, title: t('Signed by the author', 'Firmado por el autor') },
        },
        // 11.1: GET /books:new gives the body of a create with what depends on the moment: today and this year.
        newItem: () => {
          const today = new Date().toISOString().slice(0, 10);
          return { year: Number(today.slice(0, 4)), published: today };
        },
        filter: { id: ['eq', 'in'], price: ['eq', 'lt', 'le', 'gt', 'ge'], category: ['eq', 'ne', 'in'],
          year: ['eq', 'lt', 'le', 'gt', 'ge'], rating: ['ge', 'null'], published: ['lt', 'ge'],
          reading_time: ['le', 'gt'], signed: ['eq', 'null'] },
        // 6.1: named filters, for what is not comparing a field. memoryAdapter uses apply;
        // a custom adapter receives { named, value } and translates it to its query.
        namedFilters: {
          bargain: { description: t('Under 15 euros and rated 4 or more.', 'Por debajo de 15 euros y con un 4 o más.'),
            apply: (r) => Number(r.price) < 15 && (r.rating ?? 0) >= 4 },
          search: { type: 'string', description: t('Title contains the text, case-insensitively.', 'El título contiene el texto, sin distinguir mayúsculas.'),
            apply: (r, v) => r.title.toLowerCase().includes(v.toLowerCase()) },
        },
        sort: ['id', 'title', 'price', 'rating', 'year', 'published'],
        maxLimit: 50, count: 'exact',
        data: memoryAdapter([
          { id: '7', title: 'La niebla de Portugalete', price: '18.50', rating: 4.6, year: 2025, category: 'novela-negra', published: '2025-03-14', reading_time: 'PT6H', signed: true },
          { id: '12', title: 'El último ferry', price: '16.90', rating: 4.3, year: 2023, category: 'novela-negra', published: '2023-10-02', reading_time: 'PT5H30M' },
          { id: '15', title: 'Lluvia sobre Deusto', price: '14.95', rating: 4.1, year: 2022, category: 'novela-negra', published: '2022-05-20', reading_time: 'P1DT2H', signed: false },
          { id: '21', title: 'Mareas de silicio', price: '19.90', rating: 4.4, year: 2026, category: 'ciencia-ficcion', published: '2026-01-09', reading_time: 'PT8H' },
          { id: '23', title: 'Cartografía del ruido', price: '21.00', rating: 4.0, year: 2026, category: 'ensayo', published: '2026-02-27' },
          { id: '30', title: 'Cuaderno de faros', price: '9.00', rating: 4.8, year: 2024, category: 'poesia', reading_time: 'PT2H' },
          { id: '50', title: 'Bajo la niebla', price: '11.90', year: 2025, category: 'infantil', published: '2025-11-30', reading_time: 'PT45M' },
        ]),
      },
      products: {
        description: t('Other products of the shop, with their name and description in several languages.',
          'Otros productos de la tienda, con su nombre y su descripción en varios idiomas.'),
        fields: { name: 'map', description: 'map', price: { type: 'decimal', required: true }, stock: 'integer',
          category: { type: 'relation', to: 'categories' } },
        filter: { id: ['eq', 'in'], price: ['eq', 'lt', 'le', 'gt', 'ge'], 'name.es-mx': ['eq', 'in'], 'name.en-gb': ['eq', 'in'], 'category.id': ['eq', 'in', 'null'] },
        sort: ['id', 'price', 'name.es-mx', 'name.en-gb'],
        count: 'estimated',
        data: memoryAdapter([
          { id: '1', name: { en: 'Eraser', 'en-au': 'Rubber', 'en-gb': 'Rubber', 'es-es': 'Goma de borrar', 'es-mx': 'Goma' },
            description: { en: 'A soft white eraser.', es: 'Una goma blanca y blanda.' }, price: '1.20', stock: 40, category: { id: '3' } },
          { id: '2', name: { en: 'Pencil case', 'en-gb': 'Pencil case', 'es-es': 'Estuche', 'es-mx': 'Lapicera' }, price: '6.50', stock: 12, category: { id: '1' } },
          { id: '3', name: { en: 'Bookmark', es: 'Marcapáginas', 'es-mx': 'Separador' }, price: '2.00', category: { id: '4' } },
          { id: '4', name: { en: 'Tote bag', 'en-au': 'Tote bag', 'es-es': 'Bolsa de tela' },
            description: { en: 'Cotton, with the shop’s logo.', 'es-es': 'De algodón, con el logo de la librería.' }, price: '9.90', stock: 5, category: { id: '1' } },
          { id: '5', name: { en: 'Book light', 'en-gb': 'Reading light', es: 'Lámpara de lectura' }, price: '14.50', stock: 3, category: '5' },
          { id: '6', price: '3.00', category: null },
        ]),
      },
      categories: {
        description: t('Product categories, nested.', 'Categorías de productos, anidadas.'),
        fields: { name: { type: 'string', required: true }, note: 'string', parent: { type: 'relation', to: 'categories' } },
        filter: { id: ['eq', 'in'], name: ['eq'], 'parent.id': ['eq', 'null'] },
        sort: ['id', 'name'],
        // 5.1: the client may choose the id (or let the server assign it); used ids do not come back.
        idFrom: 'either',
        // 6.1: the name is filtered and sorted without regard to case or accents.
        collations: { name: 'server' },
        // A rule of the API's own: a category cannot be its own ancestor.
        validate: async (row, ctx) => {
          const id = ctx.current?.id;
          for (let at = row.parent?.id, hops = 0; at && hops < 100; hops++) {
            if (at === id) return [{ pointer: '/parent', code: 'cycle', detail: t('That would make it its own ancestor.', 'Eso la haría su propia antecesora.') }];
            at = (await ctx.collection.data.get(at))?.parent?.id;
          }
          return [];
        },
        data: memoryAdapter([
          { id: '1', name: 'Papelería', note: 'Todo lo que no es libro.', parent: null },
          { id: '2', name: 'Libros', parent: null },
          { id: '3', name: 'Material escolar', note: 'Para la vuelta al cole.', parent: { id: '1' } },
          { id: '4', name: 'Libros infantiles', parent: { id: '2' } },
          { id: '5', name: 'Lámparas', parent: { id: '1' } },
        ]),
      },
    },
    // 5.9: a singleton, the shop's data.
    singletons: {
      shop: {
        description: t('The shop’s own details.', 'Los datos de la propia tienda.'),
        fields: { name: { type: 'string', required: true }, city: 'string', opening_hours: 'string',
          featured: { type: 'relation', to: 'categories', description: t('The category on the shop window.', 'La categoría del escaparate.') } },
        data: memorySingleton({ name: 'El Marcapáginas', city: 'Bilbao', opening_hours: 'L-S 10:00-20:00', featured: { id: '2' } }),
      },
    },
    ...more,
  });
}
