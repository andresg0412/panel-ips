import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';
import { ErrorParametro } from './params.js';
import rutasResumen from './routes/resumen.js';
import rutasCampanas from './routes/campanas.js';
import rutasAgenda from './routes/agenda.js';
import rutasChatbot from './routes/chatbot.js';
import rutasListaEspera from './routes/listaEspera.js';
import rutasPacientes from './routes/pacientes.js';
import rutasSistema from './routes/sistema.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: true });

app.setErrorHandler((err, req, reply) => {
  if (err instanceof ErrorParametro) return reply.code(400).send({ error: err.message });
  const e = err as { code?: string; message: string };
  // 57014 = statement_timeout de Postgres.
  if (e.code === '57014') {
    req.log.warn({ url: req.url }, 'consulta cancelada por tiempo');
    return reply.code(503).send({ error: 'La consulta tardó demasiado. Pruebe con un rango de fechas más corto.' });
  }
  if (e.code === 'ECONNREFUSED' || e.code === '57P03' || e.code === 'ENOTFOUND') {
    return reply.code(503).send({ error: 'La base de datos no está disponible en este momento (posible despliegue en curso).' });
  }
  req.log.error(err);
  return reply.code(500).send({ error: 'Error interno del panel' });
});

// nginx (auth_basic) envía el usuario autenticado en X-Remote-User.
app.get('/api/yo', async (req) => ({ usuario: req.headers['x-remote-user'] ?? null }));

app.get('/api/health', async (_req, reply) => {
  try {
    await pool.query('SELECT 1');
    return { ok: true };
  } catch {
    return reply.code(503).send({ ok: false });
  }
});

await app.register(rutasResumen);
await app.register(rutasCampanas);
await app.register(rutasAgenda);
await app.register(rutasChatbot);
await app.register(rutasListaEspera);
await app.register(rutasPacientes);
await app.register(rutasSistema);

// Frontend compilado (dist/web). En desarrollo lo sirve Vite con proxy a /api.
const webDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
if (existsSync(webDir)) {
  // Los assets llevan hash en el nombre: se cachean un año. index.html nunca, para que tras un
  // despliegue el navegador pida siempre la versión nueva.
  await app.register(fastifyStatic, {
    root: webDir,
    cacheControl: false,
    setHeaders: (res, ruta) =>
      res.setHeader('Cache-Control', ruta.includes(`${join('web', 'assets')}`) ? 'public, max-age=31536000, immutable' : 'no-cache'),
  });
  // Rutas desconocidas de la SPA → index.html. Las de /api y /assets responden 404 de verdad,
  // para que un asset faltante no se sirva como HTML.
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api/') || req.url.startsWith('/assets/')
      ? reply.code(404).send({ error: 'No existe' })
      : reply.header('Cache-Control', 'no-cache').sendFile('index.html'),
  );
}

const cerrar = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', cerrar);
process.on('SIGINT', cerrar);

await app.listen({ port: Number(process.env.PORT ?? 8100), host: process.env.HOST ?? '0.0.0.0' });
