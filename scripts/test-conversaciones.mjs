// Prueba de integración del historial de conversaciones del panel (server/routes/conversaciones.ts).
// Diseño: proyecto-ips/docs/features/2026-10-29-historial-mensajes-panel.md, secciones 6 y 8.3.
//
// Usa Postgres REAL y los hooks reales (instalarAcceso, recortes de identidades ocultas, esquema `panel`), con DATOS
// SINTÉTICOS. Necesita una base DESECHABLE con la migración 045 del backend ya aplicada y la capa bi (030):
//   TEST_ADMIN_URL=postgres://admin:...@127.0.0.1:5437/historial_test npm run test:conversaciones
// Sin TEST_ADMIN_URL se omite (sale con 0). Por seguridad exige que la base se llame *_test: vacía las tablas del
// historial y recrea el esquema `panel` y los roles panel_t_lectura / panel_t_app (con contraseñas aleatorias de la
// corrida). NUNCA apuntarla a producción ni al volumen local con datos reales.
//
// Nada de esto toca Globho ni envía WhatsApp: el panel es de solo lectura.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const ADMIN = process.env.TEST_ADMIN_URL;
if (!ADMIN) {
  console.log('test:conversaciones omitido: defina TEST_ADMIN_URL (base desechable *_test).');
  process.exit(0);
}
const nombreBd = new URL(ADMIN).pathname.slice(1);
assert.ok(nombreBd.endsWith('_test'), `Por seguridad la base debe terminar en _test (es "${nombreBd}")`);

const { default: pg } = await import('pg');
const adm = new pg.Pool({ connectionString: ADMIN, max: 2 });
const Q = (sql, p = []) => adm.query(sql, p).then((r) => r.rows);

