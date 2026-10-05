import { useCallback, useState } from 'react';
import { conRango, useApi, type Rango } from '../api';
import Grafico from '../components/Grafico';
import { barrasApiladas, lineas, pequenosMultiplos, pivotar } from '../components/series';
import { Esqueleto, Estado, Kpi, ListaConteo, Tarjeta } from '../components/ui';
import {
  EditorMetas, KpiPrincipal, ListaAtencion, ListaFrases, MedidorConfianza,
  type Confianza, type Frase, type ItemAtencion, type Meta, type MetaKpi,
} from '../components/sala';
import { useSombras } from '../incidentes';
import { Bloqueado, Restringido, useAcceso } from '../acceso';
import { fecha, num, ratio, tasaTxt } from '../format';

type N = Record<string, number>;
interface Indicadores { citas: N; envios: N; sesiones: N; listaEspera: N }
interface DatosResumen {
  actual: Indicadores;
  anterior: Indicadores | null;
  comparacion: { tipo: 'anterior' | 'interanual' | 'ninguna'; desde: string | null; hasta: string | null };
}
interface DatosMetas {
  nuevos: { nuevos: number };
  confirmadas: { citas: number; confirmadas: number };
  ocupacion: { cupos: number; ocupan: number };
  capacidadDesde: string;
}
interface Semana { semana: string; atendidas: number; asistencia: number | null; no_ocurrieron: number | null; nuevos: number; tramites: number; ocupacion: number | null }
interface Sala { tendencia: Semana[]; relevante: Frase[]; atencion: ItemAtencion[] }
interface DatosSeries {
  rango: { grano: string };
  citas: { periodo: string; grupo: string | null; n: number }[];
  envios: { periodo: string; enviados: number; respondieron: number; fallidos: number }[];
  sesiones: { periodo: string; completadas: number; abandonadas: number }[];
}
interface Tendencia { filas: { mes: string; especialidad: string; n: number }[] }

// Mismo orden que los colores fijos: evita que el amarillo quede junto al naranja.
const GRUPOS = ['Asistió', 'Cancelada', 'Reprogramada', 'No asistió', 'Programada', 'Sin cierre', 'Otro'];
const ESPECIALIDADES = ['Psicología', 'Psiquiatría', 'Neuropsicología'];

const asistencia = (c: N) => ratio(c.asistio, c.asistio + c.no_asistio);
const respuesta = (e: N) => ratio(e.respondieron, e.enviados_con_respuesta);
const noOcurrio = (c: N) => ratio(c.canceladas + c.reprogramadas, c.total);
/** Trámites que el bot resolvió sin recepción (RES-03). */
const tramites = (i: Indicadores) => i.envios.confirmaron + i.sesiones.citas_creadas + i.sesiones.citas_canceladas + i.sesiones.citas_reprogramadas;

const DEF = {
  atendidas: 'Citas de pacientes que se atendieron en el período. No incluye reuniones internas ni bloques administrativos.',
  asistencia: 'De las citas que debían ocurrir (atendidas + inasistencias), cuántas se atendieron. Las canceladas y reprogramadas no cuentan.',
  noOcurrieron: 'Citas canceladas o reprogramadas sobre el total de citas del período. Cuanto menor, mejor.',
  nuevos: 'Pacientes cuya primera cita atendida (desde agosto de 2025) cae en el período.',
  ocupacion: 'Cupos del horario de cada profesional ocupados por citas de pacientes, en días ya pasados. Solo profesionales con horario registrado.',
  tramites: 'Gestiones que los pacientes resolvieron por WhatsApp sin pasar por recepción: confirmaciones de cita y citas agendadas, canceladas o reprogramadas con el bot.',
  registradas: 'Citas nuevas que entraron a la agenda en el período, por cualquier canal.',
  enviados: 'Mensajes de campaña que WhatsApp aceptó para entregar.',
  respuesta: 'Pacientes que respondieron a los mensajes que piden respuesta (no cuenta el recordatorio de 2 horas).',
  conversaciones: 'Conversaciones iniciadas con el asistente de WhatsApp.',
  confirmadas: 'Citas ya ocurridas que el paciente confirmó respondiendo el mensaje de WhatsApp.',
};

