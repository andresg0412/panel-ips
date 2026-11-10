// Facturación: lo vendido (reporte "Facturación Detalle" de Globho) y lo recibido en caja y bancos (informe "Recaudo
// Total x Cajero"), por día, servicio, convenio y método de pago, y un mes frente a otro. Las dos cifras miden cosas
// distintas y no se suman: van en pestañas separadas, cada una con su definición.
// Diseño: proyecto-ips/docs/features/2026-11-09-modulo-facturacion.md, sección 7.
import { useCallback, useState } from 'react';
import { conRango, useApi, type Rango } from '../api';
import Grafico from '../components/Grafico';
import { barrasApiladas, pivotar } from '../components/series';
import { Estado, Kpi, Tabla, Tarjeta, type Columna } from '../components/ui';
import { Bloqueado, useAcceso } from '../acceso';
import { Pestanas, usePestana } from '../incidentes';
import { etiqueta, fecha, fechaHora, num, pct, pesos } from '../format';
import {
  columnasPagos, columnasVentas, conEjePesos, sumar, ticketPromedio,
  type EjeFecha, type EstadoFacturacion, type FilaPago, type FilaVentas, type Totales,
} from '../facturacion';
import FacturacionComparativo from './FacturacionComparativo';

type Vista = 'diario' | 'desglose' | 'recaudo' | 'comparativo';

const FUNCION: Record<Vista, [string, string]> = {
  diario: ['facturacion.diario', 'Ventas por día'],
  desglose: ['facturacion.desglose', 'Servicios y convenios'],
  recaudo: ['facturacion.recaudo', 'Recaudo por método de pago'],
  comparativo: ['facturacion.comparativo', 'Comparativo de periodos'],
};

const EJES: [EjeFecha, string][] = [
  ['factura', 'Fecha de la factura'],
  ['servicio', 'Fecha del servicio'],
];

const NOTA_CONVENIOS = 'Los convenios se facturan consolidados a fin de mes: ese día se ve un pico.';
const NOTA_EJE_SERVICIO = 'Por fecha del servicio, los días más recientes pueden estar incompletos hasta que se facture.';
const EXPLICACION_RECAUDO = 'Lo recibido en caja y bancos de los pacientes (copagos y particulares). No incluye los pagos de las EPS ni de las prepagadas.';

export default function Facturacion({ rango }: { rango: Rango }) {
  const { data: estado, error, cargando } = useApi<EstadoFacturacion>('/api/facturacion/estado', 300_000);
  const [vista, setVista] = usePestana<Vista>(['diario', 'desglose', 'recaudo', 'comparativo'], 'diario');
  const [eje, setEje] = useState<EjeFecha>('factura');
  const { puede } = useAcceso();

  if (!estado) return <Estado cargando={cargando} error={error} hayDatos={false} />;
  if (estado.primerMes === null) {
    return (
      <Tarjeta titulo="Todavía no hay datos de facturación">
        <p className="vacio">La descarga diaria desde Globho aún no ha cargado información. Cuando termine su primera ejecución, las ventas y el recaudo aparecerán aquí.</p>
      </Tarjeta>
    );
  }

  const bloqueadas = (Object.keys(FUNCION) as Vista[]).filter((v) => !puede(FUNCION[v][0]));
  const abierta = (v: Vista) => vista === v && !bloqueadas.includes(v);
  return (
    <>
      <ActualizacionDatos estado={estado} />
      <Pestanas<Vista>
        bloqueadas={bloqueadas}
        opciones={[
          ['diario', '¿Cuánto vendimos?'],
          ['desglose', '¿Qué servicios y convenios?'],
          ['recaudo', '¿Cómo nos pagan?'],
          ['comparativo', '¿Cómo vamos frente a otro mes?'],
        ]}
        descripciones={{
          diario: 'Lo facturado en el período: el valor de los servicios y cómo se reparte entre el paciente y el convenio.',
          desglose: 'Qué servicios, convenios y especialidades componen lo facturado, y el detalle de cada factura.',
          recaudo: EXPLICACION_RECAUDO,
          comparativo: 'Compare lo vendido y lo recaudado de un mes contra el anterior, contra el mismo mes del año pasado o contra otro mes que elija.',
        }}
        valor={vista}
        onCambio={setVista}
      />
      {bloqueadas.includes(vista) && <Bloqueado clave={FUNCION[vista][0]} titulo={FUNCION[vista][1]} alto={280} />}
      {(abierta('diario') || abierta('desglose')) && <SelectorEje eje={eje} onCambio={setEje} />}
      {abierta('diario') && <Ventas rango={rango} eje={eje} />}
      {abierta('desglose') && <Desglose rango={rango} eje={eje} />}
      {abierta('recaudo') && <Recaudo rango={rango} />}
      {abierta('comparativo') && <FacturacionComparativo primerMes={estado.primerMes} />}
    </>
  );
}

