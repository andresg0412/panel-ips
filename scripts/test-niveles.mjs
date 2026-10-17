// Prueba de las restricciones por nivel (Básico / Intermedio / Full) del panel.
// Referencia: proyecto-ips/docs/features/2026-10-17-panel-revision-niveles.md (secciones 3, 4.2 y 5).
//
// Las mismas aserciones (`verificar`) corren en dos modos:
//
//  1. LOCAL, sin base de datos (por defecto): levanta un Fastify en memoria con el pipeline REAL de recortes
//     (`server/recortes.ts`, `server/funciones.ts` y `evaluar`/`historialDesde` de `server/acceso.ts`), con rutas
//     falsas que devuelven datos de ejemplo con la misma forma que las rutas reales. Sirve para que cualquiera
//     la corra sin credenciales y detecta, además, que un recorte NUNCA muta el objeto original (la caché de las
//     rutas se comparte entre niveles).
//        npm run test:niveles
//
//  2. EN VIVO, contra un servidor del panel real: se activa con PANEL_URL. Usa la vista previa de soporte
//     (cabeceras x-panel-vista-nivel y x-panel-vista-rol), así que PANEL_USUARIO debe ser un usuario con rol
//     `soporte` en `panel.usuarios` (el panel necesita DATABASE_URL y DATABASE_URL_APP; sin DATABASE_URL_APP
//     arranca en modo legado, donde todos son Dirección/Full y no existe vista previa).
//        PANEL_URL=http://localhost:8100 PANEL_USUARIO=soporte npm run test:niveles
//     Con datos reales una lista puede venir vacía legítimamente: en vivo, eso en Intermedio/Full es una
//     advertencia, no un fallo (lo que sí falla es que venga recortada, es decir, `null` o con la forma de Básico).
import assert from 'node:assert/strict';

const PANEL_URL = process.env.PANEL_URL?.replace(/\/$/, '') || null;
const PANEL_USUARIO = process.env.PANEL_USUARIO || 'soporte';
const EN_VIVO = !!PANEL_URL;

const NIVELES = ['basico', 'intermedio', 'full'];
const DIAS_HISTORIAL = { basico: 90, intermedio: 365, full: null };

const comprobaciones = [];
const advertencias = [];
const check = (etiqueta, condicion) => {
  assert.ok(condicion, etiqueta);
  comprobaciones.push(etiqueta);
};

// ------------------------------------------------------------------------------------------- fechas
const DIA_MS = 86_400_000;
const hoyBogota = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
const sumarDias = (f, n) => new Date(Date.parse(`${f}T00:00:00Z`) + n * DIA_MS).toISOString().slice(0, 10);
/** Primer mes ("YYYY-MM") que un nivel puede ver; null = sin límite. Calculado aquí, sin usar el código bajo prueba. */
const mesDesde = (nivel) => (DIAS_HISTORIAL[nivel] === null ? null : sumarDias(hoyBogota(), -(DIAS_HISTORIAL[nivel] - 1)).slice(0, 7));
/** Meses "YYYY-MM" desde ago-2025 (inicio de los datos) hasta el mes actual. */
function mesesDesdeInicio() {
  const fin = hoyBogota().slice(0, 7);
  const out = [];
  for (let [a, m] = [2025, 8]; `${a}-${String(m).padStart(2, '0')}` <= fin; m === 12 ? ((a += 1), (m = 1)) : (m += 1)) {
    out.push(`${a}-${String(m).padStart(2, '0')}`);
  }
  return out;
}

