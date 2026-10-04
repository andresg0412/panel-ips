import type { FastifyInstance } from 'fastify';
import { query, queryOne } from '../db.js';
import { conCache } from '../cache.js';
import { leerRango } from '../params.js';
import { GRUPO_ESTADO, PERIODOS, periodo } from '../sql.js';

async function indicadores(desde: string, hasta: string) {
  const p = [desde, hasta];
  const [citas, nuevas, envios, sesiones, listaEspera] = await Promise.all([
    queryOne(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE estado_agenda = 'Asistio') AS asistio,
              count(*) FILTER (WHERE estado_agenda = 'No Asistio') AS no_asistio,
              count(*) FILTER (WHERE estado_agenda IN ('Cancelado', 'Anulado')) AS canceladas,
              count(*) FILTER (WHERE estado_agenda = 'Reprogramar') AS reprogramadas,
              count(*) FILTER (WHERE estado_agenda IN ('Pendiente', 'Confirmado')) AS programadas
         FROM bi.fact_citas
        WHERE fecha_cita BETWEEN $1 AND $2`,
      p,
    ),
    queryOne(
      `SELECT count(*) AS registradas
         FROM bi.fact_citas
        WHERE created_at_bogota >= $1::date AND created_at_bogota < $2::date + 1`,
      p,
    ),
    queryOne(
      `SELECT count(*) FILTER (WHERE estado NOT IN ('rechazado_api', 'failed')) AS enviados,
              count(*) FILTER (WHERE estado IN ('rechazado_api', 'failed')) AS fallidos,
              count(*) FILTER (WHERE entregado) AS entregados,
              count(*) FILTER (WHERE leido) AS leidos,
              count(*) FILTER (WHERE estado_respuesta IN ('respondio', 'respondio_tarde')) AS respondieron,
              count(*) FILTER (WHERE cita_confirmada_despues) AS confirmaron
         FROM bi.fact_envios
        WHERE fecha_bogota BETWEEN $1 AND $2 AND tipo_envio = 'plantilla'`,
      p,
    ),
    queryOne(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE estado_calc = 'abandonada') AS abandonadas,
              count(DISTINCT telefono_norm) AS personas,
              count(*) FILTER (WHERE resultado_negocio = 'cita_creada') AS citas_creadas,
              count(*) FILTER (WHERE resultado_negocio = 'cita_cancelada') AS citas_canceladas,
              count(*) FILTER (WHERE resultado_negocio = 'cita_reprogramada') AS citas_reprogramadas,
              count(*) FILTER (WHERE resultado_negocio = 'cita_confirmada') AS citas_confirmadas,
              count(*) FILTER (WHERE resultado_negocio = 'derivado_agente') AS derivadas_agente
         FROM bi.fact_sesiones
        WHERE fecha_bogota BETWEEN $1 AND $2`,
      p,
    ),
    queryOne(
      `SELECT count(DISTINCT lista_espera_id) FILTER (
                WHERE inscripcion_created_at_bogota >= $1::date AND inscripcion_created_at_bogota < $2::date + 1) AS inscripciones,
              count(DISTINCT oferta_id) FILTER (
                WHERE enviada_at_bogota >= $1::date AND enviada_at_bogota < $2::date + 1) AS ofertas,
              count(DISTINCT oferta_id) FILTER (
                WHERE estado_oferta = 'aceptada' AND respondida_at_bogota >= $1::date AND respondida_at_bogota < $2::date + 1) AS aceptadas
         FROM bi.fact_lista_espera`,
      p,
    ),
  ]);
  return { citas: { ...citas, ...nuevas }, envios, sesiones, listaEspera };
}

export default async function rutasResumen(app: FastifyInstance) {
  app.get('/api/resumen', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    return conCache(req.url, async () => {
      const [actual, anterior] = await Promise.all([indicadores(r.desde, r.hasta), indicadores(r.prevDesde, r.prevHasta)]);
      return { rango: r, actual, anterior };
    });
  });

  app.get('/api/resumen/series', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    const p = [r.desde, r.hasta, r.grano];
    return conCache(req.url, async () => {
      const [citas, envios, sesiones] = await Promise.all([
        query(
          `WITH p AS (${PERIODOS})
           SELECT p.periodo, c.grupo, coalesce(c.n, 0) AS n
             FROM p
             LEFT JOIN (
               SELECT ${periodo('fecha_cita')} AS periodo, ${GRUPO_ESTADO} AS grupo, count(*) AS n
                 FROM bi.fact_citas
                WHERE fecha_cita BETWEEN $1 AND $2
                GROUP BY 1, 2
             ) c USING (periodo)
            ORDER BY 1`,
          p,
        ),
        query(
          `WITH p AS (${PERIODOS})
           SELECT p.periodo,
                  count(e.*) FILTER (WHERE e.estado NOT IN ('rechazado_api', 'failed')) AS enviados,
                  count(e.*) FILTER (WHERE e.estado_respuesta IN ('respondio', 'respondio_tarde')) AS respondieron
             FROM p
             LEFT JOIN bi.fact_envios e
               ON ${periodo('e.fecha_bogota')} = p.periodo
              AND e.fecha_bogota BETWEEN $1 AND $2 AND e.tipo_envio = 'plantilla'
            GROUP BY 1 ORDER BY 1`,
          p,
        ),
        query(
          `WITH p AS (${PERIODOS})
           SELECT p.periodo,
                  count(s.*) FILTER (WHERE s.estado_calc = 'completada') AS completadas,
                  count(s.*) FILTER (WHERE s.estado_calc = 'abandonada') AS abandonadas
             FROM p
             LEFT JOIN bi.fact_sesiones s
               ON ${periodo('s.fecha_bogota')} = p.periodo AND s.fecha_bogota BETWEEN $1 AND $2
            GROUP BY 1 ORDER BY 1`,
          p,
        ),
      ]);
      return { rango: r, citas, envios, sesiones };
    });
  });
}
