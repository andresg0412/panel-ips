// Sala de control (Etapa 2): tendencia de los indicadores, "lo más relevante del período", "qué requiere
// atención", índice de confianza de los datos y metas editables.
// Plan: proyecto-ips/docs/features/2026-10-04-panel-valor-niveles-soporte-plan.md, Etapa 2.
import type { FastifyInstance } from 'fastify';
import { query, queryApp, queryOne } from '../db.js';
import { conCache } from '../cache.js';
import { claveCache, puede, registrarActividad } from '../acceso.js';
import { ErrorParametro, hoyBogota, leerRango, sumarDias, type Rango } from '../params.js';
import { CITAS, HOY } from '../sql.js';
import { CAPACIDAD_DESDE, capacidad, contacto, ejecuciones } from '../sql2.js';
import { datosResumen, fraccionEnIncidente, periodoComparacion } from './resumen.js';
import { incidentes } from '../incidentes.js';
import { alertasConEstado } from './alertas.js';
import { INDICADORES, leerMetas } from '../metas.js';
import { horasDe, leerParametros, minutosAhorrados } from '../parametros.js';
import { rangoNivel } from '../funciones.js';
import { anomalias, enlaceAnomalia } from './inteligencia.js';

type N = Record<string, number>;

export interface Frase {
  clave: string;
  /** Texto con **negritas**. */
  texto: string;
  tono: 'positivo' | 'negativo' | 'neutro';
  enlace: string;
}

export interface ItemAtencion {
  clave: string;
  severidad: 'alta' | 'media' | 'info';
  texto: string;
  enlace: string;
}

const pct = (v: number, dec = 1) => `${(v * 100).toFixed(dec).replace('.', ',')} %`;
const pts = (v: number) => `${Math.abs(v * 100).toFixed(1).replace('.', ',')} puntos`;
const nf = new Intl.NumberFormat('es-CO');
const num = (v: number) => nf.format(Math.round(v));
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

/** Trámites que el bot resolvió sin recepción: confirmaciones por WhatsApp y citas agendadas, canceladas o movidas. */
const tramites = (i: { envios: N; sesiones: N }) =>
  i.envios.confirmaron + i.sesiones.citas_creadas + i.sesiones.citas_canceladas + i.sesiones.citas_reprogramadas;

const ayer = () => sumarDias(hoyBogota(), -1);
const hastaCerrado = (r: Rango) => (r.hasta < ayer() ? r.hasta : ayer());

// ------------------------------------------------------------------------------- datos de base
/** Clave de agrupación de una especialidad: el maestro tiene variantes ("Psicologia Clinica" / "Psicología Clínica"). */
export const normalizar = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Consultas pesadas que comparten la tendencia y las frases, una sola vez cada una:
 * - primera atención de cada paciente (misma definición de "paciente nuevo" que /api/resumen/metas), por día;
 * - capacidad de la agenda por día y especialidad.
 */
async function base(r: Rango, comp: { desde: string | null }) {
  const sem0 = sumarDias(r.hasta, -62);
  const desdeMin = [sem0, r.desde, comp.desde ?? r.desde].sort()[0];
  const hc = hastaCerrado(r);
  const desdeCap = [sem0, r.desde].sort()[0];
  const [primeras, cap] = await Promise.all([
    query<{ dia: string; n: number }>(
      `WITH ${CITAS},
       prim AS (SELECT paciente_id, min(fecha_cita) AS primera FROM citas
                 WHERE es_cita_paciente AND grupo = 'Asistió' AND paciente_id IS NOT NULL GROUP BY 1)
       SELECT primera::text AS dia, count(*) AS n FROM prim WHERE primera BETWEEN $1 AND $2 GROUP BY 1`,
      [desdeMin, r.hasta],
    ),
    hc >= CAPACIDAD_DESDE && hc >= desdeCap
      ? query<{ dia: string; especialidad: string | null; cupos: number; ocupan: number }>(
          `WITH ${CITAS}, ${capacidad('$1', '$2')}
           SELECT fecha::text AS dia, especialidad, sum(cupos) AS cupos, sum(ocupan) AS ocupan FROM capacidad GROUP BY 1, 2`,
          [desdeCap, hc],
        )
      : Promise.resolve([]),
  ]);
  const nuevosEntre = (d: string, h: string) => primeras.filter((x) => x.dia >= d && x.dia <= h).reduce((s, x) => s + x.n, 0);
  return { primeras, cap, nuevosEntre };
}

