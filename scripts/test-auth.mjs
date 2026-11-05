// Prueba de integración del login propio del panel (server/auth/*, server/routes/auth.ts, server/acceso.ts).
// Especificación: proyecto-ips/docs/features/2026-11-04-panel-login-autenticacion.md, sección 18.
//
// Usa Postgres REAL y los hooks y rutas REALES (cookie, cabeceras, acceso, auth, soporte...), con DATOS SINTÉTICOS y
// el proveedor de correo `memoria`. Necesita una base DESECHABLE:
//   TEST_ADMIN_URL=postgres://admin:...@127.0.0.1:5437/auth_test npm run test:auth
// Sin TEST_ADMIN_URL se omite (sale con 0). Por seguridad exige que la base se llame *_test: recrea el esquema `panel`
// y los roles panel_t_lectura / panel_t_app (con contraseñas aleatorias de la corrida). NUNCA apuntarla a producción
// ni a un volumen local con datos reales.
//
// El tiempo no se simula con `sleep`: se editan las fechas en la base y se vacía la caché de sesiones.
// Nada de esto toca Globho ni envía WhatsApp ni correo real.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';

const ADMIN = process.env.TEST_ADMIN_URL;
if (!ADMIN) {
  console.log('test:auth omitido: defina TEST_ADMIN_URL (base desechable *_test).');
  process.exit(0);
}
const nombreBd = new URL(ADMIN).pathname.slice(1);
assert.ok(nombreBd.endsWith('_test'), `Por seguridad la base debe terminar en _test (es "${nombreBd}")`);

// ----------------------------------------------------------------------------------------- registro de salidas
// Todo lo que el servidor escriba en consola se revisa al final: ninguna contraseña, código ni token puede aparecer.
const salidas = [];
for (const m of ['log', 'error', 'warn', 'info']) {
  const original = console[m].bind(console);
  console[m] = (...a) => {
    salidas.push(a.map(String).join(' '));
    original(...a);
  };
}
const SECRETOS = [];
const secreto = (v) => (SECRETOS.push(v), v);

// ------------------------------------------------------------------------ roles y esquema `panel` (desechables)
const { default: pg } = await import('pg');
const adm = new pg.Pool({ connectionString: ADMIN, max: 2 });
const Q = (sql, p = []) => adm.query(sql, p).then((r) => r.rows);
const claveBd = randomUUID().replace(/-/g, '');
const urlRol = (rol) => {
  const u = new URL(ADMIN);
  u.username = rol;
  u.password = claveBd;
  return u.toString();
};
for (const rol of ['panel_t_lectura', 'panel_t_app']) {
  await Q(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${rol}') THEN CREATE ROLE ${rol} LOGIN; END IF; END $$`);
  await Q(`ALTER ROLE ${rol} PASSWORD '${claveBd}'`);
}
await Q(`ALTER ROLE panel_t_lectura SET default_transaction_read_only = on`);
await Q(`GRANT CONNECT ON DATABASE ${nombreBd} TO panel_t_lectura, panel_t_app`);
await Q(`GRANT USAGE ON SCHEMA public TO panel_t_lectura, panel_t_app`);
await Q(`DROP SCHEMA IF EXISTS panel CASCADE`);
await Q(`CREATE SCHEMA panel AUTHORIZATION panel_t_app`);

// Entorno del servidor de la prueba. PANEL_AUTH_MODO queda SIN definir a propósito: el valor por defecto es `sesion`.
const SECRETO_AUTH = randomBytes(32).toString('base64');
delete process.env.PANEL_AUTH_MODO;
delete process.env.NODE_ENV;
process.env.DATABASE_URL = urlRol('panel_t_lectura');
process.env.DATABASE_URL_APP = urlRol('panel_t_app');
process.env.PANEL_AUTH_SECRET = SECRETO_AUTH;
process.env.EMAIL_PROVEEDOR = 'memoria';
process.env.VIGILANTE = 'off';
// El envío manual llamaría al bot REAL de producción si estas variables no apuntaran a un puerto cerrado.
process.env.PANEL_BOT_URL = 'http://127.0.0.1:9';
for (const v of ['VIGILANTE_BACKEND_URL', 'VIGILANTE_SCRAPER_URL', 'VIGILANTE_BOT_URL']) process.env[v] = '';

const { pool, poolApp } = await import('../server/db.ts');
const { prepararEsquema } = await import('../server/esquema.ts');
const { instalarAcceso, invalidarConfig, volcarActividad, estadoPaginas } = await import('../server/acceso.ts');
const { instalarCabeceras, CSP } = await import('../server/cabeceras.ts');
const { manejarError } = await import('../server/errores.ts');
const { ENDPOINTS } = await import('../server/funciones.ts');
const { modoAuth, validarConfiguracion } = await import('../server/auth/configuracion.ts');
const { hashear, verificar, generarTemporal } = await import('../server/auth/contrasenas.ts');
const { cumplePolitica } = await import('../server/auth/politica.ts');
const { esClaveProhibida } = await import('../server/auth/claves-comunes.ts');
const { vaciarLimites, limites } = await import('../server/auth/limites.ts');
const { _vaciarCacheSesiones, volcarSesiones } = await import('../server/auth/sesiones.ts');
const { mensajesEnMemoria } = await import('../server/auth/correo.ts');
const { limpiar, ejecutarVigilante } = await import('../server/vigilante.ts');
const { ipDe } = await import('../server/auth/red.ts');
const { default: Fastify } = await import('fastify');
const { default: fastifyCookie } = await import('@fastify/cookie');

await prepararEsquema(() => {});

// ---------------------------------------------------------------------------------------------- usuarios
const CLAVE = secreto('Clave#Segura1');
const HASH = await hashear(CLAVE);
await poolApp.query(`DELETE FROM panel.usuarios WHERE usuario IN ('gerencia', 'analista', 'marketing')`);
await poolApp.query(
  `INSERT INTO panel.usuarios (usuario, rol, nombre, correo, prioridad, activo) VALUES
     ('t_sop', 'soporte', 'Soporte prueba', 't_sop@test.local', 0, true),
     ('t_dir', 'direccion', 'Dirección prueba', 'carmen.rojas@test.local', 1, true),
     ('t_ope', 'operacion', 'Operación prueba', 'ope@test.local', 5, true),
     ('t_ana', 'analista', 'Analista prueba', 'otro@test.local', 4, true),
     ('t_inactivo', 'direccion', 'Inactivo', 'inactivo@test.local', 7, false),
     ('t_sincred', 'analista', 'Sin credencial', 'sincred@test.local', 6, true)`,
);
for (const u of ['t_sop', 't_dir', 't_ope', 't_ana', 't_inactivo']) {
  await poolApp.query(`INSERT INTO panel.credenciales (usuario, hash, debe_cambiar) VALUES ($1, $2, false)`, [u, HASH]);
}
const nivel = async (nv) => {
  await poolApp.query(`UPDATE panel.licencia SET nivel = $1 WHERE id = 1`, [nv]);
  invalidarConfig();
};
await nivel('full');

// ---------------------------------------------------------------------------------------------- servidor
const ORIGEN = 'http://panel.test';
const HOST = 'panel.test';
const rutasReales = [];
const app = Fastify();
app.addHook('onRoute', (o) => {
  for (const m of [].concat(o.method)) if (m !== 'HEAD' && o.url.startsWith('/api/')) rutasReales.push([m, o.url]);
});
app.setErrorHandler((e, rq, rp) => {
  if (process.env.DEPURAR && !e.statusCode && !e.codigo) console.error('ERROR NO CONTROLADO', e);
  return manejarError(e, rq, rp);
});
await app.register(fastifyCookie);
instalarCabeceras(app);
instalarAcceso(app);
const RUTAS = [
  'plan', 'resumen', 'campanas', 'agenda', 'chatbot', 'listaEspera', 'pacientes', 'sistema', 'profesionales', 'alertas',
  'campanas2', 'oleada2', 'soporte', 'sala', 'historias', 'capacidad', 'informe', 'inteligencia', 'envios', 'conversaciones', 'auth',
];
for (const r of RUTAS) await app.register((await import(`../server/routes/${r}.ts`)).default);
app.get('/api/health', async () => ({ ok: true }));
app.get('/api/incidentes', async () => ({ incidentes: [] }));
app.get('/pagina', async () => 'html');
await app.ready();

// ---------------------------------------------------------------------------------------------- utilidades
const comprobaciones = [];
const check = (etiqueta, condicion) => {
  assert.ok(condicion, etiqueta);
  comprobaciones.push(etiqueta);
};
let contadorIp = 0;
const ipNueva = () => `10.${Math.floor(contadorIp / 250) + 1}.${(contadorIp++ % 250) + 1}.7`;

const pedir = (metodo, url, { cookie, headers, payload, ip, sinOrigen } = {}) =>
  app.inject({
    method: metodo,
    url,
    headers: {
      host: HOST,
      ...(metodo !== 'GET' && !sinOrigen ? { origin: ORIGEN } : {}),
      ...(cookie ? { cookie } : {}),
      'x-real-ip': ip ?? '10.0.0.1',
      ...headers,
    },
    payload,
  });
const nombreCookie = () => (process.env.NODE_ENV === 'production' ? '__Host-panel_sesion' : 'panel_sesion');
const cookieDe = (res) => {
  const c = (res.cookies ?? []).find((x) => x.name === nombreCookie());
  return c && c.value ? `${c.name}=${c.value}` : null;
};
const valorCookie = (cookie) => cookie.slice(cookie.indexOf('=') + 1);
const sha = (t) => createHash('sha256').update(t).digest();
const idSesion = async (cookie) => (await poolApp.query(`SELECT id FROM panel.sesiones WHERE token_hash = $1`, [sha(valorCookie(cookie))])).rows[0]?.id;

async function entrar(usuario, contrasena = CLAVE, extra = {}) {
  const res = await pedir('POST', '/api/auth/login', { payload: { usuario, contrasena, ...extra.cuerpo }, ip: extra.ip ?? ipNueva() });
  return { res, cookie: cookieDe(res), json: res.statusCode === 200 ? res.json() : null };
}
const yo = async (cookie, headers) => (await pedir('GET', '/api/yo', { cookie, headers })).json();
const eventos = (tipo, usuario) =>
  poolApp.query(`SELECT * FROM panel.eventos_autenticacion WHERE tipo = $1 AND ($2::text IS NULL OR usuario = $2) ORDER BY id`, [tipo, usuario ?? null]).then((r) => r.rows);

/** Edita las fechas de una sesión y vacía la caché: el equivalente a que haya pasado el tiempo. */
async function envejecer(cookie, { inactivoMin, expiraEnMin }) {
  const id = await idSesion(cookie);
  if (inactivoMin !== undefined) await poolApp.query(`UPDATE panel.sesiones SET ultima_actividad_at = now() - ($2 || ' minutes')::interval WHERE id = $1`, [id, String(inactivoMin)]);
  if (expiraEnMin !== undefined) await poolApp.query(`UPDATE panel.sesiones SET expira_at = now() + ($2 || ' minutes')::interval WHERE id = $1`, [id, String(expiraEnMin)]);
  _vaciarCacheSesiones();
}
const filaSesion = async (cookie) => (await poolApp.query(`SELECT * FROM panel.sesiones WHERE token_hash = $1`, [sha(valorCookie(cookie))])).rows[0];
const espera = async (cond, ms = 5000) => {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};
const mediana = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
async function medir(fn, n = 5) {
  const t = [];
  for (let i = 0; i < n; i++) {
    const a = performance.now();
    await fn(i);
    t.push(performance.now() - a);
  }
  return mediana(t);
}
function correr(archivo, args, env, { timeoutMs = 90_000 } = {}) {
  return new Promise((resolver) => {
    const entorno = { ...process.env };
    for (const [k, v] of Object.entries(env)) v === undefined ? delete entorno[k] : (entorno[k] = v);
    const hijo = spawn(process.execPath, ['--import', 'tsx', archivo, ...args], { env: entorno, cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    hijo.stdout.on('data', (d) => (stdout += d));
    hijo.stderr.on('data', (d) => (stderr += d));
    const t = setTimeout(() => hijo.kill(), timeoutMs);
    hijo.on('exit', (code) => (clearTimeout(t), resolver({ code, stdout, stderr })));
  });
}
const puertoLibre = () =>
  new Promise((resolver) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolver(port));
    });
  });
