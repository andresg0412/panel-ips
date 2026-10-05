// Control de acceso del panel: quién es la persona (nginx la autentica y envía X-Remote-User), qué rol tiene,
// qué nivel de licencia rige, y si puede usar cada endpoint. Todo se decide aquí, en el servidor: ocultar algo
// en el frontend es solo presentación.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { poolApp, queryApp } from './db.js';
import { hoyBogota, sumarDias } from './params.js';
import {
  ENDPOINTS, FUNCIONES, HISTORIAL_DIAS, LIBRES, MAX_USUARIOS, NOMBRE_NIVEL, ROLES, TAM_MAX_SIN_EXPORTAR,
  esNivel, esRol, funcion, rangoNivel, type Nivel, type Pagina, type Rol,
} from './funciones.js';

export interface Licencia {
  nivel: Nivel;
  contacto_whatsapp: string | null;
  nota: string | null;
  actualizado_at: string;
  actualizado_por: string | null;
}

export interface UsuarioPanel {
  usuario: string;
  rol: Rol;
  nombre: string | null;
  correo: string | null;
  prioridad: number;
  activo: boolean;
  /** Profesional de la agenda al que corresponde el usuario (rol Profesional, "Mi agenda"). */
  profesional: string | null;
}

interface Config {
  licencia: Licencia;
  usuarios: Map<string, UsuarioPanel>;
  /** Usuarios (no soporte) que el nivel actual deja entrar, por prioridad. */
  permitidos: Set<string>;
}

export interface Contexto {
  usuario: string | null;
  nombre: string | null;
  rolReal: Rol | null;
  nivelReal: Nivel;
  /** Rol y nivel con los que se evalúa: los reales, o los de la vista previa del rol soporte. */
  rol: Rol | null;
  nivel: Nivel;
  vistaPrevia: boolean;
  /** Primera fecha consultable según el nivel (null = sin límite). */
  historialDesde: string | null;
  habilitado: boolean;
  mensaje: string | null;
  /** Profesional vinculado al usuario (nunca viene del navegador). */
  profesional: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    contexto?: Contexto;
  }
}

// ------------------------------------------------------------------------------------ configuración
const TTL_CONFIG_MS = 30_000;
let config: { valor: Config; expira: number } | null = null;

async function leerConfig(): Promise<Config> {
  const [lic] = await queryApp<Licencia>(
    `SELECT nivel, contacto_whatsapp, nota, to_char(actualizado_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD"T"HH24:MI:SS') AS actualizado_at, actualizado_por FROM panel.licencia WHERE id = 1`,
  );
  if (!lic || !esNivel(lic.nivel)) throw new Error('panel.licencia vacía o inválida');
  const filas = await queryApp<UsuarioPanel>(`SELECT usuario, rol, nombre, correo, prioridad, activo, profesional FROM panel.usuarios`);
  const usuarios = new Map(filas.filter((u) => esRol(u.rol)).map((u) => [u.usuario, u]));
  const max = MAX_USUARIOS[lic.nivel];
  const orden = [...usuarios.values()]
    .filter((u) => u.activo && u.rol !== 'soporte')
    .sort((a, b) => a.prioridad - b.prioridad || a.usuario.localeCompare(b.usuario));
  return { licencia: lic, usuarios, permitidos: new Set((max === null ? orden : orden.slice(0, max)).map((u) => u.usuario)) };
}

/**
 * Sin DATABASE_URL_APP (esquema `panel` aún no instalado), el panel funciona como antes de la Etapa 1: todo
 * usuario autenticado por nginx entra como Dirección con el plan Full, y no hay consola de soporte. Evita que un
 * despliegue hecho antes de crear el rol panel_app deje al cliente sin panel.
 */
export const MODO_LEGADO = !poolApp;
const CONFIG_LEGADO: Config = {
  licencia: { nivel: 'full', contacto_whatsapp: null, nota: null, actualizado_at: '', actualizado_por: null },
  usuarios: new Map(),
  permitidos: new Set(),
};

