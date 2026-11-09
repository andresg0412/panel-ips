// Piezas compartidas del comparativo de periodos (Agenda, Profesionales y Pacientes): selector de meses, avisos,
// indicadores con diferencia y tablas "mes A | mes B | diferencia".
// Diseño: proyecto-ips/docs/features/2026-11-09-comparativo-periodos-panel.md, secciones 4.1 y 6.
import type { ReactNode } from 'react';
import { useAcceso } from '../acceso';
import {
  hayInteranual, mesAValido, mesActual, mesesDisponibles, mesMas,
  type Comparativo, type ControlComparativo, type Modo,
} from '../comparativo';
import { nombreMes, num, tasaTxt } from '../format';
import { Kpi, Tabla, Tarjeta, calcularDelta, type Columna, type Delta } from './ui';
import type { FilaUnida } from './series';

/** Una tasa con menos casos que esto en cualquiera de los dos meses no se compara (el mismo umbral de AGE-01). */
export const MIN_BASE_TASA = 30;

const MODOS: [Modo, string][] = [
  ['mes_anterior', 'Mes anterior'],
  ['interanual', 'Mismo mes del año anterior'],
  ['libre', 'Elegir dos meses'],
];

const conInicialMayuscula = (texto: string) => texto.charAt(0).toUpperCase() + texto.slice(1);

// ------------------------------------------------------------------------------------------------ selector
export function SelectorComparativo({ control, comparativo }: { control: ControlComparativo; comparativo: Comparativo | undefined }) {
  const { yo, nombreNivel } = useAcceso();
  const historialDesde = yo?.historialDesde ?? null;
  const meses = mesesDisponibles();

  /** Los meses que el plan no alcanza se muestran deshabilitados, no se ocultan. */
  const fueraDelPlan = (mes: string) => !!historialDesde && `${mes}-01` < historialDesde;
  const opcion = (mes: string, deshabilitado: boolean) => (
    <option key={mes} value={mes} disabled={deshabilitado || fueraDelPlan(mes)}>
      {nombreMes(mes)}
      {mes === mesActual() ? ' (en curso)' : ''}
      {fueraDelPlan(mes) ? ` · disponible en el plan ${nombreNivel('full')}` : ''}
    </option>
  );

  return (
    <Tarjeta titulo="Meses a comparar" ayuda="Esta vista usa sus propios meses; el rango de fechas de arriba no aplica.">
      <div className="rango" role="group" aria-label="Tipo de comparación">
        {MODOS.map(([modo, texto]) => {
          const sinDatos = modo === 'interanual' && !hayInteranual(control.mesA);
          return (
            <button
              key={modo}
              className={control.modo === modo ? 'activo' : ''}
              aria-pressed={control.modo === modo}
              disabled={sinDatos}
              title={sinDatos ? `No hay datos de ${nombreMes(mesMas(control.mesA, -12))}` : undefined}
              onClick={() => control.cambiarModo(modo)}
            >
              {texto}
            </button>
          );
        })}
      </div>
      <div className="filtros comparativo-filtros">
        <label>
          Mes{' '}
          <select value={control.mesA} onChange={(e) => control.cambiarMesA(e.target.value)}>
            {meses.map((m) => opcion(m, !mesAValido(control.modo, m)))}
          </select>
        </label>
        {control.modo === 'libre' ? (
          <label>
            Comparar con{' '}
            <select value={control.mesB ?? ''} onChange={(e) => control.cambiarMesB(e.target.value)}>
              {meses.map((m) => opcion(m, m === control.mesA))}
            </select>
          </label>
        ) : (
          <span className="comparativo-base">{comparativo ? `comparado con ${comparativo.b.etiqueta}` : ''}</span>
        )}
        <label className="comparativo-corte" title="Compara solo los primeros días de cada mes, hasta ayer si el mes está en curso">
          <input type="checkbox" checked={control.corte === 'mismo_dia'} onChange={(e) => control.cambiarCorte(e.target.checked ? 'mismo_dia' : 'completo')} />{' '}
          Comparar hasta el mismo día
        </label>
      </div>
    </Tarjeta>
  );
}

/** "Octubre 2026 comparado con octubre 2025 · del 1 al 31" */
export function EncabezadoComparativo({ comparativo: c }: { comparativo: Comparativo }) {
  const dias = c.corte === 'mismo_dia' ? `del 1 al ${c.diaCorte} de cada mes` : c.a.dias === c.b.dias ? `del 1 al ${c.a.dias}` : 'meses completos';
  return (
    <h3 style={{ margin: '8px 0 12px' }}>
      {conInicialMayuscula(c.a.etiqueta)} comparado con {c.b.etiqueta} · {dias}
    </h3>
  );
}

/** Notas de interpretación del servidor. Van como texto discreto, no como banner: las alertas viven en Alertas. */
export function AvisosComparativo({ comparativo }: { comparativo: Comparativo }) {
  return (
    <>
      {comparativo.avisos.map((a) => (
        <p key={`${a.codigo}-${a.texto}`} className="nota">
          {a.texto}
        </p>
      ))}
    </>
  );
}

