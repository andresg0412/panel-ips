import { useCallback, useMemo } from 'react';
import { conRango, useApi, type Rango } from '../api';
import Grafico from '../components/Grafico';
import { barrasApiladas, barrasTasa, lineas, mapaCalor, pequenosMultiplos, pivotar, ranking } from '../components/series';
import { Estado, Tabla, Tarjeta, type Columna } from '../components/ui';
import { useSombras } from '../incidentes';
import { DIAS, etiqueta, fecha, mesCorto, num, tasaTxt } from '../format';

// ---------------------------------------------------------------------------------------------
// AGE-01: mapa de la inasistencia
// ---------------------------------------------------------------------------------------------

interface Tasa {
  clave: string;
  cerradas: number;
  no_asistio: number;
}
interface Inasistencia {
  mapa: { dia: number; hora: number; cerradas: number; no_asistio: number }[];
  edad: Tasa[];
  modalidad: Tasa[];
  anticipacion: Tasa[];
  especialidad: Tasa[];
  pago: Tasa[];
  servicio: Tasa[];
}

const MIN_N = 30;

function aItems(filas: Tasa[], ordenar = false) {
  const items = filas
    .filter((f) => f.cerradas > 0 && f.clave !== 'sin_dato' && f.clave !== '.Otro')
    .map((f) => ({ nombre: etiqueta(f.clave), parte: f.no_asistio, total: f.cerradas }));
  return ordenar ? items.sort((a, b) => b.parte / b.total - a.parte / a.total) : items;
}

