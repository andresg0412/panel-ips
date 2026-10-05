// Etapa 3: historias de valor del chatbot y de las campañas. Embudo de las conversaciones, horas de recepción
// ahorradas, "oportunidades de mejora" (frases por reglas) y fatiga de mensajes (CAM-09).
// Plan: proyecto-ips/docs/features/2026-10-04-panel-valor-niveles-soporte-plan.md, Etapa 3.
import type { FastifyInstance } from 'fastify';
import { query, queryApp, queryOne } from '../db.js';
import { conCache } from '../cache.js';
import { claveCache, puede, registrarActividad } from '../acceso.js';
import { ErrorParametro, leerRango, sumarDias, type Rango } from '../params.js';
import { incidentes } from '../incidentes.js';
import { FUERA_HORARIO, datosResumen } from './resumen.js';
import { PARAMETROS, horasDe, leerParametros, minutosAhorrados } from '../parametros.js';
import { nombrePaso } from '../pasos.js';
import type { Frase } from './sala.js';

/** Flujos que indican que el bot identificó qué quería la persona. */
const TRAMITES = ['agendar', 'cancelar', 'reprogramar', 'campana_respuesta', 'recordatorio', 'lista_espera', 'agente', 'pqrs', 'conocer_ips'];

/**
 * Gestión completada por el bot: una cita creada, cancelada, movida o confirmada. Las respuestas a campañas
 * anteriores a la trazabilidad v2 (1-oct-2026) no tienen resultado: cuentan si la conversación terminó completa.
 */
export const COMPLETADA = `(resultado_negocio IN ('cita_creada', 'cita_cancelada', 'cita_reprogramada', 'cita_confirmada')
  OR (primer_flujo = 'campana_respuesta' AND estado_calc = 'completada' AND resultado_negocio IS NULL))`;

const pct = (v: number, dec = 0) => `${(v * 100).toFixed(dec).replace('.', ',')} %`;
const nf = new Intl.NumberFormat('es-CO');
const num = (v: number) => nf.format(Math.round(v));

/** Fracción de días del rango en un incidente que afecta a las conversaciones del bot. */
function fraccionIncidenteBot(r: Rango): number {
  const inc = incidentes().filter((i) => ['general', 'conversaciones', 'eventos'].includes(i.area));
  let total = 0;
  let malos = 0;
  for (let d = r.desde; d <= r.hasta; d = sumarDias(d, 1)) {
    total++;
    if (inc.some((i) => d >= i.desde && d <= i.hasta)) malos++;
  }
  return total ? malos / total : 0;
}

// ------------------------------------------------------------------------------------- consultas
function embudoConversaciones(r: Rango) {
  return queryOne<Record<string, number>>(
    `WITH s AS (SELECT * FROM bi.fact_sesiones WHERE fecha_bogota BETWEEN $1 AND $2),
     f AS (SELECT DISTINCT sesion_id FROM bi.fact_eventos
            WHERE fecha_bogota BETWEEN $1 AND $2::date + 1 AND sesion_id IS NOT NULL AND flujo = ANY($3))
     SELECT count(*) AS conversaciones,
            count(*) FILTER (WHERE resultado_negocio IS NOT NULL OR primer_flujo = ANY($3) OR ultimo_flujo = ANY($3)
                               OR sesion_id IN (SELECT sesion_id FROM f)) AS con_tramite,
            count(*) FILTER (WHERE ${COMPLETADA}) AS completadas,
            count(*) FILTER (WHERE resultado_negocio IN ('derivado_agente', 'fuera_horario')) AS derivadas,
            count(*) FILTER (WHERE resultado_negocio = 'fuera_horario') AS derivadas_fuera_horario,
            count(*) FILTER (WHERE estado_calc = 'abandonada') AS abandonadas,
            count(*) FILTER (WHERE estado_calc = 'abandonada' AND ultimo_paso IN ('inicio.bienvenida', 'politicas.pregunta')) AS abandonadas_inicio,
            count(*) FILTER (WHERE estado_calc = 'abandonada' AND ultimo_paso = 'politicas.pregunta') AS abandonadas_politica,
            count(*) FILTER (WHERE ${FUERA_HORARIO}) AS fuera_horario,
            count(*) FILTER (WHERE ${FUERA_HORARIO} AND ${COMPLETADA}) AS completadas_fuera_horario,
            count(*) FILTER (WHERE resultado_negocio = 'cita_creada') AS agendadas,
            count(*) FILTER (WHERE resultado_negocio = 'cita_cancelada') AS canceladas,
            count(*) FILTER (WHERE resultado_negocio = 'cita_reprogramada') AS reprogramadas,
            count(*) FILTER (WHERE ${COMPLETADA} AND resultado_negocio IS DISTINCT FROM 'cita_creada'
                               AND resultado_negocio IS DISTINCT FROM 'cita_cancelada'
                               AND resultado_negocio IS DISTINCT FROM 'cita_reprogramada') AS confirmaciones,
            min(fecha_bogota) FILTER (WHERE NOT es_backfill) AS detalle_desde
       FROM s`,
    [r.desde, r.hasta, TRAMITES],
  );
}

