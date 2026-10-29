import type { FastifyInstance, FastifyRequest } from 'fastify';
import { query } from '../db.js';
import { conCache } from '../cache.js';
import { claveCache, registrarActividad } from '../acceso.js';
import { ErrorParametro } from '../params.js';
import { telefonoOculto } from '../ocultos.js';

// Historial de conversaciones del chatbot (solo lectura, casi en tiempo real).
// Diseño: proyecto-ips/docs/features/2026-10-29-historial-mensajes-panel.md, sección 6.1.
//
// Lee SOLO las vistas del esquema `historial` (migración 045 del backend), nunca la tabla base. Todas las consultas
// pasan por query() (db.ts) y por tanto por la reescritura de identidades ocultas (ocultos.ts); además lo que se sirve
// desde memoria se vuelve a filtrar con telefonoOculto().
//
// Carga constante sin importar cuántas personas miren: UN sondeo compartido del servidor (cada PANEL_HISTORIAL_TICK_MS,
// 2 s) trae los mensajes nuevos a un buffer circular de las últimas ~2000 filas; las peticiones "lo posterior al id X"
// se responden desde ese buffer. El sondeo solo corre si hubo alguna petición en los últimos 60 s: si nadie mira, no se
// consulta nada. Sin SSE, LISTEN/NOTIFY ni WebSocket (decisión D6): el pool del panel es de 3 conexiones.
//
// Supuesto: los ids (BIGSERIAL) se asignan y se confirman en el mismo orden porque el bot envía un lote a la vez, así
// que un id mayor visible implica que ya no llegarán filas con id menor. Si eso dejara de cumplirse, la conversación
// abierta se corrige al volver a abrirla (la apertura lee de la base, no del buffer).

const TICK_MS = Math.max(500, Number(process.env.PANEL_HISTORIAL_TICK_MS) || 2000);
/** Sin peticiones durante este tiempo, el sondeo compartido se detiene (PANEL_HISTORIAL_INACTIVIDAD_MS solo se cambia en pruebas). */
const INACTIVIDAD_MS = Math.max(1000, Number(process.env.PANEL_HISTORIAL_INACTIVIDAD_MS) || 60_000);
const BUFFER_MAX = 2000;
const LOTE_SONDEO = 500;
const LIMITE_DEFECTO = 100;
const LIMITE_MAX = 200;
const LISTA_DEFECTO = 50;
const LISTA_MAX = 100;
/** Días que el backend conserva el texto (HISTORIAL_RETENCION_DIAS del backend), solo para el aviso de la pantalla. */
const RETENCION_DIAS = Number(process.env.PANEL_HISTORIAL_RETENCION_DIAS) || 30;

const COLS = 'id, telefono_norm, direccion, origen, tipo, texto, contenido, plantilla, campana, flujo, paso, estado_envio, error_code, en_blacklist, ocurrido_at';

export interface FilaMensaje {
  id: number;
  telefono_norm: string;
  direccion: string;
  origen: string;
  tipo: string;
  texto: string | null;
  contenido: unknown;
  plantilla: string | null;
  campana: string | null;
  flujo: string | null;
  paso: string | null;
  estado_envio: string | null;
  error_code: string | null;
  en_blacklist: boolean | null;
  ocurrido_at: string | Date;
}

// ------------------------------------------------------------------------------------ sondeo compartido
let buffer: FilaMensaje[] = [];
/** El buffer contiene TODAS las filas visibles con id > base. -1 = sin inicializar. */
let base = -1;
let maxId = 0;
let ultimaPeticion = 0;
let ultimoSondeoOk = 0;
let sondeando: Promise<void> | null = null;
let temporizador: NodeJS.Timeout | null = null;
let ultimoAvisoError = 0;

class HistorialNoDisponible extends Error {}

/** Tabla o vista inexistente, esquema inexistente o sin permiso: la migración 045 / los GRANT aún no están aplicados. */
function esFaltaDeEsquema(e: unknown): boolean {
  const c = (e as { code?: string } | null)?.code;
  return c === '42P01' || c === '3F000' || c === '42501';
}

async function inicializar() {
  if (base >= 0) return;
  const [r] = await query<{ m: number }>(`SELECT coalesce(max(id), 0) AS m FROM historial.v_mensajes`);
  base = maxId = Number(r?.m ?? 0);
}

function recortar() {
  if (buffer.length <= BUFFER_MAX) return;
  const quitar = buffer.length - BUFFER_MAX;
  base = buffer[quitar - 1].id;
  buffer = buffer.slice(quitar);
}