/** Configuración vigente (en caché 30 s). Si la base no responde, sigue con la última buena. */
export async function obtenerConfig(): Promise<Config> {
  if (MODO_LEGADO) return CONFIG_LEGADO;
  if (config && config.expira > Date.now()) return config.valor;
  try {
    const valor = await leerConfig();
    config = { valor, expira: Date.now() + TTL_CONFIG_MS };
    return valor;
  } catch (e) {
    if (config) {
      config.expira = Date.now() + 5_000;
      return config.valor;
    }
    throw e;
  }
}

export function invalidarConfig() {
  config = null;
}

// ------------------------------------------------------------------------------------- contexto
function usuarioDe(req: FastifyRequest): string | null {
  const h = req.headers['x-remote-user'];
  const u = typeof h === 'string' && h.trim() ? h.trim() : null;
  if (u) return u;
  // Desarrollo local sin nginx.
  if (process.env.NODE_ENV !== 'production' && process.env.PANEL_USUARIO_DEV) return process.env.PANEL_USUARIO_DEV;
  return null;
}

export function historialDesde(nivel: Nivel): string | null {
  const dias = HISTORIAL_DIAS[nivel];
  return dias === null ? null : sumarDias(hoyBogota(), -(dias - 1));
}

export async function resolverContexto(req: FastifyRequest): Promise<Contexto> {
  const cfg = await obtenerConfig();
  const usuario = usuarioDe(req);
  const u: UsuarioPanel | undefined =
    MODO_LEGADO && usuario
      ? { usuario, rol: 'direccion', nombre: null, correo: null, prioridad: 1, activo: true, profesional: null }
      : usuario
        ? cfg.usuarios.get(usuario)
        : undefined;
  if (MODO_LEGADO && u) cfg.permitidos.add(u.usuario);
  const nivelReal = cfg.licencia.nivel;
  const rolReal = u?.rol ?? null;

  // Vista previa: solo el rol soporte puede ver el panel como otro nivel o rol (para demostraciones y revisión).
  let rol = rolReal;
  let nivel = nivelReal;
  let vistaPrevia = false;
  if (rolReal === 'soporte') {
    const vn = req.headers['x-panel-vista-nivel'];
    const vr = req.headers['x-panel-vista-rol'];
    if (esNivel(vn)) (nivel = vn), (vistaPrevia = true);
    if (esRol(vr) && vr !== 'soporte') (rol = vr), (vistaPrevia = true);
  }

  let habilitado = true;
  let mensaje: string | null = null;
  if (!usuario || !u) {
    habilitado = false;
    mensaje = 'Su usuario no tiene un rol asignado en el panel. Comuníquese con soporte.';
  } else if (!u.activo) {
    habilitado = false;
    mensaje = 'Su usuario está desactivado. Comuníquese con soporte.';
  } else if (rolReal !== 'soporte' && !cfg.permitidos.has(u.usuario)) {
    habilitado = false;
    const max = MAX_USUARIOS[nivelReal];
    mensaje = `El plan ${NOMBRE_NIVEL[nivelReal]} incluye ${max} ${max === 1 ? 'usuario' : 'usuarios'}. Para habilitar este acceso, comuníquese con la dirección o con soporte.`;
  }

  // El soporte sin vista previa de nivel no tiene límite de historial.
  const sinLimite = rolReal === 'soporte' && nivel === nivelReal && !req.headers['x-panel-vista-nivel'];
  return {
    usuario,
    nombre: u?.nombre ?? null,
    rolReal,
    nivelReal,
    rol,
    nivel,
    vistaPrevia,
    historialDesde: sinLimite ? null : historialDesde(nivel),
    habilitado,
    mensaje,
    profesional: u?.profesional ?? null,
  };
}

export interface Evaluacion {
  ok: boolean;
  /** Por qué no: el rol no incluye la función, o el nivel no alcanza. */
  motivo?: 'rol' | 'nivel';
  nivel: Nivel;
}

export function evaluar(ctx: Contexto, clave: string): Evaluacion {
  const f = funcion(clave);
  if (!f) return { ok: false, motivo: 'rol', nivel: 'full' };
  // El soporte sin vista previa lo ve todo.
  if (ctx.rolReal === 'soporte' && !ctx.vistaPrevia) return { ok: true, nivel: f.nivel };
  const rol = ctx.rol;
  const rolOk = !!rol && (f.pagina === null || ROLES[rol].paginas.includes(f.pagina)) && (!f.roles || f.roles.includes(rol));
  if (!rolOk) return { ok: false, motivo: 'rol', nivel: f.nivel };
  if (rangoNivel(ctx.nivel) < rangoNivel(f.nivel)) return { ok: false, motivo: 'nivel', nivel: f.nivel };
  return { ok: true, nivel: f.nivel };
}