// ------------------------------------------------------------------------ roles y esquema `panel` (desechables)
const clave = randomUUID().replace(/-/g, '');
const urlRol = (rol) => {
  const u = new URL(ADMIN);
  u.username = rol;
  u.password = clave;
  return u.toString();
};
for (const rol of ['panel_t_lectura', 'panel_t_app']) {
  await Q(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${rol}') THEN CREATE ROLE ${rol} LOGIN; END IF; END $$`);
  await Q(`ALTER ROLE ${rol} PASSWORD '${clave}'`);
}
await Q(`ALTER ROLE panel_t_lectura SET default_transaction_read_only = on`);
await Q(`GRANT CONNECT ON DATABASE ${nombreBd} TO panel_t_lectura, panel_t_app`);
await Q(`GRANT USAGE ON SCHEMA bi, historial, public TO panel_t_lectura`);
await Q(`GRANT SELECT ON ALL TABLES IN SCHEMA bi TO panel_t_lectura`);
await Q(`GRANT SELECT ON ALL TABLES IN SCHEMA historial TO panel_t_lectura`);
await Q(`DROP SCHEMA IF EXISTS panel CASCADE`);
await Q(`CREATE SCHEMA panel AUTHORIZATION panel_t_app`);

process.env.DATABASE_URL = urlRol('panel_t_lectura');
process.env.DATABASE_URL_APP = urlRol('panel_t_app');
process.env.PANEL_CONVERSACIONES_ENABLED = 'true';
process.env.PANEL_HISTORIAL_TICK_MS = '500';
process.env.PANEL_HISTORIAL_INACTIVIDAD_MS = '3000';
const OCULTO = '573009990000';
process.env.PANEL_IDENTIDADES_OCULTAS = `telefono:${OCULTO}`;

const { pool, poolApp } = await import('../server/db.ts');
const { prepararEsquema } = await import('../server/esquema.ts');
const { instalarAcceso, invalidarConfig } = await import('../server/acceso.ts');
const { recargarOcultos } = await import('../server/ocultos.ts');
const { ErrorParametro } = await import('../server/params.ts');
const { default: rutas, _reiniciarParaPruebas, _estadoBufferParaPruebas } = await import('../server/routes/conversaciones.ts');
const { default: Fastify } = await import('fastify');

await prepararEsquema(() => {});

// ----------------------------------------------------------------------------------------- datos sintéticos
await Q(`TRUNCATE mensajes_conversacion, conversaciones_resumen RESTART IDENTITY`);
await Q(`DELETE FROM pacientes WHERE numero_documento LIKE 'TSTC%'`);
await Q(
  `INSERT INTO pacientes (pacientes_id, numero_documento, nombre_completo, numero_contacto) VALUES
     ('tstc0001', 'TSTC001', 'Ana Prueba Uno', '3001110001'),
     ('tstc0002', 'TSTC002', 'Beto Prueba Dos', '3001110002')`,
);
const TA = '573001110001'; // Ana: conversación normal con plantilla y respuesta
const TB = '573001110002'; // Beto: crisis
const TC = '573001110003'; // sin paciente: saliente con error de entrega
const T_ESCAPE = '573001110004';
let n = 0;
const msg = async (tel, dir, origen, tipo, texto, extra = {}) => {
  n++;
  await Q(
    `INSERT INTO mensajes_conversacion (mensaje_uid, wa_message_id, telefono_norm, direccion, origen, tipo, texto, contenido, plantilla, estado_envio, error_code, en_blacklist, flujo, paso, ocurrido_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, now() - ($14 || ' seconds')::interval)`,
    [extra.wa ?? null, tel, dir, origen, tipo, texto, extra.contenido ? JSON.stringify(extra.contenido) : null, extra.plantilla ?? null,
      extra.estado ?? null, extra.err ?? null, extra.bl ?? null, extra.flujo ?? null, extra.paso ?? null, String(extra.hace ?? 0)],
  );
};
await msg(TA, 'saliente', 'campana', 'plantilla', null, { plantilla: 'recordatorio_2h_botones', contenido: { parametros: ['Ana'] }, hace: 400, estado: 'read', wa: 'wamid.A1' });
await msg(TA, 'entrante', 'paciente', 'boton', 'Confirmo asistencia', { hace: 300, contenido: { payload: 'LEREC:abc:C' } });
await msg(TA, 'saliente', 'bot_flujo', 'texto', 'Gracias, tu cita quedó confirmada.', { hace: 299, estado: 'delivered', wa: 'wamid.A2', flujo: 'recordatorio', paso: 'confirmada' });
await msg(TA, 'entrante', 'paciente', 'texto', 'Gracias a ustedes', { hace: 10 });
await msg(TB, 'entrante', 'paciente', 'texto', 'mensaje de prueba crisis', { hace: 50, bl: true });
await msg(TB, 'sistema', 'crisis', 'evento', 'Protocolo de crisis activado', { hace: 49 });
await msg(TC, 'saliente', 'campana', 'plantilla', null, { plantilla: 'cita_cancelada_sin_confirmacion', estado: 'failed', err: '131026', wa: 'wamid.C1', hace: 20 });
await msg(T_ESCAPE, 'entrante', 'paciente', 'texto', '100% seguro_ ok', { hace: 15 });
await msg(OCULTO, 'entrante', 'paciente', 'texto', 'SECRETO_INTERNO', { hace: 5 });
await Q(`UPDATE mensajes_conversacion SET texto = 'Beto escribe: 100%' WHERE telefono_norm = '${TB}' AND tipo = 'texto'`);
await Q(
  `INSERT INTO conversaciones_resumen (telefono_norm, ultimo_mensaje_id, ultimo_at, ultimo_extracto, ultima_direccion, mensajes_total, entrantes_total, primer_at, flujo_actual, paso_actual, hubo_crisis, ultima_plantilla_id, ultimo_entrante_id)
   SELECT telefono_norm, max(id), max(ocurrido_at), left(coalesce((array_agg(texto ORDER BY id DESC))[1], '(' || (array_agg(tipo ORDER BY id DESC))[1] || ')'), 120),
          (array_agg(direccion ORDER BY id DESC))[1], count(*), count(*) FILTER (WHERE direccion = 'entrante'), min(ocurrido_at),
          (array_agg(flujo ORDER BY id DESC))[1], (array_agg(paso ORDER BY id DESC))[1], bool_or(origen = 'crisis'),
          max(id) FILTER (WHERE tipo = 'plantilla'), max(id) FILTER (WHERE direccion = 'entrante')
     FROM mensajes_conversacion GROUP BY telefono_norm`,
);

// Usuarios: uno por rol. Se cambia el nivel de la licencia según la prueba.
await poolApp.query(
  `INSERT INTO panel.usuarios (usuario, rol, nombre, prioridad) VALUES
     ('t_dir', 'direccion', 'Dirección', 0), ('t_ana', 'analista', 'Analista', 2), ('t_rel', 'relacion', 'Relación', 3),
     ('t_ope', 'operacion', 'Operación', 4), ('t_pro', 'profesional', 'Profesional', 5), ('t_sop', 'soporte', 'Soporte', 0)
   ON CONFLICT (usuario) DO UPDATE SET rol = EXCLUDED.rol, prioridad = EXCLUDED.prioridad, activo = true`,
);
const nivel = async (nv) => {
  await poolApp.query(`UPDATE panel.licencia SET nivel = $1 WHERE id = 1`, [nv]);
  invalidarConfig();
};
await nivel('full');
await recargarOcultos();

// ---------------------------------------------------------------------------------------------- servidor
// Con el login propio la identidad sale SOLO de la cookie de sesión: se crea una sesión por usuario de prueba
// (directo en la base, como hace server/scripts/sesion-verificacion.ts) y `get()` envía su cookie.
const { createHash, randomBytes } = await import('node:crypto');
const { default: fastifyCookie } = await import('@fastify/cookie');
const cookies = {};
for (const u of ['t_dir', 't_ana', 't_rel', 't_ope', 't_pro', 't_sop']) {
  const token = randomBytes(32).toString('base64url');
  await poolApp.query(`INSERT INTO panel.sesiones (token_hash, usuario, expira_at) VALUES ($1, $2, now() + interval '12 hours')`, [createHash('sha256').update(token).digest(), u]);
  cookies[u] = `panel_sesion=${token}`;
}

const app = Fastify();
await app.register(fastifyCookie);
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ErrorParametro) return reply.code(400).send({ error: err.message });
  const e = err;
  if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message });
  console.error(err);
  return reply.code(500).send({ error: 'Error interno del panel' });
});
instalarAcceso(app);
await app.register(rutas);
await app.ready();