// -------------------------------------------------------------------------------- datos de ejemplo (modo local)
// Misma forma que devuelven las rutas reales de server/routes/*.ts.
function datosDeEjemplo() {
  const meses = mesesDesdeInicio();
  const conteo = (...claves) => claves.map((clave, i) => ({ clave, n: 10 - i }));
  return {
    '/api/lista-espera': {
      inscripcionesHoy: conteo('activa'),
      inscripciones: conteo('activa', 'pausada'),
      cupos: conteo('asignado'),
      ofertas: conteo('aceptada', 'expirada'),
      invitaciones: conteo('aceptada'),
      cuposRecientes: [{ detectado: '2026-10-01T10:00:00', estado: 'asignado' }],
      ofertasRecientes: [{ enviada: '2026-10-01T10:00:00', estado: 'aceptada' }],
      ejecuciones: [],
      embudo: { cupos: 8, con_oferta: 6, aceptados: 4, asignados: 3, horas_recuperadas: 3, minutos_hasta_asignar: 25, recolocadas_atendidas: 1 },
      motivos: conteo('sin_candidatos'),
      invitacionesPorTipo: [],
      ahora: { activas: 12, con_oferta_en_curso: 2, esperando_cupo: 7, sin_cita_elegible: 3, pausadas: 4, cupos_en_espera: 1 },
      pausadas: conteo('sin_respuesta', 'no_entregable'),
      flujoPeriodo: conteo('inscritos', 'consiguieron_cupo'),
      flujoDiario: [{ dia: '2026-10-01', clave: 'inscritos', n: 2 }],
      respuesta: { ofertas: 6, con_toque: 4, aceptaciones_perdidas: 1, minutos_a_leer: 3.5, minutos_a_responder: 7.2 },
    },
    '/api/pacientes/panorama': {
      mensual: meses.map((mes, i) => ({ mes, nuevos: 20 + i, recurrentes: 50 + i })),
      intervalos: [{ semana: 1, n: 30 }, { semana: 2, n: 22 }],
      perfil: [{ dimension: 'edad', clave: '18-29', n: 40 }, { dimension: 'pago', clave: 'particular', n: 40 }],
      resumenIntervalos: { n: 500, p25: 7, mediana: 14, p75: 28 },
    },
    '/api/chatbot': {
      rango: { grano: 'day' },
      kpis: { sesiones: 300, personas: 210, abandonadas: 40, mediana_min: 2.5, mensajes_promedio: 6.1, fuera_horario: 60, derivadas_fuera_horario: 5 },
      serie: [{ periodo: '2026-10-01', completadas: 10, abandonadas: 2 }],
      resultado: conteo('cita_creada', 'sin_gestion'),
      primerFlujo: conteo('agendar', 'cancelar'),
      motivoFin: conteo('flujo_completo'),
      mapaCalor: [{ dia: 1, hora: 9, n: 12 }],
      conversion: [{ clave: 'agendar', entraron: 100, lograron: 40, derivadas: 3 }],
    },
    '/api/agenda': {
      rango: { grano: 'day' },
      serie: [{ periodo: '2026-10-01', grupo: 'Asistió', n: 30 }],
      especialidad: [{ nombre: 'Psicología', total: 100, asistio: 70, no_asistio: 10, canceladas: 15, reprogramadas: 3, programadas: 2 }],
      profesional: [{ nombre: 'Profesional A', total: 50, asistio: 35, no_asistio: 5, canceladas: 8, reprogramadas: 1, programadas: 1 }],
      administradora: [{ nombre: 'Sura', total: 40, asistio: 30, no_asistio: 4, canceladas: 5, reprogramadas: 1, programadas: 0 }],
      diaSemana: [{ dia: 1, total: 20, asistio: 15, no_asistio: 2, canceladas: 3, reprogramadas: 0, programadas: 0 }],
      origenCancelacion: [{ origen: 'paciente_bot', n: 6 }],
      cambios: [{ cuando: '2026-10-01T10:00:00', estado_nuevo: 'Cancelado', origen: 'bot' }],
      servicio: [{ nombre: 'control', total: 70, asistio: 50, canceladas: 10, reprogramadas: 2, horas_no_ocurrieron: 8 }],
    },
    '/api/campanas': {
      rango: { grano: 'day' },
      porCampana: [
        { campana: 'execute', dias: 20, enviados: 400, fallidos: 12, entregados: 380, leidos: 300, respondieron: 150, respondieron_tarde: 20, no_respondieron: 180, pendientes: 38, citas_confirmadas: 160, citas_canceladas: 25 },
        { campana: 'reminder', dias: 20, enviados: 380, fallidos: 5, entregados: 370, leidos: 280, respondieron: 120, respondieron_tarde: 15, no_respondieron: 200, pendientes: 35, citas_confirmadas: 130, citas_canceladas: 18 },
      ],
      serie: [{ periodo: '2026-10-01', campana: 'execute', enviados: 20 }],
      entregaDesde: '2026-10-01',
    },
    '/api/profesionales/ficha': {
      nombre: 'Profesional A',
      kpis: { total: 50, asistio: 35 },
      mensual: meses.map((mes) => ({ mes, asistio: 30, no_asistio: 4, no_ocurrieron: 6 })),
      servicios: [{ clave: 'control', n: 20 }],
      franja: [{ clave: '9', cerradas: 10, no_asistio: 1 }],
      dia: [{ clave: 1, n: 12 }],
    },
  };
}

const PRUEBAS = [
  ['listaEspera', 'GET', '/api/lista-espera'],
  ['panorama', 'GET', '/api/pacientes/panorama'],
  ['chatbot', 'GET', '/api/chatbot'],
  ['agenda', 'GET', '/api/agenda'],
  ['campanas', 'GET', '/api/campanas'],
  ['ficha', 'GET', '/api/profesionales/ficha'],
  ['envios', 'GET', '/api/campanas/envios'],
];

