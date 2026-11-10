// Tipos de lo que responde /api/facturacion/* (server/routes/facturacion.ts) y las cuentas que comparten las vistas.
// Diseño: proyecto-ips/docs/features/2026-11-09-modulo-facturacion.md, sección 7.
import type { EChartsCoreOption } from 'echarts/core';
import type { Columna } from './components/ui';
import { pct, pesos } from './format';

export type EjeFecha = 'factura' | 'servicio';

export interface EstadoReporte {
  reporte: 'facturacion' | 'recaudo';
  /** Resultado de la última ejecución, correcta o no. */
  estado: 'ok' | 'sospechosa' | 'error';
  ok_hasta: string | null;
  ok_recibida_at: string | null;
}

export interface EstadoFacturacion {
  /** Primer mes con facturación cargada ('AAAA-MM'); null si todavía no hay datos. */
  primerMes: string | null;
  reportes: EstadoReporte[];
}

/** Lo vendido en un período (FAC-01 a FAC-04). */
export interface Totales {
  valor_bruto: number;
  copago: number;
  total_convenio: number;
  facturas: number;
  servicios: number;
  pacientes: number;
}

/** Ticket promedio por servicio (FAC-04): valor de servicios ÷ servicios. */
export const ticketPromedio = (t: Totales) => (t.servicios ? t.valor_bruto / t.servicios : null);

/** Una fila de ventas agrupada por tipo, servicio, convenio, especialidad o facturador. */
export interface FilaVentas {
  nombre: string;
  /** Solo por servicio: el código del catálogo. */
  codigo?: string;
  tipo?: string;
  /** Solo por convenio. */
  es_particular?: boolean;
  facturas: number;
  servicios: number;
  valor_bruto: number;
  copago: number;
  total_convenio: number;
}

/** Una fila del recaudo agrupado por método de pago, caja o banco, cajero o régimen. */
export interface FilaPago {
  nombre: string;
  pagos: number;
  valor: number;
}

/** Importe corto para el eje de un gráfico: 40 M, 1,5 M, 500 mil. */
export const pesosCortos = (v: number) => {
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toLocaleString('es-CO', { maximumFractionDigits: 1 })} M`;
  return Math.abs(v) >= 1_000 ? `${Math.round(v / 1_000).toLocaleString('es-CO')} mil` : String(v);
};

/** Un gráfico de barras en pesos: el eje en importes cortos y el detalle al pasar el cursor, completo. */
export function conEjePesos(opcion: EChartsCoreOption): EChartsCoreOption {
  const o = opcion as Record<string, any>;
  return {
    ...o,
    yAxis: { ...o.yAxis, axisLabel: { ...o.yAxis?.axisLabel, formatter: pesosCortos } },
    tooltip: { ...o.tooltip, valueFormatter: (v: number) => pesos(v) },
  };
}

/** Suma de una columna numérica de las filas. */
export const sumar = <T>(filas: T[], valor: (f: T) => number) => filas.reduce((total, f) => total + valor(f), 0);

/** Columnas de una tabla de ventas por grupo: servicios, facturas, valor, su peso en el total y el reparto entre paciente y convenio. */
export const columnasVentas = (titulo: string, filas: FilaVentas[], nombre: (f: FilaVentas) => string = (f) => f.nombre): Columna<FilaVentas>[] => {
  const total = sumar(filas, (f) => f.valor_bruto);
  return [
    { clave: 'nombre', titulo, formato: (_v, f) => nombre(f), csv: (_v, f) => nombre(f) },
    { clave: 'servicios', titulo: 'Servicios', num: true },
    { clave: 'facturas', titulo: 'Facturas', num: true },
    { clave: 'valor_bruto', titulo: 'Valor de servicios', num: true, formato: pesos },
    { clave: 'valor_bruto', titulo: '% del total', num: true, formato: (v) => pct(v, total), csv: (v) => pct(v, total), orden: (f) => f.valor_bruto },
    { clave: 'copago', titulo: 'Paga el paciente', num: true, formato: pesos },
    { clave: 'total_convenio', titulo: 'A cargo del convenio', num: true, formato: pesos },
  ];
};

/** Columnas de una tabla del recaudo: pagos, valor y su peso en el total. */
export const columnasPagos = (titulo: string, filas: FilaPago[]): Columna<FilaPago>[] => {
  const total = sumar(filas, (f) => f.valor);
  return [
    { clave: 'nombre', titulo },
    { clave: 'pagos', titulo: 'Pagos', num: true },
    { clave: 'valor', titulo: 'Valor recaudado', num: true, formato: pesos },
    { clave: 'valor', titulo: '% del total', num: true, formato: (v) => pct(v, total), csv: (v) => pct(v, total), orden: (f) => f.valor },
  ];
};