type Base = Awaited<ReturnType<typeof base>>;

// ------------------------------------------------------------------------------------ tendencia
const lunes = (dia: string) => {
  const d = new Date(`${dia}T00:00:00Z`);
  return sumarDias(dia, -((d.getUTCDay() + 6) % 7));
};

/** Ocho semanas (lunes a domingo) que terminan en la semana de `hasta`: el minigráfico de cada indicador. */
async function semanas(hasta: string, baseP: Promise<Base>) {
  const SEM = `s AS (SELECT generate_series(date_trunc('week', $1::date) - interval '7 weeks', date_trunc('week', $1::date), interval '1 week')::date AS semana)`;
  const [citas, bot] = await Promise.all([
    query<{ semana: string; asistio: number; no_asistio: number; canceladas: number; total: number; no_ocurrieron: number }>(
      // Cada cita se etiqueta con su semana en una sola pasada y se une por igualdad (un JOIN por rango de fechas
      // recorrería `citas` una vez por semana).
      `WITH ${CITAS}, ${SEM},
       c AS (SELECT date_trunc('week', fecha_cita)::date AS semana, grupo FROM citas
              WHERE es_cita_paciente AND fecha_cita >= date_trunc('week', $1::date) - interval '7 weeks' AND fecha_cita <= $1)
       SELECT s.semana::text AS semana,
              count(c.semana) FILTER (WHERE c.grupo = 'Asistió') AS asistio,
              count(c.semana) FILTER (WHERE c.grupo = 'No asistió') AS no_asistio,
              count(c.semana) FILTER (WHERE c.grupo = 'Cancelada') AS canceladas,
              count(c.semana) AS total,
              count(c.semana) FILTER (WHERE c.grupo IN ('Cancelada', 'Reprogramada')) AS no_ocurrieron
         FROM s LEFT JOIN c USING (semana)
        GROUP BY 1 ORDER BY 1`,
      [hasta],
    ),
    query<{ semana: string; n: number }>(
      `WITH ${SEM},
       e AS (SELECT date_trunc('week', fecha_bogota)::date AS semana, count(*) AS n FROM bi.fact_envios
              WHERE fecha_bogota BETWEEN $2 AND $1 AND tipo_envio = 'plantilla' AND (respuesta_tipo = 'confirmo' OR cita_confirmada_despues)
              GROUP BY 1),
       b AS (SELECT date_trunc('week', fecha_bogota)::date AS semana, count(*) AS n FROM bi.fact_sesiones
              WHERE fecha_bogota BETWEEN $2 AND $1 AND resultado_negocio IN ('cita_creada', 'cita_cancelada', 'cita_reprogramada')
              GROUP BY 1)
       SELECT s.semana::text AS semana, coalesce(e.n, 0) + coalesce(b.n, 0) AS n
         FROM s LEFT JOIN e USING (semana) LEFT JOIN b USING (semana) ORDER BY 1`,
      [hasta, sumarDias(hasta, -62)],
    ),
  ]);
  const b = await baseP;
  const tram = new Map(bot.map((x) => [x.semana, x.n]));
  const nuevos = new Map<string, number>();
  for (const x of b.primeras) nuevos.set(lunes(x.dia), (nuevos.get(lunes(x.dia)) ?? 0) + x.n);
  const ocup = new Map<string, { cupos: number; ocupan: number }>();
  for (const x of b.cap) {
    const k = lunes(x.dia);
    const o = ocup.get(k) ?? { cupos: 0, ocupan: 0 };
    o.cupos += x.cupos;
    o.ocupan += x.ocupan;
    ocup.set(k, o);
  }
  return citas.map((c) => ({
    semana: c.semana,
    atendidas: c.asistio,
    asistencia: ratio(c.asistio, c.asistio + c.no_asistio),
    cumplimiento: ratio(c.asistio, c.asistio + c.no_asistio + c.canceladas),
    no_ocurrieron: ratio(c.no_ocurrieron, c.total),
    nuevos: nuevos.get(c.semana) ?? 0,
    tramites: tram.get(c.semana) ?? 0,
    ocupacion: ocup.has(c.semana) ? ratio(ocup.get(c.semana)!.ocupan, ocup.get(c.semana)!.cupos) : null,
  }));
}

