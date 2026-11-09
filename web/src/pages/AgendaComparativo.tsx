// Agenda: un mes frente a otro (mes anterior, mismo mes del año anterior o dos meses elegidos).
// Diseño: proyecto-ips/docs/features/2026-11-09-comparativo-periodos-panel.md, secciones 4.2 y 6.2.
import { useCallback } from 'react';
import { useApi } from '../api';
import Grafico from '../components/Grafico';
import { barrasComparadas, unirPorClave, type FilaUnida } from '../components/series';
import { Estado, Tarjeta } from '../components/ui';
import {
  AvisosComparativo, EncabezadoComparativo, KpiComparado, SelectorComparativo, TablaComparativa, type MetricaTabla,
} from '../components/comparativo';
import { useComparativo, type RespuestaComparativa } from '../comparativo';
import { DIAS, etiqueta, nombreMes } from '../format';
import { canceladasPct, cumplimiento, esperadas, realizadas, tasa, type PorEstado } from '../metricas';

interface DatosAgenda {
  totales: PorEstado;
  especialidad: PorEstado[];
  profesional: PorEstado[];
  administradora: PorEstado[];
  servicio: PorEstado[];
  diaSemana: PorEstado[];
}

/** Cuántos convenios se comparan: los de más citas entre los dos meses. */
const MAX_CONVENIOS = 15;

const METRICAS: MetricaTabla<PorEstado>[] = [
  { titulo: 'Citas', tipo: 'conteo', valor: (f) => f.total, mejorSiSube: null },
  { titulo: 'Atendidas', tipo: 'conteo', valor: (f) => f.asistio, mejorSiSube: true },
  { titulo: 'Asistencia a citas realizadas', tipo: 'tasa', valor: tasa, mejorSiSube: true, base: realizadas },
  { titulo: 'Cumplimiento de agenda', tipo: 'tasa', valor: cumplimiento, mejorSiSube: true, base: esperadas },
  { titulo: 'Canceladas %', tipo: 'tasa', valor: canceladasPct, mejorSiSube: false, base: esperadas },
];
const METRICAS_SERVICIO: MetricaTabla<PorEstado>[] = [
  ...METRICAS,
  { titulo: 'Horas de consulta perdidas', tipo: 'conteo', valor: (f) => f.horas_no_ocurrieron ?? 0, mejorSiSube: false },
];

const porNombre = (f: PorEstado) => f.nombre ?? '';
const porTotal = (f: PorEstado) => f.total;
const sumaTotal = (f: { a: PorEstado | null; b: PorEstado | null }) => (f.a?.total ?? 0) + (f.b?.total ?? 0);

export default function AgendaComparativo() {
  const control = useComparativo();
  const { data, error, cargando } = useApi<RespuestaComparativa<DatosAgenda>>(`/api/agenda/comparativo?${control.consulta}`, 120_000);

  return (
    <>
      <SelectorComparativo control={control} comparativo={data?.comparativo} />
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && <Resultado datos={data} />}
    </>
  );
}