export const puede = (req: FastifyRequest, clave: string) => !!req.contexto && evaluar(req.contexto, clave).ok;

/** Estado de cada página para el menú: visible, bloqueada por el nivel (con candado) u oculta por el rol. */
export function estadoPaginas(ctx: Contexto): Record<string, { estado: 'ok' | 'bloqueada' | 'oculta'; nivel: Nivel }> {
  const out: Record<string, { estado: 'ok' | 'bloqueada' | 'oculta'; nivel: Nivel }> = {};
  const paginas = new Set(FUNCIONES.map((f) => f.pagina).filter((p): p is Pagina => p !== null));
  for (const p of paginas) {
    const evs = FUNCIONES.filter((f) => f.pagina === p).map((f) => evaluar(ctx, f.clave));
    const visibles = evs.filter((e) => e.motivo !== 'rol');
    if (!visibles.length) out[p] = { estado: 'oculta', nivel: 'full' };
    else if (visibles.some((e) => e.ok)) out[p] = { estado: 'ok', nivel: 'basico' };
    else out[p] = { estado: 'bloqueada', nivel: visibles.map((e) => e.nivel).sort((a, b) => rangoNivel(a) - rangoNivel(b))[0] };
  }
  const soporte = ctx.rolReal === 'soporte';
  out.soporte = { estado: soporte ? 'ok' : 'oculta', nivel: 'basico' };
  return out;
}

/** Clave de caché que separa por nivel: el mismo URL devuelve datos distintos según el nivel. */
export const claveCache = (req: FastifyRequest) => `${req.contexto?.nivel ?? '-'}|${req.contexto?.historialDesde ?? ''}|${req.url}`;

// ------------------------------------------------------------------------------------ actividad
interface FilaActividad {
  usuario: string | null;
  rol: string | null;
  tipo: 'api' | 'visita' | 'exportacion' | 'configuracion' | 'acceso_denegado';
  ruta: string | null;
  detalle: string | null;
  status: number | null;
  ms: number | null;
  vista_previa: boolean;
}

const pendientes: FilaActividad[] = [];
const MAX_PENDIENTES = 2_000;
// Consultas que se repiten solas (el menú, cada minuto) y no dicen nada del uso.
const SIN_REGISTRO = new Set(['GET /api/health', 'GET /api/alertas/conteo', 'GET /api/soporte/conteo']);

export function registrarActividad(ctx: Contexto | undefined, fila: Omit<FilaActividad, 'usuario' | 'rol' | 'vista_previa'>) {
  if (!poolApp) return;
  if (pendientes.length >= MAX_PENDIENTES) pendientes.shift();
  pendientes.push({ ...fila, usuario: ctx?.usuario ?? null, rol: ctx?.rolReal ?? null, vista_previa: ctx?.vistaPrevia ?? false });
}

async function volcarActividad() {
  if (!pendientes.length || !poolApp) return;
  const lote = pendientes.splice(0, 500);
  try {
    await queryApp(
      `INSERT INTO panel.actividad (usuario, rol, tipo, ruta, detalle, status, ms, vista_previa)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::int[], $8::bool[])`,
      [
        lote.map((f) => f.usuario),
        lote.map((f) => f.rol),
        lote.map((f) => f.tipo),
        lote.map((f) => f.ruta),
        lote.map((f) => f.detalle),
        lote.map((f) => f.status),
        lote.map((f) => f.ms),
        lote.map((f) => f.vista_previa),
      ],
    );
  } catch (e) {
    console.error('No se pudo guardar la actividad del panel:', (e as Error).message);
  }
}

// ------------------------------------------------------------------------- errores del panel
// Marcas de tiempo de los errores recientes, para la alerta de soporte "el panel está fallando".
const errores: { at: number; tipo: 'interno' | 'timeout' | 'bd' }[] = [];

export function registrarError(tipo: 'interno' | 'timeout' | 'bd') {
  errores.push({ at: Date.now(), tipo });
  if (errores.length > 500) errores.splice(0, errores.length - 500);
}

