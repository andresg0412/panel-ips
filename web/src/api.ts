import { createContext, useContext, useEffect, useState } from 'react';

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

async function leerRespuesta<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const b = body as { error?: string; codigo?: string };
    throw new ErrorApi(b.error ?? `Error ${res.status}`, res.status, b.codigo);
  }
  return body as T;
}

export async function getJson<T>(url: string): Promise<T> {
  return leerRespuesta<T>(await fetch(url, { headers: cabeceras() }));
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
    const cargar = () => {
      setCargando(true);
      getJson<T>(url)
        .then((d) => vivo && (setData(d), setError(null)))
        .catch((e: Error) => vivo && setError(e.message))
        .finally(() => vivo && setCargando(false));
    };
    cargar();
    const t = refrescoMs > 0 ? setInterval(() => document.visibilityState === 'visible' && cargar(), refrescoMs) : null;
    return () => {
      vivo = false;
      if (t) clearInterval(t);
    };
  }, [url, refrescoMs, version]);

  return { data, error, cargando, recargar: () => setVersion((v) => v + 1) };
}
