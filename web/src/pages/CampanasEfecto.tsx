import { useCallback, useMemo, useState } from 'react';
import { conRango, useApi, type Rango } from '../api';
import Grafico from '../components/Grafico';
import { barrasTasa, embudo } from '../components/series';
import { Estado, Tabla, Tarjeta, type Columna } from '../components/ui';
import { etiqueta, fecha, fechaCorta, mesCorto, num, pct } from '../format';

// ---------------------------------------------------------------------------------------------
// CAM-02: embudo de una campaña
// ---------------------------------------------------------------------------------------------
interface Embudo {
  campana: string;
  etapas: { aceptados: number; entregados: number; leidos: number; respondieron: number; confirmaron: number; asistieron: number; confirmaron_y_asistieron: number };
  seguimientoDesde: string | null;
}

const CAMPANAS = ['reminder', 'execute', 'daily', 'recuperacion', 'conasistencia'];

function EmbudoCampana({ rango }: { rango: Rango }) {
  const [campana, setCampana] = useState('reminder');
  const { data, error, cargando } = useApi<Embudo>(conRango('/api/campanas/embudo', rango, { campana }), 300_000);
  // Entrega y lectura solo existen desde el 30-sep-2026: si el período empieza antes, esas etapas se omiten.
  const conSeguimiento = !!data?.seguimientoDesde && rango.desde >= data.seguimientoDesde;
  const pideRespuesta = campana !== 'daily';

  const opt = useCallback(() => {
    const e = data!.etapas;
    const etapas = [{ nombre: 'Mensajes enviados', valor: e.aceptados }];
    if (conSeguimiento) etapas.push({ nombre: 'Entregados', valor: e.entregados }, { nombre: 'Leídos', valor: e.leidos });
    if (pideRespuesta) etapas.push({ nombre: 'Respondieron', valor: e.respondieron }, { nombre: 'Confirmaron la cita', valor: e.confirmaron });
    if (campana === 'daily') etapas.push({ nombre: 'Asistieron a la cita', valor: e.asistieron });
    else if (campana !== 'recuperacion' && campana !== 'conasistencia') etapas.push({ nombre: 'Confirmaron y asistieron', valor: e.confirmaron_y_asistieron });
    return embudo(etapas);
  }, [data, conSeguimiento, pideRespuesta, campana]);

  return (
    <Tarjeta
      titulo="Del mensaje a la cita atendida"
      ayuda={
        conSeguimiento || !data?.seguimientoDesde
          ? 'Porcentaje de cada etapa sobre la anterior.'
          : `Porcentaje de cada etapa sobre la anterior. Entregados y leídos se muestran solo para períodos desde el ${fecha(data.seguimientoDesde)}.`
      }
      accion={
        <select className="boton" value={campana} onChange={(e) => setCampana(e.target.value)}>
          {CAMPANAS.map((c) => (
            <option key={c} value={c}>{etiqueta(c)}</option>
          ))}
        </select>
      }
    >
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && (data.etapas.aceptados ? <Grafico opcion={opt} alto={260} /> : <p className="ayuda">Esta campaña no envió mensajes en el período.</p>)}
    </Tarjeta>
  );
}

// ---------------------------------------------------------------------------------------------
// CAM-03 y CAM-04: inasistencia según el contacto y cobertura de recordatorios
// ---------------------------------------------------------------------------------------------
interface Contacto {
  filas: { clave: string; citas: number; cerradas: number; no_asistio: number; con_48h: number; con_24h: number; con_2h: number }[];
}

const GRUPOS_CONTACTO: Record<string, string> = {
  confirmo_whatsapp: 'Confirmó por WhatsApp',
  recibio_sin_confirmar: 'Recibió recordatorio, no confirmó',
  sin_recordatorio: 'No recibió recordatorio',
  envio_fallido: 'El recordatorio falló',
  sin_telefono_valido: 'Sin teléfono válido',
};

