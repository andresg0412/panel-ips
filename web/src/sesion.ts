// Estado de la sesión en el navegador: cuándo fue la última vez que el SERVIDOR registró actividad (no la del ratón),
// y la comunicación entre pestañas. Sección 12 de la especificación del login propio.
//
// Por qué se sigue el último "toque" al servidor y no los movimientos del ratón: el servidor solo cuenta como actividad
// las peticiones que no son sondeos y el latido (máximo uno cada 5 minutos). Si la advertencia de inactividad se
// calculara con el ratón, podría aparecer después de que el servidor ya venció la sesión.

/** Máximo un latido cada 5 minutos con actividad real. Igual que SESION.latidoMs en server/auth/configuracion.ts. */
export const LATIDO_MS = 5 * 60_000;
/** Cuánto antes de vencer por inactividad se avisa. Igual que SESION.avisoInactividadMs en el servidor. */
export const AVISO_INACTIVIDAD_MS = 2 * 60_000;

/** Nombre del canal entre pestañas del mismo navegador. */
const CANAL = 'panel-sesion';

type Mensaje = 'cerrada' | 'toque';

let toque = Date.now();
const oyentesToque = new Set<() => void>();

let canal: BroadcastChannel | null = null;
function obtenerCanal(): BroadcastChannel | null {
  if (canal) return canal;
  if (typeof BroadcastChannel === 'undefined') return null;
  canal = new BroadcastChannel(CANAL);
  canal.onmessage = (e: MessageEvent<Mensaje>) => {
    // Otra pestaña habló con el servidor: la sesión también se renovó para esta.
    if (e.data === 'toque') registrarToque(false);
  };
  return canal;
}

function registrarToque(anunciar: boolean) {
  toque = Date.now();
  oyentesToque.forEach((f) => f());
  if (anunciar) obtenerCanal()?.postMessage('toque' satisfies Mensaje);
}

/** El servidor acaba de contestar una petición que cuenta como actividad. */
export const marcarToque = () => registrarToque(true);

export const ultimoToque = () => toque;

export function alCambiarToque(f: () => void): () => void {
  oyentesToque.add(f);
  return () => oyentesToque.delete(f);
}

/** Avisa a las demás pestañas que esta cerró la sesión. */
export function anunciarCierre() {
  obtenerCanal()?.postMessage('cerrada' satisfies Mensaje);
}

/** Ejecuta `f` cuando otra pestaña cierra la sesión (RF-37). Devuelve la función que deja de escuchar. */
export function alCerrarEnOtraPestana(f: () => void): () => void {
  const c = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CANAL);
  if (!c) return () => {};
  c.onmessage = (e: MessageEvent<Mensaje>) => {
    if (e.data === 'cerrada') f();
  };
  return () => c.close();
}

// Eventos que emite api.ts cuando el servidor dice que la sesión terminó o que hay que cambiar la contraseña.
export const EVENTO_SESION_VENCIDA = 'panel:sesion-vencida';
export const EVENTO_CAMBIAR_CONTRASENA = 'panel:cambiar-contrasena';

/**
 * Borra lo que no debe sobrevivir al cierre de sesión en un equipo compartido (H22). Se conservan las preferencias de la
 * persona (panel.tema, panel.preset y panel.usuario_recordado): no son datos.
 */
export function limpiarAlmacenamientoDeSesion() {
  try {
    sessionStorage.removeItem('panel.vista');
    localStorage.removeItem('panel.recientes');
  } catch {
    /* almacenamiento no disponible */
  }
}