const ENTORNO_BASE = {
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_URL_APP: process.env.DATABASE_URL_APP,
  PANEL_AUTH_SECRET: SECRETO_AUTH,
  PANEL_AUTH_MODO: undefined,
  NODE_ENV: undefined,
  EMAIL_PROVEEDOR: 'memoria',
  VIGILANTE: 'off',
  PANEL_BOT_URL: 'http://127.0.0.1:9',
};

// ========================================================================================= 1. configuración
{
  check('Modo por defecto sin variable: sesion', modoAuth() === 'sesion');
  process.env.PANEL_AUTH_MODO = '';
  check('Variable vacía: sesion (olvidarla jamás abre el panel)', modoAuth() === 'sesion');
  process.env.PANEL_AUTH_MODO = 'nginx';
  check('Modo nginx solo con el valor exacto', modoAuth() === 'nginx');
  process.env.PANEL_AUTH_MODO = 'abierto';
  assert.throws(() => modoAuth(), /PANEL_AUTH_MODO/);
  assert.throws(() => validarConfiguracion(), /PANEL_AUTH_MODO/);
  check('Modo inválido: lanza error', true);
  delete process.env.PANEL_AUTH_MODO;

  const inv = await correr('server/index.ts', [], { ...ENTORNO_BASE, PANEL_AUTH_MODO: 'abierto', PORT: String(await puertoLibre()) });
  check('Modo inválido: el proceso no arranca (código 1)', inv.code === 1 && /PANEL_AUTH_MODO/.test(inv.stderr));
  const sinSecreto = await correr('server/index.ts', [], { ...ENTORNO_BASE, PANEL_AUTH_SECRET: undefined, PORT: String(await puertoLibre()) });
  check('Sin PANEL_AUTH_SECRET el proceso no arranca y no revela valores', sinSecreto.code === 1 && /PANEL_AUTH_SECRET/.test(sinSecreto.stderr) && !sinSecreto.stderr.includes(SECRETO_AUTH));
  const secretoCorto = await correr('server/index.ts', [], { ...ENTORNO_BASE, PANEL_AUTH_SECRET: Buffer.from('corto').toString('base64'), PORT: String(await puertoLibre()) });
  check('Un secreto de menos de 32 bytes tampoco arranca', secretoCorto.code === 1);
  const sinBd = await correr('server/index.ts', [], { ...ENTORNO_BASE, DATABASE_URL_APP: undefined, PORT: String(await puertoLibre()) });
  check('Sin DATABASE_URL_APP el proceso no arranca (no hay modo legado en sesion)', sinBd.code === 1 && /DATABASE_URL_APP/.test(sinBd.stderr));
  const bdCaida = await correr('server/index.ts', [], { ...ENTORNO_BASE, DATABASE_URL_APP: 'postgres://x:y@127.0.0.1:1/z', PORT: String(await puertoLibre()) });
  check('Un fallo de esquema en modo sesion termina el proceso', bdCaida.code === 1);
}

// ============================================================================ 2. bypass y control de acceso (bloqueantes)
{
  const publicas = new Set(['GET /api/health', 'POST /api/auth/login', 'POST /api/auth/logout', 'POST /api/auth/recuperar/solicitar', 'POST /api/auth/recuperar/verificar', 'POST /api/auth/recuperar/restablecer']);
  const protegidas = rutasReales.filter(([m, u]) => !publicas.has(`${m} ${u}`));
  check(`Hay rutas protegidas que probar (${protegidas.length})`, protegidas.length > 60);
  check('Todas las claves de ENDPOINTS existen como rutas reales', Object.keys(ENDPOINTS).every((k) => rutasReales.some(([m, u]) => `${m} ${u}` === k)));
  for (const [m, u] of protegidas) {
    const url = u.replace(/:\w+/g, 'x');
    const res = await pedir(m, url, { headers: { 'x-remote-user': 't_sop', 'x-panel-vista-nivel': 'full' }, payload: m === 'GET' ? undefined : {} });
    assert.equal(res.statusCode, 401, `${m} ${u} con x-remote-user y sin cookie debe dar 401 (dio ${res.statusCode})`);
    assert.equal(res.json().codigo, 'sesion', `${m} ${u}`);
  }
  check('x-remote-user: t_sop sin cookie da 401 en TODAS las rutas protegidas (ENDPOINTS, /api/soporte/*, /api/yo, /api/incidentes, /api/actividad)', true);

  // El enrutador decodifica la URL: /%61pi/resumen llega a la ruta /api/resumen. El control debe decidir por la ruta
  // resuelta, nunca por el texto de req.url, o estas variantes se saltan toda la autenticación (hallazgo R1).
  const VARIANTES = [(u) => u.replace('/api/', '/%61pi/'), (u) => u.replace('/api/', '/ap%69/'), (u) => u.replace('/api/', '/%61%70%69/')];
  const filasEnvios = async () => (await poolApp.query(`SELECT count(*)::int AS n FROM panel.envios_manuales`)).rows[0].n;
  const enviosAntes = await filasEnvios();
  for (const [m, u] of protegidas) {
    const base = u.replace(/:\w+/g, 'x');
    for (const variante of VARIANTES) {
      const url = variante(base);
      // Cuerpo vacío a propósito: si el control fallara, la validación detiene la petición antes de cualquier efecto.
      const res = await pedir(m, url, { headers: { 'x-remote-user': 't_sop' }, payload: m === 'GET' ? undefined : {} });
      assert.equal(res.statusCode, 401, `${m} ${url} sin cookie debe dar 401 (dio ${res.statusCode})`);
      if (m !== 'GET' && m !== 'HEAD') {
        const sinOrigen = await pedir(m, url, { sinOrigen: true, payload: {} });
        assert.equal(sinOrigen.statusCode, 403, `${m} ${url} sin Origin debe dar 403 (dio ${sinOrigen.statusCode})`);
      }
      assert.equal(res.headers['cache-control'], 'no-store', `${m} ${url} debe llevar no-store`);
    }
  }
  check('URL codificada (/%61pi, /ap%69, /%61%70%69): 401 en TODAS las rutas protegidas, y 403 en escrituras sin Origin', true);
  const envioCodificado = await pedir('POST', '/%61pi/envios/invitacion/ejecutar', { payload: { limite: 1 } });
  check('Un anónimo no puede lanzar un envío a pacientes con la URL codificada', envioCodificado.statusCode === 401 && (await filasEnvios()) === enviosAntes);
  check('Login por URL codificada sin Origin: 403', (await pedir('POST', '/%61pi/auth/login', { sinOrigen: true, payload: { usuario: 'x', contrasena: 'y' } })).statusCode === 403);

  const { cookie } = await entrar('t_dir');
  const ver = await yo(cookie, { 'x-remote-user': 't_sop' });
  check('Cookie válida más x-remote-user de otro: manda la identidad de la cookie', ver.usuario === 't_dir' && ver.rolReal === 'direccion');
  const soporteFalso = await pedir('GET', '/api/soporte/usuarios', { cookie, headers: { 'x-remote-user': 't_sop' } });
  check('Cookie de un usuario no soporte + x-remote-user: soporte sigue dando 403', soporteFalso.statusCode === 403);

  const alterada = cookie.slice(0, -1) + (cookie.endsWith('A') ? 'B' : 'A');
  check('Cookie alterada: 401', (await pedir('GET', '/api/yo', { cookie: alterada })).statusCode === 401);
  const venc = await entrar('t_dir');
  await envejecer(venc.cookie, { expiraEnMin: -1 });
  check('Cookie vencida: 401', (await pedir('GET', '/api/yo', { cookie: venc.cookie })).statusCode === 401);
  const cerr = await entrar('t_dir');
  await pedir('POST', '/api/auth/logout', { cookie: cerr.cookie });
  check('Cookie cerrada: 401', (await pedir('GET', '/api/yo', { cookie: cerr.cookie })).statusCode === 401);

  const sop = await entrar('t_sop');
  const prevSop = await yo(sop.cookie, { 'x-panel-vista-nivel': 'basico', 'x-panel-vista-rol': 'analista' });
  const prevDir = await yo(cookie, { 'x-panel-vista-nivel': 'basico', 'x-panel-vista-rol': 'analista' });
  check('Vista previa: funciona con sesión de soporte', prevSop.vistaPrevia === true && prevSop.nivel === 'basico');
  check('Vista previa: se ignora para quien no es soporte', prevDir.vistaPrevia === false && prevDir.nivel === 'full');
}

