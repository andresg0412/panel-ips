import type { FastifyInstance } from 'fastify';
import { query } from '../db.js';
import { conCache } from '../cache.js';
import { claveCache } from '../acceso.js';
import { leerRango } from '../params.js';
import { CITAS, HOY, MESES, NOSHOW, PERIODOS, periodo } from '../sql.js';

// Asistencia = asistió / (asistió + no asistió). Las canceladas y reprogramadas no cuentan
// porque la cita no llegó a ocurrir. Todo sobre citas de pacientes (sin reuniones internas).
const COLUMNAS_ESTADO = `
  count(*) AS total,
  count(*) FILTER (WHERE grupo = 'Asistió') AS asistio,
  count(*) FILTER (WHERE grupo = 'No asistió') AS no_asistio,
  count(*) FILTER (WHERE grupo = 'Cancelada') AS canceladas,
  count(*) FILTER (WHERE grupo = 'Reprogramada') AS reprogramadas,
  count(*) FILTER (WHERE grupo = 'Programada') AS programadas,
  count(*) FILTER (WHERE grupo = 'Sin cierre') AS sin_cierre`;

const EN_RANGO = `es_cita_paciente AND fecha_cita BETWEEN $1 AND $2`;

/** Inasistencia por una dimensión de la CTE `citas`, solo en períodos confiables (AGE-01). */
const noshowPor = (expr: string) => `
  WITH ${CITAS}
  SELECT ${expr} AS clave, ${NOSHOW}
    FROM citas
   WHERE ${EN_RANGO} AND periodo_confiable
   GROUP BY 1 ORDER BY 1`;

