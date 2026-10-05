import type { FastifyInstance } from 'fastify';
import { query, queryOne } from '../db.js';
import { conCache } from '../cache.js';
import { claveCache } from '../acceso.js';
import { ErrorParametro, leerRango, leerTexto } from '../params.js';
import { PERIODOS, periodo } from '../sql.js';
import { FUERA_HORARIO } from './resumen.js';

const FLUJOS_EMBUDO = new Set(['agendar', 'cancelar', 'reprogramar', 'campana_respuesta', 'lista_espera']);

export default async function rutasChatbot(app: FastifyInstance) {
  app.get('/api/chatbot', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    const p = [r.desde, r.hasta];
    return conCache(claveCache(req), async () => {
      const [kpis, serie, resultado, primerFlujo, motivoFin, mapaCalor, conversion] = await Promise.all([
        queryOne(
          `SELECT count(*) AS sesiones,
                  count(DISTINCT telefono_norm) AS personas,
                  count(*) FILTER (WHERE estado_calc = 'abandonada') AS abandonadas,
                  -- Las sesiones reconstruidas del histórico (backfill) no tienen duración ni mensajes.
                  round((percentile_cont(0.5) WITHIN GROUP (ORDER BY duracion_min) FILTER (WHERE NOT es_backfill))::numeric, 1) AS mediana_min,
                  round((avg(mensajes_entrantes) FILTER (WHERE NOT es_backfill))::numeric, 1) AS mensajes_promedio,
                  -- CHB-04: fuera del horario de recepción (antes de las 7, desde las 19, domingos).
                  count(*) FILTER (WHERE ${FUERA_HORARIO}) AS fuera_horario,
                  count(*) FILTER (WHERE resultado_negocio = 'fuera_horario') AS derivadas_fuera_horario
             FROM bi.fact_sesiones WHERE fecha_bogota BETWEEN $1 AND $2`,
          p,
        ),
        query(
          `WITH p AS (${PERIODOS})
           SELECT p.periodo,
                  count(s.*) FILTER (WHERE s.estado_calc = 'completada') AS completadas,
                  count(s.*) FILTER (WHERE s.estado_calc = 'abandonada') AS abandonadas
             FROM p
             LEFT JOIN bi.fact_sesiones s ON ${periodo('s.fecha_bogota')} = p.periodo AND s.fecha_bogota BETWEEN $1 AND $2
            GROUP BY 1 ORDER BY 1`,
          [...p, r.grano],
        ),
        query(
          `SELECT coalesce(resultado_negocio, 'sin_gestion') AS clave, count(*) AS n
             FROM bi.fact_sesiones WHERE fecha_bogota BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 2 DESC`,
          p,
        ),
        query(
          `SELECT coalesce(primer_flujo, 'sin_dato') AS clave, count(*) AS n
             FROM bi.fact_sesiones WHERE fecha_bogota BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 2 DESC`,
          p,
        ),
        query(
          `SELECT coalesce(motivo_fin, 'sin_dato') AS clave, count(*) AS n
             FROM bi.fact_sesiones WHERE fecha_bogota BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 2 DESC`,
          p,
        ),
        query(
          `SELECT extract(isodow FROM inicio_at_bogota)::int AS dia, extract(hour FROM inicio_at_bogota)::int AS hora, count(*) AS n
             FROM bi.fact_sesiones WHERE fecha_bogota BETWEEN $1 AND $2 AND inicio_at_bogota IS NOT NULL
            GROUP BY 1, 2`,
          p,
        ),
        // CHB-01: de las conversaciones que entraron a un trámite (en cualquier momento, no solo como primer
        // paso), cuántas terminaron con el resultado de ese trámite.
        query(
          `WITH ent AS (
             SELECT DISTINCT sesion_id, flujo
               FROM bi.fact_eventos
              WHERE fecha_bogota BETWEEN $1 AND $2 AND sesion_id IS NOT NULL
                AND flujo IN ('agendar', 'cancelar', 'reprogramar')
           )
           SELECT ent.flujo AS clave,
                  count(*) AS entraron,
                  count(*) FILTER (WHERE s.resultado_negocio = CASE ent.flujo WHEN 'agendar' THEN 'cita_creada'
                                                                              WHEN 'cancelar' THEN 'cita_cancelada'
                                                                              ELSE 'cita_reprogramada' END) AS lograron,
                  count(*) FILTER (WHERE s.resultado_negocio IN ('derivado_agente', 'fuera_horario')) AS derivadas
             FROM ent LEFT JOIN bi.fact_sesiones s USING (sesion_id)
            GROUP BY 1 ORDER BY 2 DESC`,
          p,
        ),
      ]);
      return { rango: r, kpis, serie, resultado, primerFlujo, motivoFin, mapaCalor, conversion };
    });
  });

  app.get('/api/chatbot/embudo', async (req) => {
    const q = req.query as Record<string, unknown>;
    const r = leerRango(q);
    const flujo = leerTexto(q, 'flujo', 40) ?? 'agendar';
    if (!FLUJOS_EMBUDO.has(flujo)) throw new ErrorParametro('Flujo inválido');
    return conCache(claveCache(req), async () => {
      const [pasos, desde] = await Promise.all([
        query(
          `SELECT e.paso, min(e.orden) AS orden, bool_or(e.es_final) AS es_final,
                  max(d.descripcion) AS descripcion,
                  sum(e.sesiones_llegaron) AS llegaron,
                  sum(e.sesiones_terminaron_ahi) AS terminaron,
                  sum(e.sesiones_abandonaron_ahi) AS abandonaron
             FROM bi.v_embudo_flujo e
             LEFT JOIN bi.dim_paso d ON d.paso = e.paso AND d.flujo = e.flujo
            WHERE e.flujo = $3 AND e.fecha_bogota BETWEEN $1 AND $2
            GROUP BY e.paso
            ORDER BY min(e.orden) NULLS LAST, sum(e.sesiones_llegaron) DESC`,
          [r.desde, r.hasta, flujo],
        ),
        queryOne(`SELECT min(fecha_bogota) AS fecha FROM bi.v_embudo_flujo WHERE flujo = $1 AND NOT es_backfill`, [flujo]),
      ]);
      return { flujo, pasos, datosDesde: desde?.fecha ?? null };
    });
  });
}