// ------------------------------------------------------------------------------------ cliente según el modo
/** Devuelve `async (nivel) => { listaEspera, panorama, ..., envios }` con { status, body } por endpoint. */
async function clienteLocal() {
  const { default: Fastify } = await import('fastify');
  const { instalarRecortes } = await import('../server/recortes.ts');
  const { ENDPOINTS } = await import('../server/funciones.ts');
  const { evaluar, historialDesde } = await import('../server/acceso.ts');

  const ejemplo = datosDeEjemplo();
  // Copia intacta para comprobar al final que ningún recorte mutó el objeto "en caché" que devolvieron las rutas.
  const intacto = structuredClone(ejemplo);

  const app = Fastify();
  // Contexto de vista previa de soporte, igual que lo arma resolverContexto() para x-panel-vista-nivel / -rol.
  app.addHook('onRequest', async (req) => {
    const nivel = req.headers['x-panel-vista-nivel'];
    req.contexto = {
      usuario: 'prueba',
      rolReal: 'soporte',
      nivelReal: 'full',
      rol: req.headers['x-panel-vista-rol'],
      nivel,
      vistaPrevia: true,
      historialDesde: historialDesde(nivel),
      habilitado: true,
    };
    // Mismo control de nivel que instalarAcceso(): 402 si el nivel no alcanza la función del endpoint.
    const ev = evaluar(req.contexto, ENDPOINTS[`${req.method} ${req.routeOptions.url}`]);
    if (!ev.ok) throw Object.assign(new Error('nivel'), { statusCode: ev.motivo === 'nivel' ? 402 : 403 });
  });
  instalarRecortes(app);
  // Cada ruta devuelve SIEMPRE el mismo objeto (como conCache), para detectar mutaciones.
  for (const [, , ruta] of PRUEBAS) app.get(ruta, async () => ejemplo[ruta] ?? { filas: [] });
  await app.ready();

  return {
    modo: 'local (sin base de datos)',
    async respuestas(nivel) {
      const out = {};
      for (const [clave, , ruta] of PRUEBAS) {
        const r = await app.inject({
          method: 'GET',
          url: ruta,
          headers: { 'x-panel-vista-nivel': nivel, 'x-panel-vista-rol': 'direccion' },
        });
        out[clave] = { status: r.statusCode, body: r.statusCode === 200 ? r.json() : null };
      }
      return out;
    },
    async alFinal() {
      assert.deepEqual(ejemplo, intacto, 'Un recorte modificó el objeto original (rompería la caché compartida entre niveles)');
      comprobaciones.push('Ningún recorte muta el objeto original de la ruta (caché compartida entre niveles)');
      await app.close();
    },
  };
}

async function clienteEnVivo() {
  const pedir = async (ruta, nivel) => {
    const r = await fetch(`${PANEL_URL}${ruta}`, {
      headers: { 'x-remote-user': PANEL_USUARIO, 'x-panel-vista-nivel': nivel, 'x-panel-vista-rol': 'direccion' },
    });
    return { status: r.status, body: r.status === 200 ? await r.json() : null };
  };
  // Un profesional que exista: la lista de profesionales es de nivel Básico.
  const lista = await pedir('/api/profesionales', 'full');
  assert.equal(lista.status, 200, `GET /api/profesionales respondió ${lista.status}: ¿PANEL_USUARIO "${PANEL_USUARIO}" tiene rol soporte?`);
  const profesional = lista.body.filas?.[0]?.nombre;
  assert.ok(profesional, 'No hay profesionales para probar la ficha');

  return {
    modo: `en vivo (${PANEL_URL}, usuario ${PANEL_USUARIO}, profesional "${profesional}")`,
    async respuestas(nivel) {
      const out = {};
      for (const [clave, , ruta] of PRUEBAS) {
        const url = clave === 'ficha' ? `${ruta}?nombre=${encodeURIComponent(profesional)}` : ruta;
        out[clave] = await pedir(url, nivel);
      }
      return out;
    },
    async alFinal() {},
  };
}

// ------------------------------------------------------------------------------------------- aserciones
const esNumero = (v) => typeof v === 'number' && Number.isFinite(v);
const vacia = (v) => Array.isArray(v) && v.length === 0;

