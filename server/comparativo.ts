// Comparativo de periodos (Agenda, Profesionales y Pacientes): decide qué dos meses se comparan y hasta qué día.
// Es puro, sin SQL ni reloj propio (recibe "hoy"), para poder probarlo sin base de datos.
// Diseño: proyecto-ips/docs/features/2026-11-09-comparativo-periodos-panel.md, secciones 3 y 7.2.
import { ErrorHistorialPlan, ErrorParametro, INICIO_DATOS, hoyBogota } from './params.js';
import { fraccionEnIncidente } from './incidentes.js';
import { HISTORIAL_DIAS, type Nivel } from './funciones.js';

export type ModoComparativo = 'mes_anterior' | 'interanual' | 'libre';
export type CorteComparativo = 'completo' | 'mismo_dia';
export type CodigoAviso = 'carga_inicial' | 'incidente' | 'incidente_parcial' | 'mes_en_curso_completo' | 'sin_cierre' | 'dias_distintos';

/** Nota de interpretación: no bloquea la comparación. */
export interface Aviso {
  codigo: CodigoAviso;
  texto: string;
}

export interface Periodo {
  /** 'AAAA-MM' */
  mes: string;
  /** 'octubre 2026' */
  etiqueta: string;
  desde: string;
  /** Último día del mes, o el día de corte. */
  hasta: string;
  dias: number;
  /** Es el mes actual de Bogotá. */
  enCurso: boolean;
  /** Es el primer mes con datos (la carga inicial de Globho). */
  cargaInicial: boolean;
  /** Fracción del periodo (de 0 a 1) que cae en un incidente de datos. */
  fraccionIncidente: number;
}

export interface Comparativo {
  modo: ModoComparativo;
  corte: CorteComparativo;
  /** Día del mes en que se corta cada periodo (solo con `mismo_dia`). */
  diaCorte: number | null;
  /** El mes que se mira. */
  a: Periodo;
  /** El mes con el que se compara. */
  b: Periodo;
  avisos: Aviso[];
}

const MODOS: readonly ModoComparativo[] = ['mes_anterior', 'interanual', 'libre'];
const CORTES: readonly CorteComparativo[] = ['completo', 'mismo_dia'];
const MES = /^(\d{4})-(0[1-9]|1[0-2])$/;
const NOMBRES_MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const PRIMER_MES_AGENDA = INICIO_DATOS.slice(0, 7);
/** Más de esta fracción del periodo en un incidente vuelve poco confiable la comparación. */
const UMBRAL_INCIDENTE = 0.3;
/** Más de esta fracción de citas sin cierre hace dudar de los totales del periodo. */
const UMBRAL_SIN_CIERRE = 0.05;

const TTL_MES_EN_CURSO_MS = 120_000;
const TTL_MESES_CERRADOS_MS = 600_000;

const numeroMes = (mes: string) => {
  const [anio, m] = mes.split('-').map(Number);
  return { anio, m };
};

/** Suma `n` meses (puede ser negativo) a un mes 'AAAA-MM'. */
export function mesMas(mes: string, n: number): string {
  const { anio, m } = numeroMes(mes);
  return new Date(Date.UTC(anio, m - 1 + n, 1)).toISOString().slice(0, 7);
}

export function ultimoDiaMes(mes: string): number {
  const { anio, m } = numeroMes(mes);
  return new Date(Date.UTC(anio, m, 0)).getUTCDate();
}

export function etiquetaMes(mes: string): string {
  const { anio, m } = numeroMes(mes);
  return `${NOMBRES_MES[m - 1]} ${anio}`;
}

/** 'agosto de 2025' (para frases como "Los datos empiezan en…"). */
const mesConDe = (mes: string) => {
  const { anio, m } = numeroMes(mes);
  return `${NOMBRES_MES[m - 1]} de ${anio}`;
};

const conInicialMayuscula = (texto: string) => texto.charAt(0).toUpperCase() + texto.slice(1);

function leerMes(valor: unknown): string | null {
  if (valor === undefined || valor === null || valor === '') return null;
  if (typeof valor !== 'string' || !MES.test(valor)) throw new ErrorParametro('Mes inválido: use el formato AAAA-MM');
  return valor;
}

function leerOpcion<T extends string>(valor: unknown, validas: readonly T[]): T | null {
  if (valor === undefined || valor === null || valor === '') return null;
  if (typeof valor !== 'string' || !(validas as readonly string[]).includes(valor)) throw new ErrorParametro('Modo de comparación inválido');
  return valor as T;
}

/**
 * Qué datos se comparan. La agenda es el valor por defecto; la facturación tiene su propio primer mes (el de la carga
 * histórica) y no marca ninguno como "carga inicial", porque ese aviso habla de pacientes nuevos.
 */
export interface OpcionesComparativo {
  /** Primer mes con datos ('AAAA-MM'). Por defecto, el primero de la agenda. */
  primerMes?: string;
  /** El primer mes es la carga inicial de Globho: sus pacientes "nuevos" no son confiables. Por defecto, sí. */
  avisarCargaInicial?: boolean;
}

function armarPeriodo(mes: string, mesActual: string, diaCorte: number | null, cargaInicial: string | null): Periodo {
  const ultimo = ultimoDiaMes(mes);
  const dias = diaCorte === null ? ultimo : Math.min(diaCorte, ultimo);
  const desde = `${mes}-01`;
  const hasta = `${mes}-${String(dias).padStart(2, '0')}`;
  return {
    mes,
    etiqueta: etiquetaMes(mes),
    desde,
    hasta,
    dias,
    enCurso: mes === mesActual,
    cargaInicial: mes === cargaInicial,
    fraccionIncidente: fraccionEnIncidente(desde, hasta),
  };
}

