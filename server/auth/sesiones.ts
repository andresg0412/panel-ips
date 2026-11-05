// Sesiones del panel: token aleatorio en una cookie HttpOnly; en la base solo su SHA-256. Sección 11.3.
//
// Tres cosas hacen que esto sea correcto y barato a la vez:
//  1. Caché de 30 s de la lectura de cada sesión (el tablero dispara ~15 consultas y `poolApp` tiene 2 conexiones, H5).
//  2. La última actividad se actualiza en memoria al instante y se vuelca a la base cada 60 s, por lotes.
//  3. Toda revocación escribe en la base y BORRA la entrada de la caché en el mismo paso: por eso cerrar sesión,
//     cambiar la contraseña o desactivar a alguien surte efecto de inmediato pese a los 30 s de caché.
import { createHash, randomBytes } from 'node:crypto';
import '@fastify/cookie'; // tipos de req.cookies y reply.setCookie
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { queryApp } from '../db.js';
import { SESION, esProduccion, tiposSesion, type MotivoCierre } from './configuracion.js';
import { registrarEvento } from './eventos.js';
import { agenteDe, equipoDe, ipDe } from './red.js';

export interface SesionActiva {
  id: string;
  usuario: string;
  mantener: boolean;
  creadaAt: number;
  ultimaActividad: number;
  expiraAt: number;
  reautenticadaAt: number;
  debeCambiar: boolean;
  /** Cuándo se leyó por última vez de la base (para la caché de 30 s). */
  leidaAt: number;
  ip: string | null;
  agente: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Sesión ya resuelta en esta petición (undefined = aún no se intentó). */
    sesionPanel?: SesionActiva | null;
  }
}

const sha256 = (token: string) => createHash('sha256').update(token).digest();
const aHex = (b: Buffer) => b.toString('hex');

const cache = new Map<string, SesionActiva>();
/** id de sesión → clave de caché, para poder quitarla al revocar por id. */
const clavePorId = new Map<string, string>();
/** Sesiones con actividad en memoria que aún no se volcó a la base. */
const sucias = new Set<SesionActiva>();

// ------------------------------------------------------------------------------------- SQL común
const seg = (ms: number) => Math.round(ms / 1000);
/** Sesión que sigue viva: no cerrada, no vencida por tiempo máximo y con actividad dentro de su tope de inactividad. */
export const SQL_SESION_ACTIVA = `s.cerrada_at IS NULL AND s.expira_at > now()
  AND s.ultima_actividad_at > now() - (CASE WHEN s.mantener THEN ${seg(SESION.mantenida.inactividadMs)} ELSE ${seg(SESION.normal.inactividadMs)} END) * interval '1 second'`;

// ------------------------------------------------------------------------------------- cookie
export const nombreCookie = () => (esProduccion() ? SESION.cookieProduccion : SESION.cookieOtros);

function opcionesCookie(mantener: boolean) {
  return {
    httpOnly: true,
    secure: esProduccion(),
    sameSite: 'lax' as const,
    path: '/',
    // Sesión normal: cookie de navegador (sin Max-Age). Mantenida: 7 días.
    ...(mantener ? { maxAge: SESION.mantenida.maxAgeS } : {}),
  };
}

export function ponerCookie(reply: FastifyReply, token: string, mantener: boolean) {
  reply.setCookie(nombreCookie(), token, opcionesCookie(mantener));
}

export function borrarCookie(reply: FastifyReply) {
  reply.clearCookie(nombreCookie(), { httpOnly: true, secure: esProduccion(), sameSite: 'lax', path: '/' });
}

const TOKEN_MAX = 128;

export function tokenDe(req: FastifyRequest): string | null {
  const v = req.cookies?.[nombreCookie()];
  return typeof v === 'string' && v.length > 0 && v.length <= TOKEN_MAX ? v : null;
}