export default async function rutasAgenda(app: FastifyInstance) {
  app.get('/api/agenda', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    const p = [r.desde, r.hasta];
    return conCache(claveCache(req), async () => {
      const [serie, especialidad, profesional, administradora, diaSemana, origenCancelacion, cambios, servicio] = await Promise.all([
        query(
          `WITH ${CITAS}, p AS (${PERIODOS})
           SELECT p.periodo, c.grupo, coalesce(c.n, 0) AS n
             FROM p
             LEFT JOIN (
               SELECT ${periodo('fecha_cita')} AS periodo, grupo, count(*) AS n
                 FROM citas WHERE ${EN_RANGO} GROUP BY 1, 2
             ) c USING (periodo)
            ORDER BY 1`,
          [...p, r.grano],
        ),
        query(
          `WITH ${CITAS}
           SELECT CASE WHEN especialidad IN ('Psicología', 'Psiquiatría', 'Neuropsicología') THEN especialidad ELSE 'Otra' END AS nombre,
                  ${COLUMNAS_ESTADO}
             FROM citas WHERE ${EN_RANGO}
            GROUP BY 1 ORDER BY 2 DESC`,
          p,
        ),
        query(
          `WITH ${CITAS}
           SELECT coalesce(nullif(profesional_nombre, ''), 'Sin profesional') AS nombre, ${COLUMNAS_ESTADO}
             FROM citas WHERE ${EN_RANGO}
            GROUP BY 1 ORDER BY 2 DESC LIMIT 40`,
          p,
        ),
        query(
          `WITH ${CITAS}
           SELECT administradora_n AS nombre, ${COLUMNAS_ESTADO}
             FROM citas WHERE ${EN_RANGO}
            GROUP BY 1 ORDER BY 2 DESC LIMIT 15`,
          p,
        ),
        query(
          `WITH ${CITAS}
           SELECT dia, ${COLUMNAS_ESTADO}
             FROM citas WHERE ${EN_RANGO}
            GROUP BY 1 ORDER BY 1`,
          p,
        ),
        query(
          `WITH ${CITAS}
           SELECT coalesce(origen_cancelacion, 'sin_registro') AS origen, count(*) AS n
             FROM citas
            WHERE ${EN_RANGO} AND grupo = 'Cancelada'
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
        // AGE-02 por tipo de servicio: cuánto no ocurrió de cada servicio.
        query(
          `WITH ${CITAS}
           SELECT tipo_servicio AS nombre, ${COLUMNAS_ESTADO},
                  round(sum(extract(epoch FROM (hora_final - hora_cita)) / 3600.0)
                        FILTER (WHERE grupo IN ('Cancelada', 'Reprogramada') AND hora_final > hora_cita)::numeric, 0) AS horas_no_ocurrieron
             FROM citas WHERE ${EN_RANGO}
            GROUP BY 1 ORDER BY 2 DESC`,
          p,
        ),
      ]);
      return { rango: r, serie, especialidad, profesional, administradora, diaSemana, origenCancelacion, cambios, servicio };
    });
  });

  // AGE-01: mapa de la inasistencia en el rango elegido (solo días confiables; el panel oculta n < 30).
  app.get('/api/agenda/inasistencia', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    const p = [r.desde, r.hasta];
    return conCache(claveCache(req), async () => {
      const [mapa, edad, modalidad, anticipacion, especialidad, pago, servicio] = await Promise.all([
        query(
          `WITH ${CITAS}
           SELECT dia, hora, ${NOSHOW}
             FROM citas WHERE ${EN_RANGO} AND periodo_confiable
            GROUP BY 1, 2`,
          p,
        ),
        query(noshowPor('rango_edad'), p),
        query(noshowPor('modalidad'), p),
        query(
          noshowPor(`CASE
              WHEN anticipacion_registro_dias < 0 THEN 'z_sin_dato'
              WHEN anticipacion_registro_dias = 0 THEN 'a_mismo_dia'
              WHEN anticipacion_registro_dias <= 3 THEN 'b_1_3'
              WHEN anticipacion_registro_dias <= 7 THEN 'c_4_7'
              WHEN anticipacion_registro_dias <= 15 THEN 'd_8_15'
              ELSE 'e_16_mas' END`),
          p,
        ),
        query(noshowPor('especialidad'), p),
        query(noshowPor('tipo_pago'), p),
        query(noshowPor('tipo_servicio'), p),
      ]);
      return { mapa, edad, modalidad, anticipacion, especialidad, pago, servicio };
    });
  });

  // Tendencias mensuales desde el inicio de los datos (no dependen del rango): AGE-02, 04, 05, 06, 07.
  app.get('/api/agenda/historico', async (req) =>
    conCache(
      claveCache(req),
      async () => {
        const [mensual, servicios, espera, convenios] = await Promise.all([
          query(
            `WITH ${CITAS}, m AS (${MESES})
             SELECT m.mes,
                    count(c.*) AS total,
                    count(c.*) FILTER (WHERE c.grupo = 'Cancelada') AS canceladas,
                    count(c.*) FILTER (WHERE c.grupo = 'Reprogramada') AS reprogramadas,
                    count(c.*) FILTER (WHERE c.grupo IN ('Asistió', 'No asistió')) AS cerradas,
                    count(c.*) FILTER (WHERE c.grupo = 'No asistió') AS no_asistio,
                    count(c.*) FILTER (WHERE c.modalidad = 'virtual') AS virtuales,
                    count(c.*) FILTER (WHERE c.modalidad = 'virtual' AND c.grupo = 'No asistió') AS no_asistio_virtual,
                    count(c.*) FILTER (WHERE c.modalidad = 'virtual' AND c.grupo IN ('Asistió', 'No asistió')) AS cerradas_virtual,
                    count(c.*) FILTER (WHERE c.tipo_pago = 'particular') AS particulares
               FROM m
               -- Solo citas ya pasadas: en el mes en curso las futuras bajarían artificialmente las tasas.
               LEFT JOIN citas c ON to_char(c.fecha_cita, 'YYYY-MM') = m.mes AND c.es_cita_paciente AND c.fecha_cita < ${HOY}
              GROUP BY 1 ORDER BY 1`,
          ),
          query(
            `WITH ${CITAS}
             SELECT to_char(fecha_cita, 'YYYY-MM') AS mes, tipo_servicio, count(*) AS n
               FROM citas
              WHERE es_cita_paciente AND grupo = 'Asistió' AND fecha_cita <= (now() AT TIME ZONE 'America/Bogota')::date
              GROUP BY 1, 2 ORDER BY 1`,
          ),
          // AGE-04: días entre el registro de la cita y la cita (aproximado: el scraper ve la cita al entrar en
          // su ventana de ~30 días). Desde sep-2025 (ago-2025 es la carga inicial) y fuera de incidentes.
          query(
            `WITH ${CITAS}
             SELECT to_char(fecha_cita, 'YYYY-MM') AS mes,
                    CASE WHEN especialidad IN ('Psicología', 'Psiquiatría', 'Neuropsicología') THEN especialidad ELSE 'Otra' END AS especialidad,
                    CASE WHEN tipo_servicio = 'primera_vez' THEN 'primera_vez' ELSE 'control' END AS tipo,
                    count(*) AS n,
                    percentile_cont(0.5) WITHIN GROUP (ORDER BY anticipacion_registro_dias) AS mediana,
                    percentile_cont(0.9) WITHIN GROUP (ORDER BY anticipacion_registro_dias) AS p90
               FROM citas
              WHERE es_cita_paciente AND periodo_confiable AND anticipacion_registro_dias >= 0
                AND tipo_servicio IN ('primera_vez', 'control') AND fecha_cita >= DATE '2025-09-01'
                AND fecha_cita <= (now() AT TIME ZONE 'America/Bogota')::date
              GROUP BY 1, 2, 3 ORDER BY 1`,
          ),
          query(
            `WITH ${CITAS}
             SELECT administradora_n AS nombre, count(*) AS total,
                    count(*) FILTER (WHERE grupo = 'Asistió') AS asistio
               FROM citas WHERE es_cita_paciente
              GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
          ),
        ]);
        return { mensual, servicios, espera, convenios };
      },
      300_000,
    ),
  );

  // AGE-08: citas sin cierre por mes y citas sin profesional asignado en el maestro `equipo`.
  app.get('/api/agenda/calidad', async (req) =>
    conCache(
      claveCache(req),
      async () => {
        const [sinCierre, sinProfesional, administrativas] = await Promise.all([
          query(
            `WITH ${CITAS}
             SELECT to_char(fecha_cita, 'YYYY-MM') AS mes, count(*) AS n
               FROM citas WHERE es_cita_paciente AND grupo = 'Sin cierre'
              GROUP BY 1 ORDER BY 1 DESC`,
          ),
          query(
            `WITH ${CITAS}
             SELECT coalesce(nullif(profesional_nombre, ''), 'Sin nombre') AS profesional,
                    max(especialidad) AS especialidad, count(*) AS n, max(fecha_cita) AS ultima
               FROM citas WHERE es_cita_paciente AND profesional_id IS NULL
              GROUP BY 1 ORDER BY 3 DESC`,
          ),
          query(
            `WITH ${CITAS}
             SELECT coalesce(nullif(catalogo, ''), '(sin catálogo)') AS catalogo, count(*) AS n
               FROM citas WHERE NOT es_cita_paciente
              GROUP BY 1 ORDER BY 2 DESC`,
          ),
        ]);
        return { sinCierre, sinProfesional, administrativas };
      },
      300_000,
    ),
  );
}
