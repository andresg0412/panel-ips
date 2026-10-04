import { useCallback, useState } from 'react';
import { conRango, useApi, type Rango } from '../api';
import Grafico from '../components/Grafico';
import { barrasApiladas, barrasTasa, ranking } from '../components/series';
import { Estado, Kpi, Tabla, Tarjeta, type Columna } from '../components/ui';
import { AvisoIncidentes, useSombras } from '../incidentes';
import { DIAS, etiqueta, num, pct, ratio } from '../format';

interface FilaProfesional {
  nombre: string;
  especialidad: string | null;
  total: number;
  asistio: number;
  no_asistio: number;
  no_ocurrieron: number;
  pacientes: number;
  nuevos: number;
  nuevos_cohorte: number;
  volvieron: number;
  en_maestro: boolean;
}
interface Ficha {
  nombre: string;
  kpis: Record<string, number>;
  mensual: { mes: string; asistio: number; no_asistio: number; no_ocurrieron: number }[];
  servicios: { clave: string; n: number }[];
  franja: { clave: number; cerradas: number; no_asistio: number }[];
  dia: { clave: number; n: number }[];
}

// PRO-04: con pocos pacientes nuevos la tasa de retención no es representativa.
const MIN_COHORTE = 20;

const retencion = (f: FilaProfesional) => (f.nuevos_cohorte >= MIN_COHORTE ? f.volvieron / f.nuevos_cohorte : null);

const COLUMNAS: Columna<FilaProfesional>[] = [
  { clave: 'nombre', titulo: 'Profesional' },
  { clave: 'especialidad', titulo: 'Especialidad' },
  { clave: 'asistio', titulo: 'Atendidas', num: true },
  {
    clave: 'no_asistio',
    titulo: 'Asistencia',
    num: true,
    formato: (_v, f) => pct(f.asistio, f.asistio + f.no_asistio),
    csv: (_v, f) => pct(f.asistio, f.asistio + f.no_asistio),
    orden: (f) => ratio(f.asistio, f.asistio + f.no_asistio),
  },
  {
    clave: 'no_ocurrieron',
    titulo: 'No ocurrieron',
    num: true,
    formato: (v, f) => pct(v, f.total),
    csv: (v, f) => pct(v, f.total),
    orden: (f) => ratio(f.no_ocurrieron, f.total),
  },
  { clave: 'pacientes', titulo: 'Pacientes atendidos', num: true },
  { clave: 'nuevos', titulo: 'Pacientes nuevos', num: true },
  {
    clave: 'volvieron',
    titulo: 'Vuelven a 2.ª cita (90 d)',
    num: true,
    formato: (_v, f) => (retencion(f) === null ? <span title={`Menos de ${MIN_COHORTE} pacientes nuevos con ventana cerrada`} style={{ color: 'var(--muted)' }}>pocos datos</span> : pct(f.volvieron, f.nuevos_cohorte, 0)),
    csv: (_v, f) => (retencion(f) === null ? '' : pct(f.volvieron, f.nuevos_cohorte, 0)),
    orden: retencion,
  },
];

export default function Profesionales({ rango }: { rango: Rango }) {
  const lista = useApi<{ filas: FilaProfesional[] }>(conRango('/api/profesionales', rango), 120_000);
  const [elegido, setElegido] = useState<string | null>(null);
  const ficha = useApi<Ficha>(elegido ? conRango('/api/profesionales/ficha', rango, { nombre: elegido }) : null, 120_000);
  const sombras = useSombras(['agenda']);

  const optMensual = useCallback(() => {
    const m = ficha.data!.mensual;
    return barrasApiladas(
      m.map((x) => x.mes),
      { 'Asistió': m.map((x) => x.asistio), 'No asistió': m.map((x) => x.no_asistio), 'Cancelada': m.map((x) => x.no_ocurrieron) },
      'month',
      sombras,
    );
  }, [ficha.data, sombras]);
  const optServicios = useCallback(() => ranking(ficha.data!.servicios.map((s) => ({ nombre: etiqueta(s.clave), valor: s.n }))), [ficha.data]);
  const optFranja = useCallback(
    () => barrasTasa(ficha.data!.franja.map((f) => ({ nombre: `${f.clave}:00`, parte: f.no_asistio, total: f.cerradas })), 15),
    [ficha.data],
  );
  const optDia = useCallback(() => ranking(ficha.data!.dia.map((d) => ({ nombre: DIAS[d.clave], valor: d.n }))), [ficha.data]);

  const k = ficha.data?.kpis;
  const sinMaestro = lista.data?.filas.filter((f) => !f.en_maestro).length ?? 0;

  return (
    <>
      <AvisoIncidentes rango={rango} areas={['agenda']} compara={false} />
      <Tarjeta
        titulo="Profesionales"
        ayuda={
          <>
            Haga clic en un profesional para ver su ficha. Estas cifras dependen del tipo de pacientes y de convenios de cada uno:
            sirven para conversar y planear, no como ranking de desempeño.
          </>
        }
      >
        <Estado cargando={lista.cargando} error={lista.error} hayDatos={!!lista.data} />
        {lista.data && (
          <>
            <Tabla filas={lista.data.filas} columnas={COLUMNAS} nombreCsv={`profesionales_${rango.desde}_${rango.hasta}`} alFila={(f) => setElegido(f.nombre)} />
            {sinMaestro > 0 && (
              <p className="nota">
                {sinMaestro} profesionales no están en el maestro de equipo del sistema; sus citas se agrupan por nombre. Vuelven a 2.ª cita: pacientes cuya primera
                atención fue con el profesional y que regresaron en 90 días (desde sep-2025, solo pacientes con la ventana ya cumplida).
              </p>
            )}
          </>
        )}
      </Tarjeta>

      {elegido && (
        <>
          <Estado cargando={ficha.cargando} error={ficha.error} hayDatos={!!ficha.data} />
          {ficha.data && k && (
            <>
              <h3 style={{ margin: '24px 0 12px' }}>{ficha.data.nombre}</h3>
              <div className="kpis">
                <Kpi etiqueta="Citas atendidas" actual={k.asistio} />
                <Kpi etiqueta="Asistencia" formato="pct" actual={ratio(k.asistio, k.asistio + k.no_asistio)} />
                <Kpi etiqueta="Canceladas o reprogramadas" valor={pct(k.canceladas + k.reprogramadas, k.total)} actual={null} />
                <Kpi etiqueta="Pacientes atendidos" actual={k.pacientes} />
                <Kpi etiqueta="Atenciones virtuales" valor={pct(k.virtuales, k.asistio)} actual={null} />
                <Kpi etiqueta="Citas programadas" actual={k.programadas} />
              </div>
              <Tarjeta titulo="Citas por mes" ayuda="Desde el inicio de los datos, sin importar el período elegido.">
                <Grafico opcion={optMensual} alto={260} />
              </Tarjeta>
              <div className="grid g3">
                <Tarjeta titulo="Tipo de atención" ayuda="Citas atendidas en el período.">
                  <Grafico opcion={optServicios} alto={240} />
                </Tarjeta>
                <Tarjeta titulo="Inasistencia por hora" ayuda="Horas con menos de 15 citas, en gris.">
                  <Grafico opcion={optFranja} alto={240} />
                </Tarjeta>
                <Tarjeta titulo="Citas por día de la semana">
                  <Grafico opcion={optDia} alto={240} />
                </Tarjeta>
              </div>
            </>
          )}
        </>
      )}
      {!elegido && lista.data && <p className="ayuda" style={{ marginTop: 12 }}>{num(lista.data.filas.length)} profesionales con citas en el período.</p>}
    </>
  );
}
