import type { EChartsCoreOption } from 'echarts/core';
import { base, token } from './Grafico';
import { fechaCorta, mesCorto, num } from '../format';

/**
 * Color fijo por entidad: el mismo estado, campaña o servicio conserva su color en todas las pantallas,
 * aunque un filtro cambie cuántas series se ven. El orden sigue la paleta validada (s1..s8).
 */
const COLOR_FIJO: Record<string, string> = {
  'Asistió': 's1',
  'Cancelada': 's2',
  'Reprogramada': 's3',
  'No asistió': 's4',
  'Programada': 's5',
  'Sin cierre': 's-other',
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
  Nuevos: 's1',
  Recurrentes: 's3',
  'Psicología': 's1',
  'Psiquiatría': 's2',
  'Neuropsicología': 's3',
  primera_vez: 's1',
  control: 's2',
  psicoterapia: 's3',
  evaluacion: 's4',
  crisis: 's5',
  rehabilitacion: 's6',
  empresarial: 's7',
  otro: 's-other',
  Otras: 's-other',
  Otro: 's-other',
};

export function colorDe(entidad: string, indice = 0): string {
  return token(COLOR_FIJO[entidad] ?? `s${(indice % 8) + 1}`);
}

export type Grano = 'day' | 'week' | 'month';

/** Período del incidente que se sombrea en un gráfico de tiempo (fechas de Bogotá, inclusive). */
export interface Sombra {
  desde: string;
  hasta: string;
  titulo: string;
}

interface Fila {
  periodo: string;
  [k: string]: unknown;
}

/** Pivotea filas largas (periodo, grupo, n) a series por grupo, en el orden de `grupos`. */
export function pivotar(filas: Fila[], campoGrupo: string, campoValor: string, grupos: string[], campoPeriodo = 'periodo') {
  const periodos = [...new Set(filas.map((f) => f[campoPeriodo] as string))].sort();
  const idx = new Map(periodos.map((p, i) => [p, i]));
  const series = Object.fromEntries(grupos.map((g) => [g, new Array(periodos.length).fill(0) as number[]]));
  for (const f of filas) {
    const g = f[campoGrupo] as string | null;
    if (g === null || g === undefined) continue;
    const destino = series[g] ?? series['Otras'] ?? series['Otro'];
    if (destino) destino[idx.get(f[campoPeriodo] as string)!] += Number(f[campoValor] ?? 0);
  }
  return { periodos, series };
}

function etiquetaPeriodo(p: string, grano: Grano): string {
  if (grano === 'month') return mesCorto(p);
  return grano === 'week' ? `Sem. ${fechaCorta(p)}` : fechaCorta(p);
}

