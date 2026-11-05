// Parámetros de la autenticación propia del panel. Todo número vive aquí con nombre: ningún valor suelto en el
// resto del código. Especificación: proyecto-ips/docs/features/2026-11-04-panel-login-autenticacion.md (sección 8).

const MIN = 60_000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;

// ----------------------------------------------------------------------------------------- modo
export type ModoAuth = 'sesion' | 'nginx';

/**
 * `sesion` (por defecto): la identidad sale solo de la cookie de sesión. `nginx`: solo para la transición, la
 * identidad la pone nginx en `X-Remote-User`. Una variable ausente es `sesion` (H24): olvidarla jamás abre el panel.
 * Se lee en cada llamada (barata) para poder probar los dos modos en un mismo proceso.
 */
export function modoAuth(): ModoAuth {
  const v = process.env.PANEL_AUTH_MODO?.trim();
  if (v === undefined || v === '' || v === 'sesion') return 'sesion';
  if (v === 'nginx') return 'nginx';
  throw new Error('PANEL_AUTH_MODO inválido: use "sesion" o "nginx"');
}

export const esProduccion = () => process.env.NODE_ENV === 'production';

// ------------------------------------------------------------------------------------- sesiones
export const SESION = {
  /** Bytes aleatorios del token (se entrega en base64url; en la base solo se guarda su SHA-256). */
  tokenBytes: 32,
  cookieProduccion: '__Host-panel_sesion',
  cookieOtros: 'panel_sesion',
  normal: { inactividadMs: 60 * MIN, maximaMs: 12 * HORA },
  mantenida: { inactividadMs: 24 * HORA, maximaMs: 7 * DIA, maxAgeS: 7 * 24 * 3600 },
  /** Cuánto se confía en la lectura de una sesión antes de volver a leerla de la base. */
  cacheMs: 30_000,
  /** Cada cuánto se vuelca la última actividad (por lotes) a la base. */
  volcadoMs: MIN,
  /** Frecuencia máxima del latido del navegador (lo usa la interfaz, que lo recibe en /api/yo). */
  latidoMs: 5 * MIN,
  /** Antes de vencer por inactividad se avisa con esta antelación. */
  avisoInactividadMs: 2 * MIN,
  /** Cuánto vale la confirmación de contraseña para acciones sensibles. */
  reautenticacionMs: 10 * MIN,
  maxPorUsuario: 10,
  motivosCierre: ['logout', 'inactividad', 'maxima', 'contrasena', 'soporte', 'desactivado', 'limite_sesiones', 'usuario'] as const,
} as const;

export type MotivoCierre = (typeof SESION.motivosCierre)[number];

export const tiposSesion = (mantener: boolean) => (mantener ? SESION.mantenida : SESION.normal);

// -------------------------------------------------------------------------------------- límites
export interface ReglaLimite {
  /** Fallos (o solicitudes) permitidos dentro de la ventana. */
  tope: number;
  ventanaMs: number;
  /** Cuánto dura el 429 una vez alcanzado el tope. */
  bloqueoMs: number;
}

const QUINCE_MIN = 15 * MIN;

export const LIMITES = {
  loginIp: { tope: 20, ventanaMs: QUINCE_MIN, bloqueoMs: QUINCE_MIN },
  loginIdentificadorIp: { tope: 5, ventanaMs: QUINCE_MIN, bloqueoMs: QUINCE_MIN },
  loginIdentificador: { tope: 20, ventanaMs: QUINCE_MIN, bloqueoMs: QUINCE_MIN },
  recuperarIp: { tope: 10, ventanaMs: HORA, bloqueoMs: HORA },
  otpCorreoIp: { tope: 10, ventanaMs: QUINCE_MIN, bloqueoMs: QUINCE_MIN },
  otpIp: { tope: 20, ventanaMs: QUINCE_MIN, bloqueoMs: QUINCE_MIN },
  contrasenaUsuario: { tope: 5, ventanaMs: QUINCE_MIN, bloqueoMs: QUINCE_MIN },
} satisfies Record<string, ReglaLimite>;

/** Clave de los contadores cuando la petición no trae una IP válida (H18). */
export const SIN_IP = 'sin-ip';

// ---------------------------------------------------------------------------------------- OTP
export const OTP = {
  digitos: 6,
  vigenciaMs: 15 * MIN,
  intentosMax: 5,
  tokenBytes: 32,
  tokenVigenciaMs: 10 * MIN,
  /** Espera mínima entre dos solicitudes de código de una misma cuenta. */
  reenvioMs: MIN,
  /** Tope de códigos que se pueden pedir por cuenta en una hora. */
  porHoraMax: 3,
} as const;

// ------------------------------------------------------------------------------------ contraseñas
export const CLAVE = {
  /** scrypt: N = 2^logN (OWASP: N=2^15, r=8, p=3; unos 350 ms). */
  logN: 15,
  r: 8,
  p: 3,
  maxmem: 64 * 1024 * 1024,
  saltBytes: 16,
  hashBytes: 32,
  /** Operaciones scrypt simultáneas (cada una usa 32 MiB y el contenedor tiene 256 MB) y cola de espera (H19). */
  concurrencia: 2,
  cola: 10,
  /** Contraseñas anteriores que no se pueden reutilizar (además de la actual). */
  historial: 3,
  temporalLargo: 16,
  temporalVigenciaMs: DIA,
} as const;

// ------------------------------------------------------------------------------------- retención
export const RETENCION_DIAS = { sesiones: 30, codigos: 7, eventos: 365 } as const;

/** Largo máximo que se guarda del agente de usuario. */
export const AGENTE_MAX = 300;

// -------------------------------------------------------------------------------------- arranque
function exigir(condicion: unknown, variable: string) {
  if (!condicion) throw new Error(`Falta o es inválida la variable de entorno ${variable}`);
}

/**
 * Corre al inicio de index.ts. Si falla, el proceso no debe arrancar (mejor un contenedor caído que un panel
 * abierto). Solo informa QUÉ variable falta, nunca su valor.
 */
export function validarConfiguracion() {
  const modo = modoAuth();
  if (modo === 'sesion') {
    exigir(process.env.DATABASE_URL_APP, 'DATABASE_URL_APP');
    exigir(Buffer.from(process.env.PANEL_AUTH_SECRET ?? '', 'base64').length >= 32, 'PANEL_AUTH_SECRET');
  }
}

/** Llave HMAC de los códigos de recuperación. Nunca vive en la base. */
export function secretoAuth(): Buffer {
  const b = Buffer.from(process.env.PANEL_AUTH_SECRET ?? '', 'base64');
  if (b.length < 32) throw new Error('PANEL_AUTH_SECRET no está configurada');
  return b;
}
