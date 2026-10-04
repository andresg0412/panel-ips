import type { FastifyInstance } from 'fastify';
import { query, queryOne } from '../db.js';
import { conCache } from '../cache.js';
import { leerRango } from '../params.js';
import { CITAS, MESES, PERIODOS, periodo } from '../sql.js';

// Conversación fuera del horario de recepción: antes de las 7, desde las 19 o en domingo.
export const FUERA_HORARIO = `(extract(hour FROM inicio_at_bogota) < 7 OR extract(hour FROM inicio_at_bogota) >= 19
                        OR extract(isodow FROM inicio_at_bogota) = 7)`;

async function indicadores(desde: string, hasta: string) {
  const p = [desde, hasta];
  const [citas, envios, sesiones, listaEspera] = await Promise.all([
    // Solo citas de pacientes (TR-02): sin reuniones internas ni bloques administrativos.
    queryOne(
      `WITH ${CITAS}
       SELECT count(*) FILTER (WHERE fecha_cita BETWEEN $1 AND $2) AS total,
              count(*) FILTER (WHERE fecha_cita BETWEEN $1 AND $2 AND grupo = 'Asistió') AS asistio,
              count(*) FILTER (WHERE fecha_cita BETWEEN $1 AND $2 AND grupo = 'No asistió') AS no_asistio,
              count(*) FILTER (WHERE fecha_cita BETWEEN $1 AND $2 AND grupo = 'Cancelada') AS canceladas,
              count(*) FILTER (WHERE fecha_cita BETWEEN $1 AND $2 AND grupo = 'Reprogramada') AS reprogramadas,
              count(*) FILTER (WHERE fecha_cita BETWEEN $1 AND $2 AND grupo = 'Programada') AS programadas,
              count(*) FILTER (WHERE fecha_cita BETWEEN $1 AND $2 AND grupo = 'Sin cierre') AS sin_cierre,
              count(*) FILTER (WHERE created_at_bogota >= $1::date AND created_at_bogota < $2::date + 1) AS registradas
         FROM citas
        WHERE es_cita_paciente`,
      p,
    ),
    // Confirmó (CAM-01): respondió "confirmo" al mensaje o la cita pasó a Confirmado después del envío.
    queryOne(
      `SELECT count(*) FILTER (WHERE estado NOT IN ('rechazado_api', 'failed')) AS enviados,
              count(*) FILTER (WHERE estado IN ('rechazado_api', 'failed')) AS fallidos,
              count(*) FILTER (WHERE entregado) AS entregados,
              count(*) FILTER (WHERE leido) AS leidos,
              count(*) FILTER (WHERE estado_respuesta IN ('respondio', 'respondio_tarde')) AS respondieron,
              -- Base de la tasa de respuesta: sin el recordatorio de 2 h ni los avisos a asesores, que no piden respuesta.
              count(*) FILTER (WHERE estado NOT IN ('rechazado_api', 'failed') AND campana NOT IN ('daily', 'aviso_asesor')) AS enviados_con_respuesta,
              count(*) FILTER (WHERE respuesta_tipo = 'confirmo' OR cita_confirmada_despues) AS confirmaron
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
              count(*) FILTER (WHERE resultado_negocio IN ('derivado_agente', 'fuera_horario')) AS derivadas_agente,
              count(*) FILTER (WHERE ${FUERA_HORARIO}) AS fuera_horario
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
  return { citas, envios, sesiones, listaEspera };
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
          `WITH ${CITAS}, p AS (${PERIODOS})
           SELECT p.periodo, c.grupo, coalesce(c.n, 0) AS n
             FROM p
             LEFT JOIN (
               SELECT ${periodo('fecha_cita')} AS periodo, grupo, count(*) AS n
                 FROM citas
                WHERE es_cita_paciente AND fecha_cita BETWEEN $1 AND $2
                GROUP BY 1, 2
             ) c USING (periodo)
            ORDER BY 1`,
          p,
        ),
        query(
          `WITH p AS (${PERIODOS})
           SELECT p.periodo,
                  count(e.*) FILTER (WHERE e.estado NOT IN ('rechazado_api', 'failed')) AS enviados,
                  count(e.*) FILTER (WHERE e.estado_respuesta IN ('respondio', 'respondio_tarde')) AS respondieron,
                  count(e.*) FILTER (WHERE e.estado IN ('rechazado_api', 'failed')) AS fallidos
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

  // RES-02: citas atendidas por mes y especialidad desde el inicio de los datos (no depende del rango).
  app.get('/api/resumen/tendencia', async (req) =>
    conCache(
      req.url,
      async () => {
        const filas = await query(
          `WITH ${CITAS}, m AS (${MESES})
           SELECT m.mes, e.especialidad, coalesce(c.n, 0) AS n
             FROM m
            CROSS JOIN (VALUES ('Psicología'), ('Psiquiatría'), ('Neuropsicología')) AS e(especialidad)
             LEFT JOIN (
               SELECT to_char(fecha_cita, 'YYYY-MM') AS mes, especialidad, count(*) AS n
                 FROM citas
                WHERE es_cita_paciente AND grupo = 'Asistió'
                GROUP BY 1, 2
             ) c ON c.mes = m.mes AND c.especialidad = e.especialidad
            ORDER BY 1`,
        );
        return { filas };
      },
      300_000,
    ),
  );
}
