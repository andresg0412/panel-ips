// Fragmentos SQL de la Oleada 2 del catálogo (docs/catalogo-analitica.md, sección 5).
// Equivalen a las vistas propuestas para la migración 035, pero viven en el panel para no tener que
// redesplegar el backend: leen `bi` y, con permiso de solo lectura, `horariosequipo` y `chat_stats`.
// Todas son CTE para usar después de `WITH ${CITAS}, ...`.
import { HOY } from './sql.js';

/** Fecha desde la que el horario vigente de `horariosequipo` sirve para calcular ocupación (no tiene historial). */
export const CAPACIDAD_DESDE = '2026-08-06';

/**
 * CTE `contacto` (CAM-03, CAM-04): una fila por cita de paciente entre `desde` y `hasta` con los
 * recordatorios que recibió. Une envíos por agenda_id cuando existe y, si no (histórico), por teléfono
 * + cita entre el día del envío y 6 días después. Un teléfono compartido puede asignar un envío a dos citas.
 */
export const contacto = (desde: string, hasta: string) => `
  cc AS (
    SELECT agenda_id, fecha_cita, telefono_norm AS tel, grupo, especialidad, modalidad, profesional_nombre, periodo_confiable
      FROM citas
     WHERE es_cita_paciente AND fecha_cita BETWEEN ${desde} AND ${hasta}
  ),
  cm AS (
    SELECT cc.agenda_id, e.envio_id
      FROM cc JOIN bi.fact_envios e ON e.agenda_id = cc.agenda_id
     WHERE e.campana IN ('reminder', 'execute', 'daily')
    UNION
    SELECT cc.agenda_id, e.envio_id
      FROM cc JOIN bi.fact_envios e
        ON e.telefono_norm = cc.tel AND e.agenda_id IS NULL
       AND e.aceptado_at_bogota >= cc.fecha_cita - 6 AND e.aceptado_at_bogota < cc.fecha_cita + 1
     WHERE e.campana IN ('reminder', 'execute', 'daily')
  ),
  contacto AS (
    SELECT cc.agenda_id, cc.fecha_cita, cc.grupo, cc.especialidad, cc.modalidad, cc.profesional_nombre, cc.periodo_confiable,
           bool_or(e.campana = 'reminder' AND e.estado NOT IN ('rechazado_api', 'failed')) IS TRUE AS recibio_48h,
           bool_or(e.campana = 'execute' AND e.estado NOT IN ('rechazado_api', 'failed')) IS TRUE AS recibio_24h,
           bool_or(e.campana = 'daily' AND e.estado NOT IN ('rechazado_api', 'failed')) IS TRUE AS recibio_2h,
           CASE
             WHEN bool_or(e.respuesta_tipo = 'confirmo') THEN 'confirmo_whatsapp'
             WHEN bool_or(e.estado NOT IN ('rechazado_api', 'failed')) THEN 'recibio_sin_confirmar'
             WHEN count(e.envio_id) > 0 THEN 'envio_fallido'
             WHEN cc.tel IS NULL THEN 'sin_telefono_valido'
             ELSE 'sin_recordatorio'
           END AS grupo_contacto
      FROM cc
      LEFT JOIN cm ON cm.agenda_id = cc.agenda_id
      LEFT JOIN bi.fact_envios e ON e.envio_id = cm.envio_id
     GROUP BY cc.agenda_id, cc.fecha_cita, cc.grupo, cc.especialidad, cc.modalidad, cc.profesional_nombre, cc.periodo_confiable, cc.tel
  )`;

/**
 * CTE `capacidad` (PRO-01, PRO-03, AGE-09): cupos ofrecidos por profesional y día según el horario
 * vigente, sin festivos, y su uso. El horario termina en coma ("07:00,...,15:10,"): se descartan los vacíos.
 */
