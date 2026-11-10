// Prueba de las consultas de Facturación (server/routes/facturacion.ts) contra Postgres real, con datos SINTÉTICOS.
// Diseño: proyecto-ips/docs/features/2026-11-09-modulo-facturacion.md, secciones 7, 9.1 y 11.
//
// Necesita TEST_DATABASE_URL: una base DESECHABLE (nombre con "test") que ya tenga el esquema de proyecto-ips con la
// migración 048 aplicada (por ejemplo, un clon SOLO del esquema, sin datos). La prueba VACÍA facturacion_detalle,
// recaudos y facturacion_ejecuciones. NUNCA apuntarla a producción ni al volumen local con datos reales.
//   TEST_DATABASE_URL=postgres://... npm run test:facturacion
// Sin esa variable, la prueba se omite.
import assert from 'node:assert/strict';

const DB_URL = process.env.TEST_DATABASE_URL;
if (!DB_URL) {
  console.log('Facturación: omitida (defina TEST_DATABASE_URL con una base desechable para ejecutarla)');
  process.exit(0);
}
process.env.DATABASE_URL = DB_URL; // server/db.ts lo lee al importarse

const { default: Fastify } = await import('fastify');
const { pool, query } = await import('../server/db.ts');
const { manejarError } = await import('../server/errores.ts');
const { default: rutasFacturacion } = await import('../server/routes/facturacion.ts');
const { CITAS, catalogoNormalizado, especialidadDeCatalogo, tipoServicio } = await import('../server/sql.ts');
const { _fijarOcultosParaPruebas } = await import('../server/ocultos.ts');

let comprobaciones = 0;
const check = (etiqueta, condicion) => {
  assert.ok(condicion, etiqueta);
  comprobaciones++;
};

const { rows: [{ db }] } = await pool.query('SELECT current_database() AS db');
assert.ok(/test/i.test(db), `La base "${db}" no parece desechable (su nombre debe contener "test"): no se toca.`);

// ------------------------------------------------------------------------------------------------ datos sintéticos
await pool.query('TRUNCATE facturacion_detalle, recaudos, facturacion_ejecuciones');

