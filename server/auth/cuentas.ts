// Acceso a datos de las cuentas: búsqueda por usuario o correo, guardado de contraseñas con su historial, y el
// aviso por correo de "su contraseña cambió". Lo usan las rutas de autenticación, la consola de soporte y los scripts.
import type { PoolClient } from 'pg';
import { poolApp, queryApp } from '../db.js';
import { CLAVE } from './configuracion.js';
import { verificar } from './contrasenas.js';
import { correoDisponible, enviarCorreo } from './correo.js';
import { registrarEvento } from './eventos.js';
import { plantillaContrasenaCambiada } from './plantillas.js';

export interface Cuenta {
  usuario: string;
  nombre: string | null;
  correo: string | null;
  activo: boolean;
  /** Hash scrypt, o null si la persona aún no tiene contraseña. */
  hash: string | null;
  debeCambiar: boolean;
  temporalExpiraAt: Date | null;
}

interface FilaCuenta {
  usuario: string;
  nombre: string | null;
  correo: string | null;
  activo: boolean;
  hash: string | null;
  debe_cambiar: boolean | null;
  temporal_expira_at: Date | null;
}

const COLUMNAS = `u.usuario, u.nombre, u.correo, u.activo, c.hash, c.debe_cambiar, c.temporal_expira_at`;

const aCuenta = (f: FilaCuenta): Cuenta => ({
  usuario: f.usuario,
  nombre: f.nombre,
  correo: f.correo,
  activo: f.activo,
  hash: f.hash,
  debeCambiar: f.debe_cambiar ?? false,
  temporalExpiraAt: f.temporal_expira_at,
});

/** Busca por usuario O por correo, sin distinguir mayúsculas. El identificador llega ya normalizado. */
export async function buscarPorIdentificador(id: string): Promise<Cuenta | null> {
  const [f] = await queryApp<FilaCuenta>(
    `SELECT ${COLUMNAS} FROM panel.usuarios u LEFT JOIN panel.credenciales c ON c.usuario = u.usuario
      WHERE lower(u.usuario) = $1 OR lower(u.correo) = $1 ORDER BY (lower(u.usuario) = $1) DESC LIMIT 1`,
    [id],
  );
  return f ? aCuenta(f) : null;
}

export async function buscarPorUsuario(usuario: string): Promise<Cuenta | null> {
  const [f] = await queryApp<FilaCuenta>(
    `SELECT ${COLUMNAS} FROM panel.usuarios u LEFT JOIN panel.credenciales c ON c.usuario = u.usuario WHERE u.usuario = $1`,
    [usuario],
  );
  return f ? aCuenta(f) : null;
}

export async function buscarActivaPorCorreo(correo: string): Promise<Cuenta | null> {
  const [f] = await queryApp<FilaCuenta>(
    `SELECT ${COLUMNAS} FROM panel.usuarios u LEFT JOIN panel.credenciales c ON c.usuario = u.usuario WHERE lower(u.correo) = $1 AND u.activo`,
    [correo],
  );
  return f ? aCuenta(f) : null;
}

// ------------------------------------------------------------------------------- transacciones
export async function conTransaccion<T>(fn: (cli: PoolClient) => Promise<T>): Promise<T> {
  if (!poolApp) throw new Error('DATABASE_URL_APP no está configurada');
  const cli = await poolApp.connect();
  try {
    await cli.query('BEGIN');
    const r = await fn(cli);
    await cli.query('COMMIT');
    return r;
  } catch (e) {
    await cli.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cli.release();
  }
}

// --------------------------------------------------------------------------------- historial
/** ¿La contraseña nueva es igual a la actual o a una de las 3 anteriores? (RF-27). Lee dentro de la transacción. */
export async function claveYaUsada(cli: PoolClient, usuario: string, nueva: string): Promise<boolean> {
  const { rows } = await cli.query<{ hash: string }>(
    `SELECT hash FROM panel.credenciales WHERE usuario = $1
     UNION ALL
     (SELECT hash FROM panel.contrasenas_previas WHERE usuario = $1 ORDER BY at DESC, id DESC LIMIT $2)`,
    [usuario, CLAVE.historial],
  );
  for (const { hash } of rows) if ((await verificar(nueva, hash)).ok) return true;
  return false;
}

export interface OpcionesGuardado {
  debeCambiar: boolean;
  temporalExpiraAt: Date | null;
}

/**
 * Guarda la contraseña nueva: la actual pasa al historial (que conserva solo las 3 más recientes) y la credencial
 * se crea o se reemplaza. Si la cuenta no tenía credencial, la crea (así funciona el primer acceso por correo).
 */
export async function guardarContrasena(cli: PoolClient, usuario: string, hashNuevo: string, op: OpcionesGuardado): Promise<void> {
  const { rows } = await cli.query<{ hash: string }>(`SELECT hash FROM panel.credenciales WHERE usuario = $1 FOR UPDATE`, [usuario]);
  if (rows.length) await cli.query(`INSERT INTO panel.contrasenas_previas (usuario, hash) VALUES ($1, $2)`, [usuario, rows[0].hash]);
  await cli.query(
    `INSERT INTO panel.credenciales (usuario, hash, debe_cambiar, temporal_expira_at, cambiada_at)
     VALUES ($1, $2, $3, $4::timestamptz, now())
     ON CONFLICT (usuario) DO UPDATE
        SET hash = EXCLUDED.hash, debe_cambiar = EXCLUDED.debe_cambiar, temporal_expira_at = EXCLUDED.temporal_expira_at, cambiada_at = now()`,
    [usuario, hashNuevo, op.debeCambiar, op.temporalExpiraAt ? op.temporalExpiraAt.toISOString() : null],
  );
  await cli.query(
    `DELETE FROM panel.contrasenas_previas WHERE usuario = $1
        AND id NOT IN (SELECT id FROM panel.contrasenas_previas WHERE usuario = $1 ORDER BY at DESC, id DESC LIMIT $2)`,
    [usuario, CLAVE.historial],
  );
}

// ------------------------------------------------------------------------------------- aviso
/**
 * Correo de "su contraseña cambió". Nunca lanza: si falla deja un evento `correo_fallido` (sin el contenido).
 * Se llama sin esperar (la respuesta al navegador no depende del correo).
 */
export async function avisarContrasenaCambiada(usuario: string, correo: string | null, ip: string | null, agente: string | null): Promise<void> {
  if (!correo || !correoDisponible()) return;
  try {
    const p = plantillaContrasenaCambiada(new Date());
    const r = await enviarCorreo({ para: [correo], asunto: p.asunto, texto: p.texto, html: p.html });
    if (!r.ok) await registrarEvento({ tipo: 'correo_fallido', usuario, ip, agente, detalle: `aviso de cambio: ${r.error ?? 'error'}` });
  } catch (e) {
    await registrarEvento({ tipo: 'correo_fallido', usuario, ip, agente, detalle: `aviso de cambio: ${(e as Error).message}`.slice(0, 200) });
  }
}
