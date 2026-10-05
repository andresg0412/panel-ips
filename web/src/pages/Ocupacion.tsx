import { useCallback, useMemo } from 'react';
import { conRango, useApi, type Rango } from '../api';
import Grafico, { base, token } from '../components/Grafico';
import { barrasTasa, mapaCalor } from '../components/series';
import { Estado, ListaConteo, Tarjeta } from '../components/ui';
import { DIAS, etiqueta, fecha, fechaCorta, num, pct, tasaTxt } from '../format';
import { Restringido } from '../acceso';
import { useMarcas } from '../incidentes';

interface Ocupacion {
  desde: string;
  hasta: string;
  capacidadDesde: string;
  porProfesional: { profesional: string; especialidad: string | null; cupos: number; ocupan: number; administrativas: number; liberadas: number }[];
  porSemana: { profesional: string; semana: string; cupos: number; ocupan: number }[];
  libres: { profesional: string; especialidad: string | null; fecha: string; cupos: number; libres: number }[];
  sinEnlace: { profesional: string; especialidad: string | null }[];
}

const nombreCorto = (n: string) => n.replace(/\s+/g, ' ').split(' ').slice(0, 2).join(' ');

/** PRO-01 (ocupación) y PRO-03 (cupos libres de los próximos 14 días). */
export default function OcupacionProfesionales({ rango }: { rango: Rango }) {
  const marcas = useMarcas(rango, ['agenda']);
  const { data, error, cargando } = useApi<Ocupacion>(conRango('/api/profesionales/ocupacion', rango), 300_000);
  const sinRango = rango.hasta < (data?.capacidadDesde ?? '2026-08-06');

  const optOcupacion = useCallback(() => {
    const filas = [...data!.porProfesional].sort((a, b) => b.ocupan / b.cupos - a.ocupan / a.cupos);
    const total = filas.reduce((s, f) => s + f.cupos, 0);
    const prom = total ? filas.reduce((s, f) => s + f.ocupan, 0) / total : undefined;
    return barrasTasa(filas.map((f) => ({ nombre: nombreCorto(f.profesional), parte: f.ocupan, total: f.cupos })), 1, prom);
  }, [data]);

  const optSemanas = useCallback(() => {
    const semanas = [...new Set(data!.porSemana.map((s) => s.semana))].sort();
    const profs = [...new Set(data!.porSemana.map((s) => s.profesional))].sort();
    const celdas: [number, number, number | null, number][] = data!.porSemana.map((s) => [
      semanas.indexOf(s.semana),
      profs.indexOf(s.profesional),
      s.cupos ? s.ocupan / s.cupos : null,
      s.cupos,
    ]);
    return mapaCalor(semanas.map((s) => `Sem. ${fechaCorta(s)}`), profs.map(nombreCorto), celdas, (v) => tasaTxt(v, 0), (x, y, v, n) =>
      v === null ? `${y} · ${x}: sin cupos` : `${y} · ${x}: <b>${tasaTxt(v, 0)}</b> ocupado (${num(n)} cupos)`,
    );
  }, [data]);

  // PRO-03: cupos libres por profesional y día (próximos 14 días).
  const optLibres = useCallback(() => {
    const dias = [...new Set(data!.libres.map((l) => l.fecha))].sort();
    const profs = [...new Set(data!.libres.map((l) => l.profesional))].sort();
    const celdas: [number, number, number | null, number][] = data!.libres.map((l) => [dias.indexOf(l.fecha), profs.indexOf(l.profesional), l.libres, l.cupos]);
    const opt = mapaCalor(
      dias.map((d) => `${DIAS[new Date(`${d}T12:00:00Z`).getUTCDay() || 7].slice(0, 3)} ${fechaCorta(d)}`),
      profs.map(nombreCorto),
      celdas,
      (v) => num(Math.round(v)),
      (x, y, v, n) => `${y} · ${x}: <b>${num(v ?? 0)}</b> cupos libres de ${num(n)}`,
    ) as Record<string, any>;
    opt.series[0].label = { show: true, color: token('ink'), fontSize: 11 };
    return opt;
  }, [data]);

  const totalLibres = useMemo(() => (data?.libres ?? []).reduce((s, l) => s + l.libres, 0), [data]);

  return (
    <>
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && (
        <>
          <div className="grid g2">
            <Tarjeta
              titulo="¿Qué tan llena está la agenda?"
              marcas={[{ tipo: 'estimada' as const, detalle: 'La capacidad sale del horario vigente de cada profesional (no hay historial de horarios) y no descuenta ausencias ni festivos que falten en el sistema.' }, ...marcas]}
              ayuda={`Cupos ocupados por citas de pacientes sobre los cupos de su horario, días ya pasados${sinRango ? '' : ` del ${fecha(data.desde)} al ${fecha(data.hasta)}`}. Se puede medir desde el ${fecha(data.capacidadDesde)} y solo para profesionales con horario registrado.`}
            >
              {data.porProfesional.length ? <Grafico opcion={optOcupacion} alto={Math.max(200, data.porProfesional.length * 34)} /> : <p className="ayuda">Sin datos de ocupación para este período.</p>}
            </Tarjeta>
            <Tarjeta titulo="Ocupación por semana" ayuda="Más oscuro = agenda más llena.">
              {data.porSemana.length ? <Grafico opcion={optSemanas} alto={Math.max(200, data.porProfesional.length * 34 + 70)} /> : <p className="ayuda">Sin datos.</p>}
            </Tarjeta>
          </div>
          <Restringido clave="profesionales.capacidad" titulo="Cupos libres en los próximos 14 días">
          <Tarjeta
            titulo="Cupos libres en los próximos 14 días"
            marcas={[{ tipo: 'estimada' as const, detalle: 'La capacidad sale del horario vigente de cada profesional (no hay historial de horarios) y no descuenta ausencias ni festivos que falten en el sistema.' }]}
            ayuda={`${num(totalLibres)} cupos sin cita según el horario de cada profesional. Sirve para ofrecer citas o activar la lista de espera. Conviene validarlo con recepción.`}
          >
            {data.libres.length ? <Grafico opcion={optLibres} alto={Math.max(220, new Set(data.libres.map((l) => l.profesional)).size * 34 + 80)} /> : <p className="ayuda">Sin datos.</p>}
          </Tarjeta>
          </Restringido>
          {data.sinEnlace.length > 0 && (
            <p className="nota">
              No se puede medir la ocupación de {data.sinEnlace.map((p) => nombreCorto(p.profesional)).join(', ')}: tienen horario registrado, pero sus citas no están
              enlazadas a su ficha en el sistema (ver Agenda → Calidad de los datos).
            </p>
          )}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// AGE-09: próximas semanas y AGE-03: anticipación de las cancelaciones
// ---------------------------------------------------------------------------------------------
interface Proximas {
  filas: { semana: string; programadas: number; capacidad_medible: number; ocupan_medible: number; hace_un_ano: number }[];
}

export function AgendaProximas() {
  const { data, error, cargando } = useApi<Proximas>('/api/agenda/proximas');
  const opt = useCallback(() => {
    const b = base() as Record<string, any>;
    const f = data!.filas.filter((x) => x.programadas > 0 || x.capacidad_medible > 0);
    const etiquetas = f.map((x) => `Sem. ${fechaCorta(x.semana)}`);
    return {
      ...b,
      tooltip: { ...b.tooltip, trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v: number) => num(v) },
      xAxis: { ...b.xAxis, type: 'category', data: etiquetas },
      yAxis: { ...b.yAxis, type: 'value' },
      series: [
        { name: 'Citas ya agendadas', type: 'bar', barMaxWidth: 36, data: f.map((x) => x.programadas), itemStyle: { color: token('s1'), borderRadius: [4, 4, 0, 0] } },
        {
          name: 'Misma semana del año pasado (atendidas)',
          type: 'line',
          data: f.map((x) => x.hace_un_ano),
          symbolSize: 8,
          lineStyle: { width: 2, type: 'dashed' },
          itemStyle: { color: token('s2') },
        },
      ],
    };
  }, [data]);
  const opt2 = useCallback(() => {
    const f = data!.filas.filter((x) => x.capacidad_medible > 0);
    return barrasTasa(f.map((x) => ({ nombre: `Sem. ${fechaCorta(x.semana)}`, parte: x.ocupan_medible, total: x.capacidad_medible })), 1);
  }, [data]);

  return (
    <>
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && (
        <div className="grid g2">
          <Tarjeta
            titulo="¿Cómo viene la agenda?"
            marcas={[{ tipo: 'estimada', detalle: 'Proyección: las semanas lejanas todavía se están llenando con citas nuevas.' }]}
            ayuda="Citas de pacientes ya agendadas para las próximas semanas. Las semanas lejanas se van llenando con el tiempo: compare con la línea del año pasado con esa cautela."
          >
            <Grafico opcion={opt} alto={280} />
          </Tarjeta>
          <Tarjeta titulo="Agenda ya ocupada, por semana" ayuda="Solo profesionales con horario registrado en el sistema.">
            <Grafico opcion={opt2} alto={280} />
          </Tarjeta>
        </div>
      )}
    </>
  );
}

const TRAMOS: Record<string, string> = {
  a_menos_24h: 'Menos de 24 h antes',
  b_1_3_dias: 'Entre 1 y 3 días antes',
  c_3_dias_o_mas: '3 días o más antes',
};

export function AnticipacionCancelaciones({ rango }: { rango: Rango }) {
  const { data } = useApi<{ tramos: { clave: string; n: number }[] }>(conRango('/api/agenda/cancelaciones', rango), 300_000);
  const marcas = useMarcas(rango, ['agenda'], '2026-09-30');
  if (!data) return null;
  const medidas = data.tramos.filter((t) => t.clave !== 'sin_dato');
  const n = medidas.reduce((s, t) => s + t.n, 0);
  return (
    <Tarjeta
      titulo="¿Con cuánta anticipación cancelan?"
      marcas={marcas}
      ayuda="Solo se conoce la hora de cancelación desde el 30 sep 2026. Con 3 días o más, el cupo se puede ofrecer a la lista de espera."
    >
      {n < 50 ? (
        <p className="ayuda">Recolectando datos: {num(n)} cancelaciones con hora conocida en este período (se necesitan al menos 50 para sacar conclusiones).</p>
      ) : null}
      {n > 0 && (
        <ListaConteo items={medidas.map((t) => ({ clave: t.clave, etiqueta: TRAMOS[t.clave] ?? etiqueta(t.clave), n: t.n }))} total={n} />
      )}
      {n > 0 && <p className="nota">{pct(data.tramos.find((t) => t.clave === 'c_3_dias_o_mas')?.n ?? 0, n, 0)} de las cancelaciones llega a tiempo para recolocar el cupo.</p>}
    </Tarjeta>
  );
}