// ------------------------------------------------------------------------------------------------ diferencias
export type TipoMetrica = 'conteo' | 'tasa' | 'promedio';

export const promedioTxt = (v: number) => v.toFixed(1).replace('.', ',');

function textoValor(tipo: TipoMetrica, v: number): string {
  return tipo === 'tasa' ? tasaTxt(v) : tipo === 'promedio' ? promedioTxt(v) : num(v);
}

const conSigno = (v: number, texto: string) => (v > 0 ? `+${texto}` : v < 0 ? `−${texto}` : texto);

/** Por qué no hay diferencia que mostrar (null = sí la hay). */
type Motivo = 'nuevo' | 'sin_citas' | 'sin_dato' | 'pocos_datos' | null;

/** Diferencia en el formato de cada tipo: puntos para una tasa; valor absoluto y porcentaje para un conteo. */
function textoDelta(tipo: TipoMetrica, d: Delta): string {
  const abs = Math.abs(d.absoluta);
  if (tipo === 'tasa') return `${d.flecha} ${conSigno(d.absoluta, promedioTxt(abs))} pts`;
  const absoluta = conSigno(d.absoluta, tipo === 'promedio' ? promedioTxt(abs) : num(abs));
  const relativa = d.relativa === null ? '—' : conSigno(d.relativa, `${Math.abs(d.relativa * 100).toFixed(0)} %`);
  return `${d.flecha} ${absoluta} (${relativa})`;
}

/** Diferencia de una fila o el motivo por el que no se calcula. Sin tasas sobre pocos casos (menos de MIN_BASE_TASA). */
function compararMetrica<F>(m: MetricaTabla<F>, fila: FilaUnida<F>): { motivo: Motivo; delta: Delta | null } {
  if (fila.a === null) return { motivo: 'sin_citas', delta: null };
  if (fila.b === null) return { motivo: 'nuevo', delta: null };
  const a = m.valor(fila.a);
  const b = m.valor(fila.b);
  if (a === null || b === null) return { motivo: 'sin_dato', delta: null };
  if (m.tipo === 'tasa' && m.base && (m.base(fila.a) < MIN_BASE_TASA || m.base(fila.b) < MIN_BASE_TASA)) return { motivo: 'pocos_datos', delta: null };
  return { motivo: null, delta: calcularDelta(a, b, m.tipo === 'tasa' ? 'pct' : 'num', m.mejorSiSube) };
}

/** Diferencia entre dos meses: flecha, signo y color (el color nunca es la única señal). */
export function DeltaCelda({ motivo, delta, tipo, etiquetaA }: { motivo: Motivo; delta: Delta | null; tipo: TipoMetrica; etiquetaA: string }) {
  if (delta) return <span className={`delta-celda ${delta.clase}`}>{textoDelta(tipo, delta)}</span>;
  const textos: Record<Exclude<Motivo, null>, string> = {
    nuevo: `Nuevo en ${etiquetaA}`,
    sin_citas: `Sin citas en ${etiquetaA}`,
    sin_dato: '—',
    pocos_datos: 'pocos datos',
  };
  return <span className="delta-celda apagado">{textos[motivo ?? 'sin_dato']}</span>;
}

// ------------------------------------------------------------------------------------------------ indicadores
/** Indicador de un mes comparado con el otro. Para una tasa, pasar la base de cada mes (asistió + no asistió, etc.). */
export function KpiComparado({ etiqueta, a, b, comparativo, formato = 'num', mejorSiSube = null, ayuda, baseA, baseB, valor }: {
  etiqueta: string;
  /** Texto del valor del mes A si no basta el formato por defecto (p. ej. un promedio con un decimal). */
  valor?: string;
  a: number | null;
  b: number | null;
  comparativo: Comparativo;
  formato?: 'num' | 'pct';
  /** null = métrica neutra (sin color). */
  mejorSiSube?: boolean | null;
  ayuda?: string;
  baseA?: number;
  baseB?: number;
}) {
  const pocos = formato === 'pct' && ((baseA ?? MIN_BASE_TASA) < MIN_BASE_TASA || (baseB ?? MIN_BASE_TASA) < MIN_BASE_TASA);
  const sinComparacion = pocos
    ? 'pocos datos'
    : formato === 'num' && a !== null && b === 0
      ? `${conSigno(a, num(a))} · sin datos en ${comparativo.b.etiqueta}`
      : undefined;
  return (
    <Kpi
      etiqueta={etiqueta}
      valor={valor}
      ayuda={ayuda}
      actual={a}
      anterior={b}
      formato={formato}
      mejorSiSube={mejorSiSube}
      comparacion={`vs ${nombreMes(comparativo.b.mes, true)}`}
      sinComparacion={sinComparacion}
    />
  );
}

