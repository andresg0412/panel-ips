import type { FastifyInstance } from 'fastify';
import { query, queryOne } from '../db.js';
import { conCache } from '../cache.js';
import { claveCache } from '../acceso.js';
import { ErrorParametro, leerRango, leerTexto } from '../params.js';
import { resolverComparativo, ttlComparativo } from '../comparativo.js';
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
           lead(fecha_cita) OVER (PARTITION BY paciente_id ORDER BY fecha_cita, hora_cita, agenda_id) AS segunda,
           row_number() OVER (PARTITION BY paciente_id ORDER BY fecha_cita, hora_cita, agenda_id) AS orden
      FROM citas
     WHERE es_cita_paciente AND grupo = 'Asistió' AND paciente_id IS NOT NULL
  ),
  nuevos AS (
    SELECT paciente_id, profesional_nombre, primera,
           (segunda IS NOT NULL AND segunda <= primera + 90) AS volvio_90d
      FROM atenc
     WHERE orden = 1
  )`;

// Pacientes cuya primera atención histórica cae en el periodo ($1 a $2), por el profesional que los atendió (PRO-01).
const NUEVOS_EN_RANGO = `
  nuevos_rango AS (
    SELECT profesional_nombre, count(*) AS n FROM nuevos WHERE primera BETWEEN $1 AND $2 GROUP BY 1
  )`;

// Cifras de cada profesional en el periodo ($1 a $2), sobre `citas c` unida a `nuevos_rango nr`. Las comparten la
// lista y el comparativo de periodos.
const COLUMNAS_PROFESIONAL = `
  c.profesional_nombre AS nombre,
  max(c.especialidad) AS especialidad,
  count(*) AS total,
  count(*) FILTER (WHERE c.grupo = 'Asistió') AS asistio,
  count(*) FILTER (WHERE c.grupo = 'No asistió') AS no_asistio,
  count(*) FILTER (WHERE c.grupo IN ('Cancelada', 'Reprogramada')) AS no_ocurrieron,
  count(DISTINCT c.paciente_id) FILTER (WHERE c.grupo = 'Asistió') AS pacientes,
  coalesce(max(nr.n), 0) AS nuevos,
  bool_or(c.profesional_id IS NOT NULL) AS en_maestro`;

const FILTRO_PROFESIONALES = `c.es_cita_paciente AND c.fecha_cita BETWEEN $1 AND $2 AND c.profesional_nombre <> ''`;

/** Una fila por profesional con citas en el periodo, sin la retención a 90 días (que no es mensual). */
function filasProfesionales(desde: string, hasta: string) {
  return query(
    `WITH ${CITAS}, ${RETENCION}, ${NUEVOS_EN_RANGO}
     SELECT ${COLUMNAS_PROFESIONAL}
       FROM citas c
       LEFT JOIN nuevos_rango nr ON nr.profesional_nombre = c.profesional_nombre
      WHERE ${FILTRO_PROFESIONALES}
      GROUP BY 1
      ORDER BY 3 DESC`,
    [desde, hasta],
  );
}

/** Cifras de un profesional en el periodo ($3 = nombre normalizado). */
function kpisProfesional(nombre: string, desde: string, hasta: string) {
  return queryOne(
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
    [desde, hasta, nombre],
  );
}

/** Tipo de atención de las citas atendidas de un profesional en el periodo. */
function serviciosProfesional(nombre: string, desde: string, hasta: string) {
  return query(
    `WITH ${CITAS}
     SELECT tipo_servicio AS clave, count(*) AS n
       FROM citas
      WHERE es_cita_paciente AND profesional_nombre = $3 AND fecha_cita BETWEEN $1 AND $2 AND grupo = 'Asistió'
      GROUP BY 1 ORDER BY 2 DESC`,
    [desde, hasta, nombre],
  );
}

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
         ${NUEVOS_EN_RANGO}
         SELECT ${COLUMNAS_PROFESIONAL},
                coalesce(max(ret.nuevos_cohorte), 0) AS nuevos_cohorte,
                coalesce(max(ret.volvieron), 0) AS volvieron
           FROM citas c
           LEFT JOIN ret ON ret.profesional_nombre = c.profesional_nombre
           LEFT JOIN nuevos_rango nr ON nr.profesional_nombre = c.profesional_nombre
          WHERE ${FILTRO_PROFESIONALES}
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
        kpisProfesional(nombre, r.desde, r.hasta),
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
        serviciosProfesional(nombre, r.desde, r.hasta),
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

  // Comparativo de periodos: una fila por profesional con citas en cualquiera de los dos meses.
  // Diseño: proyecto-ips/docs/features/2026-11-09-comparativo-periodos-panel.md, sección 4.3.
  app.get('/api/profesionales/comparativo', async (req) => {
    const c = resolverComparativo(req.query as Record<string, unknown>, req.contexto!);
    return conCache(
      claveCache(req),
      async () => {
        const [a, b] = await Promise.all([filasProfesionales(c.a.desde, c.a.hasta), filasProfesionales(c.b.desde, c.b.hasta)]);
        return { comparativo: c, a: { filas: a }, b: { filas: b } };
      },
      ttlComparativo(c),
    );
  });

  // Ficha de un profesional en los dos meses.
  app.get('/api/profesionales/comparativo/ficha', async (req) => {
    const q = req.query as Record<string, unknown>;
    const c = resolverComparativo(q, req.contexto!);
    const nombre = leerTexto(q, 'nombre', 120);
    if (!nombre) throw new ErrorParametro('Falta el nombre del profesional');
    const delPeriodo = async (desde: string, hasta: string) => {
      const [kpis, servicios] = await Promise.all([kpisProfesional(nombre, desde, hasta), serviciosProfesional(nombre, desde, hasta)]);
      return { kpis, servicios };
    };
    return conCache(
      claveCache(req),
      async () => {
        const [a, b] = await Promise.all([delPeriodo(c.a.desde, c.a.hasta), delPeriodo(c.b.desde, c.b.hasta)]);
        return { comparativo: c, nombre, a, b };
      },
      ttlComparativo(c),
    );
  });
}
