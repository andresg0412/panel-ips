// Profesionales: cómo cambió cada uno entre dos meses, y su ficha comparada.
// Diseño: proyecto-ips/docs/features/2026-11-09-comparativo-periodos-panel.md, secciones 4.3 y 6.3.
import { useCallback, useState } from 'react';
import { useApi } from '../api';
import { Bloqueado, useAcceso } from '../acceso';
import Grafico from '../components/Grafico';
import { barrasComparadas, unirPorClave, type FilaUnida } from '../components/series';
import { Estado, Tarjeta, type Columna } from '../components/ui';
import {
  AvisosComparativo, EncabezadoComparativo, KpiComparado, SelectorComparativo, TablaComparativa, type MetricaTabla,
} from '../components/comparativo';
import { useComparativo, type ControlComparativo, type RespuestaComparativa } from '../comparativo';
import { etiqueta, nombreMes, ratio } from '../format';
import { realizadas } from '../metricas';

interface FilaProfesional {
  nombre: string;
  especialidad: string | null;
  total: number;
  asistio: number;
  no_asistio: number;
  no_ocurrieron: number;
  pacientes: number;
  nuevos: number;
  en_maestro: boolean;
}
interface KpisFicha {
  total: number;
  asistio: number;
  no_asistio: number;
  canceladas: number;
  reprogramadas: number;
  programadas: number;
  pacientes: number;
  virtuales: number;
}
interface DatosFicha {
  kpis: KpisFicha;
  servicios: { clave: string; n: number }[];
}

const METRICAS: MetricaTabla<FilaProfesional>[] = [
  { titulo: 'Citas', tipo: 'conteo', valor: (f) => f.total, mejorSiSube: null, oculta: true },
  { titulo: 'Atendidas', tipo: 'conteo', valor: (f) => f.asistio, mejorSiSube: true },
  { titulo: 'Asistencia a citas realizadas', tipo: 'tasa', valor: (f) => ratio(f.asistio, realizadas(f)), mejorSiSube: true, base: realizadas },
  { titulo: 'No ocurrieron %', tipo: 'tasa', valor: (f) => ratio(f.no_ocurrieron, f.total), mejorSiSube: false, base: (f) => f.total },
  { titulo: 'Pacientes atendidos', tipo: 'conteo', valor: (f) => f.pacientes, mejorSiSube: true },
  { titulo: 'Pacientes nuevos', tipo: 'conteo', valor: (f) => f.nuevos, mejorSiSube: true },
];

const COLUMNA_ESPECIALIDAD: Columna<FilaUnida<FilaProfesional>> = {
  clave: 'clave',
  titulo: 'Especialidad',
  formato: (_v, f) => (f.a ?? f.b)?.especialidad ?? '—',
  csv: (_v, f) => (f.a ?? f.b)?.especialidad ?? '',
};

export default function ProfesionalesComparativo() {
  const control = useComparativo();
  const { puede } = useAcceso();
  const [elegido, setElegido] = useState<string | null>(null);
  const { data, error, cargando } = useApi<RespuestaComparativa<{ filas: FilaProfesional[] }>>(`/api/profesionales/comparativo?${control.consulta}`, 120_000);

  const filas = data ? unirPorClave(data.a.filas, data.b.filas, (f) => f.nombre, (f) => f.total) : [];
  const sinMaestro = data ? new Set([...data.a.filas, ...data.b.filas].filter((f) => !f.en_maestro).map((f) => f.nombre)).size : 0;

  return (
    <>
      <SelectorComparativo control={control} comparativo={data?.comparativo} />
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && (
        <>
          <EncabezadoComparativo comparativo={data.comparativo} />
          <AvisosComparativo comparativo={data.comparativo} />
          <Tarjeta
            titulo="Profesionales"
            ayuda="Haga clic en un profesional para ver su ficha comparada. Estas cifras dependen del tipo de pacientes y de convenios de cada uno: sirven para conversar y planear, no como ranking de desempeño."
          >
            <TablaComparativa
              titulo="Profesional"
              filas={filas}
              metricas={METRICAS}
              comparativo={data.comparativo}
              nombreCsv="comparativo_profesionales"
              extras={[COLUMNA_ESPECIALIDAD]}
              alFila={(f) => setElegido(f.clave)}
            />
            {sinMaestro > 0 && <p className="nota">{sinMaestro} profesionales no están en el maestro de equipo del sistema; sus citas se agrupan por nombre.</p>}
          </Tarjeta>
          {elegido && !puede('profesionales.ficha') && <Bloqueado clave="profesionales.ficha" titulo={`Ficha de ${elegido}`} />}
          {elegido && puede('profesionales.ficha') && <FichaComparada nombre={elegido} control={control} />}
        </>
      )}
    </>
  );
}

