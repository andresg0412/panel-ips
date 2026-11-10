// Facturación: ventas por día, servicio, convenio y especialidad (reporte "Facturación Detalle" de Globho) y recaudo por
// método de pago, caja o banco y cajero (informe "Recaudo Total x Cajero"). Lee solo las vistas bi.fact_facturacion y
// bi.fact_recaudo que alimenta el scraper; las anuladas nunca cuentan en los totales.
// Diseño: proyecto-ips/docs/features/2026-11-09-modulo-facturacion.md, secciones 2.4, 2.5 y 7.
import type { FastifyInstance } from 'fastify';
import { query, queryOne } from '../db.js';
import { conCache } from '../cache.js';
import { claveCache } from '../acceso.js';
import { ErrorParametro, hoyBogota, leerPagina, leerRango, type Rango } from '../params.js';
import { resolverComparativo, ttlComparativo } from '../comparativo.js';
import { catalogoNormalizado, especialidadDeCatalogo, periodo, tipoServicio } from '../sql.js';

/** Los datos cambian una vez al día (descarga de la madrugada): no hace falta recalcular a cada visita. */
const TTL_MS = 300_000;

/** Fecha por la que se corta el período: la de la factura (por defecto) o la del servicio. Nunca viene del usuario tal cual. */
const EJES = { factura: 'fecha_factura', servicio: 'fecha_servicio' } as const;
type Eje = keyof typeof EJES;

function leerEje(q: Record<string, unknown>): Eje {
  if (q.eje === undefined || q.eje === '') return 'factura';
  if (q.eje !== 'factura' && q.eje !== 'servicio') throw new ErrorParametro('Eje de fecha inválido: use factura o servicio');
  return q.eje;
}

const CATALOGO = catalogoNormalizado('catalogo');

/**
 * Cuánto paga el paciente y cuánto el convenio (FAC-02 y FAC-03). Globho reparte cada línea en `Copago` y `Total`; en un
 * servicio particular no hay convenio: viene `Copago = 0` y todo el valor en `Total`, que paga el paciente.
 */
const PAGA_PACIENTE = `CASE WHEN es_particular THEN copago + total_convenio ELSE copago END`;
const A_CARGO_CONVENIO = `CASE WHEN es_particular THEN 0 ELSE total_convenio END`;

/** Lo que se suma en cada agrupación. El valor de servicios (FAC-01) es el KPI principal; el resto lo reparte. */
const MEDIDAS = `
  count(DISTINCT numero_factura) AS facturas,
  coalesce(sum(cantidad), 0) AS servicios,
  coalesce(sum(valor_bruto), 0) AS valor_bruto,
  coalesce(sum(${PAGA_PACIENTE}), 0) AS copago,
  coalesce(sum(${A_CARGO_CONVENIO}), 0) AS total_convenio`;

const EN_PERIODO = (columna: string) => `NOT anulada AND ${columna} BETWEEN $1 AND $2`;

/**
 * Agrupaciones de lo facturado. Las comparten el desglose del período y el comparativo de dos meses, para que una misma
 * definición dé las mismas cifras en las dos pantallas.
 */
const GRUPOS = {
  tipo: { columnas: `${tipoServicio(CATALOGO)} AS nombre`, agrupar: '1' },
  especialidad: { columnas: `${especialidadDeCatalogo(CATALOGO)} AS nombre`, agrupar: '1' },
  // El código del convenio no es único entre entidades: se agrupa por nombre. El particular queda aparte.
  convenio: { columnas: 'convenio_nombre AS nombre, es_particular', agrupar: '1, 2' },
  facturador: { columnas: `coalesce(facturador, 'Sin dato') AS nombre`, agrupar: '1' },
  // Un servicio es un código de catálogo; su nombre es el texto más frecuente (varía en tildes y espacios).
  servicio: {
    columnas: `coalesce(codigo_catalogo, '(sin código)') AS codigo, mode() WITHIN GROUP (ORDER BY catalogo) AS nombre, max(${tipoServicio(CATALOGO)}) AS tipo`,
    agrupar: '1',
  },
} as const;

