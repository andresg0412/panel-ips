// Facturación: un mes frente a otro (mes anterior, mismo mes del año anterior o dos meses elegidos). Ventas por fecha de
// factura y recaudo por fecha de pago, con las mismas definiciones que las demás pestañas.
// Diseño: proyecto-ips/docs/features/2026-11-09-modulo-facturacion.md, sección 7.3 (pestaña 4).
import { useCallback } from 'react';
import { useApi } from '../api';
import Grafico from '../components/Grafico';
import { barrasComparadas, unirPorClave, type FilaUnida } from '../components/series';
import { Estado, Tarjeta } from '../components/ui';
import {
  AvisosComparativo, EncabezadoComparativo, KpiComparado, SelectorComparativo, TablaComparativa, type MetricaTabla,
} from '../components/comparativo';
import { useComparativo, type Comparativo, type RespuestaComparativa } from '../comparativo';
import { etiqueta, nombreMes, pesos } from '../format';
import { conEjePesos, ticketPromedio, type FilaPago, type FilaVentas, type Totales } from '../facturacion';

interface ValorDelDia {
  dia: number;
  valor: number;
}
interface DatosMes {
  facturacion: {
    totales: Totales;
    tipo: FilaVentas[];
    servicio: FilaVentas[];
    convenio: FilaVentas[];
    especialidad: FilaVentas[];
    dias: ValorDelDia[];
  };
  recaudo: { total: number; pagos: number; formaPago: FilaPago[]; dias: ValorDelDia[] };
}

const METRICAS_VENTAS: MetricaTabla<FilaVentas>[] = [
  { titulo: 'Valor de servicios', tipo: 'conteo', valor: (f) => f.valor_bruto, mejorSiSube: true },
  { titulo: 'Servicios', tipo: 'conteo', valor: (f) => f.servicios, mejorSiSube: true },
  { titulo: 'Paga el paciente', tipo: 'conteo', valor: (f) => f.copago, mejorSiSube: null, oculta: true },
  { titulo: 'A cargo del convenio', tipo: 'conteo', valor: (f) => f.total_convenio, mejorSiSube: null, oculta: true },
];
const METRICAS_PAGOS: MetricaTabla<FilaPago>[] = [
  { titulo: 'Valor recaudado', tipo: 'conteo', valor: (f) => f.valor, mejorSiSube: true },
  { titulo: 'Pagos', tipo: 'conteo', valor: (f) => f.pagos, mejorSiSube: true },
];

const pesoVentas = (f: FilaVentas) => f.valor_bruto;
const pesoPagos = (f: FilaPago) => f.valor;

/** Valor de cada día del mes, del 1 al `ultimo` (los días sin movimiento valen 0). */
const valoresPorDia = (dias: ValorDelDia[], ultimo: number) =>
  Array.from({ length: ultimo }, (_, i) => dias.find((d) => d.dia === i + 1)?.valor ?? 0);

/** Barras agrupadas por día del mes: el mes A frente al mes B. */
function barrasPorDia(c: Comparativo, a: ValorDelDia[], b: ValorDelDia[]) {
  const ultimo = Math.max(c.a.dias, c.b.dias);
  return conEjePesos(barrasComparadas(
    Array.from({ length: ultimo }, (_, i) => String(i + 1)),
    { nombre: nombreMes(c.a.mes, true), valores: valoresPorDia(a, ultimo) },
    { nombre: nombreMes(c.b.mes, true), valores: valoresPorDia(b, ultimo) },
  ));
}

export default function FacturacionComparativo({ primerMes }: { primerMes: string }) {
  const control = useComparativo(primerMes);
  const { data, error, cargando } = useApi<RespuestaComparativa<DatosMes>>(`/api/facturacion/comparativo?${control.consulta}`, 300_000);

  return (
    <>
      <SelectorComparativo control={control} comparativo={data?.comparativo} primerMes={primerMes} />
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && <Resultado datos={data} />}
    </>
  );
}

