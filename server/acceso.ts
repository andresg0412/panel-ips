// Control de acceso del panel: quién es la persona (la cookie de sesión del login propio; en la transición,
// nginx con X-Remote-User), qué rol tiene, qué nivel de licencia rige, y si puede usar cada endpoint. Todo se decide
// aquí, en el servidor: ocultar algo en el frontend es solo presentación.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { poolApp, queryApp } from './db.js';
import { SESION, modoAuth } from './auth/configuracion.js';
import { esSondeo, instalarVolcadoSesiones, resolverSesion, tocarSesion } from './auth/sesiones.js';
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
  /** Sesión del login propio (null en el modo de transición con nginx, o sin sesión). */
  sesionId: string | null;
  /** La contraseña es temporal: hasta cambiarla solo se puede llamar a las rutas de DURANTE_CAMBIO. */
  debeCambiar: boolean;
  /** Última vez (ms) que la persona confirmó su contraseña en esta sesión; null si no hay sesión. */
  reautenticadaAt: number | null;
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
/** El modo legado solo existe en la transición con nginx: con login propio, faltar la base impide arrancar (H6). */
const legado = () => MODO_LEGADO && modoAuth() === 'nginx';
const CONFIG_LEGADO: Config = {
  licencia: { nivel: 'full', contacto_whatsapp: null, nota: null, actualizado_at: '', actualizado_por: null },
  usuarios: new Map(),
  permitidos: new Set(),
};

/** Configuración vigente (en caché 30 s). Si la base no responde, sigue con la última buena. */
export async function obtenerConfig(): Promise<Config> {
  if (!poolApp) {
    if (modoAuth() === 'sesion') throw new Error('DATABASE_URL_APP no está configurada');
    return CONFIG_LEGADO;
  }
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
interface Identidad {
  usuario: string | null;
  sesionId: string | null;
  debeCambiar: boolean;
  reautenticadaAt: number | null;
}

const ANONIMA: Identidad = { usuario: null, sesionId: null, debeCambiar: false, reautenticadaAt: null };

/**
 * Quién hace la petición. En modo `sesion` la identidad sale SOLO de la cookie: la cabecera `X-Remote-User` se
 * ignora por completo (H1), porque cualquiera que llegue al puerto del panel podría enviarla. En modo `nginx` (solo
 * la transición) se conserva la lógica de siempre.
 */
async function identidadDe(req: FastifyRequest): Promise<Identidad> {
  if (modoAuth() === 'sesion') {
    const s = await resolverSesion(req);
    if (!s) return ANONIMA;
    // Las consultas automáticas del navegador no cuentan como actividad: una pantalla abandonada debe vencer (H4).
    if (!esSondeo(req)) tocarSesion(s);
    return { usuario: s.usuario, sesionId: s.id, debeCambiar: s.debeCambiar, reautenticadaAt: s.reautenticadaAt };
  }
  const h = req.headers['x-remote-user'];
  const u = typeof h === 'string' && h.trim() ? h.trim() : null;
  if (u) return { ...ANONIMA, usuario: u };
  // Desarrollo local sin nginx.
  if (process.env.NODE_ENV !== 'production' && process.env.PANEL_USUARIO_DEV) return { ...ANONIMA, usuario: process.env.PANEL_USUARIO_DEV };
  return ANONIMA;
}

export function historialDesde(nivel: Nivel): string | null {
  const dias = HISTORIAL_DIAS[nivel];
  return dias === null ? null : sumarDias(hoyBogota(), -(dias - 1));
}

export async function resolverContexto(req: FastifyRequest): Promise<Contexto> {
  const cfg = await obtenerConfig();
  const { usuario, sesionId, debeCambiar, reautenticadaAt } = await identidadDe(req);
  const u: UsuarioPanel | undefined =
    legado() && usuario
      ? { usuario, rol: 'direccion', nombre: null, correo: null, prioridad: 1, activo: true, profesional: null }
      : usuario
        ? cfg.usuarios.get(usuario)
        : undefined;
  if (legado() && u) cfg.permitidos.add(u.usuario);
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
    sesionId,
    debeCambiar,
    reautenticadaAt,
  };
}

