import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { Yo } from './acceso';
import { EVENTO_CAMBIAR_CONTRASENA, EVENTO_SESION_VENCIDA, marcarToque } from './sesion';

export interface Rango {
  desde: string;
  hasta: string;
}

/**
 * Vista previa del rol soporte: ver el panel como otro nivel o rol (el servidor solo la acepta del rol soporte).
 * Se guarda en la pestaña del navegador (sessionStorage), no afecta a nadie más.
 */
export interface VistaPrevia {
  nivel?: string;
  rol?: string;
}

function leerVista(): VistaPrevia {
  try {
    return JSON.parse(sessionStorage.getItem('panel.vista') ?? '{}') as VistaPrevia;
  } catch {
    return {};
  }
}

export const vistaPrevia: VistaPrevia = leerVista();

export function cambiarVistaPrevia(v: VistaPrevia | null) {
  try {
    if (v && (v.nivel || v.rol)) sessionStorage.setItem('panel.vista', JSON.stringify(v));
    else sessionStorage.removeItem('panel.vista');
  } catch {
    /* almacenamiento no disponible */
  }
  location.hash = '#/';
  location.reload();
}

function cabeceras(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json', ...extra };
  if (vistaPrevia.nivel) h['X-Panel-Vista-Nivel'] = vistaPrevia.nivel;
  if (vistaPrevia.rol) h['X-Panel-Vista-Rol'] = vistaPrevia.rol;
  return h;
}

export class ErrorApi extends Error {
  constructor(message: string, readonly status: number, readonly codigo?: string) {
    super(message);
  }
}

async function leerRespuesta<T>(res: Response, sondeo = false): Promise<T> {
  if (res.ok && !sondeo) marcarToque(); // el servidor lo cuenta como actividad: se renovó la sesión
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const b = body as { error?: string; codigo?: string };
    // Solo estos dos códigos cambian la pantalla: cualquier otro error (credenciales, plan, permisos) se queda donde está.
    if (res.status === 401 && b.codigo === 'sesion') window.dispatchEvent(new Event(EVENTO_SESION_VENCIDA));
    if (res.status === 403 && b.codigo === 'cambiar_contrasena') window.dispatchEvent(new Event(EVENTO_CAMBIAR_CONTRASENA));
    throw new ErrorApi(b.error ?? `Error ${res.status}`, res.status, b.codigo);
  }
  return body as T;
}

/**
 * Estado de la conexión con el servidor, para la cabecera: hora de la última respuesta buena y si la última
 * petición falló por red o por el servidor (5xx). Los 4xx (falta de permiso, datos inválidos) no cuentan.
 */
export interface Conexion {
  ultimoOk: number | null;
  caida: boolean;
}
const conexion: Conexion = { ultimoOk: null, caida: false };
const oyentes = new Set<() => void>();
function marcarConexion(ok: boolean) {
  if (ok) conexion.ultimoOk = Date.now();
  conexion.caida = !ok;
  oyentes.forEach((f) => f());
}

export function useConexion(): Conexion {
  const [, forzar] = useState(0);
  useEffect(() => {
    const f = () => forzar((n) => n + 1);
    oyentes.add(f);
    return () => {
      oyentes.delete(f);
    };
  }, []);
  return { ...conexion };
}

/**
 * `sondeo: true` marca una consulta AUTOMÁTICA (la que se repite sola): lleva `X-Panel-Sondeo: 1` y el servidor no la
 * cuenta como actividad. Sin eso, una pantalla abandonada con tableros que se recargan solos nunca vencería.
 */
export interface OpcionesGet {
  sondeo?: boolean;
}

export async function getJson<T>(url: string, signal?: AbortSignal, opciones: OpcionesGet = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: cabeceras(opciones.sondeo ? { 'X-Panel-Sondeo': '1' } : {}), signal });
  } catch (e) {
    // Una petición cancelada a propósito (p. ej. al cambiar de conversación) no es una caída del servidor.
    if ((e as Error)?.name !== 'AbortError') marcarConexion(false);
    throw e;
  }
  if (res.ok) marcarConexion(true);
  else if (res.status >= 500) marcarConexion(false);
  return leerRespuesta<T>(res, opciones.sondeo);
}

export async function enviarJson<T>(metodo: 'POST' | 'PUT' | 'DELETE', url: string, cuerpo?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: metodo,
    headers: cabeceras(cuerpo === undefined ? {} : { 'Content-Type': 'application/json' }),
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  return leerRespuesta<T>(res);
}

