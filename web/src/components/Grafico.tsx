import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, HeatmapChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  VisualMapComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TitleComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';

echarts.use([
  BarChart,
  LineChart,
  HeatmapChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  VisualMapComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TitleComponent,
  CanvasRenderer,
]);

/** Lee un token de color de :root (cambia con el modo claro/oscuro). */
export function token(nombre: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${nombre}`).trim();
}

/** Tema efectivo: el elegido por el usuario (data-theme) o, si es automático, el del sistema. */
export function temaOscuro(): boolean {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Se re-renderiza cuando cambia el tema del sistema o el elegido en el panel. */
function useEsquema() {
  const [esquema, setEsquema] = useState(temaOscuro);
  useEffect(() => {
    const fn = () => setEsquema(temaOscuro());
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', fn);
    const mo = new MutationObserver(fn);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      mq.removeEventListener('change', fn);
      mo.disconnect();
    };
  }, []);
  return esquema;
}

/** Ejes, rejilla, tooltip y leyenda recesivos, compartidos por todos los gráficos. */
export function base(): EChartsCoreOption {
  const ink2 = token('ink-2');
  const muted = token('muted');
  return {
    textStyle: { fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif', color: ink2 },
    grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
    legend: { type: 'scroll', top: 0, left: 0, right: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 12, textStyle: { color: ink2 } },
    tooltip: {
      backgroundColor: token('surface'),
      borderColor: token('border'),
      textStyle: { color: token('ink') },
      confine: true,
    },
    xAxis: {
      axisLine: { lineStyle: { color: token('axis') } },
      axisTick: { show: false },
      axisLabel: { color: muted },
      splitLine: { show: false },
    },
    yAxis: {
      axisLine: { show: false },
      axisLabel: { color: muted },
      splitLine: { lineStyle: { color: token('grid') } },
    },
  };
}

interface Props {
  /** Construye la opción en cada render, para que los colores sigan el modo claro/oscuro. */
  opcion: () => EChartsCoreOption;
  alto?: number;
}

export default function Grafico({ opcion, alto = 300 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const oscuro = useEsquema();

  useEffect(() => {
    if (!ref.current) return;
    chart.current = echarts.init(ref.current);
    const ro = new ResizeObserver(() => chart.current?.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption(opcion(), { notMerge: true });
  }, [opcion, oscuro]);

  return <div ref={ref} style={{ width: '100%', height: alto }} role="img" />;
}