// ====================================================================================================== 3. login
{
  vaciarLimites();
  const porUsuario = await entrar('t_dir');
  check('Login con usuario: 200', porUsuario.res.statusCode === 200 && porUsuario.json.debeCambiar === false);
  const porCorreo = await entrar('carmen.rojas@test.local');
  check('Login con correo: 200', porCorreo.res.statusCode === 200);
  const mayus = await entrar('  T_DIR ');
  check('Login sin distinguir mayúsculas ni espacios en el usuario', mayus.res.statusCode === 200);
  const mayusCorreo = await entrar('CARMEN.ROJAS@TEST.LOCAL');
  check('Login con el correo en mayúsculas', mayusCorreo.res.statusCode === 200);
  check('La respuesta de login no contiene el hash ni el token', !JSON.stringify(porUsuario.json).includes('scrypt') && !porUsuario.res.body.includes(valorCookie(porUsuario.cookie)));

  // Misma respuesta exacta en los cuatro casos de falla (H23).
  const casos = {
    errada: ['t_dir', 'Otra#Clave9'],
    inexistente: ['no.existe', CLAVE],
    inactivo: ['t_inactivo', CLAVE],
    sinCredencial: ['t_sincred', CLAVE],
  };
  const respuestas = {};
  for (const [k, [u, c]] of Object.entries(casos)) respuestas[k] = await entrar(u, c);
  const cuerpos = Object.values(respuestas).map((r) => r.res.body);
  check('Contraseña errada, usuario inexistente, inactivo y sin credencial: misma respuesta exacta', Object.values(respuestas).every((r) => r.res.statusCode === 401) && new Set(cuerpos).size === 1);
  check('El error es el mensaje único "Usuario o contraseña incorrectos"', respuestas.errada.res.json().error === 'Usuario o contraseña incorrectos' && respuestas.errada.res.json().codigo === 'credenciales');

  // Tiempo similar entre los casos (scrypt domina en todos). Cada intento usa otra IP y otro usuario para no activar límites.
  const t = {};
  for (const [k, [u, c]] of Object.entries(casos)) t[k] = await medir((i) => entrar(k === 'inexistente' ? `fantasma${i}` : u, c), 3);
  const maxT = Math.max(...Object.values(t));
  const minT = Math.min(...Object.values(t));
  check(`Tiempo similar entre los casos de falla (${Math.round(minT)}-${Math.round(maxT)} ms)`, maxT - minT < 200);

  // Límites.
  vaciarLimites();
  const ip = ipNueva();
  const estados = [];
  for (let i = 0; i < 5; i++) estados.push((await entrar('t_dir', 'Mala#Clave1', { ip })).res);
  check('Hasta el cuarto fallo por identificador e IP responde 401', estados.slice(0, 4).every((r) => r.statusCode === 401));
  check('Quinto fallo por identificador e IP: 429 con Retry-After', estados[4].statusCode === 429 && Number(estados[4].headers['retry-after']) > 0 && estados[4].json().codigo === 'limite');
  const conCorrecta = await entrar('t_dir', CLAVE, { ip });
  check('Bloqueada esa combinación, ni la contraseña correcta entra', conCorrecta.res.statusCode === 429);
  const otraIp = await entrar('t_dir', CLAVE);
  check('Desde otra IP la misma cuenta sí entra (el bloqueo es por identificador+IP)', otraIp.res.statusCode === 200);
  vaciarLimites();
  let ultimo;
  for (let i = 0; i < 5; i++) ultimo = (await entrar('cuenta.fantasma', 'x', { ip })).res;
  check('Quinto fallo con una cuenta inexistente: también 429 (el límite no revela nada)', ultimo.statusCode === 429);
  vaciarLimites();
  for (let i = 0; i < 19; i++) await entrar(`u${i}`, 'x', { ip: '10.9.9.9' });
  check('Veinte fallos desde una IP: 429 aunque cambie de usuario', (await entrar('otro.mas', 'x', { ip: '10.9.9.9' })).res.statusCode === 429);
  vaciarLimites();
  for (let i = 0; i < 19; i++) await entrar('t_ope', 'x', { ip: ipNueva() });
  const bloq = await entrar('t_ope', 'x', { ip: ipNueva() });
  check('Veinte fallos de un identificador desde IP distintas: 429', bloq.res.statusCode === 429);
  check('Y queda el evento cuenta_bloqueada de esa cuenta', (await eventos('cuenta_bloqueada', 't_ope')).length >= 1);
  vaciarLimites();

  // Evento: nunca se guarda lo escrito en el campo de usuario si no existe.
  const pegada = secreto('Contr4sena#EnElCampoUsuario');
  await entrar(pegada, 'x');
  const fantasmas = await poolApp.query(`SELECT * FROM panel.eventos_autenticacion WHERE tipo = 'login_fallido' AND usuario IS NULL`);
  check('Un identificador inexistente se registra con usuario NULL', fantasmas.rows.length >= 1);
  const todo = JSON.stringify((await poolApp.query(`SELECT * FROM panel.eventos_autenticacion`)).rows);
  check('Lo escrito en el campo usuario (una contraseña pegada por error) no se guarda en ningún evento', !todo.includes(pegada));
  vaciarLimites();

  // Temporal vencida.
  await poolApp.query(`UPDATE panel.credenciales SET debe_cambiar = true, temporal_expira_at = now() - interval '1 minute' WHERE usuario = 't_ana'`);
  const venc = await entrar('t_ana');
  check('Temporal vencida con clave correcta: 403 temporal_vencida', venc.res.statusCode === 403 && venc.res.json().codigo === 'temporal_vencida' && !venc.cookie);
  await poolApp.query(`UPDATE panel.credenciales SET debe_cambiar = false, temporal_expira_at = NULL WHERE usuario = 't_ana'`);

  // debeCambiar.
  await poolApp.query(`UPDATE panel.credenciales SET debe_cambiar = true, temporal_expira_at = now() + interval '1 hour' WHERE usuario = 't_ana'`);
  const dc = await entrar('t_ana');
  check('Contraseña temporal vigente: entra y avisa debeCambiar', dc.res.statusCode === 200 && dc.json.debeCambiar === true);
  const otra = await pedir('GET', '/api/resumen', { cookie: dc.cookie });
  check('debeCambiar: las demás rutas dan 403 cambiar_contrasena', otra.statusCode === 403 && otra.json().codigo === 'cambiar_contrasena');
  check('debeCambiar: /api/yo funciona e informa debeCambiar', (await yo(dc.cookie)).debeCambiar === true);
  check('debeCambiar: el latido funciona', (await pedir('POST', '/api/auth/latido', { cookie: dc.cookie })).statusCode === 204);
  const sesionesTemp = await pedir('GET', '/api/auth/sesiones', { cookie: dc.cookie });
  check('debeCambiar: otras rutas de auth (sesiones) también se bloquean', sesionesTemp.statusCode === 403);
  const cambio = await pedir('POST', '/api/auth/contrasena', { cookie: dc.cookie, payload: { nueva: 'Nueva#Clave2026a' } });
  check('debeCambiar: cambiar sin la actual funciona', cambio.statusCode === 204);
  const cookieNueva = cookieDe(cambio);
  check('Tras cambiarla recibe cookie nueva y ya no debe cambiar', !!cookieNueva && cookieNueva !== dc.cookie && (await yo(cookieNueva)).debeCambiar === false);
  check('Con el token anterior ya no entra', (await pedir('GET', '/api/yo', { cookie: dc.cookie })).statusCode === 401);
  await poolApp.query(`UPDATE panel.credenciales SET hash = $2 WHERE usuario = $1`, ['t_ana', HASH]);
  _vaciarCacheSesiones();

  // Fuera del plan.
  await nivel('basico');
  const fuera = await entrar('t_ope');
  const verFuera = await yo(fuera.cookie);
  check('Usuario fuera del plan: entra, ve el mensaje y no tiene páginas', fuera.res.statusCode === 200 && verFuera.habilitado === false && /plan/i.test(verFuera.mensaje) && Object.keys(verFuera.paginas).length === 0);
  check('Usuario fuera del plan: puede salir', (await pedir('POST', '/api/auth/logout', { cookie: fuera.cookie })).statusCode === 204);
  check('Usuario fuera del plan: puede ver sus sesiones', (await pedir('GET', '/api/auth/sesiones', { cookie: (await entrar('t_ope')).cookie })).statusCode === 200);
  await nivel('full');

  // Cookie.
  const c = porUsuario.res.cookies.find((x) => x.name === 'panel_sesion');
  check('Cookie en desarrollo: HttpOnly, SameSite=Lax, Path=/, sin Domain, sin Max-Age', c.httpOnly && c.sameSite === 'Lax' && c.path === '/' && !c.domain && c.maxAge === undefined && !c.secure);
  const mant = await entrar('t_dir', CLAVE, { cuerpo: { mantener: true } });
  const cm = mant.res.cookies.find((x) => x.name === 'panel_sesion');
  check('Sesión mantenida: Max-Age de 7 días', cm.maxAge === 7 * 24 * 3600);
  process.env.NODE_ENV = 'production';
  const prod = await entrar('t_dir');
  const cp = prod.res.cookies.find((x) => x.name === '__Host-panel_sesion');
  check('Cookie en producción: nombre __Host-, Secure, HttpOnly, Lax, Path=/ y sin Domain', !!cp && cp.secure && cp.httpOnly && cp.sameSite === 'Lax' && cp.path === '/' && !cp.domain);
  check('En producción la cookie con otro nombre no sirve', (await pedir('GET', '/api/yo', { cookie: `panel_sesion=${valorCookie(prod.cookie)}` })).statusCode === 401);
  check('En producción: HSTS presente', /max-age=31536000/.test((await pedir('GET', '/api/health')).headers['strict-transport-security'] ?? ''));
  const salidaProd = await pedir('POST', '/api/auth/logout', { cookie: prod.cookie });
  const borrada = salidaProd.cookies.find((x) => x.name === '__Host-panel_sesion');
  check('Cerrar sesión borra la cookie con los mismos atributos', !!borrada && borrada.value === '' && borrada.secure && borrada.path === '/');
  delete process.env.NODE_ENV;
  check('Fuera de producción no hay HSTS', !(await pedir('GET', '/api/health')).headers['strict-transport-security']);
}