// ------------------------------------------------------------------------- lo más relevante
async function relevante(r: Rango, baseP: Promise<Base>, conHoras: boolean) {
  const datos = await datosResumen(r);
  const a = datos.actual as unknown as { citas: N; envios: N; sesiones: N; listaEspera: N };
  const p = datos.anterior as unknown as { citas: N; envios: N; sesiones: N } | null;
  const comp = datos.comparacion;
  const textoComp = comp.tipo === 'interanual' ? 'el mismo período del año anterior' : 'el período anterior';
  const frente = comp.tipo === 'interanual' ? 'frente al mismo período del año anterior' : 'frente al período anterior';
  const hc = hastaCerrado(r);

  const [cobertura, lista] = await Promise.all([
    hc >= r.desde
      ? queryOne<{ citas: number; con_recordatorio: number }>(
          `WITH ${CITAS}, ${contacto('$1', '$2')}
           SELECT count(*) AS citas, count(*) FILTER (WHERE recibio_48h OR recibio_24h OR recibio_2h) AS con_recordatorio
             FROM contacto WHERE grupo IN ('Asistió', 'No asistió', 'Sin cierre')`,
          [r.desde, hc],
        )
      : Promise.resolve({ citas: 0, con_recordatorio: 0 }),
    queryOne<{ asignados: number; horas: number }>(
      `SELECT count(*) AS asignados,
              coalesce(round(sum(extract(epoch FROM (hora_final - hora_cita)) / 3600.0) FILTER (WHERE hora_final > hora_cita)::numeric, 1), 0) AS horas
         FROM cupos_liberados
        WHERE estado = 'asignado'
          AND (asignado_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota') >= $1::date
          AND (asignado_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota') < $2::date + 1`,
      [r.desde, r.hasta],
    ),
  ]);
  const b = await baseP;
  const nuevos = { cur: b.nuevosEntre(r.desde, r.hasta), prev: comp.desde && comp.hasta ? b.nuevosEntre(comp.desde, comp.hasta) : 0 };
  // Ocupación por especialidad en los días ya pasados del período, unificando variantes del nombre.
  const porEsp = new Map<string, { nombres: Map<string, number>; cupos: number; ocupan: number }>();
  for (const x of b.cap) {
    if (!x.especialidad || x.dia < r.desde || x.dia > hc) continue;
    const k = normalizar(x.especialidad);
    const e = porEsp.get(k) ?? { nombres: new Map(), cupos: 0, ocupan: 0 };
    e.cupos += x.cupos;
    e.ocupan += x.ocupan;
    e.nombres.set(x.especialidad, (e.nombres.get(x.especialidad) ?? 0) + x.cupos);
    porEsp.set(k, e);
  }
  // Nombre visible: la variante con tildes si existe; si no, la más frecuente.
  const especialidades = [...porEsp.values()].map((e) => {
    const nombres = [...e.nombres.entries()].sort((x, y) => Number(/[^\x00-\x7f]/.test(y[0])) - Number(/[^\x00-\x7f]/.test(x[0])) || y[1] - x[1]);
    return { especialidad: nombres[0][0], cupos: e.cupos, ocupan: e.ocupan };
  });

  const frases: Frase[] = [];
  const comparable = comp.tipo !== 'ninguna' && p;

  // Asistencia: solo con al menos 50 citas cerradas en cada período.
  const cerr = a.citas.asistio + a.citas.no_asistio;
  const asis = ratio(a.citas.asistio, cerr);
  if (comparable && asis !== null && cerr >= 50 && p.citas.asistio + p.citas.no_asistio >= 50) {
    const ant = p.citas.asistio / (p.citas.asistio + p.citas.no_asistio);
    const d = asis - ant;
    frases.push(
      Math.abs(d) >= 0.015
        ? {
            clave: 'asistencia',
            texto: `La asistencia ${d > 0 ? 'subió' : 'bajó'} **${pts(d)}** (de ${pct(ant)} a ${pct(asis)}) ${frente}.`,
            tono: d > 0 ? 'positivo' : 'negativo',
            enlace: '#/agenda?t=inasistencia',
          }
        : { clave: 'asistencia', texto: `La asistencia se mantuvo estable en **${pct(asis)}**.`, tono: 'neutro', enlace: '#/agenda?t=inasistencia' },
    );
  }

  // Cancelaciones y reprogramaciones.
  const noOc = ratio(a.citas.canceladas + a.citas.reprogramadas, a.citas.total);
  if (comparable && noOc !== null && a.citas.total >= 50 && p.citas.total >= 50) {
    const ant = (p.citas.canceladas + p.citas.reprogramadas) / p.citas.total;
    const d = noOc - ant;
    if (Math.abs(d) >= 0.02) {
      frases.push({
        clave: 'no_ocurrieron',
        texto: `Las cancelaciones y reprogramaciones ${d < 0 ? 'bajaron' : 'subieron'} **${pts(d)}**: hoy son el ${pct(noOc)} de las citas.`,
        tono: d < 0 ? 'positivo' : 'negativo',
        enlace: '#/agenda?t=tendencias',
      });
    }
  }

  // Lo que hizo el bot.
  const t = tramites(a);
  if (t > 0) {
    const fh = ratio(a.sesiones.fuera_horario, a.sesiones.total);
    // Plan Full: las horas de recepción que equivalen esos trámites (Etapa 3).
    let horas = '';
    if (conHoras) {
      const h = horasDe(
        minutosAhorrados(
          { agendadas: a.sesiones.citas_creadas, reprogramadas: a.sesiones.citas_reprogramadas, canceladas: a.sesiones.citas_canceladas, confirmadas: a.envios.confirmaron },
          await leerParametros(),
        ),
      );
      if (h >= 1) horas = ` (unas **${num(h)} horas** de trabajo de recepción)`;
    }
    frases.push({
      clave: 'bot',
      texto: `El bot resolvió **${num(t)} trámites** sin pasar por recepción${horas}${fh !== null && fh >= 0.05 ? `, y el ${pct(fh, 0)} de las conversaciones llegó fuera de horario` : ''}.`,
      tono: 'positivo',
      enlace: '#/chatbot',
    });
  }

  // Cobertura de los recordatorios.
  const cob = ratio(cobertura.con_recordatorio, cobertura.citas);
  if (cob !== null && cobertura.citas >= 30) {
    frases.push({
      clave: 'cobertura',
      texto: `El **${pct(cob, 0)}** de las citas ya ocurridas recibió al menos un recordatorio por WhatsApp.`,
      tono: cob >= 0.8 ? 'positivo' : cob < 0.6 ? 'negativo' : 'neutro',
      enlace: '#/campanas?t=efecto',
    });
  }

  // Volumen de citas atendidas.
  if (comparable && p.citas.asistio >= 50) {
    const c = (a.citas.asistio - p.citas.asistio) / p.citas.asistio;
    if (Math.abs(c) >= 0.1) {
      frases.push({
        clave: 'atendidas',
        texto: `Se atendieron **${num(a.citas.asistio)} citas**, un ${pct(Math.abs(c), 0)} ${c > 0 ? 'más' : 'menos'} que en ${textoComp}.`,
        tono: c > 0 ? 'positivo' : 'negativo',
        enlace: '#/agenda',
      });
    }
  }

  // Pacientes nuevos. Después de un vacío de la agenda, quien ya venía aparece como "nuevo" en su primera cita
  // registrada: si la comparación empieza menos de 60 días después de un incidente de agenda, no se compara.
  const tocaVacio = (d: string, h: string) =>
    incidentes().some((i) => (i.area === 'agenda' || i.area === 'general') && d <= sumarDias(i.hasta, 60) && h >= i.desde);
  const sesgada = tocaVacio(r.desde, r.hasta) || (!!comp.desde && !!comp.hasta && tocaVacio(comp.desde, comp.hasta));
  if (comparable && !sesgada && nuevos.prev >= 20) {
    const c = (nuevos.cur - nuevos.prev) / nuevos.prev;
    if (Math.abs(c) >= 0.15) {
      frases.push({
        clave: 'nuevos',
        texto: `Llegaron **${num(nuevos.cur)} pacientes nuevos**, un ${pct(Math.abs(c), 0)} ${c > 0 ? 'más' : 'menos'} que en ${textoComp}.`,
        tono: c > 0 ? 'positivo' : 'negativo',
        enlace: '#/pacientes',
      });
    }
  }

  // Especialidad con menor ocupación frente a la de mayor (con al menos 50 cupos cada una).
  const esp = especialidades.filter((e) => e.cupos >= 50).map((e) => ({ ...e, tasa: e.ocupan / e.cupos })).sort((x, y) => x.tasa - y.tasa);
  if (esp.length >= 2 && esp[esp.length - 1].tasa - esp[0].tasa >= 0.1) {
    const [baja, alta] = [esp[0], esp[esp.length - 1]];
    frases.push({
      clave: 'ocupacion_especialidad',
      texto: `La agenda de **${baja.especialidad}** está al ${pct(baja.tasa, 0)} de ocupación, frente al ${pct(alta.tasa, 0)} de **${alta.especialidad}**.`,
      tono: 'neutro',
      enlace: '#/profesionales',
    });
  }

  // Lista de espera.
  if (lista.asignados > 0) {
    frases.push({
      clave: 'lista_espera',
      texto: `La lista de espera recolocó **${num(lista.asignados)} ${lista.asignados === 1 ? 'cupo' : 'cupos'}**: ${String(lista.horas).replace('.', ',')} horas de consulta que habrían quedado vacías.`,
      tono: 'positivo',
      enlace: '#/lista-espera',
    });
  }

  return frases.slice(0, 6);
}