/** En Intermedio/Full: "tiene datos". En vivo una lista vacía puede ser real, así que solo avisa. */
function conDatos(etiqueta, lista) {
  if (EN_VIVO && Array.isArray(lista) && lista.length === 0) {
    advertencias.push(`${etiqueta}: vacío (puede ser real con los datos de este período)`);
    return;
  }
  check(etiqueta, Array.isArray(lista) && lista.length > 0);
}

function verificar(nivel, r) {
  const N = nivel.toUpperCase();
  const b = (clave) => {
    assert.equal(r[clave].status, 200, `${N}: GET de ${clave} respondió ${r[clave].status}`);
    return r[clave].body;
  };

  // ---- Lista de espera (H1)
  const le = b('listaEspera');
  if (nivel === 'basico') {
    for (const k of ['pausadas', 'flujoPeriodo', 'flujoDiario', 'inscripciones', 'cupos', 'ofertas', 'cuposRecientes', 'ofertasRecientes', 'motivos']) {
      check(`${N} lista de espera: "${k}" viene vacío`, vacia(le[k]));
    }
    check(`${N} lista de espera: la respuesta a ofertas viene en ceros/null`,
      le.respuesta.ofertas === 0 && le.respuesta.con_toque === 0 && le.respuesta.aceptaciones_perdidas === 0 &&
      le.respuesta.minutos_a_leer === null && le.respuesta.minutos_a_responder === null);
    check(`${N} lista de espera: el desglose de "ahora" viene en null`,
      le.ahora.con_oferta_en_curso === null && le.ahora.sin_cita_elegible === null && le.ahora.cupos_en_espera === null);
    check(`${N} lista de espera: conserva activas, esperando cupo y pausadas (solo el total)`,
      esNumero(le.ahora.activas) && esNumero(le.ahora.esperando_cupo) && esNumero(le.ahora.pausadas));
  } else {
    check(`${N} lista de espera: el desglose de "ahora" trae datos`,
      esNumero(le.ahora.con_oferta_en_curso) && esNumero(le.ahora.sin_cita_elegible) && esNumero(le.ahora.cupos_en_espera));
    check(`${N} lista de espera: la respuesta a ofertas trae datos`, esNumero(le.respuesta.ofertas) && (EN_VIVO || le.respuesta.ofertas > 0));
    conDatos(`${N} lista de espera: pausadas por motivo`, le.pausadas);
    conDatos(`${N} lista de espera: flujo del período`, le.flujoPeriodo);
    conDatos(`${N} lista de espera: tablas de ofertas recientes`, le.ofertasRecientes);
  }

  // ---- Pacientes: panorama (H2) y límite de historial
  const pp = b('panorama');
  checkMeses(N, 'pacientes (panorama)', pp.mensual, nivel);
  if (nivel === 'basico') {
    check(`${N} pacientes: intervalos y perfil vienen vacíos`, vacia(pp.intervalos) && vacia(pp.perfil));
    check(`${N} pacientes: el resumen de intervalos viene en null`,
      pp.resumenIntervalos.mediana === null && pp.resumenIntervalos.p25 === null && pp.resumenIntervalos.p75 === null);
  } else {
    conDatos(`${N} pacientes: intervalos`, pp.intervalos);
    conDatos(`${N} pacientes: perfil`, pp.perfil);
    check(`${N} pacientes: el resumen de intervalos trae datos`, EN_VIVO ? pp.resumenIntervalos !== null : esNumero(pp.resumenIntervalos.mediana));
  }

  // ---- Ficha del profesional (H3): Intermedio con 365 días; en Básico el endpoint responde 402
  if (nivel === 'basico') {
    check(`${N} ficha del profesional: responde 402 (plan Intermedio)`, r.ficha.status === 402);
  } else {
    checkMeses(N, 'ficha del profesional', b('ficha').mensual, nivel);
  }

  // ---- Chatbot (H4)
  const cb = b('chatbot');
  if (nivel === 'basico') {
    for (const k of ['mapaCalor', 'conversion', 'primerFlujo', 'motivoFin']) check(`${N} chatbot: "${k}" viene vacío`, vacia(cb[k]));
    check(`${N} chatbot: duración, mensajes y fuera de horario vienen en null`,
      cb.kpis.mediana_min === null && cb.kpis.mensajes_promedio === null && cb.kpis.fuera_horario === null && cb.kpis.derivadas_fuera_horario === null);
    check(`${N} chatbot: conserva conversaciones, personas y abandonadas`, esNumero(cb.kpis.sesiones) && esNumero(cb.kpis.personas) && esNumero(cb.kpis.abandonadas));
    conDatos(`${N} chatbot: conserva la serie diaria`, cb.serie);
    conDatos(`${N} chatbot: conserva el resultado de negocio`, cb.resultado);
  } else {
    check(`${N} chatbot: fuera de horario y derivadas traen datos`, esNumero(cb.kpis.fuera_horario) && esNumero(cb.kpis.derivadas_fuera_horario));
    conDatos(`${N} chatbot: mapa de calor`, cb.mapaCalor);
    conDatos(`${N} chatbot: conversión por trámite`, cb.conversion);
    conDatos(`${N} chatbot: primer trámite`, cb.primerFlujo);
    conDatos(`${N} chatbot: motivo de cierre`, cb.motivoFin);
  }

  // ---- Agenda (H5)
  const ag = b('agenda');
  conDatos(`${N} agenda: conserva la serie por estado`, ag.serie);
  conDatos(`${N} agenda: conserva especialidad`, ag.especialidad);
  conDatos(`${N} agenda: conserva profesional`, ag.profesional);
  if (nivel === 'basico') {
    for (const k of ['administradora', 'servicio', 'diaSemana', 'origenCancelacion', 'cambios']) check(`${N} agenda: "${k}" viene vacío`, vacia(ag[k]));
  } else {
    for (const k of ['administradora', 'servicio', 'diaSemana', 'origenCancelacion', 'cambios']) conDatos(`${N} agenda: "${k}"`, ag[k]);
  }

  // ---- Campañas (H6)
  const ca = b('campanas');
  conDatos(`${N} campañas: hay campañas`, ca.porCampana);
  for (const f of ca.porCampana) {
    check(`${N} campañas (${f.campana}): conserva enviados, fallidos, entregados y confirmadas`,
      esNumero(f.enviados) && esNumero(f.fallidos) && esNumero(f.entregados) && esNumero(f.citas_confirmadas));
    const respuesta = ['leidos', 'respondieron', 'respondieron_tarde', 'no_respondieron', 'pendientes', 'citas_canceladas'];
    if (nivel === 'basico') check(`${N} campañas (${f.campana}): lectura y respuesta vienen en null`, respuesta.every((k) => f[k] === null));
    else check(`${N} campañas (${f.campana}): lectura y respuesta traen datos`, respuesta.every((k) => esNumero(f[k])));
  }

  // ---- Control: la vista previa funciona (detalle de envíos es Intermedio)
  if (nivel === 'basico') check(`${N} control: GET /api/campanas/envios responde 402`, r.envios.status === 402);
  else check(`${N} control: GET /api/campanas/envios no se bloquea por nivel`, r.envios.status !== 402);
}

