import pg from 'pg';

// Los DATE de Postgres llegan como texto 'YYYY-MM-DD' (sin conversión a Date con zona horaria)
// y los BIGINT de COUNT/SUM como número: los valores del panel nunca se acercan a 2^53.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.TIMESTAMP, (v) => v.replace(' ', 'T').slice(0, 19));

// Pool pequeño a propósito: el panel comparte Postgres con el backend del bot.
// El rol panel_lectura además tiene CONNECTION LIMIT 5, read-only y statement_timeout propios.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  idleTimeoutMillis: 30_000,
  // Con pool de 3, las peticiones esperan turno: un dashboard dispara ~15 consultas a la vez.
  connectionTimeoutMillis: 30_000,
  statement_timeout: 15_000,
  application_name: 'panel-ips',
});

pool.on('error', (err) => {
  console.error('Error en conexión inactiva de Postgres:', err.message);
});

/**
 * Segunda conexión, con el rol panel_app: solo puede escribir en el esquema `panel` (licencia, usuarios y roles,
 * alertas de soporte, actividad, incidentes). No tiene permisos sobre las tablas del bot ni del backend.
 * Ver deploy/crear-esquema-panel.sql.
 */
export const poolApp = process.env.DATABASE_URL_APP
  ? new pg.Pool({
      connectionString: process.env.DATABASE_URL_APP,
      max: 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 10_000,
      application_name: 'panel-ips-app',
    })
  : null;

poolApp?.on('error', (err) => {
  console.error('Error en conexión inactiva de Postgres (panel_app):', err.message);
});

export async function queryApp<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (!poolApp) throw new Error('DATABASE_URL_APP no está configurada');
  const res = await poolApp.query(sql, params);
  return res.rows as T[];
}

export async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(sql, params);
  return res.rows as T[];
}

export async function queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const rows = await query<T>(sql, params);
  return rows[0];
}
