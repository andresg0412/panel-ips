import { createContext, useContext, useEffect, useState } from 'react';

export interface Rango {
  desde: string;
  hasta: string;
}

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Error ${res.status}`);
  return body as T;
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
  }, [url, refrescoMs]);

  return { data, error, cargando };
}
