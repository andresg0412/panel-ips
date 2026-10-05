import type { FastifyInstance } from 'fastify';
import { query, queryOne } from '../db.js';
import { conCache } from '../cache.js';
import { claveCache } from '../acceso.js';
import { ErrorParametro, leerRango, leerTexto } from '../params.js';
import { CITAS, MESES, NOSHOW } from '../sql.js';

// Profesionales por nombre normalizado (no por profesional_id): el 14 % de las citas no tiene
// profesional_id porque psiquiatras y neuropsicólogos no casan con el maestro `equipo` (hallazgo D4).

/**
 * Primera atención de cada paciente y si volvió en 90 días (PRO-04). Cohortes cerradas: primera atención
 * hace más de 90 días y desde sep-2025 (ago-2025 es la carga inicial y trae pacientes que ya venían).
 */
const RETENCION = `
  atenc AS (
    SELECT paciente_id, fecha_cita, profesional_nombre,
           fecha_cita AS primera,
           lead(fecha_cita) OVER (PARTITION BY paciente_id ORDER BY fecha_cita, hora_cita) AS segunda,
           row_number() OVER (PARTITION BY paciente_id ORDER BY fecha_cita, hora_cita) AS orden
      FROM citas
     WHERE es_cita_paciente AND grupo = 'Asistió' AND paciente_id IS NOT NULL
  ),
  nuevos AS (
    SELECT paciente_id, profesional_nombre, primera,
           (segunda IS NOT NULL AND segunda <= primera + 90) AS volvio_90d
      FROM atenc
     WHERE orden = 1
  )`;

export default async function rutasProfesionales(app: FastifyInstance) {
  app.get('/api/profesionales', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    const p = [r.desde, r.hasta];
    return conCache(claveCache(req), async () => {
      const filas = await query(
        `WITH ${CITAS}, ${RETENCION},
         ret AS (
           SELECT profesional_nombre, count(*) AS nuevos_cohorte, count(*) FILTER (WHERE volvio_90d) AS volvieron
             FROM nuevos
            WHERE primera >= DATE '2025-09-01' AND primera <= (now() AT TIME ZONE 'America/Bogota')::date - 90
            GROUP BY 1
         ),
         nuevos_rango AS (
           SELECT profesional_nombre, count(*) AS n FROM nuevos WHERE primera BETWEEN $1 AND $2 GROUP BY 1
         )
         SELECT c.profesional_nombre AS nombre,
                max(c.especialidad) AS especialidad,
                count(*) AS total,
                count(*) FILTER (WHERE c.grupo = 'Asistió') AS asistio,
                count(*) FILTER (WHERE c.grupo = 'No asistió') AS no_asistio,
                count(*) FILTER (WHERE c.grupo IN ('Cancelada', 'Reprogramada')) AS no_ocurrieron,
                count(DISTINCT c.paciente_id) FILTER (WHERE c.grupo = 'Asistió') AS pacientes,
                coalesce(max(nr.n), 0) AS nuevos,
                coalesce(max(ret.nuevos_cohorte), 0) AS nuevos_cohorte,
                coalesce(max(ret.volvieron), 0) AS volvieron,
                bool_or(c.profesional_id IS NOT NULL) AS en_maestro
           FROM citas c
           LEFT JOIN ret ON ret.profesional_nombre = c.profesional_nombre
           LEFT JOIN nuevos_rango nr ON nr.profesional_nombre = c.profesional_nombre
          WHERE c.es_cita_paciente AND c.fecha_cita BETWEEN $1 AND $2 AND c.profesional_nombre <> ''
          GROUP BY 1
          ORDER BY 3 DESC`,
        p,
      );
      return { rango: r, filas };
    });
  });

  // PRO-02: ficha de un profesional.
  app.get('/api/profesionales/ficha', async (req) => {
    const q = req.query as Record<string, unknown>;
    const r = leerRango(q);
    const nombre = leerTexto(q, 'nombre', 120);
    if (!nombre) throw new ErrorParametro('Falta el nombre del profesional');
    const p = [r.desde, r.hasta, nombre];
    return conCache(claveCache(req), async () => {
      const [kpis, mensual, servicios, franja, dia] = await Promise.all([
        queryOne(
          `WITH ${CITAS}
           SELECT count(*) AS total,
                  count(*) FILTER (WHERE grupo = 'Asistió') AS asistio,
                  count(*) FILTER (WHERE grupo = 'No asistió') AS no_asistio,
                  count(*) FILTER (WHERE grupo = 'Cancelada') AS canceladas,
                  count(*) FILTER (WHERE grupo = 'Reprogramada') AS reprogramadas,
                  count(*) FILTER (WHERE grupo = 'Programada') AS programadas,
                  count(DISTINCT paciente_id) FILTER (WHERE grupo = 'Asistió') AS pacientes,
                  count(*) FILTER (WHERE grupo = 'Asistió' AND modalidad = 'virtual') AS virtuales
             FROM citas
            WHERE es_cita_paciente AND profesional_nombre = $3 AND fecha_cita BETWEEN $1 AND $2`,
          p,
        ),
        query(
          `WITH ${CITAS}, m AS (${MESES})
           SELECT m.mes,
                  count(c.*) FILTER (WHERE c.grupo = 'Asistió') AS asistio,
                  count(c.*) FILTER (WHERE c.grupo = 'No asistió') AS no_asistio,
                  count(c.*) FILTER (WHERE c.grupo IN ('Cancelada', 'Reprogramada')) AS no_ocurrieron
             FROM m
             LEFT JOIN citas c ON to_char(c.fecha_cita, 'YYYY-MM') = m.mes AND c.es_cita_paciente AND c.profesional_nombre = $1
            GROUP BY 1 ORDER BY 1`,
          [nombre],
        ),
        query(
          `WITH ${CITAS}
           SELECT tipo_servicio AS clave, count(*) AS n
             FROM citas
            WHERE es_cita_paciente AND profesional_nombre = $3 AND fecha_cita BETWEEN $1 AND $2 AND grupo = 'Asistió'
            GROUP BY 1 ORDER BY 2 DESC`,
          p,
        ),
        query(
          `WITH ${CITAS}
           SELECT hora AS clave, ${NOSHOW}
             FROM citas
            WHERE es_cita_paciente AND profesional_nombre = $3 AND fecha_cita BETWEEN $1 AND $2 AND periodo_confiable
            GROUP BY 1 ORDER BY 1`,
          p,
        ),
        query(
          `WITH ${CITAS}
           SELECT dia AS clave, count(*) FILTER (WHERE grupo IN ('Asistió', 'No asistió', 'Programada', 'Sin cierre')) AS n
             FROM citas
            WHERE es_cita_paciente AND profesional_nombre = $3 AND fecha_cita BETWEEN $1 AND $2
            GROUP BY 1 ORDER BY 1`,
          p,
        ),
      ]);
      return { nombre, kpis, mensual, servicios, franja, dia };
    });
  });
}
