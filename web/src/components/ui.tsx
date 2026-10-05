import { useMemo, useState, type ReactNode } from 'react';
import { registrar, type Rango } from '../api';
import { num } from '../format';
import { useAcceso, Candado } from '../acceso';

/** Definición de una métrica: una "i" que muestra el texto al pasar el cursor o al enfocarla con el teclado. */
export function Info({ texto }: { texto: string }) {
  return (
    <span className="info" tabIndex={0} role="note" aria-label={texto} data-tip={texto}>
      i
    </span>
  );
}

/**
 * Tipo de métrica (Etapa 3): un distintivo pequeño junto al título, con su explicación al pasar el cursor. Sin
 * distintivo, la cifra es observada: se cuenta directamente de los registros. No es un aviso ni un banner.
 */
export type TipoMarca = 'observada' | 'estimada' | 'incompleta' | 'incidente';

export interface MarcaDato {
  tipo: TipoMarca;
  /** Explicación propia de la tarjeta; si falta, la general del tipo. */
  detalle?: string;
}

const MARCAS: Record<TipoMarca, { texto: string; explicacion: string }> = {
  observada: { texto: 'Observada', explicacion: 'Se cuenta directamente de los registros del bot, de WhatsApp o de la agenda.' },
  estimada: { texto: 'Estimada', explicacion: 'Se calcula con un supuesto o con un enlace inferido entre registros (por ejemplo, mensaje y cita por teléfono y fecha).' },
  incompleta: { texto: 'Incompleta', explicacion: 'Parte del período no tiene este dato registrado: la cifra cubre solo los días con datos.' },
  incidente: { texto: 'Afectada por incidente', explicacion: 'El período toca un incidente conocido de registro de datos: la cifra puede quedar por debajo de la real.' },
};

export function Marca({ tipo, detalle }: MarcaDato) {
  const m = MARCAS[tipo];
  const tip = detalle ?? m.explicacion;
  return (
    <span className={`marca marca-${tipo}`} tabIndex={0} role="note" aria-label={`${m.texto}: ${tip}`} data-tip={tip}>
      {m.texto}
    </span>
  );
}

export function Tarjeta({ titulo, ayuda, children, accion, marcas }: {
  titulo: string;
  ayuda?: ReactNode;
  children: ReactNode;
  accion?: ReactNode;
  /** Tipo de métrica (estimada, incompleta, afectada por incidente). Las vacías se ignoran. */
  marcas?: (MarcaDato | null | undefined | false)[];
}) {
  const ms = (marcas ?? []).filter((m): m is MarcaDato => !!m);
  return (
    <section className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
        <h3>
          {titulo}
          {ms.map((m) => <Marca key={m.tipo} {...m} />)}
        </h3>
        {accion}
      </div>
      {ayuda ? <p className="ayuda">{ayuda}</p> : <div style={{ height: 10 }} />}
      {children}
    </section>
  );
}

/**
 * Indicador con comparación contra el período anterior.
 * `mejorSiSube=false` para métricas donde subir es malo (cancelaciones, abandono).
 */
export function Kpi({ etiqueta, valor, actual, anterior, mejorSiSube = true, formato = 'num', comparacion = 'vs período anterior', meta, ayuda }: {
  etiqueta: string;
  /** Definición de la métrica (se muestra en la "i"). */
  ayuda?: string;
  valor?: string;
  actual: number | null;
  anterior?: number | null;
  mejorSiSube?: boolean;
  formato?: 'num' | 'pct';
  /** Texto de la comparación, p. ej. 'vs mismo período de 2025'. */
  comparacion?: string;
  /** Meta: muestra un indicador (✓ cumple / ! cerca / ✕ lejos). Para pct, en proporción (0,92). */
  meta?: { valor: number; mejorSiSube?: boolean };
}) {
  const mostrar = valor ?? (actual === null ? '—' : formato === 'pct' ? `${(actual * 100).toFixed(1).replace('.', ',')} %` : num(actual));
  let delta: ReactNode = <span className="delta">&nbsp;</span>;
  if (anterior !== undefined && anterior !== null && actual !== null) {
    if (formato === 'pct') {
      const pp = (actual - anterior) * 100;
      const clase = Math.abs(pp) < 0.05 ? '' : (pp > 0) === mejorSiSube ? 'up' : 'down';
      delta = (
        <span className={`delta ${clase}`}>
          {pp > 0 ? '▲' : pp < 0 ? '▼' : '='} {Math.abs(pp).toFixed(1).replace('.', ',')} pts {comparacion}
        </span>
      );
    } else if (anterior > 0) {
      const cambio = (actual - anterior) / anterior;
      const clase = Math.abs(cambio) < 0.005 ? '' : (cambio > 0) === mejorSiSube ? 'up' : 'down';
      delta = (
        <span className={`delta ${clase}`}>
          {cambio > 0 ? '▲' : cambio < 0 ? '▼' : '='} {Math.abs(cambio * 100).toFixed(0)} % {comparacion} ({num(anterior)})
        </span>
      );
    } else {
      delta = <span className="delta">0 en el período anterior</span>;
    }
  }
  let indicadorMeta: ReactNode = null;
  if (meta && actual !== null) {
    const sube = meta.mejorSiSube ?? true;
    const cumple = sube ? actual >= meta.valor : actual <= meta.valor;
    const cerca = Math.abs(actual - meta.valor) <= Math.abs(meta.valor) * 0.05;
    const [color, simbolo, texto] = cumple ? ['var(--good)', '✓', 'Cumple'] : cerca ? ['var(--warning)', '!', 'Cerca'] : ['var(--critical)', '✕', 'Por debajo'];
    const metaTxt = formato === 'pct' ? `${(meta.valor * 100).toFixed(0)} %` : num(meta.valor);
    indicadorMeta = (
      <span className="delta" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="punto" style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' }} />
        {simbolo} {texto} la meta ({sube ? '≥' : '≤'} {metaTxt})
      </span>
    );
  }
  return (
    <div className="kpi">
      <div className="etiqueta">
        {etiqueta}
        {ayuda && <> <Info texto={ayuda} /></>}
      </div>
      <div className="valor">{mostrar}</div>
      {delta}
      {indicadorMeta}
    </div>
  );
}

