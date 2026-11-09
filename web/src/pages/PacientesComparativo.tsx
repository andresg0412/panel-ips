// Pacientes: cuántos se atendieron, cuántos fueron nuevos y cómo es su perfil en un mes frente a otro.
// Diseño: proyecto-ips/docs/features/2026-11-09-comparativo-periodos-panel.md, secciones 4.4 y 6.4.
import { useCallback } from 'react';
import { useApi } from '../api';
import Grafico from '../components/Grafico';
import { barrasApiladas, unirPorClave } from '../components/series';
import { Estado, Tarjeta } from '../components/ui';
import {
  AvisosComparativo, EncabezadoComparativo, KpiComparado, SelectorComparativo, TablaComparativa, promedioTxt, type MetricaTabla,
} from '../components/comparativo';
import { useComparativo, type RespuestaComparativa } from '../comparativo';
import { etiqueta, ratio } from '../format';

interface ResumenPacientes {
  atendidos: number;
  /** null en agosto de 2025: es la carga inicial y todos parecerían nuevos. */
  nuevos: number | null;
  recurrentes: number | null;
  atendidas: number;
  con_inasistencia: number;
}
interface DatosPacientes {
  resumen: ResumenPacientes;
  perfil: { dimension: string; clave: string | null; n: number }[];
}

/** Una categoría del perfil (p. ej. un rango de edad) con el total de pacientes atendidos del mes. */
interface FilaPerfil {
  clave: string;
  n: number;
  total: number;
}

const DIMENSIONES: [string, string][] = [
  ['edad', 'Edad'],
  ['especialidad', 'Especialidad'],
  ['pago', 'Particular o convenio'],
  ['regimen', 'Régimen'],
  ['modalidad', 'Modalidad de su última cita'],
];

const METRICAS_PERFIL: MetricaTabla<FilaPerfil>[] = [
  { titulo: 'Pacientes', tipo: 'conteo', valor: (f) => f.n, mejorSiSube: null },
  { titulo: '% de los atendidos', tipo: 'tasa', valor: (f) => ratio(f.n, f.total), mejorSiSube: null, base: (f) => f.total },
];

const filasPerfil = (perfil: DatosPacientes['perfil'], dimension: string): FilaPerfil[] => {
  const categorias = perfil.filter((p) => p.dimension === dimension);
  const total = categorias.reduce((suma, p) => suma + p.n, 0);
  return categorias.map((p) => ({ clave: p.clave ?? 'sin_dato', n: p.n, total }));
};

const nuevosPct = (r: ResumenPacientes) => (r.nuevos === null ? null : ratio(r.nuevos, r.atendidos));
const citasPorPaciente = (r: ResumenPacientes) => ratio(r.atendidas, r.atendidos);

export default function PacientesComparativo() {
  const control = useComparativo();
  const { data, error, cargando } = useApi<RespuestaComparativa<DatosPacientes>>(`/api/pacientes/comparativo?${control.consulta}`, 300_000);
  return (
    <>
      <SelectorComparativo control={control} comparativo={data?.comparativo} />
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && <Resultado datos={data} />}
    </>
  );
}

function Resultado({ datos: { comparativo: c, a, b } }: { datos: RespuestaComparativa<DatosPacientes> }) {
  const ra = a.resumen;
  const rb = b.resumen;
  const porPaciente = citasPorPaciente(ra);

  const optNuevos = useCallback(
    () =>
      barrasApiladas(
        [c.a.mes, c.b.mes],
        { Nuevos: [ra.nuevos ?? 0, rb.nuevos ?? 0], Recurrentes: [ra.recurrentes ?? 0, rb.recurrentes ?? 0] },
        'month',
      ),
    [c, ra, rb],
  );

  return (
    <>
      <EncabezadoComparativo comparativo={c} />
      <AvisosComparativo comparativo={c} />
      <div className="kpis">
        <KpiComparado etiqueta="Pacientes atendidos" a={ra.atendidos} b={rb.atendidos} comparativo={c} mejorSiSube ayuda="Pacientes distintos con al menos una cita atendida en el mes." />
        <KpiComparado etiqueta="Pacientes nuevos" a={ra.nuevos} b={rb.nuevos} comparativo={c} mejorSiSube ayuda="Su primera atención registrada cae en el mes." />
        <KpiComparado etiqueta="Pacientes recurrentes" a={ra.recurrentes} b={rb.recurrentes} comparativo={c} mejorSiSube ayuda="Ya se habían atendido antes del mes." />
        <KpiComparado etiqueta="% de nuevos" a={nuevosPct(ra)} b={nuevosPct(rb)} comparativo={c} formato="pct" baseA={ra.atendidos} baseB={rb.atendidos} />
        <KpiComparado
          etiqueta="Citas atendidas por paciente"
          valor={porPaciente === null ? undefined : promedioTxt(porPaciente)}
          a={porPaciente}
          b={citasPorPaciente(rb)}
          comparativo={c}
        />
        <KpiComparado etiqueta="Con alguna inasistencia" a={ra.con_inasistencia} b={rb.con_inasistencia} comparativo={c} mejorSiSube={false} ayuda="Pacientes distintos con al menos una cita a la que no asistieron." />
      </div>
      <Tarjeta titulo="Pacientes nuevos y recurrentes" ayuda="Pacientes atendidos en cada mes, según si ya se habían atendido antes.">
        <Grafico opcion={optNuevos} alto={260} />
      </Tarjeta>
      <h3 style={{ margin: '24px 0 12px' }}>Perfil de los pacientes atendidos</h3>
      {DIMENSIONES.map(([dimension, titulo]) => {
        const filas = unirPorClave(filasPerfil(a.perfil, dimension), filasPerfil(b.perfil, dimension), (f) => f.clave, (f) => f.n);
        if (dimension === 'edad') filas.sort((x, y) => x.clave.localeCompare(y.clave));
        return (
          <Tarjeta key={dimension} titulo={titulo}>
            <TablaComparativa titulo={titulo} filas={filas} metricas={METRICAS_PERFIL} comparativo={c} nombreCsv={`comparativo_pacientes_${dimension}`} nombre={etiqueta} />
          </Tarjeta>
        );
      })}
    </>
  );
}
