import type { FastifyInstance } from 'fastify';
import { query, queryOne } from '../db.js';
import { conCache } from '../cache.js';
import { claveCache } from '../acceso.js';

export default async function rutasSistema(app: FastifyInstance) {
  app.get('/api/sistema', async (req) => {
    return conCache(
      claveCache(req),
      async () => {
        const [actividad, campanas, erroresEnvio, erroresBot] = await Promise.all([
          queryOne(
            `SELECT (SELECT max(fecha_hora_bogota) FROM bi.fact_eventos WHERE NOT es_backfill) AS ultimo_evento_bot,
                    (SELECT count(*) FROM bi.fact_eventos
                      WHERE NOT es_backfill AND fecha_hora > (now() AT TIME ZONE 'UTC') - interval '24 hours') AS eventos_24h,
                    (SELECT max(greatest(created_at_bogota, updated_at_bogota)) FROM bi.fact_citas) AS ultima_actualizacion_agenda,
                    (SELECT max(inicio_at_bogota) FROM bi.fact_sesiones) AS ultima_conversacion,
                    to_char(now() AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD"T"HH24:MI:SS') AS ahora`,
          ),
          query(
            `SELECT campana, max(aceptado_at_bogota) AS ultimo_envio,
                    count(*) FILTER (WHERE fecha_bogota = (now() AT TIME ZONE 'America/Bogota')::date) AS envios_hoy,
                    count(*) FILTER (WHERE fecha_bogota = (now() AT TIME ZONE 'America/Bogota')::date
                                       AND estado IN ('rechazado_api', 'failed')) AS fallidos_hoy
               FROM bi.fact_envios
              WHERE fecha_bogota > (now() AT TIME ZONE 'America/Bogota')::date - 60
              GROUP BY campana ORDER BY max(aceptado_at) DESC NULLS LAST`,
          ),
          query(
            `SELECT coalesce(error_titulo, 'Sin detalle') AS error, error_code, count(*) AS n, max(fecha_bogota) AS ultima_vez
               FROM bi.fact_envios
              WHERE estado IN ('rechazado_api', 'failed') AND fecha_bogota > (now() AT TIME ZONE 'America/Bogota')::date - 7
              GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20`,
          ),
          query(
            `SELECT tipo_evento, coalesce(meta_endpoint, meta_cause, '') AS detalle, count(*) AS n, max(fecha_hora_bogota) AS ultima_vez
               FROM bi.fact_eventos
              WHERE NOT es_backfill AND tipo_evento ILIKE '%error%'
                AND fecha_hora > (now() AT TIME ZONE 'UTC') - interval '7 days'
              GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20`,
          ),
        ]);
        return { actividad, campanas, erroresEnvio, erroresBot };
      },
      30_000,
    );
  });
}