// ---------------------------------------------------------------------------- qué requiere atención
async function atencion(r: Rango, conAnomalias: boolean) {
  const [alertas, datos, proximas] = await Promise.all([
    alertasConEstado(),
    datosResumen(r),
    queryOne<{ sin_celular: number; manana: number; manana_pendientes: number }>(
      `WITH ${CITAS}
       SELECT count(DISTINCT coalesce(paciente_id, documento_paciente)) FILTER (
                WHERE fecha_cita BETWEEN ${HOY} AND ${HOY} + 7 AND (telefono_norm IS NULL OR telefono_norm !~ '^573')) AS sin_celular,
              count(*) FILTER (WHERE fecha_cita = ${HOY} + 1) AS manana,
              count(*) FILTER (WHERE fecha_cita = ${HOY} + 1 AND estado_agenda = 'Pendiente') AS manana_pendientes
         FROM citas WHERE es_cita_paciente AND grupo = 'Programada'`,
    ),
  ]);
  const items: ItemAtencion[] = [];
  for (const a of alertas.filter((x) => !x.revisada)) {
    items.push({ clave: `alerta:${a.clave}`, severidad: a.severidad, texto: a.titulo, enlace: a.enlace });
  }
  const sinCierre = (datos.actual as unknown as { citas: N }).citas.sin_cierre;
  if (sinCierre > 0) {
    items.push({
      clave: 'sin_cierre',
      severidad: sinCierre >= 20 ? 'media' : 'info',
      texto: `${num(sinCierre)} ${sinCierre === 1 ? 'cita pasada sigue' : 'citas pasadas siguen'} sin cierre en Globho: no se sabe si ocurrieron.`,
      enlace: '#/agenda?t=calidad',
    });
  }
  if (proximas.sin_celular > 0) {
    items.push({
      clave: 'sin_celular',
      severidad: 'media',
      texto: `${num(proximas.sin_celular)} ${proximas.sin_celular === 1 ? 'paciente con cita esta semana no tiene' : 'pacientes con cita esta semana no tienen'} un celular válido: no recibirán recordatorios.`,
      enlace: '#/campanas',
    });
  }
  if (proximas.manana_pendientes > 0) {
    items.push({
      clave: 'manana',
      severidad: 'info',
      texto: `Mañana hay ${num(proximas.manana)} citas; ${num(proximas.manana_pendientes)} siguen sin confirmar.`,
      enlace: '#/agenda?t=proximas',
    });
  }
  // Anomalías (Etapa 6, plan Full): días de la última semana fuera de lo normal que empeoran algo.
  if (conAnomalias) {
    const desde = sumarDias(hoyBogota(), -7);
    for (const a of (await anomalias().catch(() => [])).filter((x) => x.fecha >= desde && x.tono === 'negativo').slice(0, 3)) {
      items.push({ clave: `anomalia:${a.clave}`, severidad: 'media', texto: `Fuera de lo normal: ${a.texto.replace(/\*\*/g, '')}`, enlace: enlaceAnomalia(a) });
    }
  }
  const orden = { alta: 0, media: 1, info: 2 };
  return items.sort((x, y) => orden[x.severidad] - orden[y.severidad]);
}