/** Un solo sondeo a la vez; todos los que lleguen mientras corre comparten su resultado. */
function sondear(): Promise<void> {
  if (sondeando) return sondeando;
  sondeando = (async () => {
    try {
      await inicializar();
      for (let i = 0; i < 10; i++) {
        const filas = await query<FilaMensaje>(`SELECT ${COLS} FROM historial.v_mensajes WHERE id > $1 ORDER BY id LIMIT $2`, [maxId, LOTE_SONDEO]);
        if (!filas.length) break;
        buffer.push(...filas);
        maxId = Number(filas[filas.length - 1].id);
        if (filas.length < LOTE_SONDEO) break;
      }
      recortar();
      ultimoSondeoOk = Date.now();
    } finally {
      sondeando = null;
    }
  })();
  return sondeando;
}

function asegurarTemporizador() {
  if (temporizador) return;
  temporizador = setInterval(() => {
    if (Date.now() - ultimaPeticion > INACTIVIDAD_MS) return; // nadie mira: no se consulta nada
    sondear().catch((e) => {
      // No inundar el log si la base cae: un aviso por minuto.
      if (Date.now() - ultimoAvisoError > 60_000) {
        ultimoAvisoError = Date.now();
        console.error('Historial de conversaciones: no se pudo sondear:', (e as Error)?.message ?? e);
      }
    });
  }, TICK_MS);
  temporizador.unref();
}

/** Marca actividad y se asegura de que el buffer esté al día (si estuvo dormido, se pone al día antes de responder). */
async function prepararBuffer() {
  ultimaPeticion = Date.now();
  asegurarTemporizador();
  if (base < 0 || Date.now() - ultimoSondeoOk > 3 * TICK_MS) {
    try {
      await sondear();
    } catch (e) {
      if (esFaltaDeEsquema(e)) throw new HistorialNoDisponible();
      throw e;
    }
  }
}

// ------------------------------------------------------------------------------------------- utilidades
function leerEntero(q: Record<string, unknown>, nombre: string): number | null {
  const v = q[nombre];
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (typeof v !== 'string' || !/^\d{1,15}$/.test(v) || !Number.isSafeInteger(n)) throw new ErrorParametro(`El parámetro ${nombre} debe ser un número entero`);
  return n;
}

function leerLimite(q: Record<string, unknown>, defecto: number, max: number): number {
  const n = leerEntero(q, 'limite');
  return n === null ? defecto : Math.min(max, Math.max(1, n));
}

/** :telefono → 57XXXXXXXXXX. Solo dígitos, 10 a 15; si no, 400. */
export function leerTelefono(crudo: unknown): string {
  const t = typeof crudo === 'string' ? crudo.trim() : '';
  if (!/^\d{10,15}$/.test(t)) throw new ErrorParametro('Teléfono inválido: use solo dígitos (10 a 15)');
  return t.length === 10 ? `57${t}` : t;
}

const escaparLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const sinTelefono = ({ telefono_norm: _t, ...resto }: FilaMensaje) => resto;

type Respuesta = { code: (n: number) => { send: (b: unknown) => unknown } };
function noDisponible(reply: Respuesta) {
  return reply.code(503).send({ error: 'El historial de conversaciones todavía no está disponible. Intente de nuevo en unos minutos.' });
}

/** Ejecuta un manejador y traduce "el esquema historial aún no existe" en un 503 claro (no un 500 genérico). */
async function seguro(reply: Respuesta, fn: () => Promise<unknown>) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HistorialNoDisponible || esFaltaDeEsquema(e)) return noDisponible(reply);
    throw e;
  }
}

const noEncontrada = (reply: Respuesta) => reply.code(404).send({ error: 'Conversación no encontrada' });