/** Último día cubierto por un período que empieza en `p`. */
function finPeriodo(p: string, grano: Grano): string {
  const inicio = grano === 'month' ? `${p}-01` : p;
  const d = new Date(`${inicio}T00:00:00Z`);
  if (grano === 'month') d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCDate(d.getUTCDate() + (grano === 'week' ? 7 : 1));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Franjas grises sobre los períodos con incidentes (TR-01). Se agregan como markArea de la primera serie.
 * Cada franja muestra su título al pasar el cursor.
 */
function sombrear(opt: Record<string, any>, periodos: string[], grano: Grano, sombras: Sombra[] = []) {
  if (!sombras.length || !opt.series?.length) return opt;
  const etiquetas = periodos.map((p) => etiquetaPeriodo(p, grano));
  const data: unknown[] = [];
  for (const s of sombras) {
    let i0 = -1;
    let i1 = -1;
    periodos.forEach((p, i) => {
      const ini = grano === 'month' ? `${p}-01` : p;
      if (ini <= s.hasta && finPeriodo(p, grano) >= s.desde) {
        if (i0 < 0) i0 = i;
        i1 = i;
      }
    });
    if (i0 >= 0) data.push([{ xAxis: etiquetas[i0], name: s.titulo }, { xAxis: etiquetas[i1] }]);
  }
  if (!data.length) return opt;
  opt.series[0].markArea = {
    silent: false,
    itemStyle: { color: token('incidente') },
    label: { show: true, position: 'insideTop', color: token('muted'), fontSize: 11, formatter: () => 'Incidente' },
    tooltip: { formatter: (p: any) => `<b>Datos incompletos</b><br/>${p.name}` },
    data,
  };
  return opt;
}

/** Barras apiladas por período. Marcas delgadas, extremos redondeados y 1 px de separación entre segmentos. */
export function barrasApiladas(periodos: string[], series: Record<string, number[]>, grano: Grano | string, sombras?: Sombra[]): EChartsCoreOption {
  const g = grano as Grano;
  const b = base() as Record<string, any>;
  const nombres = Object.keys(series).filter((n) => series[n].some((v) => v > 0));
  const opt = {
    ...b,
    tooltip: { ...b.tooltip, trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v: number) => num(v) },
    xAxis: { ...b.xAxis, type: 'category', data: periodos.map((p) => etiquetaPeriodo(p, g)) },
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
  return sombrear(opt, periodos, g, sombras);
}

/** Líneas por período (2 px, marcadores solo al pasar el cursor). `pct` formatea el eje y el tooltip como %. */
export function lineas(
  periodos: string[],
  series: Record<string, (number | null)[]>,
  grano: Grano | string,
  sombras?: Sombra[],
  pct = false,
): EChartsCoreOption {
  const g = grano as Grano;
  const b = base() as Record<string, any>;
  const fmt = (v: number | null) => (v === null || v === undefined ? '—' : pct ? `${(v * 100).toFixed(1).replace('.', ',')} %` : num(v));
  const opt = {
    ...b,
    tooltip: { ...b.tooltip, trigger: 'axis', valueFormatter: fmt },
    xAxis: { ...b.xAxis, type: 'category', boundaryGap: false, data: periodos.map((p) => etiquetaPeriodo(p, g)) },
    yAxis: { ...b.yAxis, type: 'value', axisLabel: { ...b.yAxis.axisLabel, formatter: pct ? (v: number) => `${Math.round(v * 100)} %` : undefined } },
    series: Object.entries(series).map(([n, data], i) => ({
      name: n,
      type: 'line',
      data,
      connectNulls: false,
      showSymbol: false,
      symbolSize: 8,
      lineStyle: { width: 2 },
      itemStyle: { color: colorDe(n, i) },
    })),
  };
  return sombrear(opt, periodos, g, sombras);
}

/**
 * Pequeños múltiplos: una línea por serie, cada una en su propio panel y con su propio eje Y
 * (útil cuando una serie tiene 20 veces el volumen de otra). Mismo eje X para todas.
 */
export function pequenosMultiplos(periodos: string[], series: Record<string, (number | null)[]>, grano: Grano, sombras?: Sombra[], pct = false): EChartsCoreOption {
  const b = base() as Record<string, any>;
  const nombres = Object.keys(series);
  const n = nombres.length;
  const alto = 100 / n;
  const etiquetas = periodos.map((p) => etiquetaPeriodo(p, grano));
  const fmt = (v: number | null) => (v === null || v === undefined ? '—' : pct ? `${(v * 100).toFixed(1).replace('.', ',')} %` : num(v));
  const opt: Record<string, any> = {
    textStyle: b.textStyle,
    tooltip: { ...b.tooltip, trigger: 'axis', valueFormatter: fmt },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    title: nombres.map((nm, i) => ({
      text: nm,
      top: `${i * alto + 1}%`,
      left: 0,
      textStyle: { fontSize: 12, fontWeight: 600, color: token('ink-2') },
    })),
    grid: nombres.map((_, i) => ({ left: 48, right: 12, top: `${i * alto + 7}%`, height: `${alto - 14}%` })),
    xAxis: nombres.map((_, i) => ({
      ...b.xAxis,
      type: 'category',
      gridIndex: i,
      data: etiquetas,
      boundaryGap: false,
      axisLabel: { ...b.xAxis.axisLabel, show: i === n - 1 },
    })),
    yAxis: nombres.map((_, i) => ({
      ...b.yAxis,
      type: 'value',
      gridIndex: i,
      splitNumber: 2,
      axisLabel: { ...b.yAxis.axisLabel, formatter: pct ? (v: number) => `${Math.round(v * 100)} %` : undefined },
    })),
    series: nombres.map((nm, i) => ({
      name: nm,
      type: 'line',
      xAxisIndex: i,
      yAxisIndex: i,
      data: series[nm],
      showSymbol: false,
      lineStyle: { width: 2 },
      itemStyle: { color: colorDe(nm, i) },
    })),
  };
  // Sombra en cada panel.
  if (sombras?.length) {
    nombres.forEach((_, i) => {
      const sub = { series: [opt.series[i]] };
      sombrear(sub, periodos, grano, sombras);
      opt.series[i] = sub.series[0];
      if (opt.series[i].markArea) opt.series[i].markArea.label = { show: false };
    });
  }
  return opt;
}

/** Barras horizontales de una sola serie (ranking). Una sola serie: sin leyenda, el título la nombra. */
export function ranking(items: { nombre: string; valor: number }[], formato: (v: number) => string = num): EChartsCoreOption {
  const b = base() as Record<string, any>;
  const orden = [...items].reverse();
  return {
    ...b,
    legend: { show: false },
    grid: { ...b.grid, top: 8, right: 64 },
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

/**
 * Tasas por categoría (p. ej. inasistencia %), con el tamaño de muestra en la etiqueta.
 * Las categorías con menos de `minN` casos se muestran en gris y sin valor, para no sacar
 * conclusiones de pocos casos. Una línea marca el promedio general.
 */
export function barrasTasa(items: { nombre: string; parte: number; total: number }[], minN = 30, promedio?: number): EChartsCoreOption {
  const b = base() as Record<string, any>;
  const orden = [...items].reverse();
  const pctTxt = (v: number) => `${(v * 100).toFixed(1).replace('.', ',')} %`;
  return {
    ...b,
    legend: { show: false },
    grid: { ...b.grid, top: 8, right: 110 },
    tooltip: {
      ...b.tooltip,
      trigger: 'item',
      formatter: (p: any) => {
        const it = orden[p.dataIndex];
        return it.total < minN ? `${it.nombre}: muy pocos casos (n=${num(it.total)})` : `${it.nombre}: <b>${pctTxt(it.parte / it.total)}</b> (${num(it.parte)} de ${num(it.total)})`;
      },
    },
    xAxis: { ...b.yAxis, type: 'value', axisLabel: { show: false } },
    yAxis: { ...b.xAxis, type: 'category', data: orden.map((i) => i.nombre), axisLabel: { color: token('ink-2'), width: 150, overflow: 'truncate' } },
    series: [
      {
        type: 'bar',
        barMaxWidth: 18,
        data: orden.map((i) => ({
          value: i.total >= minN && i.total > 0 ? i.parte / i.total : 0,
          itemStyle: { color: i.total >= minN ? token('s1') : token('s-other'), borderRadius: [0, 4, 4, 0] },
        })),
        label: {
          show: true,
          position: 'right',
          color: token('ink-2'),
          formatter: (p: any) => {
            const it = orden[p.dataIndex];
            return it.total < minN ? `n=${num(it.total)} (pocos)` : `${pctTxt(it.parte / it.total)}  n=${num(it.total)}`;
          },
        },
        markLine:
          promedio === undefined
            ? undefined
            : {
                silent: true,
                symbol: 'none',
                lineStyle: { color: token('muted'), type: 'dashed' },
                label: { formatter: () => `Promedio ${pctTxt(promedio)}`, color: token('muted'), position: 'end' },
                data: [{ xAxis: promedio }],
              },
      },
    ],
  };
}

/** Mapa de calor con una rampa secuencial (azul claro → oscuro). `celdas`: [x, y, valor, n]. */
export function mapaCalor(
  xs: string[],
  ys: string[],
  celdas: [number, number, number | null, number][],
  formato: (v: number) => string,
  descripcion: (x: string, y: string, v: number | null, n: number) => string,
): EChartsCoreOption {
  const b = base() as Record<string, any>;
  const valores = celdas.map((c) => c[2]).filter((v): v is number => v !== null);
  return {
    ...b,
    legend: { show: false },
    grid: { ...b.grid, top: 8, bottom: 48 },
    tooltip: { ...b.tooltip, formatter: (p: any) => descripcion(xs[p.value[0]], ys[p.value[1]], p.value[2], p.value[3]) },
    xAxis: { ...b.xAxis, type: 'category', data: xs },
    yAxis: { ...b.yAxis, type: 'category', data: ys, splitLine: { show: false } },
    visualMap: {
      dimension: 2,
      min: valores.length ? Math.min(...valores) : 0,
      max: valores.length ? Math.max(...valores) : 1,
      calculable: false,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      itemHeight: 120,
      formatter: (v: number) => formato(v),
      inRange: { color: [token('seq-0'), token('seq-1'), token('seq-2'), token('seq-3'), token('seq-4')] },
      textStyle: { color: token('muted') },
    },
    series: [
      {
        type: 'heatmap',
        data: celdas.filter((c) => c[2] !== null),
        itemStyle: { borderColor: token('surface'), borderWidth: 2, borderRadius: 3 },
      },
    ],
  };
}

/** Embudo como barras horizontales, con el % de cada etapa sobre la anterior. */
export function embudo(etapas: { nombre: string; valor: number }[]): EChartsCoreOption {
  const b = base() as Record<string, any>;
  const orden = [...etapas].reverse();
  return {
    ...b,
    legend: { show: false },
    grid: { ...b.grid, top: 8, right: 130 },
    tooltip: { ...b.tooltip, trigger: 'item', formatter: (p: any) => `${p.name}: <b>${num(p.value)}</b>` },
    xAxis: { ...b.yAxis, type: 'value', axisLabel: { show: false } },
    yAxis: { ...b.xAxis, type: 'category', data: orden.map((e) => e.nombre), axisLabel: { color: token('ink-2'), width: 190, overflow: 'truncate' } },
    series: [
      {
        type: 'bar',
        barMaxWidth: 22,
        data: orden.map((e) => e.valor),
        itemStyle: { color: token('s1'), borderRadius: [0, 4, 4, 0] },
        label: {
          show: true,
          position: 'right',
          color: token('ink-2'),
          formatter: (p: any) => {
            const i = etapas.length - 1 - p.dataIndex;
            const prev = i > 0 ? etapas[i - 1].valor : null;
            return prev ? `${num(p.value)}  (${Math.round((p.value / prev) * 100)} %)` : num(p.value);
          },
        },
      },
    ],
  };
}
