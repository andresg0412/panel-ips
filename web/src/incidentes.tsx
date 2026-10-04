import { createContext, useContext, useMemo, useState } from 'react';
import type { Rango } from './api';
import type { Sombra } from './components/series';
import { fecha } from './format';

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

/** Días del rango [desde, hasta] que caen en algún incidente. */
function diasEnIncidente(desde: string, hasta: string, inc: Incidente[]): number {
  let n = 0;
  for (let t = Date.parse(desde); t <= Date.parse(hasta); t += DIA) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (inc.some((i) => d >= i.desde && d <= i.hasta)) n++;
  }
  return n;
}

export function rangoAnterior(r: Rango): Rango {
  const n = dias(r.desde, r.hasta);
  const fin = new Date(Date.parse(r.desde) - DIA).toISOString().slice(0, 10);
  const ini = new Date(Date.parse(fin) - (n - 1) * DIA).toISOString().slice(0, 10);
  return { desde: ini, hasta: fin };
}

/**
 * Aviso cuando el período elegido, o el período anterior con el que se compara, cae en un incidente.
 * Si más del 30 % del período anterior está en incidente, la comparación "vs período anterior" no es confiable.
 */
export function AvisoIncidentes({ rango, areas, compara = true }: { rango: Rango; areas: Area[]; compara?: boolean }) {
  const inc = useIncidentes(areas);
  if (!inc.length) return null;
  const enActual = inc.filter((i) => i.desde <= rango.hasta && i.hasta >= rango.desde);
  const prev = rangoAnterior(rango);
  const fraccionPrev = diasEnIncidente(prev.desde, prev.hasta, inc) / dias(prev.desde, prev.hasta);
  const mensajes: JSX.Element[] = [];
  if (enActual.length) {
    mensajes.push(
      <div key="a">
        <b>Datos incompletos en este período.</b>{' '}
        {enActual.map((i) => `${i.titulo} (${fecha(i.desde)} al ${fecha(i.hasta)})`).join('; ')}. Esos días aparecen sombreados en los gráficos.
      </div>,
    );
  }
  if (compara && fraccionPrev > 0.3) {
    mensajes.push(
      <div key="p">
        <b>La comparación con el período anterior no es confiable:</b> el {Math.round(fraccionPrev * 100)} % de ese período cae en un incidente.
      </div>,
    );
  }
  if (!mensajes.length) return null;
  return <div className="aviso-incidente">{mensajes}</div>;
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