// -------------------------------------------------------------------------------------------- rutas
export default async function rutasConversaciones(app: FastifyInstance) {
  /**
   * Lista de conversaciones, la más reciente primero. Parámetros: buscar (teléfono, documento o nombre), filtro
   * (activas | hoy | plantilla | crisis | error), desde_id (solo las que tuvieron mensajes nuevos después de ese id),
   * limite (50, máx. 100).
   */
  app.get('/api/conversaciones', async (req, reply) =>
    seguro(reply, async () => {
      const q = req.query as Record<string, unknown>;
      const desdeId = leerEntero(q, 'desde_id');
      const limite = leerLimite(q, LISTA_DEFECTO, LISTA_MAX);
      const buscar = typeof q.buscar === 'string' ? q.buscar.trim().slice(0, 60) : '';
      const filtro = typeof q.filtro === 'string' ? q.filtro : '';
      if (filtro && !['activas', 'hoy', 'plantilla', 'crisis', 'error'].includes(filtro)) throw new ErrorParametro('Filtro desconocido');

      await prepararBuffer();
      const cursor = maxId; // se lee ANTES de consultar: nada que pase durante la consulta queda sin ver en el siguiente sondeo
      return conCache(
        claveCache(req),
        async () => {
          const params: unknown[] = [];
          const donde: string[] = [];
          const p = (v: unknown) => (params.push(v), `$${params.length}`);
          if (desdeId !== null) donde.push(`c.ultimo_mensaje_id > ${p(desdeId)}`);
          if (buscar) {
            if (/^\d{4,}$/.test(buscar)) {
              const k = p(`%${buscar}%`);
              donde.push(`(c.telefono_norm LIKE ${k} OR c.numero_documento LIKE ${k})`);
            } else {
              const k = p(`%${escaparLike(buscar)}%`);
              donde.push(`(c.nombre ILIKE ${k} OR c.numero_documento ILIKE ${k})`);
            }
          }
          if (filtro === 'activas') donde.push(`c.ultimo_at > now() - interval '15 minutes'`);
          if (filtro === 'hoy') donde.push(`(c.ultimo_at AT TIME ZONE 'America/Bogota')::date = (now() AT TIME ZONE 'America/Bogota')::date`);
          if (filtro === 'crisis') donde.push('c.hubo_crisis');
          // La última plantilla enviada fue respondida (columnas del resumen; sin EXISTS sobre toda la tabla).
          if (filtro === 'plantilla') donde.push('c.respondio_plantilla');
          if (filtro === 'error') {
            donde.push(`EXISTS (SELECT 1 FROM historial.v_mensajes er
                          WHERE er.telefono_norm = c.telefono_norm AND er.estado_envio IN ('failed', 'error_api'))`);
          }
          const filas = await query(
            `SELECT c.telefono_norm AS telefono, c.nombre, c.numero_documento AS documento, c.pacientes_n,
                    c.ultimo_extracto AS extracto, c.ultimo_at, c.ultima_direccion, c.mensajes_total, c.entrantes_total,
                    c.flujo_actual AS flujo, c.paso_actual AS paso, c.hubo_crisis, c.ultimo_mensaje_id AS ultimo_id
               FROM historial.v_conversaciones c
              ${donde.length ? `WHERE ${donde.join(' AND ')}` : ''}
              ORDER BY c.ultimo_mensaje_id DESC
              LIMIT ${p(limite)}`,
            params,
          );
          return { conversaciones: filas, max_id: cursor, ahora: new Date().toISOString(), retencion_dias: RETENCION_DIAS };
        },
        3_000,
        0,
      );
    }),
  );

  /**
   * Qué cambió desde un id, para que la lista decida si tiene que pedir algo. Se responde desde el buffer (sin tocar
   * la base). `completo=false` = el cursor es más viejo que el buffer: hay que volver a pedir la lista.
   */
  app.get('/api/conversaciones/cursor', async (req, reply) =>
    seguro(reply, async () => {
      const desdeId = leerEntero(req.query as Record<string, unknown>, 'desde_id');
      await prepararBuffer();
      if (desdeId === null) return { max_id: maxId, completo: true, telefonos: [] as string[] };
      if (desdeId < base) return { max_id: maxId, completo: false, telefonos: [] as string[] };
      const telefonos = [...new Set(buffer.filter((f) => f.id > desdeId && !telefonoOculto(f.telefono_norm)).map((f) => f.telefono_norm))];
      return { max_id: maxId, completo: true, telefonos };
    }),
  );

  /**
   * Mensajes de una conversación.
   *  - sin cursor: la apertura (últimos `limite`, 100 por defecto) con los datos del encabezado. Es lo único que queda
   *    en la actividad del panel;
   *  - antes_id: página hacia atrás (scroll hacia arriba);
   *  - despues_id: mensajes nuevos + el estado de entrega actual de los últimos 50 salientes.
   */
  app.get('/api/conversaciones/:telefono/mensajes', async (req: FastifyRequest<{ Params: { telefono: string } }>, reply) =>
    seguro(reply, async () => {
      const telefono = leerTelefono(req.params.telefono);
      const q = req.query as Record<string, unknown>;
      const antesId = leerEntero(q, 'antes_id');
      const despuesId = leerEntero(q, 'despues_id');
      const limite = leerLimite(q, LIMITE_DEFECTO, LIMITE_MAX);
      if (antesId !== null && despuesId !== null) throw new ErrorParametro('Use antes_id o despues_id, no ambos');
      // Un teléfono oculto responde igual que uno que no existe: no se revela que existe.
      if (telefonoOculto(telefono)) return noEncontrada(reply);

      // --- mensajes nuevos: desde el buffer del sondeo compartido, o de la base si el cursor quedó atrás ---
      if (despuesId !== null) {
        await prepararBuffer();
        // El cursor es GLOBAL (max_id del sondeo compartido), no el id del último mensaje de esta conversación: así, aunque
        // la conversación esté quieta, el cursor del cliente sigue dentro del buffer y no hace falta ir a la base.
        let nuevos: FilaMensaje[];
        let cursor = maxId;
        if (despuesId >= base) {
          nuevos = buffer.filter((f) => f.id > despuesId && f.telefono_norm === telefono && !telefonoOculto(f.telefono_norm));
        } else {
          nuevos = await conCache(
            claveCache(req),
            () => query<FilaMensaje>(`SELECT ${COLS} FROM historial.v_mensajes WHERE telefono_norm = $1 AND id > $2 AND id <= $3 ORDER BY id LIMIT $4`, [telefono, despuesId, cursor, 500]),
            2_000,
            0,
          );
          // Si la página vino llena, el cursor avanza solo hasta lo entregado; el resto llega en el siguiente sondeo.
          if (nuevos.length >= 500) cursor = Number(nuevos[nuevos.length - 1].id);
        }
        const estados = await conCache(
          `conv-estados|${telefono}`,
          () =>
            query(
              `SELECT id, estado_envio, error_code FROM historial.v_mensajes
                WHERE telefono_norm = $1 AND direccion = 'saliente' ORDER BY id DESC LIMIT 50`,
              [telefono],
            ),
          2_000,
          0,
        );
        return { mensajes: nuevos.map(sinTelefono), estados, max_id: cursor };
      }

      // --- página hacia atrás ---
      if (antesId !== null) {
        const filas = await conCache(
          claveCache(req),
          () => query<FilaMensaje>(`SELECT ${COLS} FROM historial.v_mensajes WHERE telefono_norm = $1 AND id < $2 ORDER BY id DESC LIMIT $3`, [telefono, antesId, limite + 1]),
          10_000,
          0,
        );
        const hayMas = filas.length > limite;
        return { mensajes: filas.slice(0, limite).reverse().map(sinTelefono), hay_mas: hayMas };
      }

      // --- apertura de la conversación ---
      // El cursor global se lee ANTES de consultar: lo que se confirme mientras tanto llegará en el primer sondeo.
      await prepararBuffer();
      const cursorApertura = maxId;
      const [filas, cabecera] = await Promise.all([
        conCache(
          claveCache(req),
          () => query<FilaMensaje>(`SELECT ${COLS} FROM historial.v_mensajes WHERE telefono_norm = $1 ORDER BY id DESC LIMIT $2`, [telefono, limite + 1]),
          2_000,
          0,
        ),
        query(
          `SELECT c.telefono_norm AS telefono, c.nombre, c.numero_documento AS documento, c.pacientes_n, c.flujo_actual AS flujo,
                  c.paso_actual AS paso, c.hubo_crisis, c.mensajes_total, c.primer_at, c.ultimo_at
             FROM historial.v_conversaciones c WHERE c.telefono_norm = $1`,
          [telefono],
        ),
      ]);
      if (!filas.length && !cabecera.length) return noEncontrada(reply);
      // Auditoría (D4): quién abrió qué conversación. Los sondeos posteriores (despues_id / antes_id) no se registran.
      registrarActividad(req.contexto, {
        tipo: 'api',
        ruta: 'GET /api/conversaciones/:telefono/mensajes',
        detalle: `Abrió la conversación ${telefono}`,
        status: 200,
        ms: Math.round(reply.elapsedTime),
      });
      const hayMas = filas.length > limite;
      const mensajes = filas.slice(0, limite).reverse().map(sinTelefono);
      return {
        conversacion: cabecera[0] ?? { telefono },
        mensajes,
        hay_mas: hayMas,
        max_id: cursorApertura,
        retencion_dias: RETENCION_DIAS,
      };
    }),
  );
}

/** Solo para pruebas: reinicia el buffer y el sondeo. */
export function _reiniciarParaPruebas() {
  buffer = [];
  base = -1;
  maxId = 0;
  ultimaPeticion = 0;
  ultimoSondeoOk = 0;
  sondeando = null;
  if (temporizador) clearInterval(temporizador);
  temporizador = null;
}

export function _estadoBufferParaPruebas() {
  return { base, maxId, filas: buffer.length };
}
