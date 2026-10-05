import type { FastifyInstance } from 'fastify';
import { query, queryOne } from '../db.js';
import { conCache } from '../cache.js';
import { claveCache } from '../acceso.js';
import { ErrorParametro, leerRango, leerTexto } from '../params.js';
import { CITAS, MESES } from '../sql.js';

const ID = /^[A-Za-z0-9]{1,16}$/;

export default async function rutasPacientes(app: FastifyInstance) {
  // Panorama de pacientes: PAC-01 (nuevos y recurrentes), PAC-03 (tiempo entre citas), PAC-05 (perfil).
  app.get('/api/pacientes/panorama', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    return conCache(claveCache(req), async () => {
      const [mensual, intervalos, perfil, resumenIntervalos] = await Promise.all([
        // Nuevo en el mes = su primera atención (desde ago-2025) cae en ese mes. Ago-2025 incluye a quienes ya venían.
        query(
          `WITH ${CITAS},
           at AS (
             SELECT paciente_id, fecha_cita, min(fecha_cita) OVER (PARTITION BY paciente_id) AS primera
               FROM citas WHERE es_cita_paciente AND grupo = 'Asistió' AND paciente_id IS NOT NULL
           ), m AS (${MESES})
           SELECT m.mes,
                  count(DISTINCT at.paciente_id) FILTER (WHERE to_char(at.primera, 'YYYY-MM') = m.mes) AS nuevos,
                  count(DISTINCT at.paciente_id) FILTER (WHERE to_char(at.primera, 'YYYY-MM') < m.mes) AS recurrentes
             FROM m LEFT JOIN at ON to_char(at.fecha_cita, 'YYYY-MM') = m.mes
            GROUP BY 1 ORDER BY 1`,
        ),
        // Días entre atenciones consecutivas del mismo paciente, en semanas (la última barra agrupa 12+).
        query(
          `WITH ${CITAS},
           at AS (
             SELECT fecha_cita - lag(fecha_cita) OVER (PARTITION BY paciente_id ORDER BY fecha_cita, hora_cita) AS dias
               FROM citas WHERE es_cita_paciente AND grupo = 'Asistió' AND paciente_id IS NOT NULL
           )
           SELECT least(ceil(dias / 7.0)::int, 13) AS semana, count(*) AS n
             FROM at WHERE dias > 0 GROUP BY 1 ORDER BY 1`,
        ),
        // Perfil de los pacientes atendidos en el rango (pacientes distintos, no citas).
        query(
          `WITH ${CITAS},
           pac AS (
             SELECT DISTINCT ON (paciente_id) paciente_id, rango_edad, coalesce(nullif(trim(regimen), ''), 'sin_dato') AS regimen,
                    administradora_n, tipo_pago, modalidad, especialidad
               FROM citas
              WHERE es_cita_paciente AND grupo = 'Asistió' AND fecha_cita BETWEEN $1 AND $2 AND paciente_id IS NOT NULL
              ORDER BY paciente_id, fecha_cita DESC
           )
           SELECT 'edad' AS dimension, rango_edad AS clave, count(*) AS n FROM pac GROUP BY 2
           UNION ALL SELECT 'regimen', regimen, count(*) FROM pac GROUP BY 2
           UNION ALL SELECT 'pago', tipo_pago, count(*) FROM pac GROUP BY 2
           UNION ALL SELECT 'modalidad', modalidad, count(*) FROM pac GROUP BY 2
           UNION ALL SELECT 'especialidad', especialidad, count(*) FROM pac GROUP BY 2`,
          [r.desde, r.hasta],
        ),
        queryOne(
          `WITH ${CITAS},
           at AS (
             SELECT fecha_cita - lag(fecha_cita) OVER (PARTITION BY paciente_id ORDER BY fecha_cita, hora_cita) AS dias
               FROM citas WHERE es_cita_paciente AND grupo = 'Asistió' AND paciente_id IS NOT NULL
           )
           SELECT count(*) AS n,
                  percentile_cont(0.25) WITHIN GROUP (ORDER BY dias) AS p25,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY dias) AS mediana,
                  percentile_cont(0.75) WITHIN GROUP (ORDER BY dias) AS p75
             FROM at WHERE dias > 0`,
        ),
      ]);
      return { mensual, intervalos, perfil, resumenIntervalos };
    }, 300_000);
  });

  // Búsqueda por documento exacto, por teléfono (últimos dígitos) o por nombre (mínimo 3 letras).
  app.get('/api/pacientes/buscar', async (req) => {
    const q = leerTexto(req.query as Record<string, unknown>, 'q', 80);
    if (!q || q.length < 3) throw new ErrorParametro('Escriba al menos 3 caracteres');
    const digitos = q.replace(/\D/g, '');
    const esNumero = digitos.length >= 5 && digitos.length === q.replace(/[\s+()-]/g, '').length;
    const filas = esNumero
      ? await query(
          `SELECT paciente_id, nombre_completo, tipo_documento, numero_documento, telefono_norm, edad, convenio
             FROM bi.dim_paciente
            WHERE numero_documento = $1 OR telefono_norm LIKE '%' || $1
            ORDER BY nombre_completo LIMIT 25`,
          [digitos],
        )
      : await query(
          `SELECT paciente_id, nombre_completo, tipo_documento, numero_documento, telefono_norm, edad, convenio
             FROM bi.dim_paciente
            WHERE nombre_completo ILIKE '%' || $1 || '%'
            ORDER BY nombre_completo LIMIT 25`,
          [q.replace(/[%_\\]/g, '')],
        );
    return { filas };
  });

  app.get('/api/pacientes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!ID.test(id)) throw new ErrorParametro('Identificador inválido');
    const paciente = await queryOne<{ telefono_norm: string | null }>(
      `SELECT paciente_id, nombre_completo, tipo_documento, numero_documento, telefono_norm, email, edad, rango_edad,
              convenio, administradora, regimen, created_at_bogota AS registrado
         FROM bi.dim_paciente WHERE paciente_id = $1`,
      [id],
    );
    if (!paciente) return reply.code(404).send({ error: 'Paciente no encontrado' });

    const [citas, timeline, listaEspera] = await Promise.all([
      query(
        `SELECT fecha_cita, hora_cita, estado_agenda, especialidad, profesional, tipo_consulta, tipo_atencion,
                administradora, origen_cancelacion
           FROM bi.fact_citas WHERE paciente_id = $1
          ORDER BY fecha_cita DESC, hora_cita DESC LIMIT 200`,
        [id],
      ),
      query(
        `SELECT ocurrido_at_bogota AS cuando, fuente, tipo, flujo, paso, resultado, campana, origen
           FROM bi.v_timeline_paciente
          WHERE paciente_id = $1 OR ($2::text IS NOT NULL AND telefono_norm = $2)
          ORDER BY ocurrido_at DESC NULLS LAST LIMIT 300`,
        [id, paciente.telefono_norm],
      ),
      query(
        `SELECT DISTINCT ON (lista_espera_id) lista_espera_id, especialidad, estado_inscripcion,
                inscripcion_created_at_bogota AS inscrito, ofertas_enviadas
           FROM bi.fact_lista_espera WHERE paciente_id = $1
          ORDER BY lista_espera_id, inscripcion_created_at DESC`,
        [id],
      ),
    ]);
    return { paciente, citas, timeline, listaEspera };
  });
}
