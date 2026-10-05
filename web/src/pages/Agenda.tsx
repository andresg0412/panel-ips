import { useCallback } from 'react';
import { conRango, useApi, type Rango } from '../api';
import Grafico from '../components/Grafico';
import { barrasApiladas, pivotar, ranking } from '../components/series';
import { Estado, Kpi, ListaConteo, Tabla, Tarjeta, type Columna } from '../components/ui';
import { DIAS, etiqueta, fecha, fechaHora, hora, pct } from '../format';
import { Pestanas, usePestana, useSombras } from '../incidentes';
import { AgendaProximas, AnticipacionCancelaciones } from './Ocupacion';
import { AgendaCalidad, AgendaInasistencia, AgendaTendencias } from './AgendaAnalisis';

interface PorEstado {
  nombre?: string;
  dia?: number;
  total: number;
  asistio: number;
  no_asistio: number;
  canceladas: number;
  reprogramadas: number;
  programadas: number;
  sin_cierre?: number;
  horas_no_ocurrieron?: number;
}
interface Cambio {
  cuando: string;
  estado_anterior: string | null;
  estado_nuevo: string;
  origen: string;
  nombre_paciente: string | null;
  profesional: string | null;
  fecha_cita: string;
  hora_cita: string;
}
interface Datos {
  rango: { grano: string };
  serie: { periodo: string; grupo: string | null; n: number }[];
  especialidad: PorEstado[];
  profesional: PorEstado[];
  administradora: PorEstado[];
  diaSemana: PorEstado[];
  origenCancelacion: { origen: string; n: number }[];
  cambios: Cambio[];
  servicio: PorEstado[];
}

// Mismo orden que los colores fijos (s1..s5): evita que el amarillo quede junto al naranja.
const GRUPOS = ['Asistió', 'Cancelada', 'Reprogramada', 'No asistió', 'Programada', 'Sin cierre', 'Otro'];
const tasa = (f: PorEstado) => (f.asistio + f.no_asistio ? f.asistio / (f.asistio + f.no_asistio) : null);

const colsEstado = (titulo: string): Columna<PorEstado>[] => [
  { clave: 'nombre', titulo },
  { clave: 'total', titulo: 'Total', num: true },
  { clave: 'asistio', titulo: 'Asistió', num: true },
  { clave: 'no_asistio', titulo: 'No asistió', num: true },
  { clave: 'canceladas', titulo: 'Canceladas', num: true },
  { clave: 'reprogramadas', titulo: 'Reprogramadas', num: true },
  { clave: 'programadas', titulo: 'Programadas', num: true },
  { clave: 'sin_cierre', titulo: 'Sin cierre', num: true },
  {
    clave: 'asistio',
    titulo: 'Asistencia',
    num: true,
    formato: (_v, f) => pct(f.asistio, f.asistio + f.no_asistio),
    csv: (_v, f) => pct(f.asistio, f.asistio + f.no_asistio),
    orden: tasa,
  },
];
const COLS_PROF = colsEstado('Profesional');
const COLS_ESP = colsEstado('Especialidad');
const COLS_ADM = colsEstado('Convenio / administradora');
const COLS_SERV: Columna<PorEstado>[] = [
  { clave: 'nombre', titulo: 'Tipo de atención', formato: etiqueta, csv: etiqueta },
  { clave: 'total', titulo: 'Total', num: true },
  { clave: 'asistio', titulo: 'Asistió', num: true },
  {
    clave: 'canceladas',
    titulo: 'No ocurrieron',
    num: true,
    formato: (_v, f) => pct(f.canceladas + f.reprogramadas, f.total),
    csv: (_v, f) => pct(f.canceladas + f.reprogramadas, f.total),
    orden: (f) => (f.total ? (f.canceladas + f.reprogramadas) / f.total : null),
  },
  { clave: 'horas_no_ocurrieron', titulo: 'Horas de consulta perdidas', num: true },
];

const COLS_CAMBIO: Columna<Cambio>[] = [
  { clave: 'cuando', titulo: 'Cuándo', formato: fechaHora },
  { clave: 'nombre_paciente', titulo: 'Paciente' },
  { clave: 'profesional', titulo: 'Profesional' },
  { clave: 'fecha_cita', titulo: 'Cita', formato: (v, f) => `${fecha(v)} ${hora(f.hora_cita)}` },
  { clave: 'estado_anterior', titulo: 'Antes' },
  { clave: 'estado_nuevo', titulo: 'Después' },
  { clave: 'origen', titulo: 'Origen', formato: etiqueta, csv: etiqueta },
];

type Vista = 'periodo' | 'proximas' | 'inasistencia' | 'tendencias' | 'calidad';

export default function Agenda({ rango }: { rango: Rango }) {
  const [vista, setVista] = usePestana<Vista>(['periodo', 'proximas', 'inasistencia', 'tendencias', 'calidad'], 'periodo');
  return (
    <>
      <Pestanas<Vista>
        opciones={[
          ['periodo', 'Período'],
          ['proximas', 'Próximas semanas'],
          ['inasistencia', 'Inasistencia'],
          ['tendencias', 'Tendencias'],
          ['calidad', 'Calidad de los datos'],
        ]}
        valor={vista}
        onCambio={setVista}
      />
      {vista === 'periodo' && <AgendaPeriodo rango={rango} />}
      {vista === 'proximas' && <AgendaProximas />}
      {vista === 'inasistencia' && <AgendaInasistencia rango={rango} />}
      {vista === 'tendencias' && <AgendaTendencias />}
      {vista === 'calidad' && <AgendaCalidad />}
    </>
  );
}