const SECCION_FLUJO: Record<string, { gente: string; logro: string }> = {
  agendar: { gente: 'quienes intentaron agendar', logro: 'cita_creada' },
  cancelar: { gente: 'quienes intentaron cancelar una cita', logro: 'cita_cancelada' },
  reprogramar: { gente: 'quienes intentaron reprogramar', logro: 'cita_reprogramada' },
};

async function oportunidades(r: Rango): Promise<{ frases: Frase[]; omitidas: string | null }> {
  if (fraccionIncidenteBot(r) > 0.5) {
    return { frases: [], omitidas: 'La mayor parte del período cae en un incidente de registro de las conversaciones.' };
  }
  const [conv, abandonos, embudo, noEnt, noEntPaso, demanda] = await Promise.all([
    // CHB-01: entraron a cada trámite y cuántas lo lograron.
    query<{ flujo: string; entraron: number; lograron: number }>(
      `WITH ent AS (
         SELECT DISTINCT sesion_id, flujo FROM bi.fact_eventos
          WHERE fecha_bogota BETWEEN $1 AND $2 AND sesion_id IS NOT NULL AND flujo IN ('agendar', 'cancelar', 'reprogramar')
       )
       SELECT ent.flujo,
              count(*) AS entraron,
              count(*) FILTER (WHERE s.resultado_negocio = CASE ent.flujo WHEN 'agendar' THEN 'cita_creada'
                                                                          WHEN 'cancelar' THEN 'cita_cancelada'
                                                                          ELSE 'cita_reprogramada' END) AS lograron
         FROM ent LEFT JOIN bi.fact_sesiones s USING (sesion_id)
        GROUP BY 1`,
      [r.desde, r.hasta],
    ),
    // Paso donde más conversaciones de cada trámite se quedaron.
    query<{ flujo: string; paso: string; n: number }>(
      `SELECT flujo, paso, sum(sesiones_abandonaron_ahi) AS n
         FROM bi.v_embudo_flujo
        WHERE fecha_bogota BETWEEN $1 AND $2 AND flujo IN ('agendar', 'cancelar', 'reprogramar') AND paso NOT LIKE 'comun.salida'
        GROUP BY 1, 2 HAVING sum(sesiones_abandonaron_ahi) > 0
        ORDER BY 3 DESC`,
      [r.desde, r.hasta],
    ),
    embudoConversaciones(r),
    queryOne<{ no_entendidos: number; entrantes: number }>(
      `SELECT count(*) FILTER (WHERE tipo_evento = 'msg_no_entendido') AS no_entendidos,
              count(*) FILTER (WHERE tipo_evento = 'msg_entrante') AS entrantes
         FROM bi.fact_eventos WHERE fecha_bogota BETWEEN $1 AND $2 AND NOT es_backfill`,
      [r.desde, r.hasta],
    ),
    queryOne<{ paso: string | null; n: number }>(
      `SELECT paso, count(*) AS n FROM bi.fact_eventos
        WHERE fecha_bogota BETWEEN $1 AND $2 AND tipo_evento = 'msg_no_entendido' AND paso IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC LIMIT 1`,
      [r.desde, r.hasta],
    ),
    // CHB-02: vieron fechas u horas y no agendaron, por especialidad.
    query<{ especialidad: string; vieron: number; agendaron: number }>(
      `WITH vio AS (
         SELECT sesion_id, max(meta_especialidad) AS especialidad
           FROM bi.fact_eventos
          WHERE fecha_bogota BETWEEN $1 AND $2 AND sesion_id IS NOT NULL
            AND (paso LIKE 'agendar.s08%' OR paso LIKE 'agendar.s09%' OR paso LIKE 'agendar.s10%')
          GROUP BY 1
       )
       SELECT coalesce(nullif(vio.especialidad, ''), 'Sin dato') AS especialidad,
              count(*) AS vieron, count(*) FILTER (WHERE s.resultado_negocio = 'cita_creada') AS agendaron
         FROM vio LEFT JOIN bi.fact_sesiones s USING (sesion_id)
        GROUP BY 1 ORDER BY 2 DESC`,
      [r.desde, r.hasta],
    ),
  ]);

  // Cada candidata lleva cuántas personas afecta, para ordenar por impacto.
  const candidatas: (Frase & { impacto: number })[] = [];

  for (const c of conv) {
    const s = SECCION_FLUJO[c.flujo];
    const noTerminaron = c.entraron - c.lograron;
    if (!s || c.entraron < 20 || noTerminaron / c.entraron < 0.15) continue;
    const top = abandonos.find((a) => a.flujo === c.flujo);
    const donde = top && top.n >= 5 ? `; el principal abandono es en **${nombrePaso(top.paso)}** (${num(top.n)} conversaciones)` : '';
    candidatas.push({
      clave: `abandono_${c.flujo}`,
      texto: `El **${pct(noTerminaron / c.entraron)}** de ${s.gente} no terminó (${num(noTerminaron)} de ${num(c.entraron)} conversaciones)${donde}.`,
      tono: 'negativo',
      enlace: `#/chatbot?t=recorrido&f=${c.flujo}`,
      impacto: noTerminaron,
    });
  }

  // Antes de llegar al menú: saludo y política de datos.
  if (embudo.conversaciones >= 50 && embudo.abandonadas_inicio / embudo.conversaciones >= 0.1) {
    const politica = embudo.abandonadas_politica >= embudo.abandonadas_inicio / 2;
    candidatas.push({
      clave: 'abandono_inicio',
      texto: `El **${pct(embudo.abandonadas_inicio / embudo.conversaciones)}** de las conversaciones se abandona antes de llegar al menú (${num(embudo.abandonadas_inicio)} personas); la mayoría se queda en **${politica ? 'la aceptación de la política de datos' : 'el saludo de bienvenida'}**.`,
      tono: 'negativo',
      enlace: '#/chatbot?t=conversaciones',
      impacto: embudo.abandonadas_inicio,
    });
  }

  // CHB-03: mensajes que el bot no entendió (trazabilidad v2).
  if (noEnt.entrantes >= 100 && noEnt.no_entendidos / noEnt.entrantes >= 0.03) {
    candidatas.push({
      clave: 'no_entendidos',
      texto: `El bot no entendió el **${pct(noEnt.no_entendidos / noEnt.entrantes, 1)}** de los mensajes recibidos (${num(noEnt.no_entendidos)})${
        noEntPaso?.paso ? `; ocurre sobre todo en **${nombrePaso(noEntPaso.paso)}**` : ''
      }.`,
      tono: 'negativo',
      enlace: '#/chatbot?t=recorrido',
      impacto: noEnt.no_entendidos,
    });
  }

  // Asesor pedido fuera de horario.
  if (embudo.derivadas_fuera_horario >= 5) {
    candidatas.push({
      clave: 'asesor_fuera_horario',
      texto: `**${num(embudo.derivadas_fuera_horario)} personas** pidieron hablar con un asesor fuera de horario y no pudieron ser atendidas en el momento.`,
      tono: 'neutro',
      enlace: '#/chatbot?t=conversaciones',
      impacto: embudo.derivadas_fuera_horario,
    });
  }

  // CHB-02: demanda que no se convirtió en cita.
  const vieron = demanda.reduce((s, x) => s + x.vieron, 0);
  const sinCita = vieron - demanda.reduce((s, x) => s + x.agendaron, 0);
  if (vieron >= 10 && sinCita >= 5) {
    const esp = demanda.filter((x) => x.especialidad !== 'Sin dato').sort((a, b) => b.vieron - b.agendaron - (a.vieron - a.agendaron))[0];
    candidatas.push({
      clave: 'demanda',
      texto: `**${num(sinCita)} personas** consultaron fechas u horas disponibles y no agendaron${
        esp && esp.vieron - esp.agendaron >= 3 ? `; la especialidad más buscada sin cita fue **${esp.especialidad}**` : ''
      }. Son candidatas para una llamada de recepción o para la lista de espera.`,
      tono: 'neutro',
      enlace: '#/chatbot?t=recorrido',
      impacto: sinCita,
    });
  }

  const frases = candidatas
    .sort((a, b) => b.impacto - a.impacto)
    .slice(0, 5)
    .map(({ impacto: _i, ...f }) => f);
  return { frases, omitidas: null };
}