// ---------------------------------------------------------------------------- confianza de los datos
interface Componente {
  clave: string;
  titulo: string;
  valor: number;
  peso: number;
  detalle: string;
  enlace: string;
}

function escalon(horas: number | null, tramos: [number, number][]): number {
  if (horas === null) return 0;
  for (const [limite, valor] of tramos) if (horas <= limite) return valor;
  return 0.1;
}

async function confianza(r: Rango) {
  const [ahora, frescura, citas, traz, alertas] = await Promise.all([
    queryOne<{ habil: boolean }>(
      `SELECT extract(isodow FROM now() AT TIME ZONE 'America/Bogota') BETWEEN 1 AND 6
              AND (now() AT TIME ZONE 'America/Bogota')::time BETWEEN '07:00' AND '21:00' AS habil`,
    ),
    queryOne<{ agenda_h: number | null; bot_h: number | null }>(
      `SELECT round((extract(epoch FROM ((now() AT TIME ZONE 'America/Bogota')
                     - (SELECT max(greatest(created_at_bogota, updated_at_bogota)) FROM bi.fact_citas))) / 3600.0)::numeric, 1) AS agenda_h,
              round((extract(epoch FROM ((now() AT TIME ZONE 'UTC') - (SELECT max(fecha_hora) FROM chat_stats))) / 3600.0)::numeric, 1) AS bot_h`,
    ),
    queryOne<{ total: number; con_celular: number; con_profesional: number }>(
      `WITH ${CITAS}
       SELECT count(*) AS total,
              count(*) FILTER (WHERE telefono_norm ~ '^573') AS con_celular,
              count(*) FILTER (WHERE profesional_id IS NOT NULL) AS con_profesional
         FROM citas WHERE es_cita_paciente AND fecha_cita BETWEEN $1 AND $2`,
      [r.desde, r.hasta],
    ),
    // Días con campañas que enviaron mensajes y que además quedaron en el registro detallado de envíos
    // (existe desde el 30-sep-2026).
    r.hasta >= '2026-09-30'
      ? queryOne<{ dias: number; con_registro: number }>(
          `WITH ${ejecuciones('$1')},
           d AS (SELECT DISTINCT fecha FROM ejec WHERE fecha BETWEEN greatest($1::date, DATE '2026-09-30') AND $2 AND exitosos > 0)
           SELECT count(*) AS dias,
                  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM bi.fact_envios e WHERE e.fecha_bogota = d.fecha AND e.tipo_envio = 'plantilla')) AS con_registro
             FROM d`,
          [r.desde, r.hasta],
        )
      : Promise.resolve({ dias: 0, con_registro: 0 }),
    alertasConEstado(),
  ]);

  const habil = ahora.habil;
  const comps: Componente[] = [];
  const agendaH = frescura.agenda_h === null ? null : Number(frescura.agenda_h);
  comps.push({
    clave: 'agenda',
    titulo: 'Agenda actualizada desde Globho',
    valor: escalon(agendaH, habil ? [[2, 1], [4, 0.8], [8, 0.5], [24, 0.2]] : [[16, 1], [40, 0.6], [72, 0.3]]),
    peso: 20,
    detalle: agendaH === null ? 'Sin datos de actualización' : `Última actualización hace ${agendaH < 1 ? 'menos de 1 hora' : `${String(agendaH).replace('.', ',')} horas`}`,
    enlace: '#/alertas',
  });
  const botH = frescura.bot_h === null ? null : Number(frescura.bot_h);
  comps.push({
    clave: 'bot',
    titulo: 'Actividad registrada del bot',
    valor: escalon(botH, habil ? [[2, 1], [6, 0.6], [24, 0.3]] : [[16, 1], [40, 0.5]]),
    peso: 10,
    detalle: botH === null ? 'Sin eventos registrados' : `Último evento hace ${botH < 1 ? 'menos de 1 hora' : `${String(botH).replace('.', ',')} horas`}`,
    enlace: '#/chatbot',
  });
  const campanas = alertas.filter((a) => ['campana_no_corrio', 'campana_sin_envios', 'fallo_envio_alto'].includes(a.alerta));
  comps.push({
    clave: 'campanas',
    titulo: 'Campañas de hoy',
    valor: Math.max(0, 1 - 0.34 * campanas.length),
    peso: 15,
    detalle: campanas.length ? `${campanas.length} ${campanas.length === 1 ? 'problema' : 'problemas'}: ${campanas.map((c) => c.titulo).join('; ')}` : 'Todas las campañas programadas corrieron y enviaron',
    enlace: '#/campanas?t=ejecuciones',
  });
  if (citas.total > 0) {
    comps.push({
      clave: 'telefonos',
      titulo: 'Citas con celular válido',
      valor: citas.con_celular / citas.total,
      peso: 15,
      detalle: `${num(citas.con_celular)} de ${num(citas.total)} citas del período`,
      enlace: '#/campanas',
    });
    comps.push({
      clave: 'profesional',
      titulo: 'Citas con profesional identificado',
      valor: citas.con_profesional / citas.total,
      peso: 10,
      detalle: `${num(citas.con_profesional)} de ${num(citas.total)} citas enlazadas a la ficha del profesional`,
      enlace: '#/agenda?t=calidad',
    });
  }
  const enInc = fraccionEnIncidente(r.desde, r.hasta);
  comps.push({
    clave: 'incidentes',
    titulo: 'Días sin incidentes de datos',
    valor: 1 - enInc,
    peso: 20,
    detalle: enInc > 0 ? `El ${pct(enInc, 0)} del período cae en un incidente conocido` : 'El período no toca ningún incidente conocido',
    enlace: '#/alertas',
  });
  if (traz.dias > 0) {
    comps.push({
      clave: 'trazabilidad',
      titulo: 'Envíos con registro detallado',
      valor: traz.con_registro / traz.dias,
      peso: 10,
      detalle: `${traz.con_registro} de ${traz.dias} días con campañas tienen el detalle de cada envío`,
      enlace: '#/campanas',
    });
  }
  const pesoTotal = comps.reduce((s, c) => s + c.peso, 0);
  const indice = pesoTotal ? comps.reduce((s, c) => s + c.valor * c.peso, 0) / pesoTotal : 0;
  return { indice, nivel: indice >= 0.85 ? 'alta' : indice >= 0.7 ? 'media' : 'baja', componentes: comps };
}

