// Servidor de ejemplo hecho con restep-server: la librería El Marcapáginas, con datos parecidos a los
// del servidor de referencia (vendor/restep-server.mjs). Uso: PORT=8810 node example.mjs
// Con RESTEP_TOKEN=secreto también anuncia la extensión oauth y exige Authorization: Bearer secreto.
import { createServer } from 'node:http';
import { toNodeListener } from './restep-server.mjs';
import { exampleApi } from './example-api.mjs';

export { exampleApi };

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8810);
  const api = exampleApi();
  createServer(toNodeListener(api)).listen(port, () =>
    console.log(`Ejemplo de restep-server (${[...api.profiles, ...api.extensions].join(', ')}) en http://localhost:${port}/`));
}
