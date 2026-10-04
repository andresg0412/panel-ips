import type { FastifyInstance } from 'fastify';
import { query } from '../db.js';
import { conCache } from '../cache.js';
import { leerRango } from '../params.js';
import { GRUPO_ESTADO, PERIODOS, periodo } from '../sql.js';

// Asistencia = asistió / (asistió + no asistió). Las canceladas y reprogramadas no cuentan
// porque la cita no llegó a ocurrir.
const COLUMNAS_ESTADO = `
  count(*) AS total,
  count(*) FILTER (WHERE estado_agenda = 'Asistio') AS asistio,
  count(*) FILTER (WHERE estado_agenda = 'No Asistio') AS no_asistio,
  count(*) FILTER (WHERE estado_agenda IN ('Cancelado', 'Anulado')) AS canceladas,
  count(*) FILTER (WHERE estado_agenda = 'Reprogramar') AS reprogramadas,
  count(*) FILTER (WHERE estado_agenda IN ('Pendiente', 'Confirmado')) AS programadas`;

export default async function rutasAgenda(app: FastifyInstance) {
  app.get('/api/agenda', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    const p = [r.desde, r.hasta];
    return conCache(req.url, async () => {
      const [serie, especialidad, profesional, administradora, diaSemana, origenCancelacion, cambios] = await Promise.all([
        query(
          `WITH p AS (${PERIODOS})
           SELECT p.periodo, c.grupo, coalesce(c.n, 0) AS n
             FROM p
             LEFT JOIN (
               SELECT ${periodo('fecha_cita')} AS periodo, ${GRUPO_ESTADO} AS grupo, count(*) AS n
                 FROM bi.fact_citas WHERE fecha_cita BETWEEN $1 AND $2 GROUP BY 1, 2
             ) c USING (periodo)
            ORDER BY 1`,
          [...p, r.grano],
        ),
        query(
          `SELECT CASE WHEN especialidad IN ('Psicología', 'Psiquiatría', 'Neuropsicología') THEN especialidad ELSE 'Otra' END AS nombre,
                  ${COLUMNAS_ESTADO}
             FROM bi.fact_citas WHERE fecha_cita BETWEEN $1 AND $2
            GROUP BY 1 ORDER BY 2 DESC`,
          p,
        ),
        query(
          `SELECT coalesce(nullif(trim(profesional), ''), 'Sin profesional') AS nombre, ${COLUMNAS_ESTADO}
             FROM bi.fact_citas WHERE fecha_cita BETWEEN $1 AND $2
            GROUP BY 1 ORDER BY 2 DESC LIMIT 40`,
          p,
        ),
        query(
          `SELECT coalesce(nullif(trim(administradora), ''), 'Sin dato') AS nombre, ${COLUMNAS_ESTADO}
             FROM bi.fact_citas WHERE fecha_cita BETWEEN $1 AND $2
            GROUP BY 1 ORDER BY 2 DESC LIMIT 15`,
          p,
        ),
        query(
          `SELECT extract(isodow FROM fecha_cita)::int AS dia, ${COLUMNAS_ESTADO}
             FROM bi.fact_citas WHERE fecha_cita BETWEEN $1 AND $2
            GROUP BY 1 ORDER BY 1`,
          p,
        ),
        query(
          `SELECT coalesce(origen_cancelacion, 'sin_registro') AS origen, count(*) AS n
             FROM bi.fact_citas
            WHERE fecha_cita BETWEEN $1 AND $2 AND estado_agenda IN ('Cancelado', 'Anulado')
            GROUP BY 1 ORDER BY 2 DESC`,
          p,
        ),
        query(
          `SELECT e.cambiado_at_bogota AS cuando, e.estado_anterior, e.estado_nuevo, e.origen,
                  c.nombre_paciente, c.profesional, e.fecha_cita, e.hora_cita
             FROM bi.fact_cita_estados e
             LEFT JOIN bi.fact_citas c USING (agenda_id)
            WHERE e.fecha_bogota BETWEEN $1 AND $2
            ORDER BY e.cambiado_at DESC LIMIT 100`,
          p,
        ),
      ]);
      return { rango: r, serie, especialidad, profesional, administradora, diaSemana, origenCancelacion, cambios };
    });
  });
}
