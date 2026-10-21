import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Serves the Vercel Functions in api/*.ts during `vite dev`, so the serverless relayer can be
 * exercised locally without the Vercel CLI. Server-only secrets must be present in process.env
 * (e.g. `node --env-file=../relayer/.env node_modules/vite/bin/vite.js`).
 */
function localApi(): Plugin {
  return {
    name: 'katalyst-local-api',
    configureServer(server) {
      server.middlewares.use('/api', async (req, res) => {
        try {
          const name = (req.url ?? '').split('?')[0]!.replace(/^\/+/, '').replace(/[^a-z0-9_-]/gi, '');
          const mod = (await server.ssrLoadModule(`/api/${name}.ts`)) as { GET?: (r: Request) => Promise<Response> };
          if (!mod.GET) {
            res.statusCode = 404;
            res.end('{"error":"not found"}');
            return;
          }
          const response = await mod.GET(new Request(`http://localhost${req.originalUrl ?? req.url ?? ''}`));
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(await response.text());
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'internal error' }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), localApi()],
  server: { port: 5173 },
  build: { target: 'es2022' },
});
