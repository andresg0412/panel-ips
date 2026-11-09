// Comparativo de periodos: tipos de lo que responde el servidor y la elección de meses, que vive en la URL
// (#/agenda?t=comparativo&mesA=2026-10&modo=interanual) para poder compartir el enlace.
// Diseño: proyecto-ips/docs/features/2026-11-09-comparativo-periodos-panel.md, sección 6.
import { useState } from 'react';

export type Modo = 'mes_anterior' | 'interanual' | 'libre';
export type Corte = 'completo' | 'mismo_dia';

/** Lo que el servidor decide de cada mes (server/comparativo.ts). */
export interface Periodo {
  mes: string;
  etiqueta: string;
  desde: string;
  hasta: string;
  dias: number;
  enCurso: boolean;
  cargaInicial: boolean;
  fraccionIncidente: number;
}

export interface Aviso {
  codigo: string;
  texto: string;
}

export interface Comparativo {
  modo: Modo;
  corte: Corte;
  diaCorte: number | null;
  a: Periodo;
  b: Periodo;
  avisos: Aviso[];
}

/** Respuesta de los endpoints /comparativo: los dos meses y los datos de cada uno. */
export interface RespuestaComparativa<D> {
  comparativo: Comparativo;
  a: D;
  b: D;
}

/** Parámetros del comparativo en el hash de la URL: App.tsx los conserva al cambiar el rango o la pantalla. */
export const PARAMS_COMPARATIVO = ['mesA', 'mesB', 'modo', 'corte'] as const;

/** Primer mes con datos (la carga inicial de Globho). */
export const PRIMER_MES = '2025-08';
const MES = /^\d{4}-(0[1-9]|1[0-2])$/;

export function mesActual(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date()).slice(0, 7);
}

/** Suma `n` meses (puede ser negativo) a un mes 'AAAA-MM'. */
export function mesMas(mes: string, n: number): string {
  const [anio, m] = mes.split('-').map(Number);
  return new Date(Date.UTC(anio, m - 1 + n, 1)).toISOString().slice(0, 7);
}

/** Meses del más reciente al más antiguo, desde el mes en curso hasta el primero con datos. */
export function mesesDisponibles(): string[] {
  const meses: string[] = [];
  for (let m = mesActual(); m >= PRIMER_MES; m = mesMas(m, -1)) meses.push(m);
  return meses;
}

/** El mismo mes del año anterior tiene datos. */
export const hayInteranual = (mesA: string) => mesMas(mesA, -12) >= PRIMER_MES;

/** Con el modo "mes anterior" el mes A no puede ser el primero con datos: no habría con qué comparar. */
export const hayMesAnterior = (mesA: string) => mesA > PRIMER_MES;

/** ¿Este mes se puede elegir como A en ese modo? */
export const mesAValido = (modo: Modo, mes: string) => (modo === 'interanual' ? hayInteranual(mes) : modo === 'mes_anterior' ? hayMesAnterior(mes) : true);

export interface Eleccion {
  modo: Modo;
  mesA: string;
  /** Solo en modo "libre". */
  mesB: string | null;
  /** null = todavía no se eligió: se usa el corte que corresponde al mes A. */
  corte: Corte | null;
}

/** Si A o B es el mes en curso se compara hasta ayer; con dos meses cerrados, el mes completo. */
export const corteInicial = (mesA: string, mesB: string | null = null): Corte =>
  mesA === mesActual() || mesB === mesActual() ? 'mismo_dia' : 'completo';

/** Mes A por defecto: el mes en curso, salvo el día 1, que todavía no tiene días cerrados. */
export function mesAInicial(): string {
  const dia = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', day: '2-digit' }).format(new Date());
  return dia === '01' ? mesMas(mesActual(), -1) : mesActual();
}

const otroMes = (mesA: string) => (hayMesAnterior(mesA) ? mesMas(mesA, -1) : mesMas(mesA, 1));

/** Deja la elección en un estado que el servidor acepta (p. ej., sin interanual si no hay datos del año anterior). */
function normalizar(e: Eleccion): Eleccion {
  let { modo, mesA, mesB } = e;
  if (modo === 'interanual' && !hayInteranual(mesA)) modo = 'mes_anterior';
  if (modo === 'mes_anterior' && !hayMesAnterior(mesA)) mesA = mesMas(PRIMER_MES, 1);
  if (modo === 'libre' && (!mesB || mesB === mesA)) mesB = otroMes(mesA);
  return { ...e, modo, mesA, mesB: modo === 'libre' ? mesB : null };
}

function leerUrl(): Eleccion {
  const q = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const mes = (clave: string) => {
    const v = q.get(clave);
    return v && MES.test(v) ? v : null;
  };
  const modo = q.get('modo');
  const corte = q.get('corte');
  return normalizar({
    modo: modo === 'interanual' || modo === 'libre' ? modo : 'mes_anterior',
    mesA: mes('mesA') ?? mesAInicial(),
    mesB: mes('mesB'),
    corte: corte === 'completo' || corte === 'mismo_dia' ? corte : null,
  });
}

function escribirUrl(e: Eleccion) {
  const [ruta, consulta = ''] = location.hash.split('?');
  const q = new URLSearchParams(consulta);
  PARAMS_COMPARATIVO.forEach((p) => q.delete(p));
  q.set('mesA', e.mesA);
  q.set('modo', e.modo);
  if (e.mesB) q.set('mesB', e.mesB);
  if (e.corte) q.set('corte', e.corte);
  history.replaceState(null, '', `${ruta}?${q}`);
}

export interface ControlComparativo {
  modo: Modo;
  mesA: string;
  mesB: string | null;
  corte: Corte;
  /** Parámetros listos para agregar a la URL de un endpoint de comparativo ('mesA=...&modo=...'). */
  consulta: string;
  cambiarModo: (modo: Modo) => void;
  cambiarMesA: (mes: string) => void;
  cambiarMesB: (mes: string) => void;
  cambiarCorte: (corte: Corte) => void;
}

/** Elección de meses de la pantalla, guardada en la URL. Las tres pantallas comparten los mismos parámetros. */
export function useComparativo(): ControlComparativo {
  const [eleccion, setEleccion] = useState<Eleccion>(leerUrl);
  const cambiar = (cambio: Partial<Eleccion>) => {
    const nueva = normalizar({ ...eleccion, ...cambio });
    escribirUrl(nueva);
    setEleccion(nueva);
  };
  const corte = eleccion.corte ?? corteInicial(eleccion.mesA, eleccion.mesB);
  const q = new URLSearchParams({ mesA: eleccion.mesA, modo: eleccion.modo, corte });
  if (eleccion.mesB) q.set('mesB', eleccion.mesB);
  return {
    modo: eleccion.modo,
    mesA: eleccion.mesA,
    mesB: eleccion.mesB,
    corte,
    consulta: q.toString(),
    cambiarModo: (modo) => cambiar({ modo }),
    // El corte que la persona eligió se conserva; si no eligió ninguno, sigue al mes A (mes en curso: hasta ayer).
    cambiarMesA: (mesA) => cambiar({ mesA }),
    cambiarMesB: (mesB) => cambiar({ mesB }),
    cambiarCorte: (c) => cambiar({ corte: c }),
  };
}
