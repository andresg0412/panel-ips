import { useCallback } from 'react';
import { conRango, useApi, type Rango } from '../api';
import Grafico from '../components/Grafico';
import { barrasApiladas, lineas, pivotar } from '../components/series';
import { Estado, Kpi, ListaConteo, Tarjeta } from '../components/ui';
import { ratio } from '../format';

type N = Record<string, number>;
interface Indicadores { citas: N; envios: N; sesiones: N; listaEspera: N }
interface DatosResumen { actual: Indicadores; anterior: Indicadores }
interface DatosSeries {
  rango: { grano: string };
  citas: { periodo: string; grupo: string | null; n: number }[];
  envios: { periodo: string; enviados: number; respondieron: number }[];
  sesiones: { periodo: string; completadas: number; abandonadas: number }[];
}

const GRUPOS = ['Asistió', 'No asistió', 'Cancelada', 'Reprogramada', 'Programada', 'Otro'];

const asistencia = (c: N) => ratio(c.asistio, c.asistio + c.no_asistio);
const respuesta = (e: N) => ratio(e.respondieron, e.enviados);

export default function Resumen({ rango }: { rango: Rango }) {
  const r = useApi<DatosResumen>(conRango('/api/resumen', rango), 120_000);
  const s = useApi<DatosSeries>(conRango('/api/resumen/series', rango), 120_000);

  const optCitas = useCallback(() => {
    const d = s.data!;
    const { periodos, series } = pivotar(d.citas, 'grupo', 'n', GRUPOS);
    return barrasApiladas(periodos, series, d.rango.grano);
  }, [s.data]);
  const optEnvios = useCallback(() => {
    const d = s.data!;
    return lineas(d.envios.map((e) => e.periodo), { Enviados: d.envios.map((e) => e.enviados), Respondieron: d.envios.map((e) => e.respondieron) }, d.rango.grano);
  }, [s.data]);
  const optSesiones = useCallback(() => {
    const d = s.data!;
    return barrasApiladas(d.sesiones.map((e) => e.periodo), { Completadas: d.sesiones.map((e) => e.completadas), Abandonadas: d.sesiones.map((e) => e.abandonadas) }, d.rango.grano);
  }, [s.data]);

  const a = r.data?.actual;
  const p = r.data?.anterior;

  return (
    <>
      <Estado cargando={r.cargando} error={r.error} hayDatos={!!a} />
      {a && p && (
        <div className="kpis">
          <Kpi etiqueta="Citas atendidas" actual={a.citas.asistio} anterior={p.citas.asistio} />
          <Kpi etiqueta="Tasa de asistencia" formato="pct" actual={asistencia(a.citas)} anterior={asistencia(p.citas)} />
          <Kpi etiqueta="Citas canceladas" actual={a.citas.canceladas} anterior={p.citas.canceladas} mejorSiSube={false} />
          <Kpi etiqueta="Citas nuevas registradas" actual={a.citas.registradas} anterior={p.citas.registradas} />
          <Kpi etiqueta="Mensajes de campaña enviados" actual={a.envios.enviados} anterior={p.envios.enviados} />
          <Kpi etiqueta="Pacientes que respondieron" formato="pct" actual={respuesta(a.envios)} anterior={respuesta(p.envios)} />
          <Kpi etiqueta="Citas confirmadas tras un mensaje" actual={a.envios.confirmaron} anterior={p.envios.confirmaron} />
          <Kpi etiqueta="Conversaciones con el bot" actual={a.sesiones.total} anterior={p.sesiones.total} />
        </div>
      )}

      <Estado cargando={s.cargando} error={s.error} hayDatos={!!s.data} />
      {s.data && (
        <>
          <Tarjeta titulo="Citas por estado" ayuda="Según la fecha de la cita. Las programadas son citas futuras pendientes o confirmadas.">
            <Grafico opcion={optCitas} />
          </Tarjeta>
          <div className="grid g2">
            <Tarjeta titulo="Mensajes de campaña" ayuda="Enviados aceptados por WhatsApp y cuántos pacientes respondieron.">
              <Grafico opcion={optEnvios} alto={260} />
            </Tarjeta>
            <Tarjeta titulo="Conversaciones con el bot" ayuda="Abandonada: el paciente dejó de responder antes de terminar.">
              <Grafico opcion={optSesiones} alto={260} />
            </Tarjeta>
          </div>
        </>
      )}

      {a && (
        <div className="grid g2">
          <Tarjeta titulo="Lo que resolvió el bot" ayuda="Trámites completados por los pacientes dentro de la conversación.">
            <ListaConteo
              items={[
                { clave: 'cc', etiqueta: 'Agendaron una cita', n: a.sesiones.citas_creadas },
                { clave: 'cf', etiqueta: 'Confirmaron su cita', n: a.sesiones.citas_confirmadas },
                { clave: 'cr', etiqueta: 'Reprogramaron su cita', n: a.sesiones.citas_reprogramadas },
                { clave: 'ca', etiqueta: 'Cancelaron su cita', n: a.sesiones.citas_canceladas },
                { clave: 'da', etiqueta: 'Pidieron hablar con un asesor', n: a.sesiones.derivadas_agente },
              ]}
            />
          </Tarjeta>
          <Tarjeta titulo="Lista de espera" ayuda="Movimiento en el período.">
            <ListaConteo
              items={[
                { clave: 'in', etiqueta: 'Nuevas inscripciones', n: a.listaEspera.inscripciones },
                { clave: 'of', etiqueta: 'Ofertas de cupo enviadas', n: a.listaEspera.ofertas },
                { clave: 'ac', etiqueta: 'Ofertas aceptadas (cita adelantada)', n: a.listaEspera.aceptadas },
              ]}
            />
          </Tarjeta>
        </div>
      )}
    </>
  );
}
