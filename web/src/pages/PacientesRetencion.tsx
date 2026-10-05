import { useCallback, useMemo, useState } from 'react';
import { getJson, useApi } from '../api';
import Grafico, { token } from '../components/Grafico';
import { mapaCalor } from '../components/series';
import { descargarCsv, Estado, Kpi, Tarjeta, type Columna } from '../components/ui';
import { fecha, mesCorto, num, pct, tasaTxt } from '../format';
import { useAcceso } from '../acceso';

interface Ciclo {
  cohortes: { cohorte: string; k: number; n: number }[];
  estados: { clave: string; n: number }[];
}
interface EnRiesgo {
  nombre_completo: string;
  tipo_documento: string | null;
  numero_documento: string;
  telefono_norm: string | null;
  email: string | null;
  ultima: string;
  dias_sin_venir: number;
  atenciones: number;
  especialidad: string | null;
  profesional: string | null;
  administradora: string | null;
}

const COLS_RIESGO: Columna<EnRiesgo>[] = [
  { clave: 'nombre_completo', titulo: 'Paciente' },
  { clave: 'tipo_documento', titulo: 'Tipo doc.' },
  { clave: 'numero_documento', titulo: 'Documento' },
  { clave: 'telefono_norm', titulo: 'Teléfono' },
  { clave: 'email', titulo: 'Correo' },
  { clave: 'ultima', titulo: 'Última atención', formato: fecha },
  { clave: 'dias_sin_venir', titulo: 'Días sin venir', num: true },
  { clave: 'atenciones', titulo: 'Atenciones', num: true },
  { clave: 'especialidad', titulo: 'Especialidad' },
  { clave: 'profesional', titulo: 'Último profesional' },
  { clave: 'administradora', titulo: 'Convenio' },
];

const MESES_COHORTE = 7; // mes 0 (llegada) a mes 6

export default function PacientesRetencion() {
  const { data, error, cargando } = useApi<Ciclo>('/api/pacientes/ciclo');
  const [exportando, setExportando] = useState(false);

  const est = (k: string) => data?.estados.find((e) => e.clave === k)?.n ?? 0;
  const totalPac = (data?.estados ?? []).reduce((s, e) => s + e.n, 0);

  // PAC-02: % de cada cohorte (mes de llegada) que tuvo al menos una atención k meses después.
  const tabla = useMemo(() => {
    if (!data) return { cohortes: [] as string[], celdas: [] as [number, number, number | null, number][] };
    const cohortes = [...new Set(data.cohortes.map((c) => c.cohorte))].sort();
    const hoyMes = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date()).slice(0, 7);
    const celdas: [number, number, number | null, number][] = [];
    cohortes.forEach((c, y) => {
      const tam = data.cohortes.find((x) => x.cohorte === c && x.k === 0)?.n ?? 0;
      for (let k = 1; k < MESES_COHORTE; k++) {
        const [a, m] = c.split('-').map(Number);
        const mesK = new Date(Date.UTC(a, m - 1 + k, 1)).toISOString().slice(0, 7);
        if (mesK >= hoyMes) continue; // mes aún no cerrado
        const n = data.cohortes.find((x) => x.cohorte === c && x.k === k)?.n ?? 0;
        celdas.push([k - 1, cohortes.length - 1 - y, tam ? n / tam : null, tam]);
      }
    });
    // Solo cohortes con al menos un mes ya cerrado (las más recientes todavía no tienen datos).
    const conDatos = cohortes.filter((_, y) => celdas.some((c) => c[1] === cohortes.length - 1 - y));
    const reindex = celdas.map((c) => [c[0], conDatos.length - 1 - conDatos.indexOf(cohortes[cohortes.length - 1 - c[1]]), c[2], c[3]] as [number, number, number | null, number]);
    return { cohortes: conDatos, celdas: reindex };
  }, [data]);

  const optCohortes = useCallback(() => {
    const xs = Array.from({ length: MESES_COHORTE - 1 }, (_, i) => `Mes ${i + 1}`);
    const ys = [...tabla.cohortes].reverse().map((c) => {
      const tam = data!.cohortes.find((x) => x.cohorte === c && x.k === 0)?.n ?? 0;
      return `${mesCorto(c)} (${num(tam)})`;
    });
    const opt = mapaCalor(xs, ys, tabla.celdas, (v) => tasaTxt(v, 0), (x, y, v, n) =>
      v === null ? `${y} · ${x}: sin datos` : `Llegaron en ${y.split(' (')[0]}: el <b>${tasaTxt(v, 0)}</b> volvió en el ${x.toLowerCase()} (de ${num(n)})`,
    ) as Record<string, any>;
    opt.series[0].label = { show: true, color: token('ink'), fontSize: 11, formatter: (p: any) => tasaTxt(p.value[2], 0) };
    return opt;
  }, [tabla, data]);

  const { puede } = useAcceso();
  const exportar = async () => {
    setExportando(true);
    try {
      const d = await getJson<{ filas: EnRiesgo[] }>('/api/pacientes/en-riesgo');
      descargarCsv('pacientes_en_riesgo', d.filas, COLS_RIESGO);
    } finally {
      setExportando(false);
    }
  };

  return (
    <>
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && (
        <>
          <Tarjeta
            titulo="¿A quién estamos perdiendo?"
            ayuda="Pacientes atendidos desde agosto de 2025, según su última atención. Activo: volvió dentro de su ritmo habitual. En riesgo: lleva más de lo normal sin venir (hasta 4 meses). Inactivo: más de 4 meses."
            accion={
              puede('exportar.personales') ? (
                <button className="boton" disabled={exportando || est('en_riesgo') === 0} onClick={exportar}>
                  {exportando ? 'Preparando…' : 'Descargar pacientes en riesgo'}
                </button>
              ) : undefined
            }
          >
            <div className="kpis" style={{ marginBottom: 0 }}>
              <Kpi etiqueta="Activos con cita programada" actual={est('activo_con_cita')} />
              <Kpi etiqueta="Activos sin cita programada" actual={est('activo')} />
              <Kpi etiqueta="En riesgo de abandonar" actual={est('en_riesgo')} />
              <Kpi etiqueta="Inactivos (más de 4 meses)" actual={est('inactivo')} />
            </div>
            <p className="nota">
              {pct(est('en_riesgo'), totalPac, 0)} de los pacientes está en riesgo. Contactarlos a tiempo es más fácil que recuperarlos cuando ya están inactivos.
            </p>
          </Tarjeta>
          <Tarjeta
            titulo="¿Cuántos pacientes nuevos siguen viniendo?"
            ayuda="Cada fila es el mes en que llegaron los pacientes (entre paréntesis, cuántos). Cada cuadro muestra qué porcentaje tuvo al menos una atención ese mes después. Los meses de 2026 con incidente se ven más bajos."
          >
            <Grafico opcion={optCohortes} alto={Math.max(260, tabla.cohortes.length * 30 + 80)} />
          </Tarjeta>
        </>
      )}
    </>
  );
}