function ContactoAsistencia({ rango }: { rango: Rango }) {
  const { data, error, cargando } = useApi<Contacto>(conRango('/api/campanas/contacto', rango), 300_000);
  const total = useMemo(() => (data?.filas ?? []).reduce((s, f) => s + f.citas, 0), [data]);
  const promedio = useMemo(() => {
    const f = data?.filas ?? [];
    const c = f.reduce((s, x) => s + x.cerradas, 0);
    return c ? f.reduce((s, x) => s + x.no_asistio, 0) / c : undefined;
  }, [data]);

  const opt = useCallback(
    () =>
      barrasTasa(
        Object.keys(GRUPOS_CONTACTO)
          .map((k) => data!.filas.find((f) => f.clave === k))
          .filter((f): f is Contacto['filas'][number] => !!f)
          .map((f) => ({ nombre: GRUPOS_CONTACTO[f.clave], parte: f.no_asistio, total: f.cerradas })),
        30,
        promedio,
      ),
    [data, promedio],
  );

  const g = (k: string) => data?.filas.find((f) => f.clave === k);
  const con = (campo: 'con_48h' | 'con_24h' | 'con_2h') => (data?.filas ?? []).reduce((s, f) => s + f[campo], 0);
  const llego = total - (g('sin_recordatorio')?.citas ?? 0) - (g('sin_telefono_valido')?.citas ?? 0) - (g('envio_fallido')?.citas ?? 0);

  return (
    <>
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && total > 0 && (
        <div className="grid g2">
          <Tarjeta
            titulo="¿Faltan menos los que confirman por WhatsApp?"
            ayuda="Inasistencia de las citas ya ocurridas, según lo que pasó con sus recordatorios. Es una asociación: quien confirma ya tenía intención de venir."
          >
            <Grafico opcion={opt} alto={240} />
          </Tarjeta>
          <Tarjeta titulo="¿A cuántas citas les llega el recordatorio?" ayuda="Citas ya ocurridas del período y los recordatorios que recibieron.">
            <div className="cifras">
              <div className="cifra">
                <div className="n">{pct(llego, total, 0)}</div>
                <div className="t">de las citas recibió al menos un recordatorio</div>
              </div>
              <div className="cifra">
                <div className="n">{pct(g('confirmo_whatsapp')?.citas ?? 0, total, 0)}</div>
                <div className="t">se confirmaron por WhatsApp</div>
              </div>
            </div>
            <ul className="lista-simple" style={{ marginTop: 12 }}>
              <li><span>Recordatorio 48 h</span><span>{pct(con('con_48h'), total, 0)}</span></li>
              <li><span>Confirmación 24 h</span><span>{pct(con('con_24h'), total, 0)}</span></li>
              <li><span>Recordatorio 2 h</span><span>{pct(con('con_2h'), total, 0)}</span></li>
              <li><span>Sin recordatorio</span><span>{num(g('sin_recordatorio')?.citas ?? 0)} citas</span></li>
              <li><span>Sin teléfono válido</span><span>{num(g('sin_telefono_valido')?.citas ?? 0)} citas</span></li>
            </ul>
          </Tarjeta>
        </div>
      )}
      {data && total === 0 && <p className="ayuda">Sin citas ocurridas en el período.</p>}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// CAM-05: efecto de las campañas de recuperación y seguimiento
// ---------------------------------------------------------------------------------------------
interface Recuperacion {
  filas: { campana: string; mes: string; llego: boolean; envios: number; volvieron_30d: number; asistieron_60d: number }[];
}
interface FilaRec {
  grupo: string;
  envios: number;
  volvieron_30d: number;
  asistieron_60d: number;
}
const COLS_REC: Columna<FilaRec>[] = [
  { clave: 'grupo', titulo: 'Grupo' },
  { clave: 'envios', titulo: 'Pacientes', num: true },
  { clave: 'volvieron_30d', titulo: 'Agendaron en 30 días', num: true, formato: (v, f) => pct(v, f.envios, 0), orden: (f) => f.volvieron_30d / f.envios },
  { clave: 'asistieron_60d', titulo: 'Asistieron en 60 días', num: true, formato: (v, f) => pct(v, f.envios, 0), orden: (f) => f.asistieron_60d / f.envios },
];

function EfectoRecuperacion() {
  const { data, error, cargando } = useApi<Recuperacion>('/api/campanas/recuperacion');
  // Comparación limpia: abril de 2026 (WhatsApp rechazaba los mensajes y la agenda todavía se registraba)
  // frente a marzo de 2026 (los mensajes llegaban). Ambos meses con ventana completa.
  const filas = useMemo<FilaRec[]>(() => {
    if (!data) return [];
    const res: FilaRec[] = [];
    for (const c of ['recuperacion', 'conasistencia']) {
      const conMsg = data.filas.filter((f) => f.campana === c && f.llego && f.mes === '2026-03');
      const sinMsg = data.filas.filter((f) => f.campana === c && !f.llego && f.mes === '2026-04');
      const sum = (xs: typeof conMsg, grupo: string) => ({
        grupo,
        envios: xs.reduce((s, x) => s + x.envios, 0),
        volvieron_30d: xs.reduce((s, x) => s + x.volvieron_30d, 0),
        asistieron_60d: xs.reduce((s, x) => s + x.asistieron_60d, 0),
      });
      if (conMsg.length) res.push(sum(conMsg, `${etiqueta(c)}: recibieron el mensaje (mar-2026)`));
      if (sinMsg.length) res.push(sum(sinMsg, `${etiqueta(c)}: elegidos sin mensaje (abr-2026)`));
    }
    return res;
  }, [data]);

  const historico = useMemo(
    () =>
      (data?.filas ?? [])
        .filter((f) => f.llego)
        .map((f) => ({ grupo: `${etiqueta(f.campana)} · ${mesCorto(f.mes)}`, envios: f.envios, volvieron_30d: f.volvieron_30d, asistieron_60d: f.asistieron_60d })),
    [data],
  );

  return (
    <Tarjeta
      titulo="¿Las campañas de recuperación traen pacientes de vuelta?"
      ayuda="Compara a quienes recibieron el mensaje con pacientes igual de elegibles que no lo recibieron porque WhatsApp los rechazó durante el incidente de abril. Muestras pequeñas: tómelo como orientación, no como prueba."
    >
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && (
        <>
          <Tabla filas={filas} columnas={COLS_REC} vacio="Sin datos suficientes para comparar" />
          <p className="nota">
            En estos datos no se ve una diferencia clara entre recibir o no el mensaje. Para medir el efecto de verdad haría falta dejar sin mensaje, a propósito, a una parte
            pequeña de los pacientes elegibles durante unas semanas.
          </p>
          <details style={{ marginTop: 8 }}>
            <summary className="ayuda" style={{ cursor: 'pointer' }}>Ver todos los meses</summary>
            <Tabla filas={historico} columnas={COLS_REC} nombreCsv="recuperacion_por_mes" />
          </details>
        </>
      )}
    </Tarjeta>
  );
}