const linea = (id, factura, fechaFactura, convenio, catalogo, valores, extra = {}) => ({
  id, factura, fechaFactura, convenio, catalogo, particular: convenio === 'Particular', codigo: extra.codigo ?? null,
  cantidad: valores.cantidad ?? 1, unitario: valores.unitario, copago: valores.copago, anulada: false, documento: null,
  nombre: null, facturador: null, fechaServicio: fechaFactura, ...extra,
});
const LINEAS = [
  linea(1, 'F1', '2026-10-05', 'Particular', 'CONSULTA DE CONTROL PSICOLOGIA', { unitario: 100000, copago: 0 }, { codigo: '890308', documento: '111', nombre: 'PACIENTE UNO', facturador: 'RECEPCION A' }),
  linea(2, 'F2', '2026-10-31', 'EMPRESA A', 'CONSULTA PSIQUIATRIA PRIMERA VEZ', { unitario: 200000, copago: 20000 }, { codigo: '890208', documento: '222', nombre: 'PACIENTE DOS' }),
  linea(3, 'F2', '2026-10-31', 'EMPRESA A', 'PRUEBA NEUROPSICOLÓGICA', { cantidad: 2, unitario: 150000, copago: 0 }, { codigo: 'NEU1', documento: '333', nombre: 'PACIENTE TRES' }),
  linea(4, 'F3', '2026-10-31', 'Particular', 'CONSULTA DE CONTROL PSICOLOGIA', { unitario: 999999, copago: 0 }, { codigo: '890308', documento: '444', anulada: true }),
  // Facturada en septiembre pero prestada en octubre: entra al mes anterior por fecha de factura y a octubre por fecha de servicio.
  linea(5, 'F4', '2026-09-15', 'EMPRESA A', 'CONSULTA DE CONTROL PSICOLOGIA', { unitario: 50000, copago: 0 }, { codigo: '890308', documento: '555', fechaServicio: '2026-10-02' }),
];
for (const l of LINEAS) {
  const bruto = l.cantidad * l.unitario;
  await pool.query(
    `INSERT INTO facturacion_detalle
       (id_globho, numero_factura, fecha_factura, fecha_servicio, convenio_nombre, es_particular, documento_paciente, nombre_paciente,
        codigo_catalogo, catalogo, cantidad, valor_unitario, valor_bruto, copago, total_convenio, facturador, anulada)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [l.id, l.factura, l.fechaFactura, l.fechaServicio, l.convenio, l.particular, l.documento, l.nombre, l.codigo, l.catalogo,
      l.cantidad, l.unitario, bruto, l.copago, bruto - l.copago, l.facturador, l.anulada],
  );
}
const PAGOS = [
  [1, '2026-10-05', 'Efectivo', 'Caja Recepción', 'CAJERA UNO', 'Particular', 50000, false],
  [2, '2026-10-05', 'Transferencia', 'Bancolombia Ahorros', 'CAJERA UNO', 'Particular', 150000, false],
  [3, '2026-10-06', 'Efectivo', 'Caja Recepción', 'CAJERO DOS', 'Particular', 0, true],
  [4, '2026-09-20', 'Efectivo', 'Caja Recepción', 'CAJERO DOS', 'Particular', 30000, false],
];
for (const [id, fecha, forma, caja, cajero, regimen, valor, anulado] of PAGOS) {
  await pool.query(
    `INSERT INTO recaudos (id_globho, anulado, fecha_pago, forma_pago, caja_banco, cajero, regimen, concepto, valor)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'copago',$8)`,
    [id, anulado, fecha, forma, caja, cajero, regimen, valor],
  );
}
await pool.query(
  `INSERT INTO facturacion_ejecuciones (origen, reporte, desde, hasta, estado, filas_recibidas, filas_insertadas)
   VALUES ('cron_diario','facturacion','2026-10-25','2026-11-08','ok',5,5), ('cron_diario','recaudo','2026-10-25','2026-11-08','error',0,0)`,
);

// ------------------------------------------------------------------------------------------------ servidor de prueba
const app = Fastify();
app.setErrorHandler(manejarError);
app.addHook('onRequest', async (req) => {
  req.contexto = { usuario: 'prueba', rolReal: 'direccion', nivelReal: 'full', rol: 'direccion', nivel: 'full', vistaPrevia: false, historialDesde: null, habilitado: true };
});
await app.register(rutasFacturacion);
await app.ready();
const pedir = async (ruta, q = {}) => {
  const res = await app.inject({ method: 'GET', url: `${ruta}?${new URLSearchParams(q)}` });
  return { status: res.statusCode, cuerpo: res.json() };
};
const OCTUBRE = { desde: '2026-10-01', hasta: '2026-10-31' };
const suma = (filas, campo) => filas.reduce((a, f) => a + Number(f[campo]), 0);
const porNombre = (filas, nombre) => filas.find((f) => f.nombre === nombre);

// ------------------------------------------------------------------------------------------------ clasificación
{
  const nombres = [
    ['CONSULTA PSIQUIATRIA PRIMERA VEZ', 'primera_vez', 'Psiquiatría'],
    ['Consulta de control psicología', 'control', 'Psicología'],
    ['PRUEBA NEUROPSICOLÓGICA', 'evaluacion', 'Neuropsicología'],
    ['SESIÓN DE PSICOTERAPIA INDIVIDUAL', 'psicoterapia', 'Psicología'],
    ['INTERVENCION EN CRISIS', 'crisis', 'Otra'],
    ['TALLER EMPRESARIAL', 'empresarial', 'Otra'],
    ['ALGO DISTINTO', 'otro', 'Otra'],
  ];
  const valores = nombres.map((_, i) => `($${i + 1})`).join(', ');
  const norm = catalogoNormalizado('v.n');
  const { rows } = await pool.query(
    `SELECT v.n, ${tipoServicio(norm)} AS tipo, ${especialidadDeCatalogo(norm)} AS especialidad FROM (VALUES ${valores}) AS v(n)`,
    nombres.map(([n]) => n),
  );
  for (const [n, tipo, especialidad] of nombres) {
    const r = rows.find((x) => x.n === n);
    check(`Clasificación: "${n}" es ${tipo} y ${especialidad}`, r.tipo === tipo && r.especialidad === especialidad);
  }
  // La CTE de la agenda, ya con las reglas extraídas, sigue siendo SQL válido sobre el esquema real.
  const citas = await pool.query(`WITH ${CITAS} SELECT count(*)::int AS n FROM citas`);
  check('Clasificación: la CTE citas de la agenda sigue ejecutándose', citas.rows[0].n === 0);
}

// ------------------------------------------------------------------------------------------------ ¿cuánto vendimos?
{
  const { status, cuerpo: d } = await pedir('/api/facturacion', OCTUBRE);
  check('Ventas: responde 200', status === 200);
  const t = d.totales;
  check('Ventas: valor de servicios = suma de valor × cantidad, sin la factura anulada', t.valor_bruto === 600000);
  check('Ventas: un servicio particular (Copago 0, todo en Total) lo paga el paciente, no el convenio (FAC-02 y FAC-03)', t.copago === 120000 && t.total_convenio === 480000);
  check('Ventas: valor = lo que paga el paciente + a cargo del convenio', t.valor_bruto === t.copago + t.total_convenio);
  check('Ventas: facturas distintas, servicios (cantidad) y pacientes sin contar la anulada', t.facturas === 2 && t.servicios === 4 && t.pacientes === 3);
  check('Ventas: el mes anterior no se compara si el rango empieza antes del primer mes con datos', d.anterior === null);
  check('Ventas: una fila por día, con los días sin ventas en cero', d.serie.length === 31 && d.serie[0].periodo === '2026-10-01' && d.serie[0].valor_bruto === 0);
  const dia5 = d.serie.find((f) => f.periodo === '2026-10-05');
  const dia31 = d.serie.find((f) => f.periodo === '2026-10-31');
  check('Ventas: la serie separa particular y convenio', dia5.particular === 100000 && dia5.convenio === 0 && dia31.convenio === 500000 && dia31.particular === 0);
  check('Ventas: la suma de la serie es el total del período', suma(d.serie, 'valor_bruto') === t.valor_bruto);

  const quincena = await pedir('/api/facturacion', { desde: '2026-10-01', hasta: '2026-10-30' });
  check('Ventas: con datos en el período anterior, devuelve sus totales para las flechas', quincena.cuerpo.anterior !== null && quincena.cuerpo.anterior.valor_bruto === 50000);

  const porServicio = await pedir('/api/facturacion', { ...OCTUBRE, eje: 'servicio' });
  check('Ventas: por fecha del servicio entra lo prestado en octubre aunque se facturó en septiembre', porServicio.cuerpo.totales.valor_bruto === 650000);
  check('Ventas: un eje inválido responde 400', (await pedir('/api/facturacion', { ...OCTUBRE, eje: 'otro' })).status === 400);
  check('Ventas: un rango largo se agrupa por semana', (await pedir('/api/facturacion', { desde: '2026-08-01', hasta: '2026-10-31' })).cuerpo.rango.grano === 'week');
}

// ------------------------------------------------------------------------------------------------ ¿qué servicios y convenios?
{
  const { cuerpo: d } = await pedir('/api/facturacion/desglose', OCTUBRE);
  check('Desglose: por tipo de servicio', porNombre(d.tipo, 'control').valor_bruto === 100000 && porNombre(d.tipo, 'primera_vez').valor_bruto === 200000 && porNombre(d.tipo, 'evaluacion').valor_bruto === 300000);
  check('Desglose: por especialidad (neuropsicología no cae en psicología)', porNombre(d.especialidad, 'Neuropsicología').valor_bruto === 300000 && porNombre(d.especialidad, 'Psicología').valor_bruto === 100000 && porNombre(d.especialidad, 'Psiquiatría').valor_bruto === 200000);
  const particular = porNombre(d.convenio, 'Particular');
  const empresa = porNombre(d.convenio, 'EMPRESA A');
  check('Desglose: el particular queda aparte del convenio', particular.es_particular === true && particular.valor_bruto === 100000 && particular.copago === 100000 && particular.total_convenio === 0);
  check('Desglose: el convenio reparte entre paciente y entidad', empresa.es_particular === false && empresa.valor_bruto === 500000 && empresa.copago === 20000 && empresa.total_convenio === 480000 && empresa.facturas === 1);
  check('Desglose: ordenado de mayor a menor valor', d.convenio[0].nombre === 'EMPRESA A');
  const neu = d.servicio.find((s) => s.codigo === 'NEU1');
  check('Desglose: por servicio (código, nombre más frecuente, tipo y cantidad)', neu.nombre === 'PRUEBA NEUROPSICOLÓGICA' && neu.tipo === 'evaluacion' && neu.servicios === 2 && d.servicio.length === 3);
  check('Desglose: "Facturado por" agrupa a quien no tiene dato', porNombre(d.facturador, 'RECEPCION A').valor_bruto === 100000 && porNombre(d.facturador, 'Sin dato').valor_bruto === 500000);

  const f1 = await pedir('/api/facturacion/facturas', { ...OCTUBRE, tam: '2', pagina: '1' });
  check('Facturas: lista facturas (no líneas), incluida la anulada y marcada', f1.cuerpo.total === 3 && f1.cuerpo.filas.length === 2 && f1.cuerpo.filas[0].numero_factura === 'F3' && f1.cuerpo.filas[0].anulada === true);
  const f2 = await pedir('/api/facturacion/facturas', { ...OCTUBRE, tam: '2', pagina: '2' });
  const unica = f2.cuerpo.filas[0];
  check('Facturas: la segunda página trae el resto, con el paciente de una factura de un solo paciente', f2.cuerpo.filas.length === 1 && unica.numero_factura === 'F1' && unica.nombre_paciente === 'PACIENTE UNO' && unica.documento_paciente === '111' && unica.pacientes === 1);
  const convenio = f1.cuerpo.filas.find((f) => f.numero_factura === 'F2');
  check('Facturas: una factura de convenio con varios pacientes no nombra a ninguno', convenio.pacientes === 2 && convenio.nombre_paciente === null && convenio.documento_paciente === null);
  check('Facturas: el total de filas no viaja dentro de cada fila', !('total' in f1.cuerpo.filas[0]));
}

// ------------------------------------------------------------------------------------------------ ¿cómo nos pagan?
{
  const { cuerpo: d } = await pedir('/api/facturacion/recaudo', OCTUBRE);
  check('Recaudo: total y pagos sin contar el anulado', d.totales.total === 200000 && d.totales.pagos === 2 && d.anulados === 1);
  check('Recaudo: por método de pago, de mayor a menor', d.formaPago[0].nombre === 'Transferencia' && d.formaPago[0].valor === 150000 && porNombre(d.formaPago, 'Efectivo').valor === 50000);
  check('Recaudo: por caja o banco, cajero y régimen', porNombre(d.cajaBanco, 'Bancolombia Ahorros').valor === 150000 && porNombre(d.cajero, 'CAJERA UNO').valor === 200000 && porNombre(d.regimen, 'Particular').pagos === 2);
  check('Recaudo: la serie va por día y método de pago, y suma el total', d.serie.every((f) => f.periodo === '2026-10-05') && suma(d.serie, 'n') === 200000);
  const anterior = await pedir('/api/facturacion/recaudo', { desde: '2026-10-01', hasta: '2026-10-30' });
  check('Recaudo: totales del período anterior para las flechas', anterior.cuerpo.anterior.total === 30000);
}

// ------------------------------------------------------------------------------------------------ comparativo y estado
{
  const { status, cuerpo: d } = await pedir('/api/facturacion/comparativo', { mesA: '2026-10', modo: 'mes_anterior', corte: 'completo' });
  check('Comparativo: responde 200 con los dos meses', status === 200 && d.comparativo.a.mes === '2026-10' && d.comparativo.b.mes === '2026-09');
  check('Comparativo: sin aviso de carga inicial (habla de pacientes nuevos)', !d.comparativo.avisos.some((a) => a.codigo === 'carga_inicial'));
  check('Comparativo: ventas de cada mes con las mismas definiciones', d.a.facturacion.totales.valor_bruto === 600000 && d.b.facturacion.totales.valor_bruto === 50000);
  check('Comparativo: por tipo, servicio, convenio y especialidad en cada mes', d.a.facturacion.tipo.length === 3 && d.b.facturacion.convenio[0].nombre === 'EMPRESA A' && d.a.facturacion.especialidad.length === 3 && d.a.facturacion.servicio.length === 3);
  check('Comparativo: serie por día del mes', d.a.facturacion.dias.find((x) => x.dia === 31).valor === 500000);
  check('Comparativo: recaudo de cada mes, por método de pago y por día', d.a.recaudo.total === 200000 && d.b.recaudo.total === 30000 && d.a.recaudo.formaPago.length === 2 && d.b.recaudo.dias[0].dia === 20);

  const antes = await pedir('/api/facturacion/comparativo', { mesA: '2026-09', modo: 'mes_anterior', corte: 'completo' });
  check('Comparativo: no deja comparar antes del primer mes con datos (septiembre de 2026)', antes.status === 400 && /septiembre de 2026/.test(antes.cuerpo.error));

  const estado = (await pedir('/api/facturacion/estado')).cuerpo;
  check('Estado: primer mes con datos', estado.primerMes === '2026-09');
  const fact = estado.reportes.find((r) => r.reporte === 'facturacion');
  const rec = estado.reportes.find((r) => r.reporte === 'recaudo');
  check('Estado: facturación correcta con su última descarga', fact.estado === 'ok' && fact.ok_hasta === '2026-11-08' && fact.horas_desde_ok >= 0);
  check('Estado: el recaudo con error no tiene descarga correcta', rec.estado === 'error' && rec.ok_hasta === null && rec.horas_desde_ok === null);
}

// ------------------------------------------------------------------------------------------------ identidades ocultas
{
  _fijarOcultosParaPruebas({ documentos: ['222'] });
  const q = { ...OCTUBRE, x: 'ocultos' }; // otra URL: no usa la caché de las pruebas anteriores
  const ventas = (await pedir('/api/facturacion', q)).cuerpo.totales;
  check('Ocultos: las ventas de un documento oculto no se cuentan', ventas.valor_bruto === 400000 && ventas.pacientes === 2);
  const facturas = (await pedir('/api/facturacion/facturas', q)).cuerpo.filas;
  check('Ocultos: la factura de convenio ya solo nombra al paciente que queda', facturas.find((f) => f.numero_factura === 'F2').pacientes === 1);
  const recaudoOculto = await query(`SELECT count(*)::int AS n FROM bi.fact_recaudo`);
  check('Ocultos: el recaudo sin documento sigue visible', recaudoOculto[0].n === 4);
  _fijarOcultosParaPruebas({});
}

await app.close();
await pool.end();
console.log(`Facturación: ${comprobaciones} comprobaciones OK`);