// --------------------------------------------------------------------------------------- lectura
interface FilaSesion {
  id: string;
  usuario: string;
  mantener: boolean;
  creada_at: Date;
  ultima_actividad_at: Date;
  expira_at: Date;
  reautenticada_at: Date;
  cerrada_at: Date | null;
  ip: string | null;
  agente: string | null;
  debe_cambiar: boolean;
}

const LEER_SESION = `SELECT s.id, s.usuario, s.mantener, s.creada_at, s.ultima_actividad_at, s.expira_at, s.reautenticada_at, s.cerrada_at,
         host(s.ip) AS ip, s.agente, coalesce(c.debe_cambiar, false) AS debe_cambiar
    FROM panel.sesiones s LEFT JOIN panel.credenciales c ON c.usuario = s.usuario
   WHERE s.token_hash = $1`;

function quitarDeCache(clave: string) {
  const s = cache.get(clave);
  if (s) {
    sucias.delete(s);
    clavePorId.delete(s.id);
  }
  cache.delete(clave);
}

/** Cierra una sesión vencida (por inactividad o por tiempo) y deja constancia, una sola vez. */
async function cerrarVencida(s: SesionActiva, clave: string, motivo: 'inactividad' | 'maxima') {
  quitarDeCache(clave);
  const r = await queryApp(`UPDATE panel.sesiones SET cerrada_at = now(), motivo_cierre = $2 WHERE id = $1 AND cerrada_at IS NULL RETURNING id`, [s.id, motivo]);
  if (r.length) await registrarEvento({ tipo: 'sesion_expirada', usuario: s.usuario, ip: s.ip, agente: s.agente, detalle: motivo });
}

/** Sesión válida del token, o null. Lee de la caché si tiene menos de 30 s; si no, de la base. */
export async function resolverToken(token: string): Promise<SesionActiva | null> {
  const clave = aHex(sha256(token));
  const ahora = Date.now();
  let s = cache.get(clave);
  if (!s || ahora - s.leidaAt > SESION.cacheMs) {
    const [fila] = await queryApp<FilaSesion>(LEER_SESION, [Buffer.from(clave, 'hex')]);
    if (!fila || fila.cerrada_at) {
      quitarDeCache(clave);
      return null;
    }
    const datos = {
      id: fila.id,
      usuario: fila.usuario,
      mantener: fila.mantener,
      creadaAt: fila.creada_at.getTime(),
      expiraAt: fila.expira_at.getTime(),
      reautenticadaAt: fila.reautenticada_at.getTime(),
      debeCambiar: fila.debe_cambiar,
      leidaAt: ahora,
      ip: fila.ip,
      agente: fila.agente,
    };
    if (s) {
      // Si la caché expiró, se conserva la actividad más reciente entre la memoria y la base (la memoria puede ir adelante).
      Object.assign(s, datos, { ultimaActividad: Math.max(s.ultimaActividad, fila.ultima_actividad_at.getTime()) });
    } else {
      s = { ...datos, ultimaActividad: fila.ultima_actividad_at.getTime() };
      cache.set(clave, s);
      clavePorId.set(s.id, clave);
    }
  }
  if (ahora >= s.expiraAt) {
    await cerrarVencida(s, clave, 'maxima');
    return null;
  }
  if (ahora - s.ultimaActividad > tiposSesion(s.mantener).inactividadMs) {
    await cerrarVencida(s, clave, 'inactividad');
    return null;
  }
  return s;
}

/** Sesión de la petición (una sola lectura por petición). */
export async function resolverSesion(req: FastifyRequest): Promise<SesionActiva | null> {
  if (req.sesionPanel !== undefined) return req.sesionPanel;
  const token = tokenDe(req);
  req.sesionPanel = token ? await resolverToken(token) : null;
  return req.sesionPanel;
}

/** Las consultas automáticas del navegador (tableros, alertas, chat) llevan esta cabecera y NO cuentan como actividad (H4). */
export const esSondeo = (req: FastifyRequest) => req.headers['x-panel-sondeo'] === '1';

