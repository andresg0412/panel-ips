// Acceso de emergencia: genera una contraseña temporal para un usuario cuando no hay otra salida (el correo no llega,
// soporte perdió su contraseña). Se ejecuta DENTRO del contenedor, con acceso al servidor:
//
//   docker exec panel-ips node dist/server/scripts/acceso-emergencia.js soporte
//
// Imprime la contraseña UNA sola vez en la salida estándar (no se guarda en claro en ningún lado), vence en 24 h y
// obliga a cambiarla al entrar. Deja un evento `acceso_emergencia` con actor `consola` y cierra las sesiones abiertas
// de esa cuenta. Sale con código distinto de 0 si algo falla.
import { pool, poolApp } from '../db.js';
import { CLAVE } from '../auth/configuracion.js';
import { generarTemporal, hashear } from '../auth/contrasenas.js';
import { buscarPorUsuario, conTransaccion, guardarContrasena } from '../auth/cuentas.js';
import { registrarEvento } from '../auth/eventos.js';
import { revocarSesionesDeUsuario } from '../auth/sesiones.js';

async function principal(): Promise<number> {
  const usuario = process.argv[2]?.trim();
  if (!usuario) {
    console.error('Uso: node dist/server/scripts/acceso-emergencia.js <usuario>');
    return 2;
  }
  if (!poolApp) {
    console.error('DATABASE_URL_APP no está configurada.');
    return 1;
  }
  const cuenta = await buscarPorUsuario(usuario);
  if (!cuenta) {
    console.error(`El usuario "${usuario}" no existe.`);
    return 1;
  }
  if (!cuenta.activo) {
    console.error(`El usuario "${usuario}" está desactivado: actívelo primero desde la consola de soporte.`);
    return 1;
  }
  const temporal = generarTemporal();
  const venceAt = new Date(Date.now() + CLAVE.temporalVigenciaMs);
  const hash = await hashear(temporal);
  await conTransaccion((cli) => guardarContrasena(cli, usuario, hash, { debeCambiar: true, temporalExpiraAt: venceAt }));
  const cerradas = await revocarSesionesDeUsuario(usuario, 'soporte');
  await registrarEvento({ tipo: 'acceso_emergencia', usuario, actor: 'consola', detalle: `temporal generada; sesiones cerradas: ${cerradas}` });
  console.error(`Contraseña temporal de "${usuario}" (vence ${venceAt.toISOString()}, debe cambiarla al entrar). No se volverá a mostrar:`);
  console.log(temporal);
  return 0;
}

let codigo = 1;
try {
  codigo = await principal();
} catch (e) {
  console.error(`No se pudo generar el acceso de emergencia: ${(e as Error).message}`);
} finally {
  await poolApp?.end().catch(() => {});
  await pool.end().catch(() => {});
}
process.exit(codigo);