const consultas = [];
const consultar = pool.query.bind(pool);
pool.query = (...a) => (consultas.push(String(a[0]?.text ?? a[0])), consultar(...a));
const sondeos = () => consultas.filter((c) => /WHERE id > \$1 ORDER BY id LIMIT/.test(c)).length;

const comprobaciones = [];
const check = (etiqueta, condicion) => {
  assert.ok(condicion, etiqueta);
  comprobaciones.push(etiqueta);
};
const get = (usuario, url) => app.inject({ method: 'GET', url, headers: usuario ? { cookie: cookies[usuario] } : {} });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const actividadMia = async (usuario, patron) =>
  (await poolApp.query(`SELECT * FROM panel.actividad WHERE usuario = $1 AND ruta LIKE $2`, [usuario, patron])).rows;
const volcarActividad = async () => {
  // La actividad se vuelca cada 10 s o al cerrar; se fuerza esperando un tick del volcado.
  await espera(10_500);
};

// ============================================================================================== 8.3 acceso
{
  for (const usuario of ['t_ana', 't_rel', 't_ope', 't_pro']) {
    for (const url of ['/api/conversaciones', '/api/conversaciones/cursor', `/api/conversaciones/${TA}/mensajes`]) {
      const r = await get(usuario, url);
      check(`${usuario} → 403 en ${url.replace(TA, ':telefono')}`, r.statusCode === 403 && !r.body.includes('Ana Prueba'));
    }
  }
  const sinUsuario = await get(null, '/api/conversaciones');
  check('sin sesión → 401', sinUsuario.statusCode === 401);

  await nivel('intermedio');
  for (const url of ['/api/conversaciones', `/api/conversaciones/${TA}/mensajes`]) {
    const r = await get('t_dir', url);
    check(`Dirección en plan Intermedio → 402 (candado) en ${url.replace(TA, ':telefono')}`, r.statusCode === 402 && r.json().nivel === 'full');
  }
  await nivel('basico');
  check('Dirección en plan Básico → 402', (await get('t_dir', '/api/conversaciones')).statusCode === 402);
  await nivel('full');
  check('Dirección en plan Full → 200', (await get('t_dir', '/api/conversaciones')).statusCode === 200);
  check('Soporte → 200', (await get('t_sop', '/api/conversaciones')).statusCode === 200);

  const yo = await import('../server/funciones.ts');
  check('La función existe en nivel Full, solo para Dirección y Soporte', (() => {
    const f = yo.FUNCIONES.find((x) => x.clave === 'conversaciones.ver');
    return f?.nivel === 'full' && f.pagina === 'conversaciones' && f.roles.join() === 'direccion,soporte';
  })());
  check('Las 3 rutas están mapeadas en ENDPOINTS (ninguna queda sin entrada)',
    ['GET /api/conversaciones', 'GET /api/conversaciones/cursor', 'GET /api/conversaciones/:telefono/mensajes'].every((k) => yo.ENDPOINTS[k] === 'conversaciones.ver'));
}