// ================================================================================================== 4. sesiones
{
  vaciarLimites();
  // Sondeos no renuevan; las peticiones normales y el latido sí.
  const s = await entrar('t_dir');
  await envejecer(s.cookie, { inactivoMin: 50 });
  const alSondear = await pedir('GET', '/api/yo', { cookie: s.cookie, headers: { 'x-panel-sondeo': '1' } });
  await volcarSesiones();
  const despuesSondeo = await filaSesion(s.cookie);
  check('Un sondeo (X-Panel-Sondeo) no renueva la actividad de la sesión', alSondear.statusCode === 200 && Date.now() - despuesSondeo.ultima_actividad_at.getTime() > 49 * 60_000);
  await pedir('GET', '/api/yo', { cookie: s.cookie });
  await volcarSesiones();
  check('Una petición normal sí renueva la actividad', Date.now() - (await filaSesion(s.cookie)).ultima_actividad_at.getTime() < 60_000);
  await envejecer(s.cookie, { inactivoMin: 50 });
  await pedir('POST', '/api/auth/latido', { cookie: s.cookie });
  await volcarSesiones();
  check('El latido renueva la actividad', Date.now() - (await filaSesion(s.cookie)).ultima_actividad_at.getTime() < 60_000);
  await envejecer(s.cookie, { inactivoMin: 61 });
  check('Una pantalla que solo hace sondeos vence a los 60 min de inactividad', (await pedir('GET', '/api/yo', { cookie: s.cookie, headers: { 'x-panel-sondeo': '1' } })).statusCode === 401);
  const filaVencida = await filaSesion(s.cookie);
  check('La sesión vencida queda cerrada por inactividad y deja el evento', filaVencida.motivo_cierre === 'inactividad' && (await eventos('sesion_expirada', 't_dir')).length >= 1);

  // Máximo de 12 h aun con actividad.
  const m = await entrar('t_dir');
  await envejecer(m.cookie, { inactivoMin: 1, expiraEnMin: -1 });
  check('Vence a las 12 h aunque haya actividad reciente', (await pedir('GET', '/api/yo', { cookie: m.cookie })).statusCode === 401 && (await filaSesion(m.cookie)).motivo_cierre === 'maxima');
  const fila = await filaSesion((await entrar('t_dir')).cookie);
  check('El máximo de una sesión normal es de 12 horas', Math.abs(fila.expira_at.getTime() - fila.creada_at.getTime() - 12 * 3600_000) < 2000);

  // Sesión mantenida.
  const k = await entrar('t_dir', CLAVE, { cuerpo: { mantener: true } });
  await envejecer(k.cookie, { inactivoMin: 23 * 60 });
  check('Sesión mantenida: sigue viva a las 23 h de inactividad', (await pedir('GET', '/api/yo', { cookie: k.cookie })).statusCode === 200);
  await envejecer(k.cookie, { inactivoMin: 25 * 60 });
  check('Sesión mantenida: vence a las 24 h de inactividad', (await pedir('GET', '/api/yo', { cookie: k.cookie })).statusCode === 401);
  const k2 = await entrar('t_dir', CLAVE, { cuerpo: { mantener: true } });
  const fk = await filaSesion(k2.cookie);
  check('El máximo de una sesión mantenida es de 7 días', Math.abs(fk.expira_at.getTime() - fk.creada_at.getTime() - 7 * 24 * 3600_000) < 2000);
  await envejecer(k2.cookie, { expiraEnMin: -1 });
  check('Sesión mantenida: vence a los 7 días', (await pedir('GET', '/api/yo', { cookie: k2.cookie })).statusCode === 401);

  // Cierre inmediato pese a la caché de 30 s.
  const a = await entrar('t_dir');
  const b = await entrar('t_dir');
  check('Dos sesiones del mismo usuario conviven', (await pedir('GET', '/api/yo', { cookie: a.cookie })).statusCode === 200 && (await pedir('GET', '/api/yo', { cookie: b.cookie })).statusCode === 200);
  const cambio = await pedir('POST', '/api/auth/contrasena', { cookie: b.cookie, payload: { actual: CLAVE, nueva: 'Cambio#Inmediato7' } });
  check('Cambiar la contraseña desde una sesión cierra la otra DE INMEDIATO (sin esperar los 30 s de caché)', cambio.statusCode === 204 && (await pedir('GET', '/api/yo', { cookie: a.cookie })).statusCode === 401);
  check('La sesión que cambió la contraseña sigue con token nuevo', (await pedir('GET', '/api/yo', { cookie: cookieDe(cambio) })).statusCode === 200 && (await pedir('GET', '/api/yo', { cookie: b.cookie })).statusCode === 401);
  await poolApp.query(`UPDATE panel.credenciales SET hash = $1 WHERE usuario = 't_dir'`, [HASH]);

  const c = await entrar('t_dir');
  await pedir('GET', '/api/yo', { cookie: c.cookie });
  await pedir('POST', '/api/auth/logout', { cookie: c.cookie });
  check('Logout surte efecto de inmediato', (await pedir('GET', '/api/yo', { cookie: c.cookie })).statusCode === 401);
  check('Logout sin sesión: 204 (idempotente)', (await pedir('POST', '/api/auth/logout')).statusCode === 204 && (await pedir('POST', '/api/auth/logout', { cookie: c.cookie })).statusCode === 204);

  const sop = await entrar('t_sop');
  const victima = await entrar('t_ope');
  await pedir('GET', '/api/yo', { cookie: victima.cookie });
  const desact = await pedir('PUT', '/api/soporte/usuarios/t_ope', { cookie: sop.cookie, payload: { rol: 'operacion', activo: false } });
  check('Desactivar a alguien corta su sesión de inmediato', desact.statusCode === 200 && (await pedir('GET', '/api/yo', { cookie: victima.cookie })).statusCode === 401);
  check('Desactivar deja el evento usuario_desactivado con el actor', (await eventos('usuario_desactivado', 't_ope'))[0]?.actor === 't_sop');
  check('Un usuario desactivado ya no entra', (await entrar('t_ope')).res.statusCode === 401);
  await pedir('PUT', '/api/soporte/usuarios/t_ope', { cookie: sop.cookie, payload: { rol: 'operacion', activo: true } });

  // Límite de sesiones.
  await poolApp.query(`UPDATE panel.sesiones SET cerrada_at = now(), motivo_cierre = 'logout' WHERE usuario = 't_ana' AND cerrada_at IS NULL`);
  const once = [];
  for (let i = 0; i < 11; i++) once.push(await entrar('t_ana'));
  check('La undécima sesión cierra la más antigua', (await pedir('GET', '/api/yo', { cookie: once[0].cookie })).statusCode === 401 && (await pedir('GET', '/api/yo', { cookie: once[10].cookie })).statusCode === 200);
  check('Quedan exactamente 10 sesiones activas', (await pedir('GET', '/api/auth/sesiones', { cookie: once[10].cookie })).json().filas.length === 10);
  check('La cerrada por el límite lleva su motivo', (await filaSesion(once[0].cookie)).motivo_cierre === 'limite_sesiones');

  // Reinicio y fijación.
  const r = await entrar('t_dir');
  _vaciarCacheSesiones();
  check('Sobrevive a un reinicio: instancia nueva (sin caché) con la misma cookie', (await pedir('GET', '/api/yo', { cookie: r.cookie })).statusCode === 200);
  const previa = await entrar('t_dir');
  const nueva = await pedir('POST', '/api/auth/login', { cookie: previa.cookie, payload: { usuario: 't_dir', contrasena: CLAVE }, ip: ipNueva() });
  check('Al entrar con una cookie válida se revoca la anterior (sin fijación de sesión)', nueva.statusCode === 200 && (await pedir('GET', '/api/yo', { cookie: previa.cookie })).statusCode === 401 && cookieDe(nueva) !== previa.cookie);

  // Mis sesiones.
  const p = await entrar('t_dir');
  const q = await entrar('t_dir');
  const lista = (await pedir('GET', '/api/auth/sesiones', { cookie: p.cookie })).json().filas;
  check('La lista de sesiones marca la actual y muestra el equipo', lista.some((x) => x.actual) && lista.every((x) => typeof x.equipo === 'string' && !('token_hash' in x) && !('token' in x)));
  const ajena = lista.find((x) => !x.actual);
  const otraPersona = await entrar('t_ana');
  const idAjeno = (await pedir('GET', '/api/auth/sesiones', { cookie: otraPersona.cookie })).json().filas[0].id;
  check('No se puede cerrar la sesión de otra persona', (await pedir('DELETE', `/api/auth/sesiones/${idAjeno}`, { cookie: p.cookie })).statusCode === 404 && (await pedir('GET', '/api/yo', { cookie: otraPersona.cookie })).statusCode === 200);
  check('Cerrar una sesión propia ajena al navegador actual: 204 y al instante', (await pedir('DELETE', `/api/auth/sesiones/${ajena.id}`, { cookie: p.cookie })).statusCode === 204);
  await entrar('t_dir');
  const cerradas = (await pedir('POST', '/api/auth/sesiones/cerrar-otras', { cookie: p.cookie })).json().cerradas;
  check('Cerrar las demás conserva la actual', cerradas >= 1 && (await pedir('GET', '/api/yo', { cookie: p.cookie })).statusCode === 200 && (await pedir('GET', '/api/yo', { cookie: q.cookie })).statusCode === 401);
}