/** Marca actividad real: se actualiza la memoria al instante y se vuelca a la base después. */
export function tocarSesion(s: SesionActiva) {
  s.ultimaActividad = Date.now();
  sucias.add(s);
}

// ----------------------------------------------------------------------------------- volcado
export async function volcarSesiones(): Promise<void> {
  if (!sucias.size) return;
  const lote = [...sucias];
  sucias.clear();
  try {
    await queryApp(
      `UPDATE panel.sesiones s SET ultima_actividad_at = v.t
         FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::timestamptz[]) AS t) v
        WHERE s.id = v.id AND s.cerrada_at IS NULL AND s.ultima_actividad_at < v.t`,
      [lote.map((s) => s.id), lote.map((s) => new Date(s.ultimaActividad).toISOString())],
    );
  } catch (e) {
    // Se reintenta en el siguiente ciclo.
    for (const s of lote) sucias.add(s);
    console.error('No se pudo guardar la actividad de las sesiones:', (e as Error).message);
  }
}

/** Una entrada que nadie ha pedido en este tiempo se olvida (la caché no debe crecer con sesiones que ya no vuelven). */
const CACHE_OLVIDO_MS = 10 * 60_000;

function purgarCache() {
  const limite = Date.now() - CACHE_OLVIDO_MS;
  for (const [clave, s] of cache) if (s.leidaAt < limite && !sucias.has(s)) quitarDeCache(clave);
}

export function instalarVolcadoSesiones(app: FastifyInstance) {
  const t = setInterval(() => {
    void volcarSesiones();
    purgarCache();
  }, SESION.volcadoMs);
  t.unref();
  app.addHook('onClose', async () => {
    clearInterval(t);
    await volcarSesiones();
  });
}

// ----------------------------------------------------------------------------------- creación
export interface SesionNueva {
  id: string;
  token: string;
  mantener: boolean;
}

export async function crearSesion(usuario: string, mantener: boolean, req: FastifyRequest): Promise<SesionNueva> {
  const token = randomBytes(SESION.tokenBytes).toString('base64url');
  const tipo = tiposSesion(mantener);
  const ahora = Date.now();
  const ip = ipDe(req);
  const agente = agenteDe(req);
  const [fila] = await queryApp<{ id: string }>(
    `INSERT INTO panel.sesiones (token_hash, usuario, mantener, creada_at, ultima_actividad_at, expira_at, reautenticada_at, ip, agente)
     VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz, $5::timestamptz, $4::timestamptz, $6::inet, $7) RETURNING id`,
    [sha256(token), usuario, mantener, new Date(ahora).toISOString(), new Date(ahora + tipo.maximaMs).toISOString(), ip, agente],
  );
  // La undécima sesión cierra la más antigua.
  const sobrantes = await queryApp<{ token_hash: Buffer }>(
    `UPDATE panel.sesiones SET cerrada_at = now(), motivo_cierre = 'limite_sesiones'
      WHERE id IN (SELECT s.id FROM panel.sesiones s WHERE s.usuario = $1 AND ${SQL_SESION_ACTIVA} ORDER BY s.creada_at DESC OFFSET $2)
      RETURNING token_hash`,
    [usuario, SESION.maxPorUsuario],
  );
  sobrantes.forEach((f) => quitarDeCache(aHex(f.token_hash)));
  return { id: fila.id, token, mantener };
}

// ----------------------------------------------------------------------------------- revocación
async function cerrar(sql: string, params: unknown[]): Promise<number> {
  const filas = await queryApp<{ token_hash: Buffer }>(sql, params);
  // Misma operación que la escritura: sin esto la caché de 30 s dejaría viva una sesión ya cerrada.
  filas.forEach((f) => quitarDeCache(aHex(f.token_hash)));
  return filas.length;
}