export function Estado({ cargando, error, hayDatos, forma = 'tarjetas' }: {
  cargando: boolean;
  error: string | null;
  hayDatos: boolean;
  /** Silueta mientras carga: indicadores + gráfico, o solo un bloque. */
  forma?: 'tarjetas' | 'bloque';
}) {
  if (error) return <div className="error">No se pudieron cargar los datos: {error}</div>;
  if (cargando && !hayDatos) return <Esqueleto forma={forma} />;
  return null;
}

/** Silueta animada mientras llegan los datos (en vez de un "Cargando…"). */
export function Esqueleto({ forma = 'tarjetas' }: { forma?: 'tarjetas' | 'bloque' }) {
  return (
    <div className="esqueleto" aria-busy="true" aria-label="Cargando">
      {forma === 'tarjetas' && (
        <div className="esqueleto-fila">
          {[0, 1, 2, 3].map((i) => <span key={i} className="esqueleto-kpi" />)}
        </div>
      )}
      <span className="esqueleto-bloque" />
    </div>
  );
}

export interface Columna<T> {
  clave: keyof T & string;
  titulo: string;
  num?: boolean;
  formato?: (v: any, fila: T) => ReactNode;
  /** Texto plano para el CSV (por defecto el valor crudo). */
  csv?: (v: any, fila: T) => string;
  /** Valor para ordenar cuando la columna es calculada (por defecto el valor crudo). */
  orden?: (fila: T) => number | string | null;
  /** Texto largo: se ajusta en varias líneas en vez de ensanchar la tabla. */
  envolver?: boolean;
}