// ------------------------------------------------------------------------------------------------ tabla
export interface MetricaTabla<F> {
  titulo: string;
  tipo: TipoMetrica;
  /** Valor de la fila en un mes; una tasa va en proporción (0–1). null = sin dato. */
  valor: (fila: F) => number | null;
  /** null = métrica neutra (sin color). */
  mejorSiSube: boolean | null;
  /** Casos sobre los que se calcula una tasa, para marcar "pocos datos". */
  base?: (fila: F) => number;
  /** Sus columnas empiezan ocultas (se eligen con "Elegir columnas" y salen en el CSV). */
  oculta?: boolean;
}

/** Número para el CSV: sin símbolos, con coma decimal (Excel en español) y las tasas en puntos porcentuales. */
function numeroCsv(v: number | null | undefined, decimales = 2): string {
  return v === null || v === undefined ? '' : String(Number(v.toFixed(decimales))).replace('.', ',');
}

/**
 * Tabla con una fila por clave y, para cada métrica, tres columnas: mes A, mes B y diferencia. Las filas que existen
 * en un solo mes se conservan y lo dicen ("Nuevo en…", "Sin citas en…").
 */
export function TablaComparativa<F>({ titulo, filas, metricas, comparativo, nombreCsv, nombre = (clave) => clave, extras = [], alFila, vacio }: {
  /** Encabezado de la primera columna (Profesional, Especialidad…). */
  titulo: string;
  filas: FilaUnida<F>[];
  metricas: MetricaTabla<F>[];
  comparativo: Comparativo;
  /** Nombre del archivo CSV sin extensión ni meses (se le agregan). */
  nombreCsv: string;
  /** Texto de la fila a partir de su clave. */
  nombre?: (clave: string) => string;
  /** Columnas fijas después del nombre (p. ej. la especialidad). */
  extras?: Columna<FilaUnida<F>>[];
  alFila?: (fila: FilaUnida<F>) => void;
  vacio?: string;
}) {
  const mesA = nombreMes(comparativo.a.mes, true);
  const mesB = nombreMes(comparativo.b.mes, true);
  const celdaValor = (m: MetricaTabla<F>, fila: F | null): ReactNode => {
    const v = fila === null ? null : m.valor(fila);
    if (fila === null || v === null) return '—';
    const pocos = m.tipo === 'tasa' && m.base !== undefined && m.base(fila) < MIN_BASE_TASA;
    return pocos ? <span className="delta-celda apagado">{textoValor(m.tipo, v)}</span> : textoValor(m.tipo, v);
  };
  const csvValor = (m: MetricaTabla<F>, fila: F | null) => {
    const v = fila === null ? null : m.valor(fila);
    return numeroCsv(v === null ? null : m.tipo === 'tasa' ? v * 100 : v);
  };

  const columnas: Columna<FilaUnida<F>>[] = [
    { clave: 'clave', titulo, formato: (clave) => nombre(String(clave)), csv: (clave) => nombre(String(clave)) },
    ...extras,
    ...metricas.flatMap((m): Columna<FilaUnida<F>>[] => {
      const comun = { num: true, oculta: m.oculta };
      const delta = (f: FilaUnida<F>) => compararMetrica(m, f);
      /** Diferencia relativa en puntos de porcentaje del valor (8 = +8 %); null si no aplica. */
      const relativa = (f: FilaUnida<F>) => {
        const r = delta(f).delta?.relativa;
        return r === null || r === undefined ? null : r * 100;
      };
      const columnasDelta: Columna<FilaUnida<F>>[] = [
        {
          ...comun,
          clave: 'clave',
          titulo: `${m.titulo} · Δ`,
          formato: (_v, f) => <DeltaCelda {...delta(f)} tipo={m.tipo} etiquetaA={mesA} />,
          csv: (_v, f) => numeroCsv(delta(f).delta?.absoluta),
          orden: (f) => delta(f).delta?.absoluta ?? null,
        },
      ];
      // Un conteo o promedio tiene además diferencia relativa; en el CSV va en su propia columna.
      if (m.tipo !== 'tasa') {
        columnasDelta.push({
          num: true,
          oculta: true,
          clave: 'clave',
          titulo: `${m.titulo} · Δ %`,
          formato: (_v, f) => {
            const r = relativa(f);
            return r === null ? '—' : conSigno(r, `${Math.abs(r).toFixed(0)} %`);
          },
          csv: (_v, f) => numeroCsv(relativa(f), 1),
          orden: relativa,
        });
      }
      return [
        { ...comun, clave: 'a', titulo: `${m.titulo} · ${mesA}`, formato: (_v, f) => celdaValor(m, f.a), csv: (_v, f) => csvValor(m, f.a), orden: (f) => (f.a ? m.valor(f.a) : null) },
        { ...comun, clave: 'b', titulo: `${m.titulo} · ${mesB}`, formato: (_v, f) => celdaValor(m, f.b), csv: (_v, f) => csvValor(m, f.b), orden: (f) => (f.b ? m.valor(f.b) : null) },
        ...columnasDelta,
      ];
    }),
  ];

  return <Tabla filas={filas} columnas={columnas} nombreCsv={`${nombreCsv}_${comparativo.a.mes}_vs_${comparativo.b.mes}`} alFila={alFila} vacio={vacio} />;
}