// ============================================================================== lista, búsqueda y filtros
{
  const lista = (await get('t_dir', '/api/conversaciones')).json();
  const tel = lista.conversaciones.map((c) => c.telefono);
  check('La lista trae las conversaciones con teléfono completo', tel.includes(TA) && tel.includes(TB) && tel.includes(TC));
  check('La lista NO incluye al número oculto', !tel.includes(OCULTO) && !JSON.stringify(lista).includes('SECRETO_INTERNO'));
  check('Más reciente primero', lista.conversaciones.every((c, i, a) => i === 0 || a[i - 1].ultimo_id > c.ultimo_id));
  const ana = lista.conversaciones.find((c) => c.telefono === TA);
  check('Resuelve nombre y documento del paciente', ana.nombre === 'Ana Prueba Uno' && ana.documento === 'TSTC001' && ana.pacientes_n === 1);
  check('Trae el extracto, el flujo y el aviso de retención', ana.extracto === 'Gracias a ustedes' && lista.retencion_dias === 30 && !!lista.ahora);
  check('Sin paciente identificado → nombre null', lista.conversaciones.find((c) => c.telefono === TC).nombre === null);

  const buscar = async (q) => (await get('t_dir', `/api/conversaciones?buscar=${encodeURIComponent(q)}`)).json().conversaciones.map((c) => c.telefono);
  check('Búsqueda por teléfono de 10 dígitos', (await buscar('3001110001')).join() === TA);
  check('Búsqueda por teléfono completo', (await buscar(TA)).join() === TA);
  check('Búsqueda por documento', (await buscar('TSTC002')).join() === TB);
  check('Búsqueda por nombre (sin distinguir mayúsculas ni tildes de caso)', (await buscar('ana prueba')).join() === TA);
  check('Buscar el número oculto no lo revela', (await buscar(OCULTO)).length === 0 && (await buscar('3009990000')).length === 0);
  check('% y _ en la búsqueda se tratan como texto, no como comodines', (await buscar('%')).length === 0 && (await buscar('A_a')).length === 0);

  const filtro = async (f) => (await get('t_dir', `/api/conversaciones?filtro=${f}`)).json().conversaciones.map((c) => c.telefono);
  check('Filtro crisis', (await filtro('crisis')).join() === TB);
  check('Filtro error de entrega', (await filtro('error')).join() === TC);
  check('Filtro respondieron a una plantilla', (await filtro('plantilla')).join() === TA);
  check('Filtro activas ahora (menos de 15 min)', (await filtro('activas')).length >= 3);
  check('Filtro hoy', (await filtro('hoy')).length >= 3);
  check('Filtro desconocido → 400', (await get('t_dir', '/api/conversaciones?filtro=zzz')).statusCode === 400);
  check('limite se acota (1..100) y desde_id filtra', (await get('t_dir', '/api/conversaciones?limite=1')).json().conversaciones.length === 1
    && (await get('t_dir', `/api/conversaciones?desde_id=${lista.max_id + 10_000}`)).json().conversaciones.length === 0);
  check('desde_id no numérico → 400', (await get('t_dir', '/api/conversaciones?desde_id=abc')).statusCode === 400);
}