function Resultado({ datos }: { datos: RespuestaComparativa<DatosMes> }) {
  const { comparativo: c, a, b } = datos;
  const ta = a.facturacion.totales;
  const tb = b.facturacion.totales;
  const optVentasDia = useCallback(() => barrasPorDia(c, a.facturacion.dias, b.facturacion.dias), [a, b, c]);
  const optRecaudoDia = useCallback(() => barrasPorDia(c, a.recaudo.dias, b.recaudo.dias), [a, b, c]);

  const kpi = (nombre: string, valor: (t: Totales) => number | null, opciones: { dinero?: boolean; mejorSiSube?: boolean | null; ayuda?: string } = {}) => (
    <KpiComparado etiqueta={nombre} a={valor(ta)} b={valor(tb)} comparativo={c} formatear={opciones.dinero === false ? undefined : pesos} mejorSiSube={opciones.mejorSiSube ?? null} ayuda={opciones.ayuda} />
  );
  const tabla = <F,>(titulo: string, filas: FilaUnida<F>[], metricas: MetricaTabla<F>[], nombreCsv: string, nombre?: (clave: string) => string) => (
    <TablaComparativa titulo={titulo} filas={filas} metricas={metricas} comparativo={c} nombreCsv={nombreCsv} nombre={nombre} />
  );
  const nombresServicio = new Map([...a.facturacion.servicio, ...b.facturacion.servicio].map((f) => [f.codigo ?? f.nombre, `${f.codigo} · ${f.nombre}`]));

  return (
    <>
      <EncabezadoComparativo comparativo={c} />
      <AvisosComparativo comparativo={c} />
      <div className="kpis">
        {kpi('Valor de servicios', (t) => t.valor_bruto, { mejorSiSube: true, ayuda: 'Suma de valor × cantidad de los servicios facturados, sin las facturas anuladas.' })}
        {kpi('Pagado por pacientes (copagos)', (t) => t.copago)}
        {kpi('A cargo de convenios', (t) => t.total_convenio)}
        {kpi('Facturas', (t) => t.facturas, { dinero: false, mejorSiSube: true })}
        {kpi('Servicios', (t) => t.servicios, { dinero: false, mejorSiSube: true })}
        {kpi('Ticket promedio por servicio', ticketPromedio)}
        <KpiComparado etiqueta="Total recaudado" a={a.recaudo.total} b={b.recaudo.total} comparativo={c} formatear={pesos} mejorSiSube ayuda="Lo recibido en caja y bancos de los pacientes. No incluye los pagos de las EPS ni de las prepagadas." />
      </div>
      <Tarjeta titulo="Ventas por día del mes (pesos)" ayuda="Valor de servicios por fecha de factura. Los convenios se facturan a fin de mes: ese día se ve un pico.">
        <Grafico opcion={optVentasDia} alto={280} />
      </Tarjeta>
      <Tarjeta titulo="Recaudo por día del mes (pesos)">
        <Grafico opcion={optRecaudoDia} alto={280} />
      </Tarjeta>
      <Tarjeta titulo="Por tipo de servicio (pesos)">
        {tabla('Tipo de servicio', unirPorClave(a.facturacion.tipo, b.facturacion.tipo, (f) => f.nombre, pesoVentas), METRICAS_VENTAS, 'comparativo_facturacion_tipo_servicio', etiqueta)}
      </Tarjeta>
      <Tarjeta titulo="Por servicio (pesos)">
        {tabla('Servicio', unirPorClave(a.facturacion.servicio, b.facturacion.servicio, (f) => f.codigo ?? f.nombre, pesoVentas), METRICAS_VENTAS, 'comparativo_facturacion_servicio', (clave) => nombresServicio.get(clave) ?? clave)}
      </Tarjeta>
      <Tarjeta titulo="Por especialidad (pesos)">
        {tabla('Especialidad', unirPorClave(a.facturacion.especialidad, b.facturacion.especialidad, (f) => f.nombre, pesoVentas), METRICAS_VENTAS, 'comparativo_facturacion_especialidad')}
      </Tarjeta>
      <Tarjeta titulo="Por convenio (pesos)" ayuda="Los servicios particulares van aparte.">
        {tabla('Convenio', unirPorClave(a.facturacion.convenio, b.facturacion.convenio, (f) => f.nombre, pesoVentas), METRICAS_VENTAS, 'comparativo_facturacion_convenio')}
      </Tarjeta>
      <Tarjeta titulo="Por método de pago (pesos)">
        {tabla('Método de pago', unirPorClave(a.recaudo.formaPago, b.recaudo.formaPago, (f) => f.nombre, pesoPagos), METRICAS_PAGOS, 'comparativo_recaudo_metodo_pago')}
      </Tarjeta>
    </>
  );
}
