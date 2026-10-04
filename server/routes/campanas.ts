import type { FastifyInstance } from 'fastify';
import { query, queryOne } from '../db.js';
import { conCache } from '../cache.js';
import { ErrorParametro, leerPagina, leerRango, leerTexto } from '../params.js';
import { PERIODOS, periodo } from '../sql.js';

const FILTROS_RESPUESTA = new Set(['respondio', 'respondio_tarde', 'no_respondio', 'pendiente', 'no_aplica']);

export default async function rutasCampanas(app: FastifyInstance) {
  app.get('/api/campanas', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    const p = [r.desde, r.hasta, r.grano];
    return conCache(req.url, async () => {
      const [porCampana, serie, entregaDesde] = await Promise.all([
        query(
          `SELECT campana,
                  count(DISTINCT fecha_bogota) AS dias,
                  sum(enviados) AS enviados,
                  sum(rechazados_api) + sum(fallidos) AS fallidos,
                  sum(entregados) AS entregados,
                  sum(leidos) AS leidos,
                  sum(respondieron) AS respondieron,
                  sum(respondieron_tarde) AS respondieron_tarde,
                  sum(no_respondieron) AS no_respondieron,
                  sum(pendientes) AS pendientes,
                  sum(citas_confirmadas_despues) AS citas_confirmadas,
                  sum(citas_canceladas_despues) AS citas_canceladas
             FROM bi.v_campana_resumen
            WHERE fecha_bogota BETWEEN $1 AND $2
            GROUP BY campana
            ORDER BY sum(enviados) DESC`,
          p.slice(0, 2),
        ),
        query(
          `WITH p AS (${PERIODOS})
           SELECT p.periodo, c.campana, coalesce(c.enviados, 0) AS enviados, coalesce(c.respondieron, 0) AS respondieron
             FROM p
             LEFT JOIN (
               SELECT ${periodo('fecha_bogota')} AS periodo, campana,
                      sum(enviados) AS enviados, sum(respondieron) + sum(respondieron_tarde) AS respondieron
                 FROM bi.v_campana_resumen
                WHERE fecha_bogota BETWEEN $1 AND $2
                GROUP BY 1, 2
             ) c USING (periodo)
            ORDER BY 1`,
          p,
        ),
        // Desde cuándo hay estados de entrega/lectura de Meta (antes solo se sabía si la API aceptó el envío).
        queryOne(`SELECT min(fecha_bogota) AS fecha FROM bi.fact_envios WHERE delivered_at IS NOT NULL OR read_at IS NOT NULL`),
      ]);
      return { rango: r, porCampana, serie, entregaDesde: entregaDesde?.fecha ?? null };
    });
  });

  app.get('/api/campanas/envios', async (req) => {
    const q = req.query as Record<string, unknown>;
    const r = leerRango(q);
    const campana = leerTexto(q, 'campana', 60);
    const respuesta = leerTexto(q, 'respuesta', 30);
    if (respuesta && !FILTROS_RESPUESTA.has(respuesta)) throw new ErrorParametro('Filtro de respuesta inválido');
    const { tam, offset } = leerPagina(q, 50, 5000);
    const where = `fecha_bogota BETWEEN $1 AND $2 AND tipo_envio = 'plantilla'
                   AND ($3::text IS NULL OR campana = $3) AND ($4::text IS NULL OR estado_respuesta = $4)`;
    const p = [r.desde, r.hasta, campana, respuesta];
    return conCache(req.url, async () => {
      const [filas, total] = await Promise.all([
        query(
          `SELECT aceptado_at_bogota AS enviado, campana, plantilla, nombre_paciente, documento_paciente, telefono_norm,
                  estado, entregado, leido, estado_respuesta, respuesta_tipo, respondido_at_bogota AS respondido,
                  fecha_cita, hora_cita, estado_cita_actual, cita_confirmada_despues, cita_cancelada_despues,
                  error_titulo
             FROM bi.fact_envios
            WHERE ${where}
            ORDER BY aceptado_at DESC NULLS LAST
            LIMIT ${tam} OFFSET ${offset}`,
          p,
        ),
        queryOne<{ n: number }>(`SELECT count(*) AS n FROM bi.fact_envios WHERE ${where}`, p),
      ]);
      return { filas, total: total.n };
    });
  });
}
