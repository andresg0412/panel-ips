// Sesión de verificación para los despliegues: crea una sesión de 5 minutos de `soporte` e imprime el valor de la
// cookie, para comprobar con curl las rutas autenticadas del panel recién desplegado:
//
//   C=$(docker exec panel-ips node dist/server/scripts/sesion-verificacion.js)
//   curl -H "Cookie: __Host-panel_sesion=$C" 127.0.0.1:8100/api/yo
//
// Solo imprime el token en la salida estándar (todo lo demás va a la de errores). Deja un evento con actor
// `despliegue`. Se ejecuta dentro del contenedor; sale con código distinto de 0 si algo falla.
import { createHash, randomBytes } from 'node:crypto';
import { pool, poolApp, queryApp } from '../db.js';
import { SESION } from '../auth/configuracion.js';
import { registrarEvento } from '../auth/eventos.js';

/** Duración de la sesión de verificación. */
const VIGENCIA_MS = 5 * 60_000;

async function principal(): Promise<number> {
  const usuario = process.argv[2]?.trim() || 'soporte';
  if (!poolApp) {
    console.error('DATABASE_URL_APP no está configurada.');
    return 1;
  }
  const [cuenta] = await queryApp<{ activo: boolean }>(`SELECT activo FROM panel.usuarios WHERE usuario = $1`, [usuario]);
  if (!cuenta?.activo) {
    console.error(`El usuario "${usuario}" no existe o está desactivado.`);
    return 1;
  }
  const token = randomBytes(SESION.tokenBytes).toString('base64url');
  const ahora = Date.now();
  await queryApp(
    `INSERT INTO panel.sesiones (token_hash, usuario, mantener, creada_at, ultima_actividad_at, expira_at, reautenticada_at)
     VALUES ($1, $2, false, $3::timestamptz, $3::timestamptz, $4::timestamptz, $3::timestamptz)`,
    [createHash('sha256').update(token).digest(), usuario, new Date(ahora).toISOString(), new Date(ahora + VIGENCIA_MS).toISOString()],
  );
  // Tipo propio: no es un inicio de sesión de la persona, y no debe alterar su "último acceso".
  await registrarEvento({ tipo: 'sesion_verificacion', usuario, actor: 'despliegue', detalle: 'sesión de verificación de 5 minutos' });
  console.log(token);
  return 0;
}

let codigo = 1;
try {
  codigo = await principal();
} catch (e) {
  console.error(`No se pudo crear la sesión de verificación: ${(e as Error).message}`);
} finally {
  await poolApp?.end().catch(() => {});
  await pool.end().catch(() => {});
}
process.exit(codigo);