function aCsv<T>(filas: T[], cols: Columna<T>[]): string {
  const esc = (s: string) => (/[";,\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const enc = cols.map((c) => esc(c.titulo)).join(';');
  const cuerpo = filas.map((f) => cols.map((c) => esc(c.csv ? c.csv(f[c.clave], f) : String(f[c.clave] ?? ''))).join(';'));
  return [enc, ...cuerpo].join('\n');
}

export function descargarCsv<T>(nombre: string, filas: T[], cols: Columna<T>[]) {
  registrar('exportacion', nombre, `${filas.length} filas`);
  // BOM para que Excel abra bien las tildes; ';' como separador (configuración regional de Colombia).
  const blob = new Blob(['﻿' + aCsv(filas, cols)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${nombre}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function Tabla<T extends Record<string, any>>({ filas, columnas, nombreCsv, alFila, vacio = 'Sin datos para este período' }: {
  filas: T[];
  columnas: Columna<T>[];
  nombreCsv?: string;
  alFila?: (f: T) => void;
  vacio?: string;
}) {
  const [orden, setOrden] = useState<{ col: number; asc: boolean } | null>(null);
  const { puede, visible, nivelDe, nombreNivel } = useAcceso();
  const ordenadas = useMemo(() => {
    if (!orden) return filas;
    const c = columnas[orden.col];
    if (!c) return filas;
    const valor = (f: T) => (c.orden ? c.orden(f) : f[c.clave]);
    return [...filas].sort((a, b) => {
      const va = valor(a), vb = valor(b);
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      const r = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va ?? '').localeCompare(String(vb ?? ''), 'es');
      return orden.asc ? r : -r;
    });
  }, [filas, orden, columnas]);

  return (
    <>
      <div className="tabla-wrap">
        <table>
          <thead>
            <tr>
              {columnas.map((c, ci) => (
                <th
                  key={ci}
                  className={c.num ? 'num' : ''}
                  onClick={() => setOrden((o) => ({ col: ci, asc: o?.col === ci ? !o.asc : !c.num }))}
                >
                  {c.titulo}
                  {orden?.col === ci ? (orden.asc ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ordenadas.length === 0 ? (
              <tr>
                <td colSpan={columnas.length} className="celda-vacia">
                  {vacio}
                  {vacio === 'Sin datos para este período' && <span> · Pruebe con un período más largo.</span>}
                </td>
              </tr>
            ) : (
              ordenadas.map((f, i) => (
                <tr key={i} onClick={alFila ? () => alFila(f) : undefined} className={alFila ? 'resultado-busqueda' : ''}>
                  {columnas.map((c, ci) => (
                    <td key={ci} className={c.num ? 'num' : ''} style={c.envolver ? { whiteSpace: 'normal', minWidth: 200 } : undefined}>
                      {c.formato ? c.formato(f[c.clave], f) : c.num ? num(f[c.clave]) : String(f[c.clave] ?? '—')}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {nombreCsv && filas.length > 0 && (
        <div className="tabla-pie">
          <span>{num(filas.length)} filas</span>
          {puede('exportar.csv') ? (
            <button className="boton" onClick={() => descargarCsv(nombreCsv, ordenadas, columnas)}>Descargar CSV</button>
          ) : visible('exportar.csv') ? (
            <span className="boton boton-bloqueado" title={`Descargar CSV: disponible en el plan ${nombreNivel(nivelDe('exportar.csv'))}`}>
              <Candado /> Descargar CSV
            </span>
          ) : null}
        </div>
      )}
    </>
  );
}

function hoyBogota(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
}
function menosDias(f: string, d: number) {
  return new Date(Date.parse(`${f}T00:00:00Z`) - d * 86_400_000).toISOString().slice(0, 10);
}

export function rangoPreset(clave: string): Rango {
  const hoy = hoyBogota();
  const [a, m] = hoy.split('-').map(Number);
  switch (clave) {
    case '7d': return { desde: menosDias(hoy, 6), hasta: hoy };
    case '90d': return { desde: menosDias(hoy, 89), hasta: hoy };
    case 'mes': return { desde: `${hoy.slice(0, 8)}01`, hasta: hoy };
    case 'mesant': {
      const ini = new Date(Date.UTC(a, m - 2, 1)).toISOString().slice(0, 10);
      const fin = new Date(Date.UTC(a, m - 1, 0)).toISOString().slice(0, 10);
      return { desde: ini, hasta: fin };
    }
    case 'anio': return { desde: `${a}-01-01`, hasta: hoy };
    // Inicio de los datos: agosto de 2025.
    case 'todo': return { desde: '2025-08-01', hasta: hoy };
    default: return { desde: menosDias(hoy, 29), hasta: hoy };
  }
}

const PRESETS: [string, string][] = [
  ['7d', '7 días'],
  ['30d', '30 días'],
  ['90d', '90 días'],
  ['mes', 'Este mes'],
  ['mesant', 'Mes anterior'],
  ['anio', 'Este año'],
  ['todo', 'Todo'],
];

export function SelectorRango({ rango, preset, onCambio, minimo }: { rango: Rango; preset: string; onCambio: (r: Rango, preset: string) => void; minimo?: string | null }) {
  return (
    <div className="rango">
      {PRESETS.map(([k, t]) => (
        <button key={k} className={preset === k ? 'activo' : ''} onClick={() => onCambio(rangoPreset(k), k)}>{t}</button>
      ))}
      <input type="date" value={rango.desde} min={minimo ?? undefined} max={rango.hasta} onChange={(e) => e.target.value && onCambio({ ...rango, desde: e.target.value }, 'custom')} aria-label="Desde" />
      <span style={{ color: 'var(--muted)' }}>a</span>
      <input type="date" value={rango.hasta} min={rango.desde} onChange={(e) => e.target.value && onCambio({ ...rango, hasta: e.target.value }, 'custom')} aria-label="Hasta" />
      {minimo && (
        <span className="historial" title="El historial consultable depende del plan">
          <Candado /> Historial desde el {minimo.split('-').reverse().join('/')}
        </span>
      )}
    </div>
  );
}

export function ListaConteo({ items, total }: { items: { clave: string; etiqueta: string; n: number }[]; total?: number }) {
  if (items.length === 0) return <p className="vacio">Sin datos para este período. Pruebe con un período más largo.</p>;
  return (
    <ul className="lista-simple">
      {items.map((i) => (
        <li key={i.clave}>
          <span>{i.etiqueta}</span>
          <span>
            {num(i.n)}
            {total ? <span style={{ color: 'var(--muted)', fontWeight: 400 }}> · {((i.n / total) * 100).toFixed(0)} %</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
