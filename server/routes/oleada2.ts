import type { FastifyInstance } from 'fastify';
import { query, queryOne } from '../db.js';
import { conCache } from '../cache.js';
import { claveCache } from '../acceso.js';
import { hoyBogota, leerRango, sumarDias } from '../params.js';
import { CITAS, HOY } from '../sql.js';
import { CAPACIDAD_DESDE, CICLO, capacidad, contacto } from '../sql2.js';

// Oleada 2 del catálogo de analítica (docs/catalogo-analitica.md, sección 6).

export default async function rutasOleada2(app: FastifyInstance) {
  // ------------------------------------------------------------------------------------------- Agenda
  // AGE-03: con cuánta anticipación cancelan. Solo hay hora de cancelación desde el 30-sep-2026 (bot)
  // y el 3-oct-2026 (scraper); antes de eso la cancelación no tiene fecha y cuenta como "sin dato".
  app.get('/api/agenda/cancelaciones', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    return conCache(claveCache(req), async () => ({
      tramos: await query(
        `WITH ${CITAS},
         primero AS (
           SELECT agenda_id, min(cambiado_at_bogota) AS cancelada
             FROM bi.fact_cita_estados WHERE estado_nuevo IN ('Cancelado', 'Anulado') GROUP BY 1
         ),
         canc AS (
           SELECT extract(epoch FROM ((c.fecha_cita + c.hora_cita) - coalesce(c.cancelada_at_bogota, p.cancelada))) / 3600.0 AS horas
             FROM citas c LEFT JOIN primero p USING (agenda_id)
            WHERE c.es_cita_paciente AND c.grupo = 'Cancelada' AND c.fecha_cita BETWEEN $1 AND $2
         )
         SELECT CASE
                  WHEN horas IS NULL THEN 'sin_dato'
                  WHEN horas < 24 THEN 'a_menos_24h'
                  WHEN horas < 72 THEN 'b_1_3_dias'
                  ELSE 'c_3_dias_o_mas'
                END AS clave, count(*) AS n
           FROM canc GROUP BY 1 ORDER BY 1`,
        [r.desde, r.hasta],
      ),
    }));
  });

  // AGE-09: carga de las próximas 4 semanas frente a la capacidad y a las mismas semanas del año anterior.
  app.get('/api/agenda/proximas', async (req) =>
    conCache(claveCache(req), async () => {
      const hoy = hoyBogota();
      const fin = sumarDias(hoy, 27);
      // Cada fuente se agrupa por semana en una sola pasada y se une por igualdad: las subconsultas por semana
      // recorrían `citas` y `capacidad` una vez por cada semana y columna. Las semanas son lunes desde la de $1
      // hasta la que contiene $2; 364 días = 52 semanas, así que "hace un año" también cae en lunes.
      const filas = await query(
        `WITH ${CITAS}, ${capacidad('$1', '$2')},
         sem AS (SELECT generate_series(date_trunc('week', $1::date), $2::date, interval '1 week')::date AS semana),
         prog AS (SELECT date_trunc('week', fecha_cita)::date AS semana, count(*) AS n FROM citas
                   WHERE es_cita_paciente AND grupo = 'Programada'
                     AND fecha_cita >= date_trunc('week', $1::date)::date AND fecha_cita < date_trunc('week', $2::date)::date + 7
                   GROUP BY 1),
         capw AS (SELECT date_trunc('week', fecha)::date AS semana, sum(cupos) AS cupos, sum(ocupan) AS ocupan FROM capacidad GROUP BY 1),
         ant AS (SELECT date_trunc('week', fecha_cita)::date + 364 AS semana, count(*) AS n FROM citas
                  WHERE es_cita_paciente AND grupo IN ('Asistió', 'No asistió', 'Sin cierre')
                    AND fecha_cita >= date_trunc('week', $1::date)::date - 364 AND fecha_cita < date_trunc('week', $2::date)::date + 7 - 364
                  GROUP BY 1)
         SELECT sem.semana,
                coalesce(prog.n, 0) AS programadas,
                coalesce(capw.cupos, 0) AS capacidad_medible,
                coalesce(capw.ocupan, 0) AS ocupan_medible,
                coalesce(ant.n, 0) AS hace_un_ano
           FROM sem
           LEFT JOIN prog USING (semana)
           LEFT JOIN capw USING (semana)
           LEFT JOIN ant USING (semana)
          ORDER BY 1`,
        [hoy, fin],
      );
      return { filas };
    }, 300_000),
  );

  // ------------------------------------------------------------------------------------- Profesionales
  // PRO-01: ocupación de la agenda (días ya pasados del rango) y PRO-03: cupos libres de los próximos 14 días.
  app.get('/api/profesionales/ocupacion', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    return conCache(claveCache(req), async () => {
      const ayer = sumarDias(hoyBogota(), -1);
      const hasta = r.hasta < ayer ? r.hasta : ayer;
      const [porProfesional, porSemana, libres] = await Promise.all([
        query(
          `WITH ${CITAS}, ${capacidad('$1', '$2')}
           SELECT profesional, especialidad, sum(cupos) AS cupos, sum(ocupan) AS ocupan,
                  sum(administrativas) AS administrativas, sum(liberadas) AS liberadas
             FROM capacidad GROUP BY 1, 2 ORDER BY 1`,
          [r.desde, hasta],
        ),
        query(
          `WITH ${CITAS}, ${capacidad('$1', '$2')}
           SELECT profesional, date_trunc('week', fecha)::date AS semana, sum(cupos) AS cupos, sum(ocupan) AS ocupan
             FROM capacidad GROUP BY 1, 2 ORDER BY 2, 1`,
          [r.desde, hasta],
        ),
        query(
          `WITH ${CITAS}, ${capacidad('$1', '$2')}
           SELECT profesional, especialidad, fecha, cupos, libres FROM capacidad ORDER BY fecha, profesional`,
          [hoyBogota(), sumarDias(hoyBogota(), 13)],
        ),
      ]);
      // Profesionales con horario registrado pero sin citas enlazadas a su identificador (no medibles).
      const sinEnlace = await query(
        `WITH ${CITAS}
         SELECT p.nombre_completo AS profesional, p.especialidad
           FROM horariosequipo h JOIN bi.dim_profesional p ON p.profesional_id = h.profesionalid AND p.estado = 'Activo'
          WHERE (SELECT count(*) FROM citas c WHERE c.profesional_id = h.profesionalid AND c.es_cita_paciente
                   AND c.grupo IN ('Asistió', 'No asistió', 'Programada')
                   AND c.fecha_cita BETWEEN ${HOY} - 30 AND ${HOY} + 30) < 5
          ORDER BY 1`,
      );
      return { desde: r.desde > CAPACIDAD_DESDE ? r.desde : CAPACIDAD_DESDE, hasta, capacidadDesde: CAPACIDAD_DESDE, porProfesional, porSemana, libres, sinEnlace };
    });
  });

  // ------------------------------------------------------------------------------------------ Pacientes
  // PAC-02: cohortes de retención (mes de la primera atención × meses después) y PAC-04: estado de actividad.
  app.get('/api/pacientes/ciclo', async (req) =>
    conCache(claveCache(req), async () => {
      const [cohortes, estados] = await Promise.all([
        query(
          `WITH ${CITAS}, ${CICLO},
           coh AS (SELECT paciente_id, date_trunc('month', min(fecha_cita))::date AS cohorte FROM at GROUP BY 1),
           act AS (SELECT DISTINCT paciente_id, date_trunc('month', fecha_cita)::date AS mes FROM at)
           SELECT to_char(coh.cohorte, 'YYYY-MM') AS cohorte,
                  ((extract(year FROM act.mes) - extract(year FROM coh.cohorte)) * 12
                   + extract(month FROM act.mes) - extract(month FROM coh.cohorte))::int AS k,
                  count(*) AS n
             FROM coh JOIN act USING (paciente_id)
            WHERE coh.cohorte >= DATE '2025-09-01'
            GROUP BY 1, 2 ORDER BY 1, 2`,
        ),
        query(`WITH ${CITAS}, ${CICLO} SELECT estado AS clave, count(*) AS n FROM ciclo GROUP BY 1`),
      ]);
      return { cohortes, estados };
    }, 300_000),
  );

  // Exportación de pacientes en riesgo de abandonar (PAC-04), para seguimiento por recepción o marketing.
  app.get('/api/pacientes/en-riesgo', async () => ({
    filas: await query(
      `WITH ${CITAS}, ${CICLO}
       SELECT d.nombre_completo, d.tipo_documento, d.numero_documento, d.telefono_norm, d.email,
              ciclo.ultima, ciclo.dias_sin_venir, ciclo.atenciones, ciclo.especialidad, ciclo.profesional, ciclo.administradora
         FROM ciclo JOIN bi.dim_paciente d USING (paciente_id)
        WHERE ciclo.estado = 'en_riesgo'
        ORDER BY ciclo.dias_sin_venir LIMIT 3000`,
    ),
  }));

  // ------------------------------------------------------------------------------------------ Marketing
  // MKT-01: alcance de WhatsApp por mes. MKT-02: segmentos de pacientes en riesgo o inactivos para recuperar,
  // sin contar a quienes ya recibieron un mensaje de recuperación en los últimos 30 días.
  app.get('/api/marketing', async (req) =>
    conCache(claveCache(req), async () => {
      const [alcance, telefonos, segmentos] = await Promise.all([
        query(
          `SELECT to_char(fecha_bogota, 'YYYY-MM') AS mes,
                  count(DISTINCT telefono_norm) FILTER (WHERE estado NOT IN ('rechazado_api', 'failed')) AS personas,
                  count(DISTINCT telefono_norm) FILTER (WHERE estado_respuesta IN ('respondio', 'respondio_tarde')) AS respondieron
             FROM bi.fact_envios
            WHERE tipo_envio = 'plantilla' AND telefono_norm IS NOT NULL
            GROUP BY 1 ORDER BY 1`,
        ),
        queryOne(
          `SELECT count(*) AS pacientes,
                  count(*) FILTER (WHERE telefono_norm ~ '^573') AS con_celular,
                  (SELECT count(DISTINCT telefono_norm) FROM bi.fact_envios
                    WHERE estado_respuesta IN ('respondio', 'respondio_tarde')) AS respondieron_alguna_vez
             FROM bi.dim_paciente`,
        ),
        query(
          `WITH ${CITAS}, ${CICLO},
           recientes AS (
             SELECT DISTINCT telefono_norm FROM bi.fact_envios
              WHERE campana = 'recuperacion' AND fecha_bogota >= ${HOY} - 30 AND estado NOT IN ('rechazado_api', 'failed')
           )
           SELECT ciclo.estado, coalesce(ciclo.especialidad, 'Sin dato') AS especialidad, ciclo.tipo_pago,
                  count(*) AS pacientes,
                  count(*) FILTER (WHERE d.telefono_norm ~ '^573') AS contactables,
                  count(*) FILTER (WHERE r.telefono_norm IS NOT NULL) AS contactados_30d
             FROM ciclo
             JOIN bi.dim_paciente d USING (paciente_id)
             LEFT JOIN recientes r ON r.telefono_norm = d.telefono_norm
            WHERE ciclo.estado IN ('en_riesgo', 'inactivo')
            GROUP BY 1, 2, 3 ORDER BY 4 DESC`,
        ),
      ]);
      return { alcance, telefonos, segmentos };
    }, 300_000),
  );

  // -------------------------------------------------------------------------------------------- Chatbot
  // CHB-02: conversaciones que vieron fechas u horas disponibles y no terminaron con cita, por especialidad.
  // CHB-03: mensajes que el bot no entendió. Ambos con trazabilidad v2 (desde el 1-oct-2026).
  app.get('/api/chatbot/demanda', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    return conCache(claveCache(req), async () => {
      const [sinConvertir, noEntendidos, porPaso] = await Promise.all([
        query(
          `WITH vio AS (
             SELECT sesion_id, max(meta_especialidad) AS especialidad
               FROM bi.fact_eventos
              WHERE fecha_bogota BETWEEN $1 AND $2 AND sesion_id IS NOT NULL
                AND (paso LIKE 'agendar.s08%' OR paso LIKE 'agendar.s09%' OR paso LIKE 'agendar.s10%')
              GROUP BY 1
           )
           SELECT coalesce(nullif(vio.especialidad, ''), 'Sin dato') AS clave,
                  count(*) AS vieron, count(*) FILTER (WHERE s.resultado_negocio = 'cita_creada') AS agendaron
             FROM vio LEFT JOIN bi.fact_sesiones s USING (sesion_id)
            GROUP BY 1 ORDER BY 2 DESC`,
          [r.desde, r.hasta],
        ),
        queryOne(
          `SELECT count(*) FILTER (WHERE tipo_evento = 'msg_no_entendido') AS no_entendidos,
                  count(*) FILTER (WHERE tipo_evento = 'msg_entrante') AS entrantes,
                  min(fecha_bogota) FILTER (WHERE tipo_evento = 'msg_entrante') AS desde
             FROM bi.fact_eventos WHERE fecha_bogota BETWEEN $1 AND $2 AND NOT es_backfill`,
          [r.desde, r.hasta],
        ),
        query(
          `SELECT coalesce(paso, 'sin_paso') AS clave, count(*) AS n
             FROM bi.fact_eventos
            WHERE fecha_bogota BETWEEN $1 AND $2 AND tipo_evento = 'msg_no_entendido'
            GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
          [r.desde, r.hasta],
        ),
      ]);
      return { sinConvertir, noEntendidos, porPaso };
    });
  });

  // -------------------------------------------------------------------------------------------- Resumen
  // RES-01: indicadores con meta para el período: pacientes nuevos, % de citas confirmadas por WhatsApp
  // y ocupación de la agenda (solo profesionales con horario registrado, desde el 6-ago-2026).
  app.get('/api/resumen/metas', async (req) => {
    const r = leerRango(req.query as Record<string, unknown>);
    return conCache(claveCache(req), async () => {
      const ayer = sumarDias(hoyBogota(), -1);
      const hasta = r.hasta < ayer ? r.hasta : ayer;
      const [nuevos, confirmadas, ocupacion] = await Promise.all([
        queryOne(
          `WITH ${CITAS}, ${CICLO}
           SELECT count(*) FILTER (WHERE primera BETWEEN $1 AND $2) AS nuevos FROM pac`,
          [r.desde, r.hasta],
        ),
        queryOne(
          `WITH ${CITAS}, ${contacto('$1', '$2')}
           SELECT count(*) AS citas, count(*) FILTER (WHERE grupo_contacto = 'confirmo_whatsapp') AS confirmadas
             FROM contacto WHERE grupo IN ('Asistió', 'No asistió', 'Sin cierre')`,
          [r.desde, hasta],
        ),
        hasta >= CAPACIDAD_DESDE
          ? queryOne(`WITH ${CITAS}, ${capacidad('$1', '$2')} SELECT sum(cupos) AS cupos, sum(ocupan) AS ocupan FROM capacidad`, [r.desde, hasta])
          : Promise.resolve({ cupos: 0, ocupan: 0 }),
      ]);
      return { nuevos, confirmadas, ocupacion, capacidadDesde: CAPACIDAD_DESDE };
    });
  });
}
