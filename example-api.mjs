// Definición de la API de ejemplo (la librería El Marcapáginas), sin servidor: la usan example.mjs
// (Node) y la demo publicada en un Worker (projects/restep-demo).
import { createRestep, memoryAdapter, t } from './restep-server.mjs';

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
        fields: {
          title: { type: 'string', required: true }, price: { type: 'decimal', required: true },
          rating: 'number', year: 'integer', published: 'date', reading_time: 'duration', signed: 'boolean',
          category: { type: 'enum', values: ['novela-negra', 'ciencia-ficcion', 'ensayo', 'poesia', 'infantil'] },
        },
        filter: { id: ['eq', 'in'], price: ['eq', 'lt', 'le', 'gt', 'ge'], category: ['eq', 'ne', 'in'],
          year: ['eq', 'lt', 'le', 'gt', 'ge'], rating: ['ge', 'null'], published: ['lt', 'ge'],
          reading_time: ['le', 'gt'], signed: ['eq', 'null'] },
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
        // Una regla propia de la API: una categoría no puede ser su propia antecesora.
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
    ...more,
  });
}