export function erroresRecientes(ms: number) {
  const desde = Date.now() - ms;
  const r = errores.filter((e) => e.at >= desde);
  return { interno: r.filter((e) => e.tipo === 'interno').length, timeout: r.filter((e) => e.tipo === 'timeout').length, bd: r.filter((e) => e.tipo === 'bd').length };
}

// --------------------------------------------------------------------------------------- hooks
function denegar(reply: FastifyReply, code: number, cuerpo: Record<string, unknown>) {
  return reply.code(code).send(cuerpo);
}

export function instalarAcceso(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const ruta = req.routeOptions.url;
    // Ruta inexistente: responde el manejador de 404.
    if (!ruta) return;
    const clave = `${req.method} ${ruta}`;
    if (clave === 'GET /api/health') return;

    try {
      req.contexto = await resolverContexto(req);
    } catch (e) {
      req.log.error(e, 'no se pudo leer la configuración del panel');
      registrarError('bd');
      return denegar(reply, 503, { error: 'El panel no pudo leer su configuración. Intente de nuevo en unos minutos.' });
    }
    const ctx = req.contexto;

    // Escrituras: solo JSON desde el mismo sitio (el navegador manda la clave de nginx en cualquier petición).
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origen = req.headers.origin;
      if (origen) {
        let host: string | null = null;
        try {
          host = new URL(origen).host;
        } catch {
          /* origen inválido */
        }
        if (host !== req.headers.host) return denegar(reply, 403, { error: 'Origen no permitido' });
      }
    }

    if (LIBRES.has(clave)) return;
    if (!ctx.habilitado) return denegar(reply, 403, { error: ctx.mensaje, codigo: 'usuario' });

    if (ruta.startsWith('/api/soporte/')) {
      if (ctx.rolReal !== 'soporte') return denegar(reply, 403, { error: 'Solo para soporte', codigo: 'rol' });
      return;
    }

    const f = ENDPOINTS[clave];
    if (!f) return denegar(reply, 403, { error: 'Función no habilitada', codigo: 'rol' });
    const q = req.query as Record<string, unknown>;
    const claves = [f];
    // Pedir muchas filas del detalle de envíos es una descarga de datos personales.
    if (clave === 'GET /api/campanas/envios' && Number(q.tam) > TAM_MAX_SIN_EXPORTAR) claves.push('exportar.personales');
    for (const c of claves) {
      const ev = evaluar(ctx, c);
      if (!ev.ok) {
        return ev.motivo === 'nivel'
          ? denegar(reply, 402, { error: `Disponible en el plan ${NOMBRE_NIVEL[ev.nivel]}`, codigo: 'nivel', nivel: ev.nivel })
          : denegar(reply, 403, { error: 'Su rol no incluye esta información', codigo: 'rol' });
      }
    }

    // Historial: el rango de fechas no puede empezar antes de lo que permite el nivel.
    if (ctx.historialDesde) {
      const h = ctx.historialDesde;
      if (typeof q.desde === 'string' && q.desde && q.desde < h) q.desde = h;
      if (typeof q.hasta === 'string' && q.hasta && q.hasta < h) q.hasta = h;
    }
  });

  app.addHook('onResponse', async (req, reply) => {
    if (!req.url.startsWith('/api/') || !req.routeOptions.url) return;
    const clave = `${req.method} ${req.routeOptions.url}`;
    if (SIN_REGISTRO.has(clave) || clave === 'POST /api/actividad') return;
    registrarActividad(req.contexto, {
      tipo: 'api',
      ruta: clave,
      detalle: null,
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
    });
  });

  const t = setInterval(() => void volcarActividad(), 10_000);
  t.unref();
  app.addHook('onClose', async () => {
    clearInterval(t);
    await volcarActividad();
  });
}

/** Recorta filas mensuales ("YYYY-MM") a las que permite el historial del nivel (endpoints sin rango de fechas). */
export function recortarMeses<T extends Record<string, unknown>>(req: FastifyRequest, filas: T[], campo: keyof T): T[] {
  const h = req.contexto?.historialDesde;
  if (!h) return filas;
  const mes = h.slice(0, 7);
  return filas.filter((f) => String(f[campo] ?? '') >= mes);
}