/** Registro de actividad (pantallas vistas, descargas). Nunca interrumpe a la persona si falla. */
export function registrar(tipo: 'visita' | 'exportacion', ruta: string, detalle?: string) {
  if (vistaPrevia.nivel || vistaPrevia.rol) return;
  void enviarJson('POST', '/api/actividad', { tipo, ruta: ruta.slice(0, 120), ...(detalle ? { detalle: detalle.slice(0, 300) } : {}) }).catch(() => {});
}

export function conRango(ruta: string, r: Rango, extra: Record<string, string | number | null | undefined> = {}): string {
  const p = new URLSearchParams({ desde: r.desde, hasta: r.hasta });
  for (const [k, v] of Object.entries(extra)) if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
  return `${ruta}?${p}`;
}

/**
 * Contador global de "Actualizar": al cambiar, todas las pantallas vuelven a pedir sus datos
 * saltándose la cache del servidor (el parámetro _r cambia la clave de cache).
 */
export const RefrescoCtx = createContext(0);

function conRefresco(url: string, n: number): string {
  if (!n) return url;
  return `${url}${url.includes('?') ? '&' : '?'}_r=${n}`;
}

/**
 * Carga una URL y la vuelve a pedir cada `refrescoMs` (0 = nunca).
 * Mantiene los datos anteriores mientras llega la respuesta nueva para que la pantalla no parpadee.
 */
export function useApi<T>(urlBase: string | null, refrescoMs = 0) {
  const n = useContext(RefrescoCtx);
  const url = urlBase ? conRefresco(urlBase, n) : null;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!url) return;
    let vivo = true;
    // La primera carga la pide la persona; las del temporizador son sondeos y no renuevan la sesión.
    const cargar = (sondeo: boolean) => {
      setCargando(true);
      getJson<T>(url, undefined, { sondeo })
        .then((d) => vivo && (setData(d), setError(null)))
        .catch((e: Error) => vivo && setError(e.message))
        .finally(() => vivo && setCargando(false));
    };
    cargar(false);
    const t = refrescoMs > 0 ? setInterval(() => document.visibilityState === 'visible' && cargar(true), refrescoMs) : null;
    return () => {
      vivo = false;
      if (t) clearInterval(t);
    };
  }, [url, refrescoMs, version]);

  return { data, error, cargando, recargar: () => setVersion((v) => v + 1) };
}

// ------------------------------------------------------------------------------------- identidad
export type EstadoYo =
  | { tipo: 'cargando' }
  | { tipo: 'anonimo' }
  | { tipo: 'listo'; yo: Yo }
  | { tipo: 'error'; mensaje: string };

/**
 * Quién es la persona. Reemplaza a `useApi<Yo>('/api/yo')` en App porque aquí importa el código HTTP: un 401 no es un
 * error sino "no hay sesión" y lleva a la pantalla de acceso. Si la sesión vence con la pantalla abierta, vuelve a
 * `anonimo` SIN tocar el hash de la URL, para que el enlace profundo se conserve al volver a entrar (RF-08).
 */
export function useYo() {
  const [estado, setEstado] = useState<EstadoYo>({ tipo: 'cargando' });

  const recargar = useCallback(() => {
    getJson<Yo>('/api/yo')
      .then((yo) => setEstado({ tipo: 'listo', yo }))
      .catch((e: Error) => {
        if (e instanceof ErrorApi && e.status === 401) setEstado({ tipo: 'anonimo' });
        else setEstado((previo) => (previo.tipo === 'listo' ? previo : { tipo: 'error', mensaje: e.message }));
      });
  }, []);

  useEffect(() => {
    recargar();
    const vencida = () => setEstado({ tipo: 'anonimo' });
    // Una petición dijo que debe cambiar la contraseña (p. ej., soporte la acaba de reemplazar): se vuelve a leer quién es.
    const debeCambiar = () => recargar();
    window.addEventListener(EVENTO_SESION_VENCIDA, vencida);
    window.addEventListener(EVENTO_CAMBIAR_CONTRASENA, debeCambiar);
    return () => {
      window.removeEventListener(EVENTO_SESION_VENCIDA, vencida);
      window.removeEventListener(EVENTO_CAMBIAR_CONTRASENA, debeCambiar);
    };
  }, [recargar]);

  return {
    estado,
    /** Vuelve a leer quién es sin cambiar de pantalla (p. ej., tras cambiar la contraseña temporal). */
    recargar,
    /** Tras iniciar sesión: pasa por "Cargando…" y lee quién es. */
    reiniciar: () => (setEstado({ tipo: 'cargando' }), recargar()),
    aAnonimo: () => setEstado({ tipo: 'anonimo' }),
  };
}