function Resultado({ datos }: { datos: RespuestaComparativa<DatosAgenda> }) {
  const { comparativo: c, a, b } = datos;
  const optEstados = useCallback(() => {
    const valores = (t: PorEstado) => [t.asistio, t.no_asistio, t.canceladas, t.reprogramadas, t.programadas, t.sin_cierre ?? 0];
    return barrasComparadas(
      ['Asistió', 'No asistió', 'Cancelada', 'Reprogramada', 'Programada', 'Sin cierre'],
      { nombre: nombreMes(c.a.mes, true), valores: valores(a.totales) },
      { nombre: nombreMes(c.b.mes, true), valores: valores(b.totales) },
    );
  }, [a, b, c]);
  const ta = a.totales;
  const tb = b.totales;
  const kpi = (etiquetaKpi: string, valor: (t: PorEstado) => number | null, mejorSiSube: boolean | null, ayuda?: string) => (
    <KpiComparado etiqueta={etiquetaKpi} a={valor(ta)} b={valor(tb)} comparativo={c} mejorSiSube={mejorSiSube} ayuda={ayuda} />
  );
  const kpiTasa = (etiquetaKpi: string, valor: (t: PorEstado) => number | null, base: (t: PorEstado) => number, mejorSiSube: boolean, ayuda: string) => (
    <KpiComparado etiqueta={etiquetaKpi} a={valor(ta)} b={valor(tb)} comparativo={c} formato="pct" mejorSiSube={mejorSiSube} ayuda={ayuda} baseA={base(ta)} baseB={base(tb)} />
  );

  const convenios = unirPorClave(a.administradora, b.administradora, porNombre, porTotal).sort((x, y) => sumaTotal(y) - sumaTotal(x)).slice(0, MAX_CONVENIOS);
  const dias = unirPorClave(a.diaSemana, b.diaSemana, (f) => f.dia ?? 0, porTotal).sort((x, y) => Number(x.clave) - Number(y.clave));
  const tabla = (titulo: string, filas: FilaUnida<PorEstado>[], nombreCsv: string, opciones: { metricas?: MetricaTabla<PorEstado>[]; nombre?: (clave: string) => string } = {}) => (
    <TablaComparativa titulo={titulo} filas={filas} metricas={opciones.metricas ?? METRICAS} comparativo={c} nombreCsv={nombreCsv} nombre={opciones.nombre} />
  );

  return (
    <>
      <EncabezadoComparativo comparativo={c} />
      <AvisosComparativo comparativo={c} />
      <div className="kpis">
        {kpi('Citas en el período', (t) => t.total, null)}
        {kpi('Citas atendidas', (t) => t.asistio, true)}
        {kpiTasa('Asistencia a citas realizadas', tasa, realizadas, true, 'Asistió ÷ (asistió + no asistió). No cuenta las canceladas, anuladas ni reprogramadas.')}
        {kpiTasa('Cumplimiento de agenda', cumplimiento, esperadas, true, 'Asistió ÷ (asistió + no asistió + canceladas). Las anuladas (errores de registro) y las reprogramadas no cuentan.')}
        {kpiTasa('Canceladas %', canceladasPct, esperadas, false, 'Canceladas ÷ (asistió + no asistió + canceladas). Cuanto menor, mejor.')}
        {kpi('No asistieron', (t) => t.no_asistio, false)}
        {kpi('Canceladas', (t) => t.canceladas, false)}
        {kpi('Reprogramadas', (t) => t.reprogramadas, null)}
        {kpi('Horas de consulta perdidas', (t) => t.horas_no_ocurrieron ?? 0, false, 'Duración de las citas canceladas y reprogramadas.')}
        {(ta.programadas > 0 || tb.programadas > 0) && kpi('Programadas (por venir)', (t) => t.programadas, null)}
        {((ta.sin_cierre ?? 0) > 0 || (tb.sin_cierre ?? 0) > 0) && kpi('Sin cierre (no se sabe si ocurrió)', (t) => t.sin_cierre ?? 0, false)}
      </div>
      <Tarjeta titulo="Citas por estado" ayuda="Las anuladas (errores de registro) no se cuentan.">
        <Grafico opcion={optEstados} alto={280} />
      </Tarjeta>
      <Tarjeta titulo="Por especialidad">
        {tabla('Especialidad', unirPorClave(a.especialidad, b.especialidad, porNombre, porTotal), 'comparativo_agenda_especialidad')}
      </Tarjeta>
      <Tarjeta titulo="Por profesional" ayuda="Haga clic en un encabezado para ordenar. La ficha completa está en Profesionales.">
        {tabla('Profesional', unirPorClave(a.profesional, b.profesional, porNombre, porTotal), 'comparativo_agenda_profesional')}
      </Tarjeta>
      <Tarjeta titulo="Por tipo de atención" ayuda="Horas perdidas: duración de las citas canceladas y reprogramadas.">
        {tabla('Tipo de atención', unirPorClave(a.servicio, b.servicio, porNombre, porTotal), 'comparativo_agenda_tipo_atencion', { metricas: METRICAS_SERVICIO, nombre: etiqueta })}
      </Tarjeta>
      <Tarjeta titulo="Por convenio / administradora" ayuda={`Los ${MAX_CONVENIOS} con más citas entre los dos meses.`}>
        {tabla('Convenio / administradora', convenios, 'comparativo_agenda_convenio')}
      </Tarjeta>
      <Tarjeta titulo="Por día de la semana">
        {tabla('Día', dias, 'comparativo_agenda_dia', { nombre: (clave) => DIAS[Number(clave)] })}
      </Tarjeta>
    </>
  );
}