function AgendaPeriodo({ rango }: { rango: Rango }) {
  const sombras = useSombras(['agenda']);
  const { data, error, cargando } = useApi<Datos>(conRango('/api/agenda', rango), 120_000);

  const optSerie = useCallback(() => {
    const { periodos, series } = pivotar(data!.serie, 'grupo', 'n', GRUPOS);
    return barrasApiladas(periodos, series, data!.rango.grano, sombras);
  }, [data, sombras]);

  const optDia = useCallback(
    () => ranking(
      data!.diaSemana.filter((d) => d.asistio + d.no_asistio > 0).map((d) => ({ nombre: DIAS[d.dia!], valor: tasa(d) ?? 0 })),
      (v) => `${(v * 100).toFixed(0)} %`,
    ),
    [data],
  );

  const tot = data?.especialidad.reduce(
    (acc, f) => ({
      total: acc.total + f.total,
      asistio: acc.asistio + f.asistio,
      no_asistio: acc.no_asistio + f.no_asistio,
      canceladas: acc.canceladas + f.canceladas,
      reprogramadas: acc.reprogramadas + f.reprogramadas,
      programadas: acc.programadas + f.programadas,
      sin_cierre: (acc.sin_cierre ?? 0) + (f.sin_cierre ?? 0),
    }),
    { total: 0, asistio: 0, no_asistio: 0, canceladas: 0, reprogramadas: 0, programadas: 0, sin_cierre: 0 } as PorEstado,
  );
  const totalCanceladas = data?.origenCancelacion.reduce((s, o) => s + o.n, 0) ?? 0;

  return (
    <>
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && tot && (
        <>
          <div className="kpis">
            <Kpi etiqueta="Citas en el período" actual={tot.total} />
            <Kpi etiqueta="Tasa de asistencia" formato="pct" actual={tasa(tot)} />
            <Kpi etiqueta="No asistieron" actual={tot.no_asistio} />
            <Kpi etiqueta="Canceladas" actual={tot.canceladas} />
            <Kpi etiqueta="Reprogramadas" actual={tot.reprogramadas} />
            <Kpi etiqueta="Programadas (por venir)" actual={tot.programadas} />
            {(tot.sin_cierre ?? 0) > 0 && <Kpi etiqueta="Sin cierre (no se sabe si ocurrió)" actual={tot.sin_cierre ?? 0} />}
          </div>
          <Tarjeta titulo="Citas por estado" ayuda="Asistencia = asistió ÷ (asistió + no asistió). Las canceladas y reprogramadas no cuentan porque la cita no ocurrió.">
            <Grafico opcion={optSerie} />
          </Tarjeta>
          <div className="grid g2">
            <Tarjeta titulo="Por especialidad">
              <Tabla filas={data.especialidad} columnas={COLS_ESP} nombreCsv="agenda_especialidad" />
            </Tarjeta>
            <Tarjeta titulo="Asistencia por día de la semana">
              <Grafico opcion={optDia} alto={240} />
            </Tarjeta>
          </div>
          <Tarjeta titulo="Por tipo de atención" ayuda="No ocurrieron = canceladas + reprogramadas. Horas perdidas: duración de esas citas.">
            <Tabla filas={data.servicio} columnas={COLS_SERV} nombreCsv="agenda_tipo_atencion" />
          </Tarjeta>
          <Tarjeta titulo="Por profesional" ayuda="Haga clic en un encabezado para ordenar. La ficha completa está en Profesionales.">
            <Tabla filas={data.profesional} columnas={COLS_PROF} nombreCsv={`agenda_profesional_${rango.desde}_${rango.hasta}`} />
          </Tarjeta>
          <div className="grid g2">
            <Tarjeta titulo="Por convenio / administradora" ayuda="Las 15 con más citas.">
              <Tabla filas={data.administradora} columnas={COLS_ADM} nombreCsv="agenda_convenio" />
            </Tarjeta>
            <Tarjeta titulo="¿Quién canceló?" ayuda="El detalle de origen existe solo para cancelaciones hechas por el bot desde el 30 sep 2026; el resto llega de Globho sin ese dato.">
              <ListaConteo items={data.origenCancelacion.map((o) => ({ clave: o.origen, etiqueta: etiqueta(o.origen), n: o.n }))} total={totalCanceladas} />
            </Tarjeta>
          </div>
          <AnticipacionCancelaciones rango={rango} />
          <Tarjeta titulo="Últimos cambios de estado" ayuda="Registro disponible desde fines de septiembre de 2026.">
            <Tabla filas={data.cambios} columnas={COLS_CAMBIO} nombreCsv="cambios_estado" vacio="Sin cambios registrados en este período" />
          </Tarjeta>
        </>
      )}
    </>
  );
}