// ============================================================================================ 5. recuperación
{
  vaciarLimites();
  // Los avisos de "su contraseña cambió" también pasan por la memoria: aquí solo se cuentan los correos con código.
  const correosCodigo = () => mensajesEnMemoria.filter((m) => m.asunto === 'Código para restablecer su contraseña');
  const origen = correosCodigo().length;
  const codigoDe = (m) => /Su código es: (\d{6})/.exec(m.texto)?.[1];
  const ultimoCorreo = () => correosCodigo().at(-1);
  const solicitar = (correo, ip) => pedir('POST', '/api/auth/recuperar/solicitar', { payload: { correo }, ip: ip ?? ipNueva() });
  const verificarCod = (correo, codigo, ip) => pedir('POST', '/api/auth/recuperar/verificar', { payload: { correo, codigo }, ip: ip ?? ipNueva() });
  const restablecer = (token, nueva) => pedir('POST', '/api/auth/recuperar/restablecer', { payload: { token, nueva }, ip: ipNueva() });
  /** Pide un código y espera el correo. Devuelve el código. */
  async function pedirCodigo(correo) {
    const n = correosCodigo().length;
    const r = await solicitar(correo);
    assert.equal(r.statusCode, 200);
    assert.ok(await espera(() => correosCodigo().length > n), 'el correo con el código no llegó');
    return codigoDe(ultimoCorreo());
  }
  const envejecerCodigo = (usuario, segundos) => poolApp.query(`UPDATE panel.codigos_recuperacion SET creado_at = creado_at - ($2 || ' seconds')::interval WHERE usuario = $1`, [usuario, String(segundos)]);
  const limpiarCodigos = (usuario) => poolApp.query(`DELETE FROM panel.codigos_recuperacion WHERE usuario = $1`, [usuario]);

  // Neutralidad.
  const existente = await solicitar('carmen.rojas@test.local');
  const inexistente = await solicitar('no.existe@test.local');
  check('Solicitar con correo existente e inexistente: misma respuesta exacta', existente.statusCode === 200 && existente.body === inexistente.body && existente.json().ok === true);
  await espera(() => correosCodigo().length > origen);
  const te = await medir((i) => solicitar(`fantasma${i}@test.local`), 5);
  await limpiarCodigos('t_dir');
  const tx = await medir(async () => {
    await envejecerCodigo('t_dir', 3600);
    await solicitar('carmen.rojas@test.local');
  }, 5);
  check(`Correo existente e inexistente: tiempo de respuesta similar (${Math.round(te)} vs ${Math.round(tx)} ms)`, Math.abs(te - tx) < 120);
  await espera(() => false, 300);
  check('Solicitar para un correo inexistente no envía nada', !correosCodigo().some((m) => m.para.includes('no.existe@test.local')));
  const m0 = correosCodigo().find((m) => m.para.includes('carmen.rojas@test.local'));
  check('El correo del código va solo al buzón de la cuenta, sin el código en el asunto', !!m0 && m0.para.length === 1 && !/\d{6}/.test(m0.asunto) && m0.asunto === 'Código para restablecer su contraseña');
  check('El correo explica vigencia y qué hacer si no lo pidió', /15 minutos/.test(m0.texto) && /ignore este mensaje/i.test(m0.texto) && /hora de Bogotá/.test(m0.texto) && !/https?:\/\//.test(m0.texto + m0.html));

  // Código correcto, vencido, reusado, ajeno.
  await limpiarCodigos('t_dir');
  await limpiarCodigos('t_ana');
  vaciarLimites();
  const codigo = await pedirCodigo('carmen.rojas@test.local');
  check('El código tiene 6 dígitos', /^\d{6}$/.test(codigo));
  const cuerpoFila = (await poolApp.query(`SELECT * FROM panel.codigos_recuperacion WHERE usuario = 't_dir' ORDER BY id DESC LIMIT 1`)).rows[0];
  check('El código no se guarda en claro (solo su HMAC)', Buffer.isBuffer(cuerpoFila.codigo_hmac) && cuerpoFila.codigo_hmac.length === 32 && !cuerpoFila.codigo_hmac.toString('latin1').includes(codigo));
  const ajeno = await verificarCod('otro@test.local', codigo);
  check('El código de otra cuenta no sirve', ajeno.statusCode === 400 && ajeno.json().codigo === 'otp');
  const mal = await verificarCod('carmen.rojas@test.local', codigo === '000000' ? '000001' : '000000');
  if (process.env.DEPURAR) console.log('DEPURAR mal', mal.statusCode, mal.body);
  check('Código incorrecto: error otp genérico', mal.statusCode === 400 && mal.json().error === 'Código incorrecto o vencido');
  const inex = await verificarCod('no.existe@test.local', codigo);
  check('Cuenta inexistente: misma respuesta que un código incorrecto', inex.statusCode === 400 && inex.body === mal.body);
  const bueno = await verificarCod('carmen.rojas@test.local', codigo);
  check('Código correcto: devuelve un token', bueno.statusCode === 200 && typeof bueno.json().token === 'string' && bueno.json().token.length >= 40);
  const token1 = bueno.json().token;
  check('Código reusado: error', (await verificarCod('carmen.rojas@test.local', codigo)).statusCode === 400);
  check('El token no se guarda en claro', !JSON.stringify((await poolApp.query(`SELECT * FROM panel.codigos_recuperacion`)).rows).includes(token1));

  // Vencido.
  await limpiarCodigos('t_dir');
  const cv = await pedirCodigo('carmen.rojas@test.local');
  await poolApp.query(`UPDATE panel.codigos_recuperacion SET expira_at = now() - interval '1 second' WHERE usuario = 't_dir'`);
  check('Código vencido: error otp', (await verificarCod('carmen.rojas@test.local', cv)).statusCode === 400);

  // Quinto intento anula el código.
  await limpiarCodigos('t_dir');
  vaciarLimites();
  const c5 = await pedirCodigo('carmen.rojas@test.local');
  const falso = c5 === '123456' ? '654321' : '123456';
  for (let i = 0; i < 5; i++) await verificarCod('carmen.rojas@test.local', falso, '10.7.7.7');
  const tras = await verificarCod('carmen.rojas@test.local', c5, '10.7.7.8');
  check('El quinto intento fallido anula el código: ni el correcto sirve después', tras.statusCode === 400);
  check('El código anulado queda marcado en la base', (await poolApp.query(`SELECT anulado_at FROM panel.codigos_recuperacion WHERE usuario = 't_dir' ORDER BY id DESC LIMIT 1`)).rows[0].anulado_at !== null);
  const cuatro = await (async () => {
    await limpiarCodigos('t_dir');
    const c = await pedirCodigo('carmen.rojas@test.local');
    for (let i = 0; i < 4; i++) await verificarCod('carmen.rojas@test.local', falso, '10.7.7.9');
    return (await verificarCod('carmen.rojas@test.local', c, '10.7.7.10')).statusCode;
  })();
  check('Con 4 intentos fallidos, el código correcto todavía sirve', cuatro === 200);

  // Límites del OTP.
  vaciarLimites();
  await limpiarCodigos('t_dir');
  const ipOtp = '10.5.5.5';
  let u;
  for (let i = 0; i < 10; i++) u = await verificarCod('carmen.rojas@test.local', '999999', ipOtp);
  check('Diez fallos de código desde una IP para un correo: 429 con Retry-After', u.statusCode === 429 && Number(u.headers['retry-after']) > 0);
  vaciarLimites();

  // Reenvío.
  await limpiarCodigos('t_dir');
  const n0 = correosCodigo().length;
  const cA = await pedirCodigo('carmen.rojas@test.local');
  await solicitar('carmen.rojas@test.local');
  await espera(() => false, 400);
  check('Antes de 60 s no se envía otro código', correosCodigo().length === n0 + 1);
  await envejecerCodigo('t_dir', 61);
  const cB = await pedirCodigo('carmen.rojas@test.local');
  check('Pasados 60 s se envía uno nuevo', cB !== undefined && correosCodigo().length === n0 + 2);
  const viejo = await verificarCod('carmen.rojas@test.local', cA, '10.6.6.6');
  check('Un código nuevo anula el anterior', cA === cB ? true : viejo.statusCode === 400);
  await envejecerCodigo('t_dir', 61);
  await pedirCodigo('carmen.rojas@test.local');
  await envejecerCodigo('t_dir', 61);
  const nAntes = correosCodigo().length;
  await solicitar('carmen.rojas@test.local');
  await espera(() => false, 400);
  check('Máximo 3 códigos por hora por cuenta: el cuarto no se envía', correosCodigo().length === nAntes);
  vaciarLimites();
  let ult;
  for (let i = 0; i < 11; i++) ult = await solicitar(`x${i}@test.local`, '10.4.4.4');
  check('Superado el límite por IP se sigue respondiendo igual', ult.statusCode === 200 && ult.json().ok === true);
  vaciarLimites();

  // Carrera.
  await limpiarCodigos('t_dir');
  const cc = await pedirCodigo('carmen.rojas@test.local');
  const dos = await Promise.all([verificarCod('carmen.rojas@test.local', cc, '10.3.3.1'), verificarCod('carmen.rojas@test.local', cc, '10.3.3.2')]);
  check('Dos verificaciones simultáneas: solo una obtiene token', dos.filter((r) => r.statusCode === 200).length === 1 && dos.filter((r) => r.statusCode === 400).length === 1);
  const tokenCarrera = dos.find((r) => r.statusCode === 200).json().token;

  // Restablecer.
  const sesionesPrevias = [await entrar('t_dir'), await entrar('t_dir')];
  const avisosAntes = mensajesEnMemoria.filter((m) => m.asunto === 'Su contraseña del panel cambió').length;
  const debil = await restablecer(tokenCarrera, 'abc');
  check('Un error de política no consume el token', debil.statusCode === 400 && debil.json().codigo === 'politica');
  const comun = await restablecer(tokenCarrera, 'Password1!');
  check('Una clave común tampoco consume el token', comun.statusCode === 400 && comun.json().codigo === 'politica');
  const usada = await restablecer(tokenCarrera, CLAVE);
  check('Una contraseña del historial (la actual) da error historial y NO consume el token', usada.statusCode === 400 && usada.json().codigo === 'historial');
  const nuevaClave = secreto('Restablecida#2026k');
  const ok = await restablecer(tokenCarrera, nuevaClave);
  check('Con el token vigente se restablece (204)', ok.statusCode === 204);
  check('Token reusado: error', (await restablecer(tokenCarrera, 'Otra#Distinta2026')).statusCode === 400);
  check('Restablecer cierra TODAS las sesiones', (await Promise.all(sesionesPrevias.map((s) => pedir('GET', '/api/yo', { cookie: s.cookie })))).every((r) => r.statusCode === 401));
  check('Restablecer envía el aviso de cambio al correo', await espera(() => mensajesEnMemoria.filter((m) => m.asunto === 'Su contraseña del panel cambió').length === avisosAntes + 1));
  const aviso = mensajesEnMemoria.filter((m) => m.asunto === 'Su contraseña del panel cambió').at(-1);
  check('El aviso trae fecha y hora de Bogotá y la advertencia, sin la contraseña', /hora de Bogotá/.test(aviso.texto) && /contacte a soporte/i.test(aviso.texto) && !aviso.texto.includes(nuevaClave) && !aviso.html.includes(nuevaClave));
  check('Se puede entrar con la contraseña nueva y ya no con la anterior', (await entrar('t_dir', nuevaClave)).res.statusCode === 200 && (await entrar('t_dir', CLAVE)).res.statusCode === 401);
  check('Queda el evento contrasena_restablecida', (await eventos('contrasena_restablecida', 't_dir')).length >= 1);
  await poolApp.query(`UPDATE panel.credenciales SET hash = $1 WHERE usuario = 't_dir'`, [HASH]);
  await poolApp.query(`DELETE FROM panel.contrasenas_previas WHERE usuario = 't_dir'`);

  // Token vencido.
  await limpiarCodigos('t_dir');
  const cvt = await pedirCodigo('carmen.rojas@test.local');
  const tkv = (await verificarCod('carmen.rojas@test.local', cvt)).json().token;
  await poolApp.query(`UPDATE panel.codigos_recuperacion SET token_expira_at = now() - interval '1 second' WHERE usuario = 't_dir'`);
  check('Token vencido: error', (await restablecer(tkv, 'Valida#Clave2026z')).statusCode === 400);
  check('Un token inventado: error genérico', (await restablecer(randomBytes(32).toString('base64url'), 'Valida#Clave2026z')).json().codigo === 'token');

  // Primer acceso de un usuario sin credencial.
  vaciarLimites();
  const csc = await pedirCodigo('sincred@test.local');
  const tsc = (await verificarCod('sincred@test.local', csc)).json().token;
  const primera = secreto('Primera#Entrada2026');
  check('Un usuario sin credencial puede crear su contraseña por correo', (await restablecer(tsc, primera)).statusCode === 204);
  const primero = await entrar('t_sincred', primera);
  check('Y luego entra normalmente', primero.res.statusCode === 200 && primero.json.debeCambiar === false);

  // Ni el código ni el token aparecen en eventos ni respuestas.
  const evs = JSON.stringify((await poolApp.query(`SELECT * FROM panel.eventos_autenticacion`)).rows);
  check('El código y el token no aparecen en los eventos', ![codigo, cc, cvt, csc, token1, tokenCarrera, tkv, tsc].some((v) => evs.includes(v)));
  for (const v of [codigo, cc, cvt, csc, token1, tokenCarrera, tkv, tsc]) secreto(v);

  // Sin correo configurado.
  const proveedor = process.env.EMAIL_PROVEEDOR;
  process.env.EMAIL_PROVEEDOR = '';
  const sinCorreo = await solicitar('carmen.rojas@test.local');
  check('Correo no configurado: solicitar da 503 con el mensaje de contactar a soporte', sinCorreo.statusCode === 503 && sinCorreo.json().codigo === 'correo' && /soporte/i.test(sinCorreo.json().error));
  check('Correo no configurado: el login sigue funcionando', (await entrar('t_dir')).res.statusCode === 200);
  process.env.NODE_ENV = 'production';
  process.env.EMAIL_PROVEEDOR = 'memoria';
  check('El proveedor memoria se rechaza en producción', (await solicitar('carmen.rojas@test.local')).statusCode === 503);
  delete process.env.NODE_ENV;

  // Fallo del proveedor.
  process.env.EMAIL_PROVEEDOR = 'resend';
  process.env.EMAIL_API_KEY = secreto('re_llave_de_prueba_123');
  const fetchOriginal = globalThis.fetch;
  let cuerpoEnviado = '';
  globalThis.fetch = async (url, op) => {
    cuerpoEnviado = String(op?.body ?? '');
    return new Response('{"message":"dominio no verificado"}', { status: 422 });
  };
  vaciarLimites();
  await limpiarCodigos('t_dir');
  await solicitar('carmen.rojas@test.local');
  const llegoEvento = await espera(async () => (await eventos('correo_fallido', 't_dir')).length >= 1);
  globalThis.fetch = fetchOriginal;
  const evFallo = (await eventos('correo_fallido', 't_dir')).at(-1);
  const codigoFallido = /(\d{6})/.exec(cuerpoEnviado.replace(/\\n/g, ' '))?.[1];
  check('Fallo del proveedor: evento correo_fallido con el resumen HTTP, sin el código ni el cuerpo', llegoEvento && /HTTP 422/.test(evFallo.detalle) && (!codigoFallido || !evFallo.detalle.includes(codigoFallido)) && !evFallo.detalle.includes('dominio'));
  process.env.EMAIL_PROVEEDOR = 'memoria';
  delete process.env.EMAIL_API_KEY;
  vaciarLimites();
}

// ================================================================================================== 6. contraseña
{
  vaciarLimites();
  const s = await entrar('t_dir');
  let cookie = s.cookie;
  const cambiar = async (actual, nueva) => {
    const r = await pedir('POST', '/api/auth/contrasena', { cookie, payload: { actual, nueva } });
    if (r.statusCode === 204) cookie = cookieDe(r);
    return r;
  };
  const rechaza = async (nueva, etiqueta) => {
    const r = await cambiar(CLAVE, nueva);
    check(`Servidor rechaza: ${etiqueta}`, r.statusCode === 400 && r.json().codigo === 'politica');
  };
  await rechaza('Ab1!', 'menos de 8 caracteres');
  await rechaza('abcdefg1!', 'sin mayúscula');
  await rechaza('ABCDEFG1!', 'sin minúscula');
  await rechaza('Abcdefgh!', 'sin número');
  await rechaza('Abcdefg12', 'sin carácter especial');
  await rechaza('Password1!', 'clave común');
  await rechaza('Welcome1!', 'clave común (variante)');
  await rechaza('Zx9#t_dir#Qw', 'contiene el usuario');
  await rechaza('Carmen.rojas#9Zx', 'contiene la parte local del correo');
  await rechaza('Orientacion#2026', 'contiene "orientacion"');
  await rechaza(`Aa1!${'x'.repeat(125)}`, 'largo 129');
  check('Servidor acepta un largo de 128', cumplePolitica(`Aa1!${'x'.repeat(124)}`) && !cumplePolitica(`Aa1!${'x'.repeat(125)}`));

  // Pruebas unitarias de la política y las claves.
  check('Política: cada requisito por separado', !cumplePolitica('Ab1!') && !cumplePolitica('abcdefg1!') && !cumplePolitica('ABCDEFG1!') && !cumplePolitica('Abcdefgh!') && !cumplePolitica('Abcdefg12') && cumplePolitica('Abcdefg1!'));
  check('Política: el espacio no cuenta como especial', !cumplePolitica('Abcdefg1 '));
  check('Claves comunes: variantes con ! y 1 al final', esClaveProhibida('Password1') && esClaveProhibida('Qwerty!') && esClaveProhibida('Admin123!') && esClaveProhibida('P@ssw0rd'));
  check('Claves comunes: no se bloquea una clave fuerte', !esClaveProhibida('Ñandú#2026x') && !esClaveProhibida('Tx7$Lm4!pQ'));
  const temporales = Array.from({ length: 50 }, generarTemporal);
  check('La contraseña temporal tiene 16 caracteres y cumple la política siempre', temporales.every((t) => t.length === 16 && cumplePolitica(t)) && new Set(temporales).size === 50);

  // Actual incorrecta y límite.
  const sinActual = await pedir('POST', '/api/auth/contrasena', { cookie, payload: { nueva: 'Valida#Clave2026a' } });
  check('Sin la contraseña actual (y sin temporal): error actual', sinActual.statusCode === 400 && sinActual.json().codigo === 'actual');
  const errada = await cambiar('Mala#Actual1', 'Valida#Clave2026a');
  check('Actual incorrecta: error actual', errada.statusCode === 400 && errada.json().codigo === 'actual' && errada.json().error === 'La contraseña actual no es correcta');
  let ult;
  for (let i = 0; i < 4; i++) ult = await cambiar('Mala#Actual1', 'Valida#Clave2026a');
  check('Tras 5 fallos de la actual: 429 con Retry-After', ult.statusCode === 429 && Number(ult.headers['retry-after']) > 0);
  check('Bloqueado, ni la actual correcta sirve', (await cambiar(CLAVE, 'Valida#Clave2026a')).statusCode === 429);
  vaciarLimites();

  // Historial (actual + 3 anteriores).
  const P0 = CLAVE;
  const P = [P0, 'Segunda#Clave2026b', 'Tercera#Clave2026c', 'Cuarta#Clave2026d', 'Quinta#Clave2026e'].map(secreto);
  for (let i = 1; i < P.length; i++) {
    const r = await cambiar(P[i - 1], P[i]);
    assert.equal(r.statusCode, 204, `cambio ${i} falló: ${r.body}`);
  }
  const igualActual = await cambiar(P[4], P[4]);
  check('No se puede reutilizar la actual', igualActual.statusCode === 400 && igualActual.json().codigo === 'historial');
  for (const i of [1, 2, 3]) {
    const r = await cambiar(P[4], P[i]);
    assert.equal(r.statusCode, 400, `la previa ${i} debió rechazarse`);
    assert.equal(r.json().codigo, 'historial');
  }
  check('No se puede reutilizar ninguna de las 3 anteriores', true);
  const cuarta = await cambiar(P[4], P[0]);
  check('La cuarta anterior sí se puede usar', cuarta.statusCode === 204);
  const previas = (await poolApp.query(`SELECT count(*)::int AS n FROM panel.contrasenas_previas WHERE usuario = 't_dir'`)).rows[0].n;
  check('El historial conserva solo las 3 más recientes', previas === 3);
  check('Cada cambio deja evento y avisa por correo', (await eventos('contrasena_cambiada', 't_dir')).length >= 5);

  // NFKC y no ASCII.
  const unicode = secreto('Ñandú#2026x');
  const enU = await cambiar(P[0], unicode);
  check('Una contraseña con caracteres no ASCII funciona (Ñandú#2026x)', enU.statusCode === 204);
  check('Y entra con ella, también escrita con caracteres compuestos distintos (NFKC)', (await entrar('t_dir', unicode)).res.statusCode === 200 && (await entrar('t_dir', unicode.normalize('NFD'))).res.statusCode === 200);
  check('Fullwidth se normaliza a su forma equivalente', (await verificar('ＡＢＣ１２３', await hashear('ABC123'))).ok);
  await poolApp.query(`UPDATE panel.credenciales SET hash = $1 WHERE usuario = 't_dir'`, [HASH]);
  await poolApp.query(`DELETE FROM panel.contrasenas_previas WHERE usuario = 't_dir'`);

  // Hash con parámetros menores: se rehace tras un login correcto.
  const debil = await (async () => {
    const { scryptSync, randomBytes: rb } = await import('node:crypto');
    const sal = rb(16);
    const h = scryptSync(CLAVE.normalize('NFKC'), sal, 32, { N: 2 ** 12, r: 8, p: 1 });
    return ['scrypt', 12, 8, 1, sal.toString('base64url'), h.toString('base64url')].join('$');
  })();
  await poolApp.query(`UPDATE panel.credenciales SET hash = $1 WHERE usuario = 't_ope'`, [debil]);
  check('verificar() reconoce un hash con parámetros viejos y pide rehacerlo', (await verificar(CLAVE, debil)).rehacer === true && (await verificar('otra', debil)).ok === false);
  const rh = await entrar('t_ope');
  const nuevoHash = (await poolApp.query(`SELECT hash FROM panel.credenciales WHERE usuario = 't_ope'`)).rows[0].hash;
  check('Tras un login correcto el hash se rehace con los parámetros vigentes', rh.res.statusCode === 200 && nuevoHash !== debil && nuevoHash.startsWith('scrypt$15$8$3$'));
  check('Un hash guardado ilegible nunca coincide', !(await verificar(CLAVE, 'basura')).ok && !(await verificar(CLAVE, 'scrypt$15$8$3$x$')).ok);
}

// ================================================================== 7. reautenticación (acciones sensibles, D6)
{
  vaciarLimites();
  const s = await entrar('t_dir');
  const ejecutar = (c) => pedir('POST', '/api/envios/invitacion/ejecutar', { cookie: c, payload: { limite: 1 } });
  await envejecer(s.cookie, { inactivoMin: 1 });
  await poolApp.query(`UPDATE panel.sesiones SET reautenticada_at = now() - interval '11 minutes' WHERE id = $1`, [await idSesion(s.cookie)]);
  _vaciarCacheSesiones();
  const sin = await ejecutar(s.cookie);
  check('Lanzar un envío con la última confirmación de hace más de 10 min exige reautenticar', sin.statusCode === 403 && sin.json().codigo === 'reautenticar');
  const mala = await pedir('POST', '/api/auth/reautenticar', { cookie: s.cookie, payload: { contrasena: 'Mala#Clave123' } });
  check('Reautenticar con una contraseña errada: error actual', mala.statusCode === 400 && mala.json().codigo === 'actual');
  check('Y sigue sin poder enviar', (await ejecutar(s.cookie)).json().codigo === 'reautenticar');
  check('Reautenticar con la contraseña correcta: 204', (await pedir('POST', '/api/auth/reautenticar', { cookie: s.cookie, payload: { contrasena: CLAVE } })).statusCode === 204);
  const con = await ejecutar(s.cookie);
  check('Tras confirmar, el envío pasa la compuerta (llega al bot de prueba, que no existe: 502)', con.statusCode === 502 && con.json().codigo !== 'reautenticar');
  const ana = await entrar('t_ana');
  check('Quien no tiene permiso recibe 403 de rol, no el pedido de contraseña', (await ejecutar(ana.cookie)).json().codigo === 'rol');
}

// ======================================================================= 8. CSRF, cabeceras y actividad
{
  vaciarLimites();
  const s = await entrar('t_dir');
  const sinOrigen = await pedir('POST', '/api/actividad', { cookie: s.cookie, sinOrigen: true, payload: { tipo: 'visita', ruta: 'resumen' } });
  check('Escritura sin Origin: 403 origen (H9)', sinOrigen.statusCode === 403 && sinOrigen.json().codigo === 'origen');
  const ajeno = await pedir('POST', '/api/actividad', { cookie: s.cookie, headers: { origin: 'https://sitio-malo.example' }, payload: { tipo: 'visita', ruta: 'resumen' } });
  check('Escritura con origen ajeno: 403', ajeno.statusCode === 403);
  const login = await pedir('POST', '/api/auth/login', { sinOrigen: true, payload: { usuario: 't_dir', contrasena: CLAVE } });
  check('El login también exige Origin', login.statusCode === 403);
  check('Con el origen propio la escritura pasa', (await pedir('POST', '/api/actividad', { cookie: s.cookie, payload: { tipo: 'visita', ruta: 'resumen' } })).statusCode === 204);
  check('Una lectura sin Origin pasa (los GET no llevan Origin)', (await pedir('GET', '/api/yo', { cookie: s.cookie })).statusCode === 200);

  const api = await pedir('GET', '/api/yo', { cookie: s.cookie });
  check('Toda respuesta de /api/ lleva Cache-Control: no-store (también 401)', api.headers['cache-control'] === 'no-store' && (await pedir('GET', '/api/yo')).headers['cache-control'] === 'no-store' && (await pedir('GET', '/api/health')).headers['cache-control'] === 'no-store');
  const pag = await pedir('GET', '/pagina');
  check('Fuera de /api/ no se fuerza no-store', pag.headers['cache-control'] !== 'no-store');
  for (const r of [api, pag]) {
    assert.equal(r.headers['content-security-policy'], CSP);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['referrer-policy'], 'same-origin');
    assert.equal(r.headers['permissions-policy'], 'camera=(), microphone=(), geolocation=()');
  }
  check('CSP, nosniff, Referrer-Policy y Permissions-Policy en la API y en las páginas', true);
  check("La CSP no permite scripts inline ni 'unsafe-eval', ni frames", /script-src 'self'(;|$)/.test(CSP) && !/unsafe-eval/.test(CSP) && /frame-ancestors 'none'/.test(CSP) && /object-src 'none'/.test(CSP));

  // Peticiones anónimas no ensucian panel.actividad (H14).
  await volcarActividad();
  const antes = (await poolApp.query(`SELECT count(*)::int AS n FROM panel.actividad`)).rows[0].n;
  await pedir('GET', '/api/health');
  await pedir('GET', '/api/yo');
  await pedir('GET', '/api/resumen');
  await pedir('POST', '/api/auth/login', { payload: { usuario: 'nadie', contrasena: 'x' }, ip: ipNueva() });
  await pedir('POST', '/api/auth/logout');
  await volcarActividad();
  check('Las peticiones anónimas no crean filas en panel.actividad', (await poolApp.query(`SELECT count(*)::int AS n FROM panel.actividad`)).rows[0].n === antes);
  await pedir('GET', '/api/yo', { cookie: s.cookie });
  await pedir('GET', '/api/plan', { cookie: s.cookie });
  await volcarActividad();
  check('Las de una persona con sesión sí se registran, pero las de /api/auth/* no', (await poolApp.query(`SELECT count(*)::int AS n FROM panel.actividad`)).rows[0].n > antes && (await poolApp.query(`SELECT count(*)::int AS n FROM panel.actividad WHERE ruta LIKE '%/api/auth/%'`)).rows[0].n === 0);

  check('ipDe ignora X-Forwarded-For y valida X-Real-IP (H3, H18)', ipDe({ headers: { 'x-forwarded-for': '1.2.3.4, 45.66.77.88', 'x-real-ip': '45.66.77.88' } }) === '45.66.77.88' && ipDe({ headers: { 'x-real-ip': 'no-es-una-ip' } }) === null && ipDe({ headers: {} }) === null && ipDe({ headers: { 'x-real-ip': '::1' } }) === '::1');
  const sinIp = await pedir('POST', '/api/auth/login', { payload: { usuario: 't_dir', contrasena: 'x' }, headers: { 'x-real-ip': 'basura; DROP TABLE' } });
  check('Una IP inválida no rompe la columna inet: responde 401 y guarda ip NULL', sinIp.statusCode === 401 && (await poolApp.query(`SELECT ip FROM panel.eventos_autenticacion ORDER BY id DESC LIMIT 1`)).rows[0].ip === null);
  vaciarLimites();
}

