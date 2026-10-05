import { useCallback, useMemo } from 'react';
import { conRango, useApi, type Rango } from '../api';
import Grafico, { base, token } from '../components/Grafico';
import { barrasApiladas, ranking } from '../components/series';
import { Estado, Kpi, Tarjeta } from '../components/ui';
import { useMarcas, useMesesConfiables, useSombras } from '../incidentes';
import { etiqueta, num } from '../format';

interface Panorama {
  mensual: { mes: string; nuevos: number; recurrentes: number }[];
  intervalos: { semana: number; n: number }[];
  perfil: { dimension: string; clave: string | null; n: number }[];
  resumenIntervalos: { n: number; p25: number; mediana: number; p75: number };
}

export default function PacientesPanorama({ rango }: { rango: Rango }) {
  const { data, error, cargando } = useApi<Panorama>(conRango('/api/pacientes/panorama', rango), 300_000);
  const sombras = useSombras(['agenda']);
  const marcasHistoria = useMarcas({ desde: '2025-08-01', hasta: rango.hasta }, ['agenda']);

  // PAC-01: agosto de 2025 se omite porque es la carga inicial (todos parecen "nuevos").
  const mensual = useMemo(() => (data?.mensual ?? []).filter((m) => m.mes >= '2025-09'), [data]);

  const optMensual = useCallback(
    () =>
      barrasApiladas(
        mensual.map((m) => m.mes),
        { Nuevos: mensual.map((m) => m.nuevos), Recurrentes: mensual.map((m) => m.recurrentes) },
        'month',
        sombras,
      ),
    [mensual, sombras],
  );

  // PAC-03: histograma de semanas entre atenciones consecutivas, con referencias en 1, 2 y 4 semanas.
  const optIntervalos = useCallback(() => {
    const b = base() as Record<string, any>;
    const filas = data!.intervalos;
    const etiquetas = filas.map((f) => (f.semana >= 13 ? '12+ sem' : `${f.semana} sem`));
    return {
      ...b,
      legend: { show: false },
      tooltip: { ...b.tooltip, trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v: number) => `${num(v)} veces` },
      xAxis: { ...b.xAxis, type: 'category', data: etiquetas, name: 'Tiempo hasta la siguiente cita', nameLocation: 'middle', nameGap: 28 },
      yAxis: { ...b.yAxis, type: 'value' },
      grid: { ...b.grid, bottom: 32, top: 16 },
      series: [
        {
          type: 'bar',
          barMaxWidth: 28,
          data: filas.map((f) => f.n),
          itemStyle: { color: token('s1'), borderRadius: [4, 4, 0, 0] },
        },
      ],
    };
  }, [data]);

  const perfil = (dim: string) => () =>
    ranking(
      data!.perfil
        .filter((p) => p.dimension === dim && p.clave && p.clave !== 'sin_dato')
        .sort((a, b) => (dim === 'edad' ? String(a.clave).localeCompare(String(b.clave)) : b.n - a.n))
        .map((p) => ({ nombre: etiqueta(p.clave), valor: p.n })),
    );
  /* eslint-disable react-hooks/exhaustive-deps */
  const optEdad = useCallback(perfil('edad'), [data]);
  const optRegimen = useCallback(perfil('regimen'), [data]);
  const optPago = useCallback(perfil('pago'), [data]);
  const optModalidad = useCallback(perfil('modalidad'), [data]);
  const optEspecialidad = useCallback(perfil('especialidad'), [data]);
  /* eslint-enable react-hooks/exhaustive-deps */

  // Promedio de los últimos 3 meses completos que no caen en un incidente.
  const confiables = useMesesConfiables()(mensual.map((m) => m.mes));
  const ultimos = mensual.filter((m) => confiables.includes(m.mes));
  const promNuevos = ultimos.length ? Math.round(ultimos.reduce((s, m) => s + m.nuevos, 0) / ultimos.length) : null;
  const atendidos = data?.perfil.filter((p) => p.dimension === 'pago').reduce((s, p) => s + p.n, 0) ?? 0;
  const ri = data?.resumenIntervalos;

  return (
    <>
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && ri && (
        <>
          <div className="kpis">
            <Kpi etiqueta="Pacientes atendidos en el período" actual={atendidos} />
            <Kpi etiqueta="Pacientes nuevos por mes (promedio reciente)" actual={promNuevos} />
            <Kpi etiqueta="Días típicos entre citas" valor={`${Math.round(ri.mediana)} días`} actual={null} />
            <Kpi etiqueta="La mitad vuelve entre" valor={`${Math.round(ri.p25)} y ${Math.round(ri.p75)} días`} actual={null} />
          </div>
          <Tarjeta
            titulo="Pacientes nuevos y recurrentes atendidos por mes"
            marcas={marcasHistoria}
            ayuda="Nuevo: su primera atención registrada fue ese mes. Desde septiembre de 2025 (agosto es el inicio de los datos e incluye a quienes ya venían)."
          >
            <Grafico opcion={optMensual} alto={280} />
          </Tarjeta>
          <Tarjeta
            titulo="¿Cada cuánto vuelven los pacientes?"
            ayuda={`Tiempo entre una atención y la siguiente del mismo paciente (${num(ri.n)} casos desde agosto de 2025).`}
          >
            <Grafico opcion={optIntervalos} alto={260} />
          </Tarjeta>
          <h3 style={{ margin: '24px 0 12px' }}>Perfil de los pacientes atendidos en el período</h3>
          <div className="grid g3">
            <Tarjeta titulo="Edad">
              <Grafico opcion={optEdad} alto={220} />
            </Tarjeta>
            <Tarjeta titulo="Especialidad">
              <Grafico opcion={optEspecialidad} alto={220} />
            </Tarjeta>
            <Tarjeta titulo="Particular o convenio">
              <Grafico opcion={optPago} alto={220} />
            </Tarjeta>
            <Tarjeta titulo="Régimen">
              <Grafico opcion={optRegimen} alto={220} />
            </Tarjeta>
            <Tarjeta titulo="Modalidad de su última cita">
              <Grafico opcion={optModalidad} alto={220} />
            </Tarjeta>
          </div>
        </>
      )}
    </>
  );
}
