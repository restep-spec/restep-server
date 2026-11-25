// Example server built with restep-server: the El Marcapáginas bookshop, with data similar to that
// of the reference server (vendor/restep-server.mjs). Usage: PORT=8810 node example.mjs
// With RESTEP_TOKEN=secret it also announces the oauth extension and requires Authorization: Bearer secret.
import { createServer } from 'node:http';
import { toNodeListener } from './restep-server.mjs';
import { exampleApi } from './example-api.mjs';

export { exampleApi };

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8810);
  const api = exampleApi();
  createServer(toNodeListener(api)).listen(port, () =>
    console.log(`restep-server example (${[...api.profiles, ...api.extensions].join(', ')}) at http://localhost:${port}/`));
}