// ===================================================================================================== 9. soporte
{
  vaciarLimites();
  const sop = await entrar('t_sop');
  const dir = await entrar('t_dir');
  for (const [m, u] of [['POST', '/api/soporte/usuarios/t_ana/temporal'], ['POST', '/api/soporte/usuarios/t_ana/desbloquear'], ['POST', '/api/soporte/usuarios/t_ana/cerrar-sesiones'], ['GET', '/api/soporte/autenticacion']]) {
    check(`${m} ${u} rechaza a quien no es soporte`, (await pedir(m, u, { cookie: dir.cookie })).statusCode === 403);
  }

  // Temporal.
  const vict = await entrar('t_ana');
  await pedir('GET', '/api/yo', { cookie: vict.cookie });
  const tmp = await pedir('POST', '/api/soporte/usuarios/t_ana/temporal', { cookie: sop.cookie });
  const { temporal, venceAt } = tmp.json();
  secreto(temporal);
  check('Generar temporal: devuelve la clave una sola vez y su vencimiento', tmp.statusCode === 200 && typeof temporal === 'string' && cumplePolitica(temporal) && /^\d{4}-\d{2}-\d{2}T/.test(venceAt));
  check('La temporal revoca las sesiones de esa cuenta', (await pedir('GET', '/api/yo', { cookie: vict.cookie })).statusCode === 401);
  const f = (await poolApp.query(`SELECT * FROM panel.credenciales WHERE usuario = 't_ana'`)).rows[0];
  check('Vence en 24 h y obliga a cambiarla; no se guarda en texto', f.debe_cambiar === true && Math.abs(f.temporal_expira_at.getTime() - Date.now() - 24 * 3600_000) < 60_000 && !f.hash.includes(temporal));
  const conTemp = await entrar('t_ana', temporal);
  check('Se entra con la temporal y debe cambiarla', conTemp.res.statusCode === 200 && conTemp.json.debeCambiar === true);
  check('Con la temporal no se ve nada más hasta cambiarla', (await pedir('GET', '/api/campanas', { cookie: conTemp.cookie })).json().codigo === 'cambiar_contrasena');
  check('Queda el evento con el actor', (await eventos('contrasena_temporal_generada', 't_ana')).at(-1).actor === 't_sop');
  const mismaTemp = await pedir('POST', '/api/auth/contrasena', { cookie: conTemp.cookie, payload: { nueva: temporal } });
  check('No se puede conservar la temporal como contraseña definitiva', mismaTemp.statusCode === 400 && ['historial', 'politica'].includes(mismaTemp.json().codigo));
  check('Soporte no puede generarse una temporal a sí mismo', (await pedir('POST', '/api/soporte/usuarios/t_sop/temporal', { cookie: sop.cookie })).statusCode === 400);
  check('Ni para un usuario inactivo ni inexistente', (await pedir('POST', '/api/soporte/usuarios/t_inactivo/temporal', { cookie: sop.cookie })).statusCode === 400 && (await pedir('POST', '/api/soporte/usuarios/no_existe/temporal', { cookie: sop.cookie })).statusCode === 404);
  await poolApp.query(`UPDATE panel.credenciales SET hash = $1, debe_cambiar = false, temporal_expira_at = NULL WHERE usuario = 't_ana'`, [HASH]);
  _vaciarCacheSesiones();

  // La tabla de usuarios.
  await pedir('PUT', '/api/soporte/usuarios/t_nuevo', { cookie: sop.cookie, payload: { rol: 'analista', correo: 'nuevo@test.local' } });
  const lista = await pedir('GET', '/api/soporte/usuarios', { cookie: sop.cookie });
  const txt = lista.body;
  check('GET /api/soporte/usuarios nunca incluye hashes ni tokens', !/scrypt\$|"hash"|token|codigo_hmac/i.test(txt));
  const filas = lista.json().filas;
  const fa = filas.find((x) => x.usuario === 't_ana');
  check('La tabla informa contraseña, sesiones y bloqueo', filas.every((x) => ['definida', 'temporal', 'sin_definir'].includes(x.clave) && typeof x.sesiones === 'number' && typeof x.bloqueada === 'boolean') && fa.clave === 'definida' && filas.find((x) => x.usuario === 't_nuevo').clave === 'sin_definir');

  // Cerrar sesiones.
  const v2 = await entrar('t_dir');
  const cs = await pedir('POST', '/api/soporte/usuarios/t_dir/cerrar-sesiones', { cookie: sop.cookie });
  check('Cerrar sesiones de una cuenta: devuelve cuántas y las corta', cs.statusCode === 200 && cs.json().cerradas >= 1 && (await pedir('GET', '/api/yo', { cookie: v2.cookie })).statusCode === 401);
  const csPropia = await pedir('POST', '/api/soporte/usuarios/t_sop/cerrar-sesiones', { cookie: sop.cookie });
  check('Si soporte se las cierra a sí mismo conserva la sesión desde la que actúa', csPropia.statusCode === 200 && (await pedir('GET', '/api/yo', { cookie: sop.cookie })).statusCode === 200);

  // Desbloquear.
  vaciarLimites();
  const ipB = ipNueva();
  for (let i = 0; i < 5; i++) await entrar('t_ope', 'x', { ip: ipB });
  const bloqueada = (await pedir('GET', '/api/soporte/usuarios', { cookie: sop.cookie })).json().filas.find((x) => x.usuario === 't_ope').bloqueada;
  check('La tabla marca la cuenta como bloqueada tras los fallos', bloqueada === true);
  check('Bloqueada: ni la clave correcta entra', (await entrar('t_ope', CLAVE, { ip: ipB })).res.statusCode === 429);
  const des = await pedir('POST', '/api/soporte/usuarios/t_ope/desbloquear', { cookie: sop.cookie });
  check('Desbloquear: 204, deja evento y la cuenta vuelve a entrar', des.statusCode === 204 && (await eventos('cuenta_desbloqueada', 't_ope')).length === 1 && (await entrar('t_ope', CLAVE, { ip: ipB })).res.statusCode === 200);
  vaciarLimites();

  // Correo: formato y unicidad.
  const put = (usuario, cuerpo) => pedir('PUT', `/api/soporte/usuarios/${usuario}`, { cookie: sop.cookie, payload: cuerpo });
  const inv = await put('t_ana', { rol: 'analista', correo: 'no-es-un-correo' });
  check('Correo con formato inválido: 400 claro', inv.statusCode === 400 && /formato/i.test(inv.json().error));
  const dup = await put('t_ana', { rol: 'analista', correo: 'CARMEN.ROJAS@test.local' });
  check('Correo duplicado (sin importar mayúsculas): 400 "Ese correo ya está en uso"', dup.statusCode === 400 && dup.json().error === 'Ese correo ya está en uso');
  const okc = await put('t_ana', { rol: 'analista', correo: '  Otro@Test.Local ' });
  check('El correo se guarda sin espacios y en minúsculas', okc.statusCode === 200 && okc.json().correo === 'otro@test.local');
  const vac = await put('t_ana', { rol: 'analista', correo: '' });
  check('Un correo vacío lo borra', vac.statusCode === 200 && vac.json().correo === null);
  await put('t_ana', { rol: 'analista', correo: 'otro@test.local' });

  // Accesos.
  const acc = await pedir('GET', '/api/soporte/autenticacion?dias=30&usuario=t_dir', { cookie: sop.cookie });
  const a = acc.json();
  check('Accesos: devuelve eventos y resumen filtrados por usuario', acc.statusCode === 200 && a.eventos.length > 0 && a.eventos.every((e) => e.usuario === 't_dir') && a.resumen.porTipo.length > 0 && Array.isArray(a.resumen.porDia));
  check('Accesos: no expone contraseñas ni códigos', !/scrypt\$/.test(acc.body) && !SECRETOS.some((x) => acc.body.includes(x)));
  const todos = (await pedir('GET', '/api/soporte/autenticacion?dias=1', { cookie: sop.cookie })).json();
  check('Accesos: sin filtro de usuario trae los de todos', new Set(todos.eventos.map((e) => e.usuario)).size > 1);
  const noHoy = (await pedir('GET', '/api/soporte/autenticacion?dias=1&usuario=nadie', { cookie: sop.cookie })).json();
  check('Accesos: filtra por usuario', noHoy.eventos.length === 0);
}

