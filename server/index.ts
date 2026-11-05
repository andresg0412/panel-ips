import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, poolApp } from './db.js';
import { incidentes, recargarIncidentes } from './incidentes.js';
import { prepararEsquema } from './esquema.js';
import { instalarAcceso } from './acceso.js';
import { manejarError } from './errores.js';
import { instalarCabeceras } from './cabeceras.js';
import { modoAuth, validarConfiguracion } from './auth/configuracion.js';
import { precalentarContrasenas } from './auth/contrasenas.js';
import { instalarRecortes } from './recortes.js';
import { recargarOcultos } from './ocultos.js';

// Configuración de autenticación: si falta algo, el proceso NO arranca (H6, H24). Es mejor un contenedor caído
// que un panel abierto. Solo se informa QUÉ variable falta, nunca su valor.
try {
  validarConfiguracion();
} catch (e) {
  console.error(`Configuración inválida del panel: ${(e as Error).message}`);
  process.exit(1);
}

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: true });

app.setErrorHandler(manejarError);

await app.register(fastifyCookie);
instalarCabeceras(app);

// Esquema propio del panel e incidentes de datos, antes de cargar las rutas: sql.ts arma sus rangos de
// incidentes al importarse.
try {
  await prepararEsquema((m) => app.log.info(m));
  await recargarIncidentes();
} catch (e) {
  // Con login propio, un esquema sin preparar deja sin tablas de sesión: el panel no debe quedar abierto (H7).
  if (modoAuth() === 'sesion') {
    app.log.error(e, 'no se pudo preparar el esquema panel; se detiene el panel');
    process.exit(1);
  }
  app.log.error(e, 'no se pudo preparar el esquema panel; se usan los incidentes base');
}
void precalentarContrasenas();

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
  './routes/envios.js', './routes/conversaciones.js', './routes/auth.js',
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