// ======================================================================== apertura, páginas y auditoría
let aperturasAntes;
{
  aperturasAntes = (await actividadMia('t_dir', '%conversaciones%')).length;
  const r = await get('t_dir', `/api/conversaciones/${TA}/mensajes`);
  const o = r.json();
  check('Apertura: 200 con encabezado, mensajes en orden y cursor', r.statusCode === 200 && o.conversacion.nombre === 'Ana Prueba Uno'
    && o.mensajes.length === 4 && o.mensajes.every((m, i, a) => i === 0 || a[i - 1].id < m.id) && o.max_id >= o.mensajes[3].id && o.hay_mas === false);
  check('El mensaje no expone telefono_norm ni mensaje_uid', !('telefono_norm' in o.mensajes[0]) && !('mensaje_uid' in o.mensajes[0]));
  check('La plantilla trae su nombre y sus parámetros en contenido', o.mensajes[0].tipo === 'plantilla' && o.mensajes[0].plantilla === 'recordatorio_2h_botones' && o.mensajes[0].texto === null);
  check('El botón del paciente llega como botón con su payload', o.mensajes[1].tipo === 'boton' && o.mensajes[1].contenido.payload === 'LEREC:abc:C');

  const pag = (await get('t_dir', `/api/conversaciones/${TA}/mensajes?limite=2`)).json();
  check('limite=2 → los 2 últimos y hay_mas', pag.mensajes.length === 2 && pag.hay_mas === true);
  const atras = (await get('t_dir', `/api/conversaciones/${TA}/mensajes?limite=2&antes_id=${pag.mensajes[0].id}`)).json();
  check('antes_id pagina hacia atrás sin repetir y sin más', atras.mensajes.length === 2 && atras.mensajes[1].id < pag.mensajes[0].id && atras.hay_mas === false);

  check('Teléfono de 10 dígitos se normaliza', (await get('t_dir', '/api/conversaciones/3001110001/mensajes')).statusCode === 200);
  check('Teléfono inválido → 400', (await get('t_dir', '/api/conversaciones/abc/mensajes')).statusCode === 400
    && (await get('t_dir', '/api/conversaciones/123/mensajes')).statusCode === 400
    && (await get('t_dir', `/api/conversaciones/${TA}%27%20OR%201=1--/mensajes`)).statusCode === 400);
  check('antes_id y despues_id a la vez → 400', (await get('t_dir', `/api/conversaciones/${TA}/mensajes?antes_id=1&despues_id=1`)).statusCode === 400);
  check('Conversación inexistente → 404', (await get('t_dir', '/api/conversaciones/573119999999/mensajes')).statusCode === 404);
  const oculto = await get('t_dir', `/api/conversaciones/${OCULTO}/mensajes`);
  check('Número oculto por URL directa → 404 (igual que uno inexistente), sin su contenido',
    oculto.statusCode === 404 && !oculto.body.includes('SECRETO') && oculto.json().error === (await get('t_dir', '/api/conversaciones/573119999999/mensajes')).json().error);
  check('Los % y _ del texto se conservan tal cual', (await get('t_dir', `/api/conversaciones/${T_ESCAPE}/mensajes`)).json().mensajes[0].texto === '100% seguro_ ok');
}

