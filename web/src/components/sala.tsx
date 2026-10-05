// Piezas de la sala de control (Etapa 2): indicadores principales con meta, semáforo y tendencia; frases de
// "lo más relevante"; lista de "qué requiere atención"; confianza de los datos; editor de metas.
import { Fragment, useState, type ReactNode } from 'react';
import { enviarJson } from '../api';
import { useAcceso } from '../acceso';
import { fechaHora, num } from '../format';
import { Info } from './ui';

// ------------------------------------------------------------------------------------ minigráfico
/** Línea de las últimas semanas. El último tramo va punteado si esa semana todavía no termina. */
export function Sparkline({ valores, parcial = false, titulo }: { valores: (number | null)[]; parcial?: boolean; titulo?: string }) {
  const puntos = valores.map((v, i) => ({ i, v })).filter((p): p is { i: number; v: number } => p.v !== null && Number.isFinite(p.v));
  if (puntos.length < 2) return null;
  const W = 120;
  const H = 34;
  const min = Math.min(...puntos.map((p) => p.v));
  const max = Math.max(...puntos.map((p) => p.v));
  const rango = max - min || Math.abs(max) || 1;
  const x = (i: number) => (i / (valores.length - 1)) * (W - 6) + 3;
  const y = (v: number) => H - 4 - ((v - min) / rango) * (H - 8);
  const completos = parcial ? puntos.slice(0, -1) : puntos;
  const linea = (ps: typeof puntos) => ps.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const ultimo = puntos[puntos.length - 1];
  return (
    <svg className="sparkline" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={titulo ?? 'Tendencia de las últimas semanas'}>
      <path d={linea(completos)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {parcial && completos.length > 0 && (
        <path d={linea([completos[completos.length - 1], ultimo])} fill="none" stroke="currentColor" strokeWidth="1.8" strokeDasharray="3 3" opacity="0.6" vectorEffect="non-scaling-stroke" />
      )}
      <circle cx={x(ultimo.i)} cy={y(ultimo.v)} r="2.6" fill="currentColor" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// ------------------------------------------------------------------------------------- tendencia
export type Tendencia = 'sube' | 'baja' | 'estable' | null;

/** Promedio de las 3 últimas semanas completas frente a las 3 anteriores. */
export function tendencia(valores: (number | null)[], parcial: boolean, formato: 'num' | 'pct'): Tendencia {
  const completos = (parcial ? valores.slice(0, -1) : valores).filter((v): v is number => v !== null);
  if (completos.length < 6) return null;
  const prom = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const reciente = prom(completos.slice(-3));
  const previo = prom(completos.slice(-6, -3));
  const cambio = formato === 'pct' ? reciente - previo : previo ? (reciente - previo) / previo : 0;
  const umbral = formato === 'pct' ? 0.01 : 0.05;
  return Math.abs(cambio) < umbral ? 'estable' : cambio > 0 ? 'sube' : 'baja';
}

// ------------------------------------------------------------------------------ indicador principal
export interface MetaKpi {
  /** Meta ya llevada al período (las mensuales, prorrateadas). */
  valor: number;
  mejorSiSube: boolean;
  mensual?: boolean;
}

const fmt = (v: number | null, formato: 'num' | 'pct') =>
  v === null ? '—' : formato === 'pct' ? `${(v * 100).toFixed(1).replace('.', ',')} %` : num(v);

export function KpiPrincipal({
  etiqueta, valor, formato = 'num', meta, serie, parcial = false, mejorSiSube = true, anterior, comparacion, definicion, sinMeta,
}: {
  etiqueta: string;
  valor: number | null;
  formato?: 'num' | 'pct';
  meta?: MetaKpi | null;
  serie?: (number | null)[];
  parcial?: boolean;
  mejorSiSube?: boolean;
  anterior?: number | null;
  comparacion?: string;
  definicion: string;
  /** Texto cuando el indicador admite meta pero nadie la ha definido. */
  sinMeta?: string;
}) {
  // Semáforo: contra la meta si existe; si no, según la tendencia.
  let estado: 'bien' | 'cerca' | 'mal' | 'neutro' = 'neutro';
  let lineaMeta: ReactNode = sinMeta ? <span className="kpi-meta-vacia">{sinMeta}</span> : null;
  if (meta && valor !== null) {
    const sube = meta.mejorSiSube;
    const dif = valor - meta.valor;
    const cumple = sube ? dif >= 0 : dif <= 0;
    const tolerancia = formato === 'pct' ? 0.02 : Math.abs(meta.valor) * 0.1;
    estado = cumple ? 'bien' : Math.abs(dif) <= tolerancia ? 'cerca' : 'mal';
    const difTxt =
      formato === 'pct'
        ? `${Math.abs(dif * 100).toFixed(1).replace('.', ',')} pts`
        : `${num(Math.abs(dif))}${meta.valor ? ` (${Math.round((valor / meta.valor) * 100)} % de la meta)` : ''}`;
    const posicion = Math.abs(dif) < (formato === 'pct' ? 0.0005 : 0.5) ? 'en la meta' : `${difTxt} ${dif > 0 ? 'por encima' : 'por debajo'}`;
    lineaMeta = (
      <>
        Meta {sube ? '≥' : '≤'} {fmt(meta.valor, formato)}
        {meta.mensual ? ' en el período' : ''} · <b>{posicion}</b>
      </>
    );
  }
  const tend = serie ? tendencia(serie, parcial, formato) : null;
  const tendTxt = tend === 'sube' ? 'Tendencia al alza' : tend === 'baja' ? 'Tendencia a la baja' : tend === 'estable' ? 'Tendencia estable' : null;
  let sello: string | null = null;
  const conMeta = !!meta && valor !== null;
  if (conMeta) {
    sello = { bien: 'Cumple', cerca: 'Cerca', mal: 'No cumple', neutro: null }[estado];
  } else if (tend) {
    // Sin meta no hay "incumplimiento": una tendencia desfavorable se marca en ámbar, nunca en rojo.
    estado = tend === 'estable' ? 'neutro' : (tend === 'sube') === mejorSiSube ? 'bien' : 'cerca';
    sello = tend === 'sube' ? '▲ Al alza' : tend === 'baja' ? '▼ A la baja' : 'Estable';
  }

  let delta: ReactNode = null;
  if (anterior !== undefined && anterior !== null && valor !== null) {
    if (formato === 'pct') {
      const pp = (valor - anterior) * 100;
      if (Math.abs(pp) >= 0.05) delta = `${pp > 0 ? '▲' : '▼'} ${Math.abs(pp).toFixed(1).replace('.', ',')} pts ${comparacion ?? ''}`;
    } else if (anterior > 0) {
      const c = (valor - anterior) / anterior;
      if (Math.abs(c) >= 0.005) delta = `${c > 0 ? '▲' : '▼'} ${Math.abs(c * 100).toFixed(0)} % ${comparacion ?? ''}`;
    }
  }
  const deltaBueno = delta && anterior !== null && anterior !== undefined && valor !== null ? (valor > anterior) === mejorSiSube : null;

  return (
    <div className={`kpi-principal estado-${estado}`}>
      <div className="kpi-cabeza">
        <span className="etiqueta">
          {etiqueta} <Info texto={definicion} />
        </span>
        {sello && <span className={`sello sello-${estado}`}>{sello}</span>}
      </div>
      <div className="kpi-cuerpo">
        <div className="valor">{fmt(valor, formato)}</div>
        {serie && <Sparkline valores={serie} parcial={parcial} titulo={`${etiqueta}: últimas 8 semanas`} />}
      </div>
      {lineaMeta && <div className="kpi-meta">{lineaMeta}</div>}
      <div className="kpi-pie">
        {conMeta && tendTxt && <span>{tendTxt}</span>}
        {delta && <span className={deltaBueno === null ? '' : deltaBueno ? 'up' : 'down'}>{delta}</span>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------- frases y atención
export interface Frase {
  clave: string;
  texto: string;
  tono: 'positivo' | 'negativo' | 'neutro';
  enlace: string;
}

export interface ItemAtencion {
  clave: string;
  severidad: 'alta' | 'media' | 'info';
  texto: string;
  enlace: string;
}

/** "texto con **negrita**" → nodos. */
export function conNegritas(texto: string): ReactNode {
  return texto.split(/\*\*(.+?)\*\*/g).map((t, i) => (i % 2 ? <b key={i}>{t}</b> : <Fragment key={i}>{t}</Fragment>));
}

/** Página de un enlace "#/ruta?..." → la persona solo ve enlaces a pantallas que su rol y plan permiten. */
function useEnlace() {
  const { yo } = useAcceso();
  return (enlace: string) => {
    const pagina = enlace.replace(/^#\/?/, '').split('?')[0];
    return yo?.paginas[pagina]?.estado === 'ok' ? enlace : null;
  };
}

const ICONO_TONO = { positivo: '▲', negativo: '▼', neutro: '•' };

export function ListaFrases({ frases }: { frases: Frase[] }) {
  const enlace = useEnlace();
  if (!frases.length) return <p className="vacio">No hay cambios destacables en este período. Pruebe con un período más largo o compare otro mes.</p>;
  return (
    <ul className="frases">
      {frases.map((f) => {
        const e = enlace(f.enlace);
        return (
          <li key={f.clave} className={`tono-${f.tono}`}>
            <span className="frase-icono" aria-hidden="true">{ICONO_TONO[f.tono]}</span>
            <span className="frase-texto">{conNegritas(f.texto)}</span>
            {e && <a href={e} className="frase-enlace">Ver detalle</a>}
          </li>
        );
      })}
    </ul>
  );
}

const COLOR_SEV = { alta: 'var(--critical)', media: 'var(--warning)', info: 'var(--accent)' };

export function ListaAtencion({ items }: { items: ItemAtencion[] }) {
  const enlace = useEnlace();
  if (!items.length) {
    return (
      <div className="estado todo-bien">
        <span className="punto" style={{ background: 'var(--good)' }} />✓ Nada requiere atención en este momento.
      </div>
    );
  }
  return (
    <ul className="atencion">
      {items.map((i) => {
        const e = enlace(i.enlace);
        return (
          <li key={i.clave}>
            <span className="punto-inline" style={{ background: COLOR_SEV[i.severidad] }} />
            <span className="atencion-texto">{i.texto}</span>
            {e && <a href={e} className="frase-enlace">Revisar</a>}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------- confianza de los datos
export interface Confianza {
  indice: number;
  nivel: 'alta' | 'media' | 'baja';
  componentes: { clave: string; titulo: string; valor: number; peso: number; detalle: string; enlace: string }[];
}

const NIVEL_CONF = {
  alta: { color: 'var(--good)', texto: 'Alta' },
  media: { color: 'var(--warning)', texto: 'Media' },
  baja: { color: 'var(--critical)', texto: 'Baja' },
};

export function MedidorConfianza({ c, detalle = false }: { c: Confianza; detalle?: boolean }) {
  const n = NIVEL_CONF[c.nivel];
  const enlace = useEnlace();
  const peores = [...c.componentes].filter((x) => x.valor < 0.9).sort((a, b) => a.valor - b.valor);
  return (
    <div className="confianza">
      <div className="confianza-cabeza">
        <div className="confianza-valor" style={{ color: n.color }}>{Math.round(c.indice * 100)} %</div>
        <div>
          <div className="estado"><span className="punto" style={{ background: n.color }} />Confianza {n.texto.toLowerCase()}</div>
          <div className="barra-confianza"><span style={{ width: `${Math.round(c.indice * 100)}%`, background: n.color }} /></div>
        </div>
      </div>
      {detalle ? (
        <ul className="lista-simple confianza-lista">
          {c.componentes.map((x) => {
            const e = enlace(x.enlace);
            const color = x.valor >= 0.9 ? 'var(--good)' : x.valor >= 0.7 ? 'var(--warning)' : 'var(--critical)';
            return (
              <li key={x.clave}>
                <span>
                  <span className="punto-inline" style={{ background: color }} />
                  {x.titulo}
                  <div className="nota" style={{ margin: '2px 0 0 14px' }}>
                    {x.detalle}
                    {e && x.valor < 0.9 && <> · <a href={e}>Revisar</a></>}
                  </div>
                </span>
                <span>{Math.round(x.valor * 100)} %</span>
              </li>
            );
          })}
        </ul>
      ) : peores.length ? (
        <p className="nota">Lo que más la baja: {peores.slice(0, 2).map((x) => x.titulo.toLowerCase()).join(' y ')}.</p>
      ) : (
        <p className="nota">Todas las fuentes de datos están al día y completas.</p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------- metas
export interface Meta {
  titulo: string;
  tipo: 'tasa' | 'mensual';
  mejorSiSube: boolean;
  defecto: number | null;
  valor: number | null;
  actualizado_por: string | null;
  actualizado_at: string | null;
}

export function EditorMetas({ metas, onCambio, onCerrar }: { metas: Record<string, Meta>; onCambio: () => void; onCerrar: () => void }) {
  const [valores, setValores] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(metas).map(([k, m]) => [k, m.valor === null ? '' : m.tipo === 'tasa' ? String(Math.round(m.valor * 1000) / 10) : String(m.valor)])),
  );
  const [msg, setMsg] = useState<string | null>(null);
  const guardar = async (k: string, vacio = false) => {
    const m = metas[k];
    const crudo = (valores[k] ?? '').replace(',', '.').trim();
    const v = vacio || crudo === '' ? null : Number(crudo);
    if (v !== null && (!Number.isFinite(v) || v < 0 || (m.tipo === 'tasa' && v > 100))) {
      setMsg(`${m.titulo}: valor inválido`);
      return;
    }
    try {
      await enviarJson('PUT', '/api/metas', { indicador: k, valor: v === null ? null : m.tipo === 'tasa' ? v / 100 : Math.round(v) });
      setMsg(`${m.titulo}: guardada`);
      onCambio();
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
    }
  };
  return (
    <section className="card editor-metas">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <h3>Metas de los indicadores</h3>
        <button className="boton" onClick={onCerrar}>Cerrar</button>
      </div>
      <p className="ayuda">Las tasas, en porcentaje. Las metas de cantidad son por mes y se ajustan a la duración del período elegido.</p>
      <div className="tabla-wrap">
        <table>
          <thead>
            <tr><th>Indicador</th><th>Meta</th><th>Referencia</th><th>Último cambio</th><th /></tr>
          </thead>
          <tbody>
            {Object.entries(metas).map(([k, m]) => (
              <tr key={k}>
                <td>{m.titulo}</td>
                <td>
                  <span className="entrada-meta">
                    {m.mejorSiSube ? '≥' : '≤'}
                    <input className="boton" inputMode="decimal" style={{ width: 90 }} value={valores[k] ?? ''} placeholder="Sin meta" onChange={(e) => setValores({ ...valores, [k]: e.target.value })} />
                    {m.tipo === 'tasa' ? '%' : 'por mes'}
                  </span>
                </td>
                <td>{m.defecto === null ? '—' : m.tipo === 'tasa' ? `${Math.round(m.defecto * 100)} %` : num(m.defecto)}</td>
                <td>{m.actualizado_at ? `${fechaHora(m.actualizado_at)} · ${m.actualizado_por ?? ''}` : '—'}</td>
                <td style={{ display: 'flex', gap: 6 }}>
                  <button className="boton" onClick={() => guardar(k)}>Guardar</button>
                  {m.actualizado_at && <button className="boton" onClick={() => guardar(k, true)}>Usar referencia</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {msg && <p className="nota">{msg}</p>}
    </section>
  );
}