export const capacidad = (desde: string, hasta: string) => `
  cap AS (
    SELECT h.profesionalid AS profesional_id, p.nombre_completo AS profesional, p.especialidad, f.fecha,
           cardinality(array_remove(string_to_array(replace(coalesce(
             CASE f.dia_semana_iso
               WHEN 1 THEN h.lunes WHEN 2 THEN h.martes WHEN 3 THEN h.miercoles WHEN 4 THEN h.jueves
               WHEN 5 THEN h.viernes WHEN 6 THEN h.sabado ELSE h.domingo
             END, ''), ' ', ''), ','), '')) AS cupos
      FROM horariosequipo h
      JOIN bi.dim_profesional p ON p.profesional_id = h.profesionalid AND p.estado = 'Activo'
      -- Solo profesionales que hoy atienden y cuyas citas están enlazadas a su identificador: al menos 5 citas
      -- (atendidas, no asistidas o programadas) en los últimos 30 días. Si no, su ocupación saldría en 0 %
      -- y sus cupos aparecerían libres aunque no esté trabajando.
      JOIN (SELECT profesional_id FROM citas
             WHERE es_cita_paciente AND profesional_id IS NOT NULL AND grupo IN ('Asistió', 'No asistió', 'Programada')
               AND fecha_cita BETWEEN ${HOY} - 30 AND ${HOY} + 30
             GROUP BY 1 HAVING count(*) >= 5) en
        ON en.profesional_id = h.profesionalid
      JOIN bi.dim_fecha f ON NOT f.es_festivo
       AND f.fecha BETWEEN greatest(${desde}::date, DATE '${CAPACIDAD_DESDE}') AND ${hasta}::date
  ),
  uso AS (
    SELECT profesional_id, fecha_cita AS fecha,
           count(*) FILTER (WHERE es_cita_paciente AND grupo IN ('Asistió', 'No asistió', 'Programada', 'Sin cierre')) AS ocupan,
           count(*) FILTER (WHERE es_cita_paciente AND grupo = 'Programada') AS programadas,
           count(*) FILTER (WHERE es_cita_paciente AND grupo IN ('Cancelada', 'Reprogramada')) AS liberadas,
           count(*) FILTER (WHERE NOT es_cita_paciente AND grupo IN ('Asistió', 'Programada', 'Sin cierre')) AS administrativas
      FROM citas
     WHERE profesional_id IS NOT NULL AND fecha_cita BETWEEN greatest(${desde}::date, DATE '${CAPACIDAD_DESDE}') AND ${hasta}::date
     GROUP BY 1, 2
  ),
  capacidad AS (
    SELECT cap.profesional_id, cap.profesional, cap.especialidad, cap.fecha, cap.cupos,
           coalesce(u.ocupan, 0) AS ocupan, coalesce(u.programadas, 0) AS programadas,
           coalesce(u.liberadas, 0) AS liberadas, coalesce(u.administrativas, 0) AS administrativas,
           greatest(cap.cupos - coalesce(u.ocupan, 0) - coalesce(u.administrativas, 0), 0) AS libres
      FROM cap LEFT JOIN uso u ON u.profesional_id = cap.profesional_id AND u.fecha = cap.fecha
     WHERE cap.cupos > 0
  )`;

/**
 * CTE `ciclo` (PAC-02, PAC-04, MKT-02): una fila por paciente atendido desde ago-2025 con su primera y
 * última atención, frecuencia habitual, próxima cita y estado de actividad.
 * - activo_con_cita: tiene una cita futura;
 * - activo: última atención hace menos de max(2 × su frecuencia, 30 días);
 * - en_riesgo: hasta 120 días; inactivo: más de 120.
 */