// ----------------------------------------------------------------------------------------- rutas
export default async function rutasHistorias(app: FastifyInstance) {
  // Embudo de las conversaciones: llegaron → el bot identificó el trámite → lo completó sin recepción, y aparte las
  // que pasaron a un asesor.
  app.get('/api/chatbot/historia', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    return conCache(claveCache(req), async () => ({ embudo: await embudoConversaciones(r) }));
  });

  // Horas de recepción ahorradas: trámites resueltos por WhatsApp × minutos que tomaría cada uno por teléfono.
  // Los conteos son los mismos del indicador "Trámites por WhatsApp" de la sala de control.
  app.get('/api/chatbot/ahorro', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    const editable = puede(req, 'parametros.editar');
    const [params, datos] = await Promise.all([
      leerParametros(),
      conCache(claveCache(req), async () => {
        // Barras por semana en períodos cortos y por mes en los largos.
        const grano = r.dias <= 120 ? 'week' : 'month';
        const [resumen, serie, duraciones, fuera] = await Promise.all([
          datosResumen(r),
          query<{ periodo: string; agendadas: number; reprogramadas: number; canceladas: number; confirmadas: number }>(
            `WITH p AS (SELECT generate_series(date_trunc($3, $1::date), $2::date, ('1 ' || $3)::interval)::date AS periodo),
             s AS (SELECT date_trunc($3, fecha_bogota)::date AS periodo,
                          count(*) FILTER (WHERE resultado_negocio = 'cita_creada') AS agendadas,
                          count(*) FILTER (WHERE resultado_negocio = 'cita_reprogramada') AS reprogramadas,
                          count(*) FILTER (WHERE resultado_negocio = 'cita_cancelada') AS canceladas
                     FROM bi.fact_sesiones WHERE fecha_bogota BETWEEN $1 AND $2 GROUP BY 1),
             e AS (SELECT date_trunc($3, fecha_bogota)::date AS periodo, count(*) AS confirmadas
                     FROM bi.fact_envios
                    WHERE fecha_bogota BETWEEN $1 AND $2 AND tipo_envio = 'plantilla'
                      AND (respuesta_tipo = 'confirmo' OR cita_confirmada_despues)
                    GROUP BY 1)
             SELECT p.periodo, coalesce(s.agendadas, 0) AS agendadas, coalesce(s.reprogramadas, 0) AS reprogramadas,
                    coalesce(s.canceladas, 0) AS canceladas, coalesce(e.confirmadas, 0) AS confirmadas
               FROM p LEFT JOIN s USING (periodo) LEFT JOIN e USING (periodo) ORDER BY 1`,
            [r.desde, r.hasta, grano],
          ),
          // CHB-06: cuánto tarda una gestión exitosa con el bot (solo sesiones con trazabilidad v2).
          query<{ resultado: string; n: number; mediana_min: number | null }>(
            `SELECT resultado_negocio AS resultado, count(*) AS n,
                    round((percentile_cont(0.5) WITHIN GROUP (ORDER BY duracion_min))::numeric, 1) AS mediana_min
               FROM bi.fact_sesiones
              WHERE fecha_bogota BETWEEN $1 AND $2 AND NOT es_backfill AND duracion_min IS NOT NULL
                AND resultado_negocio IN ('cita_creada', 'cita_cancelada', 'cita_reprogramada', 'cita_confirmada')
              GROUP BY 1`,
            [r.desde, r.hasta],
          ),
          queryOne<{ n: number }>(
            `SELECT count(*) AS n FROM bi.fact_sesiones WHERE fecha_bogota BETWEEN $1 AND $2 AND ${FUERA_HORARIO} AND ${COMPLETADA}`,
            [r.desde, r.hasta],
          ),
        ]);
        const a = resumen.actual as unknown as { envios: Record<string, number>; sesiones: Record<string, number> };
        return {
          grano,
          tramites: {
            agendadas: a.sesiones.citas_creadas,
            reprogramadas: a.sesiones.citas_reprogramadas,
            canceladas: a.sesiones.citas_canceladas,
            confirmadas: a.envios.confirmaron,
          },
          serie,
          duraciones,
          fueraHorario: fuera.n,
        };
      }),
    ]);
    const minutos = minutosAhorrados(datos.tramites, params);
    return {
      ...datos,
      minutos,
      horas: horasDe(minutos),
      serie: datos.serie.map((s) => ({ ...s, horas: horasDe(minutosAhorrados(s, params)) })),
      parametros: params,
      editable,
    };
  });

  app.put(
    '/api/parametros',
    {
      schema: {
        body: {
          type: 'object',
          required: ['clave', 'valor'],
          additionalProperties: false,
          properties: {
            clave: { type: 'string', enum: Object.keys(PARAMETROS) },
            valor: { type: ['number', 'null'], minimum: 0 },
          },
        },
      },
    },
    async (req) => {
      const b = req.body as { clave: string; valor: number | null };
      const def = PARAMETROS[b.clave];
      if (b.valor !== null && (b.valor < def.min || b.valor > def.max)) throw new ErrorParametro(`${def.titulo}: entre ${def.min} y ${def.max} ${def.unidad}`);
      if (b.valor === null) {
        await queryApp(`DELETE FROM panel.parametros WHERE clave = $1`, [b.clave]);
      } else {
        await queryApp(
          `INSERT INTO panel.parametros (clave, valor, actualizado_por) VALUES ($1, $2, $3)
           ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_por = EXCLUDED.actualizado_por, actualizado_at = now()`,
          [b.clave, b.valor, req.contexto!.usuario],
        );
      }
      registrarActividad(req.contexto, {
        tipo: 'configuracion',
        ruta: 'parametro',
        detalle: `${def.titulo}: ${b.valor === null ? 'valor de referencia' : `${b.valor} ${def.unidad}`}`,
        status: 200,
        ms: null,
      });
      return { parametros: await leerParametros() };
    },
  );

  app.get('/api/chatbot/oportunidades', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    return conCache(claveCache(req), () => oportunidades(r), 300_000);
  });

  // CAM-09: cuántos mensajes recibe cada número al mes y si responden menos quienes reciben más.
  // Por número de teléfono: en una familia que comparte celular, los mensajes de todos llegan al mismo número.
  app.get('/api/campanas/fatiga', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    return conCache(claveCache(req), async () => {
      const BASE = `e AS (
          SELECT telefono_norm, to_char(fecha_bogota, 'YYYY-MM') AS mes, campana, estado_respuesta
            FROM bi.fact_envios
           WHERE fecha_bogota BETWEEN $1 AND $2 AND tipo_envio = 'plantilla' AND telefono_norm IS NOT NULL
             AND estado NOT IN ('rechazado_api', 'failed')
        ),
        c AS (SELECT telefono_norm, mes, count(*) AS n FROM e GROUP BY 1, 2),
        g AS (SELECT telefono_norm, mes, CASE WHEN n = 1 THEN '1' WHEN n <= 3 THEN '2-3' WHEN n <= 7 THEN '4-7' ELSE '8+' END AS grupo FROM c)`;
      const [meses, respuesta, campanas] = await Promise.all([
        query<{ mes: string; numeros: number; g1: number; g2: number; g4: number; g8: number; maximo: number; promedio: number }>(
          `WITH ${BASE}
           SELECT mes, count(*) AS numeros,
                  count(*) FILTER (WHERE n = 1) AS g1, count(*) FILTER (WHERE n BETWEEN 2 AND 3) AS g2,
                  count(*) FILTER (WHERE n BETWEEN 4 AND 7) AS g4, count(*) FILTER (WHERE n >= 8) AS g8,
                  max(n) AS maximo, round(avg(n)::numeric, 1) AS promedio
             FROM c GROUP BY 1 ORDER BY 1`,
          [r.desde, r.hasta],
        ),
        // Tasa de respuesta según cuántos mensajes recibió ese número en el mes (solo campañas que piden respuesta).
        query<{ grupo: string; piden: number; respondieron: number }>(
          `WITH ${BASE}
           SELECT g.grupo, count(*) AS piden,
                  count(*) FILTER (WHERE e.estado_respuesta IN ('respondio', 'respondio_tarde')) AS respondieron
             FROM e JOIN g USING (telefono_norm, mes)
            WHERE e.campana NOT IN ('daily', 'aviso_asesor')
            GROUP BY 1 ORDER BY 1`,
          [r.desde, r.hasta],
        ),
        // De qué campañas vienen los mensajes de quienes reciben 8 o más al mes.
        query<{ campana: string; mensajes: number }>(
          `WITH ${BASE}
           SELECT e.campana, count(*) AS mensajes FROM e JOIN g USING (telefono_norm, mes)
            WHERE g.grupo = '8+' GROUP BY 1 ORDER BY 2 DESC`,
          [r.desde, r.hasta],
        ),
      ]);
      return { meses, respuesta, campanas };
    }, 300_000);
  });
}