function agrupar(clave: keyof typeof GRUPOS, columnaFecha: string, desde: string, hasta: string) {
  const g = GRUPOS[clave];
  return query(
    `SELECT ${g.columnas}, ${MEDIDAS}
       FROM bi.fact_facturacion WHERE ${EN_PERIODO(columnaFecha)}
      GROUP BY ${g.agrupar} ORDER BY valor_bruto DESC`,
    [desde, hasta],
  );
}

interface TotalesFacturacion {
  valor_bruto: number;
  copago: number;
  total_convenio: number;
  facturas: number;
  servicios: number;
  pacientes: number;
}

/** FAC-01 a FAC-04: lo vendido en el período, repartido entre el paciente (copago) y el convenio. */
const totalesFacturacion = (columnaFecha: string, desde: string, hasta: string) =>
  queryOne<TotalesFacturacion>(
    `SELECT ${MEDIDAS}, count(DISTINCT documento_paciente) AS pacientes
       FROM bi.fact_facturacion WHERE ${EN_PERIODO(columnaFecha)}`,
    [desde, hasta],
  );

const EN_PERIODO_RECAUDO = 'NOT anulado AND fecha_pago BETWEEN $1 AND $2';

const totalesRecaudo = (desde: string, hasta: string) =>
  queryOne<{ total: number; pagos: number }>(
    `SELECT coalesce(sum(valor), 0) AS total, count(*) AS pagos FROM bi.fact_recaudo WHERE ${EN_PERIODO_RECAUDO}`,
    [desde, hasta],
  );

/** Dimensiones del recaudo (FAC-06). Los nombres de columna son fijos: nunca se arman con texto del usuario. */
const DIMENSIONES_RECAUDO = { formaPago: 'forma_pago', cajaBanco: 'caja_banco', cajero: 'cajero', regimen: 'regimen' } as const;

function recaudoPor(dimension: keyof typeof DIMENSIONES_RECAUDO, desde: string, hasta: string) {
  const columna = DIMENSIONES_RECAUDO[dimension];
  return query(
    `SELECT coalesce(nullif(${columna}, ''), 'Sin dato') AS nombre, count(*) AS pagos, coalesce(sum(valor), 0) AS valor
       FROM bi.fact_recaudo WHERE ${EN_PERIODO_RECAUDO}
      GROUP BY 1 ORDER BY valor DESC`,
    [desde, hasta],
  );
}

/** Primer mes con facturación cargada ('AAAA-MM'), o null si todavía no hay datos. */
const primerMesFacturacion = () =>
  conCache(
    'facturacion:primer-mes',
    async () => (await queryOne<{ mes: string | null }>(`SELECT to_char(min(fecha_factura), 'YYYY-MM') AS mes FROM bi.fact_facturacion`)).mes,
    TTL_MS,
  );

/** Período anterior de la misma duración, solo si ya había datos cargados entonces (para las flechas de los indicadores). */
const hayPeriodoAnterior = (r: Rango, primerMes: string | null) => primerMes !== null && r.prevDesde >= `${primerMes}-01`;

/** Un período anterior sin ninguna factura o pago es un período sin datos cargados, no un "0": no se compara. */
const conDatos = <T extends { facturas?: number; pagos?: number }>(totales: T | null) => (totales && (totales.facturas || totales.pagos) ? totales : null);

/** Ventas por día (o por semana si el rango es largo), partidas entre particular y convenio. */
function serieVentas(columnaFecha: string, r: Rango) {
  return query(
    `SELECT ${periodo('g.dia')} AS periodo,
            coalesce(sum(f.valor_bruto) FILTER (WHERE f.es_particular), 0) AS particular,
            coalesce(sum(f.valor_bruto) FILTER (WHERE NOT f.es_particular), 0) AS convenio,
            coalesce(sum(f.valor_bruto), 0) AS valor_bruto,
            coalesce(sum(CASE WHEN f.es_particular THEN f.copago + f.total_convenio ELSE f.copago END), 0) AS copago,
            coalesce(sum(CASE WHEN f.es_particular THEN 0 ELSE f.total_convenio END), 0) AS total_convenio,
            count(DISTINCT f.numero_factura) AS facturas,
            coalesce(sum(f.cantidad), 0) AS servicios
       FROM generate_series($1::date, $2::date, interval '1 day') AS g(dia)
       LEFT JOIN bi.fact_facturacion f ON f.${columnaFecha} = g.dia::date AND NOT f.anulada
      GROUP BY 1 ORDER BY 1`,
    [r.desde, r.hasta, r.grano],
  );
}

