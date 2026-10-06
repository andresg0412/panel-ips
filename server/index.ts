import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, poolApp } from './db.js';
import { ErrorParametro } from './params.js';
import { incidentes, recargarIncidentes } from './incidentes.js';
import { prepararEsquema } from './esquema.js';
import { instalarAcceso, registrarError } from './acceso.js';
import { instalarRecortes } from './recortes.js';
import { recargarOcultos } from './ocultos.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: true });

app.setErrorHandler((err, req, reply) => {
  if (err instanceof ErrorParametro) return reply.code(400).send({ error: err.message });
  const e = err as { code?: string; message: string; validation?: unknown; statusCode?: number };
  if (e.validation) return reply.code(400).send({ error: `Datos inválidos: ${e.message}` });
  if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message });
  // 57014 = statement_timeout de Postgres.
  if (e.code === '57014') {
    req.log.warn({ url: req.url }, 'consulta cancelada por tiempo');
    registrarError('timeout');
    return reply.code(503).send({ error: 'La consulta tardó demasiado. Pruebe con un rango de fechas más corto.' });
  }
  if (e.code === 'ECONNREFUSED' || e.code === '57P03' || e.code === 'ENOTFOUND') {
    registrarError('bd');
    return reply.code(503).send({ error: 'La base de datos no está disponible en este momento (posible despliegue en curso).' });
  }
  req.log.error(err);
  registrarError('interno');
  return reply.code(500).send({ error: 'Error interno del panel' });
});

// Esquema propio del panel e incidentes de datos, antes de cargar las rutas: sql.ts arma sus rangos de
// incidentes al importarse.
try {
  await prepararEsquema((m) => app.log.info(m));
  await recargarIncidentes();
} catch (e) {
  app.log.error(e, 'no se pudo preparar el esquema panel; se usan los incidentes base');
}

// Identidades ocultas (ocultos.ts): antes de atender, y luego cada 10 minutos. Si fallara, el panel arranca sin
// ocultar nada y lo registra; no se bloquea el arranque.
try {
  await recargarOcultos((m) => app.log.info(m));
} catch (e) {
  app.log.error(e, 'no se pudieron cargar las identidades ocultas');
}
setInterval(() => void recargarOcultos().catch((e) => app.log.error(e, 'no se pudieron recargar las identidades ocultas')), 10 * 60_000).unref();

instalarAcceso(app);
instalarRecortes(app);

app.get('/api/health', async (_req, reply) => {
  try {
    await pool.query('SELECT 1');
    return { ok: true };
  } catch {
    return reply.code(503).send({ ok: false });
  }
});

// Incidentes de datos conocidos (TR-01): el frontend los sombrea en los gráficos de tiempo.
app.get('/api/incidentes', async () => ({ incidentes: incidentes() }));

const rutas = [
  './routes/plan.js', './routes/resumen.js', './routes/campanas.js', './routes/agenda.js', './routes/chatbot.js',
  './routes/listaEspera.js', './routes/pacientes.js', './routes/sistema.js', './routes/profesionales.js',
  './routes/alertas.js', './routes/campanas2.js', './routes/oleada2.js', './routes/soporte.js', './routes/sala.js',
  './routes/historias.js', './routes/capacidad.js', './routes/informe.js', './routes/inteligencia.js',
  './routes/envios.js',
];
for (const r of rutas) await app.register((await import(r)).default);

const { iniciarVigilante } = await import('./vigilante.js');
const detenerVigilante = iniciarVigilante();

// Entrena el modelo de inasistencia en segundo plano (tarda unos segundos), para que la primera consulta no espere.
const { modeloInasistencia } = await import('./prediccion.js');
setTimeout(() => void modeloInasistencia().catch((e) => app.log.warn(e, 'no se pudo entrenar el modelo de inasistencia')), 30_000).unref();

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
  detenerVigilante();
  await app.close();
  await pool.end();
  await poolApp?.end();
  process.exit(0);
};
process.on('SIGTERM', cerrar);
process.on('SIGINT', cerrar);

await app.listen({ port: Number(process.env.PORT ?? 8100), host: process.env.HOST ?? '0.0.0.0' });