// ================================================================================== 10. scripts de operación
{
  const entorno = { ...ENTORNO_BASE };
  const r = await correr('server/scripts/acceso-emergencia.ts', ['t_ope'], entorno);
  const temporal = r.stdout.trim();
  secreto(temporal);
  check('acceso-emergencia imprime una temporal que cumple la política, una sola vez', r.code === 0 && cumplePolitica(temporal) && r.stdout.trim().split('\n').length === 1);
  const em = await entrar('t_ope', temporal);
  check('La temporal de emergencia entra y obliga a cambiarla', em.res.statusCode === 200 && em.json.debeCambiar === true);
  check('Deja el evento acceso_emergencia con actor consola', (await eventos('acceso_emergencia', 't_ope')).at(-1)?.actor === 'consola');
  const noExiste = await correr('server/scripts/acceso-emergencia.ts', ['fantasma'], entorno);
  check('acceso-emergencia con un usuario inexistente falla con código distinto de 0', noExiste.code === 1 && noExiste.stdout === '');
  const sinArg = await correr('server/scripts/acceso-emergencia.ts', [], entorno);
  check('Sin argumento da el uso y código distinto de 0', sinArg.code !== 0 && /Uso:/.test(sinArg.stderr));

  const v = await correr('server/scripts/sesion-verificacion.ts', [], entorno);
  const token = v.stdout.trim();
  check('sesion-verificacion imprime solo el token', v.code === 0 && /^[A-Za-z0-9_-]{43}$/.test(token));
  const conCookie = await yo(`panel_sesion=${token}`);
  check('El token sirve como sesión de soporte de 5 minutos', conCookie.usuario === 'soporte' && conCookie.rolReal === 'soporte');
  const fv = await filaSesion(`panel_sesion=${token}`);
  check('La sesión dura 5 minutos y deja el evento con actor despliegue', Math.abs(fv.expira_at.getTime() - fv.creada_at.getTime() - 300_000) < 2000 && (await eventos('sesion_verificacion', 'soporte')).some((e) => e.actor === 'despliegue'));
  check('La sesión de verificación no cuenta como inicio de sesión de la persona', !(await eventos('login_ok', 'soporte')).some((e) => e.actor === 'despliegue'));
  const fallo = await correr('server/scripts/sesion-verificacion.ts', ['fantasma'], entorno);
  check('sesion-verificacion con un usuario inexistente falla', fallo.code === 1 && fallo.stdout === '');
  secreto(token);
}