/** Ningún mes anterior al historial del nivel; Full conserva todo el historial; Intermedio conserva más que Básico. */
function checkMeses(N, donde, mensual, nivel) {
  const meses = mensual.map((m) => m.mes);
  const desde = mesDesde(nivel);
  conDatos(`${N} ${donde}: tiene meses`, mensual);
  if (desde) check(`${N} ${donde}: ningún mes anterior a ${desde} (${DIAS_HISTORIAL[nivel]} días)`, meses.every((m) => m >= desde));
  else if (!EN_VIVO) check(`${N} ${donde}: conserva todo el historial (desde 2025-08)`, meses[0] === '2025-08');
  if (nivel === 'intermedio' && !EN_VIVO) {
    check(`${N} ${donde}: llega más atrás que Básico (${mesDesde('basico')})`, meses.some((m) => m < mesDesde('basico')));
  }
}

// -------------------------------------------------------------------------------------------------- main
const cliente = EN_VIVO ? await clienteEnVivo() : await clienteLocal();
console.log(`Modo: ${cliente.modo}`);
for (const nivel of NIVELES) verificar(nivel, await cliente.respuestas(nivel));
await cliente.alFinal();

// Las claves nuevas del plan existen, son de Intermedio y no son endpoints (son recortes dentro de rutas de Básico).
{
  const { FUNCIONES, ENDPOINTS } = await import('../server/funciones.ts');
  for (const clave of ['campanas.respuesta', 'chatbot.detalle', 'agenda.desglose', 'pacientes.perfil']) {
    const f = FUNCIONES.find((x) => x.clave === clave);
    check(`Función "${clave}" definida en nivel Intermedio`, f?.nivel === 'intermedio' && !!f.pagina && !!f.titulo);
    check(`Función "${clave}" no es un endpoint (es un recorte dentro de uno de Básico)`, !Object.values(ENDPOINTS).includes(clave));
  }
}

for (const a of advertencias) console.warn(`  ⚠ ${a}`);
console.log(`Niveles: ${comprobaciones.length} comprobaciones OK${advertencias.length ? ` (${advertencias.length} advertencias)` : ''}`);
process.exit(0);