export function AgendaInasistencia({ rango }: { rango: Rango }) {
  const { data, error, cargando } = useApi<Inasistencia>(conRango('/api/agenda/inasistencia', rango), 300_000);

  const promedio = useMemo(() => {
    if (!data) return undefined;
    const c = data.mapa.reduce((s, x) => s + x.cerradas, 0);
    const n = data.mapa.reduce((s, x) => s + x.no_asistio, 0);
    return c ? n / c : undefined;
  }, [data]);

  // Celdas día × hora con suficientes citas, ordenadas por inasistencia: alimentan la frase de hallazgos.
  const celdas = useMemo(
    () => (data?.mapa ?? []).filter((c) => c.cerradas >= MIN_N).map((c) => ({ ...c, tasa: c.no_asistio / c.cerradas })),
    [data],
  );

  const optMapa = useCallback(() => {
    const horas = [...new Set(data!.mapa.filter((c) => c.cerradas >= MIN_N).map((c) => c.hora))].sort((a, b) => a - b);
    const dias = [6, 5, 4, 3, 2, 1].filter((d) => data!.mapa.some((c) => c.dia === d));
    const xs = horas.map((h) => `${h}:00`);
    const ys = dias.map((d) => DIAS[d]);
    const valores: [number, number, number | null, number][] = data!.mapa
      .filter((c) => horas.includes(c.hora) && dias.includes(c.dia))
      .map((c) => [horas.indexOf(c.hora), dias.indexOf(c.dia), c.cerradas >= MIN_N ? c.no_asistio / c.cerradas : null, c.cerradas]);
    return mapaCalor(xs, ys, valores, (v) => tasaTxt(v, 0), (x, y, v, n) =>
      v === null ? `${y} ${x}: muy pocas citas (n=${num(n)})` : `${y} ${x}: <b>${tasaTxt(v)}</b> no asistió (n=${num(n)})`,
    );
  }, [data]);

  const opt = (clave: keyof Omit<Inasistencia, 'mapa'>, ordenar = false) => () => barrasTasa(aItems(data![clave], ordenar), MIN_N, promedio);
  /* eslint-disable react-hooks/exhaustive-deps */
  const optEdad = useCallback(opt('edad'), [data, promedio]);
  const optModalidad = useCallback(opt('modalidad'), [data, promedio]);
  const optAnticipacion = useCallback(opt('anticipacion'), [data, promedio]);
  const optEspecialidad = useCallback(opt('especialidad', true), [data, promedio]);
  const optPago = useCallback(opt('pago'), [data, promedio]);
  const optServicio = useCallback(opt('servicio', true), [data, promedio]);
  /* eslint-enable react-hooks/exhaustive-deps */

  const peores = [...celdas].sort((a, b) => b.tasa - a.tasa).slice(0, 3);
  const mejores = [...celdas].sort((a, b) => a.tasa - b.tasa).slice(0, 2);

  return (
    <>
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && (
        <>
          <Tarjeta
            titulo="¿Cuándo faltan más los pacientes?"
            ayuda="Porcentaje de citas a las que el paciente no asistió, sobre las citas que sí debían ocurrir. Excluye los días con incidentes de datos y las celdas con menos de 30 citas."
          >
            {promedio !== undefined && (
              <p className="frase">
                Inasistencia promedio: <b>{tasaTxt(promedio)}</b>.
                {peores.length > 0 && (
                  <>
                    {' '}Más alta: <b>{peores.map((c) => `${DIAS[c.dia].toLowerCase()} ${c.hora}:00 (${tasaTxt(c.tasa, 0)})`).join(', ')}</b>.
                  </>
                )}
                {mejores.length > 0 && (
                  <>
                    {' '}Más baja: {mejores.map((c) => `${DIAS[c.dia].toLowerCase()} ${c.hora}:00 (${tasaTxt(c.tasa, 0)})`).join(', ')}.
                  </>
                )}
              </p>
            )}
            <Grafico opcion={optMapa} alto={300} />
          </Tarjeta>
          <div className="grid g3">
            <Tarjeta titulo="Por anticipación con que se agendó" marcas={[{ tipo: 'estimada', detalle: 'Aproximado: el sistema registra la cita cuando la ve en Globho, hasta 30 días antes. Esperas mayores quedan cortadas en 30 días.' }]} ayuda="Aproximado: días entre el registro de la cita y la cita.">
              <Grafico opcion={optAnticipacion} alto={230} />
            </Tarjeta>
            <Tarjeta titulo="Por edad del paciente">
              <Grafico opcion={optEdad} alto={230} />
            </Tarjeta>
            <Tarjeta titulo="Presencial o virtual">
              <Grafico opcion={optModalidad} alto={230} />
            </Tarjeta>
            <Tarjeta titulo="Por tipo de atención">
              <Grafico opcion={optServicio} alto={230} />
            </Tarjeta>
            <Tarjeta titulo="Por especialidad">
              <Grafico opcion={optEspecialidad} alto={230} />
            </Tarjeta>
            <Tarjeta titulo="Particular o convenio">
              <Grafico opcion={optPago} alto={230} />
            </Tarjeta>
          </div>
          <p className="nota">
            Son asociaciones, no causas: por ejemplo, las citas agendadas el mismo día casi no fallan porque el paciente ya decidió venir.
            La línea punteada marca el promedio.
          </p>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// AGE-02, 04, 05, 06, 07: tendencias mensuales desde el inicio de los datos
// ---------------------------------------------------------------------------------------------

interface Mensual {
  mes: string;
  total: number;
  canceladas: number;
  reprogramadas: number;
  cerradas: number;
  no_asistio: number;
  virtuales: number;
  no_asistio_virtual: number;
  cerradas_virtual: number;
  particulares: number;
}
interface Historico {
  mensual: Mensual[];
  servicios: { mes: string; tipo_servicio: string; n: number }[];
  espera: { mes: string; especialidad: string; tipo: string; n: number; mediana: number; p90: number }[];
  convenios: { nombre: string; total: number; asistio: number }[];
}

const SERVICIOS = ['control', 'primera_vez', 'psicoterapia', 'evaluacion', 'crisis', 'rehabilitacion', 'empresarial', 'otro'];
const r = (a: number, b: number) => (b > 0 ? a / b : null);

export function AgendaTendencias() {
  const { data, error, cargando } = useApi<Historico>('/api/agenda/historico');
  const sombras = useSombras(['agenda']);

  const optNoOcurrio = useCallback(() => {
    const m = data!.mensual;
    return lineas(
      m.map((x) => x.mes),
      {
        'No ocurrieron (total)': m.map((x) => r(x.canceladas + x.reprogramadas, x.total)),
        Cancelada: m.map((x) => r(x.canceladas, x.total)),
        Reprogramada: m.map((x) => r(x.reprogramadas, x.total)),
      },
      'month',
      sombras,
      true,
    );
  }, [data, sombras]);

  const optServicios = useCallback(() => {
    const { periodos, series } = pivotar(
      data!.servicios.map((s) => ({ ...s, periodo: s.mes })),
      'tipo_servicio',
      'n',
      SERVICIOS,
    );
    const opt = barrasApiladas(periodos, series, 'month', sombras) as any;
    opt.series.forEach((s: any) => (s.name = etiqueta(s.name)));
    return opt;
  }, [data, sombras]);

  const optVirtual = useCallback(() => {
    const m = data!.mensual;
    return lineas(
      m.map((x) => x.mes),
      {
        'Citas virtuales (% del total)': m.map((x) => r(x.virtuales, x.total)),
        'Inasistencia virtual': m.map((x) => r(x.no_asistio_virtual, x.cerradas_virtual)),
        'Inasistencia presencial': m.map((x) => r(x.no_asistio - x.no_asistio_virtual, x.cerradas - x.cerradas_virtual)),
      },
      'month',
      sombras,
      true,
    );
  }, [data, sombras]);

  const optParticular = useCallback(() => {
    const m = data!.mensual;
    return lineas(m.map((x) => x.mes), { 'Citas particulares (% del total)': m.map((x) => r(x.particulares, x.total)) }, 'month', sombras, true);
  }, [data, sombras]);
  const optConvenios = useCallback(() => ranking(data!.convenios.map((c) => ({ nombre: c.nombre, valor: c.total }))), [data]);

  // AGE-04: mediana de días de espera para la primera vez, un panel por especialidad.
  const optEspera = useCallback(() => {
    const meses = [...new Set(data!.espera.map((e) => e.mes))].sort();
    const series: Record<string, (number | null)[]> = {};
    for (const esp of ['Psicología', 'Psiquiatría', 'Neuropsicología']) {
      series[esp] = meses.map((m) => {
        const f = data!.espera.find((e) => e.mes === m && e.especialidad === esp && e.tipo === 'primera_vez');
        return f && f.n >= 10 ? f.mediana : null;
      });
    }
    return pequenosMultiplos(meses, series, 'month', sombras);
  }, [data, sombras]);

  const ultimaEspera = useMemo(() => {
    if (!data) return [];
    const ultimo = [...new Set(data.espera.map((e) => e.mes))].sort().slice(-2);
    const filas: { especialidad: string; tipo: string; n: number; mediana: number; p90: number }[] = [];
    for (const esp of ['Psicología', 'Psiquiatría', 'Neuropsicología']) {
      for (const tipo of ['primera_vez', 'control']) {
        const fs = data.espera.filter((e) => ultimo.includes(e.mes) && e.especialidad === esp && e.tipo === tipo);
        if (!fs.length) continue;
        const n = fs.reduce((s, f) => s + f.n, 0);
        // Promedio ponderado de los dos últimos meses (aprox. de la mediana conjunta).
        filas.push({
          especialidad: esp,
          tipo,
          n,
          mediana: Math.round(fs.reduce((s, f) => s + f.mediana * f.n, 0) / n),
          p90: Math.round(fs.reduce((s, f) => s + f.p90 * f.n, 0) / n),
        });
      }
    }
    return filas;
  }, [data]);

  return (
    <>
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && (
        <>
          <p className="nota" style={{ marginTop: 0 }}>Tendencias mensuales desde agosto de 2025, sin importar el período elegido. Solo citas de pacientes.</p>
          <Tarjeta
            titulo="Citas que no ocurrieron"
            ayuda="Porcentaje de citas canceladas o reprogramadas cada mes. Desde marzo de 2026 suben las cancelaciones y bajan las reprogramaciones a la vez: puede ser un cambio en cómo se registran en Globho; por eso se muestra también el total."
          >
            <Grafico opcion={optNoOcurrio} alto={280} />
          </Tarjeta>
          <Tarjeta titulo="Citas atendidas por tipo de atención">
            <Grafico opcion={optServicios} alto={300} />
          </Tarjeta>
          <div className="grid g2">
            <Tarjeta titulo="Teleconsulta" ayuda="Peso de las citas virtuales y su inasistencia frente a la presencial.">
              <Grafico opcion={optVirtual} alto={260} />
            </Tarjeta>
            <Tarjeta titulo="Particulares" ayuda="Porcentaje de citas sin convenio.">
              <Grafico opcion={optParticular} alto={260} />
            </Tarjeta>
          </div>
          <div className="grid g2">
            <Tarjeta titulo="¿Cuánto espera un paciente nuevo?" marcas={[{ tipo: 'estimada', detalle: 'Aproximado: el sistema registra la cita cuando la ve en Globho, hasta 30 días antes. Esperas mayores quedan cortadas en 30 días.' }]} ayuda="Mediana de días entre el registro de la primera cita y la cita. Aproximado: el sistema ve la cita hasta 30 días antes.">
              <Grafico opcion={optEspera} alto={300} />
            </Tarjeta>
            <Tarjeta titulo="Días de espera recientes" marcas={[{ tipo: 'estimada', detalle: 'Aproximado: el sistema registra la cita cuando la ve en Globho, hasta 30 días antes. Esperas mayores quedan cortadas en 30 días.' }]} ayuda="Últimos dos meses. P90: 9 de cada 10 pacientes esperan menos que esto.">
              <Tabla
                filas={ultimaEspera}
                columnas={[
                  { clave: 'especialidad', titulo: 'Especialidad' },
                  { clave: 'tipo', titulo: 'Tipo', formato: etiqueta, csv: etiqueta },
                  { clave: 'mediana', titulo: 'Días (mediana)', num: true },
                  { clave: 'p90', titulo: 'Días (P90)', num: true },
                  { clave: 'n', titulo: 'Citas', num: true },
                ]}
              />
            </Tarjeta>
          </div>
          <Tarjeta titulo="Convenios con más citas" ayuda="Desde agosto de 2025.">
            <Grafico opcion={optConvenios} alto={300} />
          </Tarjeta>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// AGE-08: calidad de la agenda
// ---------------------------------------------------------------------------------------------

interface Calidad {
  sinCierre: { mes: string; n: number }[];
  sinProfesional: { profesional: string; especialidad: string | null; n: number; ultima: string }[];
  administrativas: { catalogo: string; n: number }[];
}

const COLS_SIN_CIERRE: Columna<Calidad['sinCierre'][number]>[] = [
  { clave: 'mes', titulo: 'Mes', formato: mesCorto, csv: (v) => String(v) },
  { clave: 'n', titulo: 'Citas sin cierre', num: true },
];
const COLS_SIN_PROF: Columna<Calidad['sinProfesional'][number]>[] = [
  { clave: 'profesional', titulo: 'Profesional (nombre en Globho)' },
  { clave: 'especialidad', titulo: 'Especialidad' },
  { clave: 'n', titulo: 'Citas', num: true },
  { clave: 'ultima', titulo: 'Última cita', formato: fecha },
];
const COLS_ADMIN: Columna<Calidad['administrativas'][number]>[] = [
  { clave: 'catalogo', titulo: 'Catálogo excluido' },
  { clave: 'n', titulo: 'Registros', num: true },
];

export function AgendaCalidad() {
  const { data, error, cargando } = useApi<Calidad>('/api/agenda/calidad');
  return (
    <>
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && (
        <>
          <div className="grid g2">
            <Tarjeta
              titulo="Citas sin cierre"
              ayuda="Citas pasadas que siguen Pendiente o Confirmado: no se sabe si el paciente asistió. La mayoría son de junio de 2026, cuando la sincronización con Globho estuvo detenida."
            >
              <Tabla filas={data.sinCierre} columnas={COLS_SIN_CIERRE} nombreCsv="citas_sin_cierre" vacio="No hay citas sin cierre" />
            </Tarjeta>
            <Tarjeta
              titulo="Registros que no son citas de pacientes"
              ayuda="Reuniones internas y bloques administrativos de la agenda. El panel los excluye de todas las métricas."
            >
              <Tabla filas={data.administrativas} columnas={COLS_ADMIN} />
            </Tarjeta>
          </div>
          <Tarjeta
            titulo="Profesionales que no están en el maestro de equipo"
            ayuda="Sus citas no tienen identificador de profesional en el sistema. Se agrupan por nombre, pero no se puede calcular la ocupación de su agenda. Se corrige registrándolos en el equipo."
          >
            <Tabla filas={data.sinProfesional} columnas={COLS_SIN_PROF} nombreCsv="profesionales_sin_maestro" />
          </Tarjeta>
        </>
      )}
    </>
  );
}