// =========================================================================== 11. vigilante y retención
{
  await poolApp.query(`DELETE FROM panel.eventos_autenticacion`);
  await poolApp.query(`INSERT INTO panel.eventos_autenticacion (tipo, usuario) SELECT 'login_fallido', NULL FROM generate_series(1, 30)`);
  await poolApp.query(`INSERT INTO panel.eventos_autenticacion (tipo, usuario) SELECT 'cuenta_bloqueada', 't_dir' FROM generate_series(1, 3)`);
  await poolApp.query(`INSERT INTO panel.eventos_autenticacion (tipo, usuario) VALUES ('correo_fallido', 't_dir')`);
  await ejecutarVigilante();
  const alertas = (await poolApp.query(`SELECT clave, severidad, grupo, impacto, enlace FROM panel.alertas WHERE grupo = 'seguridad' AND estado <> 'resuelta'`)).rows;
  const por = Object.fromEntries(alertas.map((x) => [x.clave, x]));
  check('Vigilante: 30 fallos de login en 15 min', por['seguridad:fallos_login']?.severidad === 'media');
  check('Vigilante: misma cuenta con 3 bloqueos en 24 h', por['seguridad:bloqueos']?.severidad === 'media');
  check('Vigilante: correo fallido en la última hora', por['seguridad:correo']?.severidad === 'media');
  check('Vigilante: usuario activo sin correo (baja)', por['seguridad:sin_correo']?.severidad === 'baja' || (await poolApp.query(`SELECT count(*)::int AS n FROM panel.usuarios WHERE activo AND correo IS NULL`)).rows[0].n === 0);
  check('Cada alerta de seguridad tiene impacto en lenguaje claro y enlace a Soporte', alertas.length >= 3 && alertas.every((x) => x.impacto && x.enlace === '#/soporte'));
  await poolApp.query(`DELETE FROM panel.eventos_autenticacion`);
  await ejecutarVigilante();
  check('Las alertas de seguridad se cierran solas cuando la condición desaparece', (await poolApp.query(`SELECT count(*)::int AS n FROM panel.alertas WHERE grupo = 'seguridad' AND estado <> 'resuelta' AND clave <> 'seguridad:sin_correo'`)).rows[0].n === 0);

  // Retención.
  const uid = (await poolApp.query(`SELECT id FROM panel.sesiones LIMIT 1`)).rows[0];
  await poolApp.query(`DELETE FROM panel.sesiones`);
  await poolApp.query(`INSERT INTO panel.sesiones (token_hash, usuario, expira_at, cerrada_at) VALUES ($1, 't_dir', now() - interval '40 days', now() - interval '31 days'), ($2, 't_dir', now() + interval '1 day', NULL), ($3, 't_dir', now() - interval '29 days', NULL), ($4, 't_dir', now() - interval '31 days', NULL)`, [randomBytes(32), randomBytes(32), randomBytes(32), randomBytes(32)]);
  await poolApp.query(`DELETE FROM panel.codigos_recuperacion`);
  await poolApp.query(`INSERT INTO panel.codigos_recuperacion (usuario, codigo_hmac, creado_at, expira_at) VALUES ('t_dir', $1, now() - interval '8 days', now()), ('t_dir', $2, now() - interval '6 days', now())`, [randomBytes(32), randomBytes(32)]);
  await poolApp.query(`INSERT INTO panel.eventos_autenticacion (at, tipo) VALUES (now() - interval '366 days', 'login_ok'), (now() - interval '364 days', 'login_ok')`);
  await poolApp.query(`DELETE FROM panel.contrasenas_previas`);
  await poolApp.query(`INSERT INTO panel.contrasenas_previas (usuario, hash, at) SELECT 't_dir', 'h' || g, now() - (g || ' hours')::interval FROM generate_series(1, 6) g`);
  await limpiar();
  check('Retención: sesiones cerradas o vencidas hace más de 30 días se borran', (await poolApp.query(`SELECT count(*)::int AS n FROM panel.sesiones`)).rows[0].n === 2);
  check('Retención: códigos de recuperación de más de 7 días se borran', (await poolApp.query(`SELECT count(*)::int AS n FROM panel.codigos_recuperacion`)).rows[0].n === 1);
  check('Retención: eventos de más de 365 días se borran', (await poolApp.query(`SELECT count(*)::int AS n FROM panel.eventos_autenticacion`)).rows[0].n === 1);
  const quedan = (await poolApp.query(`SELECT hash FROM panel.contrasenas_previas WHERE usuario = 't_dir' ORDER BY at DESC`)).rows.map((x) => x.hash);
  check('Retención: del historial de contraseñas solo quedan las 3 más recientes', quedan.length === 3 && quedan[0] === 'h1');
  void uid;
}

// ====================================================================================== 12. modo de transición
{
  vaciarLimites();
  process.env.PANEL_AUTH_MODO = 'nginx';
  const sinSesion = await pedir('GET', '/api/yo', { headers: { 'x-remote-user': 't_dir' } });
  const j = sinSesion.json();
  check('Modo nginx: la cabecera X-Remote-User identifica a la persona, como hoy', sinSesion.statusCode === 200 && j.usuario === 't_dir' && j.autenticacion === 'nginx' && j.sesion === null);
  check('Modo nginx: sin cabecera ni usuario de desarrollo no hay identidad (403 de usuario sin rol)', (await pedir('GET', '/api/resumen')).statusCode === 403);
  const lg = await pedir('POST', '/api/auth/login', { payload: { usuario: 't_dir', contrasena: CLAVE } });
  check('Modo nginx: /api/auth/* responde 404', lg.statusCode === 404 && (await pedir('POST', '/api/auth/logout')).statusCode === 404 && (await pedir('GET', '/api/auth/sesiones', { headers: { 'x-remote-user': 't_dir' } })).statusCode === 404);
  const sopN = await pedir('GET', '/api/soporte/usuarios', { headers: { 'x-remote-user': 't_sop' } });
  check('Modo nginx: las acciones de soporte funcionan', sopN.statusCode === 200);
  const tmpN = await pedir('POST', '/api/soporte/usuarios/t_ope/temporal', { headers: { 'x-remote-user': 't_sop' }, sinOrigen: true });
  check('Modo nginx: se conserva la tolerancia a escrituras sin Origin de siempre', tmpN.statusCode === 200);
  const ajenoN = await pedir('POST', '/api/actividad', { headers: { 'x-remote-user': 't_dir', origin: 'https://malo.example' }, payload: { tipo: 'visita' } });
  check('Modo nginx: un Origin ajeno sigue rechazándose', ajenoN.statusCode === 403);
  const sesionEnNginx = await entrar('t_dir').catch(() => null);
  check('Modo nginx: una cookie de sesión no identifica a nadie', !sesionEnNginx || sesionEnNginx.res.statusCode === 404);
  delete process.env.PANEL_AUTH_MODO;
  check('Al volver a sesion la cabecera deja de valer', (await pedir('GET', '/api/yo', { headers: { 'x-remote-user': 't_dir' } })).statusCode === 401);
  check('"Mi cuenta" no aparece en el plan ni cuenta como función', estadoPaginas({ rolReal: 'direccion', rol: 'direccion', nivel: 'full', vistaPrevia: false }).cuenta?.estado === 'ok');
}

// ======================================================================================= 13. arranque real
{
  const puerto = await puertoLibre();
  const hijo = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { ...process.env, ...Object.fromEntries(Object.entries(ENTORNO_BASE).filter(([, v]) => v !== undefined)), PORT: String(puerto), HOST: '127.0.0.1', LOG_LEVEL: 'warn' },
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  hijo.stdout.on('data', (d) => (log += d));
  hijo.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${puerto}`;
  const listo = await espera(async () => {
    try {
      return (await fetch(`${base}/api/health`)).ok;
    } catch {
      return false;
    }
  }, 60_000);
  assert.ok(listo, `el servidor real no arrancó:\n${log.slice(-1500)}`);
  try {
    const yoReal = await fetch(`${base}/api/yo`, { headers: { 'x-remote-user': 'soporte' } });
    check('Servidor real arrancado en modo por defecto: /api/yo con la cabecera falsa da 401', yoReal.status === 401 && (await yoReal.json()).codigo === 'sesion');
    check('Servidor real: la cookie, la CSP y no-store están cableadas', yoReal.headers.get('cache-control') === 'no-store' && yoReal.headers.get('content-security-policy') === CSP);
    const lg = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ usuario: 't_dir', contrasena: CLAVE }) });
    const set = lg.headers.get('set-cookie') ?? '';
    check('Servidor real: el login responde y fija la cookie HttpOnly', lg.status === 200 && /^panel_sesion=/.test(set) && /HttpOnly/i.test(set));
    const cookie = set.split(';')[0];
    const yo2 = await fetch(`${base}/api/yo`, { headers: { cookie } });
    check('Servidor real: la cookie abre /api/yo', yo2.status === 200 && (await yo2.json()).usuario === 't_dir');
    const idx = await fetch(`${base}/`);
    check('Servidor real: el index.html también lleva las cabeceras de seguridad', idx.headers.get('content-security-policy') === CSP && idx.headers.get('x-content-type-options') === 'nosniff');
    const quedan = log.match(/Clave#Segura1/);
    check('Los logs del servidor real no contienen la contraseña', !quedan);
  } finally {
    hijo.kill();
  }
}

// ============================================================================================== cierre
const todasLasSalidas = salidas.join('\n');
for (const v of SECRETOS) assert.ok(!todasLasSalidas.includes(v), 'Un secreto (contraseña, código o token) apareció en la consola del servidor');
comprobaciones.push('Ninguna contraseña, código ni token apareció en la consola durante toda la prueba');
const ultimasLimites = limites.loginIp.tamano;
void ultimasLimites;

await app.close();
await pool.end();
await poolApp.end();
await adm.end();
console.log(`\ntest:auth OK: ${comprobaciones.length} comprobaciones`);
process.exit(0);