export interface Evaluacion {
  ok: boolean;
  /** Por qué no: el rol no incluye la función, o el nivel no alcanza. */
  motivo?: 'rol' | 'nivel';
  nivel: Nivel;
}

/** Historial de conversaciones encendido en ESTE panel (PANEL_CONVERSACIONES_ENABLED=true). Apagado, nadie salvo soporte lo ve. */
export const conversacionesHabilitadas = () => process.env.PANEL_CONVERSACIONES_ENABLED === 'true';

export function evaluar(ctx: Contexto, clave: string): Evaluacion {
  const f = funcion(clave);
  if (!f) return { ok: false, motivo: 'rol', nivel: 'full' };
  // El soporte sin vista previa lo ve todo (también lo que aún no está habilitado, para poder probarlo).
  if (ctx.rolReal === 'soporte' && !ctx.vistaPrevia) return { ok: true, nivel: f.nivel };
  // Función aún no habilitada: se comporta como un rol sin acceso (la página no aparece en el menú y la API responde 403).
  if (f.clave === 'conversaciones.ver' && !conversacionesHabilitadas()) return { ok: false, motivo: 'rol', nivel: f.nivel };
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
  // "Mi cuenta" no es una función del plan: es de toda persona con sesión (no aparece en Mi plan ni en las pruebas de niveles).
  out.cuenta = { estado: 'ok', nivel: 'basico' };
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
// Historial de conversaciones: los sondeos (cada 3 a 10 s) no se registran cuando salen bien; llenarían panel.actividad.
// Lo que sí queda es la APERTURA de una conversación (la registra la propia ruta, con el teléfono) y cualquier intento
// fallido o denegado (status >= 400).
const SIN_REGISTRO_SI_OK = new Set(['GET /api/conversaciones', 'GET /api/conversaciones/cursor', 'GET /api/conversaciones/:telefono/mensajes']);

export function registrarActividad(ctx: Contexto | undefined, fila: Omit<FilaActividad, 'usuario' | 'rol' | 'vista_previa'>) {
  if (!poolApp) return;
  if (pendientes.length >= MAX_PENDIENTES) pendientes.shift();
  pendientes.push({ ...fila, usuario: ctx?.usuario ?? null, rol: ctx?.rolReal ?? null, vista_previa: ctx?.vistaPrevia ?? false });
}

/** Se exporta para que las pruebas no esperen los 10 s del temporizador. */
export async function volcarActividad() {
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

/** Rutas que cualquiera puede llamar, sin sesión. Todo lo demás de /api exige una (sección 11.5). */
const PUBLICAS = new Set([
  'GET /api/health',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'POST /api/auth/recuperar/solicitar',
  'POST /api/auth/recuperar/verificar',
  'POST /api/auth/recuperar/restablecer',
]);

/** Con una contraseña temporal solo se puede ver quién es, cambiarla, salir y mantener viva la sesión. */
const DURANTE_CAMBIO = new Set(['GET /api/yo', 'POST /api/auth/contrasena', 'POST /api/auth/logout', 'POST /api/auth/latido']);

/** Acciones que, además de permiso, exigen haber confirmado la contraseña en los últimos 10 minutos (D6). */
const REAUTENTICAR = new Set(['POST /api/envios/invitacion/ejecutar']);

/**
 * Escrituras: solo desde el mismo sitio. En modo `sesion` el `Origin` es OBLIGATORIO (H9): una escritura sin él
 * pasaba el control anterior. En modo `nginx` se conserva el comportamiento de siempre.
 */
function origenValido(req: FastifyRequest): boolean {
  const origen = req.headers.origin;
  if (!origen) return modoAuth() !== 'sesion';
  try {
    return new URL(origen).host === req.headers.host;
  } catch {
    return false;
  }
}

export function instalarAcceso(app: FastifyInstance) {
  instalarVolcadoSesiones(app);

  app.addHook('onRequest', async (req, reply) => {
    // Se decide por la ruta RESUELTA, nunca por el texto de req.url: el enrutador decodifica la URL, así que
    // /%61pi/resumen llega a la ruta /api/resumen y un control sobre req.url la dejaría pasar sin autenticar.
    // Sin ruta (inexistente) responde el manejador de 404.
    const ruta = req.routeOptions.url;
    if (!ruta?.startsWith('/api/')) return;
    const clave = `${req.method} ${ruta}`;
    const modo = modoAuth();

    // En la transición con nginx el login propio no existe.
    if (modo === 'nginx' && ruta.startsWith('/api/auth/')) return denegar(reply, 404, { error: 'No existe' });

    // 1. Origen: antes de tocar la base.
    if (req.method !== 'GET' && req.method !== 'HEAD' && !origenValido(req)) {
      return denegar(reply, 403, { error: 'Origen no permitido', codigo: 'origen' });
    }

    // 2. Rutas públicas: sin contexto.
    if (PUBLICAS.has(clave)) return;

    // 3. Contexto, igual que antes, con su 503.
    try {
      req.contexto = await resolverContexto(req);
    } catch (e) {
      req.log.error(e, 'no se pudo leer la configuración del panel');
      registrarError('bd');
      return denegar(reply, 503, { error: 'El panel no pudo leer su configuración. Intente de nuevo en unos minutos.' });
    }
    const ctx = req.contexto;

    // 4. Sin sesión (o vencida), 401: es la única respuesta que lleva a la pantalla de acceso.
    if (modo === 'sesion' && !ctx.usuario) return denegar(reply, 401, { error: 'Su sesión terminó', codigo: 'sesion' });

    // 5. Contraseña temporal: nada funciona hasta que se cambie.
    if (ctx.debeCambiar && !DURANTE_CAMBIO.has(clave)) {
      return denegar(reply, 403, { error: 'Debe cambiar su contraseña', codigo: 'cambiar_contrasena' });
    }

    // 6. Rutas de la propia cuenta: no dependen del plan ni de estar habilitado (quien está fuera del plan puede salir).
    if (ruta.startsWith('/api/auth/')) return;

    // 7. Desde aquí, las reglas de siempre: libres, habilitado, soporte, ENDPOINTS, historial.
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

    // Reautenticación: se pide DESPUÉS de comprobar el permiso, para no pedir la contraseña a quien igual sería rechazado.
    if (modo === 'sesion' && REAUTENTICAR.has(clave) && Date.now() - (ctx.reautenticadaAt ?? 0) > SESION.reautenticacionMs) {
      return denegar(reply, 403, { error: 'Confirme su contraseña para continuar', codigo: 'reautenticar' });
    }

    // Historial: el rango de fechas no puede empezar antes de lo que permite el nivel.
    if (ctx.historialDesde) {
      const h = ctx.historialDesde;
      if (typeof q.desde === 'string' && q.desde && q.desde < h) q.desde = h;
      if (typeof q.hasta === 'string' && q.hasta && q.hasta < h) q.hasta = h;
    }
  });

  app.addHook('onResponse', async (req, reply) => {
    if (!req.routeOptions.url?.startsWith('/api/')) return;
    // Las rutas de autenticación llevan sus propios eventos, y una petición sin usuario (sondeos anónimos del
    // login público) no debe llenar panel.actividad (H14).
    if (req.routeOptions.url.startsWith('/api/auth/') || !req.contexto?.usuario) return;
    const clave = `${req.method} ${req.routeOptions.url}`;
    if (SIN_REGISTRO.has(clave) || clave === 'POST /api/actividad') return;
    if (SIN_REGISTRO_SI_OK.has(clave) && reply.statusCode < 400) return;
    const q = req.query as Record<string, unknown>;
    const personal = ENDPOINTS[clave] === 'exportar.personales' || (clave === 'GET /api/campanas/envios' && Number(q.tam) > TAM_MAX_SIN_EXPORTAR);
    if (personal && reply.statusCode === 200) {
      registrarActividad(req.contexto, {
        tipo: 'exportacion',
        ruta: clave,
        detalle: 'Descarga de datos personales de pacientes (registro del servidor)',
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
      });
      return;
    }
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