export default function CampanasEfecto({ rango }: { rango: Rango }) {
  return (
    <>
      <EmbudoCampana rango={rango} />
      <ContactoAsistencia rango={rango} />
      <EfectoRecuperacion />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// CAM-07: calendario de ejecuciones (también se usa en Alertas)
// ---------------------------------------------------------------------------------------------
interface Ejecucion {
  fecha: string;
  campana: string;
  corridas: number;
  procesadas: number;
  exitosos: number;
  errores: number;
}

const MAX_DIAS_CALENDARIO = 35;

function estadoCelda(e: Ejecucion | undefined, programada: boolean) {
  if (!e) return programada ? { color: 'var(--warning)', simbolo: '!', texto: 'No corrió' } : { color: 'var(--surface-2)', simbolo: '', texto: 'No programada' };
  if (e.procesadas > 0 && e.exitosos === 0) return { color: 'var(--critical)', simbolo: '✕', texto: 'Procesó citas y no envió nada' };
  // Un error suelto (un número que WhatsApp rechaza) es normal; se advierte si falla más del 10 %.
  if (e.errores > 0 && e.errores > 0.1 * Math.max(e.procesadas, 1)) return { color: 'var(--warning)', simbolo: '!', texto: 'Muchos envíos con error' };
  if (e.procesadas === 0) return { color: 'var(--s-other)', simbolo: '–', texto: 'Sin citas para enviar' };
  return { color: 'var(--good)', simbolo: '✓', texto: 'Envió mensajes' };
}

export function CalendarioEjecuciones({ rango }: { rango: Rango }) {
  // Para que el calendario sea legible se muestran como máximo los últimos 35 días del período.
  const desde = useMemo(() => {
    const min = new Date(Date.parse(rango.hasta) - (MAX_DIAS_CALENDARIO - 1) * 86_400_000).toISOString().slice(0, 10);
    return rango.desde > min ? rango.desde : min;
  }, [rango]);
  const { data, error, cargando } = useApi<{ filas: Ejecucion[] }>(conRango('/api/campanas/ejecuciones', { desde, hasta: rango.hasta }), 120_000);

  const dias = useMemo(() => {
    const out: string[] = [];
    for (let t = Date.parse(desde); t <= Date.parse(rango.hasta); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
    return out;
  }, [desde, rango.hasta]);
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());

  return (
    <>
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'separate', borderSpacing: 3, width: 'auto' }}>
            <thead>
              <tr>
                <th style={{ background: 'none', position: 'static' }} />
                {dias.map((d) => (
                  <th key={d} style={{ background: 'none', position: 'static', padding: '0 2px', fontWeight: 400, fontSize: 11, color: 'var(--muted)' }}>
                    {new Date(`${d}T12:00:00Z`).getUTCDay() === 1 || d === dias[0] ? fechaCorta(d) : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CAMPANAS.map((c) => {
                const activa = data.filas.some((f) => f.campana === c);
                return (
                  <tr key={c}>
                    <td style={{ padding: '0 8px 0 0', border: 0, fontSize: 12.5 }}>{etiqueta(c)}</td>
                    {dias.map((d) => {
                      const e = data.filas.find((f) => f.campana === c && f.fecha === d);
                      const domingo = new Date(`${d}T12:00:00Z`).getUTCDay() === 0;
                      const programada = activa && d < hoy && !(c === 'daily' && domingo);
                      const s = estadoCelda(e, programada);
                      const det = e ? ` · ${num(e.procesadas)} citas, ${num(e.exitosos)} enviados${e.errores ? `, ${num(e.errores)} errores` : ''}` : '';
                      return (
                        <td
                          key={d}
                          title={`${etiqueta(c)} · ${fecha(d)}: ${s.texto}${det}`}
                          style={{ width: 22, height: 22, padding: 0, border: 0, borderRadius: 4, background: s.color, textAlign: 'center', fontSize: 11, color: '#fff' }}
                        >
                          {s.simbolo}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="herramientas" style={{ marginTop: 8 }}>
            <span>✓ Envió mensajes</span>
            <span>✕ Procesó citas y no envió nada</span>
            <span>! No corrió o tuvo errores</span>
            <span>– Sin citas para enviar</span>
          </div>
        </div>
      )}
    </>
  );
}

