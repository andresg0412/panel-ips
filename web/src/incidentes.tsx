import { createContext, useContext, useMemo, useState } from 'react';
import type { Rango } from './api';
import type { Sombra } from './components/series';

// Incidentes de datos conocidos (TR-01). Los entrega /api/incidentes; aquí se reparten a las pantallas.
export type Area = 'general' | 'agenda' | 'whatsapp' | 'conversaciones' | 'eventos' | 'trazabilidad';

export interface Incidente {
  area: Area;
  desde: string;
  hasta: string;
  titulo: string;
  descripcion: string;
}

export const IncidentesCtx = createContext<Incidente[]>([]);

/** Incidentes de las áreas pedidas (el 'general' solo si no hay uno más específico del área). */
export function useIncidentes(areas: Area[]): Incidente[] {
  const todos = useContext(IncidentesCtx);
  const especificos = todos.filter((i) => areas.includes(i.area) && i.area !== 'general');
  if (especificos.length) return especificos;
  return todos.filter((i) => i.area === 'general');
}

export const comoSombras = (inc: Incidente[]): Sombra[] => inc.map((i) => ({ desde: i.desde, hasta: i.hasta, titulo: i.titulo }));

/** Franjas de incidente para los gráficos de tiempo, estables entre renders (no repintan el gráfico). */
export function useSombras(areas: Area[]): Sombra[] {
  const todos = useContext(IncidentesCtx);
  const clave = areas.join(',');
  return useMemo(() => {
    const especificos = todos.filter((i) => areas.includes(i.area) && i.area !== 'general');
    return comoSombras(especificos.length ? especificos : todos.filter((i) => i.area === 'general'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todos, clave]);
}

const DIA = 86_400_000;
const dias = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DIA) + 1;

export function rangoAnterior(r: Rango): Rango {
  const n = dias(r.desde, r.hasta);
  const fin = new Date(Date.parse(r.desde) - DIA).toISOString().slice(0, 10);
  const ini = new Date(Date.parse(fin) - (n - 1) * DIA).toISOString().slice(0, 10);
  return { desde: ini, hasta: fin };
}

export function Pestanas<T extends string>({ opciones, valor, onCambio }: { opciones: [T, string][]; valor: T; onCambio: (v: T) => void }) {
  return (
    <div className="pestanas" role="tablist">
      {opciones.map(([k, t]) => (
        <button key={k} role="tab" aria-selected={valor === k} className={valor === k ? 'activo' : ''} onClick={() => onCambio(k)}>
          {t}
        </button>
      ))}
    </div>
  );
}

/** Pestaña activa guardada en la URL (#/ruta?...&t=pestana), para compartir enlaces a una pestaña. */
export function usePestana<T extends string>(validas: T[], defecto: T): [T, (v: T) => void] {
  const leer = () => {
    const t = new URLSearchParams(location.hash.split('?')[1] ?? '').get('t') as T | null;
    return t && validas.includes(t) ? t : defecto;
  };
  const [valor, setValor] = useState<T>(leer);
  const cambiar = (v: T) => {
    const [ruta, query = ''] = location.hash.split('?');
    const q = new URLSearchParams(query);
    if (v === defecto) q.delete('t');
    else q.set('t', v);
    history.replaceState(null, '', `${ruta}${q.toString() ? `?${q}` : ''}`);
    setValor(v);
  };
  return [valor, cambiar];
}

/** Últimos `n` meses completos (YYYY-MM) que no se cruzan con un incidente: base de los promedios "por mes". */
export function useMesesConfiables(): (meses: string[], n?: number) => string[] {
  const todos = useContext(IncidentesCtx);
  return (meses, n = 3) => {
    const hoyMes = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date()).slice(0, 7);
    const inc = todos.filter((i) => i.area !== 'trazabilidad');
    const toca = (m: string) => inc.some((i) => i.desde.slice(0, 7) <= m && i.hasta.slice(0, 7) >= m);
    return meses.filter((m) => m < hoyMes && !toca(m)).sort().slice(-n);
  };
}