export default function Resumen({ rango }: { rango: Rango }) {
  const { puede } = useAcceso();
  const conSala = puede('resumen.sala');
  const conMetas = puede('resumen.metas');
  const r = useApi<DatosResumen>(conRango('/api/resumen', rango), 120_000);
  const s = useApi<DatosSeries>(conRango('/api/resumen/series', rango), 120_000);
  const t = useApi<Tendencia>(puede('resumen.tendencia') ? '/api/resumen/tendencia' : null);
  const m = useApi<DatosMetas>(conMetas ? conRango('/api/resumen/metas', rango) : null, 300_000);
  const sala = useApi<Sala>(conSala ? conRango('/api/resumen/sala', rango) : null, 300_000);
  const conf = useApi<Confianza>(puede('confianza') ? conRango('/api/confianza', rango) : null, 300_000);
  const metas = useApi<{ metas: Record<string, Meta>; editable: boolean }>(conMetas ? '/api/metas' : null);
  const [editando, setEditando] = useState(false);
  const incAgenda = useSombras(['agenda']);
  const incWhatsapp = useSombras(['whatsapp', 'trazabilidad']);
  const incConv = useSombras(['conversaciones']);

  const optCitas = useCallback(() => {
    const d = s.data!;
    const { periodos, series } = pivotar(d.citas, 'grupo', 'n', GRUPOS);
    return barrasApiladas(periodos, series, d.rango.grano, incAgenda);
  }, [s.data, incAgenda]);
  const optEnvios = useCallback(() => {
    const d = s.data!;
    return lineas(
      d.envios.map((e) => e.periodo),
      { Enviados: d.envios.map((e) => e.enviados), Respondieron: d.envios.map((e) => e.respondieron), Fallidos: d.envios.map((e) => e.fallidos) },
      d.rango.grano,
      incWhatsapp,
    );
  }, [s.data, incWhatsapp]);
  const optSesiones = useCallback(() => {
    const d = s.data!;
    return barrasApiladas(d.sesiones.map((e) => e.periodo), { Completadas: d.sesiones.map((e) => e.completadas), Abandonadas: d.sesiones.map((e) => e.abandonadas) }, d.rango.grano, incConv);
  }, [s.data, incConv]);
  const optTendencia = useCallback(() => {
    const { periodos, series } = pivotar(t.data!.filas.map((f) => ({ ...f, periodo: f.mes })), 'especialidad', 'n', ESPECIALIDADES);
    return pequenosMultiplos(periodos, series, 'month', incAgenda);
  }, [t.data, incAgenda]);

  const a = r.data?.actual;
  // Si el período anterior cae en un incidente, el servidor compara con el mismo período del año anterior,
  // o no compara (p queda vacío y los indicadores se muestran sin variación).
  const p = r.data?.anterior ?? undefined;
  const comp = r.data?.comparacion.tipo === 'interanual' ? 'vs mismo período del año anterior' : 'vs período anterior';
  const md = m.data;
  const ocupacion = md && md.ocupacion.cupos ? md.ocupacion.ocupan / md.ocupacion.cupos : null;
  const confWhatsapp = md && md.confirmadas.citas ? md.confirmadas.confirmadas / md.confirmadas.citas : null;

  // Metas: las mensuales se llevan a la duración del período elegido.
  const dias = Math.round((Date.parse(rango.hasta) - Date.parse(rango.desde)) / 86_400_000) + 1;
  const meta = (k: string): MetaKpi | null => {
    const x = metas.data?.metas[k];
    if (!x || x.valor === null) return null;
    return { valor: x.tipo === 'mensual' ? (x.valor * dias) / 30.4 : x.valor, mejorSiSube: x.mejorSiSube, mensual: x.tipo === 'mensual' };
  };
  const sinMeta = (k: string) => (metas.data && metas.data.metas[k]?.valor === null ? 'Sin meta definida' : undefined);
  const tend = sala.data?.tendencia ?? [];
  const serie = (k: keyof Semana) => (tend.length ? tend.map((x) => x[k] as number | null) : undefined);
  const ultima = tend[tend.length - 1];
  const parcial = !!ultima && ultima.semana > new Date(Date.parse(rango.hasta) - 6 * 86_400_000).toISOString().slice(0, 10);

  return (
    <>
      <Estado cargando={r.cargando} error={r.error} hayDatos={!!a} />
      {a && (
        <>
          <div className="seccion-titulo">
            <h3>¿Cómo está la IPS?</h3>
            <span className="nota" style={{ margin: 0 }}>
              Del {fecha(rango.desde)} al {fecha(rango.hasta)}
              {conSala && ' · la línea muestra las últimas 8 semanas'}
            </span>
            {metas.data?.editable && (
              <button className="boton" onClick={() => setEditando((v) => !v)}>{editando ? 'Cerrar metas' : 'Editar metas'}</button>
            )}
          </div>
          {editando && metas.data && <EditorMetas metas={metas.data.metas} onCambio={metas.recargar} onCerrar={() => setEditando(false)} />}

          {conSala ? (
            <div className="kpis-principales">
              <KpiPrincipal etiqueta="Citas atendidas" valor={a.citas.asistio} anterior={p?.citas.asistio} comparacion={comp} meta={meta('atendidas')} sinMeta={sinMeta('atendidas')} serie={serie('atendidas')} parcial={parcial} definicion={DEF.atendidas} />
              <KpiPrincipal etiqueta="Tasa de asistencia" formato="pct" valor={asistencia(a.citas)} anterior={p ? asistencia(p.citas) : undefined} comparacion={comp} meta={meta('asistencia')} serie={serie('asistencia')} definicion={DEF.asistencia} />
              <KpiPrincipal etiqueta="Cancelaciones y reprogramaciones" formato="pct" mejorSiSube={false} valor={noOcurrio(a.citas)} anterior={p ? noOcurrio(p.citas) : undefined} comparacion={comp} meta={meta('no_ocurrieron')} serie={serie('no_ocurrieron')} definicion={DEF.noOcurrieron} />
              <KpiPrincipal etiqueta="Pacientes nuevos atendidos" valor={md ? md.nuevos.nuevos : null} meta={meta('nuevos')} sinMeta={sinMeta('nuevos')} serie={serie('nuevos')} parcial={parcial} definicion={DEF.nuevos} />
              <KpiPrincipal etiqueta="Ocupación de la agenda" formato="pct" valor={ocupacion} meta={meta('ocupacion')} serie={serie('ocupacion')} definicion={DEF.ocupacion} />
              <KpiPrincipal etiqueta="Trámites resueltos por WhatsApp" valor={tramites(a)} anterior={p ? tramites(p) : undefined} comparacion={comp} meta={meta('tramites')} sinMeta={sinMeta('tramites')} serie={serie('tramites')} parcial={parcial} definicion={DEF.tramites} />
            </div>
          ) : (
            <div className="kpis-principales">
              <KpiPrincipal etiqueta="Citas atendidas" valor={a.citas.asistio} definicion={DEF.atendidas} />
              <KpiPrincipal etiqueta="Tasa de asistencia" formato="pct" valor={asistencia(a.citas)} definicion={DEF.asistencia} />
              <KpiPrincipal etiqueta="Cancelaciones y reprogramaciones" formato="pct" mejorSiSube={false} valor={noOcurrio(a.citas)} definicion={DEF.noOcurrieron} />
              <KpiPrincipal etiqueta="Citas nuevas registradas" valor={a.citas.registradas} definicion={DEF.registradas} />
              <KpiPrincipal etiqueta="Mensajes de campaña enviados" valor={a.envios.enviados} definicion={DEF.enviados} />
              <KpiPrincipal etiqueta="Conversaciones con el bot" valor={a.sesiones.total} definicion={DEF.conversaciones} />
            </div>
          )}

          {conSala && (
            <div className="kpis kpis-secundarios">
              <Kpi etiqueta="Citas nuevas registradas" actual={a.citas.registradas} anterior={p?.citas.registradas} comparacion={comp} ayuda={DEF.registradas} />
              <Kpi etiqueta="Mensajes de campaña enviados" actual={a.envios.enviados} anterior={p?.envios.enviados} comparacion={comp} ayuda={DEF.enviados} />
              <Kpi etiqueta="Respondieron a los mensajes" formato="pct" actual={respuesta(a.envios)} anterior={p ? respuesta(p.envios) : undefined} comparacion={comp} ayuda={DEF.respuesta} />
              <Kpi etiqueta="Conversaciones con el bot" actual={a.sesiones.total} anterior={p?.sesiones.total} comparacion={comp} ayuda={DEF.conversaciones} />
              <Kpi etiqueta="Citas confirmadas por WhatsApp" formato="pct" actual={confWhatsapp} meta={meta('confirmadas_whatsapp') ?? undefined} ayuda={DEF.confirmadas} />
            </div>
          )}
        </>
      )}

      {conSala ? (
        <div className="grid g2 sala-grid">
          <Tarjeta titulo="Lo más relevante del período" ayuda="Se escribe solo a partir de los datos. Solo compara cuando hay suficientes citas y el período de comparación no tiene incidentes.">
            {sala.data ? <ListaFrases frases={sala.data.relevante} /> : sala.error ? <div className="error">{sala.error}</div> : <Esqueleto forma="bloque" />}
          </Tarjeta>
          <div className="columna">
            <Tarjeta titulo="Qué requiere atención" ayuda="Alertas sin revisar y pendientes de la operación. Cada punto lleva a la pantalla donde se resuelve.">
              {sala.data ? <ListaAtencion items={sala.data.atencion} /> : sala.error ? <div className="error">{sala.error}</div> : <Esqueleto forma="bloque" />}
            </Tarjeta>
            {puede('confianza') && (
              <Tarjeta titulo="Confianza de los datos" ayuda="Qué tan completa y al día está la información de este período. El detalle está en Alertas.">
                {conf.data ? <MedidorConfianza c={conf.data} /> : conf.error ? <div className="error">{conf.error}</div> : <Esqueleto forma="bloque" />}
              </Tarjeta>
            )}
          </div>
        </div>
      ) : (
        a && <Bloqueado clave="resumen.sala" titulo="Lo más relevante del período y lo que requiere atención" alto={200} />
      )}

      {a && (
        <Tarjeta titulo="Lo que hizo el bot" ayuda="Trámites que los pacientes resolvieron por WhatsApp, sin pasar por recepción.">
          <div className="cifras">
            <div className="cifra"><div className="n">{num(a.envios.confirmaron)}</div><div className="t">confirmaron su cita respondiendo el mensaje</div></div>
            <div className="cifra"><div className="n">{num(a.sesiones.citas_creadas)}</div><div className="t">agendaron una cita</div></div>
            <div className="cifra"><div className="n">{num(a.sesiones.citas_reprogramadas)}</div><div className="t">reprogramaron</div></div>
            <div className="cifra"><div className="n">{num(a.sesiones.citas_canceladas)}</div><div className="t">cancelaron (cupo liberado a tiempo)</div></div>
            <div className="cifra"><div className="n">{num(a.sesiones.derivadas_agente)}</div><div className="t">pidieron hablar con una persona</div></div>
            <div className="cifra">
              <div className="n">{num(a.sesiones.fuera_horario)}</div>
              <div className="t">conversaciones fuera de horario{a.sesiones.total ? ` (${tasaTxt(ratio(a.sesiones.fuera_horario, a.sesiones.total), 0)})` : ''}</div>
            </div>
          </div>
        </Tarjeta>
      )}

      <Estado cargando={s.cargando} error={s.error} hayDatos={!!s.data} forma="bloque" />
      {s.data && (
        <>
          <Tarjeta titulo="Citas por estado" ayuda="Según la fecha de la cita. No incluye reuniones internas. Sin cierre: cita pasada que sigue pendiente; no se sabe si ocurrió.">
            <Grafico opcion={optCitas} />
          </Tarjeta>
          <div className="grid g2">
            <Tarjeta titulo="Mensajes de campaña" ayuda="Enviados: aceptados por WhatsApp. Fallidos: WhatsApp rechazó el envío y el paciente no recibió nada.">
              <Grafico opcion={optEnvios} alto={260} />
            </Tarjeta>
            <Tarjeta titulo="Conversaciones con el bot" ayuda="Abandonada: el paciente dejó de responder antes de terminar.">
              <Grafico opcion={optSesiones} alto={260} />
            </Tarjeta>
          </div>
        </>
      )}

      <Restringido clave="resumen.tendencia" titulo="Citas atendidas por mes y especialidad">
        {t.data && (
          <Tarjeta titulo="Citas atendidas por mes y especialidad" ayuda="Desde el inicio de los datos (agosto de 2025), sin importar el período elegido. Cada especialidad con su propia escala.">
            <Grafico opcion={optTendencia} alto={360} />
          </Tarjeta>
        )}
      </Restringido>

      {a && (
        <Tarjeta titulo="Lista de espera" ayuda="Movimiento en el período.">
          <ListaConteo
            items={[
              { clave: 'in', etiqueta: 'Nuevas inscripciones', n: a.listaEspera.inscripciones },
              { clave: 'of', etiqueta: 'Ofertas de cupo enviadas', n: a.listaEspera.ofertas },
              { clave: 'ac', etiqueta: 'Ofertas aceptadas (cita adelantada)', n: a.listaEspera.aceptadas },
            ]}
          />
        </Tarjeta>
      )}
    </>
  );
}