// ==================================================== sondeo compartido: mensajes nuevos y carga constante
{
  const ultimo = (await get('t_dir', `/api/conversaciones/${TA}/mensajes`)).json().max_id;
  await get('t_dir', `/api/conversaciones/${TA}/mensajes?despues_id=${ultimo}`);
  await Q(`INSERT INTO mensajes_conversacion (mensaje_uid, telefono_norm, direccion, origen, tipo, texto, ocurrido_at)
           VALUES (gen_random_uuid(), '${TA}', 'entrante', 'paciente', 'texto', 'NUEVO_EN_VIVO', now()),
                  (gen_random_uuid(), '${OCULTO}', 'entrante', 'paciente', 'texto', 'NUEVO_OCULTO', now())`);
  await espera(1600);
  const nuevos = (await get('t_dir', `/api/conversaciones/${TA}/mensajes?despues_id=${ultimo}`)).json();
  check('despues_id trae el mensaje nuevo en pocos segundos', nuevos.mensajes.length === 1 && nuevos.mensajes[0].texto === 'NUEVO_EN_VIVO' && nuevos.max_id > ultimo);
  check('despues_id sin novedades → vacío y mismo cursor', (await get('t_dir', `/api/conversaciones/${TA}/mensajes?despues_id=${nuevos.max_id}`)).json().mensajes.length === 0);
  const cur = (await get('t_dir', `/api/conversaciones/cursor?desde_id=${ultimo}`)).json();
  check('cursor: dice qué teléfonos cambiaron y no menciona al oculto', cur.completo && cur.telefonos.includes(TA) && !cur.telefonos.includes(OCULTO) && cur.max_id >= nuevos.max_id);
  check('cursor con un id anterior al buffer pide volver a cargar la lista', (await get('t_dir', '/api/conversaciones/cursor?desde_id=0')).json().completo === false || _estadoBufferParaPruebas().base === 0);
  check('El mensaje oculto nunca sale del buffer', !JSON.stringify((await get('t_dir', `/api/conversaciones/${OCULTO}/mensajes?despues_id=0`)).json()).includes('NUEVO_OCULTO'));

  // Estados de entrega: el UPDATE (el backend actualiza la fila saliente) llega en la siguiente consulta.
  const antes = (await get('t_dir', `/api/conversaciones/${TA}/mensajes?despues_id=${nuevos.max_id}`)).json();
  check('despues_id incluye el estado de los últimos salientes', antes.estados.some((e) => e.estado_envio === 'delivered'));
  await Q(`UPDATE mensajes_conversacion SET estado_envio = 'read' WHERE wa_message_id = 'wamid.A2'`);
  await espera(2200);
  const despues = (await get('t_dir', `/api/conversaciones/${TA}/mensajes?despues_id=${nuevos.max_id}`)).json();
  check('Un cambio de estado (✓✓ → leído) llega sin mensajes nuevos', despues.estados.find((e) => e.estado_envio === 'read' && e.id) !== undefined);

  // Carga constante: 1 persona frente a 5 personas, 4 s de sondeo cada 1 s.
  const medir = async (personas) => {
    const base = sondeos();
    for (let t = 0; t < 4; t++) {
      await Promise.all(Array.from({ length: personas }, () => get('t_dir', `/api/conversaciones/${TA}/mensajes?despues_id=${nuevos.max_id}`)));
      await espera(1000);
    }
    return sondeos() - base;
  };
  const una = await medir(1);
  const cinco = await medir(5);
  check(`Carga constante: ${una} sondeos con 1 persona y ${cinco} con 5 (no crece con los usuarios)`, Math.abs(cinco - una) <= 3 && cinco <= 12);

  // Sin peticiones durante INACTIVIDAD el sondeo se detiene.
  await espera(4500);
  const parado = sondeos();
  await espera(2500);
  check('Sin nadie mirando, no se consulta nada', sondeos() === parado);
  // Al volver, el buffer se pone al día antes de responder (aunque el tick estuviera detenido).
  await Q(`INSERT INTO mensajes_conversacion (mensaje_uid, telefono_norm, direccion, origen, tipo, texto, ocurrido_at)
           VALUES (gen_random_uuid(), '${TA}', 'saliente', 'bot_flujo', 'texto', 'TRAS_PAUSA', now())`);
  const tras = (await get('t_dir', `/api/conversaciones/${TA}/mensajes?despues_id=${nuevos.max_id}`)).json();
  check('Tras una pausa, la primera petición ya trae lo que pasó mientras tanto', tras.mensajes.some((m) => m.texto === 'TRAS_PAUSA'));

  // El cursor viejo (anterior al buffer) cae a la base de datos.
  _reiniciarParaPruebas();
  await get('t_dir', '/api/conversaciones/cursor');
  await Q(`INSERT INTO mensajes_conversacion (mensaje_uid, telefono_norm, direccion, origen, tipo, texto, ocurrido_at)
           SELECT gen_random_uuid(), '${TA}', 'entrante', 'paciente', 'texto', 'bulk ' || g, now() FROM generate_series(1, 2300) g`);
  await espera(1600);
  const viejo = (await get('t_dir', `/api/conversaciones/${TA}/mensajes?despues_id=${ultimo}`)).json();
  check('Con el cursor más atrás del buffer (2000 filas) lee de la base, tope 500 por respuesta', viejo.mensajes.length === 500 && viejo.max_id > ultimo);
}