export const CICLO = `
  at AS (
    SELECT paciente_id, fecha_cita, hora_cita, especialidad, profesional_nombre, administradora_n, tipo_pago
      FROM citas WHERE es_cita_paciente AND grupo = 'Asistió' AND paciente_id IS NOT NULL
  ),
  atv AS (
    SELECT at.*, fecha_cita - lag(fecha_cita) OVER (PARTITION BY paciente_id ORDER BY fecha_cita, hora_cita) AS dif FROM at
  ),
  pac AS (
    SELECT paciente_id, min(fecha_cita) AS primera, max(fecha_cita) AS ultima, count(*) AS atenciones,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY dif) FILTER (WHERE dif > 0) AS frecuencia,
           (array_agg(especialidad ORDER BY fecha_cita DESC))[1] AS especialidad,
           (array_agg(profesional_nombre ORDER BY fecha_cita DESC))[1] AS profesional,
           (array_agg(tipo_pago ORDER BY fecha_cita DESC))[1] AS tipo_pago,
           (array_agg(administradora_n ORDER BY fecha_cita DESC))[1] AS administradora
      FROM atv GROUP BY 1
  ),
  prox AS (
    SELECT paciente_id, min(fecha_cita) AS proxima FROM citas
     WHERE es_cita_paciente AND grupo = 'Programada' AND paciente_id IS NOT NULL GROUP BY 1
  ),
  ciclo AS (
    SELECT pac.*, prox.proxima, ${HOY} - pac.ultima AS dias_sin_venir,
           CASE
             WHEN prox.proxima IS NOT NULL THEN 'activo_con_cita'
             WHEN ${HOY} - pac.ultima <= greatest(2 * coalesce(pac.frecuencia, 14), 30) THEN 'activo'
             WHEN ${HOY} - pac.ultima <= 120 THEN 'en_riesgo'
             ELSE 'inactivo'
           END AS estado
      FROM pac LEFT JOIN prox USING (paciente_id)
  )`;

/**
 * CTE `ejec` (CAM-07, alertas A1/A2): ejecuciones de campaña desde `desde` (fecha), una fila por corrida.
 * Lee los resúmenes EJECUCION_* de chat_stats (legacy, que bi.fact_eventos excluye) y los v2
 * `campana_ejecucion` con resultado 'fin'. Desde el 2026-10-04 el bot escribe ambos en el mismo segundo: se deja el v2.
 */
export const ejecuciones = (desde: string) => `
  ejec AS (
    SELECT DISTINCT ON (campana, date_trunc('second', fin_at)) *
      FROM (
        SELECT CASE WHEN c.tipo_evento = 'campana_ejecucion' THEN 'v2' ELSE 'legacy' END AS fuente,
               coalesce(c.campana, CASE c.tipo_evento
                 WHEN 'campahna_envio' THEN 'execute'
                 WHEN 'campahna_envio_confirmados_24hrs' THEN 'execute'
                 WHEN 'campahna_recordatorio' THEN 'reminder'
                 WHEN 'campahna_envio_cron' THEN 'daily'
                 WHEN 'campahna_recuperacion_con_asistencia' THEN 'conasistencia'
                 WHEN 'campahna_recuperacion_sin_asistencia' THEN 'recuperacion'
               END) AS campana,
               c.fecha_hora AS fin_at,
               (c.fecha_hora AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota') AS fin_bogota,
               (c.fecha_hora AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date AS fecha,
               coalesce(nullif(c.metadata ->> 'total', ''), nullif(c.metadata ->> 'total_procesados', ''))::int AS procesadas,
               coalesce(nullif(c.metadata ->> 'exitosos', ''), nullif(c.metadata ->> 'envios_exitosos', ''))::int AS exitosos,
               coalesce(nullif(c.metadata ->> 'errores', ''), nullif(c.metadata ->> 'envios_errores', ''))::int AS errores
          FROM chat_stats c
         WHERE c.fecha_hora >= (${desde}::date - 1)::timestamp
           AND ((c.id_usuario LIKE 'EJECUCION%' AND c.tipo_evento LIKE 'campahna%')
                OR (c.tipo_evento = 'campana_ejecucion' AND c.resultado = 'fin'))
      ) t
     WHERE campana IS NOT NULL
     ORDER BY campana, date_trunc('second', fin_at), (fuente = 'v2') DESC
  )`;

/** Programación del cron de campañas (copia de proyecto-ips/cron/crontab; actualizar si cambia). */
export const PROGRAMACION = [
  { campana: 'daily', hora: '06:30', soloHabil: true },
  { campana: 'reminder', hora: '07:40', soloHabil: false },
  { campana: 'execute', hora: '08:10', soloHabil: false },
  { campana: 'recuperacion', hora: '08:40', soloHabil: false },
  { campana: 'conasistencia', hora: '09:10', soloHabil: false },
];
