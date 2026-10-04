import type { EChartsCoreOption } from 'echarts/core';
import { base, token } from './Grafico';
import { fechaCorta, num } from '../format';

/**
 * Color fijo por entidad: el mismo estado o campaña conserva su color en todas las pantallas,
 * aunque un filtro cambie cuántas series se ven. Los huecos del orden validado se dejan a propósito.
 */
const COLOR_FIJO: Record<string, string> = {
  'Asistió': 's1',
  'Cancelada': 's2',
  'Reprogramada': 's3',
  'No asistió': 's4',
  'Programada': 's5',
  execute: 's1',
  reminder: 's2',
  daily: 's3',
  recuperacion: 's4',
  conasistencia: 's5',
  Enviados: 's1',
  Respondieron: 's3',
  Fallidos: 's8',
  Completadas: 's1',
  Abandonadas: 's2',
  Otras: 's-other',
  Otro: 's-other',
};

export function colorDe(entidad: string, indice = 0): string {
  return token(COLOR_FIJO[entidad] ?? `s${(indice % 8) + 1}`);
}

interface Fila {
  periodo: string;
  [k: string]: unknown;
}

/** Pivotea filas largas (periodo, grupo, n) a series por grupo, en el orden de `grupos`. */
export function pivotar(filas: Fila[], campoGrupo: string, campoValor: string, grupos: string[]) {
  const periodos = [...new Set(filas.map((f) => f.periodo))].sort();
  const idx = new Map(periodos.map((p, i) => [p, i]));
  const series = Object.fromEntries(grupos.map((g) => [g, new Array(periodos.length).fill(0) as number[]]));
  for (const f of filas) {
    const g = f[campoGrupo] as string | null;
    if (g === null || g === undefined) continue;
    const destino = series[g] ?? series['Otras'] ?? series['Otro'];
    if (destino) destino[idx.get(f.periodo)!] += Number(f[campoValor] ?? 0);
  }
  return { periodos, series };
}

/** Barras apiladas por período. Marcas delgadas, extremos redondeados y 1 px de separación entre segmentos. */
export function barrasApiladas(periodos: string[], series: Record<string, number[]>, grano: string): EChartsCoreOption {
  const b = base() as Record<string, any>;
  const nombres = Object.keys(series).filter((n) => series[n].some((v) => v > 0));
  return {
    ...b,
    tooltip: { ...b.tooltip, trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v: number) => num(v) },
    xAxis: { ...b.xAxis, type: 'category', data: periodos.map((p) => (grano === 'week' ? `Sem. ${fechaCorta(p)}` : fechaCorta(p))) },
    yAxis: { ...b.yAxis, type: 'value' },
    series: nombres.map((n, i) => ({
      name: n,
      type: 'bar',
      stack: 'total',
      barMaxWidth: 28,
      data: series[n],
      itemStyle: {
        color: colorDe(n, i),
        borderColor: token('surface'),
        borderWidth: 1,
        borderRadius: i === nombres.length - 1 ? [4, 4, 0, 0] : 0,
      },
      emphasis: { focus: 'series' },
    })),
  };
}

/** Líneas por período (2 px, marcadores solo al pasar el cursor). */
export function lineas(periodos: string[], series: Record<string, number[]>, grano: string): EChartsCoreOption {
  const b = base() as Record<string, any>;
  return {
    ...b,
    tooltip: { ...b.tooltip, trigger: 'axis', valueFormatter: (v: number) => num(v) },
    xAxis: { ...b.xAxis, type: 'category', boundaryGap: false, data: periodos.map((p) => (grano === 'week' ? `Sem. ${fechaCorta(p)}` : fechaCorta(p))) },
    yAxis: { ...b.yAxis, type: 'value' },
    series: Object.entries(series).map(([n, data], i) => ({
      name: n,
      type: 'line',
      data,
      showSymbol: false,
      symbolSize: 8,
      lineStyle: { width: 2 },
      itemStyle: { color: colorDe(n, i) },
    })),
  };
}

/** Barras horizontales de una sola serie (ranking). Una sola serie: sin leyenda, el título la nombra. */
export function ranking(items: { nombre: string; valor: number }[], formato: (v: number) => string = num): EChartsCoreOption {
  const b = base() as Record<string, any>;
  const orden = [...items].reverse();
  return {
    ...b,
    legend: { show: false },
    grid: { ...b.grid, top: 8, right: 56 },
    tooltip: { ...b.tooltip, trigger: 'item', formatter: (p: any) => `${p.name}: <b>${formato(p.value)}</b>` },
    xAxis: { ...b.yAxis, type: 'value', axisLabel: { show: false } },
    yAxis: { ...b.xAxis, type: 'category', data: orden.map((i) => i.nombre), axisLabel: { color: token('ink-2'), width: 170, overflow: 'truncate' } },
    series: [
      {
        type: 'bar',
        barMaxWidth: 18,
        data: orden.map((i) => i.valor),
        itemStyle: { color: token('s1'), borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: 'right', color: token('ink-2'), formatter: (p: any) => formato(p.value) },
      },
    ],
  };
}