function avisosDe(a: Periodo, b: Periodo, corte: CorteComparativo): Aviso[] {
  const avisos: Aviso[] = [];
  if (a.cargaInicial || b.cargaInicial) {
    avisos.push({
      codigo: 'carga_inicial',
      texto: "Agosto de 2025 es el primer mes con datos: los pacientes 'nuevos' de ese mes incluyen a quienes ya venían.",
    });
  }
  for (const p of [a, b]) {
    if (p.fraccionIncidente > UMBRAL_INCIDENTE) {
      avisos.push({ codigo: 'incidente', texto: `Más del 30 % de ${p.etiqueta} cae en un incidente de datos: la comparación puede no ser confiable.` });
    } else if (p.fraccionIncidente > 0) {
      avisos.push({ codigo: 'incidente_parcial', texto: `Parte de ${p.etiqueta} cae en un incidente de datos.` });
    }
    if (p.enCurso && corte === 'completo') {
      avisos.push({
        codigo: 'mes_en_curso_completo',
        texto: `${conInicialMayuscula(p.etiqueta)} todavía no termina: los totales están incompletos. Use 'al mismo día' para comparar en igualdad de condiciones.`,
      });
    }
  }
  if (corte === 'completo' && a.dias !== b.dias) {
    avisos.push({ codigo: 'dias_distintos', texto: `Los meses tienen distinta cantidad de días (${a.dias} y ${b.dias}).` });
  }
  return avisos;
}

/** Aviso de citas pasadas que siguen sin cierre, para los endpoints que ya cuentan esas citas. */
export function avisosSinCierre(periodos: { periodo: Periodo; sinCierre: number; total: number }[]): Aviso[] {
  return periodos
    .filter(({ sinCierre, total }) => total > 0 && sinCierre / total > UMBRAL_SIN_CIERRE)
    .map(({ periodo, sinCierre }) => ({
      codigo: 'sin_cierre' as const,
      texto: `${sinCierre} citas de ${periodo.etiqueta} siguen sin cierre: no se sabe si ocurrieron.`,
    }));
}

/** Tiempo de caché: corto si algún mes sigue en curso, más largo si ambos ya cerraron. */
export const ttlComparativo = (c: Comparativo) => (c.a.enCurso || c.b.enCurso ? TTL_MES_EN_CURSO_MS : TTL_MESES_CERRADOS_MS);

/**
 * Interpreta `mesA`, `mesB`, `modo` y `corte` de la query. El servidor es la única fuente de verdad del mes B.
 * Valida contra el calendario (sin meses futuros ni anteriores a los datos) y contra el historial del plan: el
 * recorte automático de `acceso.ts` solo mira `desde`/`hasta`, así que aquí un mes fuera del historial se rechaza
 * con 402 en vez de compararse recortado.
 */
export function resolverComparativo(
  q: Record<string, unknown>,
  ctx: { nivel: Nivel; historialDesde: string | null },
  hoy: string = hoyBogota(),
  { primerMes = PRIMER_MES_AGENDA, avisarCargaInicial = true }: OpcionesComparativo = {},
): Comparativo {
  const mesActual = hoy.slice(0, 7);
  const diaHoy = Number(hoy.slice(8, 10));
  const modo = leerOpcion(q.modo, MODOS) ?? 'mes_anterior';
  // El día 1 el mes en curso no tiene días cerrados: sin mes elegido se abre el mes anterior.
  const mesA = leerMes(q.mesA) ?? (diaHoy === 1 ? mesMas(mesActual, -1) : mesActual);

  let mesB: string;
  if (modo === 'mes_anterior') mesB = mesMas(mesA, -1);
  else if (modo === 'interanual') mesB = mesMas(mesA, -12);
  else {
    const elegido = leerMes(q.mesB);
    if (!elegido) throw new ErrorParametro('Elija el mes con el que quiere comparar');
    mesB = elegido;
  }

  if (mesA === mesB) throw new ErrorParametro('Elija dos meses distintos');
  if (mesA > mesActual || mesB > mesActual) throw new ErrorParametro('No se puede comparar un mes que todavía no empieza');
  if (mesA < primerMes || mesB < primerMes) throw new ErrorParametro(`Los datos empiezan en ${mesConDe(primerMes)}`);

  // Si cualquiera de los dos meses está en curso, se compara por defecto hasta el mismo día.
  const hayMesEnCurso = mesA === mesActual || mesB === mesActual;
  const corte = leerOpcion(q.corte, CORTES) ?? (hayMesEnCurso ? 'mismo_dia' : 'completo');

  let diaCorte: number | null = null;
  if (corte === 'mismo_dia') {
    // Las citas de hoy todavía no se han cerrado: si A o B es el mes en curso, los dos se cortan en el día de ayer.
    diaCorte = hayMesEnCurso ? diaHoy - 1 : diaHoy;
    if (diaCorte < 1) throw new ErrorParametro("El mes en curso todavía no tiene días cerrados. Elija el mes anterior o use 'mes completo'.");
  }

  const mesCargaInicial = avisarCargaInicial ? primerMes : null;
  const a = armarPeriodo(mesA, mesActual, diaCorte, mesCargaInicial);
  const b = armarPeriodo(mesB, mesActual, diaCorte, mesCargaInicial);

  if (ctx.historialDesde && (a.desde < ctx.historialDesde || b.desde < ctx.historialDesde)) {
    const dias = HISTORIAL_DIAS[ctx.nivel];
    throw new ErrorHistorialPlan(`Disponible en el plan Full: su plan incluye ${dias ? `los últimos ${dias} días` : 'menos historial'}`, 'full');
  }

  return { modo, corte, diaCorte, a, b, avisos: avisosDe(a, b, corte) };
}