/** Recaudo por día (o semana) y forma de pago, para la barra apilada. */
const serieRecaudo = (r: Rango) =>
  query(
    `SELECT ${periodo('fecha_pago')} AS periodo, forma_pago AS grupo, sum(valor) AS n
       FROM bi.fact_recaudo WHERE ${EN_PERIODO_RECAUDO}
      GROUP BY 1, 2 ORDER BY 1`,
    [r.desde, r.hasta, r.grano],
  );

/** Lo vendido y lo recaudado de un mes, con las mismas definiciones que las pantallas del período. */
async function indicadoresDelMes(desde: string, hasta: string) {
  const [totales, tipo, servicio, convenio, especialidad, diasVentas, recaudo, formaPago, diasRecaudo] = await Promise.all([
    totalesFacturacion('fecha_factura', desde, hasta),
    agrupar('tipo', 'fecha_factura', desde, hasta),
    agrupar('servicio', 'fecha_factura', desde, hasta),
    agrupar('convenio', 'fecha_factura', desde, hasta),
    agrupar('especialidad', 'fecha_factura', desde, hasta),
    query(
      `SELECT extract(day FROM fecha_factura)::int AS dia, sum(valor_bruto) AS valor
         FROM bi.fact_facturacion WHERE ${EN_PERIODO('fecha_factura')} GROUP BY 1 ORDER BY 1`,
      [desde, hasta],
    ),
    totalesRecaudo(desde, hasta),
    recaudoPor('formaPago', desde, hasta),
    query(
      `SELECT extract(day FROM fecha_pago)::int AS dia, sum(valor) AS valor
         FROM bi.fact_recaudo WHERE ${EN_PERIODO_RECAUDO} GROUP BY 1 ORDER BY 1`,
      [desde, hasta],
    ),
  ]);
  return {
    facturacion: { totales, tipo, servicio, convenio, especialidad, dias: diasVentas },
    recaudo: { ...recaudo, formaPago, dias: diasRecaudo },
  };
}

