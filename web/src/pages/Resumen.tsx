import { useCallback } from 'react';
import { conRango, useApi, type Rango } from '../api';
import Grafico from '../components/Grafico';
import { barrasApiladas, lineas, pequenosMultiplos, pivotar } from '../components/series';
import { Estado, Kpi, ListaConteo, Tarjeta } from '../components/ui';
import { useSombras } from '../incidentes';
import { METAS } from '../metas';
import { num, ratio, tasaTxt } from '../format';

type N = Record<string, number>;
interface Indicadores { citas: N; envios: N; sesiones: N; listaEspera: N }
interface DatosResumen {
  actual: Indicadores;
  anterior: Indicadores | null;
  comparacion: { tipo: 'anterior' | 'interanual' | 'ninguna'; desde: string | null; hasta: string | null };
}
interface Metas {
  nuevos: { nuevos: number };
  confirmadas: { citas: number; confirmadas: number };
  ocupacion: { cupos: number; ocupan: number };
  capacidadDesde: string;
}
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

export default function Resumen({ rango }: { rango: Rango }) {
  const r = useApi<DatosResumen>(conRango('/api/resumen', rango), 120_000);
  const s = useApi<DatosSeries>(conRango('/api/resumen/series', rango), 120_000);
  const t = useApi<Tendencia>('/api/resumen/tendencia');
  const m = useApi<Metas>(conRango('/api/resumen/metas', rango), 300_000);
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
  // o no compara (p queda vacío y los KPI se muestran sin variación).
  const p = r.data?.anterior ?? undefined;
  const comp = r.data?.comparacion.tipo === 'interanual' ? 'vs mismo período del año anterior' : 'vs período anterior';
  const md = m.data;
  const ocupacion = md && md.ocupacion.cupos ? md.ocupacion.ocupan / md.ocupacion.cupos : null;
  const confWhatsapp = md && md.confirmadas.citas ? md.confirmadas.confirmadas / md.confirmadas.citas : null;
  // RES-03: trámites que el bot resolvió sin intervención humana.
  const tramites = a ? a.envios.confirmaron + a.sesiones.citas_creadas + a.sesiones.citas_canceladas + a.sesiones.citas_reprogramadas : 0;

  return (
    <>
      <Estado cargando={r.cargando} error={r.error} hayDatos={!!a} />
      {a && (
        <div className="kpis">
          <Kpi etiqueta="Citas atendidas" actual={a.citas.asistio} anterior={p?.citas.asistio} comparacion={comp} />
          <Kpi etiqueta="Tasa de asistencia" formato="pct" actual={asistencia(a.citas)} anterior={p ? asistencia(p.citas) : undefined} comparacion={comp} meta={{ valor: METAS.asistencia }} />
          <Kpi
            etiqueta="Citas que no ocurrieron"
            formato="pct"
            actual={noOcurrio(a.citas)}
            anterior={p ? noOcurrio(p.citas) : undefined}
            mejorSiSube={false}
            comparacion={comp}
            meta={{ valor: METAS.noOcurrieron, mejorSiSube: false }}
          />
          <Kpi etiqueta="Ocupación de la agenda" formato="pct" actual={ocupacion} meta={{ valor: METAS.ocupacion }} />
          <Kpi etiqueta="Citas confirmadas por WhatsApp" formato="pct" actual={confWhatsapp} meta={{ valor: METAS.confirmadasWhatsapp }} />
          <Kpi etiqueta="Pacientes nuevos atendidos" actual={md ? md.nuevos.nuevos : null} />
          <Kpi etiqueta="Citas nuevas registradas" actual={a.citas.registradas} anterior={p?.citas.registradas} comparacion={comp} />
          <Kpi etiqueta="Mensajes de campaña enviados" actual={a.envios.enviados} anterior={p?.envios.enviados} comparacion={comp} />
          <Kpi etiqueta="Respondieron a los mensajes" formato="pct" actual={respuesta(a.envios)} anterior={p ? respuesta(p.envios) : undefined} comparacion={comp} />
          <Kpi etiqueta="Conversaciones con el bot" actual={a.sesiones.total} anterior={p?.sesiones.total} comparacion={comp} />
        </div>
      )}

      {a && (
        <Tarjeta titulo="Lo que hizo el bot" ayuda="Trámites que los pacientes resolvieron por WhatsApp, sin pasar por recepción.">
          <p className="frase">
            En este período el bot resolvió <b>{num(tramites)} trámites</b> sin intervención humana
            {a.sesiones.total > 0 && (
              <>
                , y el <b>{tasaTxt(ratio(a.sesiones.fuera_horario, a.sesiones.total), 0)}</b> de las conversaciones llegó fuera del horario de recepción
              </>
            )}
            .
          </p>
          <div className="cifras">
            <div className="cifra"><div className="n">{num(a.envios.confirmaron)}</div><div className="t">confirmaron su cita respondiendo el mensaje</div></div>
            <div className="cifra"><div className="n">{num(a.sesiones.citas_creadas)}</div><div className="t">agendaron una cita</div></div>
            <div className="cifra"><div className="n">{num(a.sesiones.citas_reprogramadas)}</div><div className="t">reprogramaron</div></div>
            <div className="cifra"><div className="n">{num(a.sesiones.citas_canceladas)}</div><div className="t">cancelaron (cupo liberado a tiempo)</div></div>
            <div className="cifra"><div className="n">{num(a.sesiones.derivadas_agente)}</div><div className="t">pidieron hablar con una persona</div></div>
            <div className="cifra"><div className="n">{num(a.sesiones.fuera_horario)}</div><div className="t">conversaciones fuera de horario</div></div>
          </div>
        </Tarjeta>
      )}

      <Estado cargando={s.cargando} error={s.error} hayDatos={!!s.data} />
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

      {t.data && (
        <Tarjeta titulo="Citas atendidas por mes y especialidad" ayuda="Desde el inicio de los datos (agosto de 2025), sin importar el período elegido. Cada especialidad con su propia escala.">
          <Grafico opcion={optTendencia} alto={360} />
        </Tarjeta>
      )}

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