function FichaComparada({ nombre, control }: { nombre: string; control: ControlComparativo }) {
  const { data, error, cargando } = useApi<RespuestaComparativa<DatosFicha> & { nombre: string }>(
    `/api/profesionales/comparativo/ficha?${control.consulta}&nombre=${encodeURIComponent(nombre)}`,
    120_000,
  );

  const optServicios = useCallback(() => {
    const { comparativo: c, a, b } = data!;
    const claves = unirPorClave(a.servicios, b.servicios, (s) => s.clave, (s) => s.n).map((s) => s.clave);
    const valores = (servicios: DatosFicha['servicios']) => claves.map((k) => servicios.find((s) => s.clave === k)?.n ?? 0);
    return barrasComparadas(
      claves.map(etiqueta),
      { nombre: nombreMes(c.a.mes, true), valores: valores(a.servicios) },
      { nombre: nombreMes(c.b.mes, true), valores: valores(b.servicios) },
    );
  }, [data]);

  return (
    <>
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && (
        <>
          <h3 style={{ margin: '24px 0 12px' }}>{data.nombre}</h3>
          <FichaKpis datos={data} />
          <Tarjeta titulo="Tipo de atención" ayuda="Citas atendidas en cada mes.">
            <Grafico opcion={optServicios} alto={260} />
          </Tarjeta>
        </>
      )}
    </>
  );
}

function FichaKpis({ datos: { comparativo: c, a, b } }: { datos: RespuestaComparativa<DatosFicha> }) {
  const ka = a.kpis;
  const kb = b.kpis;
  const noOcurrieron = (k: KpisFicha) => k.canceladas + k.reprogramadas;
  return (
    <div className="kpis">
      <KpiComparado etiqueta="Citas atendidas" a={ka.asistio} b={kb.asistio} comparativo={c} mejorSiSube />
      <KpiComparado
        etiqueta="Asistencia"
        a={ratio(ka.asistio, realizadas(ka))}
        b={ratio(kb.asistio, realizadas(kb))}
        comparativo={c}
        formato="pct"
        mejorSiSube
        baseA={realizadas(ka)}
        baseB={realizadas(kb)}
      />
      <KpiComparado
        etiqueta="Canceladas o reprogramadas"
        a={ratio(noOcurrieron(ka), ka.total)}
        b={ratio(noOcurrieron(kb), kb.total)}
        comparativo={c}
        formato="pct"
        mejorSiSube={false}
        baseA={ka.total}
        baseB={kb.total}
      />
      <KpiComparado etiqueta="Pacientes atendidos" a={ka.pacientes} b={kb.pacientes} comparativo={c} mejorSiSube />
      <KpiComparado
        etiqueta="Atenciones virtuales"
        a={ratio(ka.virtuales, ka.asistio)}
        b={ratio(kb.virtuales, kb.asistio)}
        comparativo={c}
        formato="pct"
        baseA={ka.asistio}
        baseB={kb.asistio}
      />
      <KpiComparado etiqueta="Citas programadas" a={ka.programadas} b={kb.programadas} comparativo={c} />
    </div>
  );
}