export default async function rutasFacturacion(app: FastifyInstance) {
  // Cuándo se descargó cada reporte y desde qué mes hay datos. Lo usan todas las pestañas.
  app.get('/api/facturacion/estado', async (req) =>
    conCache(claveCache(req), async () => {
      const [reportes, primerMes] = await Promise.all([
        query(
          `SELECT reporte, estado, origen, recibida_at, n_avisos, ok_hasta, ok_recibida_at, horas_desde_ok
             FROM bi.v_facturacion_estado ORDER BY reporte`,
        ),
        primerMesFacturacion(),
      ]);
      return { primerMes, reportes };
    }, 60_000),
  );

  // ¿Cuánto vendimos? Indicadores del período, comparados con el período anterior, y la serie diaria.
  app.get('/api/facturacion', async (req) => {
    const q = req.query as Record<string, unknown>;
    const r = leerRango(q);
    const eje = leerEje(q);
    const columna = EJES[eje];
    return conCache(claveCache(req), async () => {
      const primerMes = await primerMesFacturacion();
      const [totales, anterior, serie] = await Promise.all([
        totalesFacturacion(columna, r.desde, r.hasta),
        hayPeriodoAnterior(r, primerMes) ? totalesFacturacion(columna, r.prevDesde, r.prevHasta) : Promise.resolve(null),
        serieVentas(columna, r),
      ]);
      return { rango: r, eje, totales, anterior: conDatos(anterior), serie };
    }, TTL_MS);
  });

  // ¿Qué servicios y convenios? Cómo se reparte lo vendido.
  app.get('/api/facturacion/desglose', async (req) => {
    const q = req.query as Record<string, unknown>;
    const r = leerRango(q);
    const columna = EJES[leerEje(q)];
    return conCache(claveCache(req), async () => {
      const [tipo, servicio, convenio, especialidad, facturador] = await Promise.all(
        (['tipo', 'servicio', 'convenio', 'especialidad', 'facturador'] as const).map((g) => agrupar(g, columna, r.desde, r.hasta)),
      );
      return { rango: r, tipo, servicio, convenio, especialidad, facturador };
    }, TTL_MS);
  });

  // Detalle de facturas del período, paginado. Incluye las anuladas, marcadas como tales; documento, teléfono y correo
  // se enmascaran según los permisos de cada persona (recortes.ts). Una factura de convenio reúne a varios pacientes:
  // solo se nombra al paciente cuando la factura tiene uno.
  app.get('/api/facturacion/facturas', async (req) => {
    const q = req.query as Record<string, unknown>;
    const r = leerRango(q);
    const columna = EJES[leerEje(q)];
    const { pagina, tam, offset } = leerPagina(q, 50, 200);
    return conCache(claveCache(req), async () => {
      const filas = await query<{ total: number }>(
        `SELECT numero_factura, fecha_factura, convenio_nombre, es_particular, bool_and(anulada) AS anulada,
                coalesce(sum(cantidad), 0) AS servicios, coalesce(sum(valor_bruto), 0) AS valor_bruto,
                coalesce(sum(${PAGA_PACIENTE}), 0) AS copago, coalesce(sum(${A_CARGO_CONVENIO}), 0) AS total_convenio,
                count(DISTINCT documento_paciente) AS pacientes,
                CASE WHEN count(DISTINCT documento_paciente) = 1 THEN max(nombre_paciente) END AS nombre_paciente,
                CASE WHEN count(DISTINCT documento_paciente) = 1 THEN max(documento_paciente) END AS documento_paciente,
                count(*) OVER () AS total
           FROM bi.fact_facturacion
          WHERE ${columna} BETWEEN $1 AND $2
          GROUP BY numero_factura, fecha_factura, convenio_nombre, es_particular
          ORDER BY fecha_factura DESC, numero_factura DESC
          LIMIT $3 OFFSET $4`,
        [r.desde, r.hasta, tam, offset],
      );
      return { rango: r, pagina, tam, total: filas[0]?.total ?? 0, filas: filas.map(({ total: _total, ...fila }) => fila) };
    }, TTL_MS);
  });

  // ¿Cómo nos pagan? Lo recibido en caja y bancos, por método de pago, caja o banco, cajero y régimen.
  app.get('/api/facturacion/recaudo', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    return conCache(claveCache(req), async () => {
      const primerMes = await primerMesFacturacion();
      const [totales, anterior, anulados, serie, formaPago, cajaBanco, cajero, regimen] = await Promise.all([
        totalesRecaudo(r.desde, r.hasta),
        hayPeriodoAnterior(r, primerMes) ? totalesRecaudo(r.prevDesde, r.prevHasta) : Promise.resolve(null),
        queryOne<{ n: number }>(`SELECT count(*) AS n FROM bi.fact_recaudo WHERE anulado AND fecha_pago BETWEEN $1 AND $2`, [r.desde, r.hasta]),
        serieRecaudo(r),
        recaudoPor('formaPago', r.desde, r.hasta),
        recaudoPor('cajaBanco', r.desde, r.hasta),
        recaudoPor('cajero', r.desde, r.hasta),
        recaudoPor('regimen', r.desde, r.hasta),
      ]);
      return { rango: r, totales, anterior: conDatos(anterior), anulados: anulados.n, serie, formaPago, cajaBanco, cajero, regimen };
    }, TTL_MS);
  });

  // Comparativo de periodos: lo vendido y lo recaudado en dos meses, uno al lado del otro.
  app.get('/api/facturacion/comparativo', async (req) => {
    const primerMes = await primerMesFacturacion();
    if (!primerMes) throw new ErrorParametro('Todavía no hay datos de facturación para comparar');
    const c = resolverComparativo(req.query as Record<string, unknown>, req.contexto!, hoyBogota(), { primerMes, avisarCargaInicial: false });
    return conCache(
      claveCache(req),
      async () => {
        const [a, b] = await Promise.all([indicadoresDelMes(c.a.desde, c.a.hasta), indicadoresDelMes(c.b.desde, c.b.hasta)]);
        return { comparativo: c, a, b };
      },
      ttlComparativo(c),
    );
  });
}