// ===================================================================== auditoría (D4) y permisos de lectura
{
  await volcarActividad();
  const aperturas = (await actividadMia('t_dir', '%:telefono/mensajes%')).filter((f) => /^Abrió la conversación \d+$/.test(f.detalle ?? ''));
  const sondeosRegistrados = (await actividadMia('t_dir', '%conversaciones%')).filter((f) => !(f.detalle ?? '').startsWith('Abrió') && (f.status ?? 0) < 400);
  check('Cada apertura de una conversación queda en panel.actividad con el teléfono', aperturas.length >= 5 && aperturas.some((f) => f.detalle.endsWith(TA)));
  check('Los sondeos exitosos (lista, cursor, despues_id, antes_id) NO se registran', sondeosRegistrados.length === 0);
  const denegados = await actividadMia('t_rel', '%conversaciones%');
  check('Un intento denegado sí queda registrado', denegados.length > 0 && denegados.every((f) => f.status === 403));
  check('La apertura de este grupo no se registró para quien no pudo abrir', (await actividadMia('t_ana', '%:telefono/mensajes%')).every((f) => f.status === 403));
  check('Ningún evento de auditoría guarda texto de mensajes', !JSON.stringify((await poolApp.query(`SELECT detalle FROM panel.actividad`)).rows).includes('Confirmo asistencia'));

  // panel_lectura solo ve las vistas, no la tabla base.
  let denegadoTabla = false;
  try { await pool.query('SELECT 1 FROM mensajes_conversacion LIMIT 1'); } catch (e) { denegadoTabla = e.code === '42501'; }
  check('El rol de lectura NO puede leer la tabla base mensajes_conversacion (solo las vistas)', denegadoTabla);
  let escritura = false;
  try { await pool.query(`DELETE FROM historial.v_mensajes`); } catch { escritura = true; }
  check('El rol de lectura no puede escribir', escritura);
}

// ======================================================================= esquema ausente → 503 claro
{
  await Q(`ALTER VIEW historial.v_mensajes RENAME TO v_mensajes_x`);
  _reiniciarParaPruebas();
  const r = await get('t_dir', '/api/conversaciones/cursor');
  await Q(`ALTER VIEW historial.v_mensajes_x RENAME TO v_mensajes`);
  check('Si el esquema historial no está listo → 503 con mensaje claro (no 500)', r.statusCode === 503 && /todavía no está disponible/.test(r.json().error));
  _reiniciarParaPruebas();
  check('Y se recupera solo cuando aparece', (await get('t_dir', '/api/conversaciones/cursor')).statusCode === 200);
}

// ---------------------------------------------------------------------------------------------- limpieza
await app.close();
_reiniciarParaPruebas(); // detiene el sondeo antes de cerrar los pools
await pool.end();
await poolApp.end();
await Q(`DELETE FROM pacientes WHERE numero_documento LIKE 'TSTC%'`);
await Q(`TRUNCATE mensajes_conversacion, conversaciones_resumen RESTART IDENTITY`);
await Q(`DROP SCHEMA IF EXISTS panel CASCADE`);
for (const rol of ['panel_t_lectura', 'panel_t_app']) {
  await Q(`REVOKE ALL ON ALL TABLES IN SCHEMA bi, historial FROM ${rol}`).catch(() => {});
  await Q(`REVOKE ALL ON SCHEMA bi, historial, public FROM ${rol}`).catch(() => {});
  await Q(`REVOKE ALL ON DATABASE ${nombreBd} FROM ${rol}`).catch(() => {});
  await Q(`DROP ROLE IF EXISTS ${rol}`).catch((e) => console.warn(`No se pudo borrar el rol ${rol}: ${e.message}`));
}
await adm.end();

console.log(`Conversaciones: ${comprobaciones.length} comprobaciones OK`);
process.exit(0);