/** Cierra una sesión por id. Si se indica `usuario`, solo si es suya (la API de "mis sesiones"). */
export async function revocarSesion(id: string, motivo: MotivoCierre, usuario?: string): Promise<boolean> {
  const n = await cerrar(
    `UPDATE panel.sesiones SET cerrada_at = now(), motivo_cierre = $2 WHERE id = $1 AND cerrada_at IS NULL AND ($3::text IS NULL OR usuario = $3) RETURNING token_hash`,
    [id, motivo, usuario ?? null],
  );
  return n > 0;
}

/** Cierra todas las sesiones de un usuario, salvo (opcionalmente) una. Devuelve cuántas cerró. */
export function revocarSesionesDeUsuario(usuario: string, motivo: MotivoCierre, exceptoId?: string): Promise<number> {
  return cerrar(
    `UPDATE panel.sesiones SET cerrada_at = now(), motivo_cierre = $2 WHERE usuario = $1 AND cerrada_at IS NULL AND ($3::uuid IS NULL OR id <> $3) RETURNING token_hash`,
    [usuario, motivo, exceptoId ?? null],
  );
}

/** Cambia el token de la sesión (al cambiar la contraseña): el anterior deja de servir de inmediato. */
export async function rotarToken(s: SesionActiva): Promise<string> {
  const token = randomBytes(SESION.tokenBytes).toString('base64url');
  const nuevo = aHex(sha256(token));
  const anterior = clavePorId.get(s.id);
  await queryApp(`UPDATE panel.sesiones SET token_hash = $2 WHERE id = $1 AND cerrada_at IS NULL`, [s.id, Buffer.from(nuevo, 'hex')]);
  if (anterior) cache.delete(anterior);
  cache.set(nuevo, s);
  clavePorId.set(s.id, nuevo);
  s.leidaAt = 0; // fuerza una relectura (por ejemplo, para recoger `debe_cambiar` ya en false)
  return token;
}

export async function marcarReautenticada(s: SesionActiva) {
  s.reautenticadaAt = Date.now();
  await queryApp(`UPDATE panel.sesiones SET reautenticada_at = $2::timestamptz WHERE id = $1 AND cerrada_at IS NULL`, [s.id, new Date(s.reautenticadaAt).toISOString()]);
}

// ----------------------------------------------------------------------------------- consulta
/** "YYYY-MM-DDTHH:mm:ss" en hora de Bogotá (sin horario de verano), como el resto del panel. */
const BOGOTA_MS = -5 * 3600_000;
export const aBogota = (ms: number) => new Date(ms + BOGOTA_MS).toISOString().slice(0, 19);

export interface SesionListada {
  id: string;
  actual: boolean;
  creada: string;
  ultimaActividad: string;
  ip: string | null;
  equipo: string;
  mantener: boolean;
}

export async function listarSesiones(usuario: string, actualId: string | null): Promise<SesionListada[]> {
  const filas = await queryApp<{ id: string; creada_at: Date; ultima_actividad_at: Date; ip: string | null; agente: string | null; mantener: boolean }>(
    `SELECT s.id, s.creada_at, s.ultima_actividad_at, host(s.ip) AS ip, s.agente, s.mantener
       FROM panel.sesiones s WHERE s.usuario = $1 AND ${SQL_SESION_ACTIVA} ORDER BY s.creada_at DESC`,
    [usuario],
  );
  return filas.map((f) => {
    const enMemoria = cache.get(clavePorId.get(f.id) ?? '')?.ultimaActividad ?? 0;
    return {
      id: f.id,
      actual: f.id === actualId,
      creada: aBogota(f.creada_at.getTime()),
      ultimaActividad: aBogota(Math.max(f.ultima_actividad_at.getTime(), enMemoria)),
      ip: f.ip,
      equipo: equipoDe(f.agente),
      mantener: f.mantener,
    };
  });
}

// ------------------------------------------------------------------------------------- pruebas
/** Solo para pruebas: olvida la caché (sin volcar), para simular el paso del tiempo editando fechas en la base. */
export function _vaciarCacheSesiones() {
  cache.clear();
  clavePorId.clear();
  sucias.clear();
}