// ------------------------------------------------------------------------------------------- rutas
export default async function rutasSala(app: FastifyInstance) {
  app.get('/api/resumen/sala', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    return conCache(claveCache(req), async () => {
      // Todo en paralelo: la base pesada se lanza una vez y cada bloque la espera cuando la necesita.
      const baseP = base(r, periodoComparacion(r));
      // Evita un rechazo "no manejado" (que tumbaría el proceso) si falla antes de que un bloque la espere.
      baseP.catch(() => {});
      // Depende solo del nivel (que va en la clave de la caché), no del rol.
      const conHoras = rangoNivel(req.contexto?.nivel ?? 'full') >= rangoNivel('full');
      const [tendencia, frases, items] = await Promise.all([semanas(r.hasta, baseP), relevante(r, baseP, conHoras), atencion(r, conHoras)]);
      return { tendencia, relevante: frases, atencion: items };
    }, 300_000);
  });

  app.get('/api/confianza', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    return conCache(claveCache(req), () => confianza(r), 120_000);
  });

  app.get('/api/metas', async (req) => ({ metas: await leerMetas(), editable: puede(req, 'metas.editar') }));

  app.put(
    '/api/metas',
    {
      schema: {
        body: {
          type: 'object',
          required: ['indicador', 'valor'],
          additionalProperties: false,
          properties: {
            indicador: { type: 'string', enum: Object.keys(INDICADORES) },
            valor: { type: ['number', 'null'], minimum: 0 },
          },
        },
      },
    },
    async (req) => {
      const b = req.body as { indicador: string; valor: number | null };
      const def = INDICADORES[b.indicador];
      if (b.valor !== null && def.tipo === 'tasa' && b.valor > 1) throw new ErrorParametro('Las tasas van de 0 a 100 %');
      if (b.valor === null) {
        await queryApp(`DELETE FROM panel.metas WHERE indicador = $1`, [b.indicador]);
      } else {
        await queryApp(
          `INSERT INTO panel.metas (indicador, valor, actualizado_por) VALUES ($1, $2, $3)
           ON CONFLICT (indicador) DO UPDATE SET valor = EXCLUDED.valor, actualizado_por = EXCLUDED.actualizado_por, actualizado_at = now()`,
          [b.indicador, b.valor, req.contexto!.usuario],
        );
      }
      registrarActividad(req.contexto, {
        tipo: 'configuracion',
        ruta: 'meta',
        detalle: `${def.titulo}: ${b.valor === null ? 'valor de referencia' : def.tipo === 'tasa' ? pct(b.valor, 0) : `${num(b.valor)} por mes`}`,
        status: 200,
        ms: null,
      });
      return { metas: await leerMetas() };
    },
  );
}