/** "Datos de Globho actualizados al 8 nov 2026 (descarga del 9 nov 2026, 05:16)". Los avisos de falla van a Soporte, no aquí. */
function ActualizacionDatos({ estado }: { estado: EstadoFacturacion }) {
  const partes = estado.reportes
    .filter((r) => r.ok_hasta)
    .map((r) => `${r.reporte === 'recaudo' ? 'Recaudo' : 'Facturación'}: al ${fecha(r.ok_hasta)} (descarga del ${fechaHora(r.ok_recibida_at)})`);
  return <p className="nota">Datos de Globho actualizados — {partes.length ? partes.join(' · ') : 'sin ninguna descarga correcta todavía'}.</p>;
}

function SelectorEje({ eje, onCambio }: { eje: EjeFecha; onCambio: (e: EjeFecha) => void }) {
  return (
    <div className="rango" role="group" aria-label="Fecha por la que se cuenta">
      {EJES.map(([clave, texto]) => (
        <button key={clave} className={eje === clave ? 'activo' : ''} aria-pressed={eje === clave} onClick={() => onCambio(clave)}>
          {texto}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ ¿cuánto vendimos?
interface FilaDia {
  periodo: string;
  particular: number;
  convenio: number;
  valor_bruto: number;
  copago: number;
  total_convenio: number;
  facturas: number;
  servicios: number;
}
interface DatosVentas {
  rango: { grano: 'day' | 'week' };
  totales: Totales;
  anterior: Totales | null;
  serie: FilaDia[];
}

const columnasDia = (grano: 'day' | 'week'): Columna<FilaDia>[] => [
  { clave: 'periodo', titulo: grano === 'week' ? 'Semana desde' : 'Día', formato: fecha, csv: String },
  { clave: 'valor_bruto', titulo: 'Valor de servicios', num: true, formato: pesos },
  { clave: 'particular', titulo: 'Particular', num: true, formato: pesos },
  { clave: 'convenio', titulo: 'Con convenio', num: true, formato: pesos },
  { clave: 'copago', titulo: 'Paga el paciente', num: true, formato: pesos },
  { clave: 'total_convenio', titulo: 'A cargo del convenio', num: true, formato: pesos },
  { clave: 'facturas', titulo: 'Facturas', num: true },
  { clave: 'servicios', titulo: 'Servicios', num: true },
];

function Ventas({ rango, eje }: { rango: Rango; eje: EjeFecha }) {
  const { data, error, cargando } = useApi<DatosVentas>(conRango('/api/facturacion', rango, { eje }), 300_000);
  const optSerie = useCallback(
    () => conEjePesos(barrasApiladas(
      data!.serie.map((f) => f.periodo),
      { Particular: data!.serie.map((f) => f.particular), 'Con convenio': data!.serie.map((f) => f.convenio) },
      data!.rango.grano,
    )),
    [data],
  );

  const t = data?.totales;
  const p = data?.anterior ?? undefined;
  const kpi = (nombre: string, valor: (x: Totales) => number | null, opciones: { dinero?: boolean; mejorSiSube?: boolean | null; ayuda?: string } = {}) => (
    <Kpi
      etiqueta={nombre}
      actual={valor(t!)}
      anterior={p ? valor(p) : undefined}
      formatear={opciones.dinero === false ? num : pesos}
      mejorSiSube={opciones.mejorSiSube ?? null}
      ayuda={opciones.ayuda}
    />
  );
  return (
    <>
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && t && (
        <>
          <div className="kpis">
            {kpi('Valor de servicios', (x) => x.valor_bruto, { mejorSiSube: true, ayuda: 'Suma de valor × cantidad de los servicios facturados en el período. No cuenta las facturas anuladas.' })}
            {kpi('Pagado por pacientes (copagos)', (x) => x.copago, { ayuda: 'Lo que paga el paciente: el copago cuando hay convenio, o todo el valor si es particular.' })}
            {kpi('A cargo de convenios', (x) => x.total_convenio, { ayuda: 'Lo que la IPS cobra después a cada EPS o prepagada (cartera).' })}
            {kpi('Facturas', (x) => x.facturas, { dinero: false, mejorSiSube: true, ayuda: 'Facturas distintas, sin las anuladas.' })}
            {kpi('Servicios', (x) => x.servicios, { dinero: false, mejorSiSube: true, ayuda: 'Suma de la cantidad de cada línea facturada.' })}
            {kpi('Ticket promedio por servicio', ticketPromedio, { ayuda: 'Valor de servicios ÷ servicios.' })}
          </div>
          <Tarjeta titulo={`Ventas por ${data.rango.grano === 'week' ? 'semana' : 'día'} (pesos)`} ayuda={NOTA_CONVENIOS}>
            <Grafico opcion={optSerie} />
            <p className="nota">{NOTA_CONVENIOS}{eje === 'servicio' && ` ${NOTA_EJE_SERVICIO}`}</p>
          </Tarjeta>
          <Tarjeta titulo={data.rango.grano === 'week' ? 'Detalle por semana' : 'Detalle por día'}>
            <Tabla filas={data.serie} columnas={columnasDia(data.rango.grano)} nombreCsv={`facturacion_${data.rango.grano === 'week' ? 'semanal' : 'diaria'}_${rango.desde}_${rango.hasta}`} />
          </Tarjeta>
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------------------------------------ ¿qué servicios y convenios?
interface DatosDesglose {
  tipo: FilaVentas[];
  servicio: FilaVentas[];
  convenio: FilaVentas[];
  especialidad: FilaVentas[];
  facturador: FilaVentas[];
}

interface Factura {
  numero_factura: string;
  fecha_factura: string;
  convenio_nombre: string;
  anulada: boolean;
  pacientes: number;
  nombre_paciente: string | null;
  documento_paciente: string | null;
  servicios: number;
  valor_bruto: number;
}
interface DatosFacturas {
  total: number;
  filas: Factura[];
}

const FACTURAS_POR_PAGINA = 50;

const textoPaciente = (f: Factura) => f.nombre_paciente ?? (f.pacientes > 1 ? `${num(f.pacientes)} pacientes` : '—');

const COLUMNAS_FACTURA: Columna<Factura>[] = [
  { clave: 'numero_factura', titulo: 'Factura' },
  { clave: 'fecha_factura', titulo: 'Fecha', formato: fecha, csv: String },
  { clave: 'convenio_nombre', titulo: 'Convenio' },
  { clave: 'nombre_paciente', titulo: 'Paciente', formato: (_v, f) => textoPaciente(f), csv: (_v, f) => textoPaciente(f) },
  { clave: 'documento_paciente', titulo: 'Documento', formato: (v) => v ?? '—', csv: (v) => v ?? '' },
  { clave: 'servicios', titulo: 'Servicios', num: true },
  { clave: 'valor_bruto', titulo: 'Valor de servicios', num: true, formato: pesos },
  { clave: 'anulada', titulo: 'Anulada', formato: (v) => (v ? 'Sí' : 'No'), csv: (v) => (v ? 'Sí' : 'No') },
];

function Desglose({ rango, eje }: { rango: Rango; eje: EjeFecha }) {
  const { data, error, cargando } = useApi<DatosDesglose>(conRango('/api/facturacion/desglose', rango, { eje }), 300_000);

  const totalConvenio = data ? sumar(data.convenio.filter((f) => !f.es_particular), (f) => f.valor_bruto) : 0;
  const totalParticular = data ? sumar(data.convenio.filter((f) => f.es_particular), (f) => f.valor_bruto) : 0;
  const total = totalConvenio + totalParticular;
  const tipoServicio = (f: FilaVentas) => etiqueta(f.nombre);
  const servicio = (f: FilaVentas) => `${f.codigo} · ${f.nombre}`;

  return (
    <>
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && (
        <>
          <div className="kpis">
            <Kpi etiqueta="Particular" actual={totalParticular} valor={pesos(totalParticular)} sinComparacion={`${pct(totalParticular, total)} del valor de servicios`} />
            <Kpi etiqueta="Con convenio" actual={totalConvenio} valor={pesos(totalConvenio)} sinComparacion={`${pct(totalConvenio, total)} del valor de servicios`} />
          </div>
          <Tarjeta titulo="Por tipo de servicio">
            <Tabla filas={data.tipo} columnas={columnasVentas('Tipo de servicio', data.tipo, tipoServicio)} nombreCsv="facturacion_tipo_servicio" />
          </Tarjeta>
          <Tarjeta titulo="Por servicio" ayuda="Cada servicio es un código del catálogo; el nombre es el más usado para ese código.">
            <Tabla filas={data.servicio} columnas={columnasVentas('Servicio', data.servicio, servicio)} nombreCsv="facturacion_servicio" />
          </Tarjeta>
          <Tarjeta titulo="Por especialidad">
            <Tabla filas={data.especialidad} columnas={columnasVentas('Especialidad', data.especialidad)} nombreCsv="facturacion_especialidad" />
          </Tarjeta>
          <Tarjeta titulo="Por convenio" ayuda="Los servicios particulares van aparte. Cuando hay convenio, el paciente paga el copago y el convenio el resto.">
            <Tabla filas={data.convenio} columnas={columnasVentas('Convenio', data.convenio)} nombreCsv="facturacion_convenio" />
          </Tarjeta>
          <Tarjeta titulo="Facturado por" ayuda="Persona de recepción que hizo la factura. Es información operativa, no un ranking de desempeño.">
            <Tabla filas={data.facturador} columnas={columnasVentas('Facturado por', data.facturador)} nombreCsv="facturacion_facturador" />
          </Tarjeta>
          <Facturas key={`${rango.desde}|${rango.hasta}|${eje}`} rango={rango} eje={eje} />
        </>
      )}
    </>
  );
}

/** Detalle de las facturas del período, de a 50. Las anuladas aparecen marcadas. */
function Facturas({ rango, eje }: { rango: Rango; eje: EjeFecha }) {
  const [pagina, setPagina] = useState(1);
  const { data, error, cargando } = useApi<DatosFacturas>(conRango('/api/facturacion/facturas', rango, { eje, pagina, tam: FACTURAS_POR_PAGINA }), 300_000);
  const paginas = Math.max(1, Math.ceil((data?.total ?? 0) / FACTURAS_POR_PAGINA));

  return (
    <Tarjeta titulo="Facturas del período" ayuda="Una factura de convenio reúne a varios pacientes: solo se nombra al paciente cuando la factura tiene uno. El documento se enmascara según sus permisos.">
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && (
        <>
          <Tabla filas={data.filas} columnas={COLUMNAS_FACTURA} nombreCsv={`facturacion_facturas_${rango.desde}_${rango.hasta}_pagina_${pagina}`} vacio="Sin facturas en este período" />
          <div className="filtros" style={{ justifyContent: 'space-between' }}>
            <span>{num(data.total)} facturas · página {pagina} de {paginas}</span>
            <span>
              <button className="boton" disabled={pagina <= 1} onClick={() => setPagina((p) => p - 1)}>Anterior</button>{' '}
              <button className="boton" disabled={pagina >= paginas} onClick={() => setPagina((p) => p + 1)}>Siguiente</button>
            </span>
          </div>
        </>
      )}
    </Tarjeta>
  );
}

// ------------------------------------------------------------------------------------------------ ¿cómo nos pagan?
interface DatosRecaudo {
  rango: { grano: 'day' | 'week' };
  totales: { total: number; pagos: number };
  anterior: { total: number; pagos: number } | null;
  anulados: number;
  serie: { periodo: string; grupo: string; n: number }[];
  formaPago: FilaPago[];
  cajaBanco: FilaPago[];
  cajero: FilaPago[];
  regimen: FilaPago[];
}

function Recaudo({ rango }: { rango: Rango }) {
  const { data, error, cargando } = useApi<DatosRecaudo>(conRango('/api/facturacion/recaudo', rango), 300_000);
  // Lo facturado a cargo de pacientes, al lado de lo recaudado: no se fuerzan a cuadrar (ver la nota de la tarjeta).
  const { data: ventas } = useApi<{ totales: Totales }>(conRango('/api/facturacion', rango), 300_000);

  const optSerie = useCallback(() => {
    const { periodos, series } = pivotar(data!.serie, 'grupo', 'n', data!.formaPago.map((f) => f.nombre));
    return conEjePesos(barrasApiladas(periodos, series, data!.rango.grano));
  }, [data]);

  return (
    <>
      <Estado cargando={cargando} error={error} hayDatos={!!data} />
      {data && (
        <>
          <div className="kpis">
            <Kpi etiqueta="Total recaudado" actual={data.totales.total} anterior={data.anterior?.total} formatear={pesos} mejorSiSube ayuda={EXPLICACION_RECAUDO} />
            <Kpi etiqueta="Pagos recibidos" actual={data.totales.pagos} anterior={data.anterior?.pagos} mejorSiSube={null} ayuda="Cantidad de pagos, sin los anulados." />
            {data.formaPago.map((f) => (
              <Kpi key={f.nombre} etiqueta={f.nombre} actual={f.valor} valor={pesos(f.valor)} sinComparacion={`${num(f.pagos)} pagos · ${pct(f.valor, data.totales.total)}`} />
            ))}
            {ventas && <Kpi etiqueta="Facturado a cargo de pacientes" actual={ventas.totales.copago} valor={pesos(ventas.totales.copago)} sinComparacion="copagos y servicios particulares" />}
          </div>
          <p className="nota">
            {EXPLICACION_RECAUDO} No tiene por qué coincidir con "Facturado a cargo de pacientes": a veces se cobra en un día distinto al de la factura, hay abonos y paquetes, y algunos pagos no pertenecen a una factura identificada.
            {data.anulados > 0 && ` ${num(data.anulados)} pagos anulados no se cuentan.`}
          </p>
          <Tarjeta titulo={`Recaudo por ${data.rango.grano === 'week' ? 'semana' : 'día'} y método de pago (pesos)`}>
            <Grafico opcion={optSerie} />
          </Tarjeta>
          <Tarjeta titulo="Por método de pago">
            <Tabla filas={data.formaPago} columnas={columnasPagos('Método de pago', data.formaPago)} nombreCsv="recaudo_metodo_pago" />
          </Tarjeta>
          <Tarjeta titulo="Por caja o banco" ayuda="Una parte del efectivo se registra en una cuenta bancaria, por eso no coincide exactamente con el método de pago.">
            <Tabla filas={data.cajaBanco} columnas={columnasPagos('Caja o banco', data.cajaBanco)} nombreCsv="recaudo_caja_banco" />
          </Tarjeta>
          <Tarjeta titulo="Por cajero" ayuda="Persona del personal que recibió el pago.">
            <Tabla filas={data.cajero} columnas={columnasPagos('Cajero', data.cajero)} nombreCsv="recaudo_cajero" />
          </Tarjeta>
          <Tarjeta titulo="Por régimen">
            <Tabla filas={data.regimen} columnas={columnasPagos('Régimen', data.regimen)} nombreCsv="recaudo_regimen" />
          </Tarjeta>
        </>
      )}
    </>
  );
}
